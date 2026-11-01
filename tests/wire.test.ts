import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fragments, Frames, packet, request, selectPreset } from '../src/core/frames';
import { compress, decompress } from '../src/core/lz4';
import { CURRENT, parameterPayload, parameterValue, READ_PARAMETER, READ_PRESET, REPLACE_NODE, SAVE_CURRENT, saveCurrentPayload, SET_PARAMETER } from '../src/core/commands';
import { InputError } from '../src/core/errors';
import { decodePreset, decodePresetText, encodePreset, presetsMatch, signalOrder, validatePreset, withSignalOrder, type Preset } from '../src/core/preset';
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

describe('matches the Python code for commands', () => {
  it('encodes every kind of setting the same way', () => {
    for (const { kind, value, hex: expected } of fixture.parameters) {
      const number = kind === 'integer' ? 'integer' : 'float';
      expect(hex(parameterPayload('amp', 'gain', value, number))).toBe(expected);
    }
  });

  it('reads every kind of setting the same way', () => {
    for (const { hex: reply, value } of fixture.parameterReplies) {
      expect(parameterValue(new Map(fields(fromHex(reply))))).toBe(value);
    }
  });

  it('encodes a save the same way', () => {
    expect(hex(saveCurrentPayload('Editor test', 100))).toBe(fixture.save['Editor test']);
    expect(hex(saveCurrentPayload('Zvuk č', 1))).toBe(fixture.save['Zvuk č']);
  });

  it('builds the same commands', () => {
    const built = {
      current: request(CURRENT, wireUint(1, 1)),
      readPreset: request(READ_PRESET, concat(wireUint(1, 99), wireUint(2, 1))),
      readParameter: request(READ_PARAMETER, concat(wireString(1, 'amp'), wireString(2, 'gain'))),
      setParameter: request(SET_PARAMETER, parameterPayload('amp', 'gain', 0.5)),
      replaceNode: request(REPLACE_NODE, concat(wireString(1, 'amp'), wireString(2, 'ACD_Deluxe65GT'))),
      saveCurrent: request(SAVE_CURRENT, saveCurrentPayload('Editor test', 100)),
    };
    for (const [name, body] of Object.entries(built)) expect(fragments(body).map(hex)).toEqual(fixture.commands[name]);
  });

  it('rewires a new pedal order the same way', () => {
    const preset = JSON.parse(fixture.lz4.raw) as Preset;
    const standard = withSignalOrder(preset, fixture.order.standard);
    expect(signalOrder(standard)).toEqual(fixture.order.found);
    expect(withSignalOrder(preset, fixture.order.moved).audioGraph.connections).toEqual(fixture.order.connections);
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

describe('save names and setting values', () => {
  it.each([[0, 'Name'], [101, 'Name'], [true, 'Name'], ['100', 'Name'], [1.5, 'Name'], [50, ''], [50, '   '], [50, 'x'.repeat(17)], [50, 'a\nb'], [50, 7]])(
    'refuses slot %s with name %s', (slot, name) => {
      expect(() => saveCurrentPayload(name, slot)).toThrow(InputError);
    });

  it('refuses numbers the amp could not hold', () => {
    expect(() => parameterPayload('amp', 'gain', NaN)).toThrow(InputError);
    expect(() => parameterPayload('amp', 'gain', 1e39)).toThrow('too large');
    expect(() => parameterPayload('amp', 'gain', 2 ** 31, 'integer')).toThrow('out of range');
    expect(() => parameterPayload('amp', 'gain', 0.5, 'integer')).toThrow(InputError);
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
  it('forgets a partial message when a packet is damaged', () => {
    const frames = new Frames();
    frames.feed(fromHex('3300021206'));
    expect(() => frames.feed(fromHex('350002ff'))).toThrow('length');
    expect(frames.feed(fromHex('35000312017f'))).toEqual(fromHex('12017f'));
  });

  it('reassembles a long command it split itself', () => {
    const original = new Uint8Array(1000).fill(120);
    const parts = fragments(original);
    const frames = new Frames();
    for (const part of parts.slice(0, -1)) expect(frames.feed(part)).toBeNull();
    expect(frames.feed(parts.at(-1)!)).toEqual(original);
    expect(parts.every((part) => part.length <= 120)).toBe(true);
  });

  it('refuses a slot outside 1 to 100', () => {
    for (const slot of [0, -1, 101]) expect(() => selectPreset(slot)).toThrow(InputError);
  });

  it('refuses a bad header and a wrong length', () => {
    expect(() => new Frames().feed(Uint8Array.of(0x20, 0, 0))).toThrow('header');
    expect(() => new Frames().feed(Uint8Array.of(0x35, 0, 5, 1))).toThrow('length');
  });

  it('ignores the end of a message sent before it subscribed', () => {
    const frames = new Frames();
    expect(frames.feed(Uint8Array.of(0x34, 0, 2, 0x6f, 5))).toBeNull();
    expect(frames.feed(Uint8Array.of(0x35, 0, 4, 0x12, 2, 7, 8))).toEqual(Uint8Array.of(0x12, 2, 7, 8));
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

  const small = (): Preset => ({ nodeType: 'preset', info: { displayName: 'Test' },
    audioGraph: { nodes: [{ nodeId: 'amp', FenderId: 'ACD_LinearGainGT', dspUnitParameters: { gain: 0.5, gatePreset: 'off' } }] } });

  it('refuses damaged data as bad input', () => {
    expect(() => decodePreset(new TextEncoder().encode('broken'))).toThrow(InputError);
    expect(() => decodePresetText(new Uint8Array(256 * 1024 + 1))).toThrow(InputError);
  });

  it('refuses values that are not finite', () => {
    for (const value of [NaN, Infinity]) {
      const preset = small();
      preset.audioGraph.nodes[0]!.dspUnitParameters.gain = value;
      expect(() => validatePreset(preset)).toThrow('finite');
    }
    const elsewhere = small() as Preset & { extra: unknown };
    elsewhere.extra = [{ value: NaN }];
    expect(() => validatePreset(elsewhere)).toThrow('finite');
  });

  it.each([
    ['not an object', 'text'], ['the wrong kind', { nodeType: 'other' }],
    ['no name', { nodeType: 'preset', info: {}, audioGraph: { nodes: [] } }],
    ['no chain', { nodeType: 'preset', info: { displayName: 'x' } }],
    ['an empty chain', { nodeType: 'preset', info: { displayName: 'x' }, audioGraph: { nodes: [] } }],
  ])('refuses %s', (_name, preset) => {
    expect(() => validatePreset(preset)).toThrow(InputError);
  });

  it('refuses malformed pedals', () => {
    const cases: ((node: Record<string, unknown>) => void)[] = [
      (node) => { node.nodeId = ''; }, (node) => { delete node.FenderId; }, (node) => { node.dspUnitParameters = []; },
      (node) => { node.dspUnitParameters = { gain: [1] }; },
    ];
    for (const change of cases) {
      const preset = small();
      change(preset.audioGraph.nodes[0]!);
      expect(() => validatePreset(preset)).toThrow(InputError);
    }
    const twice = small();
    twice.audioGraph.nodes.push(structuredClone(twice.audioGraph.nodes[0]!));
    expect(() => validatePreset(twice)).toThrow('duplicate');
  });

  it('accepts the default input mapping being left out, and nothing else', () => {
    const original = small();
    original.audioGraph.nodes[0]!.dspUnitParameters.gateDetectorPosition = 'jack';
    expect(presetsMatch(original, small())).toBe(true);
    original.audioGraph.nodes[0]!.dspUnitParameters.gateDetectorPosition = 'different';
    expect(presetsMatch(original, small())).toBe(false);
  });

  it('allows the rounding of a 32-bit float on read back', () => {
    const expected = small();
    const actual = small();
    expected.audioGraph.nodes[0]!.dspUnitParameters.gain = 0.6;
    actual.audioGraph.nodes[0]!.dspUnitParameters.gain = 0.6000000238418579;
    expect(presetsMatch(expected, actual)).toBe(true);
  });

  it('refuses an order that does not hold every pedal once', () => {
    const preset = withSignalOrder(JSON.parse(fixture.lz4.raw), fixture.order.standard);
    for (const order of [['stomp', 'mod', 'amp', 'delay'], ['stomp', 'stomp', 'amp', 'delay', 'reverb'], 'stomp', null]) {
      expect(() => withSignalOrder(preset, order)).toThrow(InputError);
    }
  });

  it('finds no order when the connections do not make one chain', () => {
    const preset = withSignalOrder(JSON.parse(fixture.lz4.raw), fixture.order.standard);
    preset.audioGraph.connections = preset.audioGraph.connections!.slice(2);
    expect(signalOrder(preset)).toBeNull();
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
