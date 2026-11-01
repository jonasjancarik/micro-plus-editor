// How messages are split into Bluetooth packets and put back together.
import { InputError } from './errors';
import { concat, readVarint, varint, wireBytes } from './wire';

const START = 0x33;
const MIDDLE = 0x34;
const LAST = 0x35;
const MAX_RESPONSE = 65536;

export function packet(payload: Uint8Array): Uint8Array {
  if (payload.length > 255) throw new InputError('Command is too large for one BLE frame');
  return concat(Uint8Array.of(LAST, 0, payload.length), payload);
}

export function selectPreset(slot: number): Uint8Array {
  if (!Number.isInteger(slot) || slot < 1 || slot > 100) throw new InputError('Preset number must be between 1 and 100');
  const index = concat(Uint8Array.of(0x08), varint(slot - 1));
  const command = concat(Uint8Array.of(0x42), varint(index.length), index);
  return packet(concat(Uint8Array.of(0x0a), varint(command.length), command));
}

export function fragments(payload: Uint8Array, maxPayload = 117): Uint8Array[] {
  if (payload.length === 0) throw new InputError('Invalid command size');
  const result: Uint8Array[] = [];
  for (let offset = 0; offset < payload.length; offset += maxPayload) {
    const chunk = payload.slice(offset, offset + maxPayload);
    const isLast = offset + maxPayload >= payload.length;
    const marker = isLast ? LAST : offset === 0 ? START : MIDDLE;
    result.push(concat(Uint8Array.of(marker, 0, chunk.length), chunk));
  }
  return result;
}

export function request(kind: number, payload: Uint8Array): Uint8Array {
  return wireBytes(1, wireBytes(kind, payload));
}

export class Frames {
  private buffer: Uint8Array = new Uint8Array();

  /** Returns a whole message once its last packet has arrived. */
  feed(data: Uint8Array): Uint8Array | null {
    const marker = data[0];
    if (data.length < 3 || (marker !== START && marker !== MIDDLE && marker !== LAST) || data[1] !== 0) {
      this.buffer = new Uint8Array();
      throw new InputError('Invalid Micro Plus BLE frame header');
    }
    if (data[2] !== data.length - 3) {
      this.buffer = new Uint8Array();
      throw new InputError('BLE frame length does not match payload');
    }
    if (marker === START) this.buffer = new Uint8Array();
    // Subscribing can catch the end of something the amp was already sending, which nobody here asked for.
    else if (marker === MIDDLE && this.buffer.length === 0) return null;
    this.buffer = concat(this.buffer, data.subarray(3));
    if (this.buffer.length > MAX_RESPONSE) {
      this.buffer = new Uint8Array();
      throw new InputError('Micro Plus response exceeds 64 KiB');
    }
    if (marker !== LAST) return null;
    const message = this.buffer;
    if (message[0] === 0x12) {
      // The amp can mark a middle chunk as last, so the length inside the message decides when it's complete.
      let length: number;
      let offset: number;
      try {
        [length, offset] = readVarint(message, 1);
      } catch {
        return null;
      }
      const expected = offset + length;
      if (expected > MAX_RESPONSE) {
        this.buffer = new Uint8Array();
        throw new InputError('Micro Plus response exceeds 64 KiB');
      }
      if (message.length < expected) return null;
      if (message.length > expected) {
        this.buffer = new Uint8Array();
        throw new InputError('Response exceeds its protobuf envelope length');
      }
    }
    this.buffer = new Uint8Array();
    return message;
  }
}
