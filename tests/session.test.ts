import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Amp } from '../src/core/amp';
import { CURRENT } from '../src/core/commands';
import { AmpError, BackupError, EditorConflict, InputError } from '../src/core/errors';
import { fragments, request } from '../src/core/frames';
import { CompareList, PresetGroups, SavedPresets } from '../src/core/groups';
import { encodePreset, signalOrder, withSignalOrder, type Preset } from '../src/core/preset';
import { MicroPlusSession, READ_RECONNECT_GAP_MS, SAVED_READ_FAILURES } from '../src/core/session';
import { MemoryStore } from '../src/core/storage';
import { concat, hex, wireBytes, wireString, wireUint } from '../src/core/wire';
import type { BleTransport } from '../src/transport/types';

const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/wire.json'), 'utf8'));
const STANDARD = ['stomp', 'mod', 'amp', 'delay', 'reverb'];

const small = (name = 'Test'): Preset => ({ nodeType: 'preset', info: { displayName: name },
  audioGraph: { nodes: [{ nodeId: 'amp', FenderId: 'ACD_LinearGainGT', dspUnitParameters: { gain: 0.5, gatePreset: 'off' } }] } });

const full = (name = 'From file'): Preset => ({ nodeType: 'preset',
  audioGraph: { nodes: STANDARD.map((nodeId) => ({ nodeId, FenderId: 'ACD_Test', dspUnitParameters: { gain: 0.5 } })) },
  info: { displayName: name, preset_id: 'ORIGINAL', product_id: 'mustang-ltx', is_factory_default: true } });

function connectedTransport(): BleTransport {
  return { connect: async () => {}, hasDevice: () => true, deviceId: () => 'device-id', write: async () => {}, onNotify: () => {},
    onDisconnect: () => () => {}, isConnected: () => true, disconnect: async () => {} };
}

function fakeAmp(slot: number, document: Preset, stored: Preset) {
  return { slot, documentSlot: slot, document, documentRevision: 4, dirty: false, names: Array(100).fill('Test') as string[],
    status: () => ({ preset: slot, name: 'Test' }),
    readPreset: vi.fn(async () => stored), saveCurrent: vi.fn(async () => stored), setParameter: vi.fn(async () => null as number | null),
    replaceNode: vi.fn(async () => {}), restorePreset: vi.fn(async () => stored), switchTo: vi.fn(async () => {}), refreshCurrent: vi.fn(async () => document) };
}

function makeSession(amp: ReturnType<typeof fakeAmp>, store = new MemoryStore()) {
  const session = new MicroPlusSession(connectedTransport(), store, new PresetGroups(), new SavedPresets(), new CompareList());
  session.amp = amp as unknown as Amp;
  session.generation = '2';
  return { session, amp, store, reconnecting: () => session.amp === null };
}

class NoBackups extends MemoryStore {
  override async create(): Promise<void> {
    throw new Error('disk full');
  }
}

const backups = (store: MemoryStore) => [...store.files.keys()].filter((name) => name.startsWith('backups/'));
const backupOf = (store: MemoryStore, index = 0) => JSON.parse(store.files.get(backups(store)[index]!)!);

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => { errors = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { errors.mockRestore(); });

describe('editing', () => {
  const setup = (store?: MemoryStore) => {
    const current = small();
    current.audioGraph.nodes[0]!.dspUnitParameters.gain = 0.6;
    const made = makeSession(fakeAmp(100, current, small()), store);
    made.amp.dirty = true;
    return made;
  };

  it('backs up what is stored before saving', async () => {
    const { session, amp, store } = setup();
    amp.saveCurrent.mockImplementation(async () => {
      expect(backups(store)).toHaveLength(1);
      const backup = backupOf(store);
      expect(backup.slot).toBe(100);
      expect(backup.format).toBe('maneline-micro-plus-backup-v1');
      expect(backup.preset.audioGraph.nodes[0].dspUnitParameters.gain).toBe(0.5);
      expect(amp.document.audioGraph.nodes[0]!.dspUnitParameters.gain).toBe(0.6);
      return small();
    });
    const result = await session.save(100, '2:4', 100, ' Edited ');
    expect(result.last_save!.verified).toBe(true);
    expect(amp.saveCurrent).toHaveBeenCalledWith('Edited', 100);
  });

  it('logs the real cause of an unconfirmed change, and reconnects', async () => {
    const { session, amp, reconnecting } = setup();
    amp.setParameter.mockRejectedValue(new AmpError('Timed out'));
    await expect(session.edit(100, '2:4', 'delay', 'dlytime', 0.02)).rejects.toThrow('did not confirm');
    expect(errors.mock.calls[0]![0]).toContain('parameter change not confirmed');
    expect(String(errors.mock.calls[0]![1])).toContain('Timed out');
    expect(reconnecting()).toBe(true);
  });

  it('keeps the connection for a change the amp refused', async () => {
    const { session, amp, reconnecting } = setup();
    amp.setParameter.mockRejectedValue(new InputError('The Micro Plus rejected the change: invalid parameter'));
    await expect(session.edit(100, '2:4', 'amp', 'gain', 0.2)).rejects.toThrow('rejected');
    expect(reconnecting()).toBe(false);
  });

  it('keeps the connection when the amp limits a value, and says what it stored', async () => {
    const { session, amp, reconnecting } = setup();
    amp.setParameter.mockResolvedValue(0.03);
    const state = await session.edit(100, '2:4', 'amp', 'gain', 0.02);
    expect(reconnecting()).toBe(false);
    expect(session.error).toBeNull();
    expect(state.limited).toEqual({ node: 'amp', parameter: 'gain', requested: 0.02, stored: 0.03 });
  });

  it('reads a saved copy and writes nothing', async () => {
    const { session, amp, store } = setup();
    const result = await session.savedCopy(100, '2:4');
    expect(result.saved_document.audioGraph.nodes[0]!.dspUnitParameters.gain).toBe(0.5);
    expect([result.preset, result.revision]).toEqual([100, '2:4']);
    expect(amp.readPreset).toHaveBeenCalledWith(100);
    expect(amp.saveCurrent).not.toHaveBeenCalled();
    expect(amp.setParameter).not.toHaveBeenCalled();
    expect(backups(store)).toEqual([]);
  });

  const failReads = async (made: ReturnType<typeof setup>, count: number) => {
    made.amp.readPreset.mockRejectedValue(new AmpError('Timed out'));
    for (let i = 0; i < count; i++) await expect(made.session.savedCopy(100, '2:4')).rejects.toThrow('did not send the saved preset');
  };

  it('keeps the connection after a failed saved copy', async () => {
    const made = setup();
    await failReads(made, SAVED_READ_FAILURES - 1);
    expect(made.reconnecting()).toBe(false);
    expect(made.session.error).toBeNull();
    expect(made.session.snapshot().stalled).toBe(false);
  });

  it('reconnects after saved copies keep failing', async () => {
    const made = setup();
    await failReads(made, SAVED_READ_FAILURES - 1);
    await expect(made.session.savedCopy(100, '2:4')).rejects.toThrow('stopped answering');
    expect(made.reconnecting()).toBe(true);
    expect(made.session.stalled).toBe(true);
    expect(errors.mock.calls.some((call: unknown[]) => String(call[0]).includes('saved preset read failed, 3 in a row'))).toBe(true);
  });

  it('starts counting again after a good saved copy', async () => {
    const made = setup();
    await failReads(made, SAVED_READ_FAILURES - 1);
    made.amp.readPreset.mockResolvedValue(small());
    await made.session.savedCopy(100, '2:4');
    await failReads(made, SAVED_READ_FAILURES - 1);
    expect(made.reconnecting()).toBe(false);
  });

  it('does not reconnect again straight away', async () => {
    const made = setup();
    made.session.readReconnectedAt = performance.now();
    await failReads(made, SAVED_READ_FAILURES + 2);
    expect(made.reconnecting()).toBe(false);
    made.session.readReconnectedAt = performance.now() - READ_RECONNECT_GAP_MS;
    await expect(made.session.savedCopy(100, '2:4')).rejects.toThrow('stopped answering');
    expect(made.reconnecting()).toBe(true);
  });

  it('does not count a stale page as a failed read', async () => {
    const { session, reconnecting } = setup();
    for (let i = 0; i <= SAVED_READ_FAILURES; i++) await expect(session.savedCopy(100, '2:3')).rejects.toThrow(EditorConflict);
    expect(session.savedReadFailures).toBe(0);
    expect(reconnecting()).toBe(false);
  });

  it('treats a timed-out save as unverified rather than as a failed backup', async () => {
    const { session, amp, reconnecting } = setup();
    amp.saveCurrent.mockRejectedValue(new AmpError('Timed out'));
    await expect(session.save(100, '2:4', 100, 'Edited')).rejects.toThrow('could not be verified');
    expect(reconnecting()).toBe(true);
  });

  it('does not save when the backup fails, and stays connected', async () => {
    const { session, amp, reconnecting } = setup(new NoBackups());
    await expect(session.save(100, '2:4', 100, 'Edited')).rejects.toThrow(BackupError);
    expect(amp.saveCurrent).not.toHaveBeenCalled();
    expect(reconnecting()).toBe(false);
  });

  it('does not save when someone turns the knob during the backup', async () => {
    const { session, amp } = setup();
    amp.readPreset.mockImplementation(async () => {
      amp.slot = 17;
      return small();
    });
    await expect(session.save(100, '2:4', 100, 'Edited')).rejects.toThrow(EditorConflict);
    expect(amp.saveCurrent).not.toHaveBeenCalled();
  });

  it('refuses edits from before a reconnection', async () => {
    const { session, amp } = setup();
    await expect(session.edit(100, '1:4', 'amp', 'gain', 0.6)).rejects.toThrow(EditorConflict);
    expect(amp.setParameter).not.toHaveBeenCalled();
  });

  it('refuses edits to a preset no longer selected', async () => {
    const { session, amp } = setup();
    await expect(session.edit(17, '2:4', 'amp', 'gain', 0.6)).rejects.toThrow(EditorConflict);
    expect(amp.setParameter).not.toHaveBeenCalled();
  });

  it('only accepts models from the list', async () => {
    const { session, amp } = setup();
    await expect(session.replace(100, '2:4', 'amp', 'unknown-model')).rejects.toThrow(InputError);
    expect(amp.replaceNode).not.toHaveBeenCalled();
  });

  it.each([[0], [101], [true], ['100']])('never touches the amp for save target %s', async (target) => {
    const { session, amp } = setup();
    await expect(session.save(100, '2:4', target, 'Edited')).rejects.toThrow(InputError);
    expect(amp.readPreset).not.toHaveBeenCalled();
    expect(amp.saveCurrent).not.toHaveBeenCalled();
  });

  it('runs commands one at a time', async () => {
    const { session, amp } = setup();
    const order: string[] = [];
    let release = () => {};
    amp.readPreset.mockImplementationOnce(() => new Promise((done) => { release = () => { order.push('first'); done(small()); }; }));
    amp.readPreset.mockImplementationOnce(async () => { order.push('second'); return small(); });
    const first = session.savedCopy(100, '2:4');
    const second = session.savedCopy(100, '2:4');
    await new Promise((done) => setTimeout(done));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
  });

  it('carries on after a command failed', async () => {
    const { session } = setup();
    await expect(session.edit(1, 'old', 'amp', 'gain', 0.6)).rejects.toThrow(EditorConflict);
    await expect(session.savedCopy(100, '2:4')).resolves.toBeTruthy();
  });

  it('says the amp is disconnected instead of trying', async () => {
    const session = new MicroPlusSession(connectedTransport(), new MemoryStore(), new PresetGroups(), new SavedPresets(), new CompareList());
    await expect(session.readSlot(42)).rejects.toThrow('disconnected');
    await expect(session.switch(42)).rejects.toThrow('disconnected');
  });
});

describe('undoing a save', () => {
  const setup = async (slot = 100, target = 100, store?: MemoryStore) => {
    const made = makeSession(fakeAmp(slot, small(), small()));
    const name = await made.session.backup(target, small('Before save'));
    if (store) (made.session as unknown as { store: MemoryStore }).store = store;
    made.session.lastSave = { preset: target, name: 'Edited', backup: name, verified: true, time: 1 };
    return made;
  };

  it('restores the backup, and backs up what it replaces', async () => {
    const { session, amp, store } = await setup();
    const result = await session.undoSave(100, '2:4');
    const [restored, target] = amp.restorePreset.mock.calls[0]! as unknown as [Preset, number];
    expect([restored.info.displayName, target]).toEqual(['Before save', 100]);
    expect(backups(store)).toHaveLength(2);
    expect(result.last_save).toBeNull();
    expect(result.last_undo!.preset).toBe(100);
  });

  it('reselects the slot being played, but no other', async () => {
    const active = await setup();
    await active.session.undoSave(100, '2:4');
    expect(active.amp.switchTo).toHaveBeenCalledExactlyOnceWith(100);
    const other = await setup(17, 100);
    await other.session.undoSave(17, '2:4');
    expect(other.amp.switchTo).not.toHaveBeenCalled();
  });

  it('does not undo when the safety backup fails', async () => {
    const { session, amp, store } = await setup();
    const create = vi.spyOn(store, 'create').mockRejectedValue(new Error('disk full'));
    await expect(session.undoSave(100, '2:4')).rejects.toThrow(BackupError);
    expect(amp.restorePreset).not.toHaveBeenCalled();
    expect(session.lastSave).not.toBeNull();
    create.mockRestore();
  });

  it('refuses when there is no save to undo', async () => {
    const { session, amp } = await setup();
    session.lastSave = null;
    await expect(session.undoSave(100, '2:4')).rejects.toThrow('no recent save');
    expect(amp.restorePreset).not.toHaveBeenCalled();
  });

  it('refuses a stale page', async () => {
    const { session, amp } = await setup();
    await expect(session.undoSave(100, 'old')).rejects.toThrow(EditorConflict);
    expect(amp.restorePreset).not.toHaveBeenCalled();
  });

  it('refuses a backup of another slot', async () => {
    const { session, amp, store } = await setup();
    const name = backups(store)[0]!;
    store.files.set(name, JSON.stringify({ slot: 5, preset: small() }));
    await expect(session.undoSave(100, '2:4')).rejects.toThrow('different preset');
    expect(amp.restorePreset).not.toHaveBeenCalled();
  });

  it('reports a missing backup and writes nothing', async () => {
    const { session, amp, store } = await setup();
    store.files.clear();
    await expect(session.undoSave(100, '2:4')).rejects.toThrow(BackupError);
    expect(amp.restorePreset).not.toHaveBeenCalled();
  });
});

describe('saved preset marks', () => {
  const setup = () => {
    const document = small();
    document.info.is_factory_default = true;
    return makeSession(fakeAmp(100, document, small()));
  };

  it('are set by saving and cleared by undoing', async () => {
    const { session } = setup();
    const state = await session.save(100, '2:4', 100, 'Surfy');
    expect(state.saved_presets).toEqual({ 100: 'Surfy' });
    expect((await session.undoSave(100, '2:4')).saved_presets).toEqual({});
  });

  it('are set when the amp says a preset is not a factory one', () => {
    const { session, amp } = setup();
    Object.assign(amp.document.info, { is_factory_default: false, displayName: 'Surfy   ' });
    expect(session.snapshot().saved_presets).toEqual({ 100: 'Surfy' });
  });

  it('are not set for a factory preset', () => {
    expect(setup().session.snapshot().saved_presets).toEqual({});
  });
});

describe('groups and the compare list', () => {
  it('work without the amp', async () => {
    const session = new MicroPlusSession({ ...connectedTransport(), isConnected: () => false }, new MemoryStore(), new PresetGroups(), new SavedPresets(), new CompareList());
    expect((await session.changeGroups({ action: 'create', name: 'Gig' })).preset_groups.groups).toEqual(['Gig']);
    expect((await session.changeCompare({ action: 'add', preset: 17 })).compare_presets).toEqual([17]);
  });
});

describe('pedal order', () => {
  const MOVED = ['reverb', 'delay', 'mod', 'amp', 'stomp'];
  const setup = () => {
    const document = withSignalOrder(full('Active'), STANDARD);
    return makeSession(fakeAmp(100, document, small()));
  };

  it('is an unsaved change that writes nothing', async () => {
    const { session, amp } = setup();
    const state = await session.setOrder(100, '2:4', MOVED);
    expect(state.dirty).toBe(true);
    expect(signalOrder(state.document!)).toEqual(MOVED);
    expect(signalOrder(amp.document)).toEqual(STANDARD);
    expect(amp.restorePreset).not.toHaveBeenCalled();
    expect(amp.readPreset).not.toHaveBeenCalled();
  });

  it('leaves nothing to save once back to the saved order', async () => {
    const { session } = setup();
    await session.setOrder(100, '2:4', MOVED);
    expect((await session.setOrder(100, '2:4', STANDARD)).dirty).toBe(false);
  });

  it('must hold every position once', async () => {
    const { session } = setup();
    for (const order of [['stomp', 'mod', 'amp', 'delay'], ['stomp', 'stomp', 'amp', 'delay', 'reverb'], 'stomp', null]) {
      await expect(session.setOrder(100, '2:4', order)).rejects.toThrow(InputError);
    }
    expect(session.pendingOrder).toBeNull();
  });

  it('goes out with the whole preset when saved, after a backup', async () => {
    const { session, amp, store } = setup();
    await session.setOrder(100, '2:4', MOVED);
    amp.restorePreset.mockImplementation(async () => {
      expect(backups(store)).toHaveLength(1);
      return small();
    });
    const state = await session.save(100, '2:4', 100, 'Moved');
    expect(amp.saveCurrent).not.toHaveBeenCalled();
    const [document, target] = amp.restorePreset.mock.calls[0]! as unknown as [Preset, number];
    expect([target, signalOrder(document), document.info.displayName]).toEqual([100, MOVED, 'Moved']);
    expect(session.pendingOrder).toBeNull();
    expect(state.last_save!.name).toBe('Moved');
    expect(amp.switchTo).toHaveBeenCalledWith(100);
  });

  it('gives a copy its own identity', async () => {
    const { session, amp } = setup();
    await session.setOrder(100, '2:4', MOVED);
    await session.save(100, '2:4', 99, 'Copy');
    const [document, target] = amp.restorePreset.mock.calls[0]! as unknown as [Preset, number];
    expect(target).toBe(99);
    expect(document.info.preset_id).not.toBe('ORIGINAL');
    expect(document.info.is_factory_default).toBe(false);
    expect(amp.switchTo).not.toHaveBeenCalled();
  });

  it('leaves an ordinary save to the amp', async () => {
    const { session, amp } = setup();
    await session.save(100, '2:4', 100, 'Same');
    expect(amp.saveCurrent).toHaveBeenCalledExactlyOnceWith('Same', 100);
    expect(amp.restorePreset).not.toHaveBeenCalled();
  });

  it('is dropped on another preset or after reconnecting', async () => {
    const changes: ((made: ReturnType<typeof setup>) => void)[] = [
      ({ amp }) => { amp.slot = amp.documentSlot = 5; },
      ({ session }) => { session.generation = '3'; },
    ];
    for (const change of changes) {
      const made = setup();
      await made.session.setOrder(100, '2:4', MOVED);
      change(made);
      const state = made.session.snapshot();
      expect(state.dirty).toBe(false);
      expect(signalOrder(state.document!)).toEqual(STANDARD);
      expect(made.session.pendingOrder).toBeNull();
    }
  });

  it('is discarded by choosing the preset again', async () => {
    const { session } = setup();
    await session.setOrder(100, '2:4', MOVED);
    expect((await session.switch(100)).dirty).toBe(false);
  });
});

describe('importing a file', () => {
  const setup = (slot = 17, store?: MemoryStore) => makeSession(fakeAmp(slot, full('Active'), full('Before import')), store);

  it('backs up the slot first and gives the copy its own identity', async () => {
    const { session, amp, store } = setup();
    const source = full();
    const untouched = structuredClone(source);
    amp.restorePreset.mockImplementation(async () => {
      expect(backups(store)).toHaveLength(1);
      expect(backupOf(store).preset.info.displayName).toBe('Before import');
      return full();
    });
    const result = await session.importPreset(17, '2:4', 50, ' Renamed ', source);
    const [written, target] = amp.restorePreset.mock.calls[0]! as unknown as [Preset, number];
    expect(target).toBe(50);
    expect(written.info.displayName).toBe('Renamed');
    expect(written.info.preset_id).not.toBe('ORIGINAL');
    expect(written.info.is_factory_default).toBe(false);
    expect(source).toEqual(untouched);
    expect([result.last_save!.preset, result.last_save!.name]).toEqual([50, 'Renamed']);
    expect(result.saved_presets['50']).toBe('Renamed');
  });

  it('reselects the slot being played, but no other', async () => {
    const active = setup();
    await active.session.importPreset(17, '2:4', 17, 'New', full());
    expect(active.amp.switchTo).toHaveBeenCalledExactlyOnceWith(17);
    const other = setup();
    await other.session.importPreset(17, '2:4', 50, 'New', full());
    expect(other.amp.switchTo).not.toHaveBeenCalled();
  });

  it('can be undone', async () => {
    const { session, amp } = setup();
    await session.importPreset(17, '2:4', 50, 'New', full());
    amp.restorePreset.mockClear();
    const result = await session.undoSave(17, '2:4');
    const [restored, target] = amp.restorePreset.mock.calls[0]! as unknown as [Preset, number];
    expect([restored.info.displayName, target]).toEqual(['Before import', 50]);
    expect(result.last_save).toBeNull();
    expect(result.saved_presets).not.toHaveProperty('50');
  });

  it('never sends a bad file to the amp', async () => {
    const otherAmp = full();
    otherAmp.info.product_id = 'mustang-lt25';
    const missing = full();
    missing.audioGraph.nodes.pop();
    const extra = full();
    extra.audioGraph.nodes.push({ nodeId: 'other', FenderId: 'x', dspUnitParameters: {} });
    const swapped = full();
    swapped.audioGraph.nodes[0]!.nodeId = 'other';
    const cases: [unknown, unknown, unknown][] = [[otherAmp, 50, 'Name'], [missing, 50, 'Name'], [extra, 50, 'Name'], [swapped, 50, 'Name'],
      ['text', 50, 'Name'], [null, 50, 'Name'], [{ nodeType: 'preset' }, 50, 'Name'], [full(), 0, 'Name'], [full(), 101, 'Name'],
      [full(), true, 'Name'], [full(), 50, ''], [full(), 50, 'x'.repeat(17)]];
    const { session, amp } = setup();
    for (const [document, target, name] of cases) {
      await expect(session.importPreset(17, '2:4', target, name, document)).rejects.toThrow(InputError);
    }
    expect(amp.readPreset).not.toHaveBeenCalled();
    expect(amp.restorePreset).not.toHaveBeenCalled();
  });

  it('allows a model that is not on the list', async () => {
    // A real amp preset uses a model missing from the list, so the list can't be a gate.
    const { session, amp } = setup();
    await session.importPreset(17, '2:4', 50, 'New', full());
    expect(amp.restorePreset).toHaveBeenCalledOnce();
  });

  it('does not write when the backup fails', async () => {
    const { session, amp } = setup(17, new NoBackups());
    await expect(session.importPreset(17, '2:4', 50, 'New', full())).rejects.toThrow(BackupError);
    expect(amp.restorePreset).not.toHaveBeenCalled();
  });

  it('does not write when someone turns the knob during the backup', async () => {
    const { session, amp } = setup();
    amp.readPreset.mockImplementation(async () => {
      amp.slot = 18;
      return full('Before import');
    });
    await expect(session.importPreset(17, '2:4', 50, 'New', full())).rejects.toThrow(EditorConflict);
    expect(amp.restorePreset).not.toHaveBeenCalled();
  });

  it('reconnects and records no save when the read back fails', async () => {
    const { session, amp, reconnecting } = setup();
    amp.restorePreset.mockRejectedValue(new AmpError('Read-back verification of the restored preset failed'));
    await expect(session.importPreset(17, '2:4', 50, 'New', full())).rejects.toThrow('could not be verified');
    expect(reconnecting()).toBe(true);
    expect(session.lastSave).toBeNull();
    expect(session.saved.state).toEqual({});
  });

  it('is refused for a stale page', async () => {
    const { session, amp } = setup();
    await expect(session.importPreset(17, '2:3', 50, 'New', full())).rejects.toThrow(EditorConflict);
    expect(amp.readPreset).not.toHaveBeenCalled();
  });
});

describe('reading any slot', () => {
  const setup = () => makeSession(fakeAmp(17, full(), full('Stored')));

  it('returns what is stored there', async () => {
    const { session, amp } = setup();
    const reply = await session.readSlot(42);
    expect([reply.slot, reply.saved_document.info.displayName]).toEqual([42, 'Stored']);
    expect(amp.readPreset).toHaveBeenCalledExactlyOnceWith(42);
  });

  it.each([[0], [101], [1.5], [true], ['42'], [null]])('never asks the amp for slot %s', async (slot) => {
    const { session, amp } = setup();
    await expect(session.readSlot(slot)).rejects.toThrow(InputError);
    expect(amp.readPreset).not.toHaveBeenCalled();
  });

  it('reconnects when reads keep failing', async () => {
    const { session, amp, reconnecting } = setup();
    amp.readPreset.mockRejectedValue(new AmpError('Timed out'));
    for (let i = 0; i < SAVED_READ_FAILURES - 1; i++) await expect(session.readSlot(42)).rejects.toThrow('did not send');
    expect(reconnecting()).toBe(false);
    await expect(session.readSlot(42)).rejects.toThrow('reconnecting');
    expect(reconnecting()).toBe(true);
    expect(session.stalled).toBe(true);
  });
});

describe('what the page is told', () => {
  it('has the same fields as the Python server', () => {
    const { session } = makeSession(fakeAmp(100, small(), small()));
    expect(Object.keys(session.snapshot()).sort()).toEqual(fixture.snapshotFields);
  });
});

/** Answers like an amp, enough to get connected. */
function ampOnBluetooth(options: { chosen?: boolean; cancel?: Error } = {}) {
  let connected = false;
  let chosen = options.chosen ?? true;
  let notify: (data: Uint8Array) => void = () => {};
  const disconnects = new Set<() => void>();
  const current = hex(fragments(request(CURRENT, wireUint(1, 1)))[0]!);
  const send = (kind: number, content: Uint8Array) => {
    for (const part of fragments(wireBytes(2, wireBytes(kind, content)), 100)) notify(part);
  };
  const transport: BleTransport & { drop(): void; connects: number } = {
    connects: 0,
    async connect() {
      if (!chosen && options.cancel) throw options.cancel;
      chosen = true;
      connected = true;
      this.connects++;
    },
    hasDevice: () => chosen,
    deviceId: () => 'device-id',
    async write(data) {
      const sent = hex(data);
      setTimeout(() => {
        if (sent === '3500041a020801') {
          send(5, wireUint(1, 16));
          send(12, concat(...Array.from({ length: 100 }, (_, index) => wireString(1, `Preset ${index + 1}`))));
        } else if (sent === current) {
          send(4, wireBytes(1, encodePreset(full('Live'))));
        }
      });
    },
    onNotify(listener) { notify = listener; },
    onDisconnect(listener) {
      disconnects.add(listener);
      return () => disconnects.delete(listener);
    },
    isConnected: () => connected,
    async disconnect() { connected = false; },
    drop() {
      connected = false;
      disconnects.forEach((listener) => listener());
    },
  };
  return transport;
}

const until = (ready: () => boolean) => vi.waitFor(() => expect(ready()).toBe(true), { timeout: 4000, interval: 10 });

describe('connecting', () => {
  const open = (transport: BleTransport) => {
    const session = new MicroPlusSession(transport, new MemoryStore(), new PresetGroups(), new SavedPresets(), new CompareList());
    session.retryMs = 10;
    return session;
  };

  it('waits for a click, connects, and reads the amp', async () => {
    const session = open(ampOnBluetooth());
    expect(session.snapshot().phase).toBe('waiting');
    expect(session.snapshot().connected).toBe(false);
    void session.start();
    await until(() => session.phase === 'connected');
    const state = session.snapshot();
    expect(state.connected).toBe(true);
    expect([state.preset, state.name, state.presets.length, state.document!.info.displayName]).toEqual([17, 'Preset 17', 100, 'Live']);
    expect(state.connected_since).not.toBeNull();
    session.stop();
    await until(() => session.phase === 'waiting');
  });

  it('reconnects by itself after losing the amp, as a new connection', async () => {
    const transport = ampOnBluetooth();
    const session = open(transport);
    void session.start();
    await until(() => session.phase === 'connected');
    const before = session.snapshot().revision;
    transport.drop();
    expect(session.snapshot().connected).toBe(false);
    await until(() => session.connections === 2 && session.snapshot().connected);
    expect(transport.connects).toBe(2);
    expect(session.snapshot().revision).not.toBe(before);
    session.stop();
    await until(() => session.phase === 'waiting');
  }, 8000);

  it('goes back to waiting when nothing was chosen', async () => {
    const session = open(ampOnBluetooth({ chosen: false, cancel: new DOMException('User cancelled the requestDevice() chooser.', 'NotFoundError') }));
    await session.start();
    expect(session.phase).toBe('waiting');
    expect(session.error).toBeNull();
  });

  it('says why when the device list could not open', async () => {
    const session = open(ampOnBluetooth({ chosen: false, cancel: new Error('Bluetooth is turned off') }));
    await session.start();
    expect(session.phase).toBe('waiting');
    expect(session.error).toBe('Bluetooth is turned off');
  });

  it('keeps trying when a chosen amp is out of reach', async () => {
    const transport = ampOnBluetooth();
    let failures = 2;
    const connect = transport.connect.bind(transport);
    transport.connect = async () => {
      if (failures-- > 0) throw new Error('out of range');
      await connect();
    };
    const session = open(transport);
    void session.start();
    await until(() => session.error === 'out of range');
    await until(() => session.phase === 'connected');
    expect(session.error).toBeNull();
    session.stop();
    await until(() => session.phase === 'waiting');
  });

  it('reconnects after a command could not be confirmed', async () => {
    const transport = ampOnBluetooth();
    const session = open(transport);
    void session.start();
    await until(() => session.phase === 'connected');
    vi.spyOn(session.amp!, 'switchTo').mockRejectedValue(new AmpError('Timed out'));
    await expect(session.switch(5)).rejects.toThrow('did not confirm the switch');
    expect(session.snapshot().connected).toBe(false);
    await until(() => session.connections === 2 && session.snapshot().connected);
    session.stop();
    await until(() => session.phase === 'waiting');
  }, 8000);
});
