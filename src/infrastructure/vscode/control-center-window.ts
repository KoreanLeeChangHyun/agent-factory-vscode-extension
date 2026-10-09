import * as vscode from "vscode";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { ChatTemplateRenderer } from "./chat-template-renderer";
import { parseClientMessage } from "../../protocol/validator";
import type { ClientMessage, ProjectTaskEntry } from "../../protocol/messages";
import { localize } from "../../common/localization";

export const CONTROL_CENTER_VIEW_TYPE = "agentFactory.controlCenter";
export const MOVE_TO_WINDOW = "workbench.action.moveEditorToNewWindow";
type Selection = { readonly workflowId: string; readonly taskId: string };
type TaskAction = Extract<ClientMessage, { type: "project.task.open" }>;
interface Center {
  readonly panel: vscode.WebviewPanel;
  readonly subscriptions: vscode.Disposable[];
  closed: boolean;
  ready: boolean;
  refreshing: boolean;
  selection?: Selection;
  timer?: ReturnType<typeof setInterval>;
}

/** A project view only: it has no session/controller and cannot submit or cancel runs. */
export class ControlCenterWindows implements vscode.Disposable {
  private readonly centers = new Map<string, Center>();
  private readonly opening = new Map<string, Promise<void>>();
  private disposed = false;
  public constructor(
    private readonly templates: ChatTemplateRenderer,
    private readonly readTasks: (root: string) => Promise<readonly ProjectTaskEntry[]>,
    private readonly openTask: (root: string, action: TaskAction) => Promise<void>
  ) {}

  public async open(root: string, selection?: Selection): Promise<void> {
    if (this.disposed) return;
    const pending = this.opening.get(root);
    if (pending) { await pending; if (!this.disposed) await this.open(root, selection); return; }
    const existing = this.centers.get(root);
    if (existing && !existing.closed) {
      existing.panel.reveal(undefined, false);
      if (selection) existing.selection = selection;
      if (existing.ready && selection) await existing.panel.webview.postMessage({ type: "control.center.selection", ...selection });
      await this.refresh(root, existing);
      return;
    }
    const operation = this.create(root, selection);
    this.opening.set(root, operation);
    try { await operation; } finally { this.opening.delete(root); }
  }

  private async create(root: string, selection?: Selection): Promise<void> {
    const commands = await vscode.commands.getCommands(true);
    if (vscode.env.uiKind === vscode.UIKind.Web || !commands.includes(MOVE_TO_WINDOW)) {
      throw new Error(localize("center.window.unavailable"));
    }
    if (this.disposed) return;
    const suffix = createHash("sha256").update(root).digest("hex").slice(0, 16);
    const panel = vscode.window.createWebviewPanel(`${CONTROL_CENTER_VIEW_TYPE}.${suffix}`,
      `${localize("maestro.center")} · ${basename(root)}`, vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [...this.templates.localResourceRoots] });
    const center: Center = { panel, subscriptions: [], closed: false, ready: false, refreshing: false, selection };
    this.centers.set(root, center);
    center.subscriptions.push(panel.onDidDispose(() => {
      center.closed = true;
      if (center.timer) clearInterval(center.timer);
      for (const subscription of center.subscriptions) subscription.dispose();
      if (this.centers.get(root) === center) this.centers.delete(root);
    }));
    center.subscriptions.push(panel.webview.onDidReceiveMessage(raw => {
      const message = parseClientMessage(raw);
      if (!message || center.closed) return;
      // The center accepts only read/navigation messages, even if other valid chat messages arrive.
      if (message.type === "client.ready") {
        center.ready = true;
        void (async () => {
          if (center.selection) await panel.webview.postMessage({ type: "control.center.selection", ...center.selection });
          await this.refresh(root, center);
        })().catch(error => this.notice(center, error));
      } else if (message.type === "project.tasks.request") void this.refresh(root, center);
      else if (message.type === "project.task.open") void this.openTask(root, message).catch(error => this.notice(center, error));
    }));
    try {
      panel.webview.html = await this.templates.render(panel.webview, "control-center.html");
      if (center.closed) return;
      // reveal is asynchronous across the Extension Host boundary. Wait for this exact panel,
      // then check it again before invoking the host's active-editor window command.
      await this.activate(center);
      if (center.closed) return;
      if (!panel.active) throw new Error(localize("center.window.focus"));
      await vscode.commands.executeCommand(MOVE_TO_WINDOW);
      if (!center.closed) {
        center.timer = setInterval(() => { void this.refresh(root, center); }, 5_000);
        center.timer.unref?.();
      }
    } catch (error) {
      panel.dispose();
      throw error;
    }
  }

  private async activate(center: Center): Promise<void> {
    if (center.panel.active) return;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => { clearTimeout(timer); changed.dispose(); closed.dispose(); error ? reject(error) : resolve(); };
      const changed = center.panel.onDidChangeViewState(event => { if (event.webviewPanel.active) finish(); });
      const closed = center.panel.onDidDispose(() => finish());
      const timer = setTimeout(() => finish(new Error(localize("center.window.focus"))), 5_000);
      center.panel.reveal(undefined, false);
    });
  }

  private async refresh(root: string, center: Center): Promise<void> {
    if (center.closed || !center.ready || center.refreshing) return;
    center.refreshing = true;
    try {
      const entries = await this.readTasks(root);
      if (!center.closed) await center.panel.webview.postMessage({ type: "project.tasks", entries });
    } catch (error) {
      if (!center.closed) await Promise.resolve(center.panel.webview.postMessage({ type: "project.tasks", entries: [], error: String(error) })).catch(() => false);
    } finally { center.refreshing = false; }
  }

  private async notice(center: Center, error: unknown): Promise<void> {
    if (!center.closed) await Promise.resolve(center.panel.webview.postMessage({ type: "host.notice", level: "error", text: String(error) })).catch(() => false);
  }

  public dispose(): void {
    this.disposed = true;
    for (const center of [...this.centers.values()]) center.panel.dispose();
  }
}
