// Preset documents as the amp stores them.
import { InputError } from './errors';
import { compress, decompress } from './lz4';

export const MAX_PRESET_BYTES = 256 * 1024;

export type ParameterValue = number | boolean | string;

export interface PresetNode {
  nodeId: string;
  FenderId: string;
  dspUnitParameters: Record<string, ParameterValue>;
  [key: string]: unknown;
}

export interface Connection {
  input: { nodeId: string; index: number };
  output: { nodeId: string; index: number };
}

export interface Preset {
  nodeType: string;
  info: { displayName: string; [key: string]: unknown };
  audioGraph: { nodes: PresetNode[]; connections?: Connection[]; [key: string]: unknown };
  [key: string]: unknown;
}

export function decodePresetText(compressed: Uint8Array): string {
  if (compressed.length > MAX_PRESET_BYTES) throw new InputError('Invalid compressed preset size');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(decompress(compressed, MAX_PRESET_BYTES));
  } catch {
    throw new InputError('The amp returned an invalid preset definition');
  }
}

export function decodePreset(compressed: Uint8Array): Preset {
  let preset: unknown;
  try {
    preset = JSON.parse(decodePresetText(compressed));
  } catch {
    throw new InputError('The amp returned an invalid preset definition');
  }
  validatePreset(preset);
  return preset;
}

export function encodePreset(preset: Preset): Uint8Array {
  return compress(new TextEncoder().encode(JSON.stringify(preset)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertFinite(value: unknown): void {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new InputError('Parameter values must be finite');
  if (Array.isArray(value)) value.forEach(assertFinite);
  else if (isRecord(value)) Object.values(value).forEach(assertFinite);
}

export function validatePreset(preset: unknown): asserts preset is Preset {
  if (!isRecord(preset) || preset.nodeType !== 'preset') throw new InputError('Expected a Micro Plus preset definition');
  if (!isRecord(preset.info) || typeof preset.info.displayName !== 'string') throw new InputError('The preset has no name');
  const graph = preset.audioGraph;
  if (!isRecord(graph) || !Array.isArray(graph.nodes)) throw new InputError('The preset has no signal chain');
  if (graph.nodes.length < 1 || graph.nodes.length > 32) throw new InputError('Invalid signal-chain size');
  const seen = new Set<string>();
  for (const node of graph.nodes as unknown[]) {
    if (!isRecord(node)) throw new InputError('Invalid signal-chain module');
    if (typeof node.nodeId !== 'string' || !node.nodeId || seen.has(node.nodeId)) {
      throw new InputError('Invalid or duplicate module identifier');
    }
    seen.add(node.nodeId);
    if (typeof node.FenderId !== 'string') throw new InputError('Missing amplifier/effect model identifier');
    if (!isRecord(node.dspUnitParameters)) throw new InputError('Missing module parameters');
    for (const value of Object.values(node.dspUnitParameters)) {
      if (!['string', 'boolean', 'number'].includes(typeof value)) throw new InputError('Invalid module parameter');
    }
  }
  assertFinite(preset);
}

/** The positions in the order the sound travels, or null if the connections don't form one chain. */
export function signalOrder(preset: Preset): string[] | null {
  const graph = preset.audioGraph;
  const following = new Map((graph.connections ?? []).filter((link) => link.input.index === 0)
    .map((link) => [link.input.nodeId, link.output.nodeId]));
  const order: string[] = [];
  let at = following.get('preset');
  while (at && at !== 'preset' && order.length <= graph.nodes.length) {
    order.push(at);
    at = following.get(at);
  }
  const nodes = graph.nodes.map((node) => node.nodeId);
  return at === 'preset' && sameMembers(order, nodes) ? order : null;
}

function sameMembers(left: string[], right: string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

/** A copy of the preset whose sound travels through its positions in this order. Only the connections change. */
export function withSignalOrder(preset: Preset, order: unknown): Preset {
  const nodes = preset.audioGraph.nodes.map((node) => node.nodeId);
  if (!Array.isArray(order) || !order.every((node) => typeof node === 'string') || !sameMembers(order, nodes)) {
    throw new InputError('Put every pedal in the new order exactly once.');
  }
  const route = ['preset', ...(order as string[]), 'preset'];
  const reordered = structuredClone(preset);
  reordered.audioGraph.connections = route.slice(0, -1).flatMap((source, step) => [0, 1].map((index) => ({
    input: { nodeId: source, index }, output: { nodeId: route[step + 1]!, index },
  })));
  return reordered;
}

export function isClose(a: number, b: number, relative: number, absolute: number): boolean {
  return Math.abs(a - b) <= Math.max(relative * Math.max(Math.abs(a), Math.abs(b)), absolute);
}

function equal(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return isClose(a, b, 1e-5, 1e-5);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => equal(item, b[index]));
  if (isRecord(a) && isRecord(b)) {
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
