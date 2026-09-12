const FRAMES = ["◜", "◝", "◞", "◟"] as const;

/** Uses plain text so the running marker also follows the active editor into the window title. */
export class RunningTitle {
  private timer: ReturnType<typeof setInterval> | undefined;
  private frame = 0;

  public constructor(
    private readonly title: () => string,
    private readonly render: (title: string) => void
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
      this.frame = (this.frame + 1) % FRAMES.length;
      this.refresh();
    }, 160);
  }

  public refresh(): void {
    this.render(`${FRAMES[this.frame]} ${this.title()}`);
  }

  public dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
