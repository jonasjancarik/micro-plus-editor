import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fragments, Frames, packet, request, selectPreset } from '../src/core/frames';
import { compress, decompress } from '../src/core/lz4';
import { decodePreset, encodePreset, presetsMatch, type Preset } from '../src/core/preset';
import { concat, fields, fromHex, hex, readVarint, varint, wireBytes, wireString, wireUint } from '../src/core/wire';

const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/wire.json'), 'utf8'));

describe('matches the Python code', () => {
  it('selects presets with the same bytes', () => {
    for (const [slot, bytes] of Object.entries(fixture.select)) expect(hex(selectPreset(Number(slot)))).toBe(bytes);
  });

  it('frames a short command the same way', () => {
    expect(hex(packet(Uint8Array.of(1, 2)))).toBe(fixture.packet);
  });

  it('splits a preset write into the same packets', () => {
    const packets = fragments(request(18, fromHex(fixture.saveAs.payload)));
    expect(packets.map(hex)).toEqual(fixture.saveAs.packets);
  });

  it('reads presets compressed by Python', () => {
    const raw = decompress(fromHex(fixture.lz4.compressed), 256 * 1024);
    expect(new TextDecoder().decode(raw)).toBe(fixture.lz4.raw);
  });

  it('puts split replies back together', () => {
    const frames = new Frames();
    const assembled = fixture.frames.packets.map((part: string) => {
      const message = frames.feed(fromHex(part));
      return message && hex(message);
    });
    expect(assembled).toEqual(fixture.frames.assembled);
  });
});

describe('lz4', () => {
  const text = (input: string) => new TextEncoder().encode(input);

  it.each([
    ['empty', ''], ['short', 'abc'], ['exactly twelve', 'aaaaaaaaaaaa'], ['thirteen', 'aaaaaaaaaaaaa'],
    ['long run', 'x'.repeat(70000)], ['many literals', Array.from({ length: 400 }, (_, i) => String.fromCharCode(33 + i % 90, 33 + (i * 7) % 83)).join('')],
    ['preset', fixture.lz4.raw],
  ])('round trips %s', (_name, input) => {
    const data = text(input);
    expect(decompress(compress(data), 256 * 1024)).toEqual(data);
  });

  it('actually compresses a preset', () => {
    const data = text(fixture.lz4.raw);
    expect(compress(data).length).toBeLessThan(data.length * 0.6);
  });

  it('rejects damaged data', () => {
    expect(() => decompress(Uint8Array.of(0xf0), 100)).toThrow('Invalid LZ4');
    expect(() => decompress(Uint8Array.of(0x10, 65, 9, 0), 100)).toThrow('Invalid LZ4');
    expect(() => decompress(Uint8Array.of(0x50, 65, 66), 100)).toThrow('Invalid LZ4');
  });
});

describe('wire format', () => {
  it('round trips large integers', () => {
    for (const value of [0, 127, 128, 300, 2 ** 31, 2 ** 40]) expect(readVarint(varint(value), 0)[0]).toBe(value);
  });

  it('reads back written fields', () => {
    const data = concat(wireUint(1, 99), wireBytes(2, Uint8Array.of(7)), wireString(3, 'ok'));
    expect(fields(data)).toEqual([[1, 99], [2, Uint8Array.of(7)], [3, new TextEncoder().encode('ok')]]);
  });

  it('refuses a truncated field', () => {
    expect(() => fields(Uint8Array.of(0x12, 5, 1))).toThrow('Truncated');
  });
});

describe('frames', () => {
  it('refuses a bad header and a wrong length', () => {
    expect(() => new Frames().feed(Uint8Array.of(0x20, 0, 0))).toThrow('header');
    expect(() => new Frames().feed(Uint8Array.of(0x35, 0, 5, 1))).toThrow('length');
    expect(() => new Frames().feed(Uint8Array.of(0x34, 0, 1, 1))).toThrow('Continuation');
  });

  it('waits when the amp marks a middle chunk as last', () => {
    const frames = new Frames();
    expect(frames.feed(Uint8Array.of(0x35, 0, 3, 0x12, 3, 1))).toBeNull();
    expect(frames.feed(Uint8Array.of(0x35, 0, 2, 2, 3))).toEqual(Uint8Array.of(0x12, 3, 1, 2, 3));
  });
});

describe('presets', () => {
  const preset = JSON.parse(fixture.lz4.raw) as Preset;

  it('survives encoding', () => {
    expect(presetsMatch(preset, decodePreset(encodePreset(preset)))).toBe(true);
  });

  it('allows float rounding but not real differences', () => {
    const copy = structuredClone(preset);
    const parameters = copy.audioGraph.nodes[2]!.dspUnitParameters as Record<string, number>;
    parameters.gain = parameters.gain! + 1e-7;
    expect(presetsMatch(preset, copy)).toBe(true);
    parameters.gain = parameters.gain! + 0.1;
    expect(presetsMatch(preset, copy)).toBe(false);
  });
});
