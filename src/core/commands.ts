// The bodies of the commands sent to the amp. The command numbers come from Fender Tone's message definitions.
import { InputError } from './errors';
import { asBytes, concat, wireBytes, wireString, wireUint, type Field } from './wire';
import type { ParameterValue } from './preset';

export const CURRENT = 4;
export const SAVE_CURRENT = 5;
export const READ_PARAMETER = 11;
export const READ_PRESET = 12;
export const REPLACE_NODE = 17;
export const SAVE_AS = 18;
export const SET_PARAMETER = 20;
// Not in those definitions: found by trying them on the amp.
export const READ_EQ = 25;
export const SET_EQ = 26;
export const EQ_SETTINGS = 9;

export function isPresetNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100;
}

/** An EQ setting counted from 0, for EQ1 Flat, as the amp counts them. */
export function isEqSetting(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < EQ_SETTINGS;
}

/** The amp leaves out a zero, so this does too. Field 1 has always been 1; its meaning isn't known. */
export function eqPayload(setting: number): Uint8Array {
  return concat(wireUint(1, 1), setting ? wireUint(2, setting) : new Uint8Array());
}

/** JavaScript has one number type, so the caller says which the amp expects. */
export function parameterPayload(nodeId: string, parameterId: string, value: ParameterValue, number: 'float' | 'integer' = 'float'): Uint8Array {
  const start = concat(wireString(1, nodeId), wireString(2, parameterId));
  if (typeof value === 'boolean') return concat(start, wireUint(6, Number(value)));
  if (typeof value === 'string') return concat(start, wireString(4, value));
  if (!Number.isFinite(value)) throw new InputError('Parameter values must be finite');
  if (number === 'integer') {
    if (!Number.isInteger(value) || value < -(2 ** 31) || value >= 2 ** 31) throw new InputError('Integer parameter is out of range');
    return concat(start, wireUint(5, ((value << 1) ^ (value >> 31)) >>> 0));
  }
  if (!Number.isFinite(Math.fround(value))) throw new InputError('Parameter value is too large');
  const float = new DataView(new ArrayBuffer(4));
  float.setFloat32(0, value, true);
  return concat(start, Uint8Array.of(0x1d), new Uint8Array(float.buffer));
}

export function saveCurrentPayload(name: unknown, slot: unknown): Uint8Array {
  if (!isPresetNumber(slot)) throw new InputError('Choose a preset number from 1 to 100');
  if (typeof name !== 'string' || !name.trim() || [...name].length > 16 || [...name].some((character) => character.codePointAt(0)! < 32)) {
    throw new InputError('Enter a preset name');
  }
  return concat(wireString(1, name), wireUint(2, slot - 1));
}

/** What the amp reported for a parameter. It leaves out zero, false and empty, which gives null here. */
export function parameterValue(content: Map<Field[0], Field[1]>): ParameterValue | null {
  const float = content.get(3);
  if (float !== undefined) {
    if (!(float instanceof Uint8Array) || float.length !== 4) throw new InputError('Invalid float parameter response');
    return new DataView(float.buffer, float.byteOffset, 4).getFloat32(0, true);
  }
  if (content.has(4)) return new TextDecoder().decode(asBytes(content.get(4)));
  const integer = content.get(5);
  if (typeof integer === 'number') return (integer >>> 1) ^ -(integer & 1);
  if (content.has(6)) return Boolean(content.get(6));
  return null;
}
