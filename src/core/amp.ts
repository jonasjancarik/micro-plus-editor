// Talks to the amp over any BleTransport: the same steps as Controller in server/mmp_ble.py.
import { fragments, Frames, request, selectPreset } from './frames';
import { decodePreset, decodePresetText, encodePreset, presetsMatch, validatePreset, type Preset } from './preset';
import { asBytes, asNumber, concat, fields, fromHex, wireBytes, wireString, wireUint } from './wire';
import type { BleTransport } from '../transport/types';

// Sent back to back, the packets of a long command can get lost, and the amp then stops answering until it reconnects.
const PACKET_GAP_MS = 30;
const KEEPALIVE_MS = 250;
const KEEPALIVE = fromHex('3500050a03c20100');
const HANDSHAKE = ['3500021a00', '3500040a023a00', '3500040a027200', '3500060a0422020801',
  '3500050a03b20100', '3500050a03ca0100', '3500041a020801'];
const CURRENT = 4;
const READ_PRESET = 12;
const SAVE_AS = 18;
const AMP_ERRORS = ['unsupported command', 'operation failed', 'invalid parameter',
  'invalid module', 'parameter value out of range', 'factory restore in progress'];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface KeepAliveStats {
  sent: number;
  longestGapMs: number;
  gapsOver500Ms: number;
  gapsOver1000Ms: number;
}

export class Amp {
  slot: number | null = null;
  dirty = false;
  names: string[] = [];
  document: Preset | null = null;
  documentRevision = 0;
  stored = new Map<number, { preset: Preset; text: string; revision: number }>();
  received = 0;
  keepAlive: KeepAliveStats = { sent: 0, longestGapMs: 0, gapsOver500Ms: 0, gapsOver1000Ms: 0 };

  private frames = new Frames();
  private saved: { preset: number; name: string } | null = null;
  private saveRevision = 0;
  private failure: Error | null = null;
  private commandError: Error | null = null;
  private waiters = new Set<() => void>();
  private writes: Promise<unknown> = Promise.resolve();
  private keepAliveTimer?: ReturnType<typeof setTimeout>;
  private lastKeepAlive = 0;

  constructor(private transport: BleTransport) {
    transport.onNotify((data) => this.notify(data));
    transport.onDisconnect(() => this.wake());
  }

  private wake(): void {
    for (const waiter of this.waiters) waiter();
  }

  private notify(data: Uint8Array): void {
    this.received++;
    try {
      const message = this.frames.feed(data);
      if (message && message[0] === 0x12) this.handle(message);
    } catch (error) {
      this.failure = error as Error;
    }
    this.wake();
  }

  private handle(message: Uint8Array): void {
    for (const [number, body] of fields(message)) {
      if (number !== 2 || !(body instanceof Uint8Array)) continue;
      for (const [kind, value] of fields(body)) {
        if (!(value instanceof Uint8Array)) continue;
        const content = new Map(fields(value));
        if (kind === 5) {
          this.slot = asNumber(content.get(1)) + 1;
          this.dirty = Boolean(asNumber(content.get(2)));
        } else if (kind === 4) {
          this.document = decodePreset(asBytes(content.get(1)));
          this.documentRevision++;
        } else if (kind === 10) {
          const slot = asNumber(content.get(1)) + 1;
          const compressed = asBytes(content.get(2));
          this.stored.set(slot, { preset: decodePreset(compressed), text: decodePresetText(compressed),
            revision: (this.stored.get(slot)?.revision ?? 0) + 1 });
        } else if (kind === 13) {
          this.saved = { preset: asNumber(content.get(1)) + 1,
            name: new TextDecoder().decode(asBytes(content.get(2))).trimEnd() };
          this.saveRevision++;
        } else if (kind === 17) {
          const code = asNumber(content.get(1));
          this.commandError = new Error(`The Micro Plus rejected the change: ${AMP_ERRORS[code] ?? code}`);
        } else if (kind === 12) {
          this.names = fields(value).filter(([key, name]) => key === 1 && name instanceof Uint8Array)
            .map(([, name]) => new TextDecoder().decode(name as Uint8Array).trimEnd());
        }
      }
    }
  }

  /** Waits for its turn, because a Bluetooth link handles one write at a time. */
  private sendPackets(packets: Uint8Array[]): Promise<void> {
    const sending = this.writes.catch(() => {}).then(async () => {
      for (const [index, data] of packets.entries()) {
        if (index) await sleep(PACKET_GAP_MS);
        await this.transport.write(data);
      }
    });
    this.writes = sending;
    return sending;
  }

  private command(kind: number, payload: Uint8Array): Promise<void> {
    this.commandError = null;
    return this.sendPackets(fragments(request(kind, payload)));
  }

  private waitFor(ready: () => boolean, timeoutMs = 8000): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (action: () => void) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        action();
      };
      const check = () => {
        if (this.failure) finish(() => reject(this.failure));
        else if (this.commandError) finish(() => reject(this.commandError));
        else if (ready()) finish(resolve);
        else if (!this.transport.isConnected()) finish(() => reject(new Error('Micro Plus disconnected')));
      };
      const timer = setTimeout(() => finish(() => reject(new Error('Timed out waiting for the Micro Plus'))), timeoutMs);
      this.waiters.add(check);
      check();
    });
  }

  async initialize(): Promise<void> {
    for (const data of HANDSHAKE) {
      await this.sendPackets([fromHex(data)]);
      await sleep(150);
    }
    await this.waitFor(() => this.slot !== null && this.names.length > 0);
  }

  startKeepAlive(): void {
    this.lastKeepAlive = performance.now();
    const tick = async () => {
      const now = performance.now();
      const gap = now - this.lastKeepAlive;
      this.lastKeepAlive = now;
      const stats = this.keepAlive;
      stats.sent++;
      stats.longestGapMs = Math.max(stats.longestGapMs, Math.round(gap));
      if (gap > 500) stats.gapsOver500Ms++;
      if (gap > 1000) stats.gapsOver1000Ms++;
      try {
        await this.sendPackets([KEEPALIVE]);
        this.keepAliveTimer = setTimeout(tick, KEEPALIVE_MS);
      } catch (error) {
        this.failure = error as Error;
        this.wake();
      }
    };
    this.keepAliveTimer = setTimeout(tick, KEEPALIVE_MS);
  }

  stopKeepAlive(): void {
    clearTimeout(this.keepAliveTimer);
  }

  async switchTo(slot: number): Promise<void> {
    const command = selectPreset(slot);
    this.slot = null;
    this.document = null;
    await this.sendPackets([command]);
    await this.waitFor(() => this.slot === slot);
  }

  async refreshCurrent(): Promise<Preset> {
    const revision = this.documentRevision;
    await this.command(CURRENT, wireUint(1, 1));
    await this.waitFor(() => this.documentRevision > revision);
    return this.document!;
  }

  async readPreset(slot: number): Promise<{ preset: Preset; text: string }> {
    const revision = this.stored.get(slot)?.revision ?? 0;
    await this.command(READ_PRESET, concat(wireUint(1, slot - 1), wireUint(2, 1)));
    await this.waitFor(() => (this.stored.get(slot)?.revision ?? 0) > revision);
    return this.stored.get(slot)!;
  }

  /** Writes the preset to the slot, then reads it back and checks it arrived unchanged. */
  async restorePreset(preset: Preset, slot: number): Promise<{ preset: Preset; text: string; packets: number }> {
    validatePreset(preset);
    const compressed = encodePreset(preset);
    const payload = concat(wireUint(1, slot - 1), wireBytes(2, compressed), wireUint(3, 1),
      wireString(4, preset.info.displayName.trimEnd()));
    const revision = this.saveRevision;
    const packets = fragments(request(SAVE_AS, payload)).length;
    await this.command(SAVE_AS, payload);
    await this.waitFor(() => this.saveRevision > revision && this.saved?.preset === slot);
    const actual = await this.readPreset(slot);
    if (!presetsMatch(preset, actual.preset)) throw new Error('Read-back of the written preset did not match');
    return { ...actual, packets };
  }
}
