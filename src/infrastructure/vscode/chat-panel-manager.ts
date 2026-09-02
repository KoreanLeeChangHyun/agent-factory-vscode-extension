import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { StatusItemId } from "../../core/config/types";
import type { AttachmentReference } from "../../common/types/attachment";
import {
  createDraftChatState,
  restoreChatState,
  type ChatPanelState
} from "../../modules/chat/chat-state";
import type { HostMessage } from "../../protocol/messages";
import { parseClientMessage } from "../../protocol/validator";
import type { ChatTemplateRenderer } from "./chat-template-renderer";
import type { AgentRuntimeClient } from "../agent-factory/agent-client";
import { ChatSessionController } from "../../modules/chat/session-controller";

type RuntimeConnection =
  | { readonly available: true; readonly client: AgentRuntimeClient }
  | { readonly available: false; readonly diagnostic: string };

interface ManagedPanel {
  readonly panel: vscode.WebviewPanel;
  state: ChatPanelState;
  readonly subscriptions: vscode.Disposable[];
  controller?: ChatSessionController;
}

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
    const state = createDraftChatState();
    const panel = vscode.window.createWebviewPanel(
      this.viewType,
      state.title,
      vscode.ViewColumn.Active,
      this.webviewOptions()
    );
    await this.attach(panel, state);
  }

  public async revive(panel: vscode.WebviewPanel, serializedState: unknown): Promise<void> {
    const state = restoreChatState(serializedState);
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
    this.panels.set(state.panelId, managed);
    if (panel.active) {
      this.activePanelId = state.panelId;
    }

    subscriptions.push(
      panel.onDidDispose(() => {
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
        const connection = await this.connectRuntime();
        await this.post(managed.panel, {
          type: "host.initialize",
          panelId: managed.state.panelId,
          title: managed.state.title,
          projectName: workspaceName(),
          runtimeAvailable: connection.available,
          running: managed.controller?.running ?? false,
          statusItems: this.statusItems()
        });
        if (!connection.available) {
          await this.post(managed.panel, {
            type: "host.notice",
            level: "error",
            text: connection.diagnostic
          });
        }
        return;
      case "chat.send":
        await this.sendChat(managed, message.text, message.attachments, message.execution);
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
      managed.state = { ...managed.state, agentId };
      await this.post(managed.panel, { type: "session.bound", agentId, reset: true });
    } catch (error) {
      await this.post(managed.panel, {
        type: "host.notice",
        level: "error",
        text: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async sendChat(
    managed: ManagedPanel,
    text: string,
    attachments: readonly AttachmentReference[],
    execution: Extract<import("../../protocol/messages").ClientMessage, { type: "chat.send" }>["execution"]
  ): Promise<void> {
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
          void this.post(managed.panel, { type: "session.bound", agentId });
        },
        onRunningChanged: (running) => {
          void this.post(managed.panel, { type: "run.state", running });
        },
        onAssistantText: (responseText) => {
          void this.post(managed.panel, { type: "chat.assistant", text: responseText });
        },
        onProgress: (progressText) => {
          void this.post(managed.panel, { type: "run.progress", text: progressText });
        },
        onActivity: (activity) => {
          void this.post(managed.panel, { type: "run.activity", ...activity });
        },
        onError: (message) => {
          void this.post(managed.panel, { type: "host.notice", level: "error", text: message });
        }
      }, managed.state.agentId);
    }
    void managed.controller.send(text, attachments, {
      model: execution.model,
      reasoningEffort: execution.reasoningEffort,
      fast: execution.fast,
      goalMode: execution.goal
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
