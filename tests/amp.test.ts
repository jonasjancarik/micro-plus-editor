import { describe, expect, it, vi } from 'vitest';
import { Amp, type RepeatingTimer } from '../src/core/amp';
import { hex } from '../src/core/wire';
import type { BleTransport } from '../src/transport/types';

function transport(write: BleTransport['write'] = async () => {}): BleTransport {
  return { connect: async () => {}, write, onNotify: () => {}, onDisconnect: () => {}, isConnected: () => true, disconnect: async () => {} };
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
});
