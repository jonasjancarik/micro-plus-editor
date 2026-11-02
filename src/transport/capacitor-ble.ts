import { BleClient } from '@capacitor-community/bluetooth-le';
import { REQUEST, RESPONSE, SERVICE, type BleTransport } from './types';

const REMEMBERED = 'mmp-amp';
const FIND_MS = 6000;
const SETTLE_MS = 1000; // After the first amp turns up, in case another nearby answers too.
const NOT_FOUND = "Couldn't find your Micro Plus. Check that it's switched on and that Fender Tone is closed on your other devices, then try again.";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Looks for amps and returns the one heard most clearly. The plugin's own device list labels the amp
 * "Unknown" on iPadOS, which only knows a device's name once it has connected to it, so it isn't used.
 */
async function findAmp(): Promise<string> {
  const heard = new Map<string, number>();
  let first = 0;
  await BleClient.requestLEScan({ services: [SERVICE] }, ({ device, rssi }) => {
    heard.set(device.deviceId, Math.max(rssi ?? -127, heard.get(device.deviceId) ?? -127));
    first ||= Date.now();
  });
  const started = Date.now();
  try {
    while (Date.now() - started < FIND_MS && !(first && Date.now() - first >= SETTLE_MS)) await sleep(100);
  } finally {
    await BleClient.stopLEScan();
  }
  const [loudest] = [...heard].sort((a, b) => b[1] - a[1]);
  if (!loudest) throw new Error(NOT_FOUND);
  return loudest[0];
}

function remembered(): string | undefined {
  try {
    return localStorage.getItem(REMEMBERED) ?? undefined;
  } catch {
    return undefined;
  }
}

function remember(id: string): void {
  try {
    localStorage.setItem(REMEMBERED, id);
  } catch { /* It only saves choosing the amp again next time. */ }
}

export class CapacitorBleTransport implements BleTransport {
  private chosen = remembered();
  private connected = false;
  private withoutResponse = false;
  private notifyListener: (data: Uint8Array) => void = () => {};
  private disconnectListeners = new Set<() => void>();

  async connect(): Promise<void> {
    try {
      await this.connectOnce();
    } catch (error) {
      // The plugin's own messages name its functions, which mean nothing to someone playing guitar.
      const message = error instanceof Error ? error.message : '';
      throw /not found|requestDevice|requestLEScan|getDevices/i.test(message) ? new Error(NOT_FOUND) : error;
    }
  }

  private async connectOnce(): Promise<void> {
    await BleClient.initialize({ androidNeverForLocation: true });
    // iPadOS only connects to a device the app has come across since it started, so a remembered amp is looked up first.
    const known = this.chosen ? await BleClient.getDevices([this.chosen]).catch(() => []) : [];
    if (!known.length) {
      this.chosen = await findAmp();
      remember(this.chosen);
    }
    const chosen = this.chosen!;
    await BleClient.connect(chosen, () => {
      this.connected = false;
      this.disconnectListeners.forEach((listener) => listener());
    });
    this.connected = true;
    const services = await BleClient.getServices(chosen);
    const request = services.find((service) => service.uuid === SERVICE)
      ?.characteristics.find((characteristic) => characteristic.uuid === REQUEST);
    if (!request) throw new Error("This doesn't seem to be a Micro Plus, or it didn't answer as one. Switch it off and on, then try again.");
    this.withoutResponse = Boolean(request.properties.writeWithoutResponse);
    await BleClient.startNotifications(chosen, SERVICE, RESPONSE, (value) => {
      this.notifyListener(new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)));
    });
  }

  async chooseAgain(): Promise<void> {
    await BleClient.initialize({ androidNeverForLocation: true });
    const chosen = await findAmp();
    const previous = this.chosen;
    this.chosen = chosen;
    remember(chosen);
    if (previous && previous !== chosen) await BleClient.disconnect(previous).catch(() => {});
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.chosen) throw new Error('Micro Plus is not connected');
    const value = new DataView(new Uint8Array(data).buffer);
    if (this.withoutResponse) await BleClient.writeWithoutResponse(this.chosen, SERVICE, REQUEST, value);
    else await BleClient.write(this.chosen, SERVICE, REQUEST, value);
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
    if (this.chosen) await BleClient.disconnect(this.chosen);
  }
}
