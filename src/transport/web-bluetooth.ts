import { REQUEST, RESPONSE, SERVICE, type BleTransport } from './types';

export class WebBluetoothTransport implements BleTransport {
  private device?: BluetoothDevice;
  private request?: BluetoothRemoteGATTCharacteristic;
  private notifyListener: (data: Uint8Array) => void = () => {};
  private disconnectListeners: (() => void)[] = [];

  /** Opens the browser's device list, so it has to be called from a click. */
  async connect(): Promise<void> {
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE] }],
    });
    this.device.addEventListener('gattserverdisconnected', () => this.disconnectListeners.forEach((listener) => listener()));
    const server = await this.device.gatt!.connect();
    const service = await server.getPrimaryService(SERVICE);
    this.request = await service.getCharacteristic(REQUEST);
    const response = await service.getCharacteristic(RESPONSE);
    response.addEventListener('characteristicvaluechanged', () => {
      const value = response.value!;
      this.notifyListener(new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)));
    });
    await response.startNotifications();
  }

  async write(data: Uint8Array): Promise<void> {
    const request = this.request;
    if (!request) throw new Error('Micro Plus is not connected');
    const bytes = new Uint8Array(data);
    if (request.properties.writeWithoutResponse) await request.writeValueWithoutResponse(bytes);
    else await request.writeValueWithResponse(bytes);
  }

  onNotify(listener: (data: Uint8Array) => void): void {
    this.notifyListener = listener;
  }

  onDisconnect(listener: () => void): void {
    this.disconnectListeners.push(listener);
  }

  isConnected(): boolean {
    return this.device?.gatt?.connected ?? false;
  }

  async disconnect(): Promise<void> {
    this.device?.gatt?.disconnect();
  }
}
