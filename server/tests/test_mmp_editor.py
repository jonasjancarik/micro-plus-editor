"""Safety checks for saving edited Micro Plus presets."""
import contextlib
import copy
import io
import json
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mmp_ble import Controller
from mmp_groups import PresetGroups, SavedPresets
from mmp_protocol import presets_match
from mmp_session import EditorConflict, MicroPlusSession, READ_RECONNECT_GAP, SAVED_READ_FAILURES
from mmp_web import dispatch, HTTPError
from test_mmp_protocol import preset_fixture


class EditorTests(unittest.IsolatedAsyncioTestCase):
    def session(self, directory):
        session = MicroPlusSession('device-id', backup_dir=directory)
        current = preset_fixture()
        current['audioGraph']['nodes'][0]['dspUnitParameters']['gain'] = 0.6
        stored = preset_fixture()
        controller = types.SimpleNamespace(slot=100, document_slot=100, document=current,
            document_revision=4, dirty=True, names=['Test'] * 100,
            status=lambda: {'name': 'Test'}, read_preset=AsyncMock(return_value=stored),
            save_current=AsyncMock(), set_parameter=AsyncMock(), replace_node=AsyncMock())
        session.controller = controller
        session.client = types.SimpleNamespace(is_connected=True)
        session.generation = 2
        return session

    async def test_stored_contents_are_backed_up_before_save(self):
        with tempfile.TemporaryDirectory() as directory:
            session = self.session(directory)

            async def save(name, target):
                backups = list(Path(directory).glob('*.json'))
                self.assertEqual(len(backups), 1)
                data = json.loads(backups[0].read_text())
                self.assertEqual(data['slot'], 100)
                self.assertEqual(data['preset']['audioGraph']['nodes'][0]['dspUnitParameters']['gain'], 0.5)
                self.assertEqual(session.controller.document['audioGraph']['nodes'][0]['dspUnitParameters']['gain'], 0.6)

            session.controller.save_current = AsyncMock(side_effect=save)
            result = await session.save(100, '2:4', 100, 'Edited')
            self.assertTrue(result['last_save']['verified'])
            session.controller.save_current.assert_awaited_once_with('Edited', 100)

    async def test_unconfirmed_change_logs_the_real_error(self):
        with tempfile.TemporaryDirectory() as directory:
            session = self.session(directory)
            session.controller.set_parameter = AsyncMock(side_effect=TimeoutError())
            log = io.StringIO()
            with contextlib.redirect_stderr(log), self.assertRaisesRegex(RuntimeError, 'did not confirm'):
                await session.edit(100, '2:4', 'delay', 'dlytime', 0.02)
            self.assertIn('parameter change not confirmed', log.getvalue())
            self.assertIn('TimeoutError', log.getvalue())

    async def test_saved_copy_reads_the_stored_preset_and_writes_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            session = self.session(directory)
            result = await session.saved_copy(100, '2:4')
            nodes = result['saved_document']['audioGraph']['nodes']
            self.assertEqual(nodes[0]['dspUnitParameters']['gain'], 0.5)
            self.assertEqual((result['preset'], result['revision']), (100, '2:4'))
            session.controller.read_preset.assert_awaited_once_with(100)
            session.controller.save_current.assert_not_awaited()
            session.controller.set_parameter.assert_not_awaited()
            self.assertEqual(list(Path(directory).glob('*.json')), [])

    async def fail_saved_copies(self, session, count):
        session.controller.read_preset = AsyncMock(side_effect=TimeoutError())
        with contextlib.redirect_stderr(io.StringIO()):
            for _ in range(count):
                with self.assertRaisesRegex(RuntimeError, 'did not send the saved preset'):
                    await session.saved_copy(100, '2:4')

    async def test_failed_saved_copy_keeps_the_connection(self):
        with tempfile.TemporaryDirectory() as directory:
            session = self.session(directory)
            await self.fail_saved_copies(session, SAVED_READ_FAILURES - 1)
            self.assertIsNotNone(session.controller)
            self.assertFalse(session.reset.is_set())
            self.assertIsNone(session.error)
            self.assertFalse(session.snapshot()['stalled'])

    async def test_saved_copy_failures_in_a_row_reconnect(self):
        with tempfile.TemporaryDirectory() as directory:
            session = self.session(directory)
            await self.fail_saved_copies(session, SAVED_READ_FAILURES - 1)
            log = io.StringIO()
            with contextlib.redirect_stderr(log), self.assertRaisesRegex(RuntimeError, 'stopped answering'):
                await session.saved_copy(100, '2:4')
            self.assertTrue(session.reset.is_set())
            self.assertIsNone(session.controller)
            self.assertTrue(session.snapshot()['stalled'])
            self.assertIn('saved preset read failed, 3 in a row', log.getvalue())
            self.assertIn('TimeoutError', log.getvalue())

    async def test_a_good_saved_copy_restarts_the_failure_count(self):
        with tempfile.TemporaryDirectory() as directory:
            session = self.session(directory)
            stored = preset_fixture()
            await self.fail_saved_copies(session, SAVED_READ_FAILURES - 1)
            session.controller.read_preset = AsyncMock(return_value=stored)
            await session.saved_copy(100, '2:4')
            await self.fail_saved_copies(session, SAVED_READ_FAILURES - 1)
            self.assertFalse(session.reset.is_set())

    async def test_saved_copy_failures_do_not_reconnect_again_straight_away(self):
        with tempfile.TemporaryDirectory() as directory:
            session = self.session(directory)
            session.read_reconnected_at = time.monotonic()
            await self.fail_saved_copies(session, SAVED_READ_FAILURES + 2)
            self.assertFalse(session.reset.is_set())
            self.assertIsNotNone(session.controller)
            session.read_reconnected_at = time.monotonic() - READ_RECONNECT_GAP
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaisesRegex(RuntimeError, 'stopped answering'):
                await session.saved_copy(100, '2:4')
            self.assertTrue(session.reset.is_set())

    async def test_a_stale_editor_does_not_count_as_a_failed_read(self):
        with tempfile.TemporaryDirectory() as directory:
            session = self.session(directory)
            for _ in range(SAVED_READ_FAILURES + 1):
                with self.assertRaises(EditorConflict):
                    await session.saved_copy(100, '2:3')
            self.assertEqual(session.saved_read_failures, 0)
            self.assertFalse(session.reset.is_set())

    async def test_amp_timeout_during_save_is_not_reported_as_a_failed_backup(self):
        # TimeoutError is an OSError, and a save that timed out may still have reached the amp.
        with tempfile.TemporaryDirectory() as directory:
            session = self.session(directory)
            session.controller.save_current = AsyncMock(side_effect=TimeoutError())
            log = io.StringIO()
            with contextlib.redirect_stderr(log), self.assertRaisesRegex(RuntimeError, 'could not be verified'):
                await session.save(100, '2:4', 100, 'Edited')
            self.assertTrue(session.reset.is_set())

    async def test_saved_copy_is_refused_for_a_stale_editor_and_routed_over_http(self):
        with tempfile.TemporaryDirectory() as directory:
            session = self.session(directory)
            with self.assertRaises(EditorConflict):
                await session.saved_copy(100, '2:3')
            headers = {'host': 'localhost:8080', 'origin': 'http://localhost:8080', 'content-type': 'application/json'}
            body = json.dumps({'action': 'saved-copy', 'preset': 100, 'revision': '2:4'}).encode()
            status, _kind, reply = await dispatch('POST', '/api/micro-plus/editor', headers, body, session)
            self.assertEqual(status, 200)
            self.assertIn('saved_document', json.loads(reply))

    async def test_backup_failure_prevents_hardware_save(self):
        with tempfile.TemporaryDirectory() as directory:
            session = self.session(directory)
            session.backup = Mock(side_effect=OSError('disk full'))
            with self.assertRaises(OSError):
                await session.save(100, '2:4', 100, 'Edited')
            session.controller.save_current.assert_not_awaited()

    async def test_physical_selection_change_during_backup_prevents_save(self):
        with tempfile.TemporaryDirectory() as directory:
            session = self.session(directory)
            controller = session.controller

            async def read(slot):
                controller.slot = 17
                return preset_fixture()

            controller.read_preset = AsyncMock(side_effect=read)
            with self.assertRaises(EditorConflict):
                await session.save(100, '2:4', 100, 'Edited')
            controller.save_current.assert_not_awaited()

    async def test_old_connection_revision_cannot_edit_reconnected_device(self):
        with tempfile.TemporaryDirectory() as directory:
            session = self.session(directory)
            with self.assertRaises(EditorConflict):
                await session.edit(100, '1:4', 'amp', 'gain', 0.6)
            session.controller.set_parameter.assert_not_awaited()

    async def test_old_preset_cannot_receive_edit(self):
        with tempfile.TemporaryDirectory() as directory:
            session = self.session(directory)
            with self.assertRaises(EditorConflict):
                await session.edit(17, '2:4', 'amp', 'gain', 0.6)
            session.controller.set_parameter.assert_not_awaited()

    async def test_model_must_be_on_micro_plus_list(self):
        with tempfile.TemporaryDirectory() as directory:
            session = self.session(directory)
            with self.assertRaises(ValueError):
                await session.replace(100, '2:4', 'amp', 'unknown-model')
            session.controller.replace_node.assert_not_awaited()

    async def test_invalid_save_target_never_reads_or_writes_device(self):
        with tempfile.TemporaryDirectory() as directory:
            for target in (0, 101, True, '100'):
                session = self.session(directory)
                with self.assertRaises(ValueError):
                    await session.save(100, '2:4', target, 'Edited')
                session.controller.read_preset.assert_not_awaited()
                session.controller.save_current.assert_not_awaited()

    async def test_http_stale_editor_is_conflict(self):
        with tempfile.TemporaryDirectory() as directory:
            session = self.session(directory)
            body = json.dumps({'action': 'parameter', 'preset': 100, 'revision': 'old',
                               'node': 'amp', 'parameter': 'gain', 'value': 0.6}).encode()
            with self.assertRaises(HTTPError) as caught:
                await dispatch('POST', '/api/micro-plus/editor',
                    {'host': 'localhost:8080', 'origin': 'http://localhost:8080',
                     'content-type': 'application/json'}, body, session)
            self.assertEqual(caught.exception.status, 409)

    async def test_save_response_must_be_verified_by_readback(self):
        controller = Controller(types.SimpleNamespace(is_connected=True), None)
        controller.slot = 100
        controller.document = preset_fixture()
        expected = copy.deepcopy(controller.document)
        expected['info']['displayName'] = 'Edited'

        async def acknowledge(*args):
            controller.saved = {'preset': 100, 'name': 'Edited'}
            controller.save_revision += 1

        controller.command = AsyncMock(side_effect=acknowledge)
        controller.read_preset = AsyncMock(return_value=preset_fixture())  # Different name.
        controller.refresh_current = AsyncMock()
        with self.assertRaises(RuntimeError):
            await controller.save_current('Edited', 100)
        controller.refresh_current.assert_not_awaited()
        self.assertFalse(presets_match(expected, preset_fixture()))

    async def test_float32_rounding_is_allowed_in_readback(self):
        expected = preset_fixture()
        actual = copy.deepcopy(expected)
        expected['audioGraph']['nodes'][0]['dspUnitParameters']['gain'] = .6
        actual['audioGraph']['nodes'][0]['dspUnitParameters']['gain'] = .6000000238418579
        self.assertTrue(presets_match(expected, actual))


class UndoSaveTests(unittest.IsolatedAsyncioTestCase):
    def session(self, directory, slot=100, target=100):
        session = MicroPlusSession('device-id', backup_dir=directory)
        controller = types.SimpleNamespace(slot=slot, document_slot=slot, document=preset_fixture(),
            document_revision=4, dirty=False, names=['Test'] * 100, status=lambda: {'name': 'Test'},
            read_preset=AsyncMock(return_value=preset_fixture()), restore_preset=AsyncMock(),
            switch=AsyncMock(), refresh_current=AsyncMock())
        session.controller = controller
        session.client = types.SimpleNamespace(is_connected=True)
        session.generation = 2
        previous = preset_fixture()
        previous['info']['displayName'] = 'Before save'
        name = session.backup(target, previous)
        session.last_save = {'preset': target, 'name': 'Edited', 'backup': name, 'verified': True, 'time': 1}
        return session

    async def test_undo_restores_backup_and_backs_up_what_it_replaces(self):
        with tempfile.TemporaryDirectory() as directory:
            session = self.session(directory)
            result = await session.undo_save(100, '2:4')
            restored, target = session.controller.restore_preset.call_args.args
            self.assertEqual((restored['info']['displayName'], target), ('Before save', 100))
            self.assertEqual(len(list(Path(directory).glob('*.json'))), 2)
            self.assertIsNone(result['last_save'])
            self.assertEqual(result['last_undo']['preset'], 100)

    async def test_undo_reselects_active_slot_but_not_another_slot(self):
        with tempfile.TemporaryDirectory() as directory:
            active = self.session(directory)
            await active.undo_save(100, '2:4')
            active.controller.switch.assert_awaited_once_with(100)
        with tempfile.TemporaryDirectory() as directory:
            other = self.session(directory, slot=17, target=100)
            await other.undo_save(17, '2:4')
            other.controller.switch.assert_not_awaited()

    async def test_failed_safety_backup_prevents_undo(self):
        with tempfile.TemporaryDirectory() as directory:
            session = self.session(directory)
            session.backup = Mock(side_effect=OSError('disk full'))
            with self.assertRaises(OSError):
                await session.undo_save(100, '2:4')
            session.controller.restore_preset.assert_not_awaited()
            self.assertIsNotNone(session.last_save)

    async def test_undo_without_a_save_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            session = self.session(directory)
            session.last_save = None
            with self.assertRaises(ValueError):
                await session.undo_save(100, '2:4')
            session.controller.restore_preset.assert_not_awaited()

    async def test_undo_rejects_stale_editor_and_is_routed_over_http(self):
        with tempfile.TemporaryDirectory() as directory:
            session = self.session(directory)
            headers = {'host': 'localhost:8080', 'origin': 'http://localhost:8080',
                       'content-type': 'application/json'}
            stale = json.dumps({'action': 'undo-save', 'preset': 100, 'revision': 'old'}).encode()
            with self.assertRaises(HTTPError) as caught:
                await dispatch('POST', '/api/micro-plus/editor', headers, stale, session)
            self.assertEqual(caught.exception.status, 409)
            session.controller.restore_preset.assert_not_awaited()
            body = json.dumps({'action': 'undo-save', 'preset': 100, 'revision': '2:4'}).encode()
            code, _, _ = await dispatch('POST', '/api/micro-plus/editor', headers, body, session)
            self.assertEqual(code, 200)
            session.controller.restore_preset.assert_awaited_once()


class CopyAndTypeTests(unittest.IsolatedAsyncioTestCase):
    async def test_save_as_assigns_new_identity_without_mutating_source(self):
        controller = Controller(types.SimpleNamespace(is_connected=True), None)
        controller.slot = 17
        controller.document = preset_fixture()
        controller.document['info'].update(preset_id='SOURCE-ID', is_factory_default=True)
        original = copy.deepcopy(controller.document)
        controller.restore_preset = AsyncMock(return_value=preset_fixture())
        controller.refresh_current = AsyncMock()
        await controller.save_current('Copy', 100)
        copied, target = controller.restore_preset.call_args.args
        self.assertEqual(target, 100)
        self.assertNotEqual(copied['info']['preset_id'], 'SOURCE-ID')
        self.assertFalse(copied['info']['is_factory_default'])
        self.assertEqual(controller.document, original)

    async def test_integer_wire_type_is_read_before_editing(self):
        from mmp_ble import fields
        controller = Controller(types.SimpleNamespace(is_connected=True), None)
        controller.slot = controller.document_slot = 100
        controller.document = preset_fixture()
        controller.document['audioGraph']['nodes'][0]['dspUnitParameters']['comppreset'] = 1
        sent = []

        async def command(kind, payload):
            sent.append((kind, payload))
            if kind == 11:
                controller.parameters[('amp', 'comppreset')] = 1
                controller.parameter_types[('amp', 'comppreset')] = 5
            else:
                self.assertEqual(dict(fields(payload))[5], 0)
                controller.parameters[('amp', 'comppreset')] = 0
            controller.parameter_revision += 1

        controller.command = command
        controller.refresh_current = AsyncMock()
        await controller.set_parameter('amp', 'comppreset', 0)
        self.assertEqual([kind for kind, _ in sent], [11, 20])


class LimitedValueTests(unittest.IsolatedAsyncioTestCase):
    # On a real amp a Delay Time of 0.02 s is stored as 0.03 s, which used to drop the connection.
    def controller(self, reports, preset_holds):
        controller = Controller(types.SimpleNamespace(is_connected=True), None)
        controller.slot = controller.document_slot = 100
        controller.document = preset_fixture()
        parameters = controller.document['audioGraph']['nodes'][0]['dspUnitParameters']
        parameters['gain'] = 0.5

        async def command(kind, payload):
            controller.parameters[('amp', 'gain')] = 0.5 if kind == 11 else reports
            controller.parameter_types[('amp', 'gain')] = 2
            controller.parameter_revision += 1

        async def refresh_current():
            parameters['gain'] = preset_holds

        controller.command = command
        controller.refresh_current = refresh_current
        return controller

    async def test_a_value_the_amp_limits_returns_what_it_stored(self):
        controller = self.controller(reports=0.03, preset_holds=0.03)
        self.assertEqual(await controller.set_parameter('amp', 'gain', 0.02), 0.03)

    async def test_a_value_stored_as_sent_is_not_reported_as_limited(self):
        controller = self.controller(reports=0.7, preset_holds=0.7)
        self.assertIsNone(await controller.set_parameter('amp', 'gain', 0.7))

    async def test_a_limit_the_preset_does_not_confirm_still_fails(self):
        controller = self.controller(reports=0.03, preset_holds=0.5)
        with self.assertRaises(RuntimeError):
            await controller.set_parameter('amp', 'gain', 0.02)

    async def test_a_reply_that_is_not_a_number_still_fails(self):
        controller = self.controller(reports='low', preset_holds=0.5)
        with self.assertRaises(RuntimeError):
            await controller.set_parameter('amp', 'gain', 0.02)

    async def test_session_keeps_the_connection_and_says_what_was_stored(self):
        with tempfile.TemporaryDirectory() as directory:
            session = EditorTests.session(self, directory)
            session.controller.set_parameter = AsyncMock(return_value=0.03)
            state = await session.edit(100, '2:4', 'amp', 'gain', 0.02)
            self.assertIsNotNone(session.controller)
            self.assertIsNone(session.error)
            self.assertEqual(state['limited'], {'node': 'amp', 'parameter': 'gain', 'requested': 0.02, 'stored': 0.03})


class PresetGroupStoreTests(unittest.TestCase):
    def test_groups_survive_a_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'groups.json'
            groups = PresetGroups(path)
            groups.apply({'action': 'create', 'name': ' Gig '})
            groups.apply({'action': 'move', 'preset': 17, 'group': 'Gig'})
            self.assertEqual(PresetGroups(path).state, {'groups': ['Gig'], 'assignments': {'17': 'Gig'}})

    def test_rename_and_delete_carry_their_presets_along(self):
        groups = PresetGroups()
        groups.apply({'action': 'create', 'name': 'Gig'})
        groups.apply({'action': 'move', 'preset': 17, 'group': 'Gig'})
        groups.apply({'action': 'move', 'preset': 32, 'group': 'Rock'})
        groups.apply({'action': 'rename', 'name': 'Gig', 'new_name': 'Live'})
        self.assertEqual(groups.state['assignments'], {'17': 'Live', '32': 'Rock'})
        groups.apply({'action': 'delete', 'name': 'Live'})
        self.assertEqual(groups.state, {'groups': [], 'assignments': {'32': 'Rock'}})

    def test_moving_to_no_group_returns_a_preset_to_its_usual_one(self):
        groups = PresetGroups()
        groups.apply({'action': 'move', 'preset': 32, 'group': 'Rock'})
        groups.apply({'action': 'move', 'preset': 32, 'group': None})
        self.assertEqual(groups.state['assignments'], {})

    def test_bad_requests_change_nothing(self):
        groups = PresetGroups()
        groups.apply({'action': 'create', 'name': 'Gig'})
        for request in ({'action': 'create', 'name': 'gig'}, {'action': 'create', 'name': '  '},
                        {'action': 'create', 'name': 'x' * 25}, {'action': 'rename', 'name': 'Nope', 'new_name': 'A'},
                        {'action': 'delete', 'name': 'Nope'}, {'action': 'move', 'preset': 0, 'group': 'Gig'},
                        {'action': 'move', 'preset': True, 'group': 'Gig'}, {'action': 'other'}):
            with self.assertRaises(ValueError):
                groups.apply(request)
        self.assertEqual(groups.state, {'groups': ['Gig'], 'assignments': {}})

    def test_an_unreadable_file_is_set_aside_rather_than_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'groups.json'
            path.write_text('{not json')
            with contextlib.redirect_stderr(io.StringIO()):
                groups = PresetGroups(path)
            self.assertEqual(groups.state['groups'], [])
            self.assertEqual((Path(directory) / 'groups.json.unreadable').read_text(), '{not json')

    def test_a_failed_write_keeps_the_previous_groups(self):
        with tempfile.TemporaryDirectory() as directory:
            blocker = Path(directory) / 'file'
            blocker.write_text('')
            groups = PresetGroups(blocker / 'groups.json')
            with self.assertRaises(RuntimeError):
                groups.apply({'action': 'create', 'name': 'Gig'})
            self.assertEqual(groups.state['groups'], [])


class SavedPresetTests(unittest.IsolatedAsyncioTestCase):
    def session(self, directory):
        session = EditorTests.session(self, directory)
        session.controller.document['info']['is_factory_default'] = True
        return session

    async def test_saving_marks_the_slot_and_undo_clears_it(self):
        with tempfile.TemporaryDirectory() as directory:
            session = self.session(directory)
            state = await session.save(100, '2:4', 100, 'Surfy')
            self.assertEqual(state['saved_presets'], {'100': 'Surfy'})
            session.controller.restore_preset = AsyncMock()
            session.controller.switch = AsyncMock()
            session.controller.refresh_current = AsyncMock()
            state = await session.undo_save(100, '2:4')
            self.assertEqual(state['saved_presets'], {})

    def test_a_preset_the_amp_says_is_not_factory_is_marked_when_seen(self):
        with tempfile.TemporaryDirectory() as directory:
            session = self.session(directory)
            session.controller.document['info'].update(is_factory_default=False, displayName='Surfy   ')
            self.assertEqual(session.snapshot()['saved_presets'], {'100': 'Surfy'})

    def test_a_factory_preset_is_not_marked(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(self.session(directory).snapshot()['saved_presets'], {})

    def test_marks_survive_a_restart_and_a_failed_write_does_not_raise(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'saved.json'
            SavedPresets(path).set(17, 'Wild Nocturne')
            self.assertEqual(SavedPresets(path).state, {'17': 'Wild Nocturne'})
            (Path(directory) / 'file').write_text('')
            blocked = SavedPresets(Path(directory) / 'file' / 'saved.json')
            with contextlib.redirect_stderr(io.StringIO()):
                blocked.set(17, 'Wild Nocturne')
            self.assertEqual(blocked.state, {'17': 'Wild Nocturne'})


class PresetGroupRequestTests(unittest.IsolatedAsyncioTestCase):
    headers = {'host': 'localhost:8080', 'origin': 'http://localhost:8080', 'content-type': 'application/json'}

    async def test_groups_change_without_the_amp(self):
        session = MicroPlusSession('device-id')
        body = json.dumps({'action': 'create', 'name': 'Gig'}).encode()
        _, _, result = await dispatch('POST', '/api/micro-plus/groups', self.headers, body, session)
        self.assertEqual(json.loads(result)['preset_groups']['groups'], ['Gig'])

    async def test_other_sites_cannot_change_groups(self):
        session = MicroPlusSession('device-id')
        body = json.dumps({'action': 'create', 'name': 'Gig'}).encode()
        with self.assertRaises(HTTPError):
            await dispatch('POST', '/api/micro-plus/groups', {**self.headers, 'origin': 'http://evil.example'}, body, session)
        self.assertEqual(session.groups.state['groups'], [])


class BoardLookTests(unittest.TestCase):
    def test_every_model_has_its_own_look_on_the_board(self):
        root = Path(__file__).resolve().parents[2]
        looks = (root / 'web-app/web_ui/_static/micro-plus-looks.css').read_text(encoding='utf-8')
        models = json.loads((root / 'scripts/mmp_models.json').read_text(encoding='utf-8'))
        for position, choices in models.items():
            for model in choices:
                if model['id'] != 'DUBS_Unknown' and model['id'] not in ('ACD_Deluxe65GT',):  # The default amp look.
                    self.assertIn(f'[data-model="{model["id"]}"]', looks, f'{position}: {model["name"]}')


class FactoryPresetGroupTests(unittest.TestCase):
    def test_every_factory_preset_has_one_group_and_a_description(self):
        root = Path(__file__).resolve().parents[2]
        source = (root / 'web-app/web_ui/_static/micro-plus-presets.js').read_text(encoding='utf-8')
        groups = json.loads(source.split('factoryPresetGroups = ', 1)[1].rstrip().rstrip(';'))
        names = [name for group in groups for name in group['presets']]
        fixture = json.loads((root / 'scripts/mmp_mock_fixture.json').read_text(encoding='utf-8'))
        self.assertCountEqual(names, fixture['names'][:70])
        presets = [preset for group in groups for preset in group['presets'].values()]
        self.assertTrue(all(preset['description'] for preset in presets))
        for preset in presets:
            self.assertLessEqual(set(preset), {'description', 'artists'})
            if 'artists' in preset:
                self.assertTrue(preset['artists'] and all(preset['artists']))


if __name__ == '__main__':
    unittest.main()
