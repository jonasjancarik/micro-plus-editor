"""Own one persistent Micro Plus connection and serialize browser commands."""
import asyncio
import contextlib
import copy
import json
import os
import sys
import time
import traceback
import uuid
from datetime import datetime, timezone
from pathlib import Path
from mmp_ble import Controller, KEEPALIVE, KEEPALIVE_INTERVAL, NAME, RESPONSE, SERVICE
from mmp_groups import CompareList, PresetGroups, SavedPresets
from mmp_protocol import signal_order, with_signal_order

MODELS = json.loads(Path(__file__).with_name('mmp_models.json').read_text())
PARAMETER_CHOICES = json.loads(Path(__file__).with_name('mmp_parameter_choices.json').read_text())
UNSCALED = json.loads(Path(__file__).with_name('mmp_parameter_hints.json').read_text())
SAVED_READ_FAILURES = 3  # The amp has been seen to stop answering these while its connection still looks healthy.
READ_RECONNECT_GAP = 300  # Seconds. If reconnecting doesn't help, trying again every few reads wouldn't either.
PRESET_POSITIONS = {'stomp', 'mod', 'amp', 'delay', 'reverb'}  # Every preset read from the amp has exactly these.


class EditorConflict(ValueError):
    """The device selection changed since the browser read the editor."""


def prepare_import(document, name, target):
    """Check a preset from a file and return the copy to write. Files can come from anyone, so nothing is assumed."""
    from mmp_protocol import save_current_payload, validate_preset
    if isinstance(name, str):
        name = name.strip()
    save_current_payload(name, target)
    validate_preset(document)
    if {node['nodeId'] for node in document['audioGraph']['nodes']} != PRESET_POSITIONS:
        raise ValueError('This file isn\'t a Micro Plus preset, so nothing was changed.')
    if document['info'].get('product_id', 'mustang-ltx') != 'mustang-ltx':
        raise ValueError('This preset is for a different amp, so nothing was changed.')
    # Models aren't checked against MODELS: that list is incomplete, and the amp's own presets can use others.
    # An imported sound gets its own identity, as a copy does, so two slots never claim to be the same preset.
    prepared = copy.deepcopy(document)
    prepared['info'].update(displayName=name, preset_id=str(uuid.uuid4()).upper(), is_factory_default=False)
    return prepared, name


class MicroPlusSession:
    def __init__(self, device=None, log=None, backup_dir='_work/preset-backups', groups_path=None, saved_path=None, compare_path=None):
        self.device_id = device
        self.log = log
        self.backup_dir = Path(backup_dir)
        self.groups = PresetGroups(groups_path)
        self.saved = SavedPresets(saved_path)
        self.compare = CompareList(compare_path)
        self.saved_before_last_save = None
        self.controller = None
        self.client = None
        self.error = None
        self.phase = 'connecting'
        self.connections = 0
        self.connected_since = None
        self.lock = asyncio.Lock()
        self.reset = asyncio.Event()
        self.last_save = None
        self.last_undo = None
        self.generation = 0
        self.saved_read_failures = 0
        self.read_reconnected_at = None
        self.stalled = False
        self.pending_order = None  # A new order waits here until it's saved: the amp has no way to play it before then.

    def waiting_order(self, controller):
        pending = self.pending_order
        if not pending:
            return None
        if pending['slot'] != controller.slot or pending['generation'] != self.generation:
            self.pending_order = None  # The amp moved to another preset or reconnected, so its edits are gone too.
            return None
        return pending['order']

    def snapshot(self):
        controller = self.controller
        connected = bool(controller and self.client and self.client.is_connected)
        if connected and getattr(controller, 'document', None) and controller.document_slot == controller.slot:
            info = controller.document['info']
            if info.get('is_factory_default') is False:  # Saved with another app, perhaps.
                self.saved.set(controller.slot, info['displayName'].rstrip())
        order = self.waiting_order(controller) if connected and getattr(controller, 'document', None) else None
        document = getattr(controller, 'document', None) if connected else None
        return {'connected': connected, 'phase': self.phase, 'error': self.error, 'stalled': self.stalled,
                'device': NAME, 'connections': self.connections,
                'connected_since': self.connected_since,
                'preset': controller.slot if connected else None,
                'name': controller.status()['name'] if connected else None,
                'presets': [{'preset': i + 1, 'name': name}
                            for i, name in enumerate(controller.names)] if connected else [],
                'document': with_signal_order(document, order) if order else document,
                'revision': f'{self.generation}:{getattr(controller, "document_revision", 0)}' if connected else None,
                'dirty': (bool(getattr(controller, 'dirty', False)) or bool(order)) if connected else False,
                'models': MODELS, 'parameter_choices': PARAMETER_CHOICES, 'unscaled': UNSCALED, 'last_save': self.last_save,
                'last_undo': self.last_undo, 'preset_groups': self.groups.state, 'saved_presets': self.saved.state,
                'compare_presets': self.compare.slots}

    def change_groups(self, request):
        self.groups.apply(request)  # Stays on this computer, so it works whether or not the amp is connected.
        return self.snapshot()

    def change_compare(self, request):
        self.compare.apply(request)  # Also stays on this computer.
        return self.snapshot()

    def require_controller(self):
        if not self.controller or not self.client or not self.client.is_connected:
            raise RuntimeError('The Micro Plus is disconnected. Wait for it to reconnect.')
        return self.controller

    def require_editor(self, slot, revision):
        controller = self.require_controller()
        if (type(slot) is not int or controller.slot != slot or
                revision != self.snapshot()['revision'] or not controller.document or
                controller.document_slot != slot):
            raise EditorConflict('The preset changed while you were editing. Review its current settings and try again.')
        return controller

    def unconfirmed(self, action):
        # Callers replace the exception with a friendly message, so this is the only record of the cause.
        print(f'Micro Plus {action} not confirmed:', file=sys.stderr)
        traceback.print_exc()
        sys.stderr.flush()
        messages = {
            'save': 'The save could not be verified. Reconnecting to read the device; check the result before saving again.',
            'undo': 'The undo could not be verified. Reconnecting to read the device; check the result before saving again.',
            'import': 'The import could not be verified. Reconnecting to read the device; check the result before saving again.',
            'saved preset read': 'Your Micro Plus stopped answering, so the editor is reconnecting to it.',
            'preset selection': 'The Micro Plus did not confirm the switch, so it may already be on the new preset. '
                                'Reconnecting to check.'}
        self.error = messages.get(action, f'The Micro Plus did not confirm the {action}. '
                                          'Reconnecting to read its current settings.')
        self.controller = None
        self.reset.set()
        return RuntimeError(self.error)

    async def switch(self, slot):
        if type(slot) is not int or not 1 <= slot <= 100:
            raise ValueError('Choose a preset number from 1 to 100.')
        async with self.lock:
            controller = self.require_controller()
            try:
                await controller.switch(slot)
                await controller.refresh_current()
                self.pending_order = None  # Choosing the same preset again is how the page discards changes.
                return self.snapshot()
            except ValueError:
                raise
            except Exception:
                raise self.unconfirmed('preset selection') from None

    async def edit(self, slot, revision, node, parameter, value):
        async with self.lock:
            controller = self.require_editor(slot, revision)
            if not isinstance(node, str) or not isinstance(parameter, str):
                raise ValueError('Choose an amplifier or effect parameter.')
            try:
                limited = await controller.set_parameter(node, parameter, value)
                snapshot = self.snapshot()
                if limited is not None:
                    snapshot['limited'] = {'node': node, 'parameter': parameter, 'requested': value, 'stored': limited}
                return snapshot
            except ValueError:
                raise
            except Exception:
                raise self.unconfirmed('parameter change') from None

    async def replace(self, slot, revision, node, model):
        async with self.lock:
            controller = self.require_editor(slot, revision)
            if not isinstance(node, str) or not isinstance(model, str):
                raise ValueError('Choose an amplifier or effect model.')
            if model not in {entry['id'] for entry in MODELS.get(node, [])}:
                raise ValueError('That model is not in the Micro Plus model list.')
            if node not in {entry['nodeId'] for entry in controller.document['audioGraph']['nodes']}:
                raise ValueError('That module is not present in the current preset.')
            try:
                await controller.replace_node(node, model)
                return self.snapshot()
            except ValueError:
                raise
            except Exception:
                raise self.unconfirmed('amplifier or effect change') from None

    async def set_order(self, slot, revision, order):
        async with self.lock:
            controller = self.require_editor(slot, revision)
            with_signal_order(controller.document, order)  # Rejects anything but the same positions in a new order.
            self.pending_order = None if order == signal_order(controller.document) else {
                'slot': slot, 'generation': self.generation, 'order': list(order)}
            return self.snapshot()

    async def read_stored(self, controller, slot):
        # Only reads, so one failure says little about the connection. Several in a row mean the amp has stalled.
        try:
            document = await controller.read_preset(slot)
        except ValueError:
            raise
        except Exception as error:
            self.saved_read_failures += 1
            print(f'Micro Plus saved preset read failed, {self.saved_read_failures} in a row: {error!r}',
                  file=sys.stderr, flush=True)
            now = time.monotonic()
            if self.saved_read_failures >= SAVED_READ_FAILURES and (
                    self.read_reconnected_at is None or now - self.read_reconnected_at >= READ_RECONNECT_GAP):
                self.read_reconnected_at = now
                self.stalled = True
                raise self.unconfirmed('saved preset read') from None
            raise RuntimeError('The Micro Plus did not send the saved preset.') from error
        self.saved_read_failures = 0
        return document

    async def saved_copy(self, slot, revision):
        async with self.lock:
            controller = self.require_editor(slot, revision)
            document = await self.read_stored(controller, slot)
            self.require_editor(slot, revision)
            return {'preset': slot, 'revision': revision, 'saved_document': document}

    async def read_slot(self, slot):
        """Read any slot for exporting. Reading doesn't depend on what the page is editing."""
        if type(slot) is not int or not 1 <= slot <= 100:
            raise ValueError('Choose a preset number from 1 to 100.')
        async with self.lock:
            return {'slot': slot, 'saved_document': await self.read_stored(self.require_controller(), slot)}

    def backup(self, slot, document):
        self.backup_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
        path = self.backup_dir / f'{stamp}-preset-{slot:03d}.json'
        with path.open('x', encoding='utf-8') as stream:
            json.dump({'format': 'maneline-micro-plus-backup-v1', 'device': self.device_id,
                       'slot': slot, 'preset': document}, stream, indent=2, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        return path.name

    async def save(self, slot, revision, target, name):
        from mmp_protocol import save_current_payload
        if isinstance(name, str):
            name = name.strip()
        save_current_payload(name, target)  # Validate before reading or writing the device.
        async with self.lock:
            controller = self.require_editor(slot, revision)
            try:
                original = await controller.read_preset(target)
                backup = self.backup(target, original)  # Must succeed before a write is sent.
                # A physical preset change during the backup must not save the wrong sound.
                self.require_editor(slot, revision)
                order = self.waiting_order(controller)
                if order:  # Saving on the amp would keep its old order, so the whole preset has to be sent.
                    document = with_signal_order(controller.document, order)
                    document['info']['displayName'] = name
                    if target != slot:  # A copy gets its own identity, as in save_current.
                        document['info'].update(preset_id=str(uuid.uuid4()).upper(), is_factory_default=False)
                    await self.write_stored(controller, target, document)
                else:
                    await controller.save_current(name, target)
                self.saved_before_last_save = self.saved.state.get(str(target))
                self.saved.set(target, name)
                self.last_save = {'preset': target, 'name': name, 'backup': backup,
                                  'verified': True, 'time': time.time()}
                return self.snapshot()
            except TimeoutError:  # An OSError, but the amp not answering is not a failed backup.
                raise self.unconfirmed('save') from None
            except (ValueError, OSError):
                raise
            except Exception:
                raise self.unconfirmed('save') from None

    async def write_stored(self, controller, target, document):
        await controller.restore_preset(document, target)
        if target == controller.slot:
            # The amp keeps playing its live copy until the slot is selected again.
            await controller.switch(target)
        await controller.refresh_current()
        self.pending_order = None

    async def import_preset(self, slot, revision, target, name, document):
        prepared, name = prepare_import(document, name, target)  # Validate before reading or writing the device.
        async with self.lock:
            controller = self.require_editor(slot, revision)
            try:
                original = await controller.read_preset(target)
                backup = self.backup(target, original)  # Must succeed before a write is sent.
                self.require_editor(slot, revision)
                await self.write_stored(controller, target, prepared)
                self.saved_before_last_save = self.saved.state.get(str(target))
                self.saved.set(target, name)
                # Recorded as a save, so Undo this save covers an import too.
                self.last_save = {'preset': target, 'name': name, 'backup': backup,
                                  'verified': True, 'time': time.time()}
                return self.snapshot()
            except TimeoutError:  # An OSError, but the amp not answering is not a failed backup.
                raise self.unconfirmed('import') from None
            except (ValueError, OSError):
                raise
            except Exception:
                raise self.unconfirmed('import') from None

    async def undo_save(self, slot, revision):
        async with self.lock:
            controller = self.require_editor(slot, revision)
            save = self.last_save
            if not save:
                raise ValueError('There is no recent save to undo.')
            target = save['preset']
            backup = json.loads((self.backup_dir / save['backup']).read_text(encoding='utf-8'))
            if backup.get('slot') != target:
                raise ValueError('That backup belongs to a different preset, so nothing was changed.')
            try:
                replaced = await controller.read_preset(target)
                safety = self.backup(target, replaced)  # Undo must itself be recoverable.
                self.require_editor(slot, revision)
                await self.write_stored(controller, target, backup['preset'])
                self.saved.set(target, self.saved_before_last_save)
                self.last_save = None
                self.last_undo = {'preset': target, 'backup': safety, 'time': time.time()}
                return self.snapshot()
            except TimeoutError:
                raise self.unconfirmed('undo') from None
            except (ValueError, OSError):
                raise
            except Exception:
                raise self.unconfirmed('undo') from None

    async def keep_alive(self, controller):
        try:
            while not self.reset.is_set():
                await asyncio.sleep(KEEPALIVE_INTERVAL)
                if controller.failure:
                    raise controller.failure
                await controller.send(KEEPALIVE)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            controller.failure = error
            controller.changed.set()
            self.reset.set()

    async def run(self):
        from bleak import BleakClient, BleakScanner
        while True:
            self.reset.clear()
            self.phase = 'connecting'
            try:
                device = await BleakScanner.find_device_by_filter(
                    lambda d, advert: (d.name == NAME or advert.local_name == NAME)
                    and (self.device_id is None or d.address == self.device_id),
                    service_uuids=[SERVICE], timeout=10)
                if device is None:
                    raise RuntimeError('Micro Plus not found. Turn it on and close Fender Tone on other devices.')
                self.device_id = device.address
                async with BleakClient(device, disconnected_callback=lambda _: self.reset.set()) as client:
                    self.client = client
                    controller = Controller(client, self.log)
                    await client.start_notify(RESPONSE, controller.notify)
                    await controller.initialize()
                    keepalive = asyncio.create_task(self.keep_alive(controller))
                    try:
                        await controller.refresh_current()
                        self.controller = controller
                        self.generation = uuid.uuid4().hex
                        self.connections += 1
                        self.connected_since = time.time()
                        self.phase = 'connected'
                        self.error = None
                        self.stalled = False
                        self.saved_read_failures = 0
                        await self.reset.wait()
                    finally:
                        keepalive.cancel()
                        with contextlib.suppress(asyncio.CancelledError):
                            await keepalive
            except asyncio.CancelledError:
                raise
            except Exception as error:
                self.error = str(error) or 'The Bluetooth connection was lost.'
            finally:
                self.controller = None
                self.client = None
                self.connected_since = None
                self.phase = 'disconnected'
            await asyncio.sleep(2)
