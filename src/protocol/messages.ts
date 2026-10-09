import type { AgentPermissions } from "../common/types/agent-permissions";
import type { AgentModels } from "../common/types/agent-models";
import type { StatusItemId } from "../core/config/types";
import type { AttachmentReference } from "../common/types/attachment";
import type { InterviewQuestion } from "../common/types/business-mode";

/** Composer settings the webview sends as `composer.settings` and the host restores in `host.initialize`. */
interface ComposerSettingsFields {
  readonly model?: string;
  readonly agentModels?: AgentModels;
  readonly modelFastModes?: import("../common/types/agent-models").ModelFastModes;
  readonly agentFastModes?: import("../common/types/agent-models").AgentFastModes;
  readonly agentPermissions?: AgentPermissions;
  readonly reasoning?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  readonly maestroMode?: boolean;
  readonly fastMode: boolean;
  readonly goalMode: boolean;
  readonly workLoopMode?: boolean;
  readonly businessMode?: import("../common/types/business-mode").BusinessMode;
  readonly taskMode?: import("../modules/chat/task-selection").TaskSelection;
  readonly agentSettingsScope?: import("../core/config/agent-settings").AgentPresetScope;
  readonly agentSettingsSet?: string;
}

/** One task brief (short-term contract) of this project, read from its loop state in any conversation. */
export interface ProjectTaskEntry {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly mainAgentId?: string;
  /** The long-term contract this brief executes, when it was bound to one. */
  readonly contract?: { readonly id: string; readonly version?: number };
  readonly loopId?: string;
  readonly workAgentId?: string;
  readonly phase?: string;
  readonly tasks: readonly ProjectTaskDetail[];
}

export interface ProjectTaskDetail {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly completionCriteria?: string;
  readonly workStatus?: string;
  readonly verificationStatus?: string;
  readonly allocation?: Readonly<Record<string, unknown>>;
  readonly runs?: readonly ProjectTaskRun[];
}
export interface ProjectTaskRun {
  readonly agentId: string;
  readonly runId: string;
  readonly role: "work" | "verification";
  readonly status: string;
  readonly model?: string;
  readonly workProfile?: string;
  readonly parentRunId?: string;
  readonly acceptedAt?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly updatedAt?: string;
  readonly attempt?: number;
  readonly receipt?: { readonly outcome: string; readonly checksRun?: boolean; readonly checks?: string };
  readonly usage?: Readonly<Record<string, number | null>>;
  readonly context?: Readonly<Record<string, string | number | boolean | null>>;
  readonly handoff?: { readonly slot?: string; readonly epoch?: number };
  readonly errorCode?: string;
}

/** Captured submission intent and app-added guidance, never the full provider prompt. */
/** What one timeline action did and touched; every field is optional and omitted when unobserved. */
export type ActivityKind = "read" | "search" | "list" | "run" | "test" | "git" | "edit" | "web" | "page" | "tool" | "think" | "skill";
export interface ActivityDetails {
  readonly kind?: ActivityKind;
  /** Path, pattern, query, URL or tool identity the action acted on. */
  readonly target?: string;
  /** Where a search/list ran, or a tool's key argument. */
  readonly scope?: string;
  readonly lineStart?: number;
  readonly lineEnd?: number;
  readonly durationMs?: number;
  /** Only nonzero exit codes are reported. */
  readonly exitCode?: number;
  readonly error?: string;
  /** Reasoning summary shown when a thinking row is opened. */
  readonly summary?: string;
}

export interface MessageSubmission {
  readonly backgroundContinuation?: boolean;
  readonly runId?: string;
  readonly acceptedAt?: string;
  readonly taskMode: import("../modules/chat/task-selection").TaskSelection;
  readonly businessMode: import("../common/types/business-mode").BusinessMode;
  readonly goal: boolean;
  readonly guidance?: string;
}

export type ClientMessage =
  | { readonly type: "control.center.open"; readonly workflowId?: string; readonly taskId?: string }
  | { readonly type: "agent.preset.field"; readonly scope: import("../core/config/agent-settings").AgentPresetScope; readonly name: string; readonly role: import("../core/config/agent-settings").AgentRole; readonly field: "model" | "reasoningEffort" | "fast"; readonly value: string | boolean }
  | { readonly type: "agent.preset.fast"; readonly scope: import("../core/config/agent-settings").AgentPresetScope; readonly name: string; readonly role: import("../core/config/agent-settings").AgentRole; readonly model: string; readonly value: boolean }
  | { readonly type: "bot.interact"; readonly action: import("../modules/chat/companion").CompanionAction }
  | { readonly type: "contract.open"; readonly id: string }
  | { readonly type: "contracts.request" }
  | { readonly type: "project.tasks.request" }
  | { readonly type: "project.task.open"; readonly workflowId: string; readonly taskId: string; readonly target: "chat" | "run" | "records" | "feedback" }
  | { readonly type: "agent.preset"; readonly action: "save" | "apply" | "copy" | "update" | "delete" | "rename" | "default"; readonly scope: "global" | "project" | "chat"; readonly name: string; readonly newName?: string; readonly sourceName?: string }
  | { readonly type: "agent.defaults.save"; readonly scope: "global" | "project"; readonly role: import("../core/config/agent-settings").AgentRole; readonly field: "model" | "reasoningEffort" | "fast"; readonly value: string | boolean }
  | { readonly type: "agent.defaults.fast"; readonly scope: "global" | "project"; readonly role: import("../core/config/agent-settings").AgentRole; readonly model: string; readonly value: boolean }
  | { readonly type: "worktree.create"; readonly repository: string; readonly name: string; readonly base: string }
  | { readonly type: "worktree.merge" | "worktree.refresh" | "worktree.repositories" }
  | { readonly type: "deploy.detect" }
  | { readonly type: "deploy.token"; readonly secret: string }
  | { readonly type: "deploy.run"; readonly workflowId: number; readonly inputs: Readonly<Record<string, string | boolean>> }
  | { readonly type: "notes.folder"; readonly scope: import("../infrastructure/vscode/note-store").NoteScope; readonly folder: string }
  | { readonly type: "notes.list"; readonly scope: import("../infrastructure/vscode/note-store").NoteScope }
  | { readonly type: "notes.save"; readonly scope: import("../infrastructure/vscode/note-store").NoteScope; readonly note: Omit<import("../infrastructure/vscode/note-store").Note, "updatedAt"> }
  | { readonly type: "bots.configure"; readonly enabled: boolean }
  | { readonly type: "bot.talk"; readonly requestId: string; readonly text: string }
  | { readonly type: "bot.character.save"; readonly character: "lumi" | "factory" }
  | { readonly type: "bot.model.save"; readonly model: string }
  | { readonly type: "bot.prompt.save"; readonly requestId: string; readonly prompt: string; readonly character?: "lumi" | "factory" }
  | { readonly type: "client.ready"; readonly pendingMessageIds?: readonly string[] }
  | { readonly type: "chat.status"; readonly ids: readonly string[] }
  | { readonly type: "execution.select"; readonly mode: import("../common/types/agent-runtime").ExecutionMode }
  | { readonly type: "message.copy"; readonly text: string }
  | { readonly type: "reference.copy"; readonly id: string }
  | { readonly type: "image.resolve"; readonly href: string }
  | { readonly type: "link.open"; readonly href: string }
  | {
      readonly type: "chat.send";
      readonly id: string;
      readonly text: string;
      readonly attachments: readonly AttachmentReference[];
      readonly execution: {
        readonly businessMode?: import("../common/types/business-mode").BusinessMode;
      readonly taskMode?: import("../modules/chat/task-selection").TaskSelection;
        readonly model?: string;
        readonly agentModels?: AgentModels;
  readonly agentPermissions?: AgentPermissions;
        /** The project's Work isolation toggle when the message was sent. */
        readonly workIsolation?: boolean;
        readonly reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
        readonly fast: boolean;
        readonly goal: boolean;
        readonly goalObjective?: string;
      };
    }
  | { readonly type: "sudo.reply"; readonly id: string; readonly key?: string; readonly iv?: string; readonly data?: string; readonly cancelled?: boolean }
  | { readonly type: "decision.approve"; readonly runId: string; readonly language?: "ko" | "en" }
  | { readonly type: "goal.control"; readonly action: import("../common/types/agent-runtime").GoalAction }
  | { readonly type: "workIsolation.set"; readonly value: boolean }
  | { readonly type: "general.set"; readonly key: keyof import("../common/types/general-settings").GeneralSettings; readonly value: boolean | "restore" | "new" }
  | { readonly type: "docsAudit.set"; readonly interval: import("../common/types/docs-audit").DocsAuditInterval }
  | { readonly type: "docsAudit.started" }
  | { readonly type: "queue.resume" }
  | { readonly type: "run.cancel" }
  | { readonly type: "conversation.clear" }
  | { readonly type: "sessions.request" }
  | { readonly type: "models.request" }
  | { readonly type: "usage.refresh" }
  | { readonly type: "providers.request" | "providers.detect" | "providers.versions.request" }
  | { readonly type: "providers.update"; readonly version?: string }
  | { readonly type: "providers.cli.install"; readonly provider: "codex" | "claude"; readonly version: string }
  | { readonly type: "providers.configure"; readonly provider: import("../common/types/provider").ProviderId; readonly path: string }
  | { readonly type: "providers.pick"; readonly provider: import("../common/types/provider").ProviderId }
  | { readonly type: "providers.updateMode.select"; readonly mode: import("../common/types/provider").PluginUpdateMode }
  | { readonly type: "session.select"; readonly agentId: string }
  | ({ readonly type: "task.stop" } & import("../common/types/agent-runtime").TaskStopTarget)
  | { readonly type: "task.delete"; readonly workflowId: string; readonly taskId: string; readonly mainAgentId?: string }
  | { readonly type: "workflow.close"; readonly workAgentId: string; readonly loopId: string }
  | { readonly type: "workflow.decision"; readonly workAgentId: string; readonly loopId: string; readonly decision: "continue" | "stop" }
  | { readonly type: "workflow.answer"; readonly workAgentId: string; readonly loopId: string; readonly decisionId: string; readonly questionHash: string; readonly answer: string }
  | { readonly type: "conversations.request" }
  | { readonly type: "conversation.read"; readonly conversationId: string | null; readonly before?: string; readonly requestId: string }
  | { readonly type: "history.request"; readonly before: string }
  | { readonly type: "agents.request" }
  | { readonly type: "agent.open"; readonly agentId: string; readonly runId?: string }
  | { readonly type: "attachments.pick" }
  | { readonly type: "attachments.addUris"; readonly uris: readonly string[] }
  | { readonly type: "attachments.createText"; readonly text: string }
  | { readonly type: "attachments.createImage"; readonly id: string; readonly name: string; readonly mediaType: string; readonly size: number; readonly data: string }
  | { readonly type: "attachments.createFile"; readonly id: string; readonly name: string; readonly size: number; readonly data: string }
  | { readonly type: "attachments.restore"; readonly attachments: readonly { readonly id: string; readonly name: string; readonly target: "composer" | "history" }[] }
  | { readonly type: "attachment.convert"; readonly id: string; readonly name: string; readonly requestId: string; readonly mediaType: string }
  | { readonly type: "attachment.converted"; readonly id: string; readonly name: string; readonly mediaType: string; readonly size: number; readonly data: string }
  | { readonly type: "attachment.revealConverted"; readonly id: string }
  | { readonly type: "attachment.conversionFailed"; readonly id: string }
  | { readonly type: "attachment.open"; readonly id: string }
  | { readonly type: "attachment.remove"; readonly id: string }
  | ({ readonly type: "composer.settings" } & ComposerSettingsFields)
  | {
      readonly type: "status.reorder";
      readonly items: readonly StatusItemId[];
    };

/** Latest account-wide limit windows reported by a provider; resets are Unix seconds, reportedAt is epoch ms. */
export interface AccountUsage {
  readonly fiveHourUsedPercent?: number;
  readonly fiveHourResetsAt?: number;
  readonly weeklyUsedPercent?: number;
  readonly weeklyResetsAt?: number;
  readonly reportedAt: number;
}

export type HostMessage =
  | { readonly type: "composer.reference"; readonly text: string }
  | { readonly type: "interview.question"; readonly question: InterviewQuestion; readonly runId?: string }
  | { readonly type: "usage.accounts"; readonly accounts: Readonly<Record<string, AccountUsage>> }
  | { readonly type: "agent.preset.field.result"; readonly error?: string }
  | { readonly type: "contracts.list"; readonly contracts: readonly import("../infrastructure/filesystem/contracts").ContractEntry[]; readonly error?: string }
  | { readonly type: "project.tasks"; readonly entries: readonly ProjectTaskEntry[]; readonly error?: string }
  | { readonly type: "agent.preset.result"; readonly scope?: import("../core/config/agent-settings").AgentPresetScope; readonly name?: string; readonly settings?: import("../core/config/agent-settings").AgentDefaults; readonly error?: string }
  | { readonly type: "agent.defaults"; readonly settings: import("../core/config/agent-settings").AgentDefaultsSnapshot }
  | import("../infrastructure/vscode/sudo-broker").SudoChallenge
  | { readonly type: "sudo.closed" }
  | { readonly type: "attachment.conversionResult"; readonly id: string; readonly path?: string; readonly error?: string }
  | { readonly type: "attachment.encode"; readonly id: string; readonly source: string; readonly mediaType: string; readonly name: string }
  | { readonly type: "worktree.created"; readonly error?: string; readonly created?: boolean }
  | { readonly type: "worktree.repositories"; readonly repositories: readonly import("../common/types/agent-runtime").WorktreeRepository[] }
  | { readonly type: "deploy.targets"; readonly target?: import("../infrastructure/github/deploy-workflows").DeployTarget; readonly error?: string }
  | { readonly type: "deploy.status"; readonly run?: import("../infrastructure/github/deploy-workflows").DeployRun; readonly repository?: string; readonly error?: string }
  | { readonly type: "composer.prefill"; readonly text: string }
  | { readonly type: "worktree.updated"; readonly value?: import("../common/types/agent-runtime").ConversationWorktree; readonly busy?: boolean; readonly supported?: boolean }
  | { readonly type: "notes.list.result"; readonly folders?: readonly string[]; readonly scope: import("../infrastructure/vscode/note-store").NoteScope; readonly notes: readonly import("../infrastructure/vscode/note-store").Note[]; readonly error?: string }
  | { readonly type: "notes.save.result"; readonly scope: import("../infrastructure/vscode/note-store").NoteScope; readonly id: string; readonly note?: import("../infrastructure/vscode/note-store").Note; readonly error?: string }
  | { readonly type: "bot.companion"; readonly companion: import("../modules/chat/companion").CompanionState; readonly working: number; readonly outcome?: "completed" | "failed"; readonly outcomeUntil: number }
  | { readonly type: "bots.updated"; readonly enabled: boolean; readonly botCharacter?: "lumi" | "factory"; readonly localCompanionAvailable?: boolean; readonly botDefaultPrompt?: string; readonly botModel?: string; readonly botPrompt?: string }
  | { readonly type: "bot.model.saved"; readonly model: string; readonly failed?: boolean }
  | { readonly type: "bot.prompt.saved"; readonly requestId: string; readonly prompt?: string; readonly failed?: boolean }
  | { readonly type: "chat.rejected"; readonly id: string }
  | { readonly type: "chat.pending"; readonly id: string }
  | { readonly type: "chat.started"; readonly submission?: MessageSubmission; readonly id: string; readonly text: string; readonly attachments: readonly AttachmentReference[] }
  | { readonly type: "agent.run.selected"; readonly capturedRun?: import("../modules/chat/chat-state").CapturedAgentRun }
  | { readonly type: "execution.updated"; readonly mode?: import("../common/types/agent-runtime").ExecutionMode | "read-only" }
  | { readonly type: "syntax.theme"; readonly selection: import("../infrastructure/agent-factory/cli-theme").CliTheme }
  | { readonly type: "branch.updated"; readonly branch?: string }
  | { readonly type: "goal.updated"; readonly goal: import("../common/types/agent-runtime").NativeGoal | null; readonly error?: string }
  | { readonly type: "workIsolation.updated"; readonly value: boolean }
  | { readonly type: "general.updated"; readonly settings: import("../common/types/general-settings").GeneralSettings; readonly error?: string }
  | { readonly type: "notification.sound" }
  | { readonly type: "docsAudit.updated"; readonly interval: string }
  | { readonly type: "docsAudit.due" }
  | { readonly type: "capabilities.updated"; readonly capabilities: { readonly submit: import("../common/types/agent-runtime").ExecutionCapabilities; readonly send: import("../common/types/agent-runtime").ExecutionCapabilities } }
  | { readonly type: "models.list"; readonly models: readonly string[] }
  | {
      readonly type: "providers.status";
      readonly providers: readonly import("../infrastructure/agent-factory/provider-detection").ProviderStatus[];
      readonly busy?: boolean;
      readonly errors?: Partial<Readonly<Record<import("../common/types/provider").ProviderId, string>>>;
      readonly pluginUpdateMode?: import("../common/types/provider").PluginUpdateMode;
      readonly versions?: Partial<Readonly<Record<import("../common/types/provider").ProviderId, import("../infrastructure/vscode/provider-settings").ProviderVersions>>>;
    }
  | { readonly type: "providers.catalog"; readonly catalog: import("../infrastructure/agent-factory/provider-version-catalog").ProviderVersionCatalog }
  | { readonly type: "runtime.updated"; readonly runtimeAvailable: boolean; readonly capabilities?: { readonly submit: import("../common/types/agent-runtime").ExecutionCapabilities; readonly send: import("../common/types/agent-runtime").ExecutionCapabilities } }
  | ({
      readonly type: "host.initialize";
      readonly agentSettingsVersion?: 1;
      readonly agentId?: string;
      readonly capturedRun?: import("../modules/chat/chat-state").CapturedAgentRun;
      readonly panelId: string;
      readonly title: string;
      readonly role: "main" | "work" | "verification";
      readonly verifiedWorkRunId?: string;
      readonly projectName: string;
      readonly runtimeAvailable: boolean;
      readonly capabilities?: { readonly submit: import("../common/types/agent-runtime").ExecutionCapabilities; readonly send: import("../common/types/agent-runtime").ExecutionCapabilities };
      /** Per-project Work isolation toggle; off unless the Human turned it on. */
      readonly workIsolation?: boolean;
      readonly generalSettings?: import("../common/types/general-settings").GeneralSettings;
      /** Per-project periodic documents check interval; off unless the Human turned it on. */
      readonly docsAuditInterval?: import("../common/types/docs-audit").DocsAuditInterval;
      readonly running: boolean;
      readonly botsEnabled?: boolean;
      readonly botsAvailable?: boolean;
      readonly companionAvailable?: boolean;
      readonly botCharacter?: "lumi" | "factory"; readonly localCompanionAvailable?: boolean; readonly botDefaultPrompt?: string; readonly botModel?: string; readonly botPrompt?: string;
      readonly statusItems: readonly StatusItemId[];
      readonly contextUsedTokens?: number;
      readonly contextWindowTokens?: number;
      readonly fiveHourUsedPercent?: number;
      readonly weeklyUsedPercent?: number;
      readonly fiveHourResetsAt?: number;
      readonly weeklyResetsAt?: number;
      readonly queueCount: number;
      readonly conversationId?: string;
      readonly resetConversation?: boolean;
      readonly pendingMessageIds?: readonly string[];
    } & ComposerSettingsFields)
  | {
      readonly type: "attachments.add";
      readonly attachments: readonly AttachmentReference[];
    }
  | {
      readonly type: "attachments.restored";
      readonly attachments: readonly (AttachmentReference & { readonly target: "composer" | "history" })[];
    }
  | { readonly type: "attachment.rejected"; readonly id: string }
  | {
      readonly type: "task.stop.result";
      readonly workflowId: string;
      readonly taskId: string;
      readonly error?: string;
    }
  | { readonly type: "task.delete.result"; readonly mainAgentId: string; readonly workflowId: string; readonly taskId: string; readonly error?: string }
  | {
      readonly type: "host.notice";
      readonly level: "info" | "warning" | "error" | "cancelled";
      readonly text: string;
    }
  | {
      readonly type: "status.updated";
      readonly items: readonly StatusItemId[];
    }
  | {
      readonly type: "chat.renamed";
      readonly title: string;
    }
  | { readonly type: "session.bound"; readonly agentId: string; readonly reset?: boolean; readonly conversationId?: string }
  | { readonly type: "conversation.clearing"; readonly busy: boolean }
  | { readonly type: "conversation.cleared"; readonly conversationId: string }
  | { readonly type: "conversations.list"; readonly conversations: readonly import("../common/types/agent-runtime").SavedConversation[]; readonly error?: string }
  | { readonly type: "conversation.read.result"; readonly requestId: string; readonly history?: import("../infrastructure/agent-factory/agent-client").ConversationHistory; readonly error?: string }
  | { readonly type: "conversation.history"; readonly agentId: string; readonly history: import("../infrastructure/agent-factory/agent-client").ConversationHistory }
  | { readonly type: "sessions.open" }
  | {
      readonly type: "sessions.list";
      readonly sessions: readonly {
        readonly agentId: string;
        readonly updatedAt?: string;
        readonly model?: string;
      }[];
    }
  | {
      readonly type: "agents.list";
      readonly workflows?: readonly Record<string, unknown>[];
      readonly workflowsComplete?: boolean;
      readonly agents: readonly {
        readonly agentId: string;
        readonly role: "work" | "verification";
        readonly status: string;
        readonly model?: string;
        readonly reasoningEffort?: string;
        readonly workProfile?: import("../common/types/agent-models").WorkProfile;
        readonly updatedAt?: string;
        readonly dispatchedAt?: string;
        readonly startedAt?: string;
        readonly finishedAt?: string;
        readonly planProgress?: { readonly completed: number; readonly total: number };
        readonly activity?: string;
        readonly progressKey?: string;
      }[];
    }
  | { readonly type: "decision.pending"; readonly runId: string | null; readonly canApprove?: boolean; readonly approval?: import("../modules/chat/decision-approval").DecisionApproval }
  | { readonly type: "chat.human-decision"; readonly submission?: MessageSubmission; readonly text: string }
  | { readonly type: "chat.assistant"; readonly localization?: { readonly text?: import("../common/localization").LocalizedMessage }; readonly text: string; readonly phase?: "commentary" | "final"; readonly runId?: string }
  | { readonly type: "chat.delta"; readonly runId: string; readonly stream: "commentary" | "final"; readonly id: string; readonly text: string }
  | { readonly type: "image.resolved"; readonly href: string; readonly src?: string }
  | { readonly type: "run.progress"; readonly text: string }
  | {
      readonly type: "context.usage";
      readonly usedTokens: number;
      readonly contextWindowTokens: number;
      readonly fiveHourUsedPercent?: number;
      readonly weeklyUsedPercent?: number;
      readonly fiveHourResetsAt?: number;
      readonly weeklyResetsAt?: number;
    }
  | ({
      readonly type: "run.activity";
      readonly id: string;
      readonly category: "command" | "file" | "tool";
      readonly phase: "started" | "completed" | "failed";
      readonly text: string;
      readonly title?: string;
      readonly diff?: string;
      readonly output?: string;
    } & ActivityDetails)
  | {
      readonly type: "run.state";
      readonly running: boolean;
    }
  | { readonly type: "bot.mood"; readonly unavailable?: boolean; readonly mood?: "calm" | "curious" | "cheerful" | "focused" }
  | { readonly type: "bot.reply.partial"; readonly requestId: string; readonly text: string }
  | { readonly type: "bot.reply"; readonly emotion?: "calm" | "happy" | "shy" | "love" | "surprised" | "playful" | "sleepy"; readonly requestId: string; readonly text?: string; readonly failed?: boolean }
  | { readonly type: "run.observed"; readonly status: string }
  | { readonly type: "queue.updated"; readonly count: number }
  | {
      readonly type: "workUnits.summary";
      readonly activeUnits: number;
      readonly workActive: number;
      readonly verificationActive: number;
      readonly totalCalled: number;
    };

/** Optional display metadata never alters the underlying runtime or message payload. */
export type LocalizedHostMessage = HostMessage & {
  readonly localization?: {
    readonly text?: import("../common/localization").LocalizedMessage;
    readonly error?: import("../common/localization").LocalizedMessage;
  };
};
