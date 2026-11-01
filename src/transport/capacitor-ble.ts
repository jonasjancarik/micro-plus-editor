import { BleClient } from '@capacitor-community/bluetooth-le';
import { REQUEST, RESPONSE, SERVICE, type BleTransport } from './types';

export class CapacitorBleTransport implements BleTransport {
  private deviceId?: string;
  private connected = false;
  private withoutResponse = false;
  private notifyListener: (data: Uint8Array) => void = () => {};
  private disconnectListeners: (() => void)[] = [];

  /** Opens the phone's device list. */
  async connect(): Promise<void> {
    await BleClient.initialize({ androidNeverForLocation: true });
    const device = await BleClient.requestDevice({ services: [SERVICE] });
    await BleClient.connect(device.deviceId, () => {
      this.connected = false;
      this.disconnectListeners.forEach((listener) => listener());
    });
    this.deviceId = device.deviceId;
    this.connected = true;
    const services = await BleClient.getServices(device.deviceId);
    const request = services.find((service) => service.uuid === SERVICE)
      ?.characteristics.find((characteristic) => characteristic.uuid === REQUEST);
    if (!request) throw new Error('Micro Plus control characteristic was not found');
    this.withoutResponse = Boolean(request.properties.writeWithoutResponse);
    await BleClient.startNotifications(device.deviceId, SERVICE, RESPONSE, (value) => {
      this.notifyListener(new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)));
    });
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.deviceId) throw new Error('Micro Plus is not connected');
    const value = new DataView(new Uint8Array(data).buffer);
    if (this.withoutResponse) await BleClient.writeWithoutResponse(this.deviceId, SERVICE, REQUEST, value);
    else await BleClient.write(this.deviceId, SERVICE, REQUEST, value);
  }

  onNotify(listener: (data: Uint8Array) => void): void {
    this.notifyListener = listener;
  }

  onDisconnect(listener: () => void): void {
    this.disconnectListeners.push(listener);
  }

  isConnected(): boolean {
    return this.connected;
  }

  async disconnect(): Promise<void> {
    if (this.deviceId) await BleClient.disconnect(this.deviceId);
  }
}
