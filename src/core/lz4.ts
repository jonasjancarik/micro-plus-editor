// The LZ4 block format, without a size header. The amp stores presets as compressed JSON.
import { InputError } from './errors';
const MIN_MATCH = 4;
const LAST_LITERALS = 5;
const MATCH_SEARCH_END = 12;
const MAX_OFFSET = 65535;

export function decompress(input: Uint8Array, maxSize: number): Uint8Array {
  const output = new Uint8Array(maxSize);
  let from = 0;
  let to = 0;
  const readLength = (start: number): number => {
    let length = start;
    if (start === 15) {
      let byte: number;
      do {
        byte = input[from++] ?? fail();
        length += byte;
      } while (byte === 255);
    }
    return length;
  };
  while (from < input.length) {
    const token = input[from++]!;
    const literals = readLength(token >> 4);
    if (from + literals > input.length || to + literals > maxSize) fail();
    output.set(input.subarray(from, from + literals), to);
    from += literals;
    to += literals;
    if (from === input.length) break;
    if (from + 2 > input.length) fail();
    const offset = input[from]! | (input[from + 1]! << 8);
    from += 2;
    if (offset === 0 || offset > to) fail();
    const length = readLength(token & 15) + MIN_MATCH;
    if (to + length > maxSize) fail();
    for (let index = 0; index < length; index++, to++) output[to] = output[to - offset]!;
  }
  return output.slice(0, to);
}

function fail(): never {
  throw new InputError('Invalid LZ4 data');
}

export function compress(input: Uint8Array): Uint8Array {
  const output: number[] = [];
  const seen = new Map<number, number>();
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const writeLength = (length: number): void => {
    for (; length >= 255; length -= 255) output.push(255);
    output.push(length);
  };
  const emit = (anchor: number, literalEnd: number, matchLength: number, offset: number): void => {
    const literals = literalEnd - anchor;
    const extra = matchLength - MIN_MATCH;
    output.push((Math.min(literals, 15) << 4) | (matchLength ? Math.min(extra, 15) : 0));
    if (literals >= 15) writeLength(literals - 15);
    for (let index = anchor; index < literalEnd; index++) output.push(input[index]!);
    if (!matchLength) return;
    output.push(offset & 255, offset >> 8);
    if (extra >= 15) writeLength(extra - 15);
  };
  const searchEnd = input.length - MATCH_SEARCH_END;
  const matchEnd = input.length - LAST_LITERALS;
  let anchor = 0;
  let at = 0;
  while (at <= searchEnd) {
    const key = view.getUint32(at, true);
    const candidate = seen.get(key);
    seen.set(key, at);
    if (candidate !== undefined && at - candidate <= MAX_OFFSET) {
      let length = MIN_MATCH;
      while (at + length < matchEnd && input[candidate + length] === input[at + length]) length++;
      emit(anchor, at, length, at - candidate);
      at += length;
      anchor = at;
    } else {
      at++;
    }
  }
  emit(anchor, input.length, 0, 0);
  return Uint8Array.from(output);
}
