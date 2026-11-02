// Owns one connection to the amp and runs the page's commands one at a time.
import { Amp, type RepeatingTimer } from './amp';
import { isPresetNumber, saveCurrentPayload } from './commands';
import { MODELS, PARAMETER_CHOICES, UNSCALED } from './data';
import { AmpError, BackupError, EditorConflict, InputError } from './errors';
import { CompareList, PresetGroups, SavedPresets, type GroupState } from './groups';
import { signalOrder, validatePreset, withSignalOrder, type Preset } from './preset';
import type { FileStore } from './storage';
import { NAME, type BleTransport } from '../transport/types';

export const SAVED_READ_FAILURES = 3; // The amp has been seen to stop answering these while its connection still looks healthy.
export const READ_RECONNECT_GAP_MS = 300_000; // If reconnecting doesn't help, trying again every few reads wouldn't either.
const RETRY_MS = 2000;
const PRESET_POSITIONS = ['stomp', 'mod', 'amp', 'delay', 'reverb']; // Every preset read from the amp has exactly these.
const STALE = 'The preset changed while you were editing. Review its current settings and try again.';
const CHOOSE_PRESET = 'Choose a preset number from 1 to 100.';

export interface LastSave {
  preset: number;
  name: string;
  backup: string;
  verified: boolean;
  time: number;
}

export interface LastUndo {
  preset: number;
  backup: string;
  time: number;
}

/** What the page shows. The snake_case names come from the earlier Python server, which the page was written for. */
export interface Snapshot {
  connected: boolean;
  phase: string;
  error: string | null;
  stalled: boolean;
  device: string;
  connections: number;
  connected_since: number | null;
  preset: number | null;
  name: string | null;
  presets: { preset: number; name: string }[];
  document: Preset | null;
  revision: string | null;
  dirty: boolean;
  models: unknown;
  parameter_choices: unknown;
  unscaled: unknown;
  last_save: LastSave | null;
  last_undo: LastUndo | null;
  preset_groups: GroupState;
  saved_presets: Record<string, string>;
  compare_presets: number[];
  limited?: { node: string; parameter: string; requested: unknown; stored: number };
}

export interface BackupEntry {
  name: string;
  /** The preset it holds a copy of. */
  preset: number;
  /** When it was made, in milliseconds. */
  time: number;
}

export interface SavedDocument {
  preset?: number;
  revision?: string;
  slot?: number;
  saved_document: Preset;
}

/** What the page can ask for, from the real amp or the simulator. */
export interface EditorSession {
  snapshot(): Snapshot;
  switch(slot: unknown): Promise<Snapshot>;
  edit(slot: unknown, revision: unknown, node: unknown, parameter: unknown, value: unknown): Promise<Snapshot>;
  replace(slot: unknown, revision: unknown, node: unknown, model: unknown): Promise<Snapshot>;
  setOrder(slot: unknown, revision: unknown, order: unknown): Promise<Snapshot>;
  save(slot: unknown, revision: unknown, target: unknown, name: unknown): Promise<Snapshot>;
  importPreset(slot: unknown, revision: unknown, target: unknown, name: unknown, document: unknown): Promise<Snapshot>;
  undoSave(slot: unknown, revision: unknown): Promise<Snapshot>;
  savedCopy(slot: unknown, revision: unknown): Promise<SavedDocument>;
  readSlot(slot: unknown): Promise<SavedDocument>;
  changeGroups(request: Record<string, unknown>): Promise<Snapshot>;
  changeCompare(request: Record<string, unknown>): Promise<Snapshot>;
  listBackups(): Promise<BackupEntry[]>;
  readBackupFile(name: string): Promise<string>;
}

/** Reads what a backup's file name says, newest first once sorted. Returns null for a name that isn't a backup's. */
export function backupEntry(name: string): BackupEntry | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{3})Z(?:-\d+)?-preset-(\d{3})\.json$/.exec(name);
  if (!match) return null;
  const [year, month, day, hour, minute, second, ms, preset] = match.slice(1).map(Number) as [number, number, number, number, number, number, number, number];
  return { name, preset, time: Date.UTC(year, month - 1, day, hour, minute, second, ms) };
}

export const newPresetId = () => crypto.randomUUID().toUpperCase();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Checks a preset from a file and returns the copy to write. Files can come from anyone, so nothing is assumed. */
export function prepareImport(document: unknown, name: unknown, target: unknown): { prepared: Preset; name: string } {
  const clean = typeof name === 'string' ? name.trim() : name;
  saveCurrentPayload(clean, target);
  validatePreset(document);
  const positions = document.audioGraph.nodes.map((node) => node.nodeId);
  if (positions.length !== PRESET_POSITIONS.length || !PRESET_POSITIONS.every((position) => positions.includes(position))) {
    throw new InputError("This file isn't a Micro Plus preset, so nothing was changed.");
  }
  if ((document.info.product_id ?? 'mustang-ltx') !== 'mustang-ltx') {
    throw new InputError('This preset is for a different amp, so nothing was changed.');
  }
  // Models aren't checked against MODELS: that list is incomplete, and the amp's own presets can use others.
  // An imported sound gets its own identity, as a copy does, so two slots never claim to be the same preset.
  const prepared = structuredClone(document);
  Object.assign(prepared.info, { displayName: clean, preset_id: newPresetId(), is_factory_default: false });
  return { prepared, name: clean as string };
}

export interface SessionFiles {
  store: FileStore;
  backupFolder?: string;
  groups?: string;
  saved?: string;
  compare?: string;
}

export class MicroPlusSession implements EditorSession {
  amp: Amp | null = null;
  error: string | null = null;
  phase = 'waiting';
  connections = 0;
  connectedSince: number | null = null;
  lastSave: LastSave | null = null;
  lastUndo: LastUndo | null = null;
  generation = '';
  savedReadFailures = 0;
  readReconnectedAt: number | null = null;
  stalled = false;
  /** A new order waits here until it's saved: the amp has no way to play it before then. */
  pendingOrder: { slot: number; generation: string; order: string[] } | null = null;
  savedBeforeLastSave: string | null = null;
  retryMs = RETRY_MS;

  private queue: Promise<unknown> = Promise.resolve();
  private resetRequested = false;
  private wakeReset: () => void = () => {};
  private running = false;
  private stopped = false;
  private lastBackupTime = 0;

  constructor(
    private transport: BleTransport,
    private store: FileStore,
    public groups: PresetGroups,
    public saved: SavedPresets,
    public compare: CompareList,
    private backupFolder = 'backups',
    private timer?: RepeatingTimer,
  ) {}

  static async open(transport: BleTransport, files: SessionFiles, timer?: RepeatingTimer): Promise<MicroPlusSession> {
    const { store } = files;
    return new MicroPlusSession(transport, store,
      await PresetGroups.open(store, files.groups ?? 'preset-groups.json'),
      await SavedPresets.open(store, files.saved ?? 'preset-saved.json'),
      await CompareList.open(store, files.compare ?? 'preset-compare.json'),
      files.backupFolder ?? 'backups', timer);
  }

  private revision(amp: Amp): string {
    return `${this.generation}:${amp.documentRevision}`;
  }

  private connectedAmp(): Amp | null {
    return this.amp && this.transport.isConnected() ? this.amp : null;
  }

  private waitingOrder(amp: Amp): string[] | null {
    const pending = this.pendingOrder;
    if (!pending) return null;
    if (pending.slot !== amp.slot || pending.generation !== this.generation) {
      this.pendingOrder = null; // The amp moved to another preset or reconnected, so its edits are gone too.
      return null;
    }
    return pending.order;
  }

  snapshot(): Snapshot {
    const amp = this.connectedAmp();
    if (amp?.document && amp.slot !== null && amp.documentSlot === amp.slot) {
      const info = amp.document.info;
      if (info.is_factory_default === false) this.saved.set(amp.slot, info.displayName.trimEnd()); // Saved with another app, perhaps.
    }
    const document = amp?.document ?? null;
    const order = amp && document ? this.waitingOrder(amp) : null;
    return {
      connected: Boolean(amp), phase: this.phase, error: this.error, stalled: this.stalled, device: NAME,
      connections: this.connections, connected_since: this.connectedSince,
      preset: amp?.slot ?? null, name: amp?.status().name ?? null,
      presets: amp ? amp.names.map((name, index) => ({ preset: index + 1, name })) : [],
      document: document && order ? withSignalOrder(document, order) : document,
      revision: amp ? this.revision(amp) : null,
      dirty: amp ? amp.dirty || Boolean(order) : false,
      models: MODELS, parameter_choices: PARAMETER_CHOICES, unscaled: UNSCALED,
      last_save: this.lastSave, last_undo: this.lastUndo, preset_groups: this.groups.state,
      saved_presets: this.saved.state, compare_presets: this.compare.slots,
    };
  }

  /** These stay on this device, so they work whether or not the amp is connected. */
  async changeGroups(request: Record<string, unknown>): Promise<Snapshot> {
    await this.groups.apply(request);
    return this.snapshot();
  }

  async changeCompare(request: Record<string, unknown>): Promise<Snapshot> {
    await this.compare.apply(request);
    return this.snapshot();
  }

  private inTurn<T>(work: () => Promise<T>): Promise<T> {
    const running = this.queue.catch(() => {}).then(work);
    this.queue = running;
    return running;
  }

  private requireAmp(): Amp {
    const amp = this.connectedAmp();
    if (!amp) throw new AmpError('The Micro Plus is disconnected. Wait for it to reconnect.');
    return amp;
  }

  private requireEditor(slot: unknown, revision: unknown): Amp {
    const amp = this.requireAmp();
    if (amp.slot !== slot || revision !== this.revision(amp) || !amp.document || amp.documentSlot !== slot) {
      throw new EditorConflict(STALE);
    }
    return amp;
  }

  private unconfirmed(action: string, cause: unknown): AmpError {
    // Callers only get a friendly message, so this is the only record of the cause.
    console.error(`Micro Plus ${action} not confirmed:`, cause);
    const messages: Record<string, string> = {
      save: 'The save could not be verified. Reconnecting to read the device; check the result before saving again.',
      undo: 'The undo could not be verified. Reconnecting to read the device; check the result before saving again.',
      import: 'The import could not be verified. Reconnecting to read the device; check the result before saving again.',
      'connection check': 'Your Micro Plus stopped answering while this page was in the background, so the editor is reconnecting to it.',
      'saved preset read': 'Your Micro Plus stopped answering, so the editor is reconnecting to it.',
      'preset selection': 'The Micro Plus did not confirm the switch, so it may already be on the new preset. Reconnecting to check.',
    };
    this.error = messages[action] ?? `The Micro Plus did not confirm the ${action}. Reconnecting to read its current settings.`;
    this.amp = null;
    this.requestReset();
    return new AmpError(this.error);
  }

  /** Bad requests and failed backups are final. Anything else may have reached the amp, so reconnect and look. */
  private async confirming<T>(action: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof InputError || error instanceof BackupError) throw error;
      throw this.unconfirmed(action, error);
    }
  }

  switch(slot: unknown): Promise<Snapshot> {
    if (!isPresetNumber(slot)) return Promise.reject(new InputError(CHOOSE_PRESET));
    return this.inTurn(async () => {
      const amp = this.requireAmp();
      return this.confirming('preset selection', async () => {
        await amp.switchTo(slot);
        await amp.refreshCurrent();
        this.pendingOrder = null; // Choosing the same preset again is how the page discards changes.
        return this.snapshot();
      });
    });
  }

  edit(slot: unknown, revision: unknown, node: unknown, parameter: unknown, value: unknown): Promise<Snapshot> {
    return this.inTurn(async () => {
      const amp = this.requireEditor(slot, revision);
      if (typeof node !== 'string' || typeof parameter !== 'string') throw new InputError('Choose an amplifier or effect parameter.');
      return this.confirming('parameter change', async () => {
        const limited = await amp.setParameter(node, parameter, value);
        const snapshot = this.snapshot();
        if (limited !== null) snapshot.limited = { node, parameter, requested: value, stored: limited };
        return snapshot;
      });
    });
  }

  replace(slot: unknown, revision: unknown, node: unknown, model: unknown): Promise<Snapshot> {
    return this.inTurn(async () => {
      const amp = this.requireEditor(slot, revision);
      if (typeof node !== 'string' || typeof model !== 'string') throw new InputError('Choose an amplifier or effect model.');
      if (!MODELS[node]?.some((entry) => entry.id === model)) throw new InputError('That model is not in the Micro Plus model list.');
      if (!amp.document!.audioGraph.nodes.some((entry) => entry.nodeId === node)) {
        throw new InputError('That module is not present in the current preset.');
      }
      return this.confirming('amplifier or effect change', async () => {
        await amp.replaceNode(node, model);
        return this.snapshot();
      });
    });
  }

  setOrder(slot: unknown, revision: unknown, order: unknown): Promise<Snapshot> {
    return this.inTurn(async () => {
      const amp = this.requireEditor(slot, revision);
      withSignalOrder(amp.document!, order); // Rejects anything but the same positions in a new order.
      const positions = order as string[];
      this.pendingOrder = JSON.stringify(positions) === JSON.stringify(signalOrder(amp.document!)) ? null
        : { slot: slot as number, generation: this.generation, order: [...positions] };
      return this.snapshot();
    });
  }

  private async readStored(amp: Amp, slot: number): Promise<Preset> {
    // Only reads, so one failure says little about the connection. Several in a row mean the amp has stalled.
    let document: Preset;
    try {
      document = await amp.readPreset(slot);
    } catch (error) {
      if (error instanceof InputError) throw error;
      this.savedReadFailures++;
      console.error(`Micro Plus saved preset read failed, ${this.savedReadFailures} in a row:`, error);
      const now = performance.now();
      if (this.savedReadFailures >= SAVED_READ_FAILURES
          && (this.readReconnectedAt === null || now - this.readReconnectedAt >= READ_RECONNECT_GAP_MS)) {
        this.readReconnectedAt = now;
        this.stalled = true;
        throw this.unconfirmed('saved preset read', error);
      }
      throw new AmpError('The Micro Plus did not send the saved preset.');
    }
    this.savedReadFailures = 0;
    return document;
  }

  savedCopy(slot: unknown, revision: unknown): Promise<SavedDocument> {
    return this.inTurn(async () => {
      const amp = this.requireEditor(slot, revision);
      const document = await this.readStored(amp, slot as number);
      this.requireEditor(slot, revision);
      return { preset: slot as number, revision: revision as string, saved_document: document };
    });
  }

  /** Reads any slot for exporting. Reading doesn't depend on what the page is editing. */
  readSlot(slot: unknown): Promise<SavedDocument> {
    if (!isPresetNumber(slot)) return Promise.reject(new InputError(CHOOSE_PRESET));
    return this.inTurn(async () => ({ slot, saved_document: await this.readStored(this.requireAmp(), slot) }));
  }

  /** Must succeed before a write is sent. */
  async backup(slot: number, document: Preset): Promise<string> {
    const time = Math.max(Date.now(), this.lastBackupTime + 1);
    this.lastBackupTime = time;
    const stamp = new Date(time).toISOString().replace(/[-:]/g, '');
    const name = `${stamp}-preset-${String(slot).padStart(3, '0')}.json`;
    const text = JSON.stringify({ format: 'maneline-micro-plus-backup-v1', device: this.transport.deviceId(), slot, preset: document }, null, 2);
    try {
      await this.store.create(`${this.backupFolder}/${name}`, text);
    } catch (error) {
      console.error('Could not create a backup:', error);
      throw new BackupError('Could not create a backup of the preset, so nothing was saved.');
    }
    return name;
  }

  async listBackups(): Promise<BackupEntry[]> {
    const names = await this.store.list(this.backupFolder);
    return names.map(backupEntry).filter((entry) => entry !== null).sort((a, b) => b.time - a.time);
  }

  async readBackupFile(name: string): Promise<string> {
    const text = backupEntry(name) && await this.store.read(`${this.backupFolder}/${name}`);
    if (!text) throw new BackupError("Couldn't read that backup.");
    return text;
  }

  /** Asks the amp for something harmless, and reconnects if it doesn't answer. */
  checkConnection(): Promise<void> {
    return this.inTurn(async () => {
      const amp = this.connectedAmp();
      if (!amp) return;
      await this.confirming('connection check', () => amp.refreshCurrent());
    }).catch(() => {}); // The page learns of this from the next snapshot.
  }

  private recordSave(target: number, name: string, backup: string): void {
    this.savedBeforeLastSave = this.saved.state[String(target)] ?? null;
    this.saved.set(target, name);
    // An import counts as a save, so Undo this save covers it too.
    this.lastSave = { preset: target, name, backup, verified: true, time: Date.now() / 1000 };
  }

  save(slot: unknown, revision: unknown, target: unknown, name: unknown): Promise<Snapshot> {
    const clean = typeof name === 'string' ? name.trim() : name;
    try {
      saveCurrentPayload(clean, target); // Validate before reading or writing the device.
    } catch (error) {
      return Promise.reject(error);
    }
    const slotNumber = target as number;
    return this.inTurn(async () => {
      const amp = this.requireEditor(slot, revision);
      return this.confirming('save', async () => {
        const backup = await this.backup(slotNumber, await amp.readPreset(slotNumber));
        // A physical preset change during the backup must not save the wrong sound.
        this.requireEditor(slot, revision);
        const order = this.waitingOrder(amp);
        if (order) { // Saving on the amp would keep its old order, so the whole preset has to be sent.
          const document = withSignalOrder(amp.document!, order);
          document.info.displayName = clean as string;
          if (slotNumber !== slot) Object.assign(document.info, { preset_id: newPresetId(), is_factory_default: false });
          await this.writeStored(amp, slotNumber, document);
        } else {
          await amp.saveCurrent(clean as string, slotNumber);
        }
        this.recordSave(slotNumber, clean as string, backup);
        return this.snapshot();
      });
    });
  }

  async writeStored(amp: Amp, target: number, document: Preset): Promise<void> {
    await amp.restorePreset(document, target);
    // The amp keeps playing its live copy until the slot is selected again.
    if (target === amp.slot) await amp.switchTo(target);
    await amp.refreshCurrent();
    this.pendingOrder = null;
  }

  importPreset(slot: unknown, revision: unknown, target: unknown, name: unknown, document: unknown): Promise<Snapshot> {
    let checked: ReturnType<typeof prepareImport>;
    try {
      checked = prepareImport(document, name, target); // Validate before reading or writing the device.
    } catch (error) {
      return Promise.reject(error);
    }
    const slotNumber = target as number;
    return this.inTurn(async () => {
      const amp = this.requireEditor(slot, revision);
      return this.confirming('import', async () => {
        const backup = await this.backup(slotNumber, await amp.readPreset(slotNumber));
        this.requireEditor(slot, revision);
        await this.writeStored(amp, slotNumber, checked.prepared);
        this.recordSave(slotNumber, checked.name, backup);
        return this.snapshot();
      });
    });
  }

  private async readBackup(name: string, target: number): Promise<Preset> {
    let text: string | null;
    try {
      text = await this.store.read(`${this.backupFolder}/${name}`);
    } catch (error) {
      console.error('Could not read the backup:', error);
      text = null;
    }
    if (text === null) throw new BackupError('Could not read the backup of that preset, so nothing was changed.');
    let backup: unknown;
    try {
      backup = JSON.parse(text);
    } catch {
      throw new InputError('That backup could not be read, so nothing was changed.');
    }
    if (!isRecord(backup) || backup.slot !== target) throw new InputError('That backup belongs to a different preset, so nothing was changed.');
    return backup.preset as Preset;
  }

  undoSave(slot: unknown, revision: unknown): Promise<Snapshot> {
    return this.inTurn(async () => {
      const amp = this.requireEditor(slot, revision);
      const save = this.lastSave;
      if (!save) throw new InputError('There is no recent save to undo.');
      const target = save.preset;
      const preset = await this.readBackup(save.backup, target);
      return this.confirming('undo', async () => {
        const safety = await this.backup(target, await amp.readPreset(target)); // Undo must itself be recoverable.
        this.requireEditor(slot, revision);
        await this.writeStored(amp, target, preset);
        this.saved.set(target, this.savedBeforeLastSave);
        this.lastSave = null;
        this.lastUndo = { preset: target, backup: safety, time: Date.now() / 1000 };
        return this.snapshot();
      });
    });
  }

  private requestReset(): void {
    this.resetRequested = true;
    this.wakeReset();
  }

  private untilReset(): Promise<void> {
    return new Promise((resolve) => {
      this.wakeReset = resolve;
      if (this.resetRequested) resolve();
    });
  }

  /** Connects and stays connected. Call it from a click: a browser only opens its device list after one. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    while (!this.stopped) {
      this.resetRequested = false;
      this.phase = 'connecting';
      const choosing = !this.transport.hasDevice();
      try {
        await this.connectOnce();
      } catch (error) {
        if (choosing && !this.transport.hasDevice()) {
          // Nothing was chosen, so there's nothing to retry until the next click.
          this.error = isCancelled(error) ? null : messageOf(error);
          this.phase = 'waiting';
          this.running = false;
          return;
        }
        this.error = messageOf(error);
      }
      this.amp = null;
      this.connectedSince = null;
      this.phase = 'disconnected';
      if (!this.stopped) await new Promise((resolve) => setTimeout(resolve, this.retryMs));
    }
    this.phase = 'waiting';
    this.running = false;
  }

  /** Ends the connection and stops trying to reconnect. */
  stop(): void {
    this.stopped = true;
    this.requestReset();
  }

  private async connectOnce(): Promise<void> {
    await this.transport.connect();
    const amp = new Amp(this.transport);
    const stopListening = this.transport.onDisconnect(() => this.requestReset());
    try {
      await amp.initialize();
      amp.startKeepAlive(this.timer, () => this.requestReset());
      await amp.refreshCurrent();
      this.amp = amp;
      this.generation = crypto.randomUUID();
      this.connections++;
      this.connectedSince = Date.now() / 1000;
      this.phase = 'connected';
      this.error = null;
      this.stalled = false;
      this.savedReadFailures = 0;
      await this.untilReset();
    } finally {
      amp.dispose();
      stopListening();
      await this.transport.disconnect().catch(() => {});
    }
  }
}

const messageOf = (error: unknown) => (error instanceof Error && error.message) || 'The Bluetooth connection was lost.';
const isCancelled = (error: unknown) => (error instanceof DOMException && error.name === 'NotFoundError')
  || (error instanceof Error && /cancel/i.test(error.message));

