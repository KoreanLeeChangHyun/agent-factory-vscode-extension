import { taskExecution } from "../../modules/chat/task-selection";
import { homedir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readCliTheme } from "../agent-factory/cli-theme";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open as openFile, realpath, unlink } from "node:fs/promises";
import { readGitBranch } from "./git-branch";
import { RunningTitle } from "./running-title";
import * as vscode from "vscode";
import type { StatusItemId } from "../../core/config/types";
import type { AttachmentReference } from "../../common/types/attachment";
import { canStageImage, decodeBrowserImage, hasImageSignature } from "../../common/image-input";
import {
  createDraftChatState,
  restoreChatState,
  type ChatPanelState,
  type ComposerPreferences
} from "../../modules/chat/chat-state";
import type { HostMessage } from "../../protocol/messages";
import { parseClientMessage } from "../../protocol/validator";
import type { ChatTemplateRenderer } from "./chat-template-renderer";
import type { AgentRuntimeClient } from "../agent-factory/agent-client";
import { readCodexModels } from "../agent-factory/model-catalog";
import { ChatSessionController } from "../../modules/chat/session-controller";
import { writeNewImageAttachment } from "./image-attachment-store";

type RuntimeConnection =
  | { readonly available: true; readonly client: AgentRuntimeClient }
  | { readonly available: false; readonly diagnostic: string };

interface ManagedPanel {
  readonly panel: vscode.WebviewPanel;
  state: ChatPanelState;
  readonly subscriptions: vscode.Disposable[];
  readonly imageAttachments: Map<string, number>;
  imageMutation: Promise<void>;
  chatSendPreparation: Promise<void>;
  pendingMessageIds?: Set<string>;
  startedMessages?: Extract<HostMessage, { type: "chat.started" }>[];
  controller?: ChatSessionController;
  controllerInitialization?: Promise<void>;
  sessionTransition?: Promise<void>;
  disposed?: boolean;
  executionModeExplicit?: boolean;
  executionMode?: import("../agent-factory/agent-client").ExecutionMode;
  themeRevision?: number;
  themeSignature?: string;
  themeReady?: boolean;
  themeTimer?: NodeJS.Timeout;
  agentRefreshTimer?: NodeJS.Timeout;
  lastAgentRefreshAt?: number;
  branchRefreshTimer?: NodeJS.Timeout;
  branchRefreshStarted?: boolean;
  runningTitle?: RunningTitle;
}

const COMPOSER_PREFERENCES_KEY = "agentFactory.mainChat.composerPreferences";
const AGENT_REFRESH_INTERVAL_MS = 2_000;
const SIDEBAR_AGENTS_KEY = "agentFactory.sidebar.agents";

export interface SidebarAgent {
  readonly state: ChatPanelState;
  readonly running: boolean;
}

export class ChatPanelManager implements vscode.Disposable {
  public readonly viewType = "agentFactory.mainChat";
  private readonly panels = new Map<string, ManagedPanel>();
  private activePanelId: string | undefined;
  private readonly sidebarListeners = new Set<() => void>();
  private sidebarAgentWrite: Promise<void> = Promise.resolve();

  public onAgentsChanged(listener: () => void): vscode.Disposable {
    this.sidebarListeners.add(listener);
    return { dispose: () => { this.sidebarListeners.delete(listener); } };
  }

  private notifyAgents(): void {
    for (const listener of this.sidebarListeners) listener();
  }

  private savedAgents(): ChatPanelState[] {
    const saved = this.context.workspaceState?.get<unknown>(SIDEBAR_AGENTS_KEY);
    return Array.isArray(saved) ? saved.map(value => restoreChatState(value)) : [];
  }

  private rememberAgent(state: ChatPanelState): Promise<void> {
    if ((state.role ?? "main") !== "main") return Promise.resolve();
    const snapshot = { ...state };
    const write = this.sidebarAgentWrite.then(async () => {
      const saved = this.savedAgents().filter(entry => entry.panelId !== snapshot.panelId &&
        (!snapshot.agentId || entry.agentId !== snapshot.agentId));
      await this.context.workspaceState?.update(SIDEBAR_AGENTS_KEY, [...saved, snapshot]);
    });
    this.sidebarAgentWrite = write.catch(() => undefined);
    void write.then(() => this.notifyAgents(), () => undefined);
    return write;
  }

  public async sidebarAgents(): Promise<SidebarAgent[]> {
    await this.sidebarAgentWrite;
    const states = this.savedAgents();
    const connection = await this.connectRuntime();
    if (connection.available) {
      for (const session of await connection.client.listSessions()) {
        if (!states.some(state => state.agentId === session.agentId)) {
          states.push({ panelId: session.agentId, title: session.agentId, role: "main", agentId: session.agentId, model: session.model });
        }
      }
    }
    for (const managed of this.panels.values()) {
      if ((managed.state.role ?? "main") !== "main") continue;
      const index = states.findIndex(state => state.panelId === managed.state.panelId ||
        (state.agentId && state.agentId === managed.state.agentId));
      if (index >= 0) states[index] = managed.state;
      else states.push(managed.state);
    }
    return states.map(state => ({ state, running: [...this.panels.values()].some(panel =>
      (panel.state.panelId === state.panelId || (state.agentId && panel.state.agentId === state.agentId)) && panel.controller?.running === true) }));
  }

  public async openSidebarAgent(state: ChatPanelState): Promise<void> {
    const existing = [...this.panels.values()].find(panel => panel.state.panelId === state.panelId ||
      (state.agentId && panel.state.agentId === state.agentId));
    if (existing) { existing.panel.reveal(undefined, true); return; }
    const panel = vscode.window.createWebviewPanel(this.viewType, state.title, vscode.ViewColumn.Active, this.webviewOptions(state.panelId));
    await this.attach(panel, { ...this.composerPreferences(), ...state });
  }

  public async renameSidebarAgent(state: ChatPanelState, title: string): Promise<void> {
    const updated = { ...state, title };
    for (const managed of this.panels.values()) {
      if (managed.state.panelId !== state.panelId && (!state.agentId || managed.state.agentId !== state.agentId)) continue;
      managed.state = { ...managed.state, title };
      managed.panel.title = title;
      if (managed.controller?.running) managed.runningTitle?.refresh();
      await this.post(managed.panel, { type: "chat.renamed", title });
    }
    await this.rememberAgent(updated);
  }

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly templates: ChatTemplateRenderer,
    private readonly statusItems: () => readonly StatusItemId[],
    private readonly connectRuntime: () => Promise<RuntimeConnection>
  ) {}

  public async openDraft(): Promise<void> {
    const state = { ...createDraftChatState(this.composerPreferences()), role: "main" as const };
    const panel = vscode.window.createWebviewPanel(
      this.viewType,
      state.title,
      vscode.ViewColumn.Active,
      this.webviewOptions(state.panelId)
    );
    await this.attach(panel, state);
  }

  public async revive(panel: vscode.WebviewPanel, serializedState: unknown): Promise<void> {
    const state = restoreChatState(serializedState, this.composerPreferences());
    const panelMatch = this.panels.get(state.panelId);
    const existing = (panelMatch && !panelMatch.disposed ? panelMatch : undefined) ?? [...this.panels.values()].find(candidate =>
      Boolean(!candidate.disposed && state.agentId && candidate.state.agentId === state.agentId));
    if (existing) {
      existing.panel.reveal(panel.viewColumn, true);
      panel.dispose();
      return;
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
      await vscode.window.showInformationMessage("Select the Main Agent chat tab to rename first.");
      return;
    }

    const title = await vscode.window.showInputBox({
      title: "Rename Main Agent",
      prompt: "Enter the name to display on this chat tab.",
      value: managed.state.title,
      valueSelection: [0, managed.state.title.length],
      validateInput(value) {
        const length = value.trim().length;
        if (length === 0) {
          return "Enter a name.";
        }
        if (length > 80) {
          return "The name must be no more than 80 characters.";
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
    if (managed.controller?.running) managed.runningTitle?.refresh();
    await this.post(managed.panel, { type: "chat.renamed", title: normalizedTitle });
    this.rememberAgent(managed.state);
  }

  public dispose(): void {
    for (const managed of this.panels.values()) {
      for (const subscription of managed.subscriptions) {
        subscription.dispose();
      }
      managed.panel.dispose();
    }
    this.panels.clear();
  }

  private async attach(panel: vscode.WebviewPanel, state: ChatPanelState): Promise<void> {
    panel.title = state.title;
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "static", "images", "agent-factory.png");
    panel.webview.options = this.webviewOptions(state.panelId);

    const subscriptions: vscode.Disposable[] = [];
    const managed: ManagedPanel = {
      panel,
      state,
      subscriptions,
      imageAttachments: new Map(),
      imageMutation: Promise.resolve(),
      chatSendPreparation: Promise.resolve()
    };
    managed.runningTitle = new RunningTitle(() => managed.state.title, (title) => { panel.title = title; });
    subscriptions.push(managed.runningTitle);
    subscriptions.push(new vscode.Disposable(() => {
      managed.disposed = true;
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
    this.panels.set(state.panelId, managed);
    this.rememberAgent(state);
    if (panel.active) {
      this.activePanelId = state.panelId;
    }

    subscriptions.push(
      panel.onDidDispose(() => {
        if (managed.agentRefreshTimer) clearTimeout(managed.agentRefreshTimer);
        this.panels.delete(state.panelId);
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
          void this.refreshTheme(managed);
        }
      }),
      panel.webview.onDidReceiveMessage(async (rawMessage: unknown) => {
        await this.handleMessage(managed, rawMessage);
      })
    );

    try {
      panel.webview.html = await this.templates.render(panel.webview);
    } catch (error) {
      this.panels.delete(state.panelId);
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
        const branch = await readGitBranch(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
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

  private async handleMessage(managed: ManagedPanel, rawMessage: unknown): Promise<void> {
    const message = parseClientMessage(rawMessage);
    if (!message) {
      await this.post(managed.panel, {
        type: "host.notice",
        level: "error",
        text: "Received an invalid message from the chat view."
      });
      return;
    }

    switch (message.type) {
      case "client.ready":
        if (!managed.state.agentId) managed.executionMode ??= this.defaultExecutionMode();
        await this.post(managed.panel, { type: "execution.updated", mode: managed.executionMode });
        managed.themeReady = true;
        managed.themeSignature = undefined;
        await this.refreshTheme(managed);
        const connection = await this.connectRuntime();
        const capabilities = connection.available ? await connection.client.capabilities(managed.state.agentId) : undefined;
        if (managed.state.agentId && !managed.executionMode) {
          await this.post(managed.panel, { type: "execution.updated", mode: capabilities?.executionMode });
        }
        await this.post(managed.panel, {
          type: "host.initialize",
          panelId: managed.state.panelId,
          title: managed.state.title,
          role: managed.state.role ?? "main",
          verifiedWorkRunId: managed.state.verifiedWorkRunId,
          projectName: workspaceName(),
          runtimeAvailable: connection.available,
          capabilities,
          running: managed.controller?.running ?? Boolean(managed.state.agentId && connection.available),
          statusItems: this.statusItems(),
          model: managed.state.model,
          agentModels: managed.state.agentModels,
          reasoning: managed.state.reasoning,
          businessMode: "normal",
          taskMode: "direct",
          fastMode: managed.state.fastMode === true,
          goalMode: false,
          workLoopMode: false,
          contextUsedTokens: managed.state.contextUsedTokens,
          contextWindowTokens: managed.state.contextWindowTokens,
          weeklyUsedPercent: managed.state.weeklyUsedPercent,
          pendingMessageIds: [...(managed.pendingMessageIds ?? [])],
          queueCount: managed.controller?.queueLength ?? 0
        });
        for (const started of managed.startedMessages ?? []) await this.post(managed.panel, started);
        if (!connection.available) {
          await this.post(managed.panel, {
            type: "host.notice",
            level: "error",
            text: connection.diagnostic
          });
        }
        await this.sendModelList(managed);
        if (managed.state.agentId) await this.post(managed.panel, { type: "session.bound", agentId: managed.state.agentId });
        if (managed.state.agentId && connection.available) {
          await this.ensureController(managed);
          try { await managed.controller?.reconnect(); }
          catch (error) {
            await this.post(managed.panel, { type: "host.notice", level: "error", text: `Unable to check the active run: ${error instanceof Error ? error.message : String(error)}` });
          }
        }
        this.scheduleAgentList(managed, true);
        if (!managed.branchRefreshStarted) {
          managed.branchRefreshStarted = true;
          void this.refreshBranch(managed);
        }
        return;
      case "reference.copy":
        await vscode.env.clipboard.writeText(message.id);
        return;
      case "link.open":
        await this.openLink(managed, message.href);
        return;
      case "execution.select":
        await this.selectExecutionMode(managed, message.mode);
        return;
      case "chat.send": {
        const previous = managed.startedMessages?.find(item => item.id === message.id);
        if (previous) { await this.post(managed.panel, previous); return; }
        if (managed.pendingMessageIds?.has(message.id)) return;
        (managed.pendingMessageIds ??= new Set()).add(message.id);
        // Capture permissions before asynchronous attachment preparation or setting changes.
        const executionMode = managed.executionMode ?? this.defaultExecutionMode();
        const executionModeExplicit = managed.executionModeExplicit || !managed.state.agentId;
        const sendPreparation = (managed.chatSendPreparation ?? Promise.resolve()).then(() =>
          this.sendChat(managed, message.text, message.attachments, message.execution, message.id, executionMode, executionModeExplicit));
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
        })) {
          await this.post(managed.panel, { type: "decision.pending", runId: null });
          await this.post(managed.panel, { type: "host.notice", level: "warning", text: "This request has already been answered or has expired. Reply directly in the current conversation." });
        }
        return;
      case "composer.settings":
        managed.state = {
          ...managed.state,
          businessMode: "normal",
          taskMode: "direct",
          model: message.model,
          agentModels: message.agentModels,
          reasoning: message.reasoning,
          fastMode: message.fastMode,
          goalMode: false,
          workLoopMode: false
        };
        await this.saveComposerPreferences(managed.state);
        return;
      case "goal.control":
        if ((managed.state.role ?? "main") !== "main") return;
        await this.ensureController(managed);
        void managed.controller?.controlGoal(message.action);
        return;
      case "queue.resume":
        try { await managed.controller?.reconnect(); }
        catch (error) { await this.post(managed.panel, { type: "host.notice", level: "error", text: String(error) }); }
        return;
      case "run.cancel":
        if (!managed.controller) {
          await this.post(managed.panel, { type: "run.state", running: false });
        } else {
          await managed.controller.cancel();
        }
        return;
      case "sessions.request":
        await this.sendSessionList(managed);
        return;
      case "models.request":
        await this.sendModelList(managed);
        return;
      case "agents.request":
        await this.sendAgentList(managed);
        return;
      case "agent.open":
        await this.openChildAgent(managed, message.agentId);
        return;
      case "session.select":
        if (managed.sessionTransition) {
          await this.post(managed.panel, { type: "host.notice", level: "warning", text: "Another session is loading." });
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
      case "attachments.createText":
        await this.createTextAttachment(managed, message.text);
        return;
      case "attachments.createImage":
        await this.mutateImages(managed, () => this.createImageAttachment(managed, message));
        return;
      case "attachments.restore":
        await this.mutateImages(managed, () => this.restoreImageAttachments(managed, message.attachments));
        return;
      case "attachment.open":
        await this.openImageAttachment(managed, message.id);
        return;
      case "attachment.remove":
        await this.mutateImages(managed, () => this.removeImageAttachment(managed, message.id));
        return;
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
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const filePath = isAbsolute(target.path)
        ? target.path
        : resolve(workspaceRoot ?? this.context.extensionUri.fsPath, target.path);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
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
        text: `Unable to open the link: ${error instanceof Error ? error.message : String(error)}`
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
    const connection = await this.connectRuntime();
    if (!connection.available) {
      await this.post(managed.panel, { type: "sessions.list", sessions: [] });
      await this.post(managed.panel, { type: "host.notice", level: "error", text: connection.diagnostic });
      return;
    }
    try {
      const sessions = await connection.client.listSessions();
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

  private async sendModelList(managed: ManagedPanel): Promise<void> {
    const models = await readCodexModels();
    if (models !== undefined) await this.post(managed.panel, { type: "models.list", models });
  }

  private async sendAgentList(managed: ManagedPanel): Promise<void> {
    if (!managed.state.agentId || (managed.state.role ?? "main") !== "main") {
      await this.post(managed.panel, { type: "agents.list", agents: [] });
      return;
    }
    const agentId = managed.state.agentId;
    const running = managed.controller?.running === true;
    const runId = managed.controller?.runId;
    if (running && !runId) {
      await this.post(managed.panel, { type: "agents.list", agents: [] });
      return;
    }
    const connection = await this.connectRuntime();
    if (!connection.available) {
      await this.post(managed.panel, { type: "host.notice", level: "error", text: connection.diagnostic });
      return;
    }
    try {
      const agents = await connection.client.listChildSessions(agentId, running ? runId : undefined);
      if (managed.state.agentId !== agentId || (managed.controller?.running === true) !== running || managed.controller?.runId !== runId) return;
      await this.post(managed.panel, { type: "agents.list", agents });
    } catch (error) {
      await this.post(managed.panel, {
        type: "host.notice",
        level: "error",
        text: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private scheduleAgentList(managed: ManagedPanel, immediate = false): void {
    if (!managed.state.agentId || (managed.state.role ?? "main") !== "main") return;
    const elapsed = Date.now() - (managed.lastAgentRefreshAt ?? 0);
    const delay = immediate ? 0 : Math.max(0, AGENT_REFRESH_INTERVAL_MS - elapsed);
    if (managed.agentRefreshTimer) {
      if (!immediate) return;
      clearTimeout(managed.agentRefreshTimer);
    }
    managed.agentRefreshTimer = setTimeout(() => {
      managed.agentRefreshTimer = undefined;
      managed.lastAgentRefreshAt = Date.now();
      void this.sendAgentList(managed);
    }, delay);
  }

  private async openChildAgent(managed: ManagedPanel, agentId: string): Promise<void> {
    if (!managed.state.agentId || (managed.state.role ?? "main") !== "main") return;
    const connection = await this.connectRuntime();
    if (!connection.available) {
      await this.post(managed.panel, { type: "host.notice", level: "error", text: connection.diagnostic });
      return;
    }
    try {
      const child = (await connection.client.listChildSessions(managed.state.agentId))
        .find((candidate) => candidate.agentId === agentId);
      if (!child) {
        await this.post(managed.panel, {
          type: "host.notice",
          level: "warning",
          text: "Unable to find the work or verification session called by Main Agent."
        });
        return;
      }
      const existing = [...this.panels.values()].find(candidate =>
        !candidate.disposed && candidate.state.agentId === child.agentId);
      if (existing) {
        existing.panel.reveal(undefined, true);
        return;
      }
      const label = child.role === "work" ? "Work agent" : "Verification agent";
      const state: ChatPanelState = {
        ...createDraftChatState(this.composerPreferences()),
        title: `${label} · ${child.agentId}`,
        agentId: child.agentId,
        role: child.role,
        ...(child.verifiedWorkRunId ? { verifiedWorkRunId: child.verifiedWorkRunId } : {})
      };
      const panel = vscode.window.createWebviewPanel(
        this.viewType,
        state.title,
        vscode.ViewColumn.Active,
        this.webviewOptions(state.panelId)
      );
      await this.attach(panel, state);
    } catch (error) {
      await this.post(managed.panel, {
        type: "host.notice",
        level: "error",
        text: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private composerPreferences(): ComposerPreferences {
    return restoreChatState(
      this.context.globalState.get(COMPOSER_PREFERENCES_KEY),
      {}
    );
  }

  private async saveComposerPreferences(state: ChatPanelState): Promise<void> {
    // A child chat override must not replace the Main composer defaults.
    if (state.role && state.role !== "main") return;
    await this.context.globalState.update(COMPOSER_PREFERENCES_KEY, {
      model: state.model,
      agentModels: state.agentModels,
      reasoning: state.reasoning,
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
        text: "Other Main Agent sessions can only be loaded from a Main Agent panel."
      });
      return;
    }
    if (managed.controllerInitialization) await managed.controllerInitialization;
    if (managed.disposed) return;
    if (managed.controller?.running || managed.controller?.queueLength || managed.pendingMessageIds?.size) {
      await this.post(managed.panel, {
        type: "host.notice",
        level: "warning",
        text: "Load another session after the current run finishes."
      });
      return;
    }
    const existing = [...this.panels.values()].find(candidate =>
      candidate !== managed && !candidate.disposed && candidate.state.agentId === agentId);
    if (existing) {
      existing.panel.reveal(undefined, true);
      return;
    }
    const connection = await this.connectRuntime();
    if (managed.disposed) return;
    if (!connection.available) {
      await this.post(managed.panel, { type: "host.notice", level: "error", text: connection.diagnostic });
      return;
    }
    try {
      const sessions = await connection.client.listSessions();
      if (managed.disposed) return;
      if (!sessions.some((session) => session.agentId === agentId)) {
        await this.post(managed.panel, {
          type: "host.notice",
          level: "warning",
          text: "The selected Main Agent session was not found in the current project."
        });
        await this.post(managed.panel, { type: "sessions.list", sessions });
        return;
      }
      if (managed.controller?.running || managed.controller?.queueLength || managed.pendingMessageIds?.size) {
        await this.post(managed.panel, {
          type: "host.notice",
          level: "warning",
          text: "Load another session after the current run finishes."
        });
        return;
      }
      const claimed = [...this.panels.values()].find(candidate =>
        candidate !== managed && !candidate.disposed && candidate.state.agentId === agentId);
      if (claimed) {
        claimed.panel.reveal(undefined, true);
        return;
      }
      managed.controller?.dispose();
      managed.startedMessages = [];
      managed.controller = undefined;
      managed.executionMode = undefined;
      managed.executionModeExplicit = false;
      managed.state = { ...managed.state, agentId, contextUsedTokens: undefined, contextWindowTokens: undefined, weeklyUsedPercent: undefined };
      await this.post(managed.panel, { type: "execution.updated", mode: managed.executionMode });
      if (managed.disposed) return;
      await this.rememberAgent(managed.state);
      if (managed.disposed) return;
      await this.post(managed.panel, { type: "session.bound", agentId, reset: true });
      if (managed.disposed) return;
      await this.reconnectController(managed);
      if (managed.disposed) return;
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
      const connection = await this.connectRuntime();
      if (managed.disposed) return;
      if (!connection.available) {
        await this.post(managed.panel, { type: "host.notice", level: "error", text: connection.diagnostic });
        await this.post(managed.panel, { type: "run.state", running: false });
        return;
      }
      managed.controller = new ChatSessionController(connection.client, {
        onBound: (agentId) => {
          managed.state = { ...managed.state, agentId, contextUsedTokens: undefined, contextWindowTokens: undefined, weeklyUsedPercent: undefined };
          this.rememberAgent(managed.state);
          void this.post(managed.panel, { type: "execution.updated", mode: managed.executionMode ?? this.defaultExecutionMode() });
          void this.post(managed.panel, { type: "session.bound", agentId });
          this.scheduleAgentList(managed, true);
        },
        onRunningChanged: (running) => {
          this.notifyAgents();
          managed.runningTitle?.setRunning(running);
          void this.post(managed.panel, { type: "run.state", running });
          this.scheduleAgentList(managed, !running);
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
        onAssistantText: (responseText, phase, runId) => {
          void this.post(managed.panel, { type: "chat.assistant", text: responseText, phase, runId });
        },
        onDecision: (runId) => {
          void this.post(managed.panel, { type: "decision.pending", runId });
        },
        onHumanDecision: (text, submission) => {
          void this.post(managed.panel, { type: "chat.human-decision", text, submission });
        },
        onProgress: (progressText) => {
          void this.post(managed.panel, { type: "run.progress", text: progressText });
        },
        onUsage: (usedTokens, contextWindowTokens, weeklyUsedPercent) => {
          managed.state = { ...managed.state, contextUsedTokens: usedTokens, contextWindowTokens, weeklyUsedPercent };
          void this.post(managed.panel, { type: "context.usage", usedTokens, contextWindowTokens, weeklyUsedPercent });
        },
        onActivity: (activity) => {
          void this.post(managed.panel, { type: "run.activity", ...activity });
        },
        onGoal: (goal, error) => {
          void this.post(managed.panel, { type: "goal.updated", goal, error });
        },
        onStatusObserved: () => {
          this.scheduleAgentList(managed);
        },
        onError: (message) => {
          void this.post(managed.panel, { type: "host.notice", level: "error", text: message });
        }
      }, managed.state.agentId);
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
    const goalMode = (managed.state.role ?? "main") === "main" && execution.taskMode !== "verification" && execution.goal;
    const goalObjective = goalMode ? text.trim() : undefined;
    if (goalMode && (!goalObjective || goalObjective.length > 4000)) {
      throw new Error("Enter a chat message of 1–4,000 characters or turn off Goal.");
    }
    await this.ensureController(managed);
    if (!managed.controller) throw new Error("Unable to connect to the runtime. Queued messages have been preserved.");
    const preparedAttachments = await Promise.all(attachments.map(async (attachment) => {
      if (attachment.kind !== "image") return attachment;
      const uri = await this.imageAttachmentPath(managed.state.panelId, attachment.id);
      if (!uri) throw new Error(`Unable to locate the original image attachment: ${attachment.name}`);
      const mediaType = imageMediaType(uri.fsPath);
      if (!mediaType) throw new Error(`Unsupported image attachment: ${attachment.name}`);
      const info = await vscode.workspace.fs.stat(uri);
      return { ...attachment, uri: uri.toString(), mediaType, size: info.size, previewUri: undefined };
    }));
    let started = false;
    void managed.controller.send(text, preparedAttachments, {
      ...((managed.state.role ?? "main") === "main" && (!managed.state.agentId || executionModeExplicit) ? { executionMode } : {}),
      ...((managed.state.role ?? "main") === "main" ? { ...taskExecution(execution.taskMode), businessMode: execution.businessMode ?? "normal" } : {}),
      model: execution.model,
      agentModels: execution.agentModels,
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
      managed.startedMessages = managed.startedMessages.slice(-200);
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
    const panel = managed.panel;
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      // Windows/Linux cannot select files and folders together: that opens a folder picker.
      canSelectFolders: false,
      canSelectMany: true,
      title: "Attach files to chat",
      openLabel: "Attach to chat"
    });
    if (!uris?.length) {
      return;
    }

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
      await this.post(panel, { type: "host.notice", level: "error", text: `Unable to prepare attachments: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    if (attachments.length) await this.post(panel, { type: "attachments.add", attachments });
    if (rejectedImages) await this.post(panel, { type: "host.notice", level: "warning", text: `Excluded ${rejectedImages} images due to attachment limits (up to 8 images, 10 MiB each, 20 MiB total).` });
  }

  private async createTextAttachment(managed: ManagedPanel, text: string): Promise<void> {
    try {
      const directory = vscode.Uri.joinPath(
        this.context.globalStorageUri,
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
        text: `Unable to create a file from pasted text: ${error instanceof Error ? error.message : String(error)}`
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
      if (!canStageImage(managed.imageAttachments.size, stagedBytes, content.byteLength)) throw new Error("Image attachment limit exceeded.");
      const attachment = await this.persistImage(managed.panel, managed.state.panelId, message.id, message.name, message.mediaType, content);
      managed.imageAttachments.set(message.id, content.byteLength);
      await this.post(managed.panel, { type: "attachments.add", attachments: [attachment] });
    } catch (error) {
      await this.post(managed.panel, { type: "attachment.rejected", id: message.id });
      await this.post(managed.panel, { type: "host.notice", level: "error", text: `Unable to save the image attachment: ${error instanceof Error ? error.message : String(error)}` });
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
    if (content.byteLength < 1 || content.byteLength > 10 * 1024 * 1024 || !hasImageSignature(content, mediaType)) throw new Error("The image is unsupported or too large.");
    const suffix = imageSuffix(mediaType);
    const directory = vscode.Uri.joinPath(this.context.globalStorageUri, "chat-images", panelId, id.slice(0, 2));
    await vscode.workspace.fs.createDirectory(directory);
    const uri = vscode.Uri.joinPath(directory, `${id}${suffix}`);
    await writeNewImageAttachment(uri.fsPath, content);
    return { id, name, kind: "image", uri: uri.toString(), previewUri: panel.webview.asWebviewUri(uri).toString(), mediaType, size: content.byteLength };
  }

  private async imageAttachmentPath(panelId: string, id: string): Promise<vscode.Uri | undefined> {
    assertAttachmentScopeId(panelId, "panel");
    assertAttachmentScopeId(id, "attachment");
    const base = vscode.Uri.joinPath(this.context.globalStorageUri, "chat-images", panelId, id.slice(0, 2));
    for (const suffix of [".png", ".jpg", ".gif", ".webp"]) {
      const uri = vscode.Uri.joinPath(base, `${id}${suffix}`);
      try {
        const file = await openFile(uri.fsPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        try { if ((await file.stat()).isFile()) return uri; } finally { await file.close(); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return undefined;
  }

  private async openImageAttachment(managed: ManagedPanel, id: string): Promise<void> {
    const uri = await this.imageAttachmentPath(managed.state.panelId, id);
    if (!uri) {
      await this.post(managed.panel, { type: "host.notice", level: "warning", text: "The original image no longer exists." });
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
      if (report) await this.post(managed.panel, { type: "host.notice", level: "warning", text: `Unable to clean up temporary image files: ${error instanceof Error ? error.message : String(error)}` });
    }
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
        await this.post(panel, { type: "host.notice", level: "warning", text: "Unable to save status bar settings. Reloading the saved settings." });
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
        vscode.Uri.joinPath(this.context.globalStorageUri, "chat-images", panelId)
      ])
    };
  }

  private async post(panel: vscode.WebviewPanel, message: HostMessage): Promise<void> {
    await panel.webview.postMessage(message);
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
  return vscode.workspace.name ?? "No workspace";
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
  const suffixLocation = path.match(/^(.*):(\d+)(?::(\d+))?$/);
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
  if (!suffix) throw new Error("Unsupported image format.");
  return suffix;
}

async function readSafeImage(path: string): Promise<Buffer> {
  if (await realpath(path) !== resolve(path)) throw new Error("Symbolic link images cannot be attached.");
  const file = await openFile(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 1 || before.size > 10 * 1024 * 1024) throw new Error("Image size is outside the allowed range.");
    const content = await file.readFile();
    const after = await file.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("The image changed while being read.");
    return content;
  } finally { await file.close(); }
}

function assertAttachmentScopeId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error(`${label} image scope is invalid`);
}

function uniqueUris(uris: readonly vscode.Uri[]): vscode.Uri[] {
  return [...new Map(uris.map((uri) => [uri.toString(), uri])).values()];
}

function fallbackHtml(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const escaped = message
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `<!doctype html><html><body><p>Unable to load the chat view.</p><pre>${escaped}</pre></body></html>`;
}
