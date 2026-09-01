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
      };
    }
  | { readonly type: "run.cancel" }
  | { readonly type: "resume.request" }
  | { readonly type: "attachments.pick" }
  | {
      readonly type: "status.reorder";
      readonly items: readonly StatusItemId[];
    };

export type HostMessage =
  | {
      readonly type: "host.initialize";
      readonly panelId: string;
      readonly title: string;
      readonly projectName: string;
      readonly runtimeAvailable: boolean;
      readonly running: boolean;
      readonly statusItems: readonly StatusItemId[];
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
  | { readonly type: "session.bound"; readonly agentId: string }
  | { readonly type: "chat.assistant"; readonly text: string }
  | { readonly type: "run.progress"; readonly text: string }
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
