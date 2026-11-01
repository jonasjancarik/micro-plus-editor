import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { factoryPresetGroups } from '../src/app/presets';
import fixture from '../src/data/mock_fixture.json';
import models from '../src/data/models.json';

describe('the board', () => {
  it('has its own look for every model', () => {
    const looks = readFileSync(resolve(import.meta.dirname, '../src/app/micro-plus-looks.css'), 'utf8');
    for (const choices of Object.values(models)) {
      for (const model of choices) {
        if (model.id !== 'DUBS_Unknown' && model.id !== 'ACD_Deluxe65GT') expect(looks).toContain(`[data-model="${model.id}"]`); // That one is the default amp look.
      }
    }
  });
});

describe('the factory presets', () => {
  const presets = (factoryPresetGroups as unknown as { presets: Record<string, { description: string; artists?: string[] }> }[]).flatMap((group) => Object.entries(group.presets));

  it('each have one group', () => {
    expect(presets.map(([name]) => name).sort()).toEqual(fixture.names.slice(0, 70).sort());
  });

  it('each have a description, and artists only if named', () => {
    for (const [, preset] of presets) {
      expect(preset.description).toBeTruthy();
      expect(Object.keys(preset).every((key) => key === 'description' || key === 'artists')).toBe(true);
      if (preset.artists) expect(preset.artists.length && preset.artists.every(Boolean)).toBeTruthy();
    }
  });
});
