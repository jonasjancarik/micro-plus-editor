import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AmpError, EditorConflict, InputError } from '../src/core/errors';
import { SimulatedSession } from '../src/core/simulator';

const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/wire.json'), 'utf8'));

describe('the simulated amp', () => {
  let session: SimulatedSession;
  beforeEach(() => { session = new SimulatedSession(0); });
  afterEach(() => { session.mode = 'ok'; });

  it('tells the page the same fields as the real session', () => {
    expect(Object.keys(session.snapshot()).sort()).toEqual(fixture.snapshotFields);
  });

  it('edits, saves and undoes', async () => {
    const original = session.names[2];
    let state = session.snapshot();
    state = await session.edit(state.preset, state.revision, 'amp', 'gain', 0.7);
    expect(state.dirty).toBe(true);
    state = await session.save(state.preset, state.revision, 3, 'Copy');
    expect(state.presets[2]!.name).toBe('Copy');
    state = await session.undoSave(state.preset, state.revision);
    expect(state.presets[2]!.name).toBe(original);
    expect(state.last_save).toBeNull();
  });

  it('stores and reports a limited value', async () => {
    session.limit('amp', 'gain', 0.3);
    const before = session.snapshot();
    const state = await session.edit(before.preset, before.revision, 'amp', 'gain', 0.7);
    expect(state.limited!.stored).toBe(0.3);
    expect(state.connected).toBe(true);
    expect(state.document!.audioGraph.nodes.find((node) => node.nodeId === 'amp')!.dspUnitParameters.gain).toBe(0.3);
  });

  it('makes an open page stale when someone turns the knob', async () => {
    const state = session.snapshot();
    session.knob(5);
    await expect(session.edit(state.preset, state.revision, 'amp', 'gain', 0.7)).rejects.toThrow(EditorConflict);
  });

  it('clears its state when it disappears, and comes back as a new connection', () => {
    const before = session.snapshot().revision;
    session.setMode('disconnected');
    expect(session.snapshot().presets).toEqual([]);
    session.setMode('ok');
    expect(session.snapshot().revision).not.toBe(before);
  });

  it('exports, imports and undoes', async () => {
    const original = session.names[2];
    const exported = (await session.readSlot(5)).saved_document;
    let state = session.snapshot();
    state = await session.importPreset(state.preset, state.revision, 3, 'Imported', exported);
    expect(state.presets[2]!.name).toBe('Imported');
    expect((await session.readSlot(3)).saved_document.audioGraph).toEqual(exported.audioGraph);
    state = await session.undoSave(state.preset, state.revision);
    expect(state.presets[2]!.name).toBe(original);
  });

  it('refuses the same files as the real session', async () => {
    const state = session.snapshot();
    await expect(session.importPreset(state.preset, state.revision, 3, 'Bad', { nodeType: 'preset' })).rejects.toThrow(InputError);
  });

  it('stops exports when saved presets stop arriving', async () => {
    session.setMode('noread-stuck');
    await expect(session.readSlot(5)).rejects.toThrow(AmpError);
  });

  it('refuses a new order that does not hold every pedal', async () => {
    const state = session.snapshot();
    await expect(session.setOrder(state.preset, state.revision, ['amp'])).rejects.toThrow(InputError);
  });

  it('does not confirm writes in fail mode', async () => {
    session.setMode('fail');
    const state = session.snapshot();
    await expect(session.edit(state.preset, state.revision, 'amp', 'gain', 0.7)).rejects.toThrow('did not confirm');
  });

  it('refuses an unknown mode', () => {
    expect(() => session.setMode('nonsense')).toThrow(InputError);
  });
});
