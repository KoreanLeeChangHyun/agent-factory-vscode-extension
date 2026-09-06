/** Shares in-flight work and briefly retains successful results. */
export class AsyncCache<T> {
  private readonly entries = new Map<string, { expires: number; promise: Promise<T> }>();

  public constructor(
    private readonly ttlMs: number,
    private readonly capacity = 32,
    private readonly now: () => number = Date.now
  ) {}

  public get(key: string, load: () => Promise<T>, retain: (value: T) => boolean = () => true): Promise<T> {
    const previous = this.entries.get(key);
    if (previous && previous.expires > this.now()) return previous.promise;
    const entry = { expires: Infinity, promise: undefined as unknown as Promise<T> };
    const remove = () => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    };
    entry.promise = Promise.resolve().then(load).then((value) => {
      if (retain(value)) entry.expires = this.now() + this.ttlMs;
      else remove();
      return value;
    }, (error) => {
      remove();
      throw error;
    });
    this.entries.delete(key);
    this.entries.set(key, entry);
    if (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
    return entry.promise;
  }
}
