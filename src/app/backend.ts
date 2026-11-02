// What the page talks to: this device's Bluetooth, the simulated amp, or the Python server if that's what served it.
import { Capacitor } from '@capacitor/core';
import { dispatch } from '../core/dispatch';
import type { BackupEntry, EditorSession } from '../core/session';
import { MicroPlusSession } from '../core/session';
import { SimulatedSession } from '../core/simulator';
import { OpfsStore, UnavailableStore } from '../core/storage';
import { steadyTimer } from '../transport/steady-timer';
import { WebBluetoothTransport } from '../transport/web-bluetooth';

const BACKGROUND_CHECK_MS = 20_000;

/** The request got no answer, so it may or may not have reached the amp. */
export class NoReplyError extends Error {}

export interface Backend {
  read(): Promise<any>;
  post(path: string, body: unknown): Promise<any>;
  /** Connects if nothing else will. Absent when the page has no need to. */
  connect?(): void;
  /** Why this device can't connect at all, if so. */
  unsupported?: string;
  listBackups?(): Promise<BackupEntry[]>;
  readBackup?(name: string): Promise<string>;
}

class LocalBackend implements Backend {
  constructor(protected session: EditorSession) {}

  // Real copies, as replies from a server would be: the page and the session must not share a preset they each change.
  async read() {
    return structuredClone(this.session.snapshot());
  }

  post(path: string, body: unknown) {
    return dispatch(this.session, path, structuredClone(body)).then((reply) => structuredClone(reply));
  }

  listBackups() {
    return this.session.listBackups();
  }

  readBackup(name: string) {
    return this.session.readBackupFile(name);
  }
}

class BluetoothBackend extends LocalBackend {
  unsupported?: string;

  constructor(private real: MicroPlusSession, unsupported?: string) {
    super(real);
    this.unsupported = unsupported;
  }

  connect() {
    void this.real.start();
  }
}

class ServerBackend implements Backend {
  async read() {
    let response: Response;
    try {
      response = await fetch('/api/micro-plus', { signal: AbortSignal.timeout(5000) });
    } catch {
      throw new NoReplyError();
    }
    if (!response.ok) throw new NoReplyError();
    return response.json();
  }

  async post(path: string, body: unknown) {
    let response: Response;
    try {
      response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
    } catch {
      throw new NoReplyError();
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The Micro Plus did not confirm the change.');
    return result;
  }
}

async function servedByPython(): Promise<boolean> {
  try {
    const response = await fetch('/api/micro-plus', { signal: AbortSignal.timeout(2000) });
    return response.ok && (response.headers.get('content-type') ?? '').includes('application/json');
  } catch {
    return false;
  }
}

/** A connection can die while a phone has the app frozen, without anything saying so. */
function checkAfterBackground(session: MicroPlusSession): void {
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = performance.now();
    else if (hiddenAt && performance.now() - hiddenAt >= BACKGROUND_CHECK_MS) void session.checkConnection();
  });
}

async function bluetoothBackend(): Promise<Backend> {
  if (Capacitor.isNativePlatform()) {
    const [{ CapacitorBleTransport }, { CapacitorFileStore }] = await Promise.all([import('../transport/capacitor-ble'), import('../transport/capacitor-files')]);
    const store = new CapacitorFileStore();
    const transport = new CapacitorBleTransport();
    const session = await MicroPlusSession.open(transport, { store }, steadyTimer);
    checkAfterBackground(session);
    const backend = new BluetoothBackend(session);
    if (transport.hasDevice()) backend.connect(); // The app can open it again with no click, unlike a browser.
    return backend;
  }
  const store = await OpfsStore.open().catch((error) => {
    console.error('On-device storage is not available:', error);
    return new UnavailableStore();
  });
  const transport = new WebBluetoothTransport();
  const session = await MicroPlusSession.open(transport, { store }, steadyTimer);
  checkAfterBackground(session);
  if (navigator.bluetooth) {
    const backend = new BluetoothBackend(session);
    if (await transport.findRemembered()) backend.connect();
    return backend;
  }
  return new BluetoothBackend(session, "This browser can't use Bluetooth. Open the editor in Chrome or Edge on a computer or an Android phone, or use the phone app.");
}

export let backend: Backend;

export async function chooseBackend(): Promise<void> {
  const parameters = new URLSearchParams(location.search);
  if (parameters.has('simulator')) {
    const session = new SimulatedSession(Number(parameters.get('delay') ?? 800));
    Object.assign(window, { simulator: session }); // For trying out failures from the browser's console.
    backend = new LocalBackend(session);
  } else if (!Capacitor.isNativePlatform() && await servedByPython()) {
    backend = new ServerBackend();
  } else {
    backend = await bluetoothBackend();
  }
}
