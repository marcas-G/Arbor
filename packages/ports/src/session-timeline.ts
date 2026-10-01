import type {
  ContextEpochNumber,
  InboxEntry,
  ProviderTurnId,
  SessionId,
  WorkspaceId,
} from "@arbor/domain";
import type { PortableToolResultStatus } from "./provider.js";

export type SessionItemTrust =
  | "CanonicalInstruction"
  | "InstructionCandidate"
  | "DataOnly";

export type SessionItem =
  | {
      readonly _tag: "UserMessage";
      readonly source:
        | {
            readonly _tag: "InboxEntry";
            readonly workspaceId: WorkspaceId;
            readonly entryKey: string;
            readonly kind: InboxEntry["kind"];
          }
        | { readonly _tag: "HumanMessage"; readonly messageId: string }
        | { readonly _tag: "RuntimeContinuation"; readonly ref: string };
      readonly contentRef: string;
      readonly text: string;
      readonly trust: SessionItemTrust;
      readonly delivery: "Steer" | "Queue";
    }
  | {
      readonly _tag: "AssistantMessage";
      readonly providerTurnId: ProviderTurnId;
      readonly contentRef: string;
      readonly text: string;
      readonly finishReason: string;
    }
  | {
      readonly _tag: "ToolCall";
      readonly providerTurnId: ProviderTurnId;
      readonly callRef: string;
      readonly toolRef: string;
      readonly argumentsRef: string;
      readonly argumentsJson: string;
    }
  | {
      readonly _tag: "ToolResult";
      readonly callRef: string;
      readonly toolName: string;
      readonly invocationId?: string;
      readonly status: PortableToolResultStatus;
      readonly observationRef: string;
      readonly modelOutputRef: string;
      readonly outputText: string;
      readonly truncated: boolean;
      readonly artifactRefs: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "ControlResult";
      readonly callRef: string;
      readonly actionKind: string;
      readonly status: PortableToolResultStatus;
      readonly disposition: string;
      readonly outputText: string;
      readonly truncated: boolean;
      readonly canonicalRefs: ReadonlyArray<string>;
      readonly observationRef: string;
    }
  | {
      readonly _tag: "ContextUpdate";
      readonly sourceRef: string;
      readonly revision: number;
      readonly updateKind: "Full" | "Replace" | "Revoke";
      readonly contentRef: string;
      readonly text: string;
    }
  | {
      readonly _tag: "CompactionCheckpoint";
      readonly implementation: "Summary" | "ProviderNative";
      readonly fromEpoch: ContextEpochNumber;
      readonly toEpoch: ContextEpochNumber;
      readonly retainedFrontierRef: string;
      readonly summaryRef?: string;
      readonly summaryText?: string;
      readonly opaqueItemRef?: string;
      readonly bindingFingerprint: string | null;
    }
  | {
      readonly _tag: "AttachmentRef";
      readonly ref: string;
      readonly mediaType: string;
      readonly filename?: string;
      readonly trust: SessionItemTrust;
    };

export type SessionItemType = SessionItem["_tag"];

export interface SessionItemSource {
  readonly kind: string;
  readonly ref: string;
}

export interface SessionItemWrite {
  readonly item: SessionItem;
  readonly contextEpoch: ContextEpochNumber;
  readonly source: SessionItemSource;
  readonly contentHash: string;
}

export interface SessionItemRecord extends SessionItemWrite {
  readonly sessionId: SessionId;
  readonly sequence: number;
  readonly itemType: SessionItemType;
  readonly schemaVersion: 2;
  readonly createdAt: string;
}

export interface SessionCompactionCommit {
  readonly expectedEpoch: ContextEpochNumber;
  readonly nextEpoch: ContextEpochNumber;
  readonly checkpoint: Extract<
    SessionItem,
    { readonly _tag: "CompactionCheckpoint" }
  >;
  readonly source: SessionItemSource;
  readonly contentHash: string;
}

export interface SessionWriteFence {
  readonly executionId: import("@arbor/domain").ExecutionId;
  readonly workerId: string;
  readonly workerIncarnationId: string;
  readonly fencingGeneration: import("@arbor/domain").LeaseGeneration;
}

export const sessionEntryKindOf = (
  item: SessionItem,
):
  | "Input"
  | "ModelOutput"
  | "Observation"
  | "CheckpointReference"
  | "ContextUpdate" => {
  switch (item._tag) {
    case "UserMessage":
    case "AttachmentRef":
      return "Input";
    case "AssistantMessage":
    case "ToolCall":
      return "ModelOutput";
    case "ToolResult":
    case "ControlResult":
      return "Observation";
    case "ContextUpdate":
      return "ContextUpdate";
    case "CompactionCheckpoint":
      return "CheckpointReference";
  }
};
