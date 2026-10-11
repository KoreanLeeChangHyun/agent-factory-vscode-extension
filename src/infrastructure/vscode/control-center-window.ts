import * as vscode from "vscode";
import { basename, isAbsolute, normalize, relative } from "node:path";
import type { ChatTemplateRenderer } from "./chat-template-renderer";
import { parseClientMessage } from "../../protocol/validator";
import type { ClientMessage, ProjectDomainEdit, ProjectDomains, ProjectTaskEntry } from "../../protocol/messages";
import { localize } from "../../common/localization";

/** One fixed type so VS Code can restore the tab through a registered serializer; the project is bound in webview state. */
export const CONTROL_CENTER_VIEW_TYPE = "agentFactory.controlCenter";

/**
 * Project root of a restored tab. VS Code restores only tabs that were still open, so a tab the user closed never
 * reaches this point. The saved root must lie in a current workspace folder; an older state without a root is
 * bound only when the workspace has exactly one folder. Anything else is not guessed: the caller closes the tab.
 */
export function restoredControlCenterRoot(state: unknown, folders: readonly string[]): string | undefined {
  const saved = state && typeof state === "object" ? (state as Record<string, unknown>).projectRoot : undefined;
  if (saved === undefined) return folders.length === 1 ? folders[0] : undefined;
  if (typeof saved !== "string" || saved.length > 4096 || !isAbsolute(saved)) return undefined;
  const root = normalize(saved).replace(/(?<=.)[\\/]+$/, "");
  return folders.some(folder => {
    const path = relative(normalize(folder), root);
    return path === "" || (!path.startsWith("..") && !isAbsolute(path));
  }) ? root : undefined;
}
type Selection = { readonly workflowId: string; readonly taskId: string };
type TaskAction = Extract<ClientMessage, { type: "project.task.open" }>;
type WorkerAction = Extract<ClientMessage, { type: "worker.command" | "worker.stop" | "worker.remove" | "worker.handoff" }>;
/** Host operations behind the worker actions; each re-checks the exact project, worker, loop and run. */
export interface WorkerControl {
  command(root: string, action: Extract<WorkerAction, { type: "worker.command" }>): Promise<unknown>;
  stop(root: string, action: Extract<WorkerAction, { type: "worker.stop" }>): Promise<unknown>;
  remove(root: string, action: Extract<WorkerAction, { type: "worker.remove" }>): Promise<unknown>;
  handoff?(root: string, action: Extract<WorkerAction, { type: "worker.handoff" }>, reference: string): Promise<unknown>;
  /** Read-only supervision verdicts of the project's unfinished loops. */
  supervise?(root: string): Promise<unknown>;
  /** Detected models a handoff may target. */
  models?(root: string): Promise<readonly { readonly id: string; readonly provider: string }[]>;
}
/** Where the control center keeps each project's worker display order (VS Code storage, never the project's records). */
export const WORKER_ORDER_KEY = "agentFactory.controlCenter.workerOrder";
type OrderStore = Pick<vscode.Memento, "get" | "update">;
interface Center {
  readonly panel: vscode.WebviewPanel;
  readonly subscriptions: vscode.Disposable[];
  closed: boolean;
  ready: boolean;
  refreshing: boolean;
  /** A change arrived during a read; read once more so the tab never keeps the older snapshot. */
  refreshQueued?: boolean;
  selection?: Selection;
  timer?: ReturnType<typeof setInterval>;
}

/** A project editor tab only: it has no session/controller and cannot submit or cancel runs. */
export class ControlCenterWindows implements vscode.Disposable {
  private readonly centers = new Map<string, Center>();
  private readonly opening = new Map<string, Promise<void>>();
  private disposed = false;
  public constructor(
    private readonly templates: ChatTemplateRenderer,
    private readonly readTasks: (root: string) => Promise<readonly ProjectTaskEntry[]>,
    private readonly openTask: (root: string, action: TaskAction) => Promise<void>,
    private readonly readDomains: (root: string) => Promise<ProjectDomains | undefined> = async () => undefined,
    private readonly editDomains?: (root: string, edit: ProjectDomainEdit) => Promise<ProjectDomains>,
    private readonly workers?: WorkerControl,
    private readonly orderStore?: OrderStore
  ) {}
  /** Order saves are applied one after another so a later drop never loses to an earlier write. */
  private orderWrite: Promise<void> = Promise.resolve();
  /** One worker action at a time per project and worker: repeated clicks never start a second stop, send or removal. */
  private readonly workerActions = new Set<string>();

  /** Bind a tab VS Code restored after reload/restart. A duplicate of an already open project tab is closed. */
  public async revive(root: string, panel: vscode.WebviewPanel): Promise<void> {
    if (this.disposed) { panel.dispose(); return; }
    const pending = this.opening.get(root);
    if (pending) await pending.catch(() => undefined);
    const existing = this.centers.get(root);
    if (this.disposed || (existing && !existing.closed)) { panel.dispose(); return; }
    const operation = this.attach(root, panel);
    this.opening.set(root, operation);
    try { await operation; } finally { if (this.opening.get(root) === operation) this.opening.delete(root); }
  }

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
    try { await operation; } finally { if (this.opening.get(root) === operation) this.opening.delete(root); }
  }

  private async create(root: string, selection?: Selection): Promise<void> {
    if (this.disposed) return;
    const panel = vscode.window.createWebviewPanel(CONTROL_CENTER_VIEW_TYPE,
      `${localize("maestro.center")} · ${basename(root)}`, vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [...this.templates.localResourceRoots] });
    await this.attach(root, panel, selection);
  }

  private async attach(root: string, panel: vscode.WebviewPanel, selection?: Selection): Promise<void> {
    panel.title = `${localize("maestro.center")} · ${basename(root)}`;
    panel.webview.options = { enableScripts: true, localResourceRoots: [...this.templates.localResourceRoots] };
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
          // The tab keeps its project in webview state so a restored tab reopens the same project.
          await panel.webview.postMessage({ type: "control.center.project", projectRoot: root });
          if (center.selection) await panel.webview.postMessage({ type: "control.center.selection", ...center.selection });
          await this.refresh(root, center);
        })().catch(error => this.notice(center, error));
      } else if (message.type === "project.tasks.request") void this.refresh(root, center);
      else if (message.type === "project.task.open") void this.openTask(root, message).catch(error => this.notice(center, error));
      else if (message.type === "domain.create" || message.type === "domain.rename" || message.type === "domain.assign") void this.editDomain(root, center, message);
      else if (message.type === "worker.command" || message.type === "worker.stop" || message.type === "worker.remove" || message.type === "worker.handoff") void this.workerAction(root, center, message);
      else if (message.type === "supervision.request") void this.supervise(root, center);
      else if (message.type === "handoff.models.request") void this.handoffModels(root, center);
      else if (message.type === "worker.order") void this.saveWorkerOrder(root, center, message.order);
    }));
    try {
      panel.webview.html = await this.templates.render(panel.webview, "control-center.html");
      if (center.closed) return;
      if (!center.closed) {
        center.timer = setInterval(() => { void this.refresh(root, center); }, 5_000);
        center.timer.unref?.();
      }
    } catch (error) {
      panel.dispose();
      throw error;
    }
  }

  /** One edit at a time per tab; the result (or the plugin's error code) returns to the editing field, then all tabs refresh. */
  private async editDomain(root: string, center: Center, edit: ProjectDomainEdit): Promise<void> {
    let result: Record<string, unknown>;
    try {
      if (!this.editDomains) throw Object.assign(new Error("Project domains are unavailable in this runtime"), { code: "domains_unavailable" });
      const updated = await this.editDomains(root, edit);
      result = { type: "domain.result", edit: edit.type, ...(updated.changedDomainId ? { domainId: updated.changedDomainId } : {}) };
    } catch (error) {
      const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "";
      const message = error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error);
      result = { type: "domain.result", edit: edit.type, error: message, code };
    }
    if (!center.closed) await Promise.resolve(center.panel.webview.postMessage(result)).catch(() => false);
    const same = this.centers.get(root);
    if (same && !same.closed) await this.refresh(root, same, true);
  }

  private async workerAction(root: string, center: Center, action: WorkerAction): Promise<void> {
    const key = root + "\0" + action.agentId;
    const reply = (fields: Record<string, unknown>) => center.closed ? undefined
      : Promise.resolve(center.panel.webview.postMessage({ type: "worker.result", action: action.type, agentId: action.agentId,
        ...(action.type === "worker.command" ? { commandId: action.commandId } : {}), ...fields })).catch(() => false);
    if (this.workerActions.has(key)) { await reply({ error: localize("maestro.workerBusy"), code: "worker_action_pending" }); return; }
    this.workerActions.add(key);
    try {
      if (!this.workers) throw Object.assign(new Error("Worker control is unavailable in this runtime"), { code: "worker_control_unavailable" });
      // Stopping and removing change real records, so the Human confirms the exact worker and task first.
      if (action.type !== "worker.command") {
        const prompt = action.type === "worker.stop" ? localize("maestro.confirmStop", action.agentId, action.taskId)
          : action.type === "worker.handoff" ? localize("maestro.confirmHandoff", action.agentId, action.loopId, action.toModel) : localize("maestro.confirmRemove", action.agentId);
        const accept = localize(action.type === "worker.stop" ? "maestro.forceStop" : action.type === "worker.handoff" ? "maestro.providerSwitch" : "maestro.removeWorker");
        if (await vscode.window.showWarningMessage(prompt, { modal: true }, accept) !== accept) { await reply({ cancelled: true }); return; }
      }
      let result: unknown;
      if (action.type === "worker.command") result = await this.workers.command(root, action);
      else if (action.type === "worker.stop") result = await this.workers.stop(root, action);
      else if (action.type === "worker.remove") result = await this.workers.remove(root, action);
      else {
        if (!this.workers.handoff) throw Object.assign(new Error("Provider handoff is unavailable in this runtime"), { code: "worker_control_unavailable" });
        // The Human's click in this tab is the authorization; the reference names the exact screen action.
        result = await this.workers.handoff(root, action, `control-center:${action.agentId}:${action.loopId}:handoff:${Date.now()}`);
      }
      await reply({ result });
    } catch (error) {
      const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "";
      await reply({ error: error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error), code });
    } finally {
      this.workerActions.delete(key);
      const same = this.centers.get(root);
      if (same && !same.closed) await this.refresh(root, same, true);
    }
  }

  /** Supervision is read on request only; a failure returns to the tab as a display error. */
  private async supervise(root: string, center: Center): Promise<void> {
    let message: Record<string, unknown>;
    try {
      if (!this.workers?.supervise) throw new Error("Supervision is unavailable in this runtime");
      message = { type: "supervision.report", report: await this.workers.supervise(root) };
    } catch (error) {
      message = { type: "supervision.report", error: error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error) };
    }
    if (!center.closed) await Promise.resolve(center.panel.webview.postMessage(message)).catch(() => false);
  }

  private async handoffModels(root: string, center: Center): Promise<void> {
    let message: Record<string, unknown>;
    try {
      message = { type: "handoff.models", models: this.workers?.models ? await this.workers.models(root) : [] };
    } catch (error) { message = { type: "handoff.models", models: [], error: String(error) }; }
    if (!center.closed) await Promise.resolve(center.panel.webview.postMessage(message)).catch(() => false);
  }

  /** Saved display order of one project's workers; anything malformed reads as no saved order. */
  private workerOrder(root: string): string[] {
    const saved = this.orderStore?.get<Record<string, unknown>>(WORKER_ORDER_KEY)?.[root];
    return Array.isArray(saved) ? saved.filter((id, index): id is string => typeof id === "string" && saved.indexOf(id) === index) : [];
  }

  /** Stores the order the tab sent (already validated) and returns what is now saved, or the kept order with the error. */
  private saveWorkerOrder(root: string, center: Center, order: readonly string[]): Promise<void> {
    const write = this.orderWrite.then(async () => {
      let reply: Record<string, unknown>;
      try {
        if (!this.orderStore) throw new Error("Worker order storage is unavailable in this runtime");
        const all = this.orderStore.get<Record<string, unknown>>(WORKER_ORDER_KEY);
        await this.orderStore.update(WORKER_ORDER_KEY, { ...(all && typeof all === "object" && !Array.isArray(all) ? all : {}), [root]: [...order] });
        reply = { type: "worker.order.result", order: this.workerOrder(root) };
      } catch (error) {
        reply = { type: "worker.order.result", order: this.workerOrder(root),
          error: error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error) };
      }
      if (!center.closed) await Promise.resolve(center.panel.webview.postMessage(reply)).catch(() => false);
    });
    this.orderWrite = write.catch(() => undefined);
    return write;
  }

  private async refresh(root: string, center: Center, changed = false): Promise<void> {
    if (center.refreshing && changed) center.refreshQueued = true;
    if (center.closed || !center.ready || center.refreshing) return;
    center.refreshing = true;
    try {
      const entries = await this.readTasks(root);
      // Domains are optional display data: a failed read keeps the task list and reports the domain error separately.
      const domains = await this.readDomains(root).then(value => ({ domains: value }), (error: unknown) => ({ domainsError: String(error) }));
      if (!center.closed) await center.panel.webview.postMessage({ type: "project.tasks", entries, ...domains, ...(this.orderStore ? { workerOrder: this.workerOrder(root) } : {}) });
    } catch (error) {
      if (!center.closed) await Promise.resolve(center.panel.webview.postMessage({ type: "project.tasks", entries: [], error: String(error) })).catch(() => false);
    } finally {
      center.refreshing = false;
      if (center.refreshQueued && !center.closed) { center.refreshQueued = false; await this.refresh(root, center); }
    }
  }

  private async notice(center: Center, error: unknown): Promise<void> {
    if (!center.closed) await Promise.resolve(center.panel.webview.postMessage({ type: "host.notice", level: "error", text: String(error) })).catch(() => false);
  }

  public dispose(): void {
    this.disposed = true;
    for (const center of [...this.centers.values()]) center.panel.dispose();
  }
}
