import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import type { ChatPanelManager, SidebarAgent } from "./chat-panel-manager";

interface Group { id: string; name: string }
interface Layout { groups: Group[]; assignments: Record<string, string> }
type Node = { kind: "group"; group: Group } | { kind: "agent"; agent: SidebarAgent };
const VIEW = "agentFactory.agents";
const STORAGE = "agentFactory.sidebar.groups";
const DRAG_MIME = "application/vnd.code.tree.agentfactory.agents";

export class AgentSidebar implements vscode.TreeDataProvider<Node>, vscode.TreeDragAndDropController<Node>, vscode.Disposable {
  public readonly dragMimeTypes = [DRAG_MIME];
  public readonly dropMimeTypes = [DRAG_MIME];
  private readonly dragSource = randomUUID();
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  public readonly onDidChangeTreeData = this.changed.event;
  private readonly subscriptions: vscode.Disposable[] = [this.changed];
  private agents: SidebarAgent[] = [];
  private layout: Layout;
  private revision = 0;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly view: vscode.TreeView<Node>;

  public constructor(private readonly context: vscode.ExtensionContext, private readonly panels: ChatPanelManager) {
    const saved = context.workspaceState.get<Layout>(STORAGE);
    this.layout = {
      groups: Array.isArray(saved?.groups) ? saved.groups.filter(group => typeof group?.id === "string" && typeof group.name === "string") : [],
      assignments: saved?.assignments && typeof saved.assignments === "object" ? { ...saved.assignments } : {}
    };
    this.view = vscode.window.createTreeView(VIEW, {
      treeDataProvider: this, dragAndDropController: this, canSelectMany: true, showCollapseAll: true
    });
    this.subscriptions.push(this.view, panels.onAgentsChanged(() => this.scheduleRefresh()),
      this.view.onDidChangeVisibility(event => { if (event.visible) void this.refresh(); }));
    const command = (name: string, action: (node?: Node) => unknown) => this.subscriptions.push(
      vscode.commands.registerCommand(`agentFactory.sidebar.${name}`, async (node?: Node) => {
        try { await action(node); }
        catch (error) { await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); }
      })
    );
    command("refresh", () => this.refresh());
    command("open", node => node?.kind === "agent" ? panels.openSidebarAgent(node.agent.state) : undefined);
    command("rename", node => this.rename(node));
    command("newGroup", () => this.newGroup());
    command("move", node => this.move(node));
    command("renameGroup", node => this.renameGroup(node));
    command("deleteGroup", node => this.deleteGroup(node));
    void this.refresh();
  }

  private scheduleRefresh(): void {
    if (this.disposed || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, 100);
  }

  public async refresh(): Promise<void> {
    const revision = ++this.revision;
    try {
      const agents = await this.panels.sidebarAgents();
      if (this.disposed || revision !== this.revision) return;
      this.agents = agents;
      this.view.message = agents.length ? undefined : "＋ 버튼으로 새 에이전트 채팅을 시작하세요.";
      this.changed.fire(undefined);
    } catch (error) {
      if (this.disposed || revision !== this.revision) return;
      this.view.message = `목록을 불러오지 못했습니다. 새로고침으로 다시 시도하세요. ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  public getChildren(node?: Node): Node[] {
    if (node?.kind === "agent") return [];
    const agents = this.agents.filter(agent => {
      const groupId = this.layout.assignments[agent.state.panelId];
      return node ? groupId === node.group.id : !this.layout.groups.some(group => group.id === groupId);
    }).map(agent => ({ kind: "agent" as const, agent }));
    return node ? agents : [...this.layout.groups.map(group => ({ kind: "group" as const, group })), ...agents];
  }

  public getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "group") {
      const item = new vscode.TreeItem(node.group.name, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `group:${node.group.id}`;
      item.contextValue = "agentFactoryGroup";
      item.iconPath = new vscode.ThemeIcon("folder");
      item.description = String(this.getChildren(node).length);
      return item;
    }
    const { state, running } = node.agent;
    const item = new vscode.TreeItem(state.title, vscode.TreeItemCollapsibleState.None);
    item.id = `agent:${state.panelId}`;
    item.contextValue = "agentFactoryAgent";
    item.description = running ? "실행 중" : state.agentId ? undefined : "새 채팅";
    item.tooltip = [state.title, state.agentId, state.model].filter(Boolean).join("\n");
    item.iconPath = new vscode.ThemeIcon(running ? "loading~spin" : "comment-discussion");
    item.command = { command: "agentFactory.sidebar.open", title: "에이전트 열기", arguments: [node] };
    return item;
  }

  public handleDrag(nodes: readonly Node[], transfer: vscode.DataTransfer, token: vscode.CancellationToken): void {
    if (token.isCancellationRequested || this.disposed) return;
    const ids = nodes.filter(node => node.kind === "agent").map(node => node.agent.state.panelId);
    if (ids.length) transfer.set(DRAG_MIME, new vscode.DataTransferItem({ source: this.dragSource, ids }));
  }

  public async handleDrop(target: Node | undefined, transfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
    if (token.isCancellationRequested || this.disposed) return;
    const payload = transfer.get(DRAG_MIME)?.value;
    if (!payload || payload.source !== this.dragSource || !Array.isArray(payload.ids)) return;
    const groupId = target?.kind === "group" ? target.group.id
      : target?.kind === "agent" ? this.layout.assignments[target.agent.state.panelId] : undefined;
    if (groupId && !this.layout.groups.some(group => group.id === groupId)) return;
    if (target?.kind === "agent" && !this.agents.some(agent => agent.state.panelId === target.agent.state.panelId)) return;
    const ids = new Set<string>(payload.ids.filter((id: unknown): id is string => typeof id === "string"));
    let changed = false;
    for (const agent of this.agents) {
      const id = agent.state.panelId;
      if (!ids.has(id) || this.layout.assignments[id] === groupId) continue;
      if (groupId) this.layout.assignments[id] = groupId;
      else delete this.layout.assignments[id];
      changed = true;
    }
    if (changed) await this.save();
  }

  private async name(title: string, value = ""): Promise<string | undefined> {
    const name = await vscode.window.showInputBox({ title, value, ignoreFocusOut: true,
      validateInput: value => !value.trim() ? "이름을 입력하세요." : value.trim().length > 80 ? "80자 이내로 입력하세요." : undefined });
    return name?.trim() || undefined;
  }

  private async save(): Promise<void> {
    await this.context.workspaceState.update(STORAGE, this.layout);
    this.changed.fire(undefined);
  }

  private async rename(node?: Node): Promise<void> {
    if (node?.kind !== "agent") return;
    const title = await this.name("에이전트 이름 변경", node.agent.state.title);
    if (!title) return;
    await this.panels.renameSidebarAgent(node.agent.state, title);
    await this.refresh();
  }

  private async newGroup(): Promise<void> {
    const name = await this.name("새 에이전트 그룹");
    if (!name) return;
    this.layout.groups.push({ id: randomUUID(), name });
    await this.save();
  }

  private async renameGroup(node?: Node): Promise<void> {
    if (node?.kind !== "group") return;
    const group = this.layout.groups.find(group => group.id === node.group.id);
    if (!group) return;
    const name = await this.name("그룹 이름 변경", group.name);
    if (!name) return;
    group.name = name;
    await this.save();
  }

  private async move(node?: Node): Promise<void> {
    if (node?.kind !== "agent") return;
    const selected = await vscode.window.showQuickPick([
      { label: "그룹 없음", id: "" },
      ...this.layout.groups.map(group => ({ label: group.name, id: group.id }))
    ], { title: "에이전트 그룹 선택", placeHolder: node.agent.state.title });
    if (!selected) return;
    if (selected.id) this.layout.assignments[node.agent.state.panelId] = selected.id;
    else delete this.layout.assignments[node.agent.state.panelId];
    await this.save();
  }

  private async deleteGroup(node?: Node): Promise<void> {
    if (node?.kind !== "group") return;
    this.layout.groups = this.layout.groups.filter(group => group.id !== node.group.id);
    for (const [agent, group] of Object.entries(this.layout.assignments)) {
      if (group === node.group.id) delete this.layout.assignments[agent];
    }
    await this.save();
  }

  public dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}
