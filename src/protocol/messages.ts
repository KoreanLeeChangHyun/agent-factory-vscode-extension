import type { AgentPermissions } from "../common/types/agent-permissions";
import type { AgentModels } from "../common/types/agent-models";
import type { StatusItemId } from "../core/config/types";
import type { AttachmentReference } from "../common/types/attachment";

/** Captured submission intent and app-added guidance, never the full provider prompt. */
export interface MessageSubmission {
  readonly backgroundContinuation?: boolean;
  readonly taskMode: import("../modules/chat/task-selection").TaskSelection;
  readonly businessMode: import("../common/types/business-mode").BusinessMode;
  readonly goal: boolean;
  readonly guidance?: string;
}

export type ClientMessage =
  | { readonly type: "agent.preset.field"; readonly name: string; readonly role: "main" | "work" | "verification"; readonly field: "model" | "reasoningEffort"; readonly value: string }
  | { readonly type: "bot.interact"; readonly action: import("../modules/chat/companion").CompanionAction }
  | { readonly type: "contract.open"; readonly id: string }
  | { readonly type: "contracts.request" }
  | { readonly type: "agent.preset"; readonly action: "save" | "apply" | "update" | "delete"; readonly scope: "global" | "project" | "chat"; readonly name: string }
  | { readonly type: "agent.defaults.save"; readonly scope: "global" | "project"; readonly role: "main" | "work" | "verification"; readonly field: "model" | "reasoningEffort"; readonly value: string }
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
  | { readonly type: "client.ready" }
  | { readonly type: "execution.select"; readonly mode: import("../infrastructure/agent-factory/agent-client").ExecutionMode }
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
        readonly reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
        readonly fast: boolean;
        readonly goal: boolean;
        readonly goalObjective?: string;
      };
    }
  | { readonly type: "sudo.reply"; readonly id: string; readonly key?: string; readonly iv?: string; readonly data?: string; readonly cancelled?: boolean }
  | { readonly type: "decision.approve"; readonly runId: string }
  | { readonly type: "goal.control"; readonly action: import("../infrastructure/agent-factory/agent-client").GoalAction }
  | { readonly type: "queue.resume" }
  | { readonly type: "run.cancel" }
  | { readonly type: "conversation.clear" }
  | { readonly type: "sessions.request" }
  | { readonly type: "models.request" }
  | { readonly type: "session.select"; readonly agentId: string }
  | { readonly type: "workflow.close"; readonly workAgentId: string; readonly loopId: string }
  | { readonly type: "conversations.request" }
  | { readonly type: "conversation.read"; readonly conversationId: string | null; readonly before?: string; readonly requestId: string }
  | { readonly type: "history.request"; readonly before: string }
  | { readonly type: "agents.request" }
  | { readonly type: "agent.open"; readonly agentId: string }
  | { readonly type: "attachments.pick" }
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
  | {
      readonly type: "composer.settings";
      readonly model?: string;
      readonly agentModels?: AgentModels;
  readonly agentPermissions?: AgentPermissions;
      readonly reasoning?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
      readonly fastMode: boolean;
      readonly goalMode: boolean;
      readonly workLoopMode?: boolean;
      readonly businessMode?: import("../common/types/business-mode").BusinessMode;
      readonly taskMode?: import("../modules/chat/task-selection").TaskSelection;
    }
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
  | { readonly type: "usage.accounts"; readonly accounts: Readonly<Record<string, AccountUsage>> }
  | { readonly type: "agent.preset.field.result"; readonly error?: string }
  | { readonly type: "contracts.list"; readonly contracts: readonly import("../infrastructure/filesystem/contracts").ContractEntry[]; readonly error?: string }
  | { readonly type: "agent.preset.result"; readonly error?: string }
  | { readonly type: "agent.defaults"; readonly settings: import("../core/config/agent-settings").AgentDefaultsSnapshot }
  | import("../infrastructure/vscode/sudo-broker").SudoChallenge
  | { readonly type: "sudo.closed" }
  | { readonly type: "attachment.conversionResult"; readonly id: string; readonly path?: string; readonly error?: string }
  | { readonly type: "attachment.encode"; readonly id: string; readonly source: string; readonly mediaType: string; readonly name: string }
  | { readonly type: "worktree.created"; readonly error?: string; readonly created?: boolean }
  | { readonly type: "worktree.repositories"; readonly repositories: readonly import("../infrastructure/agent-factory/agent-client").WorktreeRepository[] }
  | { readonly type: "deploy.targets"; readonly target?: import("../infrastructure/github/deploy-workflows").DeployTarget; readonly error?: string }
  | { readonly type: "deploy.status"; readonly run?: import("../infrastructure/github/deploy-workflows").DeployRun; readonly repository?: string; readonly error?: string }
  | { readonly type: "composer.prefill"; readonly text: string }
  | { readonly type: "worktree.updated"; readonly value?: import("../infrastructure/agent-factory/agent-client").ConversationWorktree; readonly busy?: boolean; readonly supported?: boolean }
  | { readonly type: "notes.list.result"; readonly folders?: readonly string[]; readonly scope: import("../infrastructure/vscode/note-store").NoteScope; readonly notes: readonly import("../infrastructure/vscode/note-store").Note[]; readonly error?: string }
  | { readonly type: "notes.save.result"; readonly scope: import("../infrastructure/vscode/note-store").NoteScope; readonly id: string; readonly note?: import("../infrastructure/vscode/note-store").Note; readonly error?: string }
  | { readonly type: "bot.companion"; readonly companion: import("../modules/chat/companion").CompanionState; readonly working: number; readonly outcome?: "completed" | "failed"; readonly outcomeUntil: number }
  | { readonly type: "bots.updated"; readonly enabled: boolean; readonly botCharacter?: "lumi" | "factory"; readonly localCompanionAvailable?: boolean; readonly botDefaultPrompt?: string; readonly botModel?: string; readonly botPrompt?: string }
  | { readonly type: "bot.model.saved"; readonly model: string; readonly failed?: boolean }
  | { readonly type: "bot.prompt.saved"; readonly requestId: string; readonly prompt?: string; readonly failed?: boolean }
  | { readonly type: "chat.rejected"; readonly id: string }
  | { readonly type: "chat.started"; readonly submission?: MessageSubmission; readonly id: string; readonly text: string; readonly attachments: readonly AttachmentReference[] }
  | { readonly type: "execution.updated"; readonly mode?: import("../infrastructure/agent-factory/agent-client").ExecutionMode | "read-only" }
  | { readonly type: "syntax.theme"; readonly selection: import("../infrastructure/agent-factory/cli-theme").CliTheme }
  | { readonly type: "branch.updated"; readonly branch?: string }
  | { readonly type: "goal.updated"; readonly goal: import("../infrastructure/agent-factory/agent-client").NativeGoal | null; readonly error?: string }
  | { readonly type: "capabilities.updated"; readonly capabilities: { readonly submit: import("../infrastructure/agent-factory/agent-client").ExecutionCapabilities; readonly send: import("../infrastructure/agent-factory/agent-client").ExecutionCapabilities } }
  | { readonly type: "models.list"; readonly models: readonly string[] }
  | {
      readonly type: "host.initialize";
      readonly panelId: string;
      readonly title: string;
      readonly role: "main" | "work" | "verification";
      readonly verifiedWorkRunId?: string;
      readonly projectName: string;
      readonly runtimeAvailable: boolean;
      readonly capabilities?: { readonly submit: import("../infrastructure/agent-factory/agent-client").ExecutionCapabilities; readonly send: import("../infrastructure/agent-factory/agent-client").ExecutionCapabilities };
      readonly running: boolean;
      readonly botsEnabled?: boolean;
      readonly botsAvailable?: boolean;
      readonly companionAvailable?: boolean;
      readonly botCharacter?: "lumi" | "factory"; readonly localCompanionAvailable?: boolean; readonly botDefaultPrompt?: string; readonly botModel?: string; readonly botPrompt?: string;
      readonly statusItems: readonly StatusItemId[];
      readonly model?: string;
      readonly agentModels?: AgentModels;
  readonly agentPermissions?: AgentPermissions;
      readonly reasoning?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
      readonly fastMode: boolean;
      readonly goalMode: boolean;
      readonly workLoopMode?: boolean;
      readonly businessMode?: import("../common/types/business-mode").BusinessMode;
      readonly taskMode?: import("../modules/chat/task-selection").TaskSelection;
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
    }
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
      readonly type: "host.notice";
      readonly level: "info" | "warning" | "error";
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
  | { readonly type: "conversations.list"; readonly conversations: readonly import("../infrastructure/agent-factory/agent-client").SavedConversation[]; readonly error?: string }
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
      readonly agents: readonly {
        readonly agentId: string;
        readonly role: "work" | "verification";
        readonly status: string;
        readonly updatedAt?: string;
      }[];
    }
  | { readonly type: "decision.pending"; readonly runId: string | null; readonly canApprove?: boolean }
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
  | {
      readonly type: "run.activity";
      readonly id: string;
      readonly category: "command" | "file" | "tool";
      readonly phase: "started" | "completed" | "failed";
      readonly text: string;
      readonly title?: string;
      readonly diff?: string;
      readonly output?: string;
    }
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
