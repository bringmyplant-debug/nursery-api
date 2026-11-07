/**
 * Runs `fn` repeatedly, never overlapping itself.
 *
 * `setInterval` would start the next tick while the last is still running,
 * and a slow database turns that into a pile of concurrent runs all
 * waiting on the same rows. This schedules the next run only after the
 * current one settles.
 */
export class PeriodicJob {
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  private stopped = true;

  constructor(
    private readonly fn: () => Promise<void>,
    private readonly intervalMs: number,
    private readonly onError: (error: unknown) => void,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule();
  }

  /** Stops scheduling and waits for any run already in progress. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  /** Runs once now, outside the schedule. For tests and for "do it immediately". */
  async runNow(): Promise<void> {
    await this.fn();
  }

  private schedule(): void {
    if (this.stopped) return;
    // ±10% so several replicas started together do not stay in lockstep.
    const jittered = this.intervalMs * (0.9 + Math.random() * 0.2);
    this.timer = setTimeout(() => {
      this.inFlight = this.fn()
        .catch(this.onError)
        .finally(() => {
          this.inFlight = undefined;
          this.schedule();
        });
    }, jittered);
    // Never keep a process alive just to run a background poll.
    this.timer.unref();
  }
}
