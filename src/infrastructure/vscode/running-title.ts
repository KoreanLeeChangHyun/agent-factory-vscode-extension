const FRAME_COUNT = 6;

/** Animates the tab icon while preserving the human-readable title. */
export class RunningTitle {
  private timer: ReturnType<typeof setInterval> | undefined;
  private frame = 0;

  public constructor(
    private readonly title: () => string,
    private readonly render: (title: string, frame?: number) => void
  ) {}

  public setRunning(running: boolean): void {
    if (!running) {
      this.dispose();
      this.render(this.title());
      return;
    }
    if (this.timer) return;
    this.frame = 0;
    this.refresh();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % FRAME_COUNT;
      this.refresh();
    }, 160);
  }

  public refresh(): void {
    this.render(this.title(), this.frame);
  }

  public dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
