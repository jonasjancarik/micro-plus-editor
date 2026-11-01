import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import type { FileStore } from '../core/storage';

const place = (name: string) => ({ path: `micro-plus/${name}`, directory: Directory.Data });
const isMissing = (error: unknown) => /does not exist|doesn't exist|no such file/i.test(error instanceof Error ? error.message : String(error));

/** The app's own folder. Unlike a web view's storage, the system doesn't clear it to make room, and it works on older iPads. */
export class CapacitorFileStore implements FileStore {
  async read(name: string): Promise<string | null> {
    try {
      const { data } = await Filesystem.readFile({ ...place(name), encoding: Encoding.UTF8 });
      return data as string;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  private put(path: string, text: string) {
    return Filesystem.writeFile({ ...place(path), data: text, encoding: Encoding.UTF8, recursive: true });
  }

  async write(name: string, text: string): Promise<void> {
    // Replaced in one step, so a failed write leaves the old file.
    await this.put(`${name}.tmp`, text);
    await Filesystem.rename({ from: place(`${name}.tmp`).path, to: place(name).path, directory: Directory.Data, toDirectory: Directory.Data });
  }

  async create(name: string, text: string): Promise<void> {
    if (await this.read(name) !== null) throw new Error(`${name} already exists`);
    await this.put(name, text);
  }

  async setAside(name: string): Promise<void> {
    const text = await this.read(name);
    if (text === null) return;
    await this.put(`${name}.unreadable`, text);
    await Filesystem.deleteFile(place(name));
  }

  async list(folder: string): Promise<string[]> {
    try {
      const { files } = await Filesystem.readdir(place(folder));
      return files.filter((file) => file.type === 'file').map((file) => file.name);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }
}
