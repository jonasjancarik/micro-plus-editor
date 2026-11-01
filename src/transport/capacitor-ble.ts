import { BleClient } from '@capacitor-community/bluetooth-le';
import { REQUEST, RESPONSE, SERVICE, type BleTransport } from './types';

const REMEMBERED = 'mmp-amp';

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
    await BleClient.initialize({ androidNeverForLocation: true });
    if (!this.chosen) {
      this.chosen = (await BleClient.requestDevice({ services: [SERVICE] })).deviceId;
      remember(this.chosen);
    }
    const chosen = this.chosen;
    await BleClient.connect(chosen, () => {
      this.connected = false;
      this.disconnectListeners.forEach((listener) => listener());
    });
    this.connected = true;
    const services = await BleClient.getServices(chosen);
    const request = services.find((service) => service.uuid === SERVICE)
      ?.characteristics.find((characteristic) => characteristic.uuid === REQUEST);
    if (!request) throw new Error('Micro Plus control characteristic was not found');
    this.withoutResponse = Boolean(request.properties.writeWithoutResponse);
    await BleClient.startNotifications(chosen, SERVICE, RESPONSE, (value) => {
      this.notifyListener(new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)));
    });
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
