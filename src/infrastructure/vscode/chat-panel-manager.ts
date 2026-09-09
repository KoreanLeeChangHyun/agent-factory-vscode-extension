import { homedir } from "node:os";
import { join } from "node:path";
import { readCliTheme } from "../agent-factory/cli-theme";
import { randomUUID } from "node:crypto";
import { readGitBranch } from "./git-branch";
import * as vscode from "vscode";
import type { StatusItemId } from "../../core/config/types";
import type { AttachmentReference } from "../../common/types/attachment";
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

type RuntimeConnection =
  | { readonly available: true; readonly client: AgentRuntimeClient }
  | { readonly available: false; readonly diagnostic: string };

interface ManagedPanel {
  readonly panel: vscode.WebviewPanel;
  state: ChatPanelState;
  readonly subscriptions: vscode.Disposable[];
  controller?: ChatSessionController;
  executionMode?: import("../agent-factory/agent-client").ExecutionMode;
  themeRevision?: number;
  themeSignature?: string;
  themeReady?: boolean;
  themeTimer?: NodeJS.Timeout;
  agentRefreshTimer?: NodeJS.Timeout;
  lastAgentRefreshAt?: number;
  branchRefreshTimer?: NodeJS.Timeout;
  branchRefreshStarted?: boolean;
}

const COMPOSER_PREFERENCES_KEY = "agentFactory.mainChat.composerPreferences";
const AGENT_REFRESH_INTERVAL_MS = 2_000;

export class ChatPanelManager implements vscode.Disposable {
  public readonly viewType = "agentFactory.mainChat";
  private readonly panels = new Map<string, ManagedPanel>();
  private activePanelId: string | undefined;

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
      this.webviewOptions()
    );
    await this.attach(panel, state);
  }

  public async revive(panel: vscode.WebviewPanel, serializedState: unknown): Promise<void> {
    const state = restoreChatState(serializedState, this.composerPreferences());
    const existing = this.panels.get(state.panelId);
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
      await vscode.window.showInformationMessage("이름을 변경할 Main Agent 채팅 탭을 먼저 선택하세요.");
      return;
    }

    const title = await vscode.window.showInputBox({
      title: "Main Agent 이름 변경",
      prompt: "이 채팅 탭에 표시할 이름을 입력하세요.",
      value: managed.state.title,
      valueSelection: [0, managed.state.title.length],
      validateInput(value) {
        const length = value.trim().length;
        if (length === 0) {
          return "이름을 입력하세요.";
        }
        if (length > 80) {
          return "이름은 80자 이하여야 합니다.";
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
    await this.post(managed.panel, { type: "chat.renamed", title: normalizedTitle });
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
    panel.iconPath = vscode.Uri.joinPath(
      this.context.extensionUri,
      "static",
      "images",
      "agent-factory.svg"
    );
    panel.webview.options = this.webviewOptions();

    const subscriptions: vscode.Disposable[] = [];
    const managed: ManagedPanel = { panel, state, subscriptions };
    subscriptions.push(new vscode.Disposable(() => {
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
    if (panel.active) {
      this.activePanelId = state.panelId;
    }

    subscriptions.push(
      panel.onDidDispose(() => {
        if (managed.agentRefreshTimer) clearTimeout(managed.agentRefreshTimer);
        this.panels.delete(state.panelId);
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
        text: "채팅 화면에서 올바르지 않은 메시지를 받았습니다."
      });
      return;
    }

    switch (message.type) {
      case "client.ready":
        managed.executionMode ??= this.defaultExecutionMode();
        await this.post(managed.panel, { type: "execution.updated", mode: managed.executionMode, locked: Boolean(managed.state.agentId) });
        managed.themeReady = true;
        managed.themeSignature = undefined;
        await this.refreshTheme(managed);
        const connection = await this.connectRuntime();
        await this.post(managed.panel, {
          type: "host.initialize",
          panelId: managed.state.panelId,
          title: managed.state.title,
          role: managed.state.role ?? "main",
          verifiedWorkRunId: managed.state.verifiedWorkRunId,
          projectName: workspaceName(),
          runtimeAvailable: connection.available,
          capabilities: connection.available ? await connection.client.capabilities(managed.state.agentId) : undefined,
          running: managed.controller?.running ?? false,
          statusItems: this.statusItems(),
          model: managed.state.model,
          reasoning: managed.state.reasoning,
          fastMode: managed.state.fastMode === true,
          goalMode: managed.state.goalMode === true,
          contextUsedTokens: managed.state.contextUsedTokens,
          contextWindowTokens: managed.state.contextWindowTokens
        });
        if (!connection.available) {
          await this.post(managed.panel, {
            type: "host.notice",
            level: "error",
            text: connection.diagnostic
          });
        }
        await this.sendModelList(managed);
        this.scheduleAgentList(managed, true);
        if (!managed.branchRefreshStarted) {
          managed.branchRefreshStarted = true;
          void this.refreshBranch(managed);
        }
        return;
      case "execution.pick":
        await this.pickExecutionMode(managed);
        return;
      case "chat.send":
        await this.sendChat(managed, message.text, message.attachments, message.execution);
        return;
      case "decision.approve":
        if (!managed.controller?.approveDecision(message.runId, {
          ...(managed.state.verifiedWorkRunId ? { verifiedWorkRunId: managed.state.verifiedWorkRunId } : {})
        })) {
          await this.post(managed.panel, { type: "decision.pending", runId: null });
          await this.post(managed.panel, { type: "host.notice", level: "warning", text: "이미 답변했거나 만료된 요청입니다. 현재 대화에 직접 답변하세요." });
        }
        return;
      case "composer.settings":
        managed.state = {
          ...managed.state,
          model: message.model,
          reasoning: message.reasoning,
          fastMode: message.fastMode,
          goalMode: message.goalMode
        };
        await this.saveComposerPreferences(managed.state);
        return;
      case "goal.control":
        if ((managed.state.role ?? "main") !== "main") return;
        await this.ensureController(managed);
        void managed.controller?.controlGoal(message.action);
        return;
      case "run.cancel":
        if (!managed.controller) {
          await this.post(managed.panel, { type: "host.notice", level: "info", text: "현재 실행 중인 Agent가 없습니다." });
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
        await this.selectSession(managed, message.agentId);
        return;
      case "attachments.pick":
        await this.pickAttachments(managed.panel);
        return;
      case "status.reorder":
        await this.saveStatusItems(managed.panel, message.items);
        return;
    }
  }

  private defaultExecutionMode(): import("../agent-factory/agent-client").ExecutionMode {
    const value = vscode.workspace.getConfiguration?.("agentFactory.mainChat").get<string>("executionMode", "danger-full-access");
    return value === "cli-default" || value === "workspace-write" ? value : "danger-full-access";
  }

  private async pickExecutionMode(managed: ManagedPanel): Promise<void> {
    if (managed.state.agentId || managed.controller?.running || (managed.state.role ?? "main") !== "main") return;
    const choice = await vscode.window.showQuickPick([
      { label: "CLI 기본값", description: "현재 Codex 설정 사용", mode: "cli-default" as const },
      { label: "작업 공간 쓰기", description: "작업 공간 쓰기 허용 · 추가 승인 없음", mode: "workspace-write" as const },
      { label: "전체 접근", description: "전체 파일 시스템·네트워크 접근 허용 · 추가 승인 없음", mode: "danger-full-access" as const }
    ], { title: "새 채팅 실행 권한", placeHolder: "이 채팅과 다음 새 채팅에 적용됩니다. 시작한 세션은 변경되지 않습니다." });
    if (!choice || managed.state.agentId || managed.controller?.running) return;
    managed.executionMode = choice.mode;
    await vscode.workspace.getConfiguration("agentFactory.mainChat").update("executionMode", choice.mode,
      vscode.ConfigurationTarget.Global);
    await this.post(managed.panel, { type: "execution.updated", mode: choice.mode, locked: Boolean(managed.state.agentId) });
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
    const connection = await this.connectRuntime();
    if (!connection.available) {
      await this.post(managed.panel, { type: "host.notice", level: "error", text: connection.diagnostic });
      return;
    }
    try {
      const agents = await connection.client.listChildSessions(managed.state.agentId);
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
          text: "Main Agent가 호출한 작업자 또는 검증자 세션을 찾을 수 없습니다."
        });
        return;
      }
      const label = child.role === "work" ? "작업자" : "검증자";
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
        this.webviewOptions()
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
    await this.context.globalState.update(COMPOSER_PREFERENCES_KEY, {
      model: state.model,
      reasoning: state.reasoning,
      fastMode: state.fastMode === true,
      goalMode: state.goalMode === true
    } satisfies ComposerPreferences);
  }

  private async selectSession(managed: ManagedPanel, agentId: string): Promise<void> {
    if (managed.controller?.running) {
      await this.post(managed.panel, {
        type: "host.notice",
        level: "warning",
        text: "현재 실행이 끝난 뒤 다른 세션을 불러오세요."
      });
      return;
    }
    const connection = await this.connectRuntime();
    if (!connection.available) {
      await this.post(managed.panel, { type: "host.notice", level: "error", text: connection.diagnostic });
      return;
    }
    try {
      const sessions = await connection.client.listSessions();
      if (!sessions.some((session) => session.agentId === agentId)) {
        await this.post(managed.panel, {
          type: "host.notice",
          level: "warning",
          text: "선택한 Main Agent 세션을 현재 프로젝트에서 찾을 수 없습니다."
        });
        await this.post(managed.panel, { type: "sessions.list", sessions });
        return;
      }
      managed.controller = undefined;
      await this.post(managed.panel, { type: "execution.updated", mode: "cli-default", locked: true });
      managed.state = { ...managed.state, agentId };
      await this.post(managed.panel, { type: "session.bound", agentId, reset: true });
      await this.post(managed.panel, { type: "capabilities.updated", capabilities: await connection.client.capabilities(agentId) });
      const observed = await connection.client.goal(agentId, "get");
      await this.post(managed.panel, { type: "goal.updated", goal: observed.goal ?? null, error: observed.error });
    } catch (error) {
      await this.post(managed.panel, {
        type: "host.notice",
        level: "error",
        text: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async ensureController(managed: ManagedPanel): Promise<void> {
    if (!managed.controller) {
      const connection = await this.connectRuntime();
      if (!connection.available) {
        await this.post(managed.panel, { type: "host.notice", level: "error", text: connection.diagnostic });
        await this.post(managed.panel, { type: "run.state", running: false });
        return;
      }
      managed.controller = new ChatSessionController(connection.client, {
        onBound: (agentId) => {
          managed.state = { ...managed.state, agentId };
          void this.post(managed.panel, { type: "execution.updated", mode: managed.executionMode ?? this.defaultExecutionMode(), locked: true });
          void this.post(managed.panel, { type: "session.bound", agentId });
          this.scheduleAgentList(managed, true);
        },
        onRunningChanged: (running) => {
          void this.post(managed.panel, { type: "run.state", running });
          this.scheduleAgentList(managed, !running);
        },
        onAssistantText: (responseText, phase, runId) => {
          void this.post(managed.panel, { type: "chat.assistant", text: responseText, phase, runId });
        },
        onDecision: (runId) => {
          void this.post(managed.panel, { type: "decision.pending", runId });
        },
        onHumanDecision: (text) => {
          void this.post(managed.panel, { type: "chat.human-decision", text });
        },
        onProgress: (progressText) => {
          void this.post(managed.panel, { type: "run.progress", text: progressText });
        },
        onUsage: (usedTokens, contextWindowTokens) => {
          managed.state = { ...managed.state, contextUsedTokens: usedTokens, contextWindowTokens };
          void this.post(managed.panel, { type: "context.usage", usedTokens, contextWindowTokens });
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
    execution: Extract<import("../../protocol/messages").ClientMessage, { type: "chat.send" }>["execution"]
  ): Promise<void> {
    await this.ensureController(managed);
    if (!managed.controller) return;
    void managed.controller.send(text, attachments, {
      ...(!managed.state.agentId && (managed.state.role ?? "main") === "main" ? { executionMode: managed.executionMode ?? this.defaultExecutionMode() } : {}),
      model: execution.model,
      reasoningEffort: execution.reasoningEffort,
      fast: execution.fast,
      goalMode: execution.goal,
      goalObjective: execution.goalObjective,
      ...((managed.state.role ?? "main") !== "main" ? { actor: "human" as const } : {}),
      ...(managed.state.verifiedWorkRunId ? { verifiedWorkRunId: managed.state.verifiedWorkRunId } : {})
    });
  }

  private async pickAttachments(panel: vscode.WebviewPanel): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: true,
      openLabel: "채팅에 첨부"
    });
    if (!uris?.length) {
      return;
    }

    const attachments: AttachmentReference[] = await Promise.all(
      uris.map(async (uri) => {
        let kind: AttachmentReference["kind"] = "file";
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          if ((stat.type & vscode.FileType.Directory) !== 0) {
            kind = "folder";
          }
        } catch {
          // The runtime performs the authoritative path validation before use.
        }
        return {
          id: randomUUID(),
          name: uri.path.split("/").filter(Boolean).at(-1) ?? uri.toString(),
          kind,
          uri: uri.toString()
        };
      })
    );
    await this.post(panel, { type: "attachments.add", attachments });
  }

  private async saveStatusItems(
    panel: vscode.WebviewPanel,
    items: readonly StatusItemId[]
  ): Promise<void> {
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    await vscode.workspace
      .getConfiguration("agentFactory.mainChat")
      .update("statusItems", items, target);
    await this.post(panel, { type: "status.updated", items });
  }

  private webviewOptions(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [...this.templates.localResourceRoots]
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

function fallbackHtml(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const escaped = message
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `<!doctype html><html><body><p>채팅 화면을 불러오지 못했습니다.</p><pre>${escaped}</pre></body></html>`;
}
