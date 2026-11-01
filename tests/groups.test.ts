import { describe, expect, it, vi } from 'vitest';
import { InputError, StorageError } from '../src/core/errors';
import { CompareList, MAX_COMPARED, PresetGroups, SavedPresets } from '../src/core/groups';
import { MemoryStore } from '../src/core/storage';

class FullStore extends MemoryStore {
  override async write(): Promise<void> {
    throw new Error('disk full');
  }
}

describe('preset groups', () => {
  it('survive a restart', async () => {
    const store = new MemoryStore();
    const groups = await PresetGroups.open(store, 'groups.json');
    await groups.apply({ action: 'create', name: ' Gig ' });
    await groups.apply({ action: 'move', preset: 17, group: 'Gig' });
    expect((await PresetGroups.open(store, 'groups.json')).state).toEqual({ groups: ['Gig'], assignments: { 17: 'Gig' } });
  });

  it('carry their presets along when renamed or deleted', async () => {
    const groups = new PresetGroups();
    await groups.apply({ action: 'create', name: 'Gig' });
    await groups.apply({ action: 'move', preset: 17, group: 'Gig' });
    await groups.apply({ action: 'move', preset: 32, group: 'Rock' });
    await groups.apply({ action: 'rename', name: 'Gig', new_name: 'Live' });
    expect(groups.state.assignments).toEqual({ 17: 'Live', 32: 'Rock' });
    await groups.apply({ action: 'delete', name: 'Live' });
    expect(groups.state).toEqual({ groups: [], assignments: { 32: 'Rock' } });
  });

  it('send a preset back to its usual group when moved to none', async () => {
    const groups = new PresetGroups();
    await groups.apply({ action: 'move', preset: 32, group: 'Rock' });
    await groups.apply({ action: 'move', preset: 32, group: null });
    expect(groups.state.assignments).toEqual({});
  });

  it('can be renamed to a different spelling of the same name', async () => {
    const groups = new PresetGroups();
    await groups.apply({ action: 'create', name: 'gig' });
    await groups.apply({ action: 'rename', name: 'gig', new_name: 'Gig' });
    expect(groups.state.groups).toEqual(['Gig']);
  });

  it('ignore bad requests', async () => {
    const groups = new PresetGroups();
    await groups.apply({ action: 'create', name: 'Gig' });
    const requests = [{ action: 'create', name: 'gig' }, { action: 'create', name: '  ' }, { action: 'create', name: 'x'.repeat(25) },
      { action: 'rename', name: 'Nope', new_name: 'A' }, { action: 'delete', name: 'Nope' }, { action: 'move', preset: 0, group: 'Gig' },
      { action: 'move', preset: true, group: 'Gig' }, { action: 'create', name: 'Other', extra: 1 }, { action: 'other' }];
    for (const request of requests) await expect(groups.apply(request)).rejects.toThrow(InputError);
    expect(groups.state).toEqual({ groups: ['Gig'], assignments: {} });
  });

  it('set an unreadable file aside rather than overwrite it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new MemoryStore();
    store.files.set('groups.json', '{not json');
    const groups = await PresetGroups.open(store, 'groups.json');
    expect(groups.state.groups).toEqual([]);
    expect(store.files.get('groups.json.unreadable')).toBe('{not json');
    expect(store.files.has('groups.json')).toBe(false);
    error.mockRestore();
  });

  it('keep the previous groups when a write fails', async () => {
    const groups = await PresetGroups.open(new FullStore(), 'groups.json');
    await expect(groups.apply({ action: 'create', name: 'Gig' })).rejects.toThrow(StorageError);
    expect(groups.state.groups).toEqual([]);
  });

  it('apply quick changes one after another', async () => {
    const groups = new PresetGroups();
    await Promise.all(['A', 'B', 'C'].map((name) => groups.apply({ action: 'create', name })));
    expect(groups.state.groups).toEqual(['A', 'B', 'C']);
  });
});

describe('the compare list', () => {
  it('survives a restart in the order added', async () => {
    const store = new MemoryStore();
    const compared = await CompareList.open(store, 'compare.json');
    for (const preset of [17, 2, 100]) await compared.apply({ action: 'add', preset });
    await compared.apply({ action: 'add', preset: 2 });
    await compared.apply({ action: 'remove', preset: 17 });
    expect((await CompareList.open(store, 'compare.json')).slots).toEqual([2, 100]);
  });

  it('refuses another preset when full', async () => {
    const compared = new CompareList();
    for (let preset = 1; preset <= MAX_COMPARED; preset++) await compared.apply({ action: 'add', preset });
    await expect(compared.apply({ action: 'add', preset: 50 })).rejects.toThrow('Remove one first');
    await compared.apply({ action: 'clear' });
    expect(compared.slots).toEqual([]);
  });

  it('ignores bad requests', async () => {
    const compared = new CompareList();
    await compared.apply({ action: 'add', preset: 17 });
    const requests = [{ action: 'add', preset: 0 }, { action: 'add', preset: 101 }, { action: 'add', preset: true }, { action: 'add' },
      { action: 'clear', preset: 17 }, { action: 'sort' }];
    for (const request of requests) await expect(compared.apply(request)).rejects.toThrow(InputError);
    expect(compared.slots).toEqual([17]);
  });

  it.each(['[17, 17]', '[0]', '{"slots": []}', '[1, 2, 3, 4, 5, 6, 7]'])('sets aside a file holding %s', async (contents) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new MemoryStore();
    store.files.set('compare.json', contents);
    expect((await CompareList.open(store, 'compare.json')).slots).toEqual([]);
    expect(store.files.get('compare.json.unreadable')).toBe(contents);
    error.mockRestore();
  });

  it('keeps the previous list when a write fails', async () => {
    const compared = await CompareList.open(new FullStore(), 'compare.json');
    await expect(compared.apply({ action: 'add', preset: 17 })).rejects.toThrow(StorageError);
    expect(compared.slots).toEqual([]);
  });
});

describe('saved preset marks', () => {
  it('survive a restart', async () => {
    const store = new MemoryStore();
    const saved = await SavedPresets.open(store, 'saved.json');
    saved.set(17, 'Wild Nocturne');
    await saved.settled();
    expect((await SavedPresets.open(store, 'saved.json')).state).toEqual({ 17: 'Wild Nocturne' });
  });

  it('can be cleared', () => {
    const saved = new SavedPresets();
    saved.set(17, 'Wild Nocturne');
    saved.set(17, null);
    expect(saved.state).toEqual({});
  });

  it('stay in place when a write fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const saved = await SavedPresets.open(new FullStore(), 'saved.json');
    saved.set(17, 'Wild Nocturne');
    await saved.settled();
    expect(saved.state).toEqual({ 17: 'Wild Nocturne' });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('the memory store', () => {
  it('refuses to create over an existing file', async () => {
    const store = new MemoryStore();
    await store.create('a', '1');
    await expect(store.create('a', '2')).rejects.toThrow('exists');
    expect(await store.read('a')).toBe('1');
  });
});
