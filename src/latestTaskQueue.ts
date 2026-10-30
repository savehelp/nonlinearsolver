/** Serialize expensive asynchronous work while retaining only the latest queued
 * input. Intermediate plot frames can be discarded without delaying the final
 * frame or retaining every sweep snapshot. */
export class LatestTaskQueue<T> {
  private pending: { value: T } | undefined;
  private running = false;

  constructor(private perform: (value: T) => Promise<unknown>, private onIdle: () => void = () => {},
    private onError: (error: unknown) => void = error => console.error(error)) {}

  get busy(): boolean { return this.running; }

  submit(value: T): void {
    this.pending = { value };
    if (!this.running) void this.drain();
  }

  clear(): void { this.pending = undefined; }

  private async drain(): Promise<void> {
    this.running = true;
    while (this.pending) {
      const { value } = this.pending; this.pending = undefined;
      try { await this.perform(value); }
      catch (error) { this.onError(error); }
    }
    this.running = false;
    this.onIdle();
  }
}
