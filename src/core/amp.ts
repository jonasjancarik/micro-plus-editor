// Talks to the amp over any BleTransport.
import { CURRENT, isPresetNumber, parameterPayload, parameterValue, READ_PARAMETER, READ_PRESET, REPLACE_NODE, SAVE_AS, SAVE_CURRENT, saveCurrentPayload, SET_PARAMETER } from './commands';
import { AmpError, InputError } from './errors';
import { fragments, Frames, request, selectPreset } from './frames';
import { decodePreset, decodePresetText, encodePreset, isClose, presetsMatch, validatePreset, type ParameterValue, type Preset } from './preset';
import { asBytes, asNumber, concat, fields, fromHex, hex, wireBytes, wireString, wireUint } from './wire';
import type { BleTransport } from '../transport/types';

// Sent back to back, the packets of a long command can get lost, and the amp then stops answering until it reconnects.
export const PACKET_GAP_MS = 30;
const KEEPALIVE_MS = 250;
const KEEPALIVE = fromHex('3500050a03c20100');
const HANDSHAKE = ['3500021a00', '3500040a023a00', '3500040a027200', '3500060a0422020801',
  '3500050a03b20100', '3500050a03ca0100', '3500041a020801'];
const AMP_ERRORS = ['unsupported command', 'operation failed', 'invalid parameter',
  'invalid module', 'parameter value out of range', 'factory restore in progress'];
// The amp doesn't always report a type for a setting at zero, and these are whole-number choices.
const INTEGER_CHOICES = new Set(['comppreset', 'mode', 'type', 'dlymodtype', 'panmodtype',
  'modshape', 'inputfiltermode', 'lfoclip', 'prefilttype', 'shape']);

const HANDLED_KINDS = new Set([4, 5, 9, 10, 12, 13, 15, 17]);
const UNKNOWN_LOGGED = 500; // Enough to see what the EQ and TAP buttons send, without filling the console.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const parameterKey = (node: string, parameter: string) => `${node}\n${parameter}`;

/** Calls back every so many milliseconds until the returned function is called. */
export type RepeatingTimer = (callback: () => void, ms: number) => () => void;

const plainTimer: RepeatingTimer = (callback, ms) => {
  const timer = setInterval(callback, ms);
  return () => clearInterval(timer);
};

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
  documentSlot: number | null = null;
  documentRevision = 0;
  stored = new Map<number, { preset: Preset; text: string; revision: number }>();
  parameters = new Map<string, ParameterValue | null>();
  parameterTypes = new Map<string, number | null>();
  parameterRevision = 0;
  saved: { preset: number; name: string } | null = null;
  saveRevision = 0;
  replaced: string | null = null;
  replaceRevision = 0;
  failure: Error | null = null;
  received = 0;
  lastWritePackets = 0;
  keepAlive: KeepAliveStats = { sent: 0, longestGapMs: 0, gapsOver500Ms: 0, gapsOver1000Ms: 0 };

  private frames = new Frames();
  commandError: Error | null = null;
  private waiters = new Set<() => void>();
  private writes: Promise<unknown> = Promise.resolve();
  private stopTimer: () => void = () => {};
  private lastKeepAlive = 0;
  private stopListening: () => void;
  private unknownSeen = new Set<string>();

  constructor(private transport: BleTransport) {
    transport.onNotify((data) => this.notify(data));
    this.stopListening = transport.onDisconnect(() => this.wake());
  }

  /** Stops listening to the transport, which outlives this connection. */
  dispose(): void {
    this.stopKeepAlive();
    this.stopListening();
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) waiter();
  }

  notify(data: Uint8Array): void {
    this.received++;
    try {
      const message = this.frames.feed(data);
      if (message && (message[0] !== 0x12 || !this.handle(message))) this.logUnknown(message);
    } catch (error) {
      this.failure = error as Error;
    }
    this.wake();
  }

  /** Each different message once, so whatever the amp's other buttons send can be worked out. */
  private logUnknown(message: Uint8Array): void {
    const text = hex(message);
    if (this.unknownSeen.has(text) || this.unknownSeen.size >= UNKNOWN_LOGGED) return;
    this.unknownSeen.add(text);
    console.info(`Micro Plus sent something the editor doesn't use: ${text}`);
  }

  /** Returns whether the message held anything the editor uses. */
  private handle(message: Uint8Array): boolean {
    let used = false;
    for (const [number, body] of fields(message)) {
      if (number !== 2 || !(body instanceof Uint8Array)) continue;
      for (const [kind, value] of fields(body)) {
        // Other kinds aren't necessarily made of fields, so they mustn't be read as if they were.
        if (!(value instanceof Uint8Array) || !HANDLED_KINDS.has(kind)) continue;
        used = true;
        const content = new Map(fields(value));
        if (kind === 5) {
          this.slot = asNumber(content.get(1)) + 1;
          this.dirty = Boolean(asNumber(content.get(2)));
        } else if (kind === 4) {
          this.document = decodePreset(asBytes(content.get(1)));
          this.documentSlot = this.slot;
          this.documentRevision++;
        } else if (kind === 10) {
          const slot = asNumber(content.get(1)) + 1;
          const compressed = asBytes(content.get(2));
          this.stored.set(slot, { preset: decodePreset(compressed), text: decodePresetText(compressed),
            revision: (this.stored.get(slot)?.revision ?? 0) + 1 });
        } else if (kind === 9) {
          const decoder = new TextDecoder();
          const node = decoder.decode(asBytes(content.get(1)));
          const parameter = decoder.decode(asBytes(content.get(2)));
          let result = parameterValue(content);
          if (result === null && this.document) {
            const old = this.getParameter(node, parameter);
            result = typeof old === 'boolean' ? false : typeof old === 'string' ? '' : 0;
          }
          // A change made on the amp itself, with its MODIFY buttons, arrives without being asked for.
          if (result !== null && this.applyReported(node, parameter, result)) this.documentRevision++;
          const key = parameterKey(node, parameter);
          this.parameters.set(key, result);
          this.parameterTypes.set(key, [3, 4, 5, 6].find((field) => content.has(field)) ?? null);
          this.parameterRevision++;
        } else if (kind === 13) {
          const preset = asNumber(content.get(1)) + 1;
          const name = new TextDecoder().decode(asBytes(content.get(2))).trimEnd();
          this.saved = { preset, name };
          this.saveRevision++;
          if (preset <= this.names.length) this.names[preset - 1] = name;
        } else if (kind === 15) {
          const decoder = new TextDecoder();
          this.replaced = parameterKey(decoder.decode(asBytes(content.get(1))), decoder.decode(asBytes(content.get(2))));
          this.replaceRevision++;
        } else if (kind === 17) {
          const code = asNumber(content.get(1));
          this.commandError = new InputError(`The Micro Plus rejected the change: ${AMP_ERRORS[code] ?? code}`);
        } else if (kind === 12) {
          this.names = fields(value).filter(([key, name]) => key === 1 && name instanceof Uint8Array)
            .map(([, name]) => new TextDecoder().decode(name as Uint8Array).trimEnd());
        }
      }
    }
    return used;
  }

  /** Waits for its turn, because a Bluetooth link handles one write at a time. */
  sendPackets(packets: Uint8Array[]): Promise<void> {
    const sending = this.writes.catch(() => {}).then(async () => {
      for (const [index, data] of packets.entries()) {
        if (index) await sleep(PACKET_GAP_MS);
        await this.transport.write(data);
      }
    });
    this.writes = sending;
    return sending;
  }

  command(kind: number, payload: Uint8Array): Promise<void> {
    this.commandError = null;
    return this.sendPackets(fragments(request(kind, payload)));
  }

  waitFor(ready: () => boolean, timeoutMs = 8000): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (action: () => void) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        action();
      };
      const check = () => {
        if (ready()) finish(resolve);
        else if (this.failure) finish(() => reject(this.failure));
        else if (this.commandError) finish(() => reject(this.commandError));
        else if (!this.transport.isConnected()) finish(() => reject(new AmpError('Micro Plus disconnected')));
      };
      const timer = setTimeout(() => finish(() => reject(new AmpError('Timed out waiting for the Micro Plus'))), timeoutMs);
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

  /** Keeps the amp answering. Calls onFailure once if the connection has gone wrong. */
  startKeepAlive(timer: RepeatingTimer = plainTimer, onFailure: () => void = () => {}): void {
    let sending = false;
    const fail = () => {
      this.stopKeepAlive();
      this.wake();
      onFailure();
    };
    this.lastKeepAlive = performance.now();
    this.stopTimer = timer(async () => {
      if (sending) return;
      if (this.failure) {
        fail();
        return;
      }
      sending = true;
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
      } catch (error) {
        this.failure = error as Error;
        fail();
      } finally {
        sending = false;
      }
    }, KEEPALIVE_MS);
  }

  stopKeepAlive(): void {
    this.stopTimer();
  }

  status(): { preset: number | null; name: string | null } {
    const slot = this.slot;
    return { preset: slot, name: slot && slot <= this.names.length ? this.names[slot - 1]! : null };
  }

  async switchTo(slot: number): Promise<void> {
    const command = selectPreset(slot);
    this.slot = null;
    this.document = null;
    this.documentSlot = null;
    await this.sendPackets([command]);
    await this.waitFor(() => this.slot === slot);
  }

  async refreshCurrent(): Promise<Preset> {
    const revision = this.documentRevision;
    await this.command(CURRENT, wireUint(1, 1));
    await this.waitFor(() => this.documentRevision > revision);
    return structuredClone(this.document!);
  }

  async readPreset(slot: number): Promise<Preset> {
    if (!isPresetNumber(slot)) throw new InputError('Choose a preset number from 1 to 100');
    const revision = this.stored.get(slot)?.revision ?? 0;
    await this.command(READ_PRESET, concat(wireUint(1, slot - 1), wireUint(2, 1)));
    await this.waitFor(() => (this.stored.get(slot)?.revision ?? 0) > revision);
    return structuredClone(this.stored.get(slot)!.preset);
  }

  /** Puts a reported value into the current preset, and says whether that changed anything. */
  private applyReported(nodeId: string, parameter: string, value: ParameterValue): boolean {
    const parameters = this.document?.audioGraph.nodes.find((node) => node.nodeId === nodeId)?.dspUnitParameters;
    const old = parameters?.[parameter];
    if (!parameters || old === undefined || typeof old !== typeof value) return false;
    if (typeof old === 'number' ? isClose(old, value as number, 1e-6, 1e-6) : old === value) return false;
    parameters[parameter] = value;
    return true;
  }

  getParameter(nodeId: string, parameter: string): ParameterValue {
    if (!this.document) throw new InputError('Read the current preset before editing');
    for (const node of this.document.audioGraph.nodes) {
      const value = node.nodeId === nodeId ? node.dspUnitParameters[parameter] : undefined;
      if (value !== undefined) return value;
    }
    throw new InputError('This parameter is not present in the selected preset');
  }

  /** Returns what the amp stored if it kept the value within its own limits, otherwise null. */
  async setParameter(nodeId: string, parameter: string, value: unknown): Promise<number | null> {
    const old = this.getParameter(nodeId, parameter);
    if (typeof old === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new InputError('Enter a finite number for this parameter');
    } else if (typeof value !== typeof old) {
      throw new InputError('Parameter value has the wrong type');
    }
    const checked = value as ParameterValue;
    // Ask the amp for the type: a whole number can be a continuous float control or a discrete choice.
    const slot = this.slot;
    const documentRevision = this.documentRevision;
    const key = parameterKey(nodeId, parameter);
    let revision = this.parameterRevision;
    this.parameters.delete(key);
    await this.command(READ_PARAMETER, concat(wireString(1, nodeId), wireString(2, parameter)));
    await this.waitFor(() => this.parameterRevision > revision && this.parameters.has(key));
    if (this.slot !== slot || this.documentRevision !== documentRevision) {
      throw new InputError('The selected preset changed. Review it before editing.');
    }
    const wireType = this.parameterTypes.get(key) ?? null;
    let kind: 'float' | 'integer' = 'float';
    if (typeof old === 'number' && (wireType === 5 || (wireType === null && INTEGER_CHOICES.has(parameter)))) {
      if (!Number.isInteger(checked)) throw new InputError('Choose a whole number for this parameter');
      kind = 'integer';
    }
    revision = this.parameterRevision;
    this.parameters.delete(key);
    await this.command(SET_PARAMETER, parameterPayload(nodeId, parameter, checked, kind));
    await this.waitFor(() => this.parameterRevision > revision && this.parameters.has(key));
    const reported = this.parameters.get(key);
    let limited = false;
    if (typeof checked === 'number') {
      // The amp keeps numbers within its own limits and reports what it stored, which isn't a failure.
      if (typeof reported !== 'number' || !Number.isFinite(reported)) throw new AmpError('The Micro Plus reported a different parameter value');
      limited = !isClose(checked, reported, 1e-5, 1e-5);
    } else if (checked !== reported) {
      throw new AmpError('The Micro Plus reported a different parameter value');
    }
    await this.refreshCurrent();
    if (!limited) return null;
    // The value differs from the one sent, so make sure the preset itself agrees before accepting it.
    const stored = this.getParameter(nodeId, parameter);
    if (typeof stored !== 'number' || !isClose(stored, reported as number, 1e-4, 1e-4)) {
      throw new AmpError('The Micro Plus reported a different parameter value');
    }
    return reported as number;
  }

  async replaceNode(nodeId: string, model: string): Promise<void> {
    const revision = this.replaceRevision;
    await this.command(REPLACE_NODE, concat(wireString(1, nodeId), wireString(2, model)));
    const expected = parameterKey(nodeId, model);
    await this.waitFor(() => this.replaceRevision > revision && this.replaced === expected);
    await this.refreshCurrent();
  }

  async saveCurrent(name: string, target: number): Promise<Preset> {
    if (!this.document) throw new InputError('Read the current preset before saving');
    const expected = structuredClone(this.document);
    const payload = saveCurrentPayload(name, target);
    expected.info.displayName = name;
    if (target !== this.slot) {
      // A copied sound gets its own identity; it must not claim the source preset's ID or factory status.
      expected.info.preset_id = crypto.randomUUID().toUpperCase();
      expected.info.is_factory_default = false;
      const stored = await this.restorePreset(expected, target);
      await this.refreshCurrent();
      return stored;
    }
    const revision = this.saveRevision;
    await this.command(SAVE_CURRENT, payload);
    await this.waitFor(() => this.saveRevision > revision && this.saved?.preset === target);
    const stored = await this.readPreset(target);
    if (!presetsMatch(expected, stored)) throw new AmpError('The saved preset does not match the requested changes');
    await this.refreshCurrent();
    return stored;
  }

  /** Writes the preset to the slot, then reads it back and checks it arrived unchanged. */
  async restorePreset(preset: Preset, slot: number): Promise<Preset> {
    validatePreset(preset);
    if (!isPresetNumber(slot)) throw new InputError('Choose a preset number from 1 to 100');
    const payload = concat(wireUint(1, slot - 1), wireBytes(2, encodePreset(preset)), wireUint(3, 1),
      wireString(4, preset.info.displayName.trimEnd()));
    const revision = this.saveRevision;
    this.lastWritePackets = fragments(request(SAVE_AS, payload)).length;
    await this.command(SAVE_AS, payload);
    await this.waitFor(() => this.saveRevision > revision && this.saved?.preset === slot);
    const actual = await this.readPreset(slot);
    if (!presetsMatch(preset, actual)) throw new AmpError('Read-back verification of the restored preset failed');
    return actual;
  }
}
