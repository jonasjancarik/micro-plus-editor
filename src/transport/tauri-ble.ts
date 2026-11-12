import { Channel, invoke } from '@tauri-apps/api/core';
import * as ble from '@mnlphlp/plugin-blec';
import { REQUEST, RESPONSE, SERVICE, type BleTransport } from './types';

const REMEMBERED = 'mmp-amp';
const FIND_MS = 6000;
const SETTLE_MS = 1000; // After the first amp turns up, in case another nearby answers too.
const WRITE_WITHOUT_RESPONSE = 0x04; // The standard Bluetooth characteristic property bits.
const WRITE_WITH_RESPONSE = 0x08;
const REPORT_MS = 30_000;
const NOT_FOUND = "Couldn't find your Micro Plus. Check that it's switched on and that Fender Tone is closed on your other devices, then try again.";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Prints to the terminal that started the app. Only for following a test run. */
export function log(line: string): void {
  invoke('log_line', { line }).catch(() => {});
}

function remembered(): string | undefined {
  try {
    return localStorage.getItem(REMEMBERED) ?? undefined;
  } catch {
    return undefined;
  }
}

function remember(address: string): void {
  try {
    localStorage.setItem(REMEMBERED, address);
  } catch { /* It only saves choosing the amp again next time. */ }
}

/**
 * Looks for amps and returns the remembered one if it answers, otherwise the one heard most clearly.
 * macOS only connects to a device it has come across since the app started, so this always scans first.
 */
async function findAmp(preferred?: string): Promise<string> {
  const heard = new Map<string, number>();
  let first = 0;
  await ble.startScan((devices) => {
    for (const device of devices) {
      const isAmp = device.services.some((service) => same(service, SERVICE)) || /mustang|micro plus/i.test(device.name);
      if (!isAmp) continue;
      heard.set(device.address, Math.max(device.rssi, heard.get(device.address) ?? -127));
      first ||= Date.now();
    }
  }, FIND_MS);
  const started = Date.now();
  try {
    while (Date.now() - started < FIND_MS && !(first && Date.now() - first >= SETTLE_MS) && !(preferred && heard.has(preferred))) await sleep(100);
  } finally {
    await ble.stopScan().catch(() => {});
  }
  log(`scan heard ${heard.size} amp(s): ${[...heard].map(([address, rssi]) => `${address} ${rssi} dBm`).join(', ') || 'none'}`);
  if (preferred && heard.has(preferred)) return preferred;
  const [loudest] = [...heard].sort((a, b) => b[1] - a[1]);
  if (!loudest) throw new Error(NOT_FOUND);
  return loudest[0];
}

/** Bluetooth through the native plugin, for the Tauri desktop app, whose WebKit has no Web Bluetooth. */
export class TauriBleTransport implements BleTransport {
  private chosen = remembered();
  private connection: ble.BleConnection | null = null;
  private connected = false;
  private withoutResponse = false;
  private notifyListener: (data: Uint8Array) => void = () => {};
  private disconnectListeners = new Set<() => void>();
  private notifications = 0;
  private reporter: ReturnType<typeof setInterval> | null = null;

  async connect(): Promise<void> {
    try {
      await this.connectOnce();
    } catch (error) {
      log(`connect failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error instanceof Error && error.message === NOT_FOUND ? error : new Error(NOT_FOUND);
    }
  }

  private async connectOnce(): Promise<void> {
    if (!(await ble.checkPermissions(true))) throw new Error('Micro Plus needs Bluetooth permission. Allow it in System Settings → Privacy & Security → Bluetooth, then try again.');
    if ((await ble.getAdapterState()) === 'Off') throw new Error("Bluetooth is switched off on this Mac. Switch it on, then try again.");
    const address = await findAmp(this.chosen);
    this.chosen = address;
    remember(address);
    const started = performance.now();
    this.connection = await ble.connect(address, () => {
      log('amp disconnected');
      this.connected = false;
      this.disconnectListeners.forEach((listener) => listener());
    });
    this.connected = true;
    const services = await this.connection.listServices();
    const request = services.find((service) => same(service.uuid, SERVICE))
      ?.characteristics.find((characteristic) => same(characteristic.uuid, REQUEST));
    if (!request) throw new Error("This doesn't seem to be a Micro Plus, or it didn't answer as one. Switch it off and on, then try again.");
    // btleplug holds a write without response until macOS says it can send again, and that signal
    // sometimes never comes, so a write with response is used whenever the amp accepts one.
    this.withoutResponse = !(request.properties & WRITE_WITH_RESPONSE) && Boolean(request.properties & WRITE_WITHOUT_RESPONSE);
    log(`request characteristic properties: 0x${request.properties.toString(16)}`);
    await this.connection.subscribe(RESPONSE, SERVICE, (value) => {
      this.notifications++;
      this.notifyListener(Uint8Array.from(value));
    });
    log(`connected to ${address} in ${Math.round(performance.now() - started)} ms, writes ${this.withoutResponse ? 'without' : 'with'} response`);
    this.startReporting();
  }

  async chooseAgain(): Promise<void> {
    const previous = this.chosen;
    this.chosen = await findAmp();
    remember(this.chosen);
    if (previous && previous !== this.chosen) await ble.disconnect(previous).catch(() => {});
  }

  write(data: Uint8Array): Promise<void> {
    return this.writePackets([data], 0);
  }

  async writePackets(packets: Uint8Array[], gapMs: number): Promise<void> {
    if (!this.chosen || !this.connection) throw new Error('Micro Plus is not connected');
    await invoke('amp_write', { address: this.chosen, packets: packets.map((packet) => Array.from(packet)), gapMs, withoutResponse: this.withoutResponse });
  }

  startKeepAlive(packet: Uint8Array, everyMs: number, onFailure: (error: Error) => void): () => void {
    const failed = new Channel<string>();
    failed.onmessage = (message) => {
      log(`keep-alive failed: ${message}`);
      onFailure(new Error(message));
    };
    invoke('keep_alive_start', { address: this.chosen, packet: Array.from(packet), everyMs, withoutResponse: this.withoutResponse, onFailure: failed })
      .then(() => log('keep-alive started in Rust'))
      .catch((error) => onFailure(error instanceof Error ? error : new Error(String(error))));
    return () => void invoke('keep_alive_stop').catch(() => {});
  }

  private startReporting(): void {
    if (this.reporter) return;
    this.reporter = setInterval(async () => {
      const stats = await invoke('keep_alive_stats').catch(() => null);
      log(`${document.visibilityState}: ${JSON.stringify({ ...(stats as object), notifications: this.notifications })}`);
    }, REPORT_MS);
    document.addEventListener('visibilitychange', () => log(`window is now ${document.visibilityState}`));
  }

  onNotify(listener: (data: Uint8Array) => void): void {
    this.notifyListener = listener;
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  hasDevice(): boolean {
    return Boolean(this.chosen);
  }

  deviceId(): string | null {
    return this.chosen ?? null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async disconnect(): Promise<void> {
    if (this.chosen) await ble.disconnect(this.chosen).catch(() => {});
    this.connected = false;
  }
}
