import { REQUEST, RESPONSE, SERVICE, type BleTransport } from './types';

export class WebBluetoothTransport implements BleTransport {
  private device?: BluetoothDevice;
  private request?: BluetoothRemoteGATTCharacteristic;
  private response?: BluetoothRemoteGATTCharacteristic;
  private notifyListener: (data: Uint8Array) => void = () => {};
  private disconnectListeners = new Set<() => void>();
  private forward = () => {
    const value = this.response!.value!;
    this.notifyListener(new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)));
  };
  private disconnected = () => this.disconnectListeners.forEach((listener) => listener());

  private use(device: BluetoothDevice) {
    this.device?.removeEventListener('gattserverdisconnected', this.disconnected);
    this.device = device;
    device.addEventListener('gattserverdisconnected', this.disconnected);
  }

  async chooseAgain(): Promise<void> {
    const chosen = await navigator.bluetooth.requestDevice({ filters: [{ services: [SERVICE] }] });
    const previous = this.device;
    this.use(chosen);
    if (previous !== chosen) previous?.gatt?.disconnect(); // Ends an attempt that's still waiting on it.
  }

  /** Picks up an amp this site was allowed to use before, so a reload needs no click. */
  async findRemembered(): Promise<boolean> {
    const bluetooth = navigator.bluetooth as Bluetooth & { getDevices?: () => Promise<BluetoothDevice[]> };
    const devices = await bluetooth.getDevices?.().catch(() => []) ?? [];
    const [device] = devices;
    if (!device || devices.length > 1) return false;
    this.use(device);
    return true;
  }

  async connect(): Promise<void> {
    if (!this.device) this.use(await navigator.bluetooth.requestDevice({ filters: [{ services: [SERVICE] }] }));
    const server = await this.device!.gatt!.connect();
    const service = await server.getPrimaryService(SERVICE);
    this.request = await service.getCharacteristic(REQUEST);
    this.response?.removeEventListener('characteristicvaluechanged', this.forward);
    this.response = await service.getCharacteristic(RESPONSE);
    this.response.addEventListener('characteristicvaluechanged', this.forward);
    await this.response.startNotifications();
  }

  hasDevice(): boolean {
    return Boolean(this.device);
  }

  deviceId(): string | null {
    return this.device?.id ?? null;
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

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  isConnected(): boolean {
    return this.device?.gatt?.connected ?? false;
  }

  async disconnect(): Promise<void> {
    this.device?.gatt?.disconnect();
  }
}
