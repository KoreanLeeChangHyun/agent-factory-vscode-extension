import { watch, type FSWatcher } from "node:fs";

// Notifications are hints; every entry expires even if the OS loses an event.
// Entries are short lived so abandoned clients cannot retain watchers indefinitely.
export class ObservedRunCache<T> {
  private retryAt = 0;
  private readonly entries = new Map<string, { identity: unknown; value?: T; ready: boolean; expires: number; close: () => void }>();
  public constructor(private readonly now = Date.now, private readonly lifetime = 10_000, private readonly limit = 128,
    private readonly createWatcher = (path: string, onChange: () => void): FSWatcher => watch(path, { persistent: false }, onChange)) {}

  public get(key: string, identity: unknown): T | undefined {
    const entry = this.entries.get(key);
    if (entry && (entry.identity !== identity || this.now() >= entry.expires)) entry.close();
    else if (entry?.ready) return entry.value;
    return undefined;
  }

  public observe(key: string, identity: unknown, paths: readonly string[]): (value: T) => void {
    this.entries.get(key)?.close();
    if (this.now() < this.retryAt) return () => {};
    // Keep admitted entries until invalidation/expiry; eviction on every scan
    // would churn watchers when a history contains more runs than the limit.
    if (this.entries.size >= this.limit) return () => {};
    const watchers: FSWatcher[] = [];
    let timer: NodeJS.Timeout | undefined;
    let closed = false;
    const entry = { identity, value: undefined as T | undefined, ready: false, expires: this.now() + this.lifetime,
      close: () => {
        if (closed) return;
        closed = true;
        if (timer) clearTimeout(timer);
        for (const watcher of watchers) watcher.close();
        if (this.entries.get(key) === entry) this.entries.delete(key);
      } };
    const failed = () => { this.retryAt = this.now() + this.lifetime; entry.close(); };
    this.entries.set(key, entry);
    try {
      for (const path of paths) {
        const watcher = this.createWatcher(path, entry.close);
        watchers.push(watcher);
        watcher.on("error", failed);
        watcher.on("close", entry.close);
      }
      timer = setTimeout(entry.close, this.lifetime);
      timer.unref();
    } catch {
      // Unsupported or exhausted watchers fall back to the existing fresh scan.
      failed();
    }
    return value => { if (!closed) { entry.value = value; entry.ready = true; } };
  }

  public dispose(): void {
    for (const entry of this.entries.values()) entry.close();
  }
}
