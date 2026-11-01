// Answers one question: can this browser or phone keep up with the amp without the Python server?
import { Amp } from '../src/core/amp';
import type { BleTransport } from '../src/transport/types';
import { steadyTimer } from '../src/transport/steady-timer';
import { WebBluetoothTransport } from '../src/transport/web-bluetooth';

const WRITE_SLOT = 100;
const params = new URLSearchParams(location.search);
const idleMinutes = Number(params.get('idle') ?? 10);
const run = `${new Date().toISOString().replace(/[:.]/g, '-')}-${/Android/.test(navigator.userAgent) ? 'android' : 'desktop'}`;

const $ = (id: string) => document.getElementById(id)!;
$('minutes').textContent = String(idleMinutes + 1);

let saving: Promise<unknown> = Promise.resolve();
function save(entry: object): void {
  const body = `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`;
  saving = saving.then(() => fetch(`/results?run=${run}`, { method: 'POST', body })).catch(() => {});
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
  show('Started', 'info', { userAgent: navigator.userAgent, idleMinutes, reconnectWithoutPicker: 'getDevices' in navigator.bluetooth });
  document.addEventListener('visibilitychange', () => save({ kind: 'info', text: `Page ${document.visibilityState}` }));
  await step('Connected', () => transport.connect());
  transport.onDisconnect(() => show('The Bluetooth connection dropped', 'bad'));
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
    save({ kind: 'backup', slot: WRITE_SLOT, text: before.text });
    const roundTrip = JSON.stringify(before.preset);
    show(`Preset ${WRITE_SLOT} is "${before.preset.info.displayName}", ${before.text.length} characters; `
      + (roundTrip === before.text ? 'JavaScript keeps its text exactly' : `JavaScript re-saves it as ${roundTrip.length} characters`), 'info');
    const written = await step(`Wrote preset ${WRITE_SLOT} and read it back unchanged`, () => amp.restorePreset(before.preset, WRITE_SLOT));
    show(`The write took ${written.packets} packets`, 'info', { packets: written.packets, sent: roundTrip, readBack: written.text });
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
    amp.stopKeepAlive();
    await transport.disconnect();
  }
}

$('start').addEventListener('click', () => {
  ($('start') as HTMLButtonElement).disabled = true;
  test(new WebBluetoothTransport()).catch((error: Error) => {
    show(`${error.name}: ${error.message}`, 'bad', { result: 'failed' });
    $('status').textContent = 'Test stopped.';
  });
});
