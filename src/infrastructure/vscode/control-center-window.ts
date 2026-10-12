import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { basename, isAbsolute, normalize, relative } from "node:path";
import type { ChatTemplateRenderer } from "./chat-template-renderer";
import { parseRolePoolMessage, type RolePoolMessage } from "../../protocol/role-pools";
import { readAgentDefaults } from "./agent-settings-store";
import { modelSelectionCatalog } from "../agent-factory/model-catalog";
import { parseClientMessage } from "../../protocol/validator";
import type { ClientMessage, ProjectDomainEdit, ProjectDomains, ProjectTaskEntry, TeamHistory, TeamRoster } from "../../protocol/messages";
import type { RequestView } from "../../protocol/messages";
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
export const HIDDEN_WORKERS_KEY = "agentFactory.controlCenter.hiddenWorkers";
export const DOMAIN_ORDER_KEY = "agentFactory.controlCenter.domainOrder";
export const WORKER_ORDER_KEY = "agentFactory.controlCenter.workerOrder";
type OrderStore = Pick<vscode.Memento, "get" | "update">;
/** The plugin's team records (loop.py team-*), read-only. An installed plugin without them answers "unsupported". */
export interface TeamRecords {
  roster(root: string): Promise<TeamRoster>;
  history(root: string, agentId: string): Promise<TeamHistory>;
  /** The exact run file path, or undefined when the run never wrote it. */
  runDocument(root: string, agentId: string, runId: string, document: "request" | "result" | "receipt"): Promise<string | undefined>;
  requestView?(root: string, agentId: string, runId: string): Promise<RequestView>;
  /** The same roster with its running runs' state, phase and latest activity read again (cheap; every refresh). */
  live?(root: string, roster: TeamRoster): Promise<TeamRoster>;
}
/** The roster is re-read when the task records change, on a manual refresh, or after this long without one. */
const TEAM_ROSTER_MAX_AGE_MS = 30_000;
interface Center {
  readonly panel: vscode.WebviewPanel;
  readonly subscriptions: vscode.Disposable[];
  closed: boolean;
  ready: boolean;
  refreshing: boolean;
  /** The last posted list snapshot; an identical read is not posted again (the view keeps its DOM, scroll and focus). */
  lastPosted?: string;
  /** A manual refresh always answers, even when nothing changed. */
  forcePost?: boolean;
  team?: { readonly roster: TeamRoster; readonly readAt: number; readonly basis: string };
  /** A change arrived during a read; read once more so the tab never keeps the older snapshot. */
  refreshQueued?: boolean;
  selection?: Selection;
  requestView?: RequestView;
  timer?: ReturnType<typeof setInterval>;
  /** Set once the tab received its conductor queue snapshot; feed rows are forwarded only after it. */
  conductorReady?: boolean;
}

/** The project's conductor queue as the chats see it: same runtime process, projection rows and versions. */
export interface ConductorBoardAccess {
  enabled(): boolean;
  board(root: string): Promise<Record<string, unknown>>;
  role(root: string): string;
  subscribe(listener: (root: string, line: import("../agent-factory/conductor-queue-client").ConductorQueueLine) => void): () => void;
  control(root: string, chatId: string, control: Record<string, unknown>): Promise<void>;
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
    private readonly orderStore?: OrderStore,
    private readonly team?: TeamRecords,
    private readonly conductor?: ConductorBoardAccess
  ) {
    this.conductorSubscription = conductor?.subscribe((root, line) => this.forwardConductor(root, line));
  }
  private readonly conductorSubscription?: () => void;
  /** Order saves are applied one after another so a later drop never loses to an earlier write. */
  private orderWrite: Promise<void> = Promise.resolve();
  /** One worker action at a time per project and worker: repeated clicks never start a second stop, send or removal. */
  private readonly workerActions = new Set<string>();

  public async showRequest(root: string, view: RequestView): Promise<void> {
    await this.open(root);
    const center = this.centers.get(root);
    if (!center || center.closed) return;
    center.requestView = view;
    if (center.ready) await center.panel.webview.postMessage({ type: "request.view", view });
  }

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
      const roleMessage = parseRolePoolMessage(raw);
      if (roleMessage && !center.closed) { void this.rolePoolControl(root, center, roleMessage); return; }
      const message = parseClientMessage(raw);
      if (!message || center.closed) return;
      // The center accepts only read/navigation messages, even if other valid chat messages arrive.
      if (message.type === "client.ready") {
        center.ready = true;
        void (async () => {
          // The tab keeps its project in webview state so a restored tab reopens the same project.
          await panel.webview.postMessage({ type: "control.center.project", projectRoot: root });
          if (center.selection) await panel.webview.postMessage({ type: "control.center.selection", ...center.selection });
          if (center.requestView) await panel.webview.postMessage({ type: "request.view", view: center.requestView });
          void this.conductorSync(root, center);
          await this.refresh(root, center);
        })().catch(error => this.notice(center, error));
      } else if (message.type === "project.tasks.request") { center.forcePost = true; void this.refresh(root, center, true); }
      else if (message.type === "team.history.request") void this.teamHistory(root, center, message.agentId, message.requestId);
      else if (message.type === "team.run.open") void this.openTeamRun(root, message.agentId, message.runId, message.document).catch(error => this.notice(center, error));
      else if (message.type === "project.task.open") void this.openTask(root, message).catch(error => this.notice(center, error));
      else if (message.type === "domain.create" || message.type === "domain.rename" || message.type === "domain.assign") void this.editDomain(root, center, message);
      else if (message.type === "worker.command" || message.type === "worker.stop" || message.type === "worker.remove" || message.type === "worker.handoff") void this.workerAction(root, center, message);
      else if (message.type === "supervision.request") void this.supervise(root, center);
      else if (message.type === "handoff.models.request") void this.handoffModels(root, center);
      else if (message.type === "worker.visibility") void this.saveWorkerVisibility(root, center, message.agentId, message.hidden);
      else if (message.type === "domain.order") void this.saveDisplayOrder(root, center, message.order, "domain");
      else if (message.type === "worker.order") void this.saveDisplayOrder(root, center, message.order, "worker");
      else if (message.type === "conductor.resync") void this.conductorSync(root, center);
      else if (message.type === "conductor.control") {
        const { type: _type, chatId, ...control } = message;
        if (chatId && this.conductor) void this.conductor.control(root, chatId, control).catch(error => this.notice(center, error));
      }
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

  /** Snapshot first, then live rows after its cursor; a disabled queue hides the section. */
  private async rolePoolControl(root: string, center: Center, message: RolePoolMessage): Promise<void> {
    if (!this.conductor?.enabled()) { await this.notice(center, new Error("Role pools are unavailable in this runtime")); return; }
    const key = root + ":role-pool";
    if (this.workerActions.has(key)) return;
    this.workerActions.add(key);
    try {
      let settings: Record<string, unknown> | undefined;
      if (message.action === "hire-role") {
        const profile = message.profile!;
        const defaults = readAgentDefaults(this.orderStore).project;
        const selected = defaults[profile] ?? (profile === "workLight" ? defaults.work : undefined);
        if (!selected?.model) throw new Error("Configure this role model in the existing agent settings first");
        const detected = (await modelSelectionCatalog()).candidates.find(candidate => candidate.id === selected.model);
        if (!detected) throw new Error("The selected role model is unavailable in the detected catalog");
        const board = await this.conductor.board(root);
        const pools = board.rolePools as { chats?: { id: string; policy: { sandbox?: string; approvalPolicy?: string } }[] } | undefined;
        const chat = pools?.chats?.find(entry => entry.id === message.chatId);
        if (!chat) throw new Error("Select an existing request policy before hiring");
        settings = { ...selected, provider: detected.provider, sandbox: chat.policy.sandbox, approvalPolicy: chat.policy.approvalPolicy };
      }
      const commandId = message.commandId ?? randomUUID();
      await this.conductor.control(root, message.chatId, { commandId, action: message.action, areaId: message.areaId, area: message.area, profile: message.profile, route: message.route, text: message.text, name: message.name, expectedRevision: message.expectedRevision, ...(settings ? { settings } : {}) });
      await center.panel.webview.postMessage({ type: "role.pool.result", accepted: true, commandId });
      await this.conductorSync(root, center);
    } catch (error) {
      await center.panel.webview.postMessage({ type: "role.pool.result", error: error instanceof Error ? error.message : String(error) });
    } finally { this.workerActions.delete(key); }
  }

  private async conductorSync(root: string, center: Center): Promise<void> {
    if (!this.conductor || center.closed) return;
    if (!this.conductor.enabled()) {
      center.conductorReady = false;
      await Promise.resolve(center.panel.webview.postMessage({ type: "conductor.state", enabled: false })).catch(() => false);
      return;
    }
    try {
      const snapshot = await this.conductor.board(root);
      center.conductorReady = true;
      await Promise.resolve(center.panel.webview.postMessage({ type: "conductor.state", enabled: true, role: this.conductor.role(root) })).catch(() => false);
      await Promise.resolve(center.panel.webview.postMessage({ type: "conductor.snapshot", snapshot })).catch(() => false);
    } catch (error) {
      await Promise.resolve(center.panel.webview.postMessage({ type: "conductor.state", enabled: true, role: "disconnected",
        error: error instanceof Error ? error.message : String(error) })).catch(() => false);
    }
  }

  private forwardConductor(root: string, line: import("../agent-factory/conductor-queue-client").ConductorQueueLine): void {
    const center = this.centers.get(root);
    if (!center || center.closed || !center.conductorReady) return;
    if (line.type === "feed") {
      // Every chat's state rows; chat transcript rows stay in their chats.
      const entries = line.entries.filter(entry => entry.kind === "state");
      if (entries.length) void Promise.resolve(center.panel.webview.postMessage({ type: "conductor.feed", cursor: line.cursor, entries, emittedAt: line.emittedAt })).catch(() => false);
    } else if (line.type === "role") {
      void Promise.resolve(center.panel.webview.postMessage({ type: "conductor.state", enabled: true, role: line.role, ...(line.diagnostic ? { error: line.diagnostic } : {}) })).catch(() => false);
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
  private workerOrder(root: string): string[] { return this.displayOrder(root, WORKER_ORDER_KEY); }
  private domainOrder(root: string): string[] { return this.displayOrder(root, DOMAIN_ORDER_KEY); }
  private displayOrder(root: string, key: string): string[] {
    const saved = this.orderStore?.get<Record<string, unknown>>(key)?.[root];
    return Array.isArray(saved) ? saved.filter((id, index): id is string => typeof id === "string" && saved.indexOf(id) === index) : [];
  }

  private hiddenWorkers(root: string): string[] {
    const saved = this.orderStore?.get<Record<string, unknown>>(HIDDEN_WORKERS_KEY)?.[root];
    return Array.isArray(saved) ? saved.filter((id, index): id is string => typeof id === "string" && saved.indexOf(id) === index) : [];
  }

  /** Serialized with display-order writes; each operation changes only one worker in the bound project. */
  private saveWorkerVisibility(root: string, center: Center, agentId: string, hidden: boolean): Promise<void> {
    const write = this.orderWrite.then(async () => {
      let error: string | undefined;
      try {
        if (!this.orderStore) throw new Error("Worker visibility storage is unavailable in this runtime");
        const all = this.orderStore.get<Record<string, unknown>>(HIDDEN_WORKERS_KEY);
        const ids = this.hiddenWorkers(root).filter(id => id !== agentId);
        if (hidden) ids.push(agentId);
        await this.orderStore.update(HIDDEN_WORKERS_KEY, { ...(all && typeof all === "object" && !Array.isArray(all) ? all : {}), [root]: ids });
      } catch (cause) { error = cause && typeof cause === "object" && typeof (cause as { message?: unknown }).message === "string" ? (cause as { message: string }).message : String(cause); }
      if (!center.closed) await Promise.resolve(center.panel.webview.postMessage({ type: "worker.visibility.result", hiddenWorkers: this.hiddenWorkers(root), ...(error ? { error } : {}) })).catch(() => false);
    });
    this.orderWrite = write.catch(() => undefined);
    return write;
  }

  /** Stores the order the tab sent (already validated) and returns what is now saved, or the kept order with the error. */
  private saveDisplayOrder(root: string, center: Center, order: readonly string[], kind: "worker" | "domain"): Promise<void> {
    const key = kind === "worker" ? WORKER_ORDER_KEY : DOMAIN_ORDER_KEY;
    const type = kind === "worker" ? "worker.order.result" : "domain.order.result";
    const write = this.orderWrite.then(async () => {
      let reply: Record<string, unknown>;
      try {
        if (!this.orderStore) throw new Error(kind === "worker" ? "Worker order storage is unavailable in this runtime" : "Domain order storage is unavailable in this runtime");
        const all = this.orderStore.get<Record<string, unknown>>(key);
        await this.orderStore.update(key, { ...(all && typeof all === "object" && !Array.isArray(all) ? all : {}), [root]: [...order] });
        reply = { type, order: this.displayOrder(root, key) };
      } catch (error) {
        reply = { type, order: this.displayOrder(root, key),
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
      const team = await this.readTeam(root, center, JSON.stringify([entries, domains]));
      const payload = { type: "project.tasks", entries, ...domains, ...(team ? { team } : {}), ...(this.orderStore ? { workerOrder: this.workerOrder(root), domainOrder: this.domainOrder(root), hiddenWorkers: this.hiddenWorkers(root) } : {}) };
      const serialized = JSON.stringify(payload);
      const force = center.forcePost; center.forcePost = false;
      if (center.closed) return;
      // An unchanged read only refreshes the observation time; the view keeps its rows, scroll, selection and focus.
      if (!force && serialized === center.lastPosted) { await center.panel.webview.postMessage({ type: "project.tasks.unchanged" }); return; }
      center.lastPosted = serialized;
      await center.panel.webview.postMessage(payload);
    } catch (error) {
      if (!center.closed) await Promise.resolve(center.panel.webview.postMessage({ type: "project.tasks", entries: [], error: String(error) })).catch(() => false);
    } finally {
      center.refreshing = false;
      if (center.refreshQueued && !center.closed) { center.refreshQueued = false; await this.refresh(root, center); }
    }
  }

  /**
   * The roster is read with the task records it explains; between record changes it is re-read at most every 30 seconds.
   * What its running runs are doing now is read again on every refresh, so a row follows its worker's latest activity.
   */
  private async readTeam(root: string, center: Center, basis: string): Promise<TeamRoster | undefined> {
    if (!this.team) return undefined;
    const known = center.team;
    if (known && !center.forcePost && known.basis === basis && Date.now() - known.readAt < TEAM_ROSTER_MAX_AGE_MS) {
      if (!this.team.live) return known.roster;
      const roster = await this.team.live(root, known.roster).catch(() => known.roster);
      center.team = { ...known, roster };
      return roster;
    }
    // An unsupported runtime stays unsupported until a manual refresh or a record change asks again.
    const roster = await this.team.roster(root).catch((error: unknown): TeamRoster => ({ status: "error", error: String(error) }));
    center.team = { roster, readAt: Date.now(), basis };
    return roster;
  }

  /** One worker's history; the request ID returns with it so the view can drop a reply that a newer request superseded. */
  private async teamHistory(root: string, center: Center, agentId: string, requestId: number): Promise<void> {
    const history: TeamHistory = this.team ? await this.team.history(root, agentId).catch((error: unknown): TeamHistory => ({ status: "error", agentId, error: String(error) }))
      : { status: "unsupported", agentId };
    if (!center.closed) await Promise.resolve(center.panel.webview.postMessage({ type: "team.history", requestId, history })).catch(() => false);
  }

  private async openTeamRun(root: string, agentId: string, runId: string, document: "request" | "result" | "receipt"): Promise<void> {
    const path = this.team ? await this.team.runDocument(root, agentId, runId, document) : undefined;
    if (!path) throw new Error(localize("maestro.teamDocumentMissing", document, runId));
    if (document === "request" && this.team?.requestView) {
      await this.showRequest(root, await this.team.requestView(root, agentId, runId));
      return;
    }
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(path)), { preview: true });
  }

  private async notice(center: Center, error: unknown): Promise<void> {
    if (!center.closed) await Promise.resolve(center.panel.webview.postMessage({ type: "host.notice", level: "error", text: String(error) })).catch(() => false);
  }

  /** The conductor queue setting changed: every open tab shows or hides its section accordingly. */
  public conductorChanged(): void {
    for (const [root, center] of this.centers) void this.conductorSync(root, center);
  }

  public dispose(): void {
    this.disposed = true;
    this.conductorSubscription?.();
    for (const center of [...this.centers.values()]) center.panel.dispose();
  }
}
