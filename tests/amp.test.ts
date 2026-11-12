import { describe, expect, it, vi } from 'vitest';
import { Amp, PACKET_GAP_MS, parameterKey, type RepeatingTimer } from '../src/core/amp';
import { eqPayload, parameterPayload, READ_PARAMETER, SET_PARAMETER } from '../src/core/commands';
import { AmpError, InputError } from '../src/core/errors';
import { fragments, request, selectPreset } from '../src/core/frames';
import { encodePreset, type Preset } from '../src/core/preset';
import { concat, fields, fromHex, hex, wireBytes, wireString, wireUint } from '../src/core/wire';
import type { BleTransport } from '../src/transport/types';

function transport(write: BleTransport['write'] = async () => {}): BleTransport {
  return { connect: async () => {}, hasDevice: () => true, deviceId: () => 'amp', write, onNotify: () => {}, onDisconnect: () => () => {}, isConnected: () => true, disconnect: async () => {} };
}

function manualTimer() {
  let tick = () => {};
  const stop = vi.fn();
  const timer: RepeatingTimer = (callback, ms) => {
    expect(ms).toBe(250);
    tick = callback;
    return stop;
  };
  return { timer, stop, tick: () => tick() };
}

const flush = () => new Promise((resolve) => setTimeout(resolve));

describe('keep-alive', () => {
  it('runs on the timer it is given, so a hidden page can use one that keeps its pace', async () => {
    const sent: string[] = [];
    const clock = manualTimer();
    const amp = new Amp(transport(async (data) => void sent.push(hex(data))));
    amp.startKeepAlive(clock.timer);
    clock.tick();
    await flush();
    clock.tick();
    await flush();
    expect(sent).toEqual(['3500050a03c20100', '3500050a03c20100']);
    amp.stopKeepAlive();
    expect(clock.stop).toHaveBeenCalled();
  });

  it('skips a beat instead of queueing while a write is still going', async () => {
    let release = () => {};
    const write = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const clock = manualTimer();
    const amp = new Amp(transport(write));
    amp.startKeepAlive(clock.timer);
    clock.tick();
    await flush();
    clock.tick();
    await flush();
    expect(write).toHaveBeenCalledTimes(1);
    release();
    await flush();
    clock.tick();
    await flush();
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('stops when a write fails', async () => {
    const clock = manualTimer();
    const amp = new Amp(transport(async () => { throw new Error('gone'); }));
    amp.startKeepAlive(clock.timer);
    clock.tick();
    await flush();
    expect(clock.stop).toHaveBeenCalled();
  });

  it('leaves the beat to a transport that keeps it natively, and hands it whole commands', async () => {
    const write = vi.fn(async () => {});
    const groups: string[][] = [];
    let failed: (error: Error) => void = () => {};
    const stopNative = vi.fn();
    const native: BleTransport = {
      ...transport(write),
      writePackets: async (packets, gapMs) => {
        expect(gapMs).toBe(PACKET_GAP_MS);
        groups.push(packets.map(hex));
      },
      startKeepAlive: (packet, everyMs, onFailure) => {
        expect([hex(packet), everyMs]).toEqual(['3500050a03c20100', 250]);
        failed = onFailure;
        return stopNative;
      },
    };
    const clock = manualTimer();
    const amp = new Amp(native);
    amp.startKeepAlive(clock.timer);
    clock.tick();
    await flush();
    const long = fragments(request(SET_PARAMETER, new Uint8Array(300)));
    await amp.sendPackets(long);
    expect(groups).toEqual([long.map(hex)]);
    expect(write).not.toHaveBeenCalled();
    failed(new Error('gone'));
    expect(amp.failure?.message).toBe('gone');
    expect(stopNative).toHaveBeenCalled();
  });
});

const preset = (): Preset => ({ nodeType: 'preset', info: { displayName: 'Test' },
  audioGraph: { nodes: [{ nodeId: 'amp', FenderId: 'ACD_LinearGainGT', dspUnitParameters: { gain: 0.5, gatePreset: 'off' } }] } });

/** A message from the amp, as Bluetooth packets. */
const reply = (kind: number, content: Uint8Array) => {
  const body = wireBytes(2, wireBytes(kind, content));
  return fragments(body, 100);
};
const hear = (amp: Amp, kind: number, content: Uint8Array) => reply(kind, content).forEach((part) => amp.notify(part));

describe('messages from the amp', () => {
  it('understands the selected preset in a captured report', () => {
    const amp = new Amp(transport());
    amp.notify(fromHex('35000a120808012a0408472001'));
    expect(amp.status()).toEqual({ preset: 72, name: null });
    expect(amp.dirty).toBe(false);
    hear(amp, 5, concat(wireUint(1, 71), wireUint(2, 1)));
    expect(amp.dirty).toBe(true);
  });

  it('counts a left-out preset number as the first preset', () => {
    const amp = new Amp(transport());
    amp.notify(fromHex('350008120608012a022001'));
    expect(amp.slot).toBe(1);
  });

  it('puts split preset names back together', () => {
    const amp = new Amp(transport());
    const body = concat(Uint8Array.of(0x08, 0x02), wireBytes(12, concat(wireString(1, 'One'), wireString(1, 'Two '))));
    const frame = wireBytes(2, body);
    amp.notify(concat(Uint8Array.of(0x33, 0, 5), frame.slice(0, 5)));
    amp.notify(concat(Uint8Array.of(0x35, 0, frame.length - 5), frame.slice(5)));
    expect(amp.names).toEqual(['One', 'Two']);
    expect(amp.failure).toBeNull();
  });

  it('ignores kinds it does not know, even if they are not made of fields', () => {
    const amp = new Amp(transport());
    hear(amp, 30, Uint8Array.of(0xff, 0xff));
    expect(amp.failure).toBeNull();
  });

  it('logs each message it does not use once, and not the ones it does', () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const amp = new Amp(transport());
    hear(amp, 30, wireUint(1, 3));
    hear(amp, 30, wireUint(1, 3));
    hear(amp, 30, wireUint(1, 4));
    hear(amp, 5, concat(wireUint(1, 71), wireUint(2, 1)));
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0]![0]).toMatch(/^Micro Plus sent something the editor doesn't use: [0-9a-f]+$/);
    log.mockRestore();
  });

  it('remembers a preset it can not read as a failure', () => {
    const amp = new Amp(transport());
    hear(amp, 4, wireBytes(1, new TextEncoder().encode('broken')));
    expect(amp.failure).toBeInstanceOf(InputError);
  });

  it('keeps a saved name in the list', () => {
    const amp = new Amp(transport());
    amp.names = ['One', 'Two'];
    hear(amp, 13, concat(wireUint(1, 1), wireString(2, 'Renamed  ')));
    expect(amp.names).toEqual(['One', 'Renamed']);
    expect(amp.saved).toEqual({ preset: 2, name: 'Renamed' });
  });

  it('takes in a change made on the amp itself', () => {
    const amp = new Amp(transport());
    amp.document = preset();
    hear(amp, 9, parameterPayload('amp', 'gain', 0.5, 'float'));
    expect(amp.documentRevision).toBe(0);
    hear(amp, 9, parameterPayload('amp', 'gain', 0.8, 'float'));
    expect(amp.document.audioGraph.nodes[0]!.dspUnitParameters.gain).toBeCloseTo(0.8);
    expect(amp.documentRevision).toBe(1);
  });

  it('follows the EQ, including a press of the amp’s EQ buttons', () => {
    const amp = new Amp(transport());
    expect(amp.eq).toBeNull();
    amp.notify(fromHex('35000b120908029a010408011002')); // Captured: the reply to reading the EQ, on EQ3.
    expect(amp.eq).toBe(2);
    amp.notify(fromHex('35000712059a01020801')); // Captured: someone pressed EQ down to Flat.
    expect(amp.eq).toBe(0);
  });

  it('sets the EQ the way the amp was seen to accept it, and waits for it to agree', async () => {
    const sent: string[] = [];
    const amp: Amp = new Amp(transport(async (data) => {
      sent.push(hex(data));
      setTimeout(() => hear(amp, 19, concat(wireUint(1, 1), wireUint(2, 1))));
    }));
    await amp.setEq(1);
    expect(amp.eq).toBe(1);
    expect(sent).toEqual([hex(fragments(request(26, fromHex('08011001')))[0]!)]);
    expect(hex(eqPayload(0))).toBe('0801');
  });

  it('turns a rejection into a clear message for the waiting command', async () => {
    const amp = new Amp(transport());
    const waiting = amp.waitFor(() => false);
    hear(amp, 17, wireUint(1, 4));
    await expect(waiting).rejects.toThrow('The Micro Plus rejected the change: parameter value out of range');
    await expect(waiting).rejects.toBeInstanceOf(InputError);
  });
});

describe('waiting for the amp', () => {
  it('only reports a switch once the amp confirms it', async () => {
    const sent: string[] = [];
    const amp = new Amp(transport(async (data) => void sent.push(hex(data))));
    amp.slot = 71;
    let done = false;
    const switching = amp.switchTo(72).then(() => { done = true; });
    await flush();
    expect(sent).toEqual([hex(selectPreset(72))]);
    expect(done).toBe(false);
    amp.notify(fromHex('35000a120808012a0408472001'));
    await switching;
    expect(amp.slot).toBe(72);
  });

  it('gives up when no answer comes', async () => {
    await expect(new Amp(transport()).waitFor(() => false, 10)).rejects.toThrow(AmpError);
  });

  it('stops waiting when the connection is gone', async () => {
    const amp = new Amp({ ...transport(), isConnected: () => false });
    await expect(amp.waitFor(() => false)).rejects.toThrow('disconnected');
  });

  it('does not send the packets of a long command back to back', async () => {
    const times: number[] = [];
    const amp = new Amp(transport(async () => void times.push(performance.now())));
    await amp.sendPackets([Uint8Array.of(1), Uint8Array.of(2), Uint8Array.of(3)]);
    expect(times).toHaveLength(3);
    for (let index = 1; index < 3; index++) expect(times[index]! - times[index - 1]!).toBeGreaterThanOrEqual(PACKET_GAP_MS * 0.9);
  });

  it('keeps writes in order and carries on after a failed one', async () => {
    const sent: number[] = [];
    let fail = true;
    const amp = new Amp(transport(async (data) => {
      if (fail) {
        fail = false;
        throw new Error('busy');
      }
      sent.push(data[0]!);
    }));
    const first = amp.sendPackets([Uint8Array.of(1)]);
    const second = amp.sendPackets([Uint8Array.of(2)]);
    await expect(first).rejects.toThrow('busy');
    await second;
    expect(sent).toEqual([2]);
  });
});

describe('saving', () => {
  it('refuses a save whose read back differs', async () => {
    const amp = new Amp(transport());
    amp.slot = 100;
    amp.document = preset();
    vi.spyOn(amp, 'command').mockImplementation(async () => {
      amp.saved = { preset: 100, name: 'Edited' };
      amp.saveRevision++;
    });
    vi.spyOn(amp, 'readPreset').mockResolvedValue(preset());
    const refresh = vi.spyOn(amp, 'refreshCurrent').mockResolvedValue(preset());
    await expect(amp.saveCurrent('Edited', 100)).rejects.toThrow(AmpError);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('gives a copy its own identity and leaves the source alone', async () => {
    const amp = new Amp(transport());
    amp.slot = 17;
    amp.document = preset();
    Object.assign(amp.document.info, { preset_id: 'SOURCE-ID', is_factory_default: true });
    const original = structuredClone(amp.document);
    const restore = vi.spyOn(amp, 'restorePreset').mockResolvedValue(preset());
    vi.spyOn(amp, 'refreshCurrent').mockResolvedValue(preset());
    await amp.saveCurrent('Copy', 100);
    const [copied, target] = restore.mock.calls[0]!;
    expect(target).toBe(100);
    expect(copied.info.preset_id).not.toBe('SOURCE-ID');
    expect(copied.info.is_factory_default).toBe(false);
    expect(amp.document).toEqual(original);
  });

  it('writes a preset, then checks what the amp read back', async () => {
    const amp = new Amp(transport());
    vi.spyOn(amp, 'command').mockImplementation(async (kind) => {
      if (kind === 18) hear(amp, 13, concat(wireUint(1, 99), wireString(2, 'Test')));
      else hear(amp, 10, concat(wireUint(1, 99), wireBytes(2, encodePreset(preset()))));
    });
    expect(await amp.restorePreset(preset(), 100)).toEqual(preset());
    const changed = preset();
    changed.audioGraph.nodes[0]!.dspUnitParameters.gain = 0.9;
    await expect(amp.restorePreset(changed, 100)).rejects.toThrow('Read-back');
  });

  it('refuses a slot outside 1 to 100 before sending anything', async () => {
    const amp = new Amp(transport());
    const command = vi.spyOn(amp, 'command');
    await expect(amp.restorePreset(preset(), 101)).rejects.toThrow(InputError);
    await expect(amp.readPreset(0)).rejects.toThrow(InputError);
    expect(command).not.toHaveBeenCalled();
  });
});

describe('changing a setting', () => {
  it('asks the amp for the type first, and sends a whole-number choice as one', async () => {
    const amp = new Amp(transport());
    amp.slot = amp.documentSlot = 100;
    amp.document = preset();
    amp.document.audioGraph.nodes[0]!.dspUnitParameters.comppreset = 1;
    const key = parameterKey('amp', 'comppreset');
    const kinds: number[] = [];
    vi.spyOn(amp, 'command').mockImplementation(async (kind, payload) => {
      kinds.push(kind);
      if (kind === READ_PARAMETER) {
        amp.parameters.set(key, 1);
        amp.parameterTypes.set(key, 5);
      } else {
        expect(new Map(fields(payload)).get(5)).toBe(0);
        amp.parameters.set(key, 0);
      }
      amp.parameterRevision++;
    });
    vi.spyOn(amp, 'refreshCurrent').mockResolvedValue(preset());
    await amp.setParameter('amp', 'comppreset', 0);
    expect(kinds).toEqual([READ_PARAMETER, SET_PARAMETER]);
  });

  it('refuses a fraction for a whole-number choice', async () => {
    const amp = new Amp(transport());
    amp.slot = amp.documentSlot = 100;
    amp.document = preset();
    amp.document.audioGraph.nodes[0]!.dspUnitParameters.gain = 1;
    const key = parameterKey('amp', 'gain');
    vi.spyOn(amp, 'command').mockImplementation(async () => {
      amp.parameters.set(key, 1);
      amp.parameterTypes.set(key, 5);
      amp.parameterRevision++;
    });
    await expect(amp.setParameter('amp', 'gain', 0.5)).rejects.toThrow('whole number');
  });

  it.each([[NaN], ['loud'], [true]])('refuses %s for a number', async (value) => {
    const amp = new Amp(transport());
    amp.document = preset();
    await expect(amp.setParameter('amp', 'gain', value)).rejects.toThrow(InputError);
  });

  it('refuses a setting the preset does not have', async () => {
    const amp = new Amp(transport());
    amp.document = preset();
    await expect(amp.setParameter('amp', 'nothing', 1)).rejects.toThrow(InputError);
  });

  // On a real amp a Delay Time of 0.02 s is stored as 0.03 s, which used to drop the connection.
  function limiting(reports: unknown, presetHolds: number) {
    const amp = new Amp(transport());
    amp.slot = amp.documentSlot = 100;
    amp.document = preset();
    const parameters = amp.document.audioGraph.nodes[0]!.dspUnitParameters;
    const key = parameterKey('amp', 'gain');
    vi.spyOn(amp, 'command').mockImplementation(async (kind) => {
      amp.parameters.set(key, (kind === READ_PARAMETER ? 0.5 : reports) as number);
      amp.parameterTypes.set(key, 3);
      amp.parameterRevision++;
    });
    vi.spyOn(amp, 'refreshCurrent').mockImplementation(async () => {
      parameters.gain = presetHolds;
      return preset();
    });
    return amp;
  }

  it('returns what the amp stored when it limits a value', async () => {
    expect(await limiting(0.03, 0.03).setParameter('amp', 'gain', 0.02)).toBe(0.03);
  });

  it('does not call a value limited when it was stored as sent', async () => {
    expect(await limiting(0.7, 0.7).setParameter('amp', 'gain', 0.7)).toBeNull();
  });

  it('fails when the preset does not confirm the limit', async () => {
    await expect(limiting(0.03, 0.5).setParameter('amp', 'gain', 0.02)).rejects.toThrow(AmpError);
  });

  it('fails when the reply is not a number', async () => {
    await expect(limiting('low', 0.5).setParameter('amp', 'gain', 0.02)).rejects.toThrow(AmpError);
  });
});

describe('keep-alive failures', () => {
  it('stops and calls back once a reply has gone wrong', async () => {
    const clock = manualTimer();
    const failed = vi.fn();
    const write = vi.fn(async () => {});
    const amp = new Amp(transport(write));
    amp.startKeepAlive(clock.timer, failed);
    amp.failure = new Error('bad reply');
    clock.tick();
    await flush();
    expect(failed).toHaveBeenCalledOnce();
    expect(clock.stop).toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});
