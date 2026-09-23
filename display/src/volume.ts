/** Keep drag traffic bounded; the final thumb value is sent at release. */
export class VolumeThrottle {
  private lastSent = -Infinity;
  private lastValue: number | null = null;
  private pending: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly send: (value: number) => void,
    private readonly now: () => number = Date.now,
    private readonly intervalMs = 150,
  ) {}

  input(value: number): void {
    if (!Number.isFinite(value)) return;
    this.pending = Math.max(0, Math.min(1, value));
    if (this.now() - this.lastSent >= this.intervalMs) this.flush();
    else if (!this.timer)
      this.timer = setTimeout(
        () => this.flush(),
        this.intervalMs - (this.now() - this.lastSent),
      );
  }

  finish(value: number): void {
    if (!Number.isFinite(value)) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = Math.max(0, Math.min(1, value));
    if (
      this.lastValue !== this.pending ||
      this.now() - this.lastSent >= this.intervalMs
    )
      this.flush();
    else this.pending = null; // input already delivered this exact final value
  }

  private flush(): void {
    this.timer = null;
    if (this.pending === null) return;
    const value = this.pending;
    this.pending = null;
    this.lastSent = this.now();
    this.lastValue = value;
    this.send(value);
  }
}
