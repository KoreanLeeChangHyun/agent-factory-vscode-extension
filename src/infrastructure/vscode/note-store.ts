export interface Note {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly revision: number;
  readonly updatedAt: string;
}
export type NoteScope = "global" | "workspace";
interface Storage {
  keys(): readonly string[];
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
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
  public save(scope: NoteScope, input: Omit<Note, "updatedAt">): Promise<Note> {
    const operation = this.pending.then(async () => {
      const storage = this.storage(scope);
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
