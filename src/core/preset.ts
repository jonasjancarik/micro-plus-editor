// Preset documents as the amp stores them.
import { compress, decompress } from './lz4';

export const MAX_PRESET_BYTES = 256 * 1024;

export interface Preset {
  nodeType: string;
  info: { displayName: string; [key: string]: unknown };
  audioGraph: { nodes: { nodeId: string; [key: string]: unknown }[]; [key: string]: unknown };
  [key: string]: unknown;
}

export function decodePresetText(compressed: Uint8Array): string {
  return new TextDecoder().decode(decompress(compressed, MAX_PRESET_BYTES));
}

export function decodePreset(compressed: Uint8Array): Preset {
  const preset: unknown = JSON.parse(decodePresetText(compressed));
  validatePreset(preset);
  return preset;
}

export function encodePreset(preset: Preset): Uint8Array {
  return compress(new TextEncoder().encode(JSON.stringify(preset)));
}

export function validatePreset(preset: unknown): asserts preset is Preset {
  const candidate = preset as Partial<Preset> | null;
  if (candidate?.nodeType !== 'preset') throw new Error('Expected a Micro Plus preset definition');
  if (typeof candidate.info?.displayName !== 'string') throw new Error('The preset has no name');
  const nodes = candidate.audioGraph?.nodes;
  if (!Array.isArray(nodes) || nodes.length < 1 || nodes.length > 32) throw new Error('Invalid signal-chain size');
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(1e-5 * Math.max(Math.abs(a), Math.abs(b)), 1e-5);
}

function equal(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return close(a, b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => equal(item, b[index]));
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    // Saved factory presets can contain the default input mapping that current-preset reports leave out.
    const keep = ([key, value]: [string, unknown]) => !(key === 'gateDetectorPosition' && value === 'jack');
    const left = Object.entries(a).filter(keep);
    const right = new Map(Object.entries(b).filter(keep));
    return left.length === right.size && left.every(([key, value]) => right.has(key) && equal(value, right.get(key)));
  }
  return a === b;
}

/** Compares the signal chains, allowing for rounding when the amp stores numbers as 32-bit floats. */
export function presetsMatch(expected: Preset, actual: Preset): boolean {
  return expected.info.displayName.trimEnd() === actual.info.displayName.trimEnd()
    && equal(expected.audioGraph, actual.audioGraph);
}
