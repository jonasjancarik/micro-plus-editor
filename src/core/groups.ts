// What the amp has nowhere to store: preset groups, the compare list, and which presets were saved over.
import { isPresetNumber } from './commands';
import { InputError, StorageError } from './errors';
import type { FileStore } from './storage';

export const MAX_GROUPS = 50;
export const MAX_NAME = 24;
export const MAX_COMPARED = 6;

export interface GroupState {
  groups: string[];
  assignments: Record<string, string>;
}

type Request = Record<string, unknown>;

function cleanName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim()) throw new InputError('Enter a name for the group.');
  const clean = name.trim();
  if ([...clean].length > MAX_NAME) throw new InputError(`Keep group names to ${MAX_NAME} characters.`);
  return clean;
}

function hasOnly(request: Request, ...keys: string[]): boolean {
  const present = Object.keys(request);
  return present.length === keys.length && keys.every((key) => present.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readState<T>(store: FileStore | null, name: string, empty: T, valid: (state: unknown) => boolean): Promise<T> {
  const text = store && await store.read(name);
  if (text === null || text === undefined) return empty;
  try {
    const state: unknown = JSON.parse(text);
    if (!valid(state)) throw new Error('Unexpected contents');
    return state as T;
  } catch (error) {
    console.error(`Could not read ${name}, so it was set aside:`, error);
    await store!.setAside(name);
    return empty;
  }
}

/** Runs one change at a time, so that a change can't start from a state another is about to replace. */
class OneAtATime {
  private last: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const running = this.last.catch(() => {}).then(work);
    this.last = running;
    return running;
  }
}

/**
 * Remembers the name each slot had when it was seen to be saved over, so a built-in can be shown as edited.
 *
 * The amp can't be relied on for this: a save in place can leave its factory flag set.
 * The name is kept because something else may later be saved to the slot without this page seeing it.
 */
export class SavedPresets {
  state: Record<string, string> = {};
  private writes = new OneAtATime();

  constructor(private store: FileStore | null = null, private file = '') {}

  static async open(store: FileStore, file: string): Promise<SavedPresets> {
    const saved = new SavedPresets(store, file);
    saved.state = await readState(store, file, {}, isRecord);
    return saved;
  }

  /** Takes effect at once, and the file catches up. Only a label depends on it, so a failed write isn't an error. */
  set(slot: number, name: string | null | undefined): void {
    const key = String(slot);
    if ((this.state[key] ?? null) === (name ?? null)) return;
    const state = { ...this.state };
    delete state[key];
    if (name !== null && name !== undefined) state[key] = name;
    this.state = state;
    void this.writes.run(async () => {
      try {
        await this.store?.write(this.file, JSON.stringify(state, null, 2));
      } catch (error) {
        console.error('Could not remember the saved preset:', error);
      }
    });
  }

  /** Resolves once everything set so far has been written. */
  settled(): Promise<void> {
    return this.writes.run(async () => {});
  }
}

/** The slots being compared, in the order they were added. A slot takes whatever is saved there. */
export class CompareList {
  slots: number[] = [];
  private changes = new OneAtATime();

  constructor(private store: FileStore | null = null, private file = '') {}

  static async open(store: FileStore, file: string): Promise<CompareList> {
    const compared = new CompareList(store, file);
    compared.slots = await readState<number[]>(store, file, [], (slots) => Array.isArray(slots)
      && slots.length <= MAX_COMPARED && new Set(slots).size === slots.length && slots.every(isPresetNumber));
    return compared;
  }

  apply(request: Request): Promise<void> {
    return this.changes.run(() => this.change(request));
  }

  private async change(request: Request): Promise<void> {
    const action = request.action;
    let slots: number[];
    if (action === 'clear' && hasOnly(request, 'action')) {
      slots = [];
    } else if ((action === 'add' || action === 'remove') && hasOnly(request, 'action', 'preset')) {
      const preset = request.preset;
      if (!isPresetNumber(preset)) throw new InputError('Choose a preset number from 1 to 100.');
      slots = this.slots.filter((slot) => slot !== preset);
      if (action === 'add') {
        if (this.slots.includes(preset)) return;
        if (slots.length >= MAX_COMPARED) throw new InputError(`You can compare up to ${MAX_COMPARED} presets. Remove one first.`);
        slots.push(preset);
      }
    } else {
      throw new InputError('Choose a preset to add or remove.');
    }
    try {
      await this.store?.write(this.file, JSON.stringify(slots, null, 2));
    } catch {
      throw new StorageError('Could not save your compare list on this device.');
    }
    this.slots = slots;
  }
}

/**
 * Groups are names, and assignments say which group a preset slot was moved to.
 *
 * A slot can also be moved to a group the page provides, which this class doesn't know about.
 */
export class PresetGroups {
  state: GroupState = { groups: [], assignments: {} };
  private changes = new OneAtATime();

  constructor(private store: FileStore | null = null, private file = '') {}

  static async open(store: FileStore, file: string): Promise<PresetGroups> {
    const groups = new PresetGroups(store, file);
    groups.state = await readState<GroupState>(store, file, groups.state,
      (state) => isRecord(state) && Array.isArray(state.groups) && isRecord(state.assignments));
    return groups;
  }

  apply(request: Request): Promise<void> {
    return this.changes.run(() => this.change(request));
  }

  private async change(request: Request): Promise<void> {
    const state = structuredClone(this.state);
    const action = request.action;
    const named = String(request.name);
    if (action === 'create' && hasOnly(request, 'action', 'name')) {
      const name = cleanName(request.name);
      requireNew(state, name);
      if (state.groups.length >= MAX_GROUPS) throw new InputError(`You can have up to ${MAX_GROUPS} groups.`);
      state.groups.push(name);
    } else if (action === 'rename' && hasOnly(request, 'action', 'name', 'new_name')) {
      if (!state.groups.includes(named)) throw new InputError('That group no longer exists.');
      const name = cleanName(request.new_name);
      requireNew(state, name, named);
      state.groups[state.groups.indexOf(named)] = name;
      state.assignments = Object.fromEntries(Object.entries(state.assignments)
        .map(([slot, group]) => [slot, group === named ? name : group]));
    } else if (action === 'delete' && hasOnly(request, 'action', 'name')) {
      if (!state.groups.includes(named)) throw new InputError('That group no longer exists.');
      state.groups.splice(state.groups.indexOf(named), 1);
      state.assignments = Object.fromEntries(Object.entries(state.assignments).filter(([, group]) => group !== named));
    } else if (action === 'move' && hasOnly(request, 'action', 'preset', 'group')) {
      if (!isPresetNumber(request.preset)) throw new InputError('Choose a preset number from 1 to 100.');
      if (request.group === null) delete state.assignments[String(request.preset)]; // Back to its usual group.
      else state.assignments[String(request.preset)] = cleanName(request.group);
    } else {
      throw new InputError('Choose a group to create, rename or delete, or a preset to move.');
    }
    try {
      await this.store?.write(this.file, JSON.stringify(state, null, 2));
    } catch {
      throw new StorageError('Could not save your groups on this device.');
    }
    this.state = state;
  }
}

function requireNew(state: GroupState, name: string, ignoring?: string): void {
  const taken = state.groups.filter((group) => group !== ignoring).map((group) => group.toLowerCase());
  if (taken.includes(name.toLowerCase())) throw new InputError(`There is already a group called “${name}”.`);
}
