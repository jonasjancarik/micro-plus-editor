// A simulated amp, for working on the page and for trying out failures without Bluetooth.
import fixture from '../../server/mmp_mock_fixture.json';
import { isPresetNumber } from './commands';
import { MODELS, PARAMETER_CHOICES, UNSCALED } from './data';
import { AmpError, EditorConflict, InputError } from './errors';
import { CompareList, PresetGroups, SavedPresets } from './groups';
import { withSignalOrder, type ParameterValue, type Preset, type PresetNode } from './preset';
import { prepareImport, READ_RECONNECT_GAP_MS, SAVED_READ_FAILURES, type EditorSession, type LastSave, type LastUndo, type SavedDocument, type Snapshot } from './session';

const FIXTURE = fixture as unknown as { names: string[]; active: number; document: Preset };
const STALL_MS = 8000;
const RECONNECT_MS = 3000;
const MODES = ['ok', 'disconnected', 'fail', 'stall', 'noread', 'noread-stuck'] as const;
const CHOOSE_PRESET = 'Choose a preset number from 1 to 100.';
const STALE = 'The preset changed while you were editing. Review its current settings and try again.';

export type SimulatorMode = typeof MODES[number];

export class SimulatedSession implements EditorSession {
  names = [...FIXTURE.names];
  slot = FIXTURE.active;
  stored = new Map<number, Preset>();
  document: Preset;
  mode: SimulatorMode = 'ok';
  dirty = false;
  error: string | null = null;
  generation = crypto.randomUUID();
  documentRevision = 1;
  connections = 1;
  lastSave: LastSave | null = null;
  lastUndo: LastUndo | null = null;
  backups = new Map<string, { preset: Preset; name: string }>();
  requests: Record<string, unknown>[] = [];
  limits = new Map<string, number>();
  savedReadFailures = 0;
  readReconnectedAt: number | null = null;
  stalled = false;
  groups = new PresetGroups();
  compare = new CompareList();
  saved = new SavedPresets();
  savedBeforeLastSave: string | null = null;

  constructor(private delayMs = 800) {
    this.document = this.read(this.slot);
  }

  read(slot: number): Preset {
    if (!this.stored.has(slot)) {
      const document = structuredClone(FIXTURE.document);
      document.info.displayName = this.names[slot - 1]!;
      this.stored.set(slot, document);
    }
    return structuredClone(this.stored.get(slot)!);
  }

  get connected(): boolean {
    return this.mode !== 'disconnected';
  }

  private get revision(): string {
    return `${this.generation}:${this.documentRevision}`;
  }

  snapshot(): Snapshot {
    const connected = this.connected;
    return {
      connected, phase: connected ? 'connected' : 'disconnected',
      error: connected ? null : this.error ?? 'Micro Plus not found. Turn it on and close Fender Tone on other devices.',
      stalled: this.stalled, device: 'Simulated Micro Plus', connections: this.connections, connected_since: null,
      preset: connected ? this.slot : null, name: connected ? this.names[this.slot - 1]! : null,
      presets: connected ? this.names.map((name, index) => ({ preset: index + 1, name })) : [],
      document: connected ? this.document : null, revision: connected ? this.revision : null,
      dirty: connected ? this.dirty : false,
      models: MODELS, parameter_choices: PARAMETER_CHOICES, unscaled: UNSCALED,
      last_save: this.lastSave, last_undo: this.lastUndo, preset_groups: this.groups.state,
      saved_presets: this.saved.state, compare_presets: this.compare.slots,
    };
  }

  async changeGroups(request: Record<string, unknown>): Promise<Snapshot> {
    await this.groups.apply(request);
    return this.snapshot();
  }

  async changeCompare(request: Record<string, unknown>): Promise<Snapshot> {
    await this.compare.apply(request);
    return this.snapshot();
  }

  /** normal behaviour, or the amp disappears, stops confirming writes, or stops sending saved presets. */
  setMode(mode: string): void {
    if (!MODES.includes(mode as SimulatorMode)) throw new InputError('Unknown mode');
    if (this.mode === 'disconnected' && mode !== 'disconnected') this.reconnect();
    this.mode = mode as SimulatorMode;
  }

  private reconnect(): void {
    this.generation = crypto.randomUUID();
    this.connections++;
    this.error = null;
    this.savedReadFailures = 0;
    if (this.stalled) {
      this.stalled = false; // Reconnecting after a stall leaves the amp's live preset and flag as they were.
      return;
    }
    this.dirty = false;
    this.document = this.read(this.slot);
  }

  /** Someone turns the knob on the amp. */
  knob(slot: number): void {
    this.slot = slot;
    this.document = this.read(slot);
    this.dirty = false;
    this.documentRevision++;
  }

  /** The amp stores no more than this for that setting. */
  limit(node: string, parameter: string, value: number): void {
    this.limits.set(`${node}\n${parameter}`, value);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async begin(action: string, body: Record<string, unknown>): Promise<void> {
    this.requests.push({ time: Date.now() / 1000, action, ...body });
    await this.sleep(this.delayMs);
    if (!this.connected) throw new AmpError('The Micro Plus is disconnected. Wait for it to reconnect.');
    if (this.mode === 'fail') throw new AmpError(`The Micro Plus did not confirm the ${action}. Reconnecting to read its current settings.`);
  }

  private requireEditor(slot: unknown, revision: unknown): void {
    if (slot !== this.slot || revision !== this.revision) throw new EditorConflict(STALE);
  }

  private node(id: unknown): PresetNode {
    const node = this.document.audioGraph.nodes.find((entry) => entry.nodeId === id);
    if (!node) throw new InputError('That module is not present in the current preset.');
    return node;
  }

  async switch(slot: unknown): Promise<Snapshot> {
    if (!isPresetNumber(slot)) throw new InputError(CHOOSE_PRESET);
    if (this.mode === 'stall') {
      this.requests.push({ time: Date.now() / 1000, action: 'switch', preset: slot });
      await this.sleep(STALL_MS);
      this.slot = slot;
      this.error = 'The Micro Plus did not confirm the switch, so it may already be on the new preset. Reconnecting to check.';
      this.mode = 'disconnected';
      setTimeout(() => this.setMode('ok'), RECONNECT_MS);
      throw new AmpError(this.error);
    }
    await this.begin('switch', { preset: slot });
    this.knob(slot);
    return this.snapshot();
  }

  async edit(slot: unknown, revision: unknown, node: unknown, parameter: unknown, value: unknown): Promise<Snapshot> {
    this.requireEditor(slot, revision);
    await this.begin('parameter', { node, parameter, value });
    this.requireEditor(slot, revision);
    const parameters = this.node(node).dspUnitParameters;
    if (typeof parameter !== 'string' || !(parameter in parameters)) throw new InputError('This parameter is not present in the selected preset');
    const limit = this.limits.get(`${String(node)}\n${parameter}`);
    const stored = limit !== undefined ? Math.min(value as number, limit) : value as ParameterValue;
    parameters[parameter] = stored;
    this.dirty = true;
    this.documentRevision++;
    const snapshot = this.snapshot();
    if (stored !== value) snapshot.limited = { node: node as string, parameter, requested: value, stored: stored as number };
    return snapshot;
  }

  private async readStored(slot: number): Promise<Preset> {
    await this.sleep(this.delayMs);
    if (this.mode === 'noread' || this.mode === 'noread-stuck') {
      this.savedReadFailures++;
      const now = performance.now();
      if (this.savedReadFailures >= SAVED_READ_FAILURES
          && (this.readReconnectedAt === null || now - this.readReconnectedAt >= READ_RECONNECT_GAP_MS)) {
        this.readReconnectedAt = now;
        this.stalled = true;
        this.error = 'Your Micro Plus stopped answering, so the editor is reconnecting to it.';
        const after = this.mode === 'noread' ? 'ok' : 'noread-stuck';
        this.mode = 'disconnected';
        setTimeout(() => this.setMode(after), RECONNECT_MS);
        throw new AmpError(this.error);
      }
    }
    if (!this.connected || this.mode === 'fail' || this.mode === 'noread' || this.mode === 'noread-stuck') {
      throw new AmpError('The Micro Plus did not send the saved preset.');
    }
    this.savedReadFailures = 0;
    return this.read(slot);
  }

  async savedCopy(slot: unknown, revision: unknown): Promise<SavedDocument> {
    this.requireEditor(slot, revision);
    const document = await this.readStored(slot as number);
    this.requireEditor(slot, revision);
    return { preset: slot as number, revision: revision as string, saved_document: document };
  }

  async readSlot(slot: unknown): Promise<SavedDocument> {
    if (!isPresetNumber(slot)) throw new InputError(CHOOSE_PRESET);
    return { slot, saved_document: await this.readStored(slot) };
  }

  private recordSave(target: number, name: string, preset: Preset): void {
    const stamp = new Date().toISOString().replace(/[-:]/g, '');
    const backup = `${stamp}-${this.backups.size}-preset-${String(target).padStart(3, '0')}.json`;
    this.backups.set(backup, { preset: this.read(target), name: this.names[target - 1]! });
    this.stored.set(target, preset);
    this.names[target - 1] = name;
    this.savedBeforeLastSave = this.saved.state[String(target)] ?? null;
    this.saved.set(target, name);
    this.lastSave = { preset: target, name, backup, verified: true, time: Date.now() / 1000 };
    if (target === this.slot) {
      this.document = this.read(target);
      this.dirty = false;
    }
    this.documentRevision++;
  }

  async importPreset(slot: unknown, revision: unknown, target: unknown, name: unknown, document: unknown): Promise<Snapshot> {
    const { prepared, name: clean } = prepareImport(document, name, target);
    this.requireEditor(slot, revision);
    await this.begin('import', { target, name: clean });
    this.recordSave(target as number, clean, prepared);
    return this.snapshot();
  }

  async replace(slot: unknown, revision: unknown, node: unknown, model: unknown): Promise<Snapshot> {
    this.requireEditor(slot, revision);
    await this.begin('model', { node, model });
    this.node(node).FenderId = model as string;
    this.dirty = true;
    this.documentRevision++;
    return this.snapshot();
  }

  async setOrder(slot: unknown, revision: unknown, order: unknown): Promise<Snapshot> {
    this.requireEditor(slot, revision);
    this.document = withSignalOrder(this.document, order);
    this.dirty = true;
    return this.snapshot();
  }

  async save(slot: unknown, revision: unknown, target: unknown, name: unknown): Promise<Snapshot> {
    this.requireEditor(slot, revision);
    await this.begin('save', { target, name });
    const saved = structuredClone(this.document);
    saved.info.displayName = name as string;
    this.recordSave(target as number, name as string, saved);
    return this.snapshot();
  }

  async undoSave(slot: unknown, revision: unknown): Promise<Snapshot> {
    this.requireEditor(slot, revision);
    if (!this.lastSave) throw new InputError('There is no recent save to undo.');
    await this.begin('undo', {});
    const target = this.lastSave.preset;
    const { preset, name } = this.backups.get(this.lastSave.backup)!;
    this.stored.set(target, preset);
    this.names[target - 1] = name;
    this.lastUndo = { preset: target, backup: this.lastSave.backup, time: Date.now() / 1000 };
    this.saved.set(target, this.savedBeforeLastSave);
    this.lastSave = null;
    if (target === this.slot) {
      this.document = this.read(target);
      this.dirty = false;
    }
    this.documentRevision++;
    return this.snapshot();
  }
}
