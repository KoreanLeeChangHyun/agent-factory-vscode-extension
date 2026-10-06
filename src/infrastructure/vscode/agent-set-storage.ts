import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

async function atomicWrite(file: string, value: string): Promise<void> {
  const temporary = `${file.replace(/\.lock\..*$/, "")}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.promises.open(temporary, "wx", 0o600);
    try { await handle.writeFile(value); await handle.sync(); }
    finally { await handle.close(); }
    await fs.promises.rename(temporary, file);
  } finally { await fs.promises.rm(temporary, {force: true}); }
}

/** A shared file is authoritative: Memento instances cache whole values per window. */
export class AgentSetStorage {
  public constructor(public readonly file: string) {}

  public read<T>(): T | undefined {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid agent set storage");
      return value as T;
    }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw cause; }
  }

  public async write(value: unknown): Promise<void> {
    await atomicWrite(this.file, JSON.stringify(value));
  }

  public async transaction<T>(action: () => Promise<T>): Promise<T> {
    await fs.promises.mkdir(path.dirname(this.file), {recursive: true});
    // Bakery tickets avoid deleting/replacing another host's lock during crash recovery.
    const prefix = `${path.basename(this.file)}.lock.`;
    const token = `${process.pid}.${randomUUID()}`;
    const lock = path.join(path.dirname(this.file), prefix + token);
    const deadline = Date.now() + 10000;
    const peers = async () => {
      const tickets: {token: string; number: number}[] = [];
      for (const name of await fs.promises.readdir(path.dirname(this.file))) {
        if (!name.startsWith(prefix)) continue;
        const peer = name.slice(prefix.length);
        const pid = Number(peer.split(".")[0]);
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid agent set storage lock owner");
        const location = path.join(path.dirname(this.file), name);
        try {
          try { process.kill(pid, 0); }
          catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "ESRCH") { await fs.promises.rm(location, {force: true}); continue; }
            if ((cause as NodeJS.ErrnoException).code !== "EPERM") throw cause;
          }
          const number = Number(await fs.promises.readFile(location, "utf8"));
          if (!Number.isSafeInteger(number) || number < 0) throw new Error("Invalid agent set storage lock");
          tickets.push({token: peer, number});
        } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
      }
      return tickets;
    };
    await fs.promises.writeFile(lock, "", {flag: "wx", mode: 0o600});
    try {
      const number = Math.max(0, ...(await peers()).map(peer => peer.number)) + 1;
      await atomicWrite(lock, String(number));
      while ((await peers()).some(peer => peer.token !== token &&
        (peer.number === 0 || peer.number < number || (peer.number === number && peer.token < token)))) {
        if (Date.now() >= deadline) throw new Error("Agent set storage is busy; please retry");
        await delay(20);
      }
      return await action();
    } finally { await fs.promises.rm(lock, {force: true}); }
  }
}
