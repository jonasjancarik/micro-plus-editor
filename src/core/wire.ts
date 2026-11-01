// The protobuf wire format, limited to what the Micro Plus messages use.
import { InputError } from './errors';

export type Field = [number: number, value: number | Uint8Array];

export function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export function hex(data: Uint8Array): string {
  return Array.from(data, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function fromHex(text: string): Uint8Array {
  return Uint8Array.from(text.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}

export function varint(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new InputError('Expected an unsigned protobuf integer');
  const output: number[] = [];
  while (value >= 128) {
    output.push((value % 128) + 128);
    value = Math.floor(value / 128);
  }
  output.push(value);
  return Uint8Array.from(output);
}

export function readVarint(data: Uint8Array, start: number): [value: number, offset: number] {
  let value = 0;
  let scale = 1;
  let offset = start;
  for (let count = 0; count < 10; count++) {
    const byte = data[offset];
    if (byte === undefined) throw new InputError('Truncated protobuf integer');
    offset++;
    value += (byte & 127) * scale;
    scale *= 128;
    if (byte < 128) return [value, offset];
  }
  throw new InputError('Protobuf integer is too long');
}

export function fields(data: Uint8Array): Field[] {
  const result: Field[] = [];
  let offset = 0;
  while (offset < data.length) {
    let tag: number;
    [tag, offset] = readVarint(data, offset);
    const number = Math.floor(tag / 8);
    const wire = tag % 8;
    if (number === 0) throw new InputError('Invalid protobuf field zero');
    if (wire === 0) {
      let value: number;
      [value, offset] = readVarint(data, offset);
      result.push([number, value]);
    } else if (wire === 1 || wire === 2 || wire === 5) {
      let length = wire === 1 ? 8 : 4;
      if (wire === 2) [length, offset] = readVarint(data, offset);
      if (offset + length > data.length) throw new InputError('Truncated protobuf field');
      result.push([number, data.slice(offset, offset + length)]);
      offset += length;
    } else {
      throw new InputError(`Unsupported protobuf wire type ${wire}`);
    }
  }
  return result;
}

export function wireBytes(number: number, value: Uint8Array): Uint8Array {
  return concat(varint(number * 8 + 2), varint(value.length), value);
}

export function wireString(number: number, value: string): Uint8Array {
  return wireBytes(number, new TextEncoder().encode(value));
}

export function wireUint(number: number, value: number): Uint8Array {
  return concat(varint(number * 8), varint(value));
}

export function asBytes(value: number | Uint8Array | undefined): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array();
}

export function asNumber(value: number | Uint8Array | undefined): number {
  return typeof value === 'number' ? value : 0;
}
