import { localize } from "../../common/localization";
import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import type { ChatPanelManager, SidebarAgent } from "./chat-panel-manager";

type ArchivedAgent = Pick<SidebarAgent["state"], "panelId" | "agentId" | "title">;
interface Group { id: string; name: string }
interface Layout { groups: Group[]; assignments: Record<string, string>; order: string[] }
type Node = { kind: "group"; group: Group } | { kind: "agent"; agent: SidebarAgent };
const VIEW = "agentFactory.agents";
const STORAGE = "agentFactory.sidebar.groups";
const ARCHIVE_STORAGE = "agentFactory.sidebar.archived";
const DRAG_MIME = "application/vnd.code.tree.agentfactory.agents";

export class AgentSidebar implements vscode.TreeDataProvider<Node>, vscode.TreeDragAndDropController<Node>, vscode.Disposable {
  public readonly dragMimeTypes = [DRAG_MIME];
  public readonly dropMimeTypes = [DRAG_MIME];
  private readonly dragSource = randomUUID();
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  public readonly onDidChangeTreeData = this.changed.event;
  private readonly subscriptions: vscode.Disposable[] = [this.changed];
  private agents: SidebarAgent[] = [];
  private archived: ArchivedAgent[];
  private archiveWrite: Promise<void> = Promise.resolve();
  private layout: Layout;
  private layoutWrite: Promise<void> = Promise.resolve();
  private layoutVersion = 0;
  private persistedLayoutVersion = 0;
  private revision = 0;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly view: vscode.TreeView<Node>;

  public constructor(private readonly context: vscode.ExtensionContext, private readonly panels: ChatPanelManager) {
    const archived = context.workspaceState.get<ArchivedAgent[]>(ARCHIVE_STORAGE);
    this.archived = Array.isArray(archived) ? archived.filter(entry =>
      typeof entry?.panelId === "string" && typeof entry.title === "string" &&
      (entry.agentId === undefined || typeof entry.agentId === "string")) : [];
    const saved = context.workspaceState.get<Partial<Layout>>(STORAGE);
    const assignments = saved?.assignments && typeof saved.assignments === "object"
      ? Object.fromEntries(Object.entries(saved.assignments).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {};
    const order = Array.isArray(saved?.order) ? saved.order.filter((id, index, values): id is string =>
      typeof id === "string" && values.indexOf(id) === index) : [];
    this.layout = {
      groups: Array.isArray(saved?.groups) ? saved.groups.filter(group => typeof group?.id === "string" && typeof group.name === "string") : [],
      assignments,
      order
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
    command("archive", node => this.archive(node));
    command("restore", () => this.restoreArchived());
    void this.refresh();
  }

  private isArchived(state: ArchivedAgent): boolean {
    return this.archived.some(entry => entry.panelId === state.panelId ||
      Boolean(entry.agentId && entry.agentId === state.agentId));
  }

  private updateMessage(): void {
    this.view.message = this.agents.some(agent => !this.isArchived(agent.state)) ? undefined
      : this.archived.length ? localize("ui.sidebar.archived.empty")
      : localize("ui.use.the.button.to.start.a.new.agent.chat");
  }

  private updateArchive(change: (entries: ArchivedAgent[]) => ArchivedAgent[]): Promise<void> {
    const write = this.archiveWrite.then(async () => {
      const next = change(this.archived);
      await this.context.workspaceState.update(ARCHIVE_STORAGE, next);
      this.archived = next;
      this.updateMessage();
      this.changed.fire(undefined);
    });
    this.archiveWrite = write.catch(() => undefined);
    return write;
  }

  private async archive(node?: Node): Promise<void> {
    if (node?.kind !== "agent") return;
    const current = this.agents.find(agent => agent.state.panelId === node.agent.state.panelId);
    if (!current) return;
    const { panelId, agentId, title } = current.state;
    // This only changes sidebar visibility; open tabs and running work remain intact.
    await this.updateArchive(entries => this.isArchived(current.state) ? entries
      : [...entries, { panelId, agentId, title }]);
  }

  private async restoreArchived(): Promise<void> {
    await this.archiveWrite;
    const selected = await vscode.window.showQuickPick(this.archived.map(entry => ({
      label: entry.title, description: entry.agentId, entry
    })), { title: localize("ui.sidebar.restore"), placeHolder: localize("ui.sidebar.restore.hint") });
    if (!selected) return;
    await this.updateArchive(entries => entries.filter(entry => entry.panelId !== selected.entry.panelId));
    await this.refresh();
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
      const known = new Set(this.layout.order);
      const additions = agents.map(agent => agent.state.panelId).filter(id => !known.has(id));
      if (additions.length) {
        this.layout.order.push(...additions);
        this.layoutVersion += 1;
      }
      this.updateMessage();
      this.changed.fire(undefined);
      if (this.persistedLayoutVersion < this.layoutVersion) await this.save(false);
    } catch (error) {
      if (this.disposed || revision !== this.revision) return;
      this.view.message = localize("ui.unable.to.load.the.list.refresh.to.try.again.0", error instanceof Error ? error.message : String(error));
    }
  }

  public getChildren(node?: Node): Node[] {
    if (node?.kind === "agent") return [];
    const byId = new Map(this.agents.map(agent => [agent.state.panelId, agent]));
    const agents = this.layout.order.flatMap(id => {
      const agent = byId.get(id);
      return agent ? [agent] : [];
    }).filter(agent => {
      if (this.isArchived(agent.state)) return false;
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
    item.description = running ? localize("ui.running.73989d") : state.agentId ? undefined : localize("ui.new.chat");
    item.tooltip = [state.title, state.agentId, state.model].filter(Boolean).join("\n");
    item.iconPath = new vscode.ThemeIcon(running ? "loading~spin" : "comment-discussion");
    item.command = { command: "agentFactory.sidebar.open", title: localize("ui.open.agent"), arguments: [node] };
    return item;
  }

  public handleDrag(nodes: readonly Node[], transfer: vscode.DataTransfer, token: vscode.CancellationToken): void {
    if (token.isCancellationRequested || this.disposed) return;
    const groupIds = nodes.filter(node => node.kind === "group").map(node => node.group.id);
    const ids = nodes.filter(node => node.kind === "agent").map(node => node.agent.state.panelId);
    if (groupIds.length && ids.length) return;
    if (groupIds.length || ids.length) transfer.set(DRAG_MIME, new vscode.DataTransferItem({ source: this.dragSource, ids, groupIds }));
  }

  public async handleDrop(target: Node | undefined, transfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
    if (token.isCancellationRequested || this.disposed) return;
    const payload = transfer.get(DRAG_MIME)?.value;
    if (!payload || payload.source !== this.dragSource || !Array.isArray(payload.ids)) return;
    if (Array.isArray(payload.groupIds) && payload.groupIds.length) {
      if (payload.ids.length || payload.groupIds.some((id: unknown) => typeof id !== "string")) return;
      const requested = new Set<string>(payload.groupIds);
      if (requested.size !== payload.groupIds.length ||
          [...requested].some(id => !this.layout.groups.some(group => group.id === id))) return;
      const destination = target?.kind === "group" ? target.group.id
        : target?.kind === "agent" ? this.groupFor(target.agent.state.panelId) : undefined;
      if (target?.kind === "agent" && !this.visibleAgentIds().includes(target.agent.state.panelId)) return;
      if (this.moveGroups(requested, destination)) await this.save();
      return;
    }
    const groupId = target?.kind === "group" ? target.group.id
      : target?.kind === "agent" ? this.groupFor(target.agent.state.panelId) : undefined;
    if (groupId && !this.layout.groups.some(group => group.id === groupId)) return;
    const visibleIds = this.visibleAgentIds();
    const visible = new Set(visibleIds);
    const requested = [...new Set<unknown>(payload.ids)];
    if (!requested.length || requested.some(id => typeof id !== "string" || !visible.has(id))) return;
    const requestedIds = new Set(requested as string[]);
    const ids = visibleIds.filter(id => requestedIds.has(id));
    const targetId = target?.kind === "agent" ? target.agent.state.panelId : undefined;
    if (targetId && (!visible.has(targetId) || ids.includes(targetId))) return;
    if (this.moveAgents(ids, groupId, targetId)) await this.save();
  }

  private async name(title: string, value = ""): Promise<string | undefined> {
    const name = await vscode.window.showInputBox({ title, value, ignoreFocusOut: true,
      validateInput: value => !value.trim() ? localize("ui.enter.a.name") : value.trim().length > 80 ? localize("ui.enter.no.more.than.80.characters") : undefined });
    return name?.trim() || undefined;
  }

  private groupFor(panelId: string): string | undefined {
    const groupId = this.layout.assignments[panelId];
    return this.layout.groups.some(group => group.id === groupId) ? groupId : undefined;
  }

  private visibleAgentIds(): string[] {
    const visible = new Set(this.agents.filter(agent => !this.isArchived(agent.state)).map(agent => agent.state.panelId));
    const ids: string[] = [];
    for (const group of this.layout.groups) {
      ids.push(...this.layout.order.filter(id => visible.has(id) && this.groupFor(id) === group.id));
    }
    ids.push(...this.layout.order.filter(id => visible.has(id) && this.groupFor(id) === undefined));
    return ids;
  }

  private moveGroups(selected: ReadonlySet<string>, destination?: string): boolean {
    if (destination && (!this.layout.groups.some(group => group.id === destination) || selected.has(destination))) return false;
    const moving = this.layout.groups.filter(group => selected.has(group.id));
    const remaining = this.layout.groups.filter(group => !selected.has(group.id));
    const insertion = destination ? remaining.findIndex(group => group.id === destination) : remaining.length;
    if (insertion < 0) return false;
    const groups = [...remaining.slice(0, insertion), ...moving, ...remaining.slice(insertion)];
    if (groups.every((group, index) => group.id === this.layout.groups[index]?.id)) return false;
    this.layout.groups = groups;
    this.layoutVersion += 1;
    return true;
  }

  private moveAgents(ids: readonly string[], groupId: string | undefined, targetId?: string): boolean {
    if (!ids.length) return false;
    const selected = new Set(ids);
    const remaining = this.layout.order.filter(id => !selected.has(id));
    let insertion = remaining.length;
    if (targetId) {
      insertion = remaining.indexOf(targetId);
      if (insertion < 0) return false;
    } else {
      let lastDestination = -1;
      for (let index = remaining.length - 1; index >= 0; index -= 1) {
        if (this.groupFor(remaining[index]!) === groupId) {
          lastDestination = index;
          break;
        }
      }
      if (lastDestination >= 0) insertion = lastDestination + 1;
    }
    const order = [...remaining.slice(0, insertion), ...ids, ...remaining.slice(insertion)];
    const assignmentChanged = ids.some(id => this.groupFor(id) !== groupId);
    const orderChanged = order.some((id, index) => id !== this.layout.order[index]);
    if (!assignmentChanged && !orderChanged) return false;
    for (const id of ids) {
      if (groupId) this.layout.assignments[id] = groupId;
      else delete this.layout.assignments[id];
    }
    this.layout.order = order;
    this.layoutVersion += 1;
    return true;
  }

  private async save(refresh = true): Promise<void> {
    const version = this.layoutVersion;
    const snapshot: Layout = {
      groups: this.layout.groups.map(group => ({ ...group })),
      assignments: { ...this.layout.assignments },
      order: [...this.layout.order]
    };
    if (refresh) this.changed.fire(undefined);
    const write = this.layoutWrite.then(async () => {
      await this.context.workspaceState.update(STORAGE, snapshot);
      this.persistedLayoutVersion = Math.max(this.persistedLayoutVersion, version);
      this.updateMessage();
    });
    this.layoutWrite = write.catch(() => undefined);
    return write;
  }

  private async rename(node?: Node): Promise<void> {
    if (node?.kind !== "agent") return;
    const title = await this.name(localize("ui.rename.agent"), node.agent.state.title);
    if (!title) return;
    await this.panels.renameSidebarAgent(node.agent.state, title);
    await this.refresh();
  }

  private async newGroup(): Promise<void> {
    const name = await this.name(localize("ui.new.agent.group"));
    if (!name) return;
    this.layout.groups.push({ id: randomUUID(), name });
    this.layoutVersion += 1;
    await this.save();
  }

  private async renameGroup(node?: Node): Promise<void> {
    if (node?.kind !== "group") return;
    const group = this.layout.groups.find(group => group.id === node.group.id);
    if (!group) return;
    const name = await this.name(localize("ui.rename.group"), group.name);
    if (!name) return;
    group.name = name;
    this.layoutVersion += 1;
    await this.save();
  }

  private async move(node?: Node): Promise<void> {
    if (node?.kind !== "agent") return;
    if (!this.visibleAgentIds().includes(node.agent.state.panelId)) return;
    const selected = await vscode.window.showQuickPick([
      { label: localize("ui.no.group"), id: "" },
      ...this.layout.groups.map(group => ({ label: group.name, id: group.id }))
    ], { title: localize("ui.select.agent.group"), placeHolder: node.agent.state.title });
    if (!selected) return;
    if (this.moveAgents([node.agent.state.panelId], selected.id || undefined)) await this.save();
  }

  private async deleteGroup(node?: Node): Promise<void> {
    if (node?.kind !== "group") return;
    if (!this.layout.groups.some(group => group.id === node.group.id)) return;
    const moved = this.layout.order.filter(id => this.layout.assignments[id] === node.group.id);
    this.moveAgents(moved, undefined);
    this.layout.groups = this.layout.groups.filter(group => group.id !== node.group.id);
    for (const [agent, group] of Object.entries(this.layout.assignments)) {
      if (group === node.group.id) delete this.layout.assignments[agent];
    }
    this.layoutVersion += 1;
    await this.save();
  }

  public dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}
