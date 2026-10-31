"""Exporting presets to files and importing one into a slot."""
import asyncio
import contextlib
import copy
import io
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mmp_mock import MockSession, mock_dispatch
from mmp_session import EditorConflict, MicroPlusSession, SAVED_READ_FAILURES
from mmp_web import MAX_BODY, MAX_EDITOR_BODY, dispatch, handle, HTTPError

HEADERS = {'host': 'localhost:8080', 'origin': 'http://localhost:8080', 'content-type': 'application/json'}


def full_preset(name='From file'):
    nodes = [{'nodeId': node, 'FenderId': 'ACD_Test', 'dspUnitParameters': {'gain': 0.5}}
             for node in ('stomp', 'mod', 'amp', 'delay', 'reverb')]
    return {'nodeType': 'preset', 'audioGraph': {'nodes': nodes},
            'info': {'displayName': name, 'preset_id': 'ORIGINAL', 'product_id': 'mustang-ltx',
                     'is_factory_default': True}}


class ImportTests(unittest.IsolatedAsyncioTestCase):
    def session(self, directory, slot=17):
        session = MicroPlusSession('device-id', backup_dir=directory)
        session.controller = types.SimpleNamespace(slot=slot, document_slot=slot, document=full_preset('Active'),
            document_revision=4, dirty=False, names=['Test'] * 100, status=lambda: {'name': 'Test'},
            read_preset=AsyncMock(return_value=full_preset('Before import')), restore_preset=AsyncMock(),
            switch=AsyncMock(), refresh_current=AsyncMock())
        session.client = types.SimpleNamespace(is_connected=True)
        session.generation = 2
        return session

    async def test_slot_is_backed_up_before_the_write_and_the_copy_gets_its_own_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            session = self.session(directory)
            source = full_preset()
            untouched = copy.deepcopy(source)

            async def write(preset, target):
                backups = list(Path(directory).glob('*.json'))
                self.assertEqual(len(backups), 1)
                self.assertEqual(json.loads(backups[0].read_text())['preset']['info']['displayName'], 'Before import')

            session.controller.restore_preset = AsyncMock(side_effect=write)
            result = await session.import_preset(17, '2:4', 50, ' Renamed ', source)
            written, target = session.controller.restore_preset.call_args.args
            self.assertEqual(target, 50)
            self.assertEqual(written['info']['displayName'], 'Renamed')
            self.assertNotEqual(written['info']['preset_id'], 'ORIGINAL')
            self.assertFalse(written['info']['is_factory_default'])
            self.assertEqual(source, untouched)
            self.assertEqual((result['last_save']['preset'], result['last_save']['name']), (50, 'Renamed'))
            self.assertEqual(result['saved_presets']['50'], 'Renamed')

    async def test_import_reselects_active_slot_but_not_another_slot(self):
        with tempfile.TemporaryDirectory() as directory:
            active = self.session(directory)
            await active.import_preset(17, '2:4', 17, 'New', full_preset())
            active.controller.switch.assert_awaited_once_with(17)
            other = self.session(directory)
            await other.import_preset(17, '2:4', 50, 'New', full_preset())
            other.controller.switch.assert_not_awaited()

    async def test_undo_this_save_puts_back_what_an_import_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            session = self.session(directory)
            await session.import_preset(17, '2:4', 50, 'New', full_preset())
            session.controller.restore_preset.reset_mock()
            result = await session.undo_save(17, '2:4')
            restored, target = session.controller.restore_preset.call_args.args
            self.assertEqual((restored['info']['displayName'], target), ('Before import', 50))
            self.assertIsNone(result['last_save'])
            self.assertNotIn('50', result['saved_presets'])

    async def test_bad_files_never_reach_the_device(self):
        other_amp = full_preset()
        other_amp['info']['product_id'] = 'mustang-lt25'
        missing = full_preset()
        missing['audioGraph']['nodes'].pop()
        extra = full_preset()
        extra['audioGraph']['nodes'].append({'nodeId': 'other', 'FenderId': 'x', 'dspUnitParameters': {}})
        cases = [(other_amp, 50, 'Name'), (missing, 50, 'Name'), (extra, 50, 'Name'), ('text', 50, 'Name'), (None, 50, 'Name'),
                 ({'nodeType': 'preset'}, 50, 'Name'), (full_preset(), 0, 'Name'), (full_preset(), 101, 'Name'),
                 (full_preset(), True, 'Name'), (full_preset(), 50, ''), (full_preset(), 50, 'x' * 17)]
        with tempfile.TemporaryDirectory() as directory:
            session = self.session(directory)
            for document, target, name in cases:
                with self.subTest(target=target, name=name), self.assertRaises(ValueError):
                    await session.import_preset(17, '2:4', target, name, document)
            session.controller.read_preset.assert_not_awaited()
            session.controller.restore_preset.assert_not_awaited()

    async def test_model_outside_the_known_list_is_allowed(self):
        # A real amp preset uses a model missing from mmp_models.json, so the list can't be a gate.
        with tempfile.TemporaryDirectory() as directory:
            session = self.session(directory)
            await session.import_preset(17, '2:4', 50, 'New', full_preset())
            session.controller.restore_preset.assert_awaited_once()

    async def test_backup_failure_prevents_the_write(self):
        with tempfile.TemporaryDirectory() as directory:
            session = self.session(directory)
            session.backup = lambda *_: (_ for _ in ()).throw(OSError('disk full'))
            with self.assertRaises(OSError):
                await session.import_preset(17, '2:4', 50, 'New', full_preset())
            session.controller.restore_preset.assert_not_awaited()

    async def test_selection_change_during_backup_prevents_the_write(self):
        with tempfile.TemporaryDirectory() as directory:
            session = self.session(directory)

            async def read(_slot):
                session.controller.slot = 18
                return full_preset('Before import')

            session.controller.read_preset = AsyncMock(side_effect=read)
            with self.assertRaises(EditorConflict):
                await session.import_preset(17, '2:4', 50, 'New', full_preset())
            session.controller.restore_preset.assert_not_awaited()

    async def test_failed_read_back_reconnects_and_records_no_save(self):
        with tempfile.TemporaryDirectory() as directory:
            session = self.session(directory)
            session.controller.restore_preset = AsyncMock(
                side_effect=RuntimeError('Read-back verification of the restored preset failed'))
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaisesRegex(RuntimeError, 'could not be verified'):
                await session.import_preset(17, '2:4', 50, 'New', full_preset())
            self.assertIsNone(session.controller)
            self.assertIsNone(session.last_save)
            self.assertEqual(session.saved.state, {})

    async def test_import_is_refused_for_a_stale_editor(self):
        with tempfile.TemporaryDirectory() as directory:
            session = self.session(directory)
            body = {'action': 'import', 'preset': 17, 'revision': '2:3', 'target': 50, 'name': 'New', 'document': full_preset()}
            with self.assertRaises(HTTPError) as caught:
                await dispatch('POST', '/api/micro-plus/editor', HEADERS, json.dumps(body).encode(), session)
            self.assertEqual(caught.exception.status, 409)
            session.controller.read_preset.assert_not_awaited()


class ReadSlotTests(unittest.IsolatedAsyncioTestCase):
    def session(self):
        session = MicroPlusSession('device-id')
        session.controller = types.SimpleNamespace(slot=17, document_slot=17, document=full_preset(), document_revision=4,
            dirty=False, names=['Test'] * 100, status=lambda: {'name': 'Test'},
            read_preset=AsyncMock(return_value=full_preset('Stored')))
        session.client = types.SimpleNamespace(is_connected=True)
        session.generation = 2
        return session

    async def test_any_slot_can_be_read_over_http(self):
        session = self.session()
        code, _, body = await dispatch('POST', '/api/micro-plus/editor', HEADERS,
                                       json.dumps({'action': 'read-slot', 'slot': 42}).encode(), session)
        reply = json.loads(body)
        self.assertEqual((code, reply['slot'], reply['saved_document']['info']['displayName']), (200, 42, 'Stored'))
        session.controller.read_preset.assert_awaited_once_with(42)

    async def test_invalid_slots_never_reach_the_device(self):
        session = self.session()
        for slot in (0, 101, 1.5, True, '42', None):
            with self.subTest(slot=slot), self.assertRaises(ValueError):
                await session.read_slot(slot)
        session.controller.read_preset.assert_not_awaited()

    async def test_reads_that_keep_failing_reconnect(self):
        session = self.session()
        session.controller.read_preset = AsyncMock(side_effect=TimeoutError())
        with contextlib.redirect_stderr(io.StringIO()):
            for _ in range(SAVED_READ_FAILURES - 1):
                with self.assertRaisesRegex(RuntimeError, 'did not send'):
                    await session.read_slot(42)
            self.assertIsNotNone(session.controller)
            with self.assertRaisesRegex(RuntimeError, 'reconnecting'):
                await session.read_slot(42)
        self.assertIsNone(session.controller)
        self.assertTrue(session.stalled)

    async def test_disconnected_read_is_an_error(self):
        with self.assertRaisesRegex(RuntimeError, 'disconnected'):
            await MicroPlusSession().read_slot(42)


class BodyLimitTests(unittest.IsolatedAsyncioTestCase):
    async def send(self, path, length):
        reader = asyncio.StreamReader()
        reader.feed_data(f'POST {path} HTTP/1.1\r\nContent-Length: {length}\r\n\r\n'.encode() + b'x' * length)
        reader.feed_eof()
        written = bytearray()
        writer = types.SimpleNamespace(write=written.extend, drain=AsyncMock(), close=lambda: None, wait_closed=AsyncMock())
        seen = []

        async def dispatcher(_method, _path, _headers, body, _session, _hosts):
            seen.append(len(body))
            return 200, 'application/json', b'{}'

        await handle(reader, writer, None, dispatcher=dispatcher)
        return written.split(b' ', 2)[1], seen

    async def test_only_the_editor_accepts_a_whole_preset(self):
        self.assertEqual(await self.send('/api/micro-plus/editor', MAX_EDITOR_BODY), (b'200', [MAX_EDITOR_BODY]))
        self.assertEqual((await self.send('/api/micro-plus/editor', MAX_EDITOR_BODY + 1))[0], b'413')
        self.assertEqual(await self.send('/api/micro-plus', MAX_BODY), (b'200', [MAX_BODY]))
        self.assertEqual((await self.send('/api/micro-plus', MAX_BODY + 1))[0], b'413')
        self.assertEqual((await self.send('/api/micro-plus/groups', MAX_BODY + 1))[0], b'413')


class SimulatedAmpTests(unittest.IsolatedAsyncioTestCase):
    async def post(self, session, body):
        code, _, data = await mock_dispatch('POST', '/api/micro-plus/editor', HEADERS, json.dumps(body).encode(), session)
        return code, json.loads(data)

    async def test_export_import_and_undo_round_trip(self):
        session = MockSession(delay=0)
        original = session.names[2]
        _, read = await self.post(session, {'action': 'read-slot', 'slot': 5})
        exported = read['saved_document']
        state = session.snapshot()
        _, state = await self.post(session, {'action': 'import', 'preset': state['preset'], 'revision': state['revision'],
                                             'target': 3, 'name': 'Imported', 'document': exported})
        self.assertEqual(state['presets'][2]['name'], 'Imported')
        _, read = await self.post(session, {'action': 'read-slot', 'slot': 3})
        self.assertEqual(read['saved_document']['audioGraph'], exported['audioGraph'])
        _, state = await self.post(session, {'action': 'undo-save', 'preset': state['preset'], 'revision': state['revision']})
        self.assertEqual(state['presets'][2]['name'], original)

    async def test_simulated_amp_refuses_the_same_files(self):
        session = MockSession(delay=0)
        state = session.snapshot()
        with self.assertRaises(HTTPError) as caught:
            await self.post(session, {'action': 'import', 'preset': state['preset'], 'revision': state['revision'],
                                      'target': 3, 'name': 'Bad', 'document': {'nodeType': 'preset'}})
        self.assertEqual(caught.exception.status, 400)

    async def test_saved_read_stall_also_stops_exports(self):
        session = MockSession(delay=0)
        await mock_dispatch('GET', '/__mock/mode/noread-stuck', HEADERS, b'', session)
        with self.assertRaises(HTTPError) as caught:
            await self.post(session, {'action': 'read-slot', 'slot': 5})
        self.assertEqual(caught.exception.status, 503)


if __name__ == '__main__':
    unittest.main()
