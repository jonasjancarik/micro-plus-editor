// Answered one question before the port: can this browser or phone keep up with the amp without the Python server?
import { Capacitor } from '@capacitor/core';
import { Amp } from '../src/core/amp';
import { CapacitorBleTransport } from '../src/transport/capacitor-ble';
import type { BleTransport } from '../src/transport/types';
import { steadyTimer } from '../src/transport/steady-timer';
import { WebBluetoothTransport } from '../src/transport/web-bluetooth';

const WRITE_SLOT = 100;
const params = new URLSearchParams(location.search);
const idleMinutes = Number(params.get('idle') ?? 10);
const native = Capacitor.isNativePlatform();
const platform = native ? `${Capacitor.getPlatform()}-app` : /Android/.test(navigator.userAgent) ? 'android' : 'desktop';
const run = `${new Date().toISOString().replace(/[:.]/g, '-')}-${platform}`;
// The app reaches the dev server on this computer through adb reverse.
const results = native ? 'http://localhost:5175/results' : '/results';

const $ = (id: string) => document.getElementById(id)!;
$('minutes').textContent = String(idleMinutes + 1);

let saving: Promise<unknown> = Promise.resolve();
function save(entry: object): void {
  const body = `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`;
  saving = saving.then(() => fetch(`${results}?run=${run}`, { method: 'POST', body })).catch(() => {});
}

function show(text: string, kind: 'ok' | 'bad' | 'info', detail: object = {}): void {
  const line = document.createElement('li');
  if (kind !== 'info') line.className = kind;
  line.textContent = text;
  $('log').append(line);
  save({ kind, text, ...detail });
}

async function step<T>(name: string, action: () => Promise<T>): Promise<T> {
  const started = performance.now();
  $('status').textContent = name;
  const result = await action();
  show(`${name} (${Math.round(performance.now() - started)} ms)`, 'ok');
  return result;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function idle(amp: Amp, minutes: number): Promise<void> {
  for (let minute = 1; minute <= minutes; minute++) {
    const before = amp.received;
    const sent = amp.keepAlive.sent;
    for (let second = 60; second > 0; second -= 5) {
      $('status').textContent = `Waiting with the amp idle: minute ${minute} of ${minutes}`;
      await sleep(5000);
    }
    show(`Idle minute ${minute}: sent ${amp.keepAlive.sent - sent} keep-alives, received ${amp.received - before} packets, page ${document.visibilityState}`, 'info',
      { keepAlive: amp.keepAlive, visibility: document.visibilityState });
  }
}

async function test(transport: BleTransport): Promise<void> {
  show('Started', 'info', { userAgent: navigator.userAgent, idleMinutes, reconnectWithoutPicker: !native && 'getDevices' in navigator.bluetooth });
  document.addEventListener('visibilitychange', () => save({ kind: 'info', text: `Page ${document.visibilityState}` }));
  await step('Connected', () => transport.connect());
  transport.onDisconnect(() => show('The Bluetooth connection closed', 'info'));
  const amp = new Amp(transport);
  await step('Read the amp\'s state and preset names', () => amp.initialize());
  show(`On preset ${amp.slot}, ${amp.names[amp.slot! - 1]}; ${amp.names.length} names`, 'info', { names: amp.names.length });
  if (amp.names.length !== 100) throw new Error(`Expected 100 preset names, got ${amp.names.length}`);
  if (amp.dirty) throw new Error('The current preset has unsaved changes, so the test stopped before switching away. Save or discard them, then reload.');
  const start = amp.slot!;
  amp.startKeepAlive(steadyTimer);
  try {
    await step('Read the current preset', () => amp.refreshCurrent());

    await step(`Switched to preset ${WRITE_SLOT}`, () => amp.switchTo(WRITE_SLOT));
    const before = await step(`Read preset ${WRITE_SLOT}`, () => amp.readPreset(WRITE_SLOT));
    const text = amp.stored.get(WRITE_SLOT)!.text;
    const roundTrip = JSON.stringify(before);
    save({ kind: 'backup', slot: WRITE_SLOT, text });
    show(`Preset ${WRITE_SLOT} is "${before.info.displayName}", ${text.length} characters; `
      + (roundTrip === text ? 'JavaScript keeps its text exactly' : `JavaScript re-saves it as ${roundTrip.length} characters`), 'info');
    await step(`Wrote preset ${WRITE_SLOT} and read it back unchanged`, () => amp.restorePreset(before, WRITE_SLOT));
    show(`The write took ${amp.lastWritePackets} packets`, 'info', { packets: amp.lastWritePackets, sent: roundTrip, readBack: amp.stored.get(WRITE_SLOT)!.text });
    await step(`Back on preset ${start}`, () => amp.switchTo(start));

    await idle(amp, idleMinutes);

    await step('Amp still answers after the idle wait: read the current preset', () => amp.refreshCurrent());
    await step(`Switched to preset ${WRITE_SLOT} after the idle wait`, () => amp.switchTo(WRITE_SLOT));
    await step(`Back on preset ${start}`, () => amp.switchTo(start));
    show('Keep-alive timing', 'info', { keepAlive: amp.keepAlive });
    show(`Keep-alives: ${amp.keepAlive.sent} sent, longest gap ${amp.keepAlive.longestGapMs} ms, ${amp.keepAlive.gapsOver500Ms} gaps over 500 ms, ${amp.keepAlive.gapsOver1000Ms} over 1 second`, 'info');
    show('Test passed', 'ok', { result: 'passed' });
    $('status').textContent = 'Test passed. You can close this page.';
  } finally {
    if (transport.isConnected() && amp.slot !== start) await amp.switchTo(start).catch(() => {});
    amp.dispose();
    await transport.disconnect();
  }
}

$('start').addEventListener('click', () => {
  ($('start') as HTMLButtonElement).disabled = true;
  const transport = native ? new CapacitorBleTransport() : new WebBluetoothTransport();
  test(transport).catch((error: Error) => {
    show(`${error.name}: ${error.message}`, 'bad', { result: 'failed' });
    $('status').textContent = 'Test stopped.';
    return transport.disconnect();
  }).catch(() => {});
});
