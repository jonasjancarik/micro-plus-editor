// What the page talks to: this device's Bluetooth or the simulated amp.
import { Capacitor } from '@capacitor/core';
import { dispatch } from '../core/dispatch';
import type { BackupEntry, EditorSession } from '../core/session';
import { MicroPlusSession } from '../core/session';
import { SimulatedSession } from '../core/simulator';
import { OpfsStore, UnavailableStore } from '../core/storage';
import { steadyTimer } from '../transport/steady-timer';
import { WebBluetoothTransport } from '../transport/web-bluetooth';

const BACKGROUND_CHECK_MS = 20_000;
/** How long the editor can be in the background before it lets go of the amp. Reconnecting takes about 3 s. */
const REST_AFTER_MS = 60_000;

export interface Backend {
  read(): Promise<any>;
  post(path: string, body: unknown): Promise<any>;
  /** Connects if nothing else will. Absent when the page has no need to. */
  connect?(): void;
  /** Why this device can't connect at all, if so. */
  unsupported?: string;
  /** Opens the device list to pick the amp again. Absent where that isn't possible. Call it from a click. */
  chooseAgain?(): Promise<void>;
  /** Whether the editor lets go of the amp after a while in the background. Absent where that isn't possible. */
  batterySaver?: boolean;
  setBatterySaver?(on: boolean): void;
  /** Brings the amp back after the editor let go of it. In a browser, call it from a click. */
  reconnect?(): Promise<void>;
  /** Whether it reconnects by itself when shown again, rather than waiting for reconnect() from a click. */
  reconnectsByItself?: boolean;
  listBackups?(): Promise<BackupEntry[]>;
  readBackup?(name: string): Promise<string>;
}

class LocalBackend implements Backend {
  constructor(protected session: EditorSession) {}

  // Real copies: the page and the session must not share a preset they each change.
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

const BATTERY_SAVER = 'mmp-battery-saver';

class BluetoothBackend extends LocalBackend {
  unsupported?: string;
  batterySaver: boolean;
  reconnectsByItself: boolean;

  /** findsAmpByItself: whether it can reconnect without the device list, which a browser only opens from a click. */
  constructor(private real: MicroPlusSession, private findsAmpByItself: boolean, unsupported?: string) {
    super(real);
    this.reconnectsByItself = findsAmpByItself;
    this.unsupported = unsupported;
    try { this.batterySaver = localStorage.getItem(BATTERY_SAVER) === '1'; } catch { this.batterySaver = false; }
    watchBackground(real, this, findsAmpByItself);
  }

  setBatterySaver(on: boolean) {
    this.batterySaver = on;
    try { localStorage.setItem(BATTERY_SAVER, on ? '1' : '0'); } catch { /* Then it's only for this visit. */ }
  }

  async reconnect() {
    if (this.findsAmpByItself) this.real.resume();
    else await this.real.chooseAgain();
  }

  connect() {
    void this.real.start();
  }

  chooseAgain() {
    return this.real.chooseAgain();
  }
}

class SimulatorBackend extends LocalBackend {
  constructor(private simulator: SimulatedSession) {
    super(simulator);
  }

  chooseAgain() {
    return this.simulator.chooseAgain();
  }
}

/**
 * A connection can die while a phone has the app frozen, without anything saying so. And an amp that stays
 * connected while nobody is looking at the editor runs its battery down, so with the battery saver on, after
 * a while in the background the editor lets go of it, unless there are unsaved changes. The apps reconnect
 * when they're shown again. A browser needs a click: after letting go, Chrome on the Mac failed every
 * reconnect with "Bluetooth Device is no longer in range" until the amp was chosen from the device list again.
 */
function watchBackground(session: MicroPlusSession, backend: BluetoothBackend, findsAmpByItself: boolean): void {
  let hiddenAt = 0;
  let restTimer: ReturnType<typeof setTimeout> | undefined;
  document.addEventListener('visibilitychange', () => {
    clearTimeout(restTimer);
    if (document.hidden) {
      hiddenAt = performance.now();
      if (backend.batterySaver) restTimer = setTimeout(() => void session.rest(), REST_AFTER_MS);
    } else if (session.phase === 'resting') {
      if (findsAmpByItself) session.resume(); // Otherwise the page offers a button.
    } else if (hiddenAt && performance.now() - hiddenAt >= BACKGROUND_CHECK_MS) {
      void session.checkConnection();
    }
  });
}

async function bluetoothBackend(): Promise<Backend> {
  if (Capacitor.isNativePlatform()) {
    const [{ CapacitorBleTransport }, { CapacitorFileStore }] = await Promise.all([import('../transport/capacitor-ble'), import('../transport/capacitor-files')]);
    const store = new CapacitorFileStore();
    const transport = new CapacitorBleTransport();
    const session = await MicroPlusSession.open(transport, { store }, steadyTimer);
    const backend = new BluetoothBackend(session, true);
    if (transport.hasDevice()) backend.connect(); // The app can open it again with no click, unlike a browser.
    return backend;
  }
  const store = await OpfsStore.open().catch((error) => {
    console.error('On-device storage is not available:', error);
    return new UnavailableStore();
  });
  const transport = new WebBluetoothTransport();
  const session = await MicroPlusSession.open(transport, { store }, steadyTimer);
  if (navigator.bluetooth) {
    const backend = new BluetoothBackend(session, false);
    if (await transport.findRemembered()) backend.connect();
    return backend;
  }
  return new BluetoothBackend(session, false, "This browser can't use Bluetooth. Open the editor in Chrome or Edge on a computer or an Android phone, or use the phone app.");
}

export let backend: Backend;

export async function chooseBackend(): Promise<void> {
  const parameters = new URLSearchParams(location.search);
  if (parameters.has('simulator')) {
    const session = new SimulatedSession(Number(parameters.get('delay') ?? 800));
    Object.assign(window, { simulator: session }); // For trying out failures from the browser's console.
    backend = new SimulatorBackend(session);
  } else {
    backend = await bluetoothBackend();
  }
}
