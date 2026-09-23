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

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
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

/** State reports can move the thumb; only trusted gestures can send commands. */
export class VolumeSlider {
  private active = false;
  private confirmed: number | null = null;
  private pending: { value: number; id: string } | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly throttle: VolumeThrottle;
  private ignoreMouseUntil = 0;

  get interacting(): boolean {
    return this.active;
  }

  constructor(
    private readonly input: HTMLInputElement,
    send: (volume: number) => string | null,
    private readonly reveal: () => void,
    trusted: (event: Event) => boolean = (event) => event.isTrusted,
    releaseTarget: EventTarget = document,
    pointerEvents = typeof window !== "undefined" && "PointerEvent" in window,
  ) {
    input.disabled = true;
    input.value = "0";
    this.throttle = new VolumeThrottle((volume) => {
      const id = send(volume);
      if (!id) return;
      this.pending = { value: volume, id };
      if (this.pendingTimer) clearTimeout(this.pendingTimer);
      this.pendingTimer = setTimeout(() => {
        this.pending = null;
        this.refresh();
      }, 2500);
    });
    const begin = (event: Event) => {
      if (input.disabled || !trusted(event)) return;
      if (event.type === "mousedown" && Date.now() < this.ignoreMouseUntil)
        return;
      this.active = true;
      this.reveal();
    };
    const finish = (event: Event) => {
      if (!this.active || !trusted(event)) return;
      if (event.type === "touchend") this.ignoreMouseUntil = Date.now() + 600;
      this.active = false;
      this.throttle.finish(this.value());
      this.refresh();
      this.reveal();
    };
    if (pointerEvents) {
      input.addEventListener("pointerdown", begin);
      releaseTarget.addEventListener("pointerup", finish);
      releaseTarget.addEventListener("pointercancel", () => this.cancel());
    } else {
      input.addEventListener("touchstart", begin);
      input.addEventListener("mousedown", begin);
      releaseTarget.addEventListener("touchend", finish);
      releaseTarget.addEventListener("mouseup", finish);
      releaseTarget.addEventListener("touchcancel", () => this.cancel());
    }
    input.addEventListener("keydown", (event) => {
      if (
        [
          "ArrowLeft",
          "ArrowRight",
          "ArrowUp",
          "ArrowDown",
          "Home",
          "End",
          "PageUp",
          "PageDown",
        ].includes(event.key)
      )
        begin(event);
    });
    input.addEventListener("keyup", finish);
    input.addEventListener("input", (event) => {
      if (!this.active || input.disabled || !trusted(event)) return;
      this.reveal();
      this.throttle.input(this.value());
    });
    input.addEventListener("change", finish);
    input.addEventListener("blur", () => this.cancel());
  }

  receive(
    volume: number | null,
    muted: boolean | null,
    connected: boolean,
  ): void {
    if (
      !connected ||
      volume === null ||
      !Number.isFinite(volume) ||
      volume < 0 ||
      volume > 1
    ) {
      this.input.disabled = true;
      this.cancel();
      this.confirmed = null;
      this.pending = null;
      if (this.pendingTimer) clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
      this.input.value = "0";
      return;
    }
    this.confirmed = volume;
    this.input.disabled = false;
    if (this.pending && Math.abs(volume - this.pending.value) <= 0.005) {
      this.pending = null;
      if (this.pendingTimer) clearTimeout(this.pendingTimer);
    }
    this.input.parentElement?.classList.toggle("muted", muted === true);
    this.refresh();
  }

  acknowledge(id: string, delivered: boolean): void {
    if (this.pending?.id !== id || delivered) return;
    this.pending = null;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.refresh();
  }

  private value(): number {
    return Number(this.input.value) / 100;
  }

  private refresh(): void {
    if (this.active || this.pending || this.confirmed === null) return;
    const value = Math.round(this.confirmed * 100);
    this.input.value = String(value);
    this.input.setAttribute("aria-valuetext", value + "%");
  }

  private cancel(): void {
    if (!this.active) return;
    this.active = false;
    this.throttle.cancel();
    this.refresh();
  }
}
