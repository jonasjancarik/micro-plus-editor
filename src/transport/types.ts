export const SERVICE = '90559580-b707-11ee-acb1-7b7e30f1af54';
export const REQUEST = '820a7e34-4e0a-4f90-8520-04ebce35a3a1';
export const RESPONSE = '1017adcc-dcbc-4387-a59f-2546b2ea5bb0';
export const NAME = 'Mustang Micro Plus';

/** The Bluetooth link to the amp. The browser and each phone platform provide their own. */
export interface BleTransport {
  /** Connects to the amp chosen earlier, or opens the device list. A browser only allows that from a click. */
  connect(): Promise<void>;
  /** Whether an amp has been chosen, so that connecting needs no device list. */
  hasDevice(): boolean;
  deviceId(): string | null;
  /** Sends one packet. Callers must wait for each write to finish before starting the next. */
  write(data: Uint8Array): Promise<void>;
  /** Only the latest listener gets packets. */
  onNotify(listener: (data: Uint8Array) => void): void;
  /** Returns a function that stops listening. */
  onDisconnect(listener: () => void): () => void;
  isConnected(): boolean;
  disconnect(): Promise<void>;
  /**
   * Opens the device list again and uses the amp picked there, ending any attempt with the old one.
   * For when the amp can't be found the old way. A browser only allows it from a click.
   */
  chooseAgain?(): Promise<void>;
}
