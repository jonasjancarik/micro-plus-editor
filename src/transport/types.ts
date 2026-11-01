export const SERVICE = '90559580-b707-11ee-acb1-7b7e30f1af54';
export const REQUEST = '820a7e34-4e0a-4f90-8520-04ebce35a3a1';
export const RESPONSE = '1017adcc-dcbc-4387-a59f-2546b2ea5bb0';
export const NAME = 'Mustang Micro Plus';

/** The Bluetooth link to the amp. The browser and each phone platform provide their own. */
export interface BleTransport {
  connect(): Promise<void>;
  /** Sends one packet. Callers must wait for each write to finish before starting the next. */
  write(data: Uint8Array): Promise<void>;
  onNotify(listener: (data: Uint8Array) => void): void;
  onDisconnect(listener: () => void): void;
  isConnected(): boolean;
  disconnect(): Promise<void>;
}
