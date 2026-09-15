export class PerKeyLock {
  private readonly pending = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => held);
    this.pending.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.pending.get(key) === tail) this.pending.delete(key);
    }
  }
}
