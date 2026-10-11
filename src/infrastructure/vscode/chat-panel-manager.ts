import { normalizeGeneralSettings, shouldNotify, type GeneralSettings, type NotificationKind } from "../../common/types/general-settings";
import type { AgentDefaults } from "../../core/config/agent-settings";
import { DOCS_AUDIT_INTERVALS, docsAuditDue, type DocsAuditInterval } from "../../common/types/docs-audit";
import { BOT_DEFAULT_PROMPTS, resolveBotPrompt } from "../../modules/chat/bot-prompts";
import { isBotModel } from "../../modules/chat/bot-model";
import { localCompanionAvailable } from "../../modules/chat/bot-build-policy";
import { restoreCompanion, interactCompanion } from "../../modules/chat/companion";
import { workUnitContextText, workUnitBranch } from "./work-unit-context";
import { unitGit, validateUnitBranch, directBranchEvidence } from "./work-unit-git";
import { ControlCenterWindows, restoredControlCenterRoot } from "./control-center-window";
import { openContractPanel } from "./contract-panel";
import { listContracts } from "../filesystem/contracts";
import { readAgentDefaults, updateAgentPresetField, updateAgentPresetFastMode, useAgentPreset, ensureAgentPresets, watchAgentSets } from "./agent-settings-store";
import { readMarkdownImage } from "./markdown-image";
import { localize, describeLocalizedMessage } from "../../common/localization";
import { LunaBot, type BotContext, type BotMessage } from "../codex/luna-bot";
import { taskExecution } from "../../modules/chat/task-selection";
import { homedir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readCliTheme } from "../agent-factory/cli-theme";
import { randomUUID, createHash } from "node:crypto";
import { constants as fsConstants, existsSync } from "node:fs";
import { open as openFile, realpath, stat, unlink } from "node:fs/promises";
import { readGitBranch } from "./git-branch";
import { NoteStore } from "./note-store";
import { RunningTitle, shouldShowTabLoading } from "./running-title";
import { prepareTabIcons } from "./tab-icons";
import * as vscode from "vscode";
import type { StatusItemId } from "../../core/config/types";
import type { AttachmentReference } from "../../common/types/attachment";
import { canStageImage, decodeBrowserImage, hasImageSignature } from "../../common/image-input";
import {
  createDraftChatState,
  restoreChatState,
  type ChatPanelState,
  type CapturedAgentRun,
  type ComposerPreferences
} from "../../modules/chat/chat-state";
import type { AccountUsage, HostMessage } from "../../protocol/messages";
import { DISPATCH_ID } from "../../common/types/agent-runtime";
import { parseClientMessage } from "../../protocol/validator";
import type { ChatTemplateRenderer } from "./chat-template-renderer";
import type { AccountLimits, AgentRuntimeClient } from "../agent-factory/agent-client";
import { modelSelectionCatalog, readProviderModels } from "../agent-factory/model-catalog";
import { readAntigravityUsage } from "../agent-factory/antigravity-usage";
import { isProviderDetected, providerStatuses, type ProviderId } from "../agent-factory/provider-detection";
import { installProviderCliVersion } from "../agent-factory/provider-cli-installer";
import { readProviderVersionCatalog } from "../agent-factory/provider-version-catalog";
import { redetectProviders, saveProviderPath, pluginUpdateMode, savePluginUpdateMode, updateProviderPlugins, providerVersions, refreshProviderVersions } from "./provider-settings";
import { ChatSessionController } from "../../modules/chat/session-controller";
import { saveConvertedImage } from "./converted-image-store";
import { writeNewImageAttachment } from "./image-attachment-store";
import { SudoBroker } from "./sudo-broker";
import { DeployError, deployRunStatus, detectDeployTarget, dispatchDeploy, setupDeploySecret, type DeployTarget } from "../github/deploy-workflows";

type RuntimeConnection =
  | { readonly available: true; readonly client: AgentRuntimeClient; readonly projectRoot?: string }
  | { readonly available: false; readonly diagnostic: string };

function modelProvider(model: string | undefined): "codex" | "claude" | "antigravity" | undefined {
  if (!model) return undefined;
  if (model.startsWith("antigravity/") || model.startsWith("gemini-")) return "antigravity";
  return model.startsWith("claude-") ? "claude" : "codex";
}

interface ManagedPanel {
  composerReady?: boolean;
  composerReferences?: string[];
  notificationKeys?: Set<string>;
  notificationRunId?: string;
  initialPrompt?: string;
  contractWorkflows?: readonly Record<string, unknown>[];
  readonly panel: vscode.WebviewPanel;
  state: ChatPanelState;
  readonly subscriptions: vscode.Disposable[];
  readonly imageAttachments: Map<string, number>;
  imageMutation: Promise<void>;
  convertedImages?: Map<string, string>;
  imageConversions?: Map<string, { root: string; name: string; mediaType: string }>;
  chatSendPreparation: Promise<void>;
  pendingMessageIds?: Set<string>;
  startedMessages?: Extract<HostMessage, { type: "chat.started" }>[];
  controller?: ChatSessionController;
  runtimeClient?: AgentRuntimeClient;
  controllerInitialization?: Promise<void>;
  queueResumeInFlight?: boolean;
  sessionTransition?: Promise<void>;
  worktree?: import("../agent-factory/agent-client").ConversationWorktree;
  deployTarget?: { readonly root: string; readonly target: DeployTarget };
  deployPolling?: boolean;
  disposed?: boolean;
  executionModeExplicit?: boolean;
  executionMode?: import("../agent-factory/agent-client").ExecutionMode;
  themeRevision?: number;
  themeSignature?: string;
  themeReady?: boolean;
  themeTimer?: NodeJS.Timeout;
  agentRefreshTimer?: NodeJS.Timeout;
  lastAgentRefreshAt?: number;
  agentRefreshInFlight?: boolean;
  activeChildRuns?: readonly { readonly status: string }[];
  backgroundContinuation?: boolean;
  branchRefreshTimer?: NodeJS.Timeout;
  branchRefreshStarted?: boolean;
  runningTitle?: RunningTitle;
  lunaBot?: LunaBot;
  botContext?: BotContext;
}

const GENERAL_SETTINGS_KEY = "agentFactory.general.v1";
const LAST_CHAT_KEY = "agentFactory.mainChat.lastPanel";
const DELETED_PANELS_KEY = "agentFactory.mainChat.deletedPanels";
const COMPOSER_PREFERENCES_KEY = "agentFactory.mainChat.composerPreferences";
// Per project (workspaceState): the Human's Work isolation toggle, off by default.
const WORK_ISOLATION_KEY = "agentFactory.mainChat.workIsolation";
/** Per-project periodic documents check: the Human's interval and the last time a Main chat started one. */
const DOCS_AUDIT_KEY = "agentFactory.mainChat.docsAudit";
const DOCS_AUDIT_CHECK_MS = 30 * 60 * 1000;
const ACCOUNT_USAGE_KEY = "agentFactory.accountUsage.v1";
// agy answers /usage locally without a model turn; refresh it at most this often across panels.
const ANTIGRAVITY_USAGE_REFRESH_MS = 60_000;
const AGENT_REFRESH_INTERVAL_MS = 2_000;
const AGENT_IDLE_VISIBLE_REFRESH_INTERVAL_MS = 5_000;
const AGENT_IDLE_HIDDEN_REFRESH_INTERVAL_MS = 15_000;
const SIDEBAR_AGENTS_KEY = "agentFactory.sidebar.agents";

export interface SidebarAgent {
  readonly state: ChatPanelState;
  readonly running: boolean;
}

export class ChatPanelManager implements vscode.Disposable {
  private controlCenters?: ControlCenterWindows;
  private readonly taskStopsPending = new Set<string>();
  private generalSettingsWrite: Promise<void> = Promise.resolve();
  private startupHandled = false;
  private docsAuditTimer: ReturnType<typeof setInterval> | undefined;
  private docsAuditOfferedAt = 0;
  public readonly viewType = "agentFactory.mainChat";
  private noteStore?: NoteStore;
  private readonly disposedPanels = new WeakSet<vscode.WebviewPanel>();
  private readonly panels = new Map<string, ManagedPanel>();
  private activePanelId: string | undefined;
  private tabIconRoot: vscode.Uri | undefined;
  private tabIconPreparation: Promise<void> | undefined;
  private readonly sidebarListeners = new Set<() => void>();
  private sidebarAgentWrite: Promise<void> = Promise.resolve();
  private branchNoticeWrite: Promise<void> = Promise.resolve();
  private readonly agentRefreshes = new WeakMap<AgentRuntimeClient, Map<string, Promise<{
    readonly agents: readonly import("../agent-factory/agent-client").ChildAgentSession[];
    readonly workflows: readonly Record<string, unknown>[] | undefined;
  }>>>();
  private readonly terminalDeliveryClaims = new WeakMap<object, Set<string>>();
  private readonly projectDeliveryOwners = new Map<string, object>();
  private readonly terminalDeliveryWrites = new Map<string, Promise<void>>();
  private readonly taskDeletesPending = new Set<string>();
  private readonly workflowActionsPending = new Set<string>();
  private taskHistoryRevision = 0;
  private readonly projectHistoryRevisions = new Map<string, number>();
  private readonly deletingPanels = new Set<string>();
  private readonly deletedAgentIds = new Set<string>();
  private readonly deletedPanels = new Set<string>();
  private readonly sudoBroker = new SudoBroker((runId, agentId) => {
    const active = this.findActivePanel();
    const managed = active && (active.state.role ?? "main") === "main" && active.controller?.running && active.controller.runId === runId && active.state.agentId === agentId ? active :
      [...this.panels.values()].find(candidate => (candidate.state.role ?? "main") === "main" && candidate.controller?.running && candidate.controller.runId === runId && candidate.state.agentId === agentId);
    const cwd = managed?.worktree?.workingDirectory ?? managed?.state.projectRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return managed && cwd ? { id: managed.state.panelId, cwd,
      post: (message: import("./sudo-broker").SudoChallenge | { type: "sudo.closed" }) => {
        if (!managed.panel.visible) managed.panel.reveal(undefined, true);
        return this.post(managed.panel, message);
      } } : undefined;
  });

  public onAgentsChanged(listener: () => void): vscode.Disposable {
    this.sidebarListeners.add(listener);
    return { dispose: () => { this.sidebarListeners.delete(listener); } };
  }

  private notifyAgents(): void {
    for (const listener of this.sidebarListeners) listener();
  }

  private async connectPanelRuntime(managed: ManagedPanel): Promise<RuntimeConnection> {
    // A live conversation keeps its original project's runtime even if the
    // workspace's first folder changes or the discovery cache expires.
    return managed.runtimeClient ? { available: true, client: managed.runtimeClient, projectRoot: managed.state.projectRoot } : this.connectRuntime(managed.state.projectRoot);
  }

  private restoreProjectBinding(state: ChatPanelState): ChatPanelState {
    const saved = this.context.workspaceState?.get<string>(`agentFactory.panel.project.${state.panelId}`);
    const known = typeof saved === "string" && isAbsolute(saved) && !saved.includes("\0") ? saved : undefined;
    const projectRoot = known ?? state.projectRoot ?? this.savedAgents().find(entry => entry.panelId === state.panelId)?.projectRoot;
    return projectRoot ? { ...state, projectRoot } : state;
  }

  private async rememberProjectBinding(state: ChatPanelState): Promise<void> {
    if (state.projectRoot) await this.context.workspaceState?.update(`agentFactory.panel.project.${state.panelId}`, state.projectRoot);
  }

  private async recoverProjectBinding(state: ChatPanelState): Promise<ChatPanelState> {
    state = this.restoreProjectBinding(state);
    if (state.projectRoot) return state;
    const agentId = (state.role ?? "main") === "main" ? state.agentId : state.capturedRun?.parentAgentId;
    if (!agentId) return state;
    const roots = [...new Set([...(vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath),
      ...this.savedAgents().map(entry => entry.projectRoot).filter((root): root is string => Boolean(root))])];
    if (roots.length < 2) return state;
    const matches: { root: string; conversationId?: string }[] = [];
    let unavailable = false;
    for (const root of roots) {
      try {
        const connection = await this.connectRuntime(root);
        if (!connection.available) { unavailable = true; continue; }
        const session = (await connection.client.listSessions()).find(session => session.agentId === agentId);
        if (session) matches.push({ root, conversationId: session.conversationId });
      } catch { unavailable = true; }
    }
    // Old Webview snapshots have no root. Only recorded identity establishes
    // their owner; folder order and an unavailable lookup cannot establish it.
    const conversationMatches = (state.role ?? "main") === "main" && state.conversationId
      ? matches.filter(match => match.conversationId === state.conversationId) : [];
    const selected = conversationMatches.length === 1 ? conversationMatches[0] : matches.length === 1 ? matches[0] : undefined;
    if (unavailable) throw new Error("Stored panel project could not be confirmed because a runtime lookup is unavailable");
    if (selected) return { ...state, projectRoot: selected.root };
    if (matches.length > 1) throw new Error("Stored panel project is ambiguous; its recorded identities match multiple workspace projects");
    return state;
  }

  private sameProject(left: ChatPanelState, right: ChatPanelState): boolean {
    const fallback = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return (left.projectRoot ?? fallback) === (right.projectRoot ?? fallback);
  }

  private agentIdentity(state: ChatPanelState): string {
    return state.projectRoot ? createHash("sha256").update(state.projectRoot).digest("hex").slice(0, 32) + "." + state.agentId : String(state.agentId);
  }

  private deliveryStorageKey(prefix: string, state: ChatPanelState): string {
    return prefix + this.agentIdentity(state);
  }

  private historyRevision(state: ChatPanelState): number {
    return state.projectRoot ? this.projectHistoryRevisions.get(state.projectRoot) ?? 0 : this.taskHistoryRevision;
  }

  private invalidateProjectHistory(state: ChatPanelState): void {
    if (state.projectRoot) this.projectHistoryRevisions.set(state.projectRoot, this.historyRevision(state) + 1);
    else this.taskHistoryRevision++;
  }

  private savedAgents(): ChatPanelState[] {
    const saved = this.context.workspaceState?.get<unknown>(SIDEBAR_AGENTS_KEY);
    return Array.isArray(saved) ? saved.map(value => restoreChatState(value)) : [];
  }

  private removedChat(state: ChatPanelState): boolean {
    return this.deletedPanels.has(state.panelId) || Boolean(state.agentId && this.deletedAgentIds.has(this.agentIdentity(state))) ||
      Boolean(this.context.workspaceState?.get<readonly string[]>(DELETED_PANELS_KEY)?.includes(state.panelId));
  }

  public async deleteSidebarAgent(state: ChatPanelState): Promise<readonly string[]> {
    const matches = [...this.panels.values()].filter(panel => this.sameProject(panel.state, state) && (panel.state.panelId === state.panelId ||
      Boolean(state.agentId && panel.state.agentId === state.agentId)));
    const selected = matches.find(panel => panel.state.panelId === state.panelId)?.state ??
      this.savedAgents().find(entry => entry.panelId === state.panelId) ?? state;
    const ids = new Set([selected.panelId, ...matches.map(panel => panel.state.panelId),
      ...this.savedAgents().filter(entry => this.sameProject(entry, selected) && selected.agentId && entry.agentId === selected.agentId).map(entry => entry.panelId)]);
    if ([...ids].some(id => this.deletingPanels.has(id))) throw new Error(localize("ui.sidebar.delete.pending"));
    if (matches.some(panel => this.tabLoading(panel) || panel.controller?.queueLength || panel.pendingMessageIds?.size ||
        panel.controllerInitialization || panel.sessionTransition || panel.backgroundContinuation || panel.queueResumeInFlight)) {
      throw new Error(localize("ui.sidebar.delete.busy"));
    }
    for (const id of ids) this.deletingPanels.add(id);
    try {
      if (selected.agentId) {
        const owner = matches.find(panel => panel.state.panelId === selected.panelId);
        const connection = owner ? await this.connectPanelRuntime(owner) : await this.connectRuntime(selected.projectRoot);
        if (!connection.available || !connection.client.deleteAgent) throw new Error(localize("ui.sidebar.delete.unavailable"));
        await connection.client.deleteAgent(selected.agentId);
        this.deletedAgentIds.add(this.agentIdentity(selected));
        this.agentRefreshes.delete(connection.client);
        this.invalidateProjectHistory(selected);
      }
      // UI markers prevent stale serialized drafts from reviving. The runtime
      // records have already been physically deleted before this point.
      for (const id of ids) this.deletedPanels.add(id);
      for (const panel of [...this.panels.values()]) {
        if (ids.has(panel.state.panelId) || (this.sameProject(panel.state, selected) && selected.agentId && (panel.state.agentId === selected.agentId ||
            panel.state.capturedRun?.agentId === selected.agentId))) panel.panel.dispose();
      }
      const write = this.sidebarAgentWrite.then(async () => {
        await this.context.workspaceState?.update(SIDEBAR_AGENTS_KEY, this.savedAgents().filter(entry =>
          !ids.has(entry.panelId) && (!this.sameProject(entry, selected) || !selected.agentId || entry.agentId !== selected.agentId)));
        const deleted = this.context.workspaceState?.get<readonly string[]>(DELETED_PANELS_KEY) ?? [];
        await this.context.workspaceState?.update(DELETED_PANELS_KEY, [...new Set([...deleted, ...ids])]);
        if (ids.has(this.context.workspaceState?.get<string>(LAST_CHAT_KEY) ?? "")) {
          await this.context.workspaceState?.update(LAST_CHAT_KEY, undefined);
        }
        if (selected.agentId) {
          for (const prefix of ["agentFactory.background.", "agentFactory.workflowResults."]) {
            await this.context.workspaceState?.update(this.deliveryStorageKey(prefix, selected), undefined);
          }
        }
      });
      this.sidebarAgentWrite = write.catch(() => undefined);
      await write;
      this.notifyAgents();
      if (selected.agentId) {
        const connection = await this.connectRuntime(selected.projectRoot);
        if (connection.available && connection.client.listProjectTasks) {
          const entries = await connection.client.listProjectTasks();
          for (const panel of this.panels.values()) {
            if (!panel.disposed && this.sameProject(panel.state, selected)) await this.post(panel.panel, { type: "project.tasks", entries });
          }
        }
      }
      return [...ids];
    } finally { for (const id of ids) this.deletingPanels.delete(id); }
  }

  private rememberAgent(state: ChatPanelState): Promise<void> {
    if ((state.role ?? "main") !== "main") return Promise.resolve();
    const snapshot = { ...state };
    const write = this.sidebarAgentWrite.then(async () => {
      if (this.removedChat(snapshot)) return;
      // Opening or updating a chat must not move its sidebar entry to the end.
      let replaced = false;
      const saved = this.savedAgents().flatMap(entry => {
        if (entry.panelId !== snapshot.panelId && (!this.sameProject(entry, snapshot) || !snapshot.agentId || entry.agentId !== snapshot.agentId)) return [entry];
        if (replaced) return [];
        replaced = true;
        return [snapshot];
      });
      if (!replaced) saved.push(snapshot);
      await this.context.workspaceState?.update(SIDEBAR_AGENTS_KEY, saved);
    });
    this.sidebarAgentWrite = write.catch(() => undefined);
    void write.then(() => this.notifyAgents(), () => undefined);
    return write;
  }

  public async sidebarAgents(): Promise<SidebarAgent[]> {
    await this.sidebarAgentWrite;
    let states = this.savedAgents().filter(state => !this.removedChat(state));
    const fallback = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const roots = new Set([fallback, ...states.map(state => state.projectRoot ?? fallback),
      ...[...this.panels.values()].filter(panel => !panel.disposed).map(panel => panel.state.projectRoot ?? fallback)]);
    for (const projectRoot of roots) {
      const project = { projectRoot } as ChatPanelState;
      const connection = await this.connectRuntime(projectRoot);
      if (!connection.available) continue;
      const sessions = await connection.client.listSessions();
      const existing = new Set(sessions.map(session => session.agentId));
      states = states.filter(state => !this.sameProject(state, project) || !state.agentId || existing.has(state.agentId));
      for (const session of sessions) {
        const state = { projectRoot, agentId: session.agentId } as ChatPanelState;
        if (this.deletedAgentIds.has(this.agentIdentity(state))) continue;
        if (!states.some(state => this.sameProject(state, project) && state.agentId === session.agentId)) {
          states.push({ panelId: this.agentIdentity(state), title: session.agentId, role: "main", projectRoot, agentId: session.agentId, model: session.model });
        }
      }
    }
    for (const managed of this.panels.values()) {
      if (managed.disposed || this.removedChat(managed.state)) continue;
      if ((managed.state.role ?? "main") !== "main") continue;
      const index = states.findIndex(state => state.panelId === managed.state.panelId ||
        (this.sameProject(state, managed.state) && state.agentId && state.agentId === managed.state.agentId));
      if (index >= 0) states[index] = managed.state;
      else states.push(managed.state);
    }
    return states.map(state => ({ state, running: [...this.panels.values()].some(panel =>
      (panel.state.panelId === state.panelId || (this.sameProject(panel.state, state) && state.agentId && panel.state.agentId === state.agentId)) && this.tabLoading(panel)) }));
  }

  public async openSidebarAgent(state: ChatPanelState): Promise<void> {
    state = this.restoreProjectBinding(state);
    if (this.removedChat(state) || this.deletingPanels.has(state.panelId)) return;
    state = await this.recoverProjectBinding(state);
    this.startupHandled = true;
    const existing = [...this.panels.values()].find(panel => this.sameProject(panel.state, state) && (panel.state.panelId === state.panelId ||
      (state.agentId && panel.state.agentId === state.agentId)));
    if (existing) { existing.panel.reveal(undefined, true); return; }
    const panel = vscode.window.createWebviewPanel(this.viewType, state.title, vscode.ViewColumn.Active, this.webviewOptions(state.panelId));
    await this.attach(panel, restoreChatState(state, this.newChatPreferences(state.role ?? "main")));
  }

  public async openControlCenter(state?: ChatPanelState, selection?: { workflowId: string; taskId: string }): Promise<void> {
    const selected = state ?? this.findActivePanel()?.state;
    const root = selected?.projectRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) throw new Error(localize("ui.no.workspace"));
    await this.controlCenterWindows().open(root, selection);
  }

  /** Rebind a control center tab VS Code restored; an unknown or missing project closes it instead of guessing. */
  public async reviveControlCenter(panel: vscode.WebviewPanel, serializedState: unknown): Promise<void> {
    const root = restoredControlCenterRoot(serializedState, (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath));
    const exists = root ? await stat(root).then(value => value.isDirectory(), () => false) : false;
    if (!root || !exists) { panel.dispose(); return; }
    await this.controlCenterWindows().revive(root, panel);
  }

  private controlCenterWindows(): ControlCenterWindows {
    return this.controlCenters ??= new ControlCenterWindows(this.templates, async projectRoot => {
      const connection = await this.controlCenterRuntime(projectRoot);
      if (!connection.available) throw new Error(connection.diagnostic);
      if (!connection.client.listProjectTasks) throw new Error("Project task records are unavailable in this runtime");
      return connection.client.listProjectTasks();
    }, (projectRoot, action) => this.openProjectTask(projectRoot, action), async projectRoot => {
      const connection = await this.controlCenterRuntime(projectRoot);
      if (!connection.available) throw new Error(connection.diagnostic);
      return connection.client.listProjectDomains?.();
    }, (projectRoot, edit) => this.editProjectDomains(projectRoot, edit), {
      command: async (projectRoot, action) => {
        const client = await this.controlCenterClient(projectRoot);
        if (!client.sendWorkerCommand) throw Object.assign(new Error("Worker commands are unavailable in this runtime"), { code: "worker_control_unavailable" });
        return client.sendWorkerCommand(action.agentId, action.text, action.commandId, { loopId: action.loopId, runId: action.runId, rework: action.rework });
      },
      stop: async (projectRoot, action) => {
        const client = await this.controlCenterClient(projectRoot);
        if (!client.stopWorkerTask) throw Object.assign(new Error("Force stop is unavailable in this runtime"), { code: "worker_control_unavailable" });
        await client.stopWorkerTask(action.agentId, action.loopId, action.workflowId, action.taskId);
        return {};
      },
      remove: async (projectRoot, action) => {
        const client = await this.controlCenterClient(projectRoot);
        if (!client.removeWorker) throw Object.assign(new Error("Worker removal is unavailable in this runtime"), { code: "worker_control_unavailable" });
        await client.removeWorker(action.agentId, action.revision);
        return {};
      },
      handoff: async (projectRoot, action, reference) => {
        // Only a model the host currently detects can receive the task.
        const catalog = await modelSelectionCatalog();
        if (!catalog.candidates.some(candidate => candidate.id === action.toModel)) {
          throw Object.assign(new Error(`Model ${action.toModel} is not among the detected models`), { code: "worker_handoff_model" });
        }
        const client = await this.controlCenterClient(projectRoot);
        if (!client.handoffWorker) throw Object.assign(new Error("Provider handoff is unavailable in this runtime"), { code: "worker_control_unavailable" });
        return client.handoffWorker(action.agentId, action.loopId, action.toModel, action.reason, reference);
      },
      supervise: async projectRoot => {
        const client = await this.controlCenterClient(projectRoot);
        if (!client.superviseProject) throw new Error("Supervision is unavailable in this runtime");
        return client.superviseProject();
      },
      models: async () => (await modelSelectionCatalog()).candidates.map(candidate => ({ id: candidate.id, provider: candidate.provider }))
    }, this.context.globalState);
  }

  private async controlCenterClient(projectRoot: string) {
    const connection = await this.controlCenterRuntime(projectRoot);
    if (!connection.available) throw new Error(connection.diagnostic);
    return connection.client;
  }

  private async editProjectDomains(projectRoot: string, edit: import("../../protocol/messages").ProjectDomainEdit): Promise<import("../../protocol/messages").ProjectDomains> {
    const connection = await this.controlCenterRuntime(projectRoot);
    if (!connection.available) throw new Error(connection.diagnostic);
    if (!connection.client.editProjectDomains) throw new Error("Project domains are unavailable in this runtime");
    return connection.client.editProjectDomains(edit);
  }

  private async controlCenterRuntime(projectRoot: string): Promise<RuntimeConnection> {
    const bound = [...this.panels.values()].find(panel => panel.state.projectRoot === projectRoot && panel.runtimeClient);
    return bound ? this.connectPanelRuntime(bound) : this.connectRuntime(projectRoot);
  }

  private async openProjectTask(projectRoot: string, message: Extract<import("../../protocol/messages").ClientMessage, { type: "project.task.open" }>): Promise<void> {
    const connection = await this.controlCenterRuntime(projectRoot);
    if (!connection.available) throw new Error(connection.diagnostic);
    const entry = (await connection.client.listProjectTasks?.())?.find(value => value.id === message.workflowId);
    const task = entry?.tasks.find(value => value.id === message.taskId);
    if (!entry || !task) throw new Error("Task record is no longer available");
    // The work report (result.md) and work request (request.md) of the exact recorded agent/run, never another run's.
    if (message.target === "result" || message.target === "request") {
      const kind = message.target;
      const run = task.runs?.find(value => value.agentId === message.agentId && value.runId === message.runId);
      if (!run || run[kind]?.availability !== "recorded") throw new Error(`The recorded ${kind} is unavailable`);
      const records = await connection.client.projectTaskRecords?.(entry.id, task.id) ?? [];
      const document = records.find(value => value.name === `${run.role} · ${run.runId} · ${kind}.md`);
      if (!document) throw new Error(`The recorded ${kind} is unavailable`);
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(document.path)), { preview: true });
      return;
    }
    if (message.target === "records") {
      const records = await connection.client.projectTaskRecords?.(entry.id, task.id) ?? [];
      const selected = await vscode.window.showQuickPick(records.map(record => ({ label: record.name, path: record.path })), { title: localize("maestro.records") });
      if (selected) await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(selected.path)), { preview: true });
      return;
    }
    if (!entry.mainAgentId) throw new Error("Main conversation identity is not recorded");
    const main = (await this.sidebarAgents()).find(value => value.state.projectRoot === projectRoot && value.state.agentId === entry.mainAgentId);
    if (!main) throw new Error("The recorded Main conversation is unavailable");
    await this.openSidebarAgent(main.state);
    const owner = [...this.panels.values()].find(value => !value.disposed && value.state.projectRoot === projectRoot && value.state.agentId === entry.mainAgentId);
    if (!owner) return;
    if (message.target === "feedback") {
      const ids = (task.runs ?? []).map(run => `${run.agentId}/${run.runId}`).join(", ");
      const text = localize("maestro.feedback.reference", new Date().toISOString(), entry.id, task.id, ids || localize("maestro.unrecorded"));
      if (owner.composerReady) await this.post(owner.panel, { type: "composer.reference", text });
      else (owner.composerReferences ??= []).push(text);
    } else if (message.target === "run") {
      const run = message.agentId ? task.runs?.find(value => value.agentId === message.agentId && value.runId === message.runId)
        : task.runs?.find(value => value.role === "work") ?? task.runs?.[0];
      if (!run) throw new Error("The recorded run is unavailable");
      if (run) await this.openChildAgent(owner, run.agentId, run.runId);
    }
  }

  public async renameSidebarAgent(state: ChatPanelState, title: string): Promise<void> {
    const updated = { ...state, title };
    for (const managed of this.panels.values()) {
      if (!this.sameProject(managed.state, state) || (managed.state.panelId !== state.panelId && (!state.agentId || managed.state.agentId !== state.agentId))) continue;
      managed.state = { ...managed.state, title };
      managed.panel.title = title;
      if (this.tabLoading(managed)) managed.runningTitle?.refresh();
      await this.post(managed.panel, { type: "chat.renamed", title });
    }
    await this.rememberAgent(updated);
  }

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly templates: ChatTemplateRenderer,
    private readonly statusItems: () => readonly StatusItemId[],
    private readonly connectRuntime: (projectRoot?: string) => Promise<RuntimeConnection>
  ) {
    const listener = vscode.workspace.onDidChangeConfiguration?.(event => {
      if (event.affectsConfiguration("agentFactory.agents")) {
        for (const managed of this.panels.values()) void this.refreshAgentDefaults(managed);
      }
    });
    if (listener) this.context.subscriptions.push(listener);
    const setsListener = watchAgentSets(context, () => {
      for (const managed of this.panels.values()) void this.refreshAgentDefaults(managed).catch(cause => {
        void this.post(managed.panel, {type: "host.notice", level: "error", text: cause instanceof Error ? cause.message : String(cause)});
      });
    });
    if (setsListener) this.context.subscriptions.push(setsListener);
  }

  public async openStartup(): Promise<void> {
    if (this.startupHandled) return;
    this.startupHandled = true;
    if (this.generalSettings().startup === "new") { await this.openDraft(); return; }
    const last = this.context.workspaceState?.get<string>(LAST_CHAT_KEY);
    const saved = this.savedAgents();
    const state = saved.find(entry => entry.panelId === last) ?? saved.at(-1);
    // VS Code revives a restored chat tab only when it is shown, so an untracked tab may be this chat; opening it again duplicates the tab.
    if (state && !this.liveDuplicate(state) && this.restoredChatTabPending()) return;
    if (state) await this.openSidebarAgent(state);
  }

  /** Whether the window layout holds a chat tab VS Code restored but has not revived into a tracked panel yet. */
  private restoredChatTabPending(): boolean {
    const tabs = (vscode.window.tabGroups?.all ?? []).flatMap(group => group.tabs)
      .filter(tab => { const viewType = (tab.input as { viewType?: unknown } | undefined)?.viewType; return typeof viewType === "string" && viewType.endsWith(this.viewType); });
    return tabs.length > [...this.panels.values()].filter(panel => !panel.disposed).length;
  }

  /** A live panel already bound to the same chat: the same panel ID, or the same Agent in the same project. */
  private liveDuplicate(state: ChatPanelState, panel?: vscode.WebviewPanel): ManagedPanel | undefined {
    return [...this.panels.values()].find(candidate => !candidate.disposed && candidate.panel !== panel && this.sameProject(candidate.state, state) &&
      (candidate.state.panelId === state.panelId || Boolean(state.agentId && candidate.state.agentId === state.agentId)));
  }

  private generalSettings(): GeneralSettings {
    return normalizeGeneralSettings(this.context.globalState.get(GENERAL_SETTINGS_KEY));
  }

  private async updateGeneralSetting(managed: ManagedPanel, key: keyof GeneralSettings, value: boolean | "restore" | "new"): Promise<void> {
    const write = this.generalSettingsWrite.then(async () => {
      await this.context.globalState.update(GENERAL_SETTINGS_KEY, { ...this.generalSettings(), [key]: value });
      for (const target of this.panels.values()) await this.post(target.panel, { type: "general.updated", settings: this.generalSettings() });
    });
    this.generalSettingsWrite = write.catch(() => undefined);
    try { await write; }
    catch (error) { await this.post(managed.panel, { type: "general.updated", settings: this.generalSettings(), error: String(error) }); }
  }

  private notifyRun(managed: ManagedPanel, kind: NotificationKind, identity: string): void {
    if (managed.disposed || !identity) return;
    const runId = identity.split(":")[0];
    if (managed.notificationRunId !== runId) { managed.notificationRunId = runId; managed.notificationKeys = new Set(); }
    const key = `${identity}:${kind}`;
    const keys = managed.notificationKeys ??= new Set();
    if (keys.has(key)) return;
    keys.add(key);
    const settings = this.generalSettings();
    if (!shouldNotify(settings, kind, managed.panel.active && vscode.window.state?.focused !== false)) return;
    if (settings.notifySound) void this.post(managed.panel, { type: "notification.sound" });
    const text = localize(`general.notice.${kind}`, managed.state.title);
    const open = localize("general.notice.open");
    const notification = kind === "failed" ? vscode.window.showErrorMessage(text, open) : vscode.window.showInformationMessage(text, open);
    // A notification awaiting dismissal must never block completion or queue processing.
    void notification.then(choice => {
      if (choice === open && !managed.disposed) managed.panel.reveal(undefined, false);
    }, () => {});
  }

  public async openDraft(): Promise<void> {
    this.startupHandled = true;
    const state = { ...createDraftChatState(this.newChatPreferences()), role: "main" as const,
      projectRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath };
    const panel = vscode.window.createWebviewPanel(
      this.viewType,
      state.title,
      vscode.ViewColumn.Active,
      this.webviewOptions(state.panelId)
    );
    await this.attach(panel, state);
  }

  public async revive(panel: vscode.WebviewPanel, serializedState: unknown): Promise<void> {
    let state = this.restoreProjectBinding(restoreChatState(serializedState, this.newChatPreferences()));
    if (this.removedChat(state)) { panel.dispose(); return; }
    state = await this.recoverProjectBinding(state);
    const panelMatch = this.panels.get(state.panelId);
    const existing = (panelMatch && !panelMatch.disposed && this.sameProject(panelMatch.state, state) ? panelMatch : undefined) ?? [...this.panels.values()].find(candidate =>
      Boolean(!candidate.disposed && this.sameProject(candidate.state, state) && state.agentId && candidate.state.agentId === state.agentId));
    if (existing) {
      if (state.capturedRun) {
        const capturedRun = await this.restoreCapturedRun(state.capturedRun, state).catch(() => undefined);
        existing.state = { ...existing.state, capturedRun };
        await this.post(existing.panel, { type: "agent.run.selected", capturedRun });
      }
      existing.panel.reveal(panel.viewColumn, true);
      panel.dispose();
      return;
    }
    if (state.agentId && (state.role ?? "main") === "main") {
      const connection = await this.connectRuntime(state.projectRoot);
      if (connection.available && !(await connection.client.listSessions()).some(session => session.agentId === state.agentId)) {
        panel.dispose(); return;
      }
    }
    await this.attach(panel, state);
  }

  public async requestResume(): Promise<void> {
    let managed = this.findActivePanel() ?? this.panels.values().next().value as ManagedPanel | undefined;
    if (!managed) {
      await this.openDraft();
      managed = this.findActivePanel() ?? this.panels.values().next().value as ManagedPanel | undefined;
    }
    if (managed) {
      managed.panel.reveal(undefined, true);
      await this.post(managed.panel, { type: "sessions.open" });
    }
  }

  public async renameActive(): Promise<void> {
    const managed = this.findActivePanel();
    if (!managed) {
      await vscode.window.showInformationMessage(localize("ui.select.the.main.agent.chat.tab.to.rename.first"));
      return;
    }

    const title = await vscode.window.showInputBox({
      title: localize("ui.rename.main.agent"),
      prompt: localize("ui.enter.the.name.to.display.on.this.chat.tab"),
      value: managed.state.title,
      valueSelection: [0, managed.state.title.length],
      validateInput(value) {
        const length = value.trim().length;
        if (length === 0) {
          return localize("ui.enter.a.name");
        }
        if (length > 80) {
          return localize("ui.the.name.must.be.no.more.than.80.characters");
        }
        return undefined;
      }
    });
    if (title === undefined) {
      return;
    }

    const normalizedTitle = title.trim();
    managed.state = { ...managed.state, title: normalizedTitle };
    managed.panel.title = normalizedTitle;
    if (this.tabLoading(managed)) managed.runningTitle?.refresh();
    await this.post(managed.panel, { type: "chat.renamed", title: normalizedTitle });
    this.rememberAgent(managed.state);
  }

  public async clearActiveConversation(): Promise<void> {
    const managed = this.findActivePanel();
    if (!managed) {
      await vscode.window.showInformationMessage(localize("ui.select.the.main.agent.chat.tab.to.clear.first"));
      return;
    }
    await this.transitionConversation(managed);
  }

  public dispose(): void {
    if (this.docsAuditTimer) clearInterval(this.docsAuditTimer);
    this.sudoBroker.dispose();
    this.controlCenters?.dispose();
    for (const managed of this.panels.values()) {
      managed.disposed = true;
      this.disposedPanels.add(managed.panel);
      if (managed.agentRefreshTimer) clearTimeout(managed.agentRefreshTimer);
      managed.lunaBot?.dispose();
      for (const subscription of managed.subscriptions) {
        subscription.dispose();
      }
      managed.panel.dispose();
    }
    this.panels.clear();
  }

  private tabIcon(name: string): vscode.Uri {
    this.tabIconPreparation ??= prepareTabIcons(this.context.extensionUri, this.context.globalStorageUri).then(root => {
      this.tabIconRoot = root;
      for (const managed of this.panels.values()) {
        if (!managed.disposed && !this.tabLoading(managed)) managed.panel.iconPath = this.tabIcon("agent-factory.png");
      }
    }).catch(() => undefined);
    return vscode.Uri.joinPath(this.tabIconRoot ?? vscode.Uri.joinPath(this.context.extensionUri, "static", "images"), name);
  }

  private tabLoading(managed: ManagedPanel): boolean {
    return shouldShowTabLoading(managed.controller?.running === true, managed.activeChildRuns);
  }

  private refreshTabLoading(managed: ManagedPanel): void {
    managed.runningTitle?.setRunning(this.tabLoading(managed));
  }

  private async attach(panel: vscode.WebviewPanel, state: ChatPanelState, runtimeClient?: AgentRuntimeClient): Promise<void> {
    state = this.restoreProjectBinding(state);
    const legacyState = state;
    state = {...state, agentSettingsVersion: 1, projectRoot: state.projectRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath};
    await this.rememberProjectBinding(state);
    if (this.context.globalState) await ensureAgentPresets(this.context.globalState, this.context.workspaceState, state.panelId, this.agentSettingsFromState(state));
    panel.title = state.title;
    panel.iconPath = this.tabIcon("agent-factory.png");
    panel.webview.options = this.webviewOptions(state.panelId);

    const subscriptions: vscode.Disposable[] = [];
    const managed: ManagedPanel = {
      panel,
      state,
      runtimeClient,
      subscriptions,
      imageAttachments: new Map(),
      imageMutation: Promise.resolve(),
      chatSendPreparation: Promise.resolve()
    };
    managed.runningTitle = new RunningTitle(() => managed.state.title, (title, frame) => {
      panel.title = title;
      const icon = frame === undefined ? "agent-factory.png" : `loading-squares-${frame}.svg`;
      panel.iconPath = this.tabIcon(icon);
    });
    subscriptions.push(managed.runningTitle);
    subscriptions.push(new vscode.Disposable(() => {
      managed.disposed = true;
      this.disposedPanels.add(panel);
      managed.controller?.dispose();
      managed.branchRefreshStarted = false;
      managed.themeReady = false;
      managed.themeRevision = (managed.themeRevision ?? 0) + 1;
      if (managed.themeTimer) clearTimeout(managed.themeTimer);
      if (managed.branchRefreshTimer) clearTimeout(managed.branchRefreshTimer);
    }));
    const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(codexHome), "{config.toml,themes/*.tmTheme}")
    );
    const refreshTheme = () => {
      if (managed.themeTimer) clearTimeout(managed.themeTimer);
      managed.themeTimer = setTimeout(() => { void this.refreshTheme(managed); }, 150);
    };
    subscriptions.push(watcher, watcher.onDidChange(refreshTheme), watcher.onDidCreate(refreshTheme), watcher.onDidDelete(refreshTheme));
    // Restoration and startup can both pass their checks across the awaits above; the first bound tab keeps the chat.
    const duplicate = this.liveDuplicate(state, panel);
    if (duplicate) {
      for (const subscription of subscriptions) subscription.dispose();
      duplicate.panel.reveal(panel.viewColumn, true);
      panel.dispose();
      return;
    }
    this.panels.set(state.panelId, managed);
    if (!legacyState.projectRoot && state.projectRoot && state.agentId) {
      // Old snapshots belonged to the workspace's default project. Copy their
      // delivery cache into that binding without replacing newer acknowledgements.
      for (const prefix of ["agentFactory.background.", "agentFactory.workflowResults."]) {
        const legacy = this.context.workspaceState?.get<Record<string, unknown>>(prefix + state.agentId);
        if (legacy) await this.persistTerminalDeliveries(this.deliveryStorageKey(prefix, state), legacy, () => !managed.disposed, true);
      }
    }
    await this.rememberAgent(state);
    if (panel.active) {
      this.activePanelId = state.panelId;
      if ((state.role ?? "main") === "main") void this.context.workspaceState?.update(LAST_CHAT_KEY, state.panelId);
    }

    subscriptions.push(
      panel.onDidDispose(() => {
        managed.disposed = true;
        this.sudoBroker.cancelPanel(managed.state.panelId);
        this.disposedPanels.add(panel);
        managed.lunaBot?.dispose();
        if (managed.agentRefreshTimer) clearTimeout(managed.agentRefreshTimer);
        if (this.panels.get(state.panelId) === managed) this.panels.delete(state.panelId);
        this.broadcastCompanion();
        this.notifyAgents();
        if (this.activePanelId === state.panelId) {
          this.activePanelId = undefined;
        }
        for (const subscription of subscriptions) {
          subscription.dispose();
        }
      }),
      panel.onDidChangeViewState((event) => {
        if (event.webviewPanel.active) {
          this.activePanelId = state.panelId;
          if ((managed.state.role ?? "main") === "main") void this.context.workspaceState?.update(LAST_CHAT_KEY, state.panelId);
          void this.refreshTheme(managed);
        }
        if (event.webviewPanel.visible) this.scheduleAgentList(managed, true);
      }),
      panel.webview.onDidReceiveMessage(async (rawMessage: unknown) => {
        await this.dispatchMessage(managed, rawMessage);
      })
    );

    try {
      panel.webview.html = await this.templates.render(panel.webview);
    } catch (error) {
      if (this.panels.get(state.panelId) === managed) this.panels.delete(state.panelId);
      this.broadcastCompanion();
      panel.webview.html = fallbackHtml(error);
    }
  }

  private async refreshTheme(managed: ManagedPanel): Promise<void> {
    if (!managed.themeReady) return;
    const revision = managed.themeRevision = (managed.themeRevision ?? 0) + 1;
    const selection = await readCliTheme();
    if (!managed.themeReady || revision !== managed.themeRevision) return;
    const signature = JSON.stringify(selection);
    if (signature === managed.themeSignature) return;
    managed.themeSignature = signature;
    await this.post(managed.panel, { type: "syntax.theme", selection });
  }

  private async refreshBranch(managed: ManagedPanel): Promise<void> {
    if (!managed.branchRefreshStarted) return;
    try {
      if (managed.panel.visible) {
        const branch = await readGitBranch(managed.worktree?.workingDirectory ?? managed.state?.projectRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
        if (managed.branchRefreshStarted) {
          await this.post(managed.panel, { type: "branch.updated", branch });
        }
      }
    } finally {
      if (managed.branchRefreshStarted) {
        managed.branchRefreshTimer = setTimeout(() => { void this.refreshBranch(managed); }, 3_000);
      }
    }
  }

  private async ensureSudoBroker(managed: ManagedPanel): Promise<void> {
    if (!this.context.extensionPath || process.platform === "win32") return;
    try {
      await this.sudoBroker.start(join(this.context.extensionPath, "static", "sudo-request.py"));
    } catch (error) {
      await this.post(managed.panel, { type: "host.notice", level: "warning",
        text: localize("sudo.unavailable", error instanceof Error ? error.message : String(error)) });
    }
  }

  /** Reports a failed chat request in the log and the chat instead of leaving an unhandled rejection. */
  private async dispatchMessage(managed: ManagedPanel, rawMessage: unknown): Promise<void> {
    try {
      await this.handleMessage(managed, rawMessage);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      // Log the protocol operation only, never chat text, attachments or credentials.
      console.error("[Agent Factory] Chat request failed", { type: requestType(rawMessage), error: text });
      if (managed.disposed) return;
      try { await this.post(managed.panel, { type: "host.notice", level: "error", text }); }
      catch (notice) { console.error("[Agent Factory] Chat request failure could not be shown", { type: requestType(rawMessage), error: String(notice) }); }
    }
  }

  /** Initializes a loaded chat view; host.initialize is sent even when a preparation step fails. */
  private async initializeClient(managed: ManagedPanel, pendingMessageIds: readonly string[]): Promise<void> {
    // A failed step must not prevent host.initialize; the chat reports it afterwards.
    const runtimeErrors = new Set<string>();
    const runtimeError = (error: unknown) => { runtimeErrors.add(error instanceof Error ? error.message : String(error)); return undefined; };
    const guard = async <T>(step: () => Promise<T>): Promise<T | undefined> => {
      try { return await step(); } catch (error) { return runtimeError(error); }
    };
    await guard(() => this.reconcileChatRequests(managed, pendingMessageIds));
    await guard(() => this.ensureSudoBroker(managed));
    void this.detectDeploy(managed, true);
    managed.lunaBot?.cancelTalk();
    const pendingSudo = this.sudoBroker.challengeFor(managed.state.panelId);
    if (pendingSudo) await guard(() => this.post(managed.panel, pendingSudo));
    if (!managed.state.agentId) managed.executionMode ??= this.defaultExecutionMode();
    await guard(() => this.post(managed.panel, { type: "execution.updated", mode: managed.executionMode }));
    managed.themeReady = true;
    managed.themeSignature = undefined;
    await guard(() => this.refreshTheme(managed));
    const connection: RuntimeConnection = await this.connectPanelRuntime(managed)
      .catch(error => ({ available: false as const, diagnostic: error instanceof Error ? error.message : String(error) }));
    await guard(async () => {
      await ensureAgentPresets(this.context.globalState, this.context.workspaceState, managed.state.panelId, this.agentSettingsFromState(managed.state));
      await this.post(managed.panel, { type: "agent.defaults", settings: readAgentDefaults(this.context.globalState, this.context.workspaceState, managed.state.panelId) });
    });
    await guard(() => this.post(managed.panel, { type: "usage.accounts", accounts: this.accountUsage() }));
    void this.refreshAntigravityUsage();
    const selected = managed.state.capturedRun;
    if (selected) {
      const capturedRun = await this.restoreCapturedRun(selected, managed.state).catch(runtimeError);
      if (managed.state.capturedRun === selected) managed.state = { ...managed.state, capturedRun };
    }
    const capabilities = connection.available
      ? await connection.client.capabilities(managed.state.agentId, this.effectiveModel(managed)).catch(runtimeError) : undefined;
    this.broadcastCompanion();
    let runtimeConversationId: string | undefined;
    if (managed.state.agentId && connection.available) {
      runtimeConversationId = (await connection.client.listSessions().catch(runtimeError))
        ?.find(session => session.agentId === managed.state.agentId)?.conversationId;
    }
    const resetConversation = Boolean(runtimeConversationId && runtimeConversationId !== managed.state.conversationId);
    if (runtimeConversationId) {
      managed.state = {
        ...managed.state,
        conversationId: runtimeConversationId,
        ...(resetConversation ? {
          contextUsedTokens: undefined,
          contextWindowTokens: undefined,
          weeklyUsedPercent: undefined,
          fiveHourUsedPercent: undefined,
          weeklyResetsAt: undefined,
          fiveHourResetsAt: undefined
        } : {})
      };
      if (resetConversation) managed.startedMessages = [];
    }
    if (managed.state.agentId && !managed.executionMode) {
      await guard(() => this.post(managed.panel, { type: "execution.updated", mode: capabilities?.executionMode }));
    }
    await this.post(managed.panel, {
      type: "host.initialize",
      agentSettingsVersion: 1,
      capturedRun: managed.state.capturedRun,
      agentId: managed.state.agentId,
      panelId: managed.state.panelId,
      title: managed.state.title,
      role: managed.state.role ?? "main",
      verifiedWorkRunId: managed.state.verifiedWorkRunId,
      projectName: workspaceName(),
      runtimeAvailable: connection.available,
      capabilities,
      workIsolation: this.workIsolation(),
      generalSettings: this.generalSettings(),
      docsAuditInterval: this.docsAudit().interval ?? "off",
      running: managed.controller?.running ?? Boolean(managed.state.agentId && connection.available),
      statusItems: this.statusItems(),
      botsEnabled: this.botsEnabled(),
      botsAvailable: true,
      companionAvailable: this.botCharacter() === "lumi",
      localCompanionAvailable, botCharacter: this.botCharacter(),
      botModel: this.botModel(), botDefaultPrompt: BOT_DEFAULT_PROMPTS[this.botCharacter()], botPrompt: resolveBotPrompt(this.botCharacter(), this.botPrompt()),
      model: managed.state.model,
      agentModels: managed.state.agentModels,
      agentFastModes: managed.state.agentFastModes,
      agentPermissions: managed.state.agentPermissions,
      reasoning: managed.state.reasoning,
      agentSettingsScope: managed.state.agentSettingsScope,
      agentSettingsSet: managed.state.agentSettingsSet,
      businessMode: "normal",
      maestroMode: managed.state.maestroMode === true,
      taskMode: "direct",
      fastMode: managed.state.fastMode === true,
      goalMode: false,
      workLoopMode: false,
      contextUsedTokens: managed.state.contextUsedTokens,
      contextWindowTokens: managed.state.contextWindowTokens,
      weeklyUsedPercent: managed.state.weeklyUsedPercent,
      fiveHourUsedPercent: managed.state.fiveHourUsedPercent,
      weeklyResetsAt: managed.state.weeklyResetsAt,
      fiveHourResetsAt: managed.state.fiveHourResetsAt,
      pendingMessageIds: [...(managed.pendingMessageIds ?? [])],
      queueCount: managed.controller?.queueLength ?? 0,
      conversationId: runtimeConversationId,
      resetConversation
    });
    if ((managed.state.role ?? "main") === "main" && connection.available) {
      this.ensureDocsAuditTimer();
      await guard(() => this.offerDocsAudit());
    }
    if (!connection.available) {
      await this.post(managed.panel, {
        type: "host.notice",
        level: "error",
        text: connection.diagnostic
      });
    }
    for (const text of runtimeErrors) await this.post(managed.panel, { type: "host.notice", level: "error", text });
    runtimeErrors.clear();
    try {
      await guard(() => this.sendModelList(managed));
      if (managed.state.agentId) await this.post(managed.panel, { type: "session.bound", agentId: managed.state.agentId });
      if (managed.state.agentId && connection.available) {
        // A history failure must not leave the active run unchecked.
        await guard(() => this.restoreConversationHistory(managed, connection.client));
        await this.ensureController(managed);
        try { await managed.controller?.reconnect(); }
        catch (error) {
          await this.post(managed.panel, { type: "host.notice", level: "error", text: localize("ui.unable.to.check.the.active.run.0", error instanceof Error ? describeLocalizedMessage(error.message) ?? error.message : String(error)) });
        }
      }
      await guard(() => this.refreshWorktree(managed));
      managed.composerReady = true;
      for (const text of managed.composerReferences?.splice(0) ?? []) await this.post(managed.panel, { type: "composer.reference", text });
      if (managed.initialPrompt) { await this.post(managed.panel, { type: "composer.prefill", text: managed.initialPrompt }); managed.initialPrompt = undefined; }
    } finally {
      this.scheduleAgentList(managed, true);
      if (!managed.branchRefreshStarted) {
        managed.branchRefreshStarted = true;
        void this.refreshBranch(managed);
      }
    }
    for (const text of runtimeErrors) await this.post(managed.panel, { type: "host.notice", level: "error", text });
  }

  private async handleMessage(managed: ManagedPanel, rawMessage: unknown): Promise<void> {
    const message = parseClientMessage(rawMessage);
    if (message && (managed.disposed || (managed.state && (this.removedChat(managed.state) || this.deletingPanels.has(managed.state.panelId))))) {
      if (message.type === "chat.send") await this.post(managed.panel, { type: "chat.rejected", id: message.id });
      return;
    }
    if (!message) {
      const type = requestType(rawMessage);
      // Log the protocol operation only, never chat text, attachments or credentials.
      console.warn("[Agent Factory] Chat request rejected", { type, reason: "protocol-validation-failed" });
      // A rejected upload must release its pending composer chip, or sending stays blocked.
      if ((type === "attachments.createImage" || type === "attachments.createFile")
          && typeof rawMessage === "object" && rawMessage !== null && "id" in rawMessage && typeof rawMessage.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(rawMessage.id)) {
        await this.post(managed.panel, { type: "attachment.rejected", id: rawMessage.id });
      }
      await this.post(managed.panel, {
        type: "host.notice",
        level: "error",
        text: localize("ui.received.an.invalid.message.from.the.chat.view")
      });
      return;
    }

    switch (message.type) {
      case "worktree.repositories": {
        const connection = await this.connectPanelRuntime(managed);
        try {
          const repositories = connection.available ? await connection.client.worktreeRepositories?.() ?? [] : [];
          await this.post(managed.panel, { type: "worktree.repositories", repositories });
        } catch (error) { await this.post(managed.panel, { type: "host.notice", level: "error", text: String(error) }); }
        return;
      }
      case "worktree.refresh":
        await this.refreshWorktree(managed);
        return;
      case "deploy.detect":
        await this.detectDeploy(managed, false);
        return;
      case "deploy.run":
        await this.runDeploy(managed, message.workflowId, message.inputs);
        return;
      case "deploy.token":
        await this.setupDeployToken(managed, message.secret);
        return;
      case "worktree.create":
      case "worktree.merge": {
        if (managed.sessionTransition) return;
        const transition = this.changeWorktree(managed, message.type === "worktree.create" ? "create" : "merge", message.type === "worktree.create" ? message : undefined);
        managed.sessionTransition = transition;
        try { await transition; }
        finally { if (managed.sessionTransition === transition) managed.sessionTransition = undefined; }
        return;
      }
      case "chat.status":
        await this.reconcileChatRequests(managed, message.ids);
        return;
      case "client.ready": {
        // Share the per-panel order with chat.send so a reload cannot interleave
        // with an earlier send or reset the conversation boundary under a later one.
        const ready = (managed.chatSendPreparation ?? Promise.resolve()).then(() => this.initializeClient(managed, message.pendingMessageIds ?? []));
        managed.chatSendPreparation = ready.then(() => undefined, () => undefined);
        await ready;
        return;
      }
      case "message.copy":
        await vscode.env.clipboard.writeText(message.text);
        return;
      case "reference.copy":
        await vscode.env.clipboard.writeText(message.id);
        return;
      case "image.resolve":
        await this.post(managed.panel, { type: "image.resolved", href: message.href, src: await readMarkdownImage(message.href, [...(managed.worktree ? [managed.worktree.workingDirectory] : []), ...(vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath)]) });
        return;
      case "link.open":
        await this.openLink(managed, message.href);
        return;
      case "execution.select":
        await this.selectExecutionMode(managed, message.mode);
        return;
      case "sudo.reply":
        this.sudoBroker.respond(managed.state.panelId, message);
        return;
      case "chat.send": {
        // Reserve identity before any asynchronous preparation or status snapshot.
        const previous = managed.startedMessages?.find(item => item.id === message.id);
        if (previous) { await this.post(managed.panel, previous); return; }
        if (managed.pendingMessageIds?.has(message.id)) {
          await this.post(managed.panel, { type: "chat.pending", id: message.id });
          return;
        }
        (managed.pendingMessageIds ??= new Set()).add(message.id);
        const executionMode = managed.executionMode ?? this.defaultExecutionMode();
        const executionModeExplicit = managed.executionModeExplicit || !managed.state.agentId;
        // Serialize the whole preparation, preserving arrival order even when probes differ in latency.
        const sendPreparation = (managed.chatSendPreparation ?? Promise.resolve()).then(async () => {
          await this.refreshWorktree(managed);
          if (managed.worktree?.worktree?.workUnit && managed.worktree.worktree.phase === "merged") {
            throw new Error(localize("unit.archived"));
          }
          await this.warnDirectBranch(managed);
          await this.ensureSudoBroker(managed);
          await this.sendChat(managed, message.text, message.attachments, message.execution, message.id, executionMode, executionModeExplicit);
        });
        managed.chatSendPreparation = sendPreparation.then(() => undefined, () => undefined);
        try {
          await sendPreparation;
        } catch (error) {
          managed.pendingMessageIds?.delete(message.id);
          await this.post(managed.panel, { type: "chat.rejected", id: message.id });
          await this.post(managed.panel, { type: "host.notice", level: "error", text: error instanceof Error ? error.message : String(error) });
          await this.post(managed.panel, { type: "run.state", running: managed.controller?.running === true });
          await this.post(managed.panel, { type: "queue.updated", count: managed.controller?.queueLength ?? 0 });
        }
        return;
      }
      case "decision.approve":
        if (!managed.controller?.approveDecision(message.runId, {
          ...((managed.state.role ?? "main") === "main" && (!managed.state.agentId || managed.executionModeExplicit) ? { executionMode: managed.executionMode ?? this.defaultExecutionMode() } : {}),
          ...(managed.state.verifiedWorkRunId ? { verifiedWorkRunId: managed.state.verifiedWorkRunId } : {})
        }, message.language)) {
          await this.post(managed.panel, { type: "decision.pending", runId: null });
          await this.post(managed.panel, { type: "host.notice", level: "warning", text: localize("ui.this.request.has.already.been.answered.or.has.expired.reply.directly.in.the.current.conversation") });
        }
        return;
      case "agent.preset.field": {
        try {
          await updateAgentPresetField(this.context.globalState, this.context.workspaceState, managed.state.panelId, message.scope, message.name, message.role, message.field, message.value);
          await this.post(managed.panel, {type: "agent.preset.field.result"});
          for (const panel of this.panels.values()) await this.refreshAgentDefaults(panel);
        } catch (cause) {
          await this.post(managed.panel, {type: "agent.preset.field.result", error: cause instanceof Error ? cause.message : String(cause)});
          await this.refreshAgentDefaults(managed);
        }
        return;
      }
      case "agent.preset.fast": {
        try {
          await updateAgentPresetFastMode(this.context.globalState, this.context.workspaceState, managed.state.panelId, message.scope, message.name, message.role, message.model, message.value);
          await this.post(managed.panel, {type: "agent.preset.field.result"});
          for (const panel of this.panels.values()) await this.refreshAgentDefaults(panel);
        } catch (cause) {
          await this.post(managed.panel, {type: "agent.preset.field.result", error: cause instanceof Error ? cause.message : String(cause)});
          await this.refreshAgentDefaults(managed);
        }
        return;
      }
      case "agent.preset": {
        let error: string | undefined;
        let settings: AgentDefaults | undefined;
        const copyToChat = message.action === "copy" || (message.action === "apply" && message.scope === "chat");
        try {
          if (copyToChat) {
            await this.assertPresetSelectionAvailable(managed);
            const preset = (readAgentDefaults(this.context.globalState, this.context.workspaceState, managed.state.panelId).presets ?? [])
              .find(item => item.scope === message.scope && item.name === message.name);
            if (preset) await this.assertAgentSettingsCompatible(managed, preset.settings);
          }
          if (message.action === "save" && !readAgentDefaults(this.context.globalState).presets?.some(set => set.name === message.sourceName)) {
            throw new Error(localize("preset.missing"));
          }
          settings = await useAgentPreset(this.context.globalState, this.context.workspaceState, managed.state.panelId, message.action, message.scope, message.name, this.agentSettingsFromState(managed.state), message.newName, message.action === "save" ? message.sourceName : undefined);
          if (settings && copyToChat) {
            managed.state = this.applyAgentSettings(managed.state, settings, "global", message.name);
            await this.rememberAgent(managed.state);
          } else if (message.action === "rename" && managed.state.agentSettingsScope === message.scope && managed.state.agentSettingsSet === message.name) {
            managed.state = {...managed.state, agentSettingsSet: message.newName};
            await this.rememberAgent(managed.state);
          }
        } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
        finally {
          await this.post(managed.panel, {type: "agent.preset.result", scope: copyToChat ? "global" : message.scope, name: message.action === "rename" && message.newName ? message.newName : message.name, ...(settings && copyToChat && !error ? {settings} : {}), ...(error ? {error} : {})});
          for (const panel of this.panels.values()) await this.refreshAgentDefaults(panel);
        }
        return;
      }
      case "agent.defaults.save":
      case "agent.defaults.fast":
        // Retired scope editors must not mutate the single set library.
        await this.refreshAgentDefaults(managed);
        throw new Error(localize("preset.scope.retired"));
      case "general.set":
        await this.updateGeneralSetting(managed, message.key, message.value);
        return;
      case "docsAudit.set": {
        // Enabling starts the first period now, so a check never fires the moment it is switched on.
        await this.context.workspaceState?.update(DOCS_AUDIT_KEY, { interval: message.interval, ...(message.interval === "off" ? {} : { lastRunAt: Date.now() }) });
        for (const panel of this.panels.values()) {
          if (panel !== managed && !panel.disposed) await this.post(panel.panel, { type: "docsAudit.updated", interval: message.interval });
        }
        return;
      }
      case "docsAudit.started":
        await this.context.workspaceState?.update(DOCS_AUDIT_KEY, { ...this.docsAudit(), lastRunAt: Date.now() });
        return;
      case "workIsolation.set":
        await this.context.workspaceState?.update(WORK_ISOLATION_KEY, message.value);
        for (const panel of this.panels.values()) {
          if (panel !== managed && !panel.disposed) await this.post(panel.panel, { type: "workIsolation.updated", value: message.value });
        }
        return;
      case "composer.settings": {
        const locked = managed.state.agentSettingsScope === "global" && message.agentSettingsScope === "global";
        try {
          await this.assertAgentSettingsCompatible(managed, {
            [managed.state.role ?? "main"]: { model: message.model, reasoningEffort: message.reasoning }
          });
        } catch (cause) {
          await this.post(managed.panel, { type: "host.notice", level: "error", text: cause instanceof Error ? cause.message : String(cause) });
          return;
        }
        managed.state = {
          ...managed.state,
          businessMode: "normal",
          maestroMode: (managed.state.role ?? "main") === "main" && (message.maestroMode ?? managed.state.maestroMode) === true,
          taskMode: "direct",
          model: locked ? managed.state.model : message.model,
          agentModels: locked ? managed.state.agentModels : message.agentModels,
          agentFastModes: locked ? managed.state.agentFastModes : message.agentFastModes,
          agentPermissions: message.agentPermissions,
          reasoning: locked ? managed.state.reasoning : message.reasoning,
          agentSettingsScope: locked ? "global" : "chat",
          agentSettingsSet: locked ? managed.state.agentSettingsSet : "Chat",
          fastMode: locked ? managed.state.fastMode : message.fastMode,
          goalMode: false,
          workLoopMode: false
        };
        await this.saveComposerPreferences(managed.state);
        await this.rememberAgent(managed.state);
        {
          const selectedModel = this.effectiveModel(managed);
          const connection = await this.connectPanelRuntime(managed);
          if (connection.available) {
            const capabilities = await connection.client.capabilities(managed.state.agentId, selectedModel).catch(() => undefined);
            if (capabilities && !managed.disposed && this.effectiveModel(managed) === selectedModel) {
              await this.post(managed.panel, { type: "capabilities.updated", capabilities });
            }
          }
        }
        return;
      }
      case "goal.control":
        if ((managed.state.role ?? "main") !== "main") return;
        await this.ensureController(managed);
        void managed.controller?.controlGoal(message.action);
        return;
      case "queue.resume":
        if (managed.queueResumeInFlight) return;
        managed.queueResumeInFlight = true;
        try {
          if (!managed.controller) throw new Error("Chat controller is unavailable");
          await managed.controller.reconnect();
        } catch (error) {
          console.error("[Agent Factory] Queue resume failed", error);
          await this.post(managed.panel, { type: "host.notice", level: "error", text: localize("ui.queue.resume.failed") });
        } finally {
          managed.queueResumeInFlight = false;
        }
        return;
      case "run.cancel":
        if (!managed.controller) {
          await this.post(managed.panel, { type: "run.state", running: false });
        } else {
          await managed.controller.cancel();
        }
        return;
      case "conversation.clear": {
        await this.transitionConversation(managed);
        return;
      }
      case "sessions.request":
        await this.sendSessionList(managed);
        return;
      case "models.request":
        await this.sendModelList(managed);
        return;
      case "usage.refresh":
        await this.refreshAntigravityUsage();
        return;
      case "providers.request":
        await this.post(managed.panel, { type: "providers.status", providers: providerStatuses(), busy: this.providerRefresh !== undefined, errors: this.providerErrors, pluginUpdateMode: pluginUpdateMode(), versions: providerVersions() });
        return;
      case "providers.detect":
        await this.refreshProviders();
        return;
      case "providers.configure":
        try {
          await saveProviderPath(message.provider, message.path);
        } catch (error) {
          await this.post(managed.panel, { type: "host.notice", level: "error", text: error instanceof Error ? error.message : String(error) });
        }
        // The configuration listener also refreshes; both calls share one detection.
        await this.refreshProviders();
        return;
      case "providers.pick": {
        const selected = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          title: localize("ui.providers.pick.title"),
          openLabel: localize("ui.providers.pick")
        });
        const executable = selected?.[0];
        if (!executable) return;
        try {
          await saveProviderPath(message.provider, executable.fsPath);
          await this.refreshProviders();
        } catch (error) {
          await this.post(managed.panel, { type: "host.notice", level: "error", text: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      case "providers.updateMode.select":
        await savePluginUpdateMode(message.mode);
        await this.post(managed.panel, { type: "providers.status", providers: providerStatuses(), busy: this.providerRefresh !== undefined, errors: this.providerErrors, pluginUpdateMode: message.mode, versions: providerVersions() });
        return;
      case "providers.update":
        await this.updateProviderPluginsNow(message.version);
        return;
      case "providers.cli.install":
        await this.installProviderCliNow(message.provider, message.version);
        return;
      case "providers.versions.request":
        await refreshProviderVersions(this.context.extension?.packageJSON?.version);
        await this.broadcast({ type: "providers.status", providers: providerStatuses(), busy: this.providerRefresh !== undefined, errors: this.providerErrors, pluginUpdateMode: pluginUpdateMode(), versions: providerVersions() });
        await this.post(managed.panel, { type: "providers.catalog", catalog: await readProviderVersionCatalog(
          providerStatuses(), Object.fromEntries(Object.entries(providerVersions()).map(([id, value]) => [id, value?.plugin]))
        ) });
        return;
      case "task.delete": {
        const mainAgentId = message.mainAgentId || managed.state.agentId;
        if (!mainAgentId || (managed.state.role ?? "main") !== "main") return;
        const ownerState = managed.state;
        const current = () => !managed.disposed && !managed.sessionTransition && managed.state.agentId === ownerState.agentId &&
          managed.state.conversationId === ownerState.conversationId && this.sameProject(managed.state, ownerState);
        const key = this.agentIdentity({ ...ownerState, agentId: mainAgentId }) + "/" + message.workflowId + "/" + message.taskId;
        if (this.taskDeletesPending.has(key)) return;
        this.taskDeletesPending.add(key);
        try {
          const connection = await this.connectPanelRuntime(managed);
          if (!current()) return;
          if (!connection.available || !connection.client.deleteTask) throw new Error("Task history deletion is unavailable in this runtime");
          // Project history uses the recorded owner, checked again against fresh
          // runtime data. The screen cannot select an arbitrary Main session.
          if (mainAgentId !== managed.state.agentId) {
            const entry = (await connection.client.listProjectTasks?.())?.find(entry => entry.id === message.workflowId && entry.mainAgentId === mainAgentId);
            if (!entry?.tasks.some(task => task.id === message.taskId)) throw new Error("Task does not belong to the selected project history");
          }
          if (!current()) return;
          await connection.client.deleteTask(mainAgentId, message.workflowId, message.taskId);
          this.invalidateProjectHistory(ownerState);
          this.agentRefreshes.delete(connection.client);
          for (const panel of this.panels.values()) {
            if (panel.disposed || !this.sameProject(panel.state, ownerState) ||
                (!ownerState.projectRoot && !panel.state.projectRoot && panel.runtimeClient && panel.runtimeClient !== connection.client)) continue;
            await this.post(panel.panel, { type: "task.delete.result", mainAgentId, workflowId: message.workflowId, taskId: message.taskId });
            if (!panel.disposed && panel.state.agentId === mainAgentId) void this.sendAgentList(panel);
          }
        } catch (error) {
          if (!current()) return;
          await this.post(managed.panel, { type: "task.delete.result", mainAgentId, workflowId: message.workflowId, taskId: message.taskId, error: String(error) });
          await this.post(managed.panel, { type: "host.notice", level: "error", text: String(error) });
        } finally { this.taskDeletesPending.delete(key); }
        return;
      }
      case "task.stop": {
        if (!managed.state.agentId || (managed.state.role ?? "main") !== "main") return;
        const agentId = managed.state.agentId, conversationId = managed.state.conversationId;
        const revision = this.historyRevision(managed.state), projectRoot = managed.state.projectRoot;
        const current = () => !managed.disposed && !managed.sessionTransition && managed.state.agentId === agentId &&
          managed.state.conversationId === conversationId && managed.state.projectRoot === projectRoot && revision === this.historyRevision(managed.state);
        const key = this.agentIdentity(managed.state) + "/" + message.workflowId + "/" + message.taskId;
        if (this.taskStopsPending.has(key)) return;
        this.taskStopsPending.add(key);
        try {
          const connection = await this.connectPanelRuntime(managed);
          if (!current()) return;
          if (!connection.available || !connection.client.stopTask) throw new Error("Task stop is unavailable in this runtime");
          const snapshot = await connection.client.stopTask(agentId, message);
          if (!current()) return;
          const agents = await connection.client.listChildSessions(agentId);
          if (!current()) return;
          await this.post(managed.panel, { type: "agents.list", agents,
            ...(snapshot ? { workflows: [snapshot] } : {}) });
          if (!current()) return;
          await this.post(managed.panel, { type: "task.stop.result", workflowId: message.workflowId, taskId: message.taskId });
        } catch (error) {
          if (!current()) return;
          await this.post(managed.panel, { type: "task.stop.result", workflowId: message.workflowId, taskId: message.taskId, error: String(error) });
        } finally { this.taskStopsPending.delete(key); }
        return;
      }
      // These actions share one asynchronous conversation boundary and replay guard.
      case "workflow.close":
      case "workflow.answer":
      case "workflow.decision": {
        // Reaches the runtime only from a Human's click in this Main chat; no Agent output produces this message.
        if (!managed.state.agentId || (managed.state.role ?? "main") !== "main") return;
        const agentId = managed.state.agentId, conversationId = managed.state.conversationId;
        const revision = this.historyRevision(managed.state), projectRoot = managed.state.projectRoot;
        const current = () => !managed.disposed && !managed.sessionTransition && managed.state.agentId === agentId &&
          managed.state.conversationId === conversationId && managed.state.projectRoot === projectRoot && revision === this.historyRevision(managed.state);
        const key = JSON.stringify([this.agentIdentity(managed.state), message]);
        if (this.workflowActionsPending.has(key)) return;
        this.workflowActionsPending.add(key);
        try {
          const connection = await this.connectPanelRuntime(managed);
          if (!current()) return;
          let snapshot: Record<string, unknown>;
          if (message.type === "workflow.close") {
            if (!connection.available || !connection.client.closeWorkflow) throw new Error("Workflow closure is unavailable in this runtime");
            snapshot = await connection.client.closeWorkflow(agentId, message.workAgentId, message.loopId);
          } else if (message.type === "workflow.answer") {
            if (!connection.available || !connection.client.answerWorkflow) throw new Error("Workflow answers are unavailable in this runtime");
            snapshot = await connection.client.answerWorkflow(agentId, message.workAgentId, message.loopId, message.decisionId, message.questionHash, message.answer);
          } else {
            if (!connection.available || !connection.client.decideRevisionLimit) throw new Error("Revision-limit decisions are unavailable in this runtime");
            snapshot = await connection.client.decideRevisionLimit(agentId, message.workAgentId, message.loopId, message.decision);
          }
          if (!current()) return;
          const agents = await connection.client.listChildSessions(agentId);
          if (!current()) return;
          await this.post(managed.panel, { type: "agents.list", agents, workflows: [snapshot] });
        } catch (error) {
          if (!current()) return;
          await this.post(managed.panel, { type: "host.notice", level: "error", text: String(error) });
        } finally { this.workflowActionsPending.delete(key); }
        return;
      }
      case "contract.open": {
        const roots = contractRoots(managed.worktree?.workingDirectory, managed.state.projectRoot);
        const root = roots.find(candidate => existsSync(join(candidate, "docs", "progress", message.id))) ?? roots[0];
        if (!root) return;
        try { await openContractPanel(this.context.extensionUri, root, message.id, async () => {
          const connection = await this.connectPanelRuntime(managed);
          if (!connection.available || !managed.state.agentId) throw new Error("Runtime unavailable; execution status could not be refreshed");
          const agents = await connection.client.listChildSessions(managed.state.agentId);
          return await connection.client.advanceWorkflows?.(managed.state.agentId, agents, false) ?? [];
        }, async agentId => {
          if (agentId === managed.state.agentId) await this.openSidebarAgent(managed.state);
          else await this.openChildAgent(managed, agentId);
        }); }
        catch (error) { await vscode.window.showErrorMessage(String(error)); }
        return;
      }
      case "contracts.request": {
        // Contracts are project records: list the project's, plus any still only on this chat's isolated branch.
        try {
          const lists = await Promise.all(contractRoots(managed.worktree?.workingDirectory, managed.state.projectRoot).map(listContracts));
          const contracts = lists.flat().filter((entry, index, all) =>
            all.findIndex(other => other.id === entry.id && other.version === entry.version) === index)
            .sort((a, b) => a.id.localeCompare(b.id) || Number(b.version) - Number(a.version));
          await this.post(managed.panel, { type: "contracts.list", contracts });
        } catch (error) {
          await this.post(managed.panel, { type: "contracts.list", contracts: [], error: String(error) });
        }
        return;
      }
      case "control.center.open": {
        const selection = message.workflowId && message.taskId ? { workflowId: message.workflowId, taskId: message.taskId } : undefined;
        await this.openControlCenter(managed.state, selection);
        return;
      }
      case "domain.create":
      case "domain.rename":
      case "domain.assign": {
        // Domain edits come from the control center; the same Human edit path serves any webview of this project.
        const root = managed.state.projectRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) throw new Error(localize("ui.no.workspace"));
        await this.editProjectDomains(root, message);
        return;
      }
      case "worker.command":
      case "worker.stop":
      case "worker.remove":
      case "worker.handoff":
      case "worker.order":
      case "supervision.request":
      case "handoff.models.request":
        // Worker control belongs to the control center tab, which confirms and binds the exact worker; chat tabs ignore it.
        return;
      case "project.task.open": {
        const root = managed.state.projectRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) throw new Error(localize("ui.no.workspace"));
        await this.openProjectTask(root, message);
        return;
      }
      case "project.tasks.request": {
        const historyRevision = this.historyRevision(managed.state), projectRoot = managed.state.projectRoot;
        try {
          const connection = await this.connectPanelRuntime(managed);
          if (!connection.available) throw new Error(connection.diagnostic);
          const entries = await connection.client.listProjectTasks?.() ?? [];
          if (managed.disposed || managed.state.projectRoot !== projectRoot || historyRevision !== this.historyRevision(managed.state)) return;
          await this.post(managed.panel, { type: "project.tasks", entries });
        } catch (error) {
          if (managed.disposed || managed.state.projectRoot !== projectRoot || historyRevision !== this.historyRevision(managed.state)) return;
          await this.post(managed.panel, { type: "project.tasks", entries: [], error: String(error) });
        }
        return;
      }
      case "conversations.request":
      case "conversation.read": {
        const agentId = managed.state.agentId;
        try {
          if (!agentId) {
            if (message.type === "conversations.request") await this.post(managed.panel, { type: "conversations.list", conversations: [] });
            return;
          }
          const connection = await this.connectPanelRuntime(managed);
          if (!connection.available) throw new Error(connection.diagnostic);
          if (message.type === "conversations.request") {
            if (!connection.client.conversations) throw new Error("Conversation history is unavailable.");
            const conversations = await connection.client.conversations(agentId);
            if (managed.state.agentId === agentId) await this.post(managed.panel, { type: "conversations.list", conversations });
          } else {
            if (!connection.client.history) throw new Error("Conversation history is unavailable.");
            const history = await connection.client.history(agentId, { limit: 50, conversationId: message.conversationId, before: message.before });
            if (managed.state.agentId === agentId) await this.post(managed.panel, { type: "conversation.read.result", requestId: message.requestId, history });
          }
        } catch (error) {
          if (managed.state.agentId !== agentId) return;
          const detail = error instanceof Error ? error.message : String(error);
          await this.post(managed.panel, message.type === "conversations.request"
            ? { type: "conversations.list", conversations: [], error: detail }
            : { type: "conversation.read.result", requestId: message.requestId, error: detail });
        }
        return;
      }
      case "notes.folder":
      case "notes.list":
      case "notes.save": {
        this.noteStore ??= new NoteStore(this.context.globalState, this.context.workspaceState);
        try {
          if (message.type === "notes.list" || message.type === "notes.folder") {
            if (message.type === "notes.folder") await this.noteStore.createFolder(message.scope, message.folder);
            await this.post(managed.panel, { type: "notes.list.result", scope: message.scope, notes: await this.noteStore.list(message.scope), folders: await this.noteStore.folders(message.scope) });
          } else {
            const note = await this.noteStore.save(message.scope, message.note);
            await this.post(managed.panel, { type: "notes.save.result", scope: message.scope, id: note.id, note });
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          await this.post(managed.panel, (message.type === "notes.list" || message.type === "notes.folder")
            ? { type: "notes.list.result", scope: message.scope, notes: [], error: detail }
            : { type: "notes.save.result", scope: message.scope, id: message.note.id, error: detail });
        }
        return;
      }
      case "history.request": {
        const connection = await this.connectPanelRuntime(managed);
        if (connection.available) await this.restoreConversationHistory(managed, connection.client, message.before);
        return;
      }
      case "agents.request":
        await this.sendAgentList(managed);
        return;
      case "agent.open":
        await this.openChildAgent(managed, message.agentId, message.runId);
        return;
      case "session.select":
        if (managed.sessionTransition) {
          await this.post(managed.panel, { type: "host.notice", level: "warning", text: localize("ui.another.session.is.loading") });
          return;
        }
        const transition = this.selectSession(managed, message.agentId);
        managed.sessionTransition = transition;
        try {
          await transition;
        } finally {
          if (managed.sessionTransition === transition) managed.sessionTransition = undefined;
        }
        return;
      case "attachments.pick":
        await this.mutateImages(managed, () => this.pickAttachments(managed));
        return;
      case "attachments.addUris":
        await this.mutateImages(managed, () => this.addUriAttachments(managed, message.uris));
        return;
      case "attachments.createText":
        await this.createTextAttachment(managed, message.text);
        return;
      case "attachments.createImage":
        await this.mutateImages(managed, () => this.createImageAttachment(managed, message));
        return;
      case "attachments.createFile":
        await this.mutateImages(managed, () => this.createFileAttachment(managed, message));
        return;
      case "attachments.restore":
        await this.mutateImages(managed, () => this.restoreImageAttachments(managed, message.attachments));
        return;
      case "attachment.convert":
        await this.convertImageAttachment(managed, message.id, message.name, message.requestId, message.mediaType);
        break;
      case "attachment.converted":
        await this.finishImageConversion(managed, message);
        break;
      case "attachment.revealConverted": {
        const path = managed.convertedImages?.get(message.id);
        if (path) await vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(path));
        break;
      }
      case "attachment.conversionFailed":
        if (managed.imageConversions?.delete(message.id)) {
          await this.post(managed.panel, { type: "attachment.conversionResult", id: message.id, error: localize("attachment.convert.failed") });
        }
        break;
      case "attachment.open":
        await this.openImageAttachment(managed, message.id);
        return;
      case "attachment.remove":
        await this.mutateImages(managed, () => this.removeImageAttachment(managed, message.id));
        return;
      case "bot.interact":
        if (this.botCharacter() !== "lumi" || !this.botsEnabled()) return;
        this.companionWrite = this.companionWrite.catch(() => {}).then(async () => {
          const next = interactCompanion(this.companionState(), message.action);
          await this.context.globalState.update("agentFactory.companion.v1", next);
          this.broadcastCompanion();
        });
        await this.companionWrite;
        return;
      case "bots.configure":
        await this.saveBots(message.enabled);
        return;
      case "bot.talk": {
        if (!this.botsEnabled() || managed.disposed) {
          await this.post(managed.panel, { type: "bot.reply", requestId: message.requestId, failed: true });
          return;
        }
        const bot = managed.lunaBot ??= new LunaBot();
        const character = this.botCharacter();
        const prompt = resolveBotPrompt(character, this.botPrompt());
        const model = this.botModel();
        const conversation = this.botConversationWrite.catch(() => {}).then(async () => {
          try {
            if (managed.disposed || !this.botsEnabled() || managed.lunaBot !== bot) return;
            if (character === "lumi") {
              this.companionWrite = this.companionWrite.catch(() => {}).then(async () => {
                await this.context.globalState.update("agentFactory.companion.v1", interactCompanion(this.companionState(), "call"));
                this.broadcastCompanion();
              });
              await this.companionWrite;
            }
            const key = "agentFactory.botConversation.v1." + character;
            const history = this.context.globalState.get<BotMessage[]>(key, []);
            const text = await bot.talk(message.text, prompt, model, history, partial => {
              if (!managed.disposed && this.botsEnabled() && managed.lunaBot === bot)
                void this.post(managed.panel, { type: "bot.reply.partial", requestId: message.requestId, text: partial });
            });
            if (managed.disposed || !this.botsEnabled() || managed.lunaBot !== bot) return;
            await this.context.globalState.update(key, [...history,
              { role: "user", content: message.text }, { role: "assistant", content: text }]);
            if (!managed.disposed && this.botsEnabled() && managed.lunaBot === bot)
              await this.post(managed.panel, { type: "bot.reply", requestId: message.requestId, text, emotion: bot.lastEmotion });
          } catch {
            if (!managed.disposed && this.botsEnabled() && managed.lunaBot === bot)
              await this.post(managed.panel, { type: "bot.reply", requestId: message.requestId, failed: true });
          }
        });
        this.botConversationWrite = conversation.catch(() => {});
        await conversation;
        return;
      }
      case "bot.character.save": {
        if (message.character === "lumi" && !localCompanionAvailable) return;
        const write = this.botsWrite.then(() => vscode.workspace.getConfiguration("agentFactory.mainChat")
          .update("botCharacter", message.character, vscode.ConfigurationTarget.Global));
        this.botsWrite = write.then(() => {}, () => {});
        try { await write; } catch { /* Restore the persisted selection in every panel. */ }
        await this.refreshBots();
        this.broadcastCompanion();
        return;
      }
      case "bot.model.save": {
        const write = this.botsWrite.then(() => vscode.workspace.getConfiguration("agentFactory.mainChat")
          .update("botModel", message.model, vscode.ConfigurationTarget.Global));
        this.botsWrite = write.then(() => {}, () => {});
        try {
          await write;
          await this.refreshBots();
          await this.post(managed.panel, { type: "bot.model.saved", model: this.botModel() });
        } catch {
          await this.post(managed.panel, { type: "bot.model.saved", model: this.botModel(), failed: true });
        }
        return;
      }
      case "bot.prompt.save": {
        const character = message.character ?? this.botCharacter();
        const customPrompt = message.prompt === BOT_DEFAULT_PROMPTS[character] ? "" : message.prompt;
        const write = this.botsWrite.then(() => vscode.workspace.getConfiguration("agentFactory.mainChat")
          .update(character === "lumi" ? "lumiPrompt" : "factoryBotPrompt", customPrompt, vscode.ConfigurationTarget.Global));
        this.botsWrite = write.then(() => {}, () => {});
        try {
          await write;
          await this.refreshBots();
          await this.post(managed.panel, { type: "bot.prompt.saved", requestId: message.requestId, prompt: resolveBotPrompt(character, customPrompt) });
        } catch {
          await this.post(managed.panel, { type: "bot.prompt.saved", requestId: message.requestId, failed: true });
        }
        return;
      }
      case "status.reorder":
        await this.saveStatusItems(managed.panel, message.items);
        return;
    }
  }

  private async openLink(managed: ManagedPanel, href: string): Promise<void> {
    try {
      if (/^(?:https?:\/\/|mailto:)/i.test(href)) {
        await vscode.env.openExternal(vscode.Uri.parse(href, true));
        return;
      }

      const target = parseLocalLink(href);
      const workspaceRoot = managed.worktree?.workingDirectory ?? managed.state?.projectRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const filePath = isAbsolute(target.path)
        ? target.path
        : resolve(workspaceRoot ?? this.context.extensionUri.fsPath, target.path);
      const uri = vscode.Uri.file(filePath);
      // Archives are downloadable artifacts, not text documents or editor previews.
      if (/\.(?:zip|7z|rar|tar|tgz|gz|bz2|xz)$/i.test(filePath)) {
        const destination = await vscode.window.showSaveDialog({ defaultUri: uri });
        if (!destination) return;
        if (destination.scheme === uri.scheme && destination.authority === uri.authority && destination.path === uri.path) return;
        await vscode.workspace.fs.copy(uri, destination, { overwrite: true });
        return;
      }
      // Let VS Code select the file's editor (including the remote image viewer).
      // Explicit line links still require a text editor for selection/reveal.
      if (target.line === undefined) {
        await vscode.commands.executeCommand("vscode.open", uri, { preview: true });
        return;
      }
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, { preview: true });
      if (target.line !== undefined) {
        const position = new vscode.Position(Math.max(0, target.line - 1), Math.max(0, (target.column ?? 1) - 1));
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    } catch (error) {
      await this.post(managed.panel, {
        type: "host.notice",
        level: "error",
        text: localize("ui.unable.to.open.the.link.0", error instanceof Error ? describeLocalizedMessage(error.message) ?? error.message : String(error))
      });
    }
  }

  private defaultExecutionMode(): import("../agent-factory/agent-client").ExecutionMode {
    const value = vscode.workspace.getConfiguration?.("agentFactory.mainChat").get<string>("executionMode", "danger-full-access");
    return value === "cli-default" || value === "workspace-write" || value === "bypass" ? value : "danger-full-access";
  }

  private async selectExecutionMode(
    managed: ManagedPanel,
    mode: import("../agent-factory/agent-client").ExecutionMode
  ): Promise<void> {
    if (managed.controller?.running || (managed.state.role ?? "main") !== "main") return;
    managed.executionMode = mode;
    managed.executionModeExplicit = true;
    await vscode.workspace.getConfiguration("agentFactory.mainChat").update("executionMode", mode,
      vscode.ConfigurationTarget.Global);
    await this.post(managed.panel, { type: "execution.updated", mode });
  }

  private async sendSessionList(managed: ManagedPanel): Promise<void> {
    const connection = await this.connectPanelRuntime(managed);
    if (!connection.available) {
      await this.post(managed.panel, { type: "sessions.list", sessions: [] });
      await this.post(managed.panel, { type: "host.notice", level: "error", text: connection.diagnostic });
      return;
    }
    try {
      const sessions = (await connection.client.listSessions()).filter(session =>
        !this.removedChat({ ...managed.state, agentId: session.agentId }));
      await this.post(managed.panel, { type: "sessions.list", sessions });
    } catch (error) {
      await this.post(managed.panel, { type: "sessions.list", sessions: [] });
      await this.post(managed.panel, {
        type: "host.notice",
        level: "error",
        text: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private providerRefresh?: Promise<void>;
  private providerRefreshQueued = false;
  private providerErrors: Partial<Record<ProviderId, string>> = {};

  /** Detect provider CLIs again and bring every open chat up to date without a window reload. */
  public refreshProviders(): Promise<void> {
    if (this.providerRefresh) {
      this.providerRefreshQueued = true;
      return this.providerRefresh;
    }
    const refresh = (async () => {
      try {
        do {
          this.providerRefreshQueued = false;
          await this.broadcast({ type: "providers.status", providers: providerStatuses(), busy: true, errors: this.providerErrors, pluginUpdateMode: pluginUpdateMode(), versions: providerVersions() });
          this.providerErrors = { ...(await redetectProviders(this.context)).errors };
        } while (this.providerRefreshQueued);
      } catch (error) {
        console.error("[Agent Factory] Provider detection failed", error);
      } finally {
        this.providerRefresh = undefined;
      }
      await this.broadcast({ type: "providers.status", providers: providerStatuses(), busy: false, errors: this.providerErrors, pluginUpdateMode: pluginUpdateMode(), versions: providerVersions() });
      try {
        for (const managed of this.panels.values()) {
          if (managed.disposed) continue;
          const connection = await this.connectPanelRuntime(managed);
          await this.sendModelList(managed);
          const capabilities = connection.available
            ? await connection.client.capabilities(managed.state.agentId, this.effectiveModel(managed)).catch(() => undefined) : undefined;
          await this.post(managed.panel, { type: "runtime.updated", runtimeAvailable: connection.available, capabilities });
        }
      } catch (error) {
        console.error("[Agent Factory] Runtime refresh after provider detection failed", error);
      }
    })();
    this.providerRefresh = refresh;
    return refresh;
  }

  /** Update Agent Factory plugins for all detected providers. */
  public updateProviderPluginsNow(version?: string): Promise<void> {
    if (this.providerRefresh) return this.providerRefresh;
    const refresh = (async () => {
      try {
        await this.broadcast({ type: "providers.status", providers: providerStatuses(), busy: true, errors: this.providerErrors, pluginUpdateMode: pluginUpdateMode(), versions: providerVersions() });
        this.providerErrors = { ...this.providerErrors, ...(await updateProviderPlugins(this.context, version)) };
        await refreshProviderVersions(this.context.extension?.packageJSON?.version);
      } catch (error) {
        console.error("[Agent Factory] Provider plugin update failed", error);
      } finally {
        this.providerRefresh = undefined;
      }
      await this.broadcast({ type: "providers.status", providers: providerStatuses(), busy: false, errors: this.providerErrors, pluginUpdateMode: pluginUpdateMode(), versions: providerVersions() });
    })();
    this.providerRefresh = refresh;
    return refresh;
  }

  private installProviderCliNow(provider: "codex" | "claude", version: string): Promise<void> {
    if (this.providerRefresh) return this.providerRefresh;
    const selected = providerStatuses().find(status => status.id === provider && status.detected && status.path);
    const executable = selected?.path;
    if (!executable) return Promise.resolve();
    const refresh = (async () => {
      try {
        await this.broadcast({ type: "providers.status", providers: providerStatuses(), busy: true, errors: this.providerErrors, pluginUpdateMode: pluginUpdateMode(), versions: providerVersions() });
        await installProviderCliVersion(provider, executable, version);
        this.providerErrors = { ...(await redetectProviders(this.context)).errors };
        await refreshProviderVersions(this.context.extension?.packageJSON?.version);
      } catch (error) {
        await this.broadcast({ type: "host.notice", level: "error", text: error instanceof Error ? error.message : String(error) });
      } finally {
        this.providerRefresh = undefined;
      }
      await this.broadcast({ type: "providers.status", providers: providerStatuses(), busy: false, errors: this.providerErrors, pluginUpdateMode: pluginUpdateMode(), versions: providerVersions() });
    })();
    this.providerRefresh = refresh;
    return refresh;
  }

  private async broadcast(message: HostMessage): Promise<void> {
    await Promise.all([...this.panels.values()].filter(managed => !managed.disposed).map(managed => this.post(managed.panel, message)));
  }

  private async sendModelList(managed: ManagedPanel): Promise<void> {
    // Undetected providers contribute no models; with none detected the picker is empty.
    const models = await readProviderModels(undefined, undefined, undefined, undefined, {
      codex: isProviderDetected("codex"), claude: isProviderDetected("claude"), antigravity: isProviderDetected("antigravity")
    });
    if (models !== undefined) await this.post(managed.panel, { type: "models.list", models });
  }

  private async sendAgentList(managed: ManagedPanel): Promise<void> {
    if (!managed.state.agentId || (managed.state.role ?? "main") !== "main") {
      managed.activeChildRuns = [];
      this.refreshTabLoading(managed);
      await this.post(managed.panel, { type: "agents.list", agents: [] });
      return;
    }
    const agentId = managed.state.agentId;
    const conversationId = managed.state.conversationId;
    const historyRevision = this.historyRevision(managed.state), projectRoot = managed.state.projectRoot;
    if (managed.disposed || managed.agentRefreshInFlight) return;
    managed.agentRefreshInFlight = true;
    try {
      const connection = await this.connectPanelRuntime(managed);
      if (!connection.available) return;
      const { agents, workflows } = await this.sharedAgentRefresh(connection.client, agentId);
      if (managed.disposed || managed.sessionTransition || managed.state.agentId !== agentId ||
          managed.state.conversationId !== conversationId || managed.state.projectRoot !== projectRoot || historyRevision !== this.historyRevision(managed.state)) return;
      managed.activeChildRuns = agents;
      this.refreshTabLoading(managed);
      this.notifyAgents();
      await this.post(managed.panel, { type: "agents.list", agents, workflows, ...(workflows ? { workflowsComplete: true } : {}) });
      if (workflows) managed.contractWorkflows = workflows;
      if (workflows) await this.reportWorkflowResults(managed, workflows, connection.client);
      await this.continueBackgroundWork(managed, agents.filter(agent => !workflows?.some(flow => flow.workAgentId === agent.agentId || flow.verificationAgentId === agent.agentId ||
        (Array.isArray((flow.workflow as { tasks?: unknown[] } | undefined)?.tasks) &&
          ((flow.workflow as { tasks: { workAgentId?: string; verificationAgentId?: string }[] }).tasks).some(task =>
            task.workAgentId === agent.agentId || task.verificationAgentId === agent.agentId)))), connection.client);
    } catch (error) {
      if (managed.disposed || managed.sessionTransition || managed.state.agentId !== agentId ||
          managed.state.conversationId !== conversationId || managed.state.projectRoot !== projectRoot || historyRevision !== this.historyRevision(managed.state)) return;
      await this.post(managed.panel, {
        type: "host.notice",
        level: "error",
        text: error instanceof Error ? error.message : String(error)
      });
    } finally {
      managed.agentRefreshInFlight = false;
      managed.lastAgentRefreshAt = Date.now();
      if (!managed.disposed && managed.state.agentId === agentId) this.scheduleAgentList(managed);
    }
  }

  private sharedAgentRefresh(client: AgentRuntimeClient, agentId: string): Promise<{
    readonly agents: readonly import("../agent-factory/agent-client").ChildAgentSession[];
    readonly workflows: readonly Record<string, unknown>[] | undefined;
  }> {
    let byAgent = this.agentRefreshes.get(client);
    if (!byAgent) {
      byAgent = new Map();
      this.agentRefreshes.set(client, byAgent);
    }
    const existing = byAgent.get(agentId);
    if (existing) return existing;
    const refresh = (async () => {
      const agents = await client.listChildSessions(agentId);
      // The runtime loop driver owns progression. UI refresh observes status only.
      const workflows = await client.advanceWorkflows?.(agentId, agents, false);
      return { agents, workflows };
    })();
    byAgent.set(agentId, refresh);
    void refresh.finally(() => {
      if (byAgent?.get(agentId) === refresh) byAgent.delete(agentId);
    }).catch(() => {});
    return refresh;
  }

  private claimTerminalDelivery(owner: object, key: string): (() => void) | undefined {
    let claims = this.terminalDeliveryClaims.get(owner);
    if (!claims) {
      claims = new Set();
      this.terminalDeliveryClaims.set(owner, claims);
    }
    if (claims.has(key)) return undefined;
    claims.add(key);
    return () => { claims?.delete(key); };
  }

  private projectDeliveryOwner(state: ChatPanelState, fallback: object): object {
    if (!state.projectRoot) return fallback;
    let owner = this.projectDeliveryOwners.get(state.projectRoot);
    if (!owner) { owner = {}; this.projectDeliveryOwners.set(state.projectRoot, owner); }
    return owner;
  }

  private async persistTerminalDeliveries(key: string, values: Record<string, unknown>, current: () => boolean, onlyMissing = false): Promise<void> {
    // Memento updates replace the whole value. Serialize merges so completions
    // from different panels cannot erase each other's durable acknowledgement.
    const write = (this.terminalDeliveryWrites.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (!current()) return;
      const existing = this.context.workspaceState?.get<Record<string, unknown>>(key);
      await this.context.workspaceState?.update(key, onlyMissing ? { ...values, ...existing } : { ...existing, ...values });
    });
    this.terminalDeliveryWrites.set(key, write);
    try { await write; }
    finally { if (this.terminalDeliveryWrites.get(key) === write) this.terminalDeliveryWrites.delete(key); }
  }

  private async reportWorkflowResults(managed: ManagedPanel, workflows: readonly Record<string, unknown>[], owner: object = this): Promise<void> {
    owner = this.projectDeliveryOwner(managed.state, owner);
    const agentId = managed.state.agentId;
    const conversationId = managed.state.conversationId;
    const revision = this.historyRevision(managed.state), projectRoot = managed.state.projectRoot;
    const current = () => !managed.disposed && !managed.sessionTransition && managed.state.agentId === agentId &&
      managed.state.conversationId === conversationId && managed.state.projectRoot === projectRoot && this.historyRevision(managed.state) === revision;
    const key = this.deliveryStorageKey("agentFactory.workflowResults.", managed.state);
    type Delivery = { identity: string; state: "prepared" | "accepted" | "completed" | "failed" | "blocked";
      dispatchId: string; message: string; attempt: number; runId?: string; error?: string };
    for (const flow of workflows) {
      if (typeof flow.loopId !== "string" || typeof flow.status !== "string" || flow.status === "active") continue;
      const eligible = () => current() && ![...this.taskDeletesPending].some(key =>
        key.startsWith(`${this.agentIdentity(managed.state)}/${(flow.workflow as { id?: string } | undefined)?.id}/`));
      if (!eligible() || (flow.parentAgentId !== undefined && flow.parentAgentId !== agentId) ||
          (flow.parentConversationId ?? undefined) !== conversationId) continue;
      const identity = JSON.stringify([flow.loopId, flow.status, flow.latestWorkRunId, flow.latestVerificationRunId,
        flow.terminalReason, flow.controlPlaneError, flow.pendingDecision]);
      // Error wording, object field order and diagnostic refreshes are not new
      // completion events. Keep the original bytes/key of an existing delivery.
      const eventIdentity = (value: string): string => {
        try {
          const fields = JSON.parse(value);
          const decision = fields[6];
          return JSON.stringify([fields[0], fields[1], fields[2], fields[3], decision?.id, decision?.questionHash, decision?.status]);
        } catch { return value; }
      };
      const states = { ...this.context.workspaceState?.get<Record<string, Delivery | string>>(key) };
      const stored = states[flow.loopId];
      if (typeof stored === "string" && eventIdentity(stored) === eventIdentity(identity)) continue;
      let previous = typeof stored === "object" && eventIdentity(stored.identity) === eventIdentity(identity) ? stored : undefined;
      if (previous && ["completed", "blocked", "failed"].includes(previous.state)) continue;
      const persistDelivery = async (value: Delivery): Promise<void> => {
        await this.persistTerminalDeliveries(key, { [flow.loopId as string]: value }, eligible);
      };
      if (previous && !previous.runId && previous.dispatchId.startsWith("dispatch-")) {
        const connection = await this.connectPanelRuntime(managed);
        if (!connection.available || !connection.client.dispatchAcceptance || !agentId) continue;
        // A lost ACK may already own a run. Observe it without sending the same
        // notification through the controller again (which replays its output).
        const accepted = await connection.client.dispatchAcceptance(agentId, previous.dispatchId);
        if (!current()) return;
        if (accepted) {
          previous = { ...previous, state: "accepted", runId: accepted.runId };
          await persistDelivery(previous);
        }
      }
      if (previous?.runId && previous.state !== "failed" && managed.state.agentId) {
        const connection = await this.connectPanelRuntime(managed);
        if (!connection.available) continue;
        // A failed task can have a successfully delivered failure report. A
        // transport failure or missing result is not a delivered report.
        try {
          const report = await connection.client.result(agentId!, previous.runId);
          if (!["completed", "failed", "cancelled", "needs-human-decision"].includes(report.status)) continue;
          const delivered = ["completed", "failed", "needs-human-decision"].includes(report.status)
            && !report.error && !report.goalError && Boolean(report.text.trim());
          previous = { ...previous, state: delivered ? "completed" : "failed" };
          await persistDelivery(previous);
          // Cancellation/failure ends this report attempt; polling must not
          // create another Main run. A Human can request a report explicitly.
          continue;
        } catch { continue; } // Observation loss never establishes submission failure.
      }
      if (!eligible() || managed.backgroundContinuation || managed.controller?.running ||
          managed.pendingMessageIds?.size || !managed.controller || managed.controller.conversationResetBlockedReason) continue;
      const releaseClaim = this.claimTerminalDelivery(owner, `${managed.state.agentId}:workflow:${eventIdentity(identity)}`);
      if (!releaseClaim) continue;
      const attempt = previous?.attempt ?? 1;
      const message = previous?.message ?? `[Engine workflow result — not a new Human request]
${JSON.stringify(flow)}
The engine owns execution. Read and acknowledge the exact stored result/receipt identity and report the result or exception. Distinguish Work completion, checks, integration, preservation, cleanup and required input. Do not review implementation or rerun tests. Goal completion alone is not a pass. Do not redispatch Work or grant missing approval.${flow.pendingDecision ? "\nTreat pendingDecision.question as internal worker context. In the Main conversation, summarize the blocker and ask only the concrete question that requires the Human's input. Do not paste the internal report or ask the Human to resolve routine internal bookkeeping. If no Human-owned choice or missing input is identified, report the execution exception without inventing an approval request. Preserve the loop and decision identity; relay an actual Human answer through the existing loop answer command only after it is received." : ""}`;
      let delivery: Delivery = previous ?? {
        identity, state: "prepared", attempt, message,
        dispatchId: "dispatch-report-" + createHash("sha256").update(eventIdentity(identity)).digest("hex").slice(0, 32) + "-" + attempt
      };
      // Old report-* keys were rejected before dispatch acceptance. Only migrate
      // the exact legacy key without acceptance evidence; keep text and attempt.
      const legacyId = "report-" + createHash("sha256").update(delivery.identity).digest("hex").slice(0, 32) + "-" + attempt;
      if (delivery.state === "prepared" && !delivery.runId && delivery.dispatchId === legacyId) {
        delivery = { ...delivery, dispatchId: "dispatch-" + legacyId };
      }
      if (!DISPATCH_ID.test(delivery.dispatchId)) {
        const error = localize("workflow.report.invalid.dispatch");
        try {
          await persistDelivery({ ...delivery, state: "blocked", error });
          await this.post(managed.panel, { type: "host.notice", level: "error", text: error });
        } finally { releaseClaim(); }
        continue;
      }
      managed.backgroundContinuation = true;
      try {
        if (!previous && agentId) {
          const connection = await this.connectPanelRuntime(managed);
          if (!eligible()) { managed.backgroundContinuation = false; releaseClaim(); return; }
          if (!connection.available) { managed.backgroundContinuation = false; releaseClaim(); continue; }
          if (connection.client.dispatchAcceptance) {
            // The latest event's local record can have replaced an earlier one.
            // Runtime acceptance is the durable ledger for out-of-order replay.
            let acceptedId = delivery.dispatchId;
            let accepted = await connection.client.dispatchAcceptance(agentId, acceptedId);
            if (!accepted) {
              acceptedId = "dispatch-" + legacyId;
              accepted = await connection.client.dispatchAcceptance(agentId, acceptedId);
            }
            if (accepted) {
              await persistDelivery({ ...delivery, dispatchId: acceptedId, state: "accepted", runId: accepted.runId });
              managed.backgroundContinuation = false;
              releaseClaim();
              continue;
            }
          }
        }
        // Persist intent before sending. A lost ACK reuses both text and dispatch
        // identity, so the runtime adopts the accepted run instead of duplicating it.
        await persistDelivery(delivery);
      } catch (error) {
        managed.backgroundContinuation = false;
        releaseClaim();
        throw error;
      }
      if (!eligible()) { managed.backgroundContinuation = false; releaseClaim(); return; }
      let persisted: PromiseLike<void> | undefined;
      let failure: { error: unknown } | undefined;
      const controller = managed.controller;
      void controller.send(delivery.message, [], { taskMode: "direct", deliveryId: delivery.dispatchId }, () => {
        const runId = controller.runId;
        delivery = { ...delivery, state: "accepted", ...(runId ? { runId } : {}) };
        persisted = persistDelivery(delivery);
      }, error => { failure = { error }; }).then(async () => {
        await persisted;
        if (!eligible()) return;
        if (failure) throw failure.error;
        if (!delivery.runId || !agentId) return;
        const connection = await this.connectPanelRuntime(managed);
        if (!connection.available || !eligible()) return;
        const report = await connection.client.result(agentId, delivery.runId);
        if (!["completed", "failed", "cancelled", "needs-human-decision"].includes(report.status)) return;
        const delivered = ["completed", "failed", "needs-human-decision"].includes(report.status)
          && !report.error && !report.goalError && Boolean(report.text.trim());
        await persistDelivery({ ...delivery, state: delivered ? "completed" : "failed" });
      }).catch(async error => {
        if (!eligible()) return;
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        const text = String(error);
        const rejected = !delivery.runId && (["invalid_dispatch_id", "dispatch_id_collision", "request_invalid"].includes(String(code))
          || /^Error: dispatch id must match dispatch-/.test(text));
        // Permanent request errors cannot recover by replaying the same request.
        // Ambiguous failures retain the exact key for runtime deduplication.
        await persistDelivery({ ...delivery, ...(rejected ? { state: "blocked" as const } : {}), error: text });
        if (eligible() && delivery.error !== text) await this.post(managed.panel, { type: "host.notice", level: "error", text });
      }).finally(() => { managed.backgroundContinuation = false; releaseClaim(); });
    }
  }

  private async continueBackgroundWork(managed: ManagedPanel, agents: readonly import("../agent-factory/agent-client").ChildAgentSession[], owner: object = this): Promise<void> {
    owner = this.projectDeliveryOwner(managed.state, owner);
    const agentId = managed.state.agentId;
    const conversationId = managed.state.conversationId;
    const revision = this.historyRevision(managed.state), projectRoot = managed.state.projectRoot;
    const current = () => !managed.disposed && !managed.sessionTransition && managed.state.agentId === agentId &&
      managed.state.conversationId === conversationId && managed.state.projectRoot === projectRoot && this.historyRevision(managed.state) === revision;
    const key = this.deliveryStorageKey("agentFactory.background.", managed.state);
    type Delivery = { identity: string; state: "prepared" | "accepted" | "blocked";
      dispatchId: string; message: string; runId?: string; error?: string };
    const saved = this.context.workspaceState?.get<Record<string, string | Delivery>>(key);
    const states = { ...saved };
    const differentStatus = (stored: Delivery, child: import("../agent-factory/agent-client").ChildAgentSession): boolean => {
      try {
        const captured: unknown = JSON.parse(stored.identity);
        return Array.isArray(captured) && captured.length === 4 &&
          captured[0] === agentId && captured[1] === child.agentId && captured[2] === child.runId && captured[3] !== child.status;
      } catch { return false; }
    };
    const observed: Record<string, string> = {};
    const terminal = new Set(["completed", "failed", "cancelled", "needs-human-decision"]);
    const pending = [];
    for (const agent of agents) {
      if (!agent.runId) continue;
      if (agent.currentConversation === false || agent.parentConversationId !== conversationId ||
          [...this.taskDeletesPending].some(key => key === `${this.agentIdentity(managed.state)}/${agent.taskBinding?.workflowId}/${agent.taskBinding?.taskId}`)) continue;
      const id = `${agent.agentId}/${agent.runId}`;
      if (!saved) observed[id] = states[id] = agent.status;
      else if (terminal.has(agent.status) && states[id] !== agent.status
          // Legacy attempts had no dispatch identity. Their acceptance cannot be
          // reconstructed safely; preserve their duplicate suppression.
          && states[id] !== `delivery-error:${agent.status}`) pending.push(agent);
      else if (!terminal.has(agent.status) && typeof states[id] !== "object") observed[id] = states[id] = agent.status;
    }
    if (Object.keys(observed).length || !saved) {
      await this.persistTerminalDeliveries(key, observed, current);
      Object.assign(states, this.context.workspaceState?.get<Record<string, string | Delivery>>(key));
    }
    if (!current() || managed.backgroundContinuation || managed.controller?.running ||
        managed.pendingMessageIds?.size || !managed.controller || managed.controller.conversationResetBlockedReason || !pending.length) return;
    const child = pending.find(child => {
      const stored = states[`${child.agentId}/${child.runId}`];
      return child.taskMode && child.taskMode !== "direct" &&
        !(typeof stored === "object" && !differentStatus(stored, child) && ["accepted", "blocked"].includes(stored.state));
    });
    if (!child) return;
    const eligible = () => current() && !this.taskDeletesPending.has(`${this.agentIdentity(managed.state)}/${child.taskBinding?.workflowId}/${child.taskBinding?.taskId}`);
    const id = `${child.agentId}/${child.runId}`;
    const identity = JSON.stringify([managed.state.agentId, child.agentId, child.runId, child.status]);
    const stored = states[id];
    const previous = typeof stored === "object" && !differentStatus(stored, child) ? stored : undefined;
    const releaseClaim = this.claimTerminalDelivery(owner,
      `${managed.state.agentId}:child:${child.agentId}:${child.runId}:${child.status}`);
    if (!releaseClaim) return;
    managed.backgroundContinuation = true;
    const notification = previous?.message ?? `[Background workflow continuation — not a new Human request]
${JSON.stringify(child)}
Read the exact stored child result/receipt and existing workflow status for reporting. The engine owns loop transitions; do not reconcile or advance the loop, redispatch completed Work, review implementation or rerun tests. Goal completion is not a Verification pass. Preserve the accepted identities and captured route. If the child needs a Human decision or failed, report it; do not automatically grant approval or retry failed work. Report completion only when the captured route has completed; otherwise report the current stage and return promptly. When the workflow is bound to a work contract, record the terminal task statuses and result/receipt evidence in its Main-owned progress record. Answer any pending Human questions while preserving this workflow.`;
    let delivery: Delivery = previous ?? { identity, state: "prepared", message: notification,
      dispatchId: "dispatch-child-" + createHash("sha256").update(identity).digest("hex").slice(0, 32) };
    const persistDelivery = async (value: Delivery): Promise<void> => {
      await this.persistTerminalDeliveries(key, { [id]: value }, eligible);
    };
    let persisted: PromiseLike<void> | undefined;
    let failure: { error: unknown } | undefined;
    const finish = () => { managed.backgroundContinuation = false; releaseClaim(); };
    const fail = async (error: unknown): Promise<void> => {
      if (!eligible()) return;
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
      const text = String(error);
      const blocked = !delivery.runId && ["invalid_dispatch_id", "dispatch_id_collision", "request_invalid"].includes(code ?? "");
      await persistDelivery({ ...delivery, ...(blocked ? { state: "blocked" as const } : {}), error: text });
      if (eligible() && delivery.error !== text) await this.post(managed.panel, { type: "host.notice", level: "error", text });
    };
    try {
      {
        // Query before replay: lost ACKs may already own a run. Observation
        // failure or an old runtime without lookup never proves absence.
        const connection = await this.connectPanelRuntime(managed);
        if (!eligible()) { finish(); return; }
        if (connection.available && connection.client.dispatchAcceptance && agentId) {
          const accepted = await connection.client.dispatchAcceptance(agentId, delivery.dispatchId);
          if (accepted) {
            await persistDelivery({ ...delivery, state: "accepted", runId: accepted.runId });
            finish();
            return;
          }
        } else if (previous) {
          finish(); return;
        }
      }
      await persistDelivery(delivery);
    } catch (error) {
      try { await fail(error); } finally { finish(); }
      return;
    }
    if (!eligible()) { finish(); return; }
    const controller = managed.controller;
    void controller.send(delivery.message, [], { taskMode: "direct", deliveryId: delivery.dispatchId }, () => {
      const runId = controller.runId;
      delivery = { ...delivery, state: "accepted", ...(runId ? { runId } : {}) };
      persisted = persistDelivery(delivery);
    }, error => { failure = { error }; }).then(async () => {
      await persisted;
      if (!eligible()) return;
      if (failure) throw failure.error;
      if (delivery.state !== "accepted") throw new Error(localize("ui.background.continuation.failed", child.agentId, child.runId!));
    }).catch(fail).finally(finish)
      .catch(async error => { if (eligible()) await this.post(managed.panel, { type: "host.notice", level: "error", text: String(error) }); });
  }

  private scheduleAgentList(managed: ManagedPanel, immediate = false): void {
    if (managed.disposed || !managed.state.agentId || (managed.state.role ?? "main") !== "main") return;
    const elapsed = Date.now() - (managed.lastAgentRefreshAt ?? 0);
    const interval = this.tabLoading(managed)
      ? AGENT_REFRESH_INTERVAL_MS
      : managed.panel.visible ? AGENT_IDLE_VISIBLE_REFRESH_INTERVAL_MS : AGENT_IDLE_HIDDEN_REFRESH_INTERVAL_MS;
    const delay = immediate ? 0 : Math.max(0, interval - elapsed);
    if (managed.agentRefreshTimer) {
      if (!immediate) return;
      clearTimeout(managed.agentRefreshTimer);
    }
    managed.agentRefreshTimer = setTimeout(() => {
      managed.agentRefreshTimer = undefined;
      void this.sendAgentList(managed);
    }, delay);
  }

  private async restoreCapturedRun(selected: CapturedAgentRun, state?: ChatPanelState): Promise<CapturedAgentRun | undefined> {
    const connection = await this.connectRuntime(state?.projectRoot);
    if (!connection.available) return selected;
    if (!connection.client.childRun) return undefined;
    const child = await connection.client.childRun(selected.parentAgentId, selected.agentId, selected.runId);
    if (!child || child.agentId !== selected.agentId || child.runId !== selected.runId) return undefined;
    return { parentAgentId: selected.parentAgentId, agentId: child.agentId, runId: child.runId,
      ...(child.model ? { model: child.model } : {}),
      ...(child.reasoningEffort ? { reasoningEffort: child.reasoningEffort } : {}),
      ...(child.workProfile ? { workProfile: child.workProfile } : {}) };
  }

  private async openChildAgent(managed: ManagedPanel, agentId: string, runId?: string): Promise<void> {
    if (!managed.state.agentId || (managed.state.role ?? "main") !== "main") return;
    const connection = await this.connectPanelRuntime(managed);
    if (!connection.available) {
      await this.post(managed.panel, { type: "host.notice", level: "error", text: connection.diagnostic });
      return;
    }
    try {
      const child = runId && connection.client.childRun
        ? await connection.client.childRun(managed.state.agentId, agentId, runId)
        : (await connection.client.listChildSessions(managed.state.agentId))
          .find(candidate => candidate.agentId === agentId && (!runId || candidate.runId === runId));
      if (!child) {
        await this.post(managed.panel, {
          type: "host.notice",
          level: "warning",
          text: localize("ui.unable.to.find.the.work.or.verification.session.called.by.main.agent")
        });
        return;
      }
      const capturedRun = child.runId ? { parentAgentId: managed.state.agentId, agentId: child.agentId, runId: child.runId,
        ...(child.model ? { model: child.model } : {}),
        ...(child.reasoningEffort ? { reasoningEffort: child.reasoningEffort } : {}),
        ...(child.workProfile ? { workProfile: child.workProfile } : {}) } : undefined;
      const existing = [...this.panels.values()].find(candidate =>
        !candidate.disposed && this.sameProject(candidate.state, managed.state) && candidate.state.agentId === child.agentId);
      if (existing) {
        if (capturedRun) {
          existing.state = { ...existing.state, capturedRun };
          await this.post(existing.panel, { type: "agent.run.selected", capturedRun });
        }
        existing.panel.reveal(undefined, false);
        return;
      }
      const label = child.role === "work" ? "Work agent" : "Verification agent";
      const state: ChatPanelState = {
        ...createDraftChatState(this.newChatPreferences(child.role)),
        title: `${label} · ${child.agentId}`,
        agentId: child.agentId,
        projectRoot: managed.state.projectRoot,
        capturedRun,
        role: child.role,
        ...(child.verifiedWorkRunId ? { verifiedWorkRunId: child.verifiedWorkRunId } : {})
      };
      const panel = vscode.window.createWebviewPanel(
        this.viewType,
        state.title,
        vscode.ViewColumn.Active,
        this.webviewOptions(state.panelId)
      );
      await this.attach(panel, state, connection.client);
    } catch (error) {
      await this.post(managed.panel, {
        type: "host.notice",
        level: "error",
        text: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private effectiveModel(managed: ManagedPanel): string | undefined {
    return managed.state.model;
  }

  private async assertAgentSettingsCompatible(managed: ManagedPanel, settings: AgentDefaults): Promise<void> {
    if (!managed.state.agentId) return;
    const role = managed.state.role ?? "main";
    const next = settings[role];
    if (!next?.model && !next?.reasoningEffort) return;
    const connection = await this.connectPanelRuntime(managed);
    if (!connection.available) return;
    const resolved = await connection.client.capabilities(managed.state.agentId, managed.state.model).catch(() => undefined);
    if (!resolved) return;
    const capabilities = resolved.send;
    const lockedProvider = capabilities.sessionProvider;
    if (next.model && lockedProvider && modelProvider(next.model) !== lockedProvider) {
      throw new Error(localize("ui.model.provider.fixed"));
    }
    if (next.model && next.model !== managed.state.model && capabilities.model !== true) {
      throw new Error(localize("ui.model.change.unavailable.active.chat"));
    }
    if (next.reasoningEffort && next.reasoningEffort !== managed.state.reasoning && capabilities.reasoning !== true) {
      throw new Error(localize("ui.reasoning.change.unavailable.active.chat"));
    }
  }

  private async assertPresetSelectionAvailable(managed: ManagedPanel): Promise<void> {
    if (!managed.state.agentId) return;
    const connection = await this.connectPanelRuntime(managed);
    if (!connection.available) return;
    const capabilities = await connection.client.capabilities(managed.state.agentId, managed.state.model).catch(() => undefined);
    if (capabilities?.send.sessionProvider) throw new Error(localize("preset.selection.bound"));
  }

  private async refreshAgentDefaults(managed: ManagedPanel): Promise<void> {
    if (managed.disposed) return;
    await ensureAgentPresets(this.context.globalState, this.context.workspaceState, managed.state.panelId, this.agentSettingsFromState(managed.state));
    await this.post(managed.panel, { type: "agent.defaults", settings: readAgentDefaults(this.context.globalState, this.context.workspaceState, managed.state.panelId) });
    const model = this.effectiveModel(managed);
    const connection = await this.connectPanelRuntime(managed);
    if (connection.available) {
      // The defaults were already saved and posted; a failed capability probe must not report them as failed.
      const capabilities = await connection.client.capabilities(managed.state.agentId, model).catch(() => undefined);
      if (capabilities && !managed.disposed && model === this.effectiveModel(managed)) await this.post(managed.panel, { type: "capabilities.updated", capabilities });
    }
  }

  private composerPreferences(): ComposerPreferences {
    const { agentPermissions } = restoreChatState(
      this.context.globalState.get(COMPOSER_PREFERENCES_KEY), {});
    // Model settings come from the selected defaults. Session identity and usage
    // restored from older preference snapshots must never enter a new draft.
    return { agentPermissions };
  }

  private newChatPreferences(role: "main" | "work" | "verification" = "main"): ComposerPreferences {
    const defaults = readAgentDefaults(this.context.globalState, this.context.workspaceState);
    const source = defaults.presets?.find(set => set.id === defaults.defaultSetId)?.settings ?? {};
    const own = source[role] ?? {};
    return {
      ...this.composerPreferences(),
      ...(own.model ? { model: own.model } : {}),
      ...(own.reasoningEffort ? { reasoning: own.reasoningEffort } : {}),
      fastMode: (own.model ? source.fastByRoleModel?.[role]?.[own.model] : undefined) ?? own.fast ?? false,
      agentFastModes: JSON.parse(JSON.stringify(source.fastByRoleModel ?? {})),
      agentSettingsScope: "chat",
      agentSettingsSet: "Chat",
      ...(role === "main" ? { agentModels: {
        ...(source.work ? { work: { ...source.work } } : {}),
        ...(source.workLight || source.work ? { workLight: { ...(source.work ?? {}), ...(source.workLight ?? {}) } } : {}),
        ...(source.verification ? { verification: { ...source.verification } } : {}),
        ...restrictedProfileModels(source)
      } } : {})
    };
  }

  private agentSettingsFromState(state: ChatPanelState): AgentDefaults {
    if ((state.role ?? "main") !== "main") return { [state.role!]: { model: state.model, reasoningEffort: state.reasoning } };
    return {
      main: { model: state.model, reasoningEffort: state.reasoning, fast: state.fastMode === true },
      work: { ...state.agentModels?.work },
      workLight: { ...state.agentModels?.workLight },
      verification: { ...state.agentModels?.verification },
      explore: { ...state.agentModels?.explore },
      scribe: { ...state.agentModels?.scribe },
      ...(state.agentFastModes ? {fastByRoleModel: state.agentFastModes} : {})
    };
  }

  private applyAgentSettings(state: ChatPanelState, settings: AgentDefaults, scope: "global" | "project" | "chat", name: string): ChatPanelState {
    const role = state.role ?? "main";
    const own = settings[role === "main" ? "main" : role] ?? {};
    return {
      ...state,
      ...(own.model ? {model: own.model} : {}),
      ...(own.reasoningEffort ? {reasoning: own.reasoningEffort} : {}),
      fastMode: (own.model ? settings.fastByRoleModel?.[role]?.[own.model] : undefined) ?? own.fast ?? false,
      agentFastModes: JSON.parse(JSON.stringify(settings.fastByRoleModel ?? {})),
      ...(role === "main" ? {agentModels: {
        ...(settings.work ? {work: {...settings.work}} : {}),
        ...(settings.workLight || settings.work ? {workLight: {...(settings.work ?? {}), ...(settings.workLight ?? {})}} : {}),
        ...(settings.verification ? {verification: {...settings.verification}} : {}),
        ...restrictedProfileModels(settings)
      }} : {}),
      agentSettingsScope: scope,
      agentSettingsSet: name
    };
  }

  private docsAudit(): { readonly interval?: DocsAuditInterval; readonly lastRunAt?: number } {
    const value = this.context.workspaceState?.get<{ interval?: string; lastRunAt?: number }>(DOCS_AUDIT_KEY);
    const interval = value?.interval && Object.hasOwn(DOCS_AUDIT_INTERVALS, value.interval) ? value.interval as DocsAuditInterval : undefined;
    return { ...(interval ? { interval } : {}), ...(typeof value?.lastRunAt === "number" ? { lastRunAt: value.lastRunAt } : {}) };
  }

  /** Offer a due periodic check to one open Main chat; the webview sends it when the chat is idle. */
  private async offerDocsAudit(): Promise<void> {
    const now = Date.now();
    if (!docsAuditDue(this.docsAudit(), now) || now - this.docsAuditOfferedAt < DOCS_AUDIT_CHECK_MS) return;
    const panels = [...this.panels.values()].filter(panel => !panel.disposed && (panel.state.role ?? "main") === "main" && panel.state.agentId);
    const target = panels.find(panel => panel.state.panelId === this.activePanelId) ?? panels[0];
    if (!target) return;
    this.docsAuditOfferedAt = now;
    await this.post(target.panel, { type: "docsAudit.due" });
  }

  private ensureDocsAuditTimer(): void {
    if (this.docsAuditTimer) return;
    this.docsAuditTimer = setInterval(() => { void this.offerDocsAudit().catch(() => undefined); }, DOCS_AUDIT_CHECK_MS);
    (this.docsAuditTimer as { unref?: () => void }).unref?.();
  }

  private workIsolation(): boolean {
    return this.context.workspaceState?.get<boolean>(WORK_ISOLATION_KEY) === true;
  }

  private async saveComposerPreferences(state: ChatPanelState): Promise<void> {
    // A child chat override must not replace the Main composer defaults.
    if (state.role && state.role !== "main") return;
    await this.context.globalState.update(COMPOSER_PREFERENCES_KEY, {
      agentPermissions: state.agentPermissions,
      agentFastModes: state.agentFastModes,
      businessMode: "normal",
      taskMode: "direct",
      fastMode: state.fastMode === true,
      goalMode: false,
      workLoopMode: false
    } satisfies ComposerPreferences);
  }

  private async selectSession(managed: ManagedPanel, agentId: string): Promise<void> {
    if ((managed.state.role ?? "main") !== "main") {
      await this.post(managed.panel, {
        type: "host.notice",
        level: "warning",
        text: localize("ui.other.main.agent.sessions.can.only.be.loaded.from.a.main.agent.panel")
      });
      return;
    }
    if (managed.controllerInitialization) await managed.controllerInitialization;
    if (managed.disposed) return;
    if (managed.controller?.running || managed.controller?.queueLength || managed.pendingMessageIds?.size) {
      await this.post(managed.panel, {
        type: "host.notice",
        level: "warning",
        text: localize("ui.load.another.session.after.the.current.run.finishes")
      });
      return;
    }
    const existing = [...this.panels.values()].find(candidate =>
      candidate !== managed && !candidate.disposed && this.sameProject(candidate.state, managed.state) && candidate.state.agentId === agentId);
    if (existing) {
      existing.panel.reveal(undefined, true);
      return;
    }
    const connection = await this.connectPanelRuntime(managed);
    if (managed.disposed) return;
    if (!connection.available) {
      await this.post(managed.panel, { type: "host.notice", level: "error", text: connection.diagnostic });
      return;
    }
    try {
      const sessions = await connection.client.listSessions();
      if (managed.disposed) return;
      const selectedSession = sessions.find((session) => session.agentId === agentId && !this.removedChat({ ...managed.state, agentId }));
      if (!selectedSession) {
        await this.post(managed.panel, {
          type: "host.notice",
          level: "warning",
          text: localize("ui.the.selected.main.agent.session.was.not.found.in.the.current.project")
        });
        await this.post(managed.panel, { type: "sessions.list", sessions });
        return;
      }
      if (managed.controller?.running || managed.controller?.queueLength || managed.pendingMessageIds?.size) {
        await this.post(managed.panel, {
          type: "host.notice",
          level: "warning",
          text: localize("ui.load.another.session.after.the.current.run.finishes")
        });
        return;
      }
      const claimed = [...this.panels.values()].find(candidate =>
        candidate !== managed && !candidate.disposed && this.sameProject(candidate.state, managed.state) && candidate.state.agentId === agentId);
      if (claimed) {
        claimed.panel.reveal(undefined, true);
        return;
      }
      managed.controller?.dispose();
      managed.startedMessages = [];
      managed.controller = undefined;
      managed.runtimeClient = connection.client;
      managed.executionMode = undefined;
      managed.executionModeExplicit = false;
      managed.state = {
        ...managed.state, agentId, conversationId: selectedSession.conversationId,
        contextUsedTokens: undefined, contextWindowTokens: undefined, weeklyUsedPercent: undefined, fiveHourUsedPercent: undefined,
        weeklyResetsAt: undefined, fiveHourResetsAt: undefined
      };
      await this.post(managed.panel, { type: "execution.updated", mode: managed.executionMode });
      if (managed.disposed) return;
      await this.rememberAgent(managed.state);
      if (managed.disposed) return;
      await this.post(managed.panel, { type: "session.bound", agentId, reset: true, conversationId: selectedSession.conversationId });
      if (managed.disposed) return;
      await this.restoreConversationHistory(managed, connection.client);
      if (managed.disposed) return;
      await this.reconnectController(managed);
      if (managed.disposed) return;
      await this.refreshWorktree(managed);
      const capabilities = await connection.client.capabilities(agentId);
      if (managed.disposed) return;
      await this.post(managed.panel, { type: "capabilities.updated", capabilities });
      if (managed.disposed) return;
      await this.post(managed.panel, { type: "execution.updated", mode: capabilities.executionMode });
      if (managed.disposed) return;
      const observed = await connection.client.goal(agentId, "get");
      if (managed.disposed) return;
      await this.post(managed.panel, { type: "goal.updated", goal: observed.goal ?? null, error: observed.error });
    } catch (error) {
      if (managed.disposed) return;
      await this.post(managed.panel, {
        type: "host.notice",
        level: "error",
        text: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async ensureController(managed: ManagedPanel): Promise<void> {
    if (managed.disposed || managed.controller) return;
    if (!managed.controllerInitialization) {
      managed.controllerInitialization = this.createController(managed).finally(() => { managed.controllerInitialization = undefined; });
    }
    await managed.controllerInitialization;
  }

  private async reconnectController(managed: ManagedPanel): Promise<void> {
    if (managed.disposed) return;
    await this.ensureController(managed);
    if (managed.disposed) return;
    await managed.controller?.reconnect();
  }

  private async createController(managed: ManagedPanel): Promise<void> {
    if (!managed.disposed && !managed.controller) {
      const connection = await this.connectPanelRuntime(managed);
      if (managed.disposed) return;
      if (!connection.available) {
        await this.post(managed.panel, { type: "host.notice", level: "error", text: connection.diagnostic });
        await this.post(managed.panel, { type: "run.state", running: false });
        return;
      }
      if (!managed.state.projectRoot && connection.projectRoot) {
        managed.state = { ...managed.state, projectRoot: connection.projectRoot };
        await this.rememberProjectBinding(managed.state);
        await this.rememberAgent(managed.state);
        if (managed.disposed) return;
      }
      managed.runtimeClient = connection.client;
      managed.controller = new ChatSessionController(connection.client, {
        onBound: (agentId) => {
          managed.state = { ...managed.state, agentId, contextUsedTokens: undefined, contextWindowTokens: undefined, weeklyUsedPercent: undefined, fiveHourUsedPercent: undefined,
            weeklyResetsAt: undefined, fiveHourResetsAt: undefined };
          this.rememberAgent(managed.state);
          const key = this.deliveryStorageKey("agentFactory.background.", managed.state);
          if (!this.context.workspaceState?.get(key)) void this.persistTerminalDeliveries(key, {}, () => !managed.disposed, true);
          void this.post(managed.panel, { type: "execution.updated", mode: managed.executionMode ?? this.defaultExecutionMode() });
          void this.post(managed.panel, { type: "session.bound", agentId });
          this.scheduleAgentList(managed, true);
        },
        onRunningChanged: (running) => {
          this.notifyAgents();
          if (running) managed.botContext = "working";
          else if (managed.botContext === "working") managed.botContext = "idle";
          this.reactBot(managed);
          this.broadcastCompanion();
          // When Main stops, keep its current frame until the immediate durable child refresh
          // confirms whether delegated Work or Verification is still active.
          if (running || !managed.state.agentId || (managed.state.role ?? "main") !== "main") {
            this.refreshTabLoading(managed);
          }
          void this.post(managed.panel, { type: "run.state", running });
          this.scheduleAgentList(managed, !running);
          if (!running) void this.refreshWorktree(managed);
        },
        onBeforeQueueDrain: async () => {
          // Include inputs already received while their attachments were preparing.
          let preparation: Promise<void>;
          do {
            preparation = managed.chatSendPreparation;
            await preparation;
          } while (preparation !== managed.chatSendPreparation);
        },
        onQueueChanged: (count) => {
          void this.post(managed.panel, { type: "queue.updated", count });
        },
        onAssistantText: (responseText, phase, runId, localization) => {
          void this.post(managed.panel, { type: "chat.assistant", text: responseText, phase, runId, ...(localization ? { localization: { text: localization } } : {}) });
        },
        onAssistantDelta: (delta) => {
          void this.post(managed.panel, { type: "chat.delta", ...delta });
        },
        onInterviewQuestion: (question, runId) => {
          this.notifyRun(managed, "decision", `${runId}:${question.id}`);
          void this.post(managed.panel, { type: "interview.question", question, runId });
        },
        onDecision: (runId, canApprove, approval) => {
          if (runId) this.notifyRun(managed, "decision", runId);
          void this.post(managed.panel, { type: "decision.pending", runId, canApprove, ...(approval ? { approval } : {}) });
        },
        onHumanDecision: (text, submission) => {
          void this.post(managed.panel, { type: "chat.human-decision", text, submission });
        },
        onProgress: (progressText) => {
          void this.post(managed.panel, { type: "run.progress", text: progressText });
        },
        onUsage: (usedTokens, contextWindowTokens, weeklyUsedPercent, fiveHourUsedPercent, weeklyResetsAt, fiveHourResetsAt) => {
          const limits = { weeklyUsedPercent, fiveHourUsedPercent, weeklyResetsAt, fiveHourResetsAt };
          managed.state = { ...managed.state, contextUsedTokens: usedTokens, contextWindowTokens, ...limits };
          void this.post(managed.panel, { type: "context.usage", usedTokens, contextWindowTokens, ...limits });
        },
        onAccountLimits: (limits) => void this.recordAccountLimits(limits),
        onActivity: (activity) => {
          void this.post(managed.panel, { type: "run.activity", ...activity });
        },
        onGoal: (goal, error) => {
          void this.post(managed.panel, { type: "goal.updated", goal, error });
        },
        onStatusObserved: (status) => {
          if ((status === "completed" || status === "failed") && managed.controller?.runId) this.notifyRun(managed, status, managed.controller.runId);
          if (status === "completed" || status === "failed") {
            managed.botContext = status;
            this.companionOutcome = status;
            this.companionOutcomeUntil = Date.now() + 4000;
          }
          this.broadcastCompanion();
          void this.post(managed.panel, { type: "run.observed", status });
          this.scheduleAgentList(managed);
        },
        onError: (message, level = "error") => {
          void this.post(managed.panel, { type: "host.notice", level, text: message });
        }
      }, managed.state.agentId);
    }
  }

  private async refreshWorktree(managed: ManagedPanel): Promise<void> {
    try {
      const connection = await this.connectPanelRuntime(managed);
      if (!connection.available || managed.disposed) return;
      const supported = (await connection.client.capabilities(managed.state.agentId)).submit.worktrees === true && (managed.state.role ?? "main") === "main";
      const agentId = managed.state.agentId;
      const value = supported && agentId && connection.client.worktree ? await connection.client.worktree(agentId, "status") : undefined;
      if (managed.disposed || managed.state.agentId !== agentId) return;
      managed.worktree = value;
      await this.post(managed.panel, { type: "worktree.updated", value, supported });
      if (value) await this.post(managed.panel, { type: "branch.updated", branch: value.branch ?? undefined });
    } catch (error) {
      await this.post(managed.panel, { type: "host.notice", level: "error", text: localize("worktree.failed", error instanceof Error ? error.message : String(error)) });
    }
  }

  private readonly deployPollIntervalMs = 10_000;
  private readonly deployDetections = new Map<string, { readonly at: number; readonly result: Promise<DeployTarget> }>();

  /** Finds manually dispatchable GitHub workflows for the chat's project; quiet detection only reports availability. */
  private async detectDeploy(managed: ManagedPanel, quiet: boolean): Promise<void> {
    const root = managed.worktree?.workingDirectory ?? managed.state?.projectRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root || (managed.state.role ?? "main") !== "main") {
      if (!quiet) await this.post(managed.panel, { type: "deploy.targets", error: localize("deploy.no.project") });
      return;
    }
    const cached = this.deployDetections.get(root);
    const detection = cached && (quiet || Date.now() - cached.at < 5_000) && Date.now() - cached.at < 300_000
      ? cached : { at: Date.now(), result: detectDeployTarget(root) };
    this.deployDetections.set(root, detection);
    try {
      const target = await detection.result;
      if (managed.disposed) return;
      managed.deployTarget = { root, target };
      await this.post(managed.panel, { type: "deploy.targets", target });
    } catch (error) {
      this.deployDetections.delete(root);
      managed.deployTarget = undefined;
      if (managed.disposed) return;
      const text = error instanceof DeployError && error.code === "gh-missing" ? localize("deploy.gh.missing")
        : error instanceof DeployError && error.code === "not-github" ? localize("deploy.not.github")
          : localize("deploy.failed", error instanceof Error ? error.message : String(error));
      await this.post(managed.panel, { type: "deploy.targets", error: text });
    }
  }

  /** Stores the gh token as the workflow secret; without a gh sign-in, starts the browser sign-in in a terminal. */
  private async setupDeployToken(managed: ManagedPanel, secret: string): Promise<void> {
    const detected = managed.deployTarget;
    if (!detected) {
      await this.post(managed.panel, { type: "deploy.targets", error: localize("deploy.detect.first") });
      return;
    }
    try {
      await setupDeploySecret(detected.root, detected.target.repository, secret);
      await this.post(managed.panel, { type: "host.notice", level: "info", text: localize("deploy.token.saved", secret, detected.target.repository) });
      this.deployDetections.delete(detected.root);
      await this.detectDeploy(managed, false);
    } catch (error) {
      if (error instanceof DeployError && error.code === "auth-required") {
        const terminal = vscode.window.createTerminal({ name: "GitHub sign-in", cwd: detected.root });
        terminal.show();
        terminal.sendText("gh auth login --hostname github.com --web --git-protocol https --scopes repo,workflow");
        await this.post(managed.panel, { type: "host.notice", level: "info", text: localize("deploy.token.signin", secret) });
        return;
      }
      await this.post(managed.panel, { type: "deploy.targets", target: detected.target,
        error: localize("deploy.failed", error instanceof Error ? error.message : String(error)) });
    }
  }

  private async runDeploy(managed: ManagedPanel, workflowId: number, inputs: Readonly<Record<string, string | boolean>>): Promise<void> {
    const detected = managed.deployTarget;
    if (!detected || managed.deployPolling) {
      await this.post(managed.panel, { type: "deploy.status", error: localize(detected ? "deploy.busy" : "deploy.detect.first") });
      return;
    }
    let run;
    try {
      run = await dispatchDeploy(detected.root, detected.target, workflowId, inputs);
    } catch (error) {
      await this.post(managed.panel, { type: "deploy.status", error: localize("deploy.failed", error instanceof Error ? error.message : String(error)) });
      return;
    }
    const repository = detected.target.repository;
    managed.deployPolling = true;
    await this.post(managed.panel, { type: "deploy.status", run, repository });
    await this.post(managed.panel, { type: "host.notice", level: "info", text: localize("deploy.started", run.workflow, repository, run.url) });
    try {
      let failures = 0;
      while (!managed.disposed && run.status !== "completed") {
        await new Promise(resolve => setTimeout(resolve, this.deployPollIntervalMs));
        if (managed.disposed) return;
        try {
          const next = await deployRunStatus(detected.root, repository, run);
          failures = 0;
          if (next.status !== run.status || next.conclusion !== run.conclusion) await this.post(managed.panel, { type: "deploy.status", run: next, repository });
          run = next;
        } catch (error) {
          // Only the status view stops; the run continues on GitHub at its URL.
          if (!deployStatusRetryable(error, ++failures)) {
            await this.post(managed.panel, { type: "host.notice", level: "error",
              text: localize("deploy.status.unavailable", run.workflow, error instanceof Error ? error.message : String(error), run.url) });
            return;
          }
        }
      }
      if (!managed.disposed) {
        const success = run.conclusion === "success";
        await this.post(managed.panel, { type: "host.notice", level: success ? "info" : "error",
          text: localize(success ? "deploy.succeeded" : "deploy.finished", run.workflow, run.conclusion ?? run.status, run.url) });
      }
    } finally { managed.deployPolling = false; }
  }

  private async warnDirectBranch(managed: ManagedPanel): Promise<void> {
    const pending = this.branchNoticeWrite.then(() => this.updateDirectBranchNotice(managed));
    this.branchNoticeWrite = pending.catch(() => {});
    await pending;
  }

  private async updateDirectBranchNotice(managed: ManagedPanel): Promise<void> {
    if (!vscode.workspace.getConfiguration("agentFactory").get<boolean>("workUnits.warnDefaultBranch", true)) return;
    const root = managed.worktree?.workingDirectory ?? managed.state?.projectRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return;
    try {
      const evidence = await directBranchEvidence(root);
      const key = "agentFactory.workUnit.warning." + evidence.key;
      const previous = this.context.globalState.get<{ shown: boolean; operations: string[] }>(key);
      const completed = previous && evidence.operations.some(operation => !previous.operations.includes(operation));
      const shown = previous?.shown && !completed;
      if (["main", "master"].includes(evidence.branch) && !shown) {
        await this.context.globalState.update(key, { shown: true, operations: evidence.operations });
        // This is an informational notice, not a submission approval. VS Code
        // resolves it on dismissal; holding the shared chain would stall all sends.
        void vscode.window.showInformationMessage(localize("unit.direct.notice", evidence.branch)).then(undefined, () => {});
      } else await this.context.globalState.update(key, { shown: Boolean(shown), operations: evidence.operations });
    } catch { /* Without Git evidence, do not infer a completed push or merge. */ }
  }

  private async changeWorktree(managed: ManagedPanel, action: "create" | "merge", draft?: { repository: string; name: string; base: string }): Promise<void> {
    let targetPanel = managed;
    try {
      if ((managed.state.role ?? "main") !== "main" || managed.pendingMessageIds?.size || managed.controller?.running || managed.controller?.queueLength) throw new Error(localize("worktree.busy"));
      const connection = await this.connectPanelRuntime(managed);
      if (!connection.available) throw new Error(connection.diagnostic);
      const repositories = await connection.client.worktreeRepositories?.();
      if (!repositories) throw new Error(localize("worktree.unsupported"));
      await this.post(managed.panel, { type: "worktree.updated", value: managed.worktree, busy: true });
      let options: import("../agent-factory/agent-client").WorktreeOptions;
      if (action === "create") {
        const repo = repositories.find(r => r.path === draft?.repository);
        if (!repo || !draft) throw new Error(localize("unit.pick.repository"));
        const name = draft.name.trim(), branch = workUnitBranch(name);
        if (!name) throw new Error(localize("unit.name.required"));
        if (!repo.branches.includes(draft.base)) throw new Error(localize("unit.base"));
        const invalid = await validateUnitBranch(repo.path, branch);
        if (invalid) throw new Error(invalid);
        let summary = "";
        if (managed.state.agentId && connection.client.history) {
          const history = await connection.client.history(managed.state.agentId, { limit: 50 });
          summary = history.messages.filter(m => m.type === "user" || m.phase === "final").slice(-8)
            .map(m => {
              const text = workUnitContextText(m.text);
              return text ? `${localize(m.type === "user" ? "unit.summary.request" : "unit.summary.result")}: ${text}` : "";
            }).filter(Boolean).join("\n\n");
        }
        const state = { ...createDraftChatState(this.newChatPreferences()), role: "main" as const, title: name.trim(), projectRoot: managed.state.projectRoot };
        const panel = vscode.window.createWebviewPanel(this.viewType, state.title, vscode.ViewColumn.Active, this.webviewOptions(state.panelId));
        await this.attach(panel, state, connection.client);
        targetPanel = this.panels.get(state.panelId)!;
        targetPanel.initialPrompt = summary;
        targetPanel.executionMode = managed.executionMode ?? this.defaultExecutionMode();
        await this.ensureController(targetPanel);
        options = { repository: repo.path, name: name.trim(), branch, base: draft.base, changes: "keep" };
      } else {
        await this.ensureController(managed);
        const tree = managed.worktree?.worktree;
        const repo = repositories.find(r => r.path === tree?.repositoryRoot) ?? repositories[0];
        if (!tree || !repo) throw new Error(localize("unit.merge.missing"));
        const target = await vscode.window.showQuickPick(repo.branches.filter(b => b !== tree.branch).sort((a, b) => Number(b === tree.targetBranch) - Number(a === tree.targetBranch)).map(label => ({ label, picked: label === tree.targetBranch })), { title: localize("unit.merge.target"), placeHolder: tree.targetBranch });
        if (!target) return;
        const diff = await unitGit(repo.path, ["diff", "--stat", `refs/heads/${target.label}...refs/heads/${tree.branch}`, "--"]);
        const confirmed = await vscode.window.showWarningMessage(localize("unit.merge.review", tree.branch, target.label, diff || localize("unit.merge.empty")), { modal: true }, localize("unit.merge.confirm"));
        if (!confirmed) return;
        options = { target: target.label };
      }
      if (!targetPanel.controller) throw new Error(localize("worktree.unsupported"));
      targetPanel.worktree = await targetPanel.controller.changeWorktree(action, { ...options,
        executionMode: targetPanel.executionMode ?? this.defaultExecutionMode(), ...(targetPanel.state.model ? { model: targetPanel.state.model } : {}) });
      const tree = targetPanel.worktree.worktree;
      if (action === "create" && tree) {
        const folders = vscode.workspace.workspaceFolders ?? [];
        if (!folders.some(f => f.uri.fsPath === tree.path) && !vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri: vscode.Uri.file(tree.path), name: tree.name ?? tree.branch })) throw new Error(localize("unit.explorer.add.failed"));
        if (targetPanel.initialPrompt) { await this.post(targetPanel.panel, { type: "composer.prefill", text: targetPanel.initialPrompt }); targetPanel.initialPrompt = undefined; }
      } else if (tree?.cleaned) {
        const index = vscode.workspace.workspaceFolders?.findIndex(f => f.uri.fsPath === tree.path) ?? -1;
        if (index >= 0 && !vscode.workspace.updateWorkspaceFolders(index, 1)) throw new Error(localize("unit.explorer.remove.failed"));
      }
      if (action === "create") await this.post(managed.panel, { type: "worktree.created", created: true });
      await this.post(targetPanel.panel, { type: "host.notice", level: "info", text: localize(action === "create" ? "worktree.created.notice" : "worktree.merged.notice") });
    } catch (error) {
      if (action === "create") {
        await this.post(managed.panel, { type: "worktree.created", created: Boolean(targetPanel !== managed && targetPanel.worktree?.worktree), error: error instanceof Error ? error.message : String(error) });
        if (targetPanel !== managed && !targetPanel.worktree?.worktree) targetPanel.panel.dispose();
      } else await this.post(targetPanel.panel, { type: "host.notice", level: "error", text: localize("worktree.failed", error instanceof Error ? error.message : String(error)) });
    } finally {
      await this.refreshWorktree(targetPanel);
      await this.post(managed.panel, { type: "worktree.updated", value: managed.worktree, busy: false });
    }
  }

  private async transitionConversation(managed: ManagedPanel): Promise<void> {
    if (managed.sessionTransition) {
      await this.post(managed.panel, { type: "host.notice", level: "warning", text: localize("ui.another.session.is.loading") });
      try {
        await managed.sessionTransition;
      } finally {
        await this.post(managed.panel, { type: "conversation.clearing", busy: false });
      }
      return;
    }
    const transition = Promise.resolve().then(async () => {
      try {
        await this.post(managed.panel, { type: "conversation.clearing", busy: true });
        await this.clearConversation(managed);
      } catch (error) {
        await this.post(managed.panel, {
          type: "host.notice", level: "error",
          text: localize("ui.unable.to.clear.the.conversation.0", error instanceof Error ? describeLocalizedMessage(error.message) ?? error.message : String(error))
        });
      } finally {
        await this.post(managed.panel, { type: "conversation.clearing", busy: false });
      }
    });
    managed.sessionTransition = transition;
    try {
      await transition;
    } finally {
      if (managed.sessionTransition === transition) managed.sessionTransition = undefined;
    }
  }

  private async clearConversation(managed: ManagedPanel): Promise<void> {
    if ((managed.state.role ?? "main") !== "main") {
      await this.post(managed.panel, { type: "host.notice", level: "error", text: localize("ui.only.main.agent.conversations.can.be.cleared") });
      return;
    }
    await this.ensureController(managed);
    if (!managed.controller) return;
    const controller = managed.controller, ownerState = managed.state;
    let conversationId = ownerState.conversationId;
    const current = () => !managed.disposed && managed.controller === controller && managed.state.agentId === ownerState.agentId &&
      managed.state.conversationId === conversationId && this.sameProject(managed.state, ownerState);
    if (!current()) return;
    if (managed.pendingMessageIds?.size) {
      await this.post(managed.panel, { type: "host.notice", level: "warning", text: localize("ui.wait.for.pending.messages.to.be.accepted.or.rejected.before.clearing.the.conversation") });
      return;
    }
    const blocked = managed.controller.conversationResetBlockedReason;
    if (blocked) {
      await this.post(managed.panel, { type: "host.notice", level: "warning", text: blocked });
      return;
    }
    if (managed.state.agentId) {
      const connection = await this.connectPanelRuntime(managed);
      if (!current()) return;
      if (!connection.available) {
        await this.post(managed.panel, { type: "host.notice", level: "error", text: connection.diagnostic });
        return;
      }
      let activeChildren: readonly import("../agent-factory/agent-client").ChildAgentSession[];
      try {
        activeChildren = (await connection.client.listChildSessions(managed.state.agentId))
          .filter(child => ["accepted", "queued", "starting", "running", "verifying", "cancelling"].includes(child.status));
      } catch (error) {
        if (!current()) return;
        await this.post(managed.panel, {
          type: "host.notice", level: "error",
          text: localize("ui.unable.to.confirm.child.agent.state.0", error instanceof Error ? describeLocalizedMessage(error.message) ?? error.message : String(error))
        });
        return;
      }
      if (!current()) return;
      if (activeChildren.length) {
        await this.post(managed.panel, {
          type: "host.notice", level: "warning",
          text: localize("ui.wait.for.the.active.work.or.verification.agent.to.finish.before.clearing.the.conversation")
        });
        return;
      }
    }
    if (managed.pendingMessageIds?.size || managed.controller.conversationResetBlockedReason) {
      await this.post(managed.panel, {
        type: "host.notice", level: "warning",
        text: managed.pendingMessageIds?.size
          ? localize("ui.a.message.is.now.pending.wait.for.it.to.be.accepted.or.rejected.before.clearing.the.conversation")
          : managed.controller.conversationResetBlockedReason ?? localize("ui.the.conversation.is.busy")
      });
      return;
    }
    try {
      if (!current()) return;
      const reset = await controller.resetConversation();
      if (!current()) return;
      conversationId = reset.conversationId;
      managed.state = {
        ...managed.state,
        conversationId: reset.conversationId,
        contextUsedTokens: undefined,
        contextWindowTokens: undefined,
        weeklyUsedPercent: undefined,
        fiveHourUsedPercent: undefined,
        weeklyResetsAt: undefined,
        fiveHourResetsAt: undefined
      };
      await this.rememberAgent(managed.state);
      if (!current()) return;
      await this.post(managed.panel, { type: "conversation.cleared", conversationId: reset.conversationId });
      const refreshedConnection = await this.connectPanelRuntime(managed);
      const refreshed = refreshedConnection.available
        ? await refreshedConnection.client.capabilities(managed.state.agentId, managed.state.model).catch(() => undefined)
        : undefined;
      if (!current()) return;
      if (refreshed) await this.post(managed.panel, { type: "capabilities.updated", capabilities: refreshed });
      this.scheduleAgentList(managed, true);
    } catch (error) {
      if (!current()) return;
      await this.post(managed.panel, {
        type: "host.notice", level: "error",
        text: localize("ui.unable.to.clear.the.conversation.0", error instanceof Error ? describeLocalizedMessage(error.message) ?? error.message : String(error))
      });
    }
  }

  private async restoreConversationHistory(managed: ManagedPanel, client: import("../agent-factory/agent-client").AgentRuntimeClient, before?: string): Promise<void> {
    const agentId = managed.state.agentId;
    if (!agentId || !client.history) return;
    try {
      const history = await client.history(agentId, { limit: 50, ...(before ? { before } : {}) });
      if (managed.disposed || managed.state.agentId !== agentId ||
          history.conversationId !== managed.state.conversationId) return;
      await this.post(managed.panel, { type: "conversation.history", agentId, history });
    } catch (error) {
      if (managed.disposed || managed.state.agentId !== agentId) return;
      await this.post(managed.panel, { type: "host.notice", level: "error",
        text: `Unable to restore conversation history: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  private async reconcileChatRequests(managed: ManagedPanel, ids: readonly string[]): Promise<void> {
    // This is acknowledgement replay only: never dispatch or reconnect a runtime run.
    for (const id of new Set(ids)) {
      const started = managed.startedMessages?.find(item => item.id === id);
      if (started) await this.post(managed.panel, started);
      else await this.post(managed.panel, { type: managed.pendingMessageIds?.has(id) ? "chat.pending" : "chat.rejected", id });
    }
  }

  private async sendChat(
    managed: ManagedPanel,
    text: string,
    attachments: readonly AttachmentReference[],
    execution: Extract<import("../../protocol/messages").ClientMessage, { type: "chat.send" }>["execution"],
    id: string,
    executionMode = managed.executionMode ?? this.defaultExecutionMode(),
    executionModeExplicit = managed.executionModeExplicit
  ): Promise<void> {
    if (managed.sessionTransition) {
      await managed.sessionTransition;
      if (managed.disposed) return;
    }
    if ((managed.state.role ?? "main") === "main" && execution.agentPermissions?.main) {
      executionMode = execution.agentPermissions.main;
      executionModeExplicit = true;
    }
    const goalMode = (managed.state.role ?? "main") === "main" && execution.taskMode !== "verification" && execution.goal;
    const goalObjective = goalMode ? text.trim() : undefined;
    if (goalMode && (!goalObjective)) {
      throw new Error(localize("ui.describe.the.goal.you.want.to.achieve.for.example.make.the.attached.page.usable.on.mobile"));
    }
    await this.ensureController(managed);
    if (!managed.controller) throw new Error(localize("ui.unable.to.connect.to.the.runtime.queued.messages.have.been.preserved"));
    const preparedAttachments = await Promise.all(attachments.map(async (attachment) => {
      if (attachment.kind !== "image") return attachment;
      const uri = await this.imageAttachmentPath(managed.state.panelId, attachment.id);
      if (!uri) throw new Error(localize("ui.unable.to.locate.the.original.image.attachment.0", attachment.name));
      const mediaType = imageMediaType(uri.fsPath);
      if (!mediaType) throw new Error(localize("ui.unsupported.image.attachment.0", attachment.name));
      const info = await vscode.workspace.fs.stat(uri);
      return { ...attachment, uri: uri.toString(), mediaType, size: info.size, previewUri: undefined };
    }));
    if (this.context.workspaceState && managed.state.agentId && (managed.state.role ?? "main") === "main") {
      const key = this.deliveryStorageKey("agentFactory.background.", managed.state);
      if (!this.context.workspaceState?.get(key)) {
        const agentId = managed.state.agentId, conversationId = managed.state.conversationId, projectRoot = managed.state.projectRoot;
        const current = () => !managed.disposed && managed.state.agentId === agentId && managed.state.conversationId === conversationId && managed.state.projectRoot === projectRoot;
        const connection = await this.connectPanelRuntime(managed);
        if (connection.available) {
          const existing = await connection.client.listChildSessions(agentId);
          await this.persistTerminalDeliveries(key, Object.fromEntries(existing.filter(child => child.runId).map(child => [`${child.agentId}/${child.runId}`, child.status])), current, true);
        }
        if (!current()) return;
      }
    }
    let started = false;
    void managed.controller.send(text, preparedAttachments, {
      messageId: id, receivedAt: new Date().toISOString(),
      ...((managed.state.role ?? "main") === "main" && (!managed.state.agentId || executionModeExplicit) ? { executionMode } : {}),
      ...((managed.state.role ?? "main") === "main" ? { ...taskExecution(execution.taskMode), businessMode: execution.businessMode ?? "normal" } : {}),
      model: execution.model,
      agentModels: execution.agentModels,
      agentPermissions: execution.agentPermissions,
      // Only Main delegates; a message sent before the stored toggle loaded falls back to it.
      ...((managed.state.role ?? "main") === "main" ? { workIsolation: execution.workIsolation ?? this.workIsolation() } : {}),
      reasoningEffort: execution.reasoningEffort,
      fast: execution.fast,
      goalMode,
      goalObjective,
      ...((managed.state.role ?? "main") !== "main" ? { actor: "human" as const } : {}),
      ...(managed.state.verifiedWorkRunId ? { verifiedWorkRunId: managed.state.verifiedWorkRunId } : {})
    }, (submission) => {
      started = true;
      managed.pendingMessageIds?.delete(id);
      const event: Extract<HostMessage, { type: "chat.started" }> = { type: "chat.started", id, text, attachments, submission };
      (managed.startedMessages ??= []).push(event);
      // Retain accepted identities for this panel/conversation so delayed confirmations
      // and explicit recovery cannot turn an already accepted request into a new run.
      void this.post(managed.panel, event);
    }).catch(error => {
      void this.post(managed.panel, { type: "host.notice", level: "error", text: String(error) });
    }).finally(() => {
      if (!started) {
        managed.pendingMessageIds?.delete(id);
        void this.post(managed.panel, { type: "chat.rejected", id });
        return;
      }
      for (const item of attachments) {
        if (item.kind === "image") managed.imageAttachments.delete(item.id);
      }
    });
  }

  private async mutateImages(managed: ManagedPanel, action: () => Promise<void>): Promise<void> {
    const operation = managed.imageMutation.then(action, action);
    managed.imageMutation = operation.then(() => undefined, () => undefined);
    await operation;
  }

  private async pickAttachments(managed: ManagedPanel): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      // Windows/Linux cannot select files and folders together: that opens a folder picker.
      canSelectFolders: false,
      canSelectMany: true,
      title: localize("ui.attach.files.to.chat"),
      openLabel: localize("ui.attach.to.chat")
    });
    if (!uris?.length) {
      return;
    }

    await this.prepareAttachmentUris(managed, uris);
  }

  private async addUriAttachments(managed: ManagedPanel, values: readonly string[]): Promise<void> {
    const uris: vscode.Uri[] = [];
    try {
      for (const value of values) {
        const uri = vscode.Uri.parse(value, true);
        if (uri.scheme !== "file" && uri.scheme !== "vscode-remote") throw new Error(localize("ui.unable.to.prepare.attachments.0", value));
        uris.push(uri);
      }
    } catch (error) {
      await this.post(managed.panel, { type: "host.notice", level: "error", text: localize("ui.unable.to.prepare.attachments.0", error instanceof Error ? error.message : String(error)) });
      return;
    }
    await this.prepareAttachmentUris(managed, uris);
  }

  private async prepareAttachmentUris(managed: ManagedPanel, uris: readonly vscode.Uri[]): Promise<void> {
    const panel = managed.panel;
    const attachments: AttachmentReference[] = [];
    const createdImageIds: string[] = [];
    let imageCount = managed.imageAttachments.size;
    let imageBytes = [...managed.imageAttachments.values()].reduce((total, size) => total + size, 0);
    let rejectedImages = 0;
    try {
      for (const uri of uris) {
        let kind: AttachmentReference["kind"] = "file";
        const mediaType = imageMediaType(uri.fsPath);
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          if ((stat.type & vscode.FileType.Directory) !== 0) {
            kind = "folder";
          } else if (mediaType) {
            kind = "image";
          }
        } catch {
          // The runtime performs the authoritative path validation before use.
        }
        const id = randomUUID();
        if (kind === "image" && mediaType) {
          const content = await readSafeImage(uri.fsPath);
          if (!canStageImage(imageCount, imageBytes, content.byteLength)) {
            rejectedImages += 1;
            continue;
          }
          const attachment = await this.persistImage(panel, managed.state.panelId, id, uri.path.split("/").filter(Boolean).at(-1) ?? "image", mediaType, content);
          attachments.push(attachment);
          createdImageIds.push(id);
          managed.imageAttachments.set(id, content.byteLength);
          imageCount += 1;
          imageBytes += content.byteLength;
          continue;
        }
        attachments.push({
          id,
          name: uri.path.split("/").filter(Boolean).at(-1) ?? uri.toString(),
          kind,
          uri: uri.toString(),
          ...(mediaType ? { mediaType } : {})
        });
      }
    } catch (error) {
      await Promise.all(createdImageIds.map(id => this.removeImageAttachment(managed, id, false)));
      await this.post(panel, { type: "host.notice", level: "error", text: localize("ui.unable.to.prepare.attachments.0", error instanceof Error ? describeLocalizedMessage(error.message) ?? error.message : String(error)) });
      return;
    }
    if (attachments.length) await this.post(panel, { type: "attachments.add", attachments });
    if (rejectedImages) await this.post(panel, { type: "host.notice", level: "warning", text: localize("ui.excluded.0.images.due.to.attachment.limits.up.to.8.images.10.mib.each.20.mib.total", rejectedImages) });
  }

  private async createFileAttachment(managed: ManagedPanel, message: Extract<import("../../protocol/messages").ClientMessage, { type: "attachments.createFile" }>): Promise<void> {
    try {
      const directory = vscode.Uri.joinPath(this.storageRoot(), "uploaded-files", managed.state.panelId, randomUUID());
      const uri = vscode.Uri.joinPath(directory, message.name);
      await vscode.workspace.fs.createDirectory(directory);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(message.data, "base64"));
      await this.post(managed.panel, { type: "attachments.add", attachments: [{
        id: message.id, name: message.name, kind: "file", uri: uri.toString(), size: message.size
      }] });
    } catch (error) {
      await this.post(managed.panel, { type: "attachment.rejected", id: message.id });
      await this.post(managed.panel, { type: "host.notice", level: "error", text: localize("ui.unable.to.prepare.attachments.0", error instanceof Error ? error.message : String(error)) });
    }
  }

  private async createTextAttachment(managed: ManagedPanel, text: string): Promise<void> {
    try {
      const directory = vscode.Uri.joinPath(
        this.storageRoot(),
        "pasted-text",
        managed.state.panelId
      );
      const uri = vscode.Uri.joinPath(directory, `${randomUUID()}.txt`);
      const contents = Buffer.from(text, "utf8");
      await vscode.workspace.fs.createDirectory(directory);
      await vscode.workspace.fs.writeFile(uri, contents);
      await this.post(managed.panel, {
        type: "attachments.add",
        attachments: [{
          id: randomUUID(),
          name: "Pasted text.txt",
          kind: "file",
          uri: uri.toString(),
          mediaType: "text/plain",
          size: contents.byteLength
        }]
      });
    } catch (error) {
      await this.post(managed.panel, {
        type: "host.notice",
        level: "error",
        text: localize("ui.unable.to.create.a.file.from.pasted.text.0", error instanceof Error ? describeLocalizedMessage(error.message) ?? error.message : String(error))
      });
    }
  }

  private async createImageAttachment(
    managed: ManagedPanel,
    message: Extract<import("../../protocol/messages").ClientMessage, { type: "attachments.createImage" }>
  ): Promise<void> {
    try {
      const content = decodeBrowserImage(message.data, message.size, message.mediaType);
      const stagedBytes = [...managed.imageAttachments.values()].reduce((total, size) => total + size, 0);
      if (!canStageImage(managed.imageAttachments.size, stagedBytes, content.byteLength)) throw new Error(localize("ui.image.attachment.limit.exceeded"));
      const attachment = await this.persistImage(managed.panel, managed.state.panelId, message.id, message.name, message.mediaType, content);
      managed.imageAttachments.set(message.id, content.byteLength);
      await this.post(managed.panel, { type: "attachments.add", attachments: [attachment] });
    } catch (error) {
      await this.post(managed.panel, { type: "attachment.rejected", id: message.id });
      await this.post(managed.panel, { type: "host.notice", level: "error", text: localize("ui.unable.to.save.the.image.attachment.0", error instanceof Error ? describeLocalizedMessage(error.message) ?? error.message : String(error)) });
    }
  }

  private async restoreImageAttachments(managed: ManagedPanel, references: readonly { readonly id: string; readonly name: string; readonly target: "composer" | "history" }[]): Promise<void> {
    const attachments: (AttachmentReference & { readonly target: "composer" | "history" })[] = [];
    for (const reference of references) {
      const uri = await this.imageAttachmentPath(managed.state.panelId, reference.id);
      if (!uri) {
        await this.post(managed.panel, { type: "attachment.rejected", id: reference.id });
        continue;
      }
      const mediaType = imageMediaType(uri.fsPath);
      if (!mediaType) continue;
      const info = await vscode.workspace.fs.stat(uri);
      attachments.push({ id: reference.id, name: reference.name, kind: "image", uri: uri.toString(), previewUri: managed.panel.webview.asWebviewUri(uri).toString(), mediaType, size: info.size, target: reference.target });
      if (reference.target === "composer") managed.imageAttachments.set(reference.id, info.size);
    }
    if (attachments.length) await this.post(managed.panel, { type: "attachments.restored", attachments });
  }

  private async persistImage(panel: vscode.WebviewPanel, panelId: string, id: string, name: string, mediaType: string, content: Buffer): Promise<AttachmentReference> {
    assertAttachmentScopeId(panelId, "panel");
    assertAttachmentScopeId(id, "attachment");
    if (content.byteLength < 1 || !hasImageSignature(content, mediaType)) throw new Error(localize("ui.the.image.is.unsupported.or.too.large"));
    const suffix = imageSuffix(mediaType);
    const directory = vscode.Uri.joinPath(this.storageRoot(), "chat-images", panelId, id.slice(0, 2));
    await vscode.workspace.fs.createDirectory(directory);
    const uri = vscode.Uri.joinPath(directory, `${id}${suffix}`);
    await writeNewImageAttachment(uri.fsPath, content);
    return { id, name, kind: "image", uri: uri.toString(), previewUri: panel.webview.asWebviewUri(uri).toString(), mediaType, size: content.byteLength };
  }

  /**
   * Profile-enabled desktop hosts can expose global storage as `vscode-userdata:`. Attachments
   * are handed to CLIs as local paths, so use the equivalent `file:` URI for the same folder.
   */
  private storageRoot(): vscode.Uri {
    const root = this.context.globalStorageUri;
    return root.scheme === "vscode-userdata" ? vscode.Uri.file(root.fsPath) : root;
  }

  private async imageAttachmentPath(panelId: string, id: string): Promise<vscode.Uri | undefined> {
    assertAttachmentScopeId(panelId, "panel");
    assertAttachmentScopeId(id, "attachment");
    const base = vscode.Uri.joinPath(this.storageRoot(), "chat-images", panelId, id.slice(0, 2));
    for (const suffix of [".png", ".jpg", ".gif", ".webp"]) {
      const uri = vscode.Uri.joinPath(base, `${id}${suffix}`);
      try {
        const file = await openFile(uri.fsPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        try { if ((await file.stat()).isFile()) return uri; } finally { await file.close(); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return undefined;
  }

  private async convertImageAttachment(managed: ManagedPanel, id: string, name: string, requestId: string, mediaType: string): Promise<void> {
    try {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) throw new Error(localize("attachment.convert.workspace"));
      const uri = await this.imageAttachmentPath(managed.state.panelId, id);
      if (!uri) throw new Error(localize("ui.the.original.image.no.longer.exists"));
      const sourceType = imageMediaType(uri.fsPath);
      if (!["image/png", "image/jpeg", "image/webp"].includes(mediaType)) throw new Error(localize("attachment.convert.failed"));
      const file = await openFile(uri.fsPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      let content: Buffer;
      try { content = await file.readFile(); } finally { await file.close(); }
      if (!sourceType || !hasImageSignature(content, sourceType)) throw new Error(localize("attachment.convert.failed"));
      (managed.imageConversions ??= new Map()).set(requestId, { root, name, mediaType: mediaType });
      await this.post(managed.panel, { type: "attachment.encode", id: requestId, name,
        source: `data:${sourceType};base64,${content.toString("base64")}`, mediaType: mediaType });
    } catch (error) {
      await this.post(managed.panel, { type: "attachment.conversionResult", id: requestId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async finishImageConversion(managed: ManagedPanel, message: Extract<import("../../protocol/messages").ClientMessage, { type: "attachment.converted" }>): Promise<void> {
    const pending = managed.imageConversions?.get(message.id);
    if (!pending) return;
    managed.imageConversions!.delete(message.id);
    try {
      if (pending.mediaType !== message.mediaType) throw new Error(localize("attachment.convert.failed"));
      const path = await saveConvertedImage(pending.root, pending.name, pending.mediaType, message.data, message.size);
      (managed.convertedImages ??= new Map()).set(message.id, path);
      await this.post(managed.panel, { type: "attachment.conversionResult", id: message.id, path });
    } catch (error) {
      await this.post(managed.panel, { type: "attachment.conversionResult", id: message.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async openImageAttachment(managed: ManagedPanel, id: string): Promise<void> {
    const uri = await this.imageAttachmentPath(managed.state.panelId, id);
    if (!uri) {
      await this.post(managed.panel, { type: "host.notice", level: "warning", text: localize("ui.the.original.image.no.longer.exists") });
      return;
    }
    await vscode.commands.executeCommand("vscode.open", uri);
  }

  private async removeImageAttachment(managed: ManagedPanel, id: string, report = true): Promise<void> {
    try {
      const uri = await this.imageAttachmentPath(managed.state.panelId, id);
      if (uri) await unlink(uri.fsPath);
      managed.imageAttachments.delete(id);
    } catch (error) {
      if (report) await this.post(managed.panel, { type: "host.notice", level: "warning", text: localize("ui.unable.to.clean.up.temporary.image.files.0", error instanceof Error ? describeLocalizedMessage(error.message) ?? error.message : String(error)) });
    }
  }

  private reactBot(managed: ManagedPanel): void {
    if (managed.disposed || !this.botsEnabled()) return;
    managed.lunaBot ??= new LunaBot();
    void managed.lunaBot.react(managed.botContext ?? "idle", (mood, unavailable) => {
      if (!managed.disposed && this.botsEnabled()) void this.post(managed.panel, { type: "bot.mood", mood, unavailable });
    });
  }

  private companionOutcome?: "completed" | "failed";
  private companionOutcomeUntil = 0;
  private botConversationWrite: Promise<void> = Promise.resolve();
  private companionWrite: Promise<void> = Promise.resolve();
  private companionInitial = restoreCompanion(undefined);
  private companionState() {
    return restoreCompanion(this.context.globalState.get("agentFactory.companion.v1", this.companionInitial));
  }
  private accountUsage(): Readonly<Record<string, AccountUsage>> {
    return this.context.globalState.get<Record<string, AccountUsage>>(ACCOUNT_USAGE_KEY, {});
  }

  /** Keeps each provider's latest reported windows so every chat shows account limits, not just the active run. */
  private async recordAccountLimits({ provider, ...windows }: AccountLimits): Promise<void> {
    const accounts = this.accountUsage();
    const next = { ...accounts, [provider]: { ...accounts[provider], ...windows, reportedAt: Date.now() } };
    await this.context.globalState.update(ACCOUNT_USAGE_KEY, next);
    for (const panel of this.panels.values()) {
      if (!panel.disposed) void this.post(panel.panel, { type: "usage.accounts", accounts: next });
    }
  }

  private antigravityUsageCheckedAt = 0;
  private antigravityUsageRefresh: Promise<void> | undefined;

  /** Antigravity reports quota only on request, so poll `agy /usage` (throttled) instead of waiting for runs. */
  private refreshAntigravityUsage(): Promise<void> {
    if (this.antigravityUsageRefresh) return this.antigravityUsageRefresh;
    if (Date.now() - this.antigravityUsageCheckedAt < ANTIGRAVITY_USAGE_REFRESH_MS) return Promise.resolve();
    this.antigravityUsageCheckedAt = Date.now();
    this.antigravityUsageRefresh = (async () => {
      for (const limits of await readAntigravityUsage()) await this.recordAccountLimits(limits);
    })().catch(() => undefined).finally(() => { this.antigravityUsageRefresh = undefined; });
    return this.antigravityUsageRefresh;
  }

  private broadcastCompanion(): void {
    if (this.botCharacter() !== "lumi" || !this.botsEnabled()) return;
    const companion = this.companionState();
    const working = [...this.panels.values()].filter(panel => panel.botContext === "working").length;
    for (const panel of this.panels.values()) {
      if (!panel.disposed) void this.post(panel.panel, { type: "bot.companion", companion, working, outcome: this.companionOutcome, outcomeUntil: this.companionOutcomeUntil });
    }
  }

  private botsWrite: Promise<void> = Promise.resolve();

  private saveBots(enabled: boolean): Promise<void> {
    const write = this.botsWrite.then(async () => {
      try {
        await vscode.workspace.getConfiguration("agentFactory.mainChat").update("botsEnabled", enabled, vscode.ConfigurationTarget.Global);
      } finally {
        await this.refreshBots();
      }
    });
    this.botsWrite = write.catch(() => {});
    return write;
  }

  private botsEnabled(): boolean {
    return vscode.workspace.getConfiguration("agentFactory.mainChat").get<boolean>("botsEnabled", true);
  }
  private botModel(): string {
    const value = vscode.workspace.getConfiguration("agentFactory.mainChat").get<unknown>("botModel", "");
    return isBotModel(value) ? value : "";
  }

  private botCharacter(): "lumi" | "factory" {
    const value = vscode.workspace.getConfiguration("agentFactory.mainChat").get<string>("botCharacter", "");
    return localCompanionAvailable && value !== "factory" ? "lumi" : "factory";
  }

  private botPrompt(): string {
    const config = vscode.workspace.getConfiguration("agentFactory.mainChat");
    const character = this.botCharacter();
    const value = config.get<unknown>(character === "lumi" ? "lumiPrompt" : "factoryBotPrompt");
    if (typeof value === "string") return value;
    const legacy = character === "factory" ? config.get<unknown>("botPrompt", "") : "";
    return typeof legacy === "string" ? legacy : "";
  }

  public async refreshBots(): Promise<void> {
    const enabled = this.botsEnabled();
    await Promise.all([...this.panels.values()].map(managed => {
      if (!enabled) {
        managed.lunaBot?.dispose();
        managed.lunaBot = undefined;
      }
      return this.post(managed.panel, { type: "bots.updated", enabled, botCharacter: this.botCharacter(), localCompanionAvailable, botModel: this.botModel(), botDefaultPrompt: BOT_DEFAULT_PROMPTS[this.botCharacter()], botPrompt: resolveBotPrompt(this.botCharacter(), this.botPrompt()) });
    }));
  }

  private statusItemsWrite: Promise<void> = Promise.resolve();
  private pendingStatusWrites = 0;

  public async refreshStatusItems(): Promise<void> {
    if (this.pendingStatusWrites > 0) return;
    const items = this.statusItems();
    await Promise.all([...this.panels.values()].map(managed =>
      this.post(managed.panel, { type: "status.updated", items })));
  }

  private async saveStatusItems(
    panel: vscode.WebviewPanel,
    items: readonly StatusItemId[]
  ): Promise<void> {
    // Serialize rapid checkbox/drop changes so the last edit remains authoritative.
    this.pendingStatusWrites += 1;
    this.statusItemsWrite = this.statusItemsWrite.then(async () => {
      const target = vscode.workspace.workspaceFolders?.length
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
      try {
        await vscode.workspace.getConfiguration("agentFactory.mainChat").update("statusItems", items, target);
      } catch {
        await this.post(panel, { type: "host.notice", level: "warning", text: localize("ui.unable.to.save.status.bar.settings.reloading.the.saved.settings") });
      } finally {
        this.pendingStatusWrites -= 1;
        await this.refreshStatusItems();
      }
    }).catch(() => undefined);
    await this.statusItemsWrite;
  }

  private webviewOptions(panelId: string): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    assertAttachmentScopeId(panelId, "panel");
    // Register the panel image tree before HTML loads. Changing Webview options
    // during image preparation can reload the document and discard live input.
    return {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: uniqueUris([
        ...this.templates.localResourceRoots,
        vscode.Uri.joinPath(this.storageRoot(), "chat-images", panelId)
      ])
    };
  }

  private async post(panel: vscode.WebviewPanel, message: HostMessage): Promise<void> {
    if (this.disposedPanels.has(panel)) return;
    const text = (message.type === "host.notice" || message.type === "run.progress")
      ? describeLocalizedMessage(message.text) : message.type === "chat.assistant" ? message.localization?.text : undefined;
    const error = message.type === "goal.updated" && message.error ? describeLocalizedMessage(message.error) : undefined;
    const localized: import("../../protocol/messages").LocalizedHostMessage = text || error
      ? { ...message, localization: { ...(text ? { text } : {}), ...(error ? { error } : {}) } }
      : message;
    try {
      await panel.webview.postMessage(localized);
    } catch (error) {
      // A pending send may reject after the panel disposal callback has run.
      if (!this.disposedPanels.has(panel)) throw error;
    }
  }

  private findActivePanel(): ManagedPanel | undefined {
    if (this.activePanelId) {
      const managed = this.panels.get(this.activePanelId);
      if (managed?.panel.active) {
        return managed;
      }
    }
    return [...this.panels.values()].find((managed) => managed.panel.active);
  }
}

function workspaceName(): string {
  return vscode.workspace.name ?? localize("ui.no.workspace");
}

function parseLocalLink(href: string): { path: string; line?: number; column?: number } {
  let path = href;
  let fragment = "";
  if (/^file:\/\//i.test(href)) {
    const url = new URL(href);
    fragment = url.hash.slice(1);
    url.hash = "";
    url.search = "";
    path = fileURLToPath(url);
  } else {
    const hashIndex = path.indexOf("#");
    if (hashIndex >= 0) {
      fragment = path.slice(hashIndex + 1);
      path = path.slice(0, hashIndex);
    }
    path = decodeURIComponent(path);
  }

  const fragmentLocation = fragment.match(/^L(\d+)(?:C(\d+))?$/i);
  if (fragmentLocation) {
    return { path, line: Number(fragmentLocation[1]), ...(fragmentLocation[2] ? { column: Number(fragmentLocation[2]) } : {}) };
  }
  const suffixLocation = path.match(/^(.*?):(\d+)(?::(\d+))?$/);
  if (suffixLocation) {
    return {
      path: suffixLocation[1]!,
      line: Number(suffixLocation[2]),
      ...(suffixLocation[3] ? { column: Number(suffixLocation[3]) } : {})
    };
  }
  return { path };
}

function imageMediaType(path: string): string | undefined {
  return ({
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp"
  } as Readonly<Record<string, string>>)[extname(path).toLowerCase()];
}

function imageSuffix(mediaType: string): string {
  const suffix = ({ "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" } as Record<string, string>)[mediaType];
  if (!suffix) throw new Error(localize("ui.unsupported.image.format"));
  return suffix;
}

async function readSafeImage(path: string): Promise<Buffer> {
  if (await realpath(path) !== resolve(path)) throw new Error(localize("ui.symbolic.link.images.cannot.be.attached"));
  const file = await openFile(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 1) throw new Error(localize("ui.image.size.is.outside.the.allowed.range"));
    const content = await file.readFile();
    const after = await file.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error(localize("ui.the.image.changed.while.being.read"));
    return content;
  } finally { await file.close(); }
}

function assertAttachmentScopeId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error(localize("ui.0.image.scope.is.invalid", label));
}

function uniqueUris(uris: readonly vscode.Uri[]): vscode.Uri[] {
  return [...new Map(uris.map((uri) => [uri.toString(), uri])).values()];
}

/**
 * Whether a failed deploy status read is retried. A missing gh, a lost
 * sign-in, an unknown run or an unreadable response cannot recover by
 * repeating the same read. Any other failure is retried until it repeats on
 * consecutive polls: one success resets the count, so only a failure that
 * persists across the network blips the retry exists for ends polling.
 */
export function deployStatusRetryable(error: unknown, consecutiveFailures: number): boolean {
  if (error instanceof DeployError || error instanceof SyntaxError) return false;
  return consecutiveFailures < DEPLOY_STATUS_FAILURES;
}

const DEPLOY_STATUS_FAILURES = 3;

/** The protocol operation of a chat request, safe to log. */
function requestType(rawMessage: unknown): string {
  return rawMessage && typeof rawMessage === "object" && "type" in rawMessage
    && typeof rawMessage.type === "string" && /^[a-z.]{1,64}$/.test(rawMessage.type)
    ? rawMessage.type : "unknown";
}

function fallbackHtml(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const escaped = message
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `<!doctype html><html><body><p>${localize("ui.unable.to.load.the.chat.view")}</p><pre>${escaped}</pre></body></html>`;
}

/** The isolated chat branch first (its newer versions), then the project root; each root once. */
function contractRoots(worktree: string | undefined, projectRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath): string[] {
  return [...new Set([worktree, projectRoot].filter((root): root is string => Boolean(root)))];
}

/** Explorer and Scribe settings: their own fields over the Worker's (workLight, else work). */
function restrictedProfileModels(settings: AgentDefaults): Pick<AgentDefaults, "explore" | "scribe"> {
  const light = { ...(settings.work ?? {}), ...(settings.workLight ?? {}) };
  if (!settings.explore && !settings.scribe && !Object.keys(light).length) return {};
  return { explore: { ...light, ...(settings.explore ?? {}) }, scribe: { ...light, ...(settings.scribe ?? {}) } };
}
