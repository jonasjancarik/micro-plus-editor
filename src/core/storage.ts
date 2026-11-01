// Where groups, the compare list and preset backups are kept on the device.

/** Text files by name. A name can contain folders, such as "backups/one.json". */
export interface FileStore {
  /** Returns null if there is no such file. */
  read(name: string): Promise<string | null>;
  /** Replaces the file as a whole, so a failed write leaves the old one. */
  write(name: string, text: string): Promise<void>;
  /** Writes a new file and fails if one already has this name. */
  create(name: string, text: string): Promise<void>;
  /** Keeps a file that couldn't be understood, under a name that won't be read again. */
  setAside(name: string): Promise<void>;
}

export class MemoryStore implements FileStore {
  files = new Map<string, string>();

  async read(name: string): Promise<string | null> {
    return this.files.get(name) ?? null;
  }

  async write(name: string, text: string): Promise<void> {
    this.files.set(name, text);
  }

  async create(name: string, text: string): Promise<void> {
    if (this.files.has(name)) throw new Error(`${name} already exists`);
    this.files.set(name, text);
  }

  async setAside(name: string): Promise<void> {
    const text = this.files.get(name);
    if (text === undefined) return;
    this.files.set(`${name}.unreadable`, text);
    this.files.delete(name);
  }
}

const isMissing = (error: unknown) => error instanceof DOMException && error.name === 'NotFoundError';

/** The browser's private storage for this site, which also works inside the phone app. */
export class OpfsStore implements FileStore {
  private constructor(private root: FileSystemDirectoryHandle) {}

  static async open(): Promise<OpfsStore> {
    // Without this a browser may clear the files when it runs short of space. It can say no, and then they still work.
    await navigator.storage.persist?.().catch(() => false);
    return new OpfsStore(await navigator.storage.getDirectory());
  }

  private async file(name: string, create: boolean): Promise<FileSystemFileHandle> {
    const parts = name.split('/');
    const file = parts.pop()!;
    let folder = this.root;
    for (const part of parts) folder = await folder.getDirectoryHandle(part, { create });
    return folder.getFileHandle(file, { create });
  }

  async read(name: string): Promise<string | null> {
    try {
      return await (await (await this.file(name, false)).getFile()).text();
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async write(name: string, text: string): Promise<void> {
    // The browser only replaces the file when this closes.
    const stream = await (await this.file(name, true)).createWritable();
    await stream.write(text);
    await stream.close();
  }

  async create(name: string, text: string): Promise<void> {
    if (await this.read(name) !== null) throw new Error(`${name} already exists`);
    await this.write(name, text);
  }

  async setAside(name: string): Promise<void> {
    const text = await this.read(name);
    if (text === null) return;
    await this.write(`${name}.unreadable`, text);
    const parts = name.split('/');
    const file = parts.pop()!;
    let folder = this.root;
    for (const part of parts) folder = await folder.getDirectoryHandle(part);
    await folder.removeEntry(file);
  }
}
