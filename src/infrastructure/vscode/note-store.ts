export interface Note {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly folder?: string;
  readonly revision: number;
  readonly updatedAt: string;
}
export type NoteScope = "global" | "workspace";
interface Storage {
  keys(): readonly string[];
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}
export function validNoteFolder(folder: unknown): folder is string {
  return typeof folder === "string" && (folder === "" || folder.split("/").every(part => Boolean(part.trim()) && part !== "." && part !== ".." && !/[\\\x00-\x1f]/.test(part)));
}
const PREFIX = "agentFactory.notes.v1.";
/** Notes are user UI data, independent of Agent sessions and conversation resets. */
export class NoteStore {
  private pending: Promise<unknown> = Promise.resolve();
  public constructor(private readonly global: Storage, private readonly workspace: Storage) {}
  public async list(scope: NoteScope): Promise<Note[]> {
    await this.pending;
    const storage = this.storage(scope);
    return storage.keys().filter(key => key.startsWith(PREFIX))
      .map(key => storage.get<Note>(key)).filter((note): note is Note => Boolean(note))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  public async folders(scope: NoteScope): Promise<string[]> {
    await this.pending;
    return this.storage(scope).get<string[]>("agentFactory.noteFolders.v1") ?? [];
  }
  public createFolder(scope: NoteScope, folder: string): Promise<void> {
    const operation = this.pending.then(async () => {
      if (!folder || !validNoteFolder(folder)) throw new Error("Invalid folder name");
      const storage = this.storage(scope);
      const folders = [...(storage.get<string[]>("agentFactory.noteFolders.v1") ?? [])];
      if (folders.includes(folder)) throw new Error("Folder already exists");
      const parts = folder.split("/");
      for (let i = 1; i <= parts.length; i++) if (!folders.includes(parts.slice(0, i).join("/"))) folders.push(parts.slice(0, i).join("/"));
      await storage.update("agentFactory.noteFolders.v1", folders);
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }
  public save(scope: NoteScope, input: Omit<Note, "updatedAt">): Promise<Note> {
    const operation = this.pending.then(async () => {
      const storage = this.storage(scope);
      if (!validNoteFolder(input.folder ?? "")) throw new Error("Invalid folder name");
      if (input.folder && !(storage.get<string[]>("agentFactory.noteFolders.v1") ?? []).includes(input.folder)) throw new Error("Folder does not exist");
      const previous = storage.get<Note>(PREFIX + input.id);
      if ((previous?.revision ?? 0) !== input.revision) throw new Error("This note changed in another chat. Save a copy to keep your edits.");
      const note = { ...input, revision: input.revision + 1, updatedAt: new Date().toISOString() };
      await storage.update(PREFIX + note.id, note);
      return note;
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }
  private storage(scope: NoteScope): Storage { return scope === "global" ? this.global : this.workspace; }
}
