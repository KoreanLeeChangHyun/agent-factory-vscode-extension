import type { StatusItemId } from "../core/config/types";
import type { AttachmentReference } from "../common/types/attachment";

export type ClientMessage =
  | { readonly type: "client.ready" }
  | {
      readonly type: "chat.send";
      readonly id: string;
      readonly text: string;
      readonly attachments: readonly AttachmentReference[];
      readonly execution: {
        readonly model?: string;
        readonly reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
        readonly fast: boolean;
        readonly goal: boolean;
        readonly goalObjective?: string;
      };
    }
  | { readonly type: "goal.control"; readonly action: import("../infrastructure/agent-factory/agent-client").GoalAction }
  | { readonly type: "run.cancel" }
  | { readonly type: "sessions.request" }
  | { readonly type: "models.request" }
  | { readonly type: "session.select"; readonly agentId: string }
  | { readonly type: "agents.request" }
  | { readonly type: "agent.open"; readonly agentId: string }
  | { readonly type: "attachments.pick" }
  | {
      readonly type: "composer.settings";
      readonly model?: string;
      readonly reasoning?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
      readonly fastMode: boolean;
      readonly goalMode: boolean;
    }
  | {
      readonly type: "status.reorder";
      readonly items: readonly StatusItemId[];
    };

export type HostMessage =
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
      readonly statusItems: readonly StatusItemId[];
      readonly model?: string;
      readonly reasoning?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
      readonly fastMode: boolean;
      readonly goalMode: boolean;
      readonly contextUsedTokens?: number;
      readonly contextWindowTokens?: number;
    }
  | {
      readonly type: "attachments.add";
      readonly attachments: readonly AttachmentReference[];
    }
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
  | { readonly type: "session.bound"; readonly agentId: string; readonly reset?: boolean }
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
      readonly agents: readonly {
        readonly agentId: string;
        readonly role: "work" | "verification";
        readonly status: string;
        readonly updatedAt?: string;
      }[];
    }
  | { readonly type: "chat.assistant"; readonly text: string; readonly phase?: "commentary" | "final" }
  | { readonly type: "run.progress"; readonly text: string }
  | {
      readonly type: "context.usage";
      readonly usedTokens: number;
      readonly contextWindowTokens: number;
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
  | {
      readonly type: "workUnits.summary";
      readonly activeUnits: number;
      readonly workActive: number;
      readonly verificationActive: number;
      readonly totalCalled: number;
    };
