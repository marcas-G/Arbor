import type {
  CommandSubmissionContext,
  Execution,
  ExecutionSettlement,
  MessageId,
  MessageKind,
  WaitSpec,
  WorkId,
  WorkspaceId,
} from "@arbor/domain";
import type { ControlBasis, ToolInvocation } from "@arbor/model-context";
import type {
  BoundedObservation,
  ControlToolCatalogPortService,
  ModelFacingControlToolDefinition,
} from "@arbor/ports";
import { Context, type Effect } from "effect";

export type AgentAction =
  | {
      readonly _tag: "Wait";
      readonly reason: string;
      readonly waitSpec: WaitSpec;
    }
  | {
      readonly _tag: "SendMessage";
      readonly kind: Exclude<MessageKind, "Deliver">;
      readonly body: string;
      readonly recipientWorkspaceId?: WorkspaceId;
      readonly queryMessageId?: MessageId;
    }
  | {
      /** ACR-8 (DID v1.19): P8 completion-claim chain is semantically
       * closed — the producer agent claims its Work is complete; the
       * workRevision is a trusted Runtime fact bound at the handler, never
       * model-supplied; the downstream StartVerification is driven by the
       * existing verification consumer (no command from the agent). */
      readonly _tag: "ClaimCompletion";
      readonly claim: string;
    }
  | {
      /** ACR-8 (DID v1.19): P2 execution-bound admission is closed. The
       * specialist is a temporary ExecutionBound execution bound to the
       * spawning execution; ids are deterministic Runtime facts derived
       * from the provider-turn occurrence. No durable Workspace or
       * responsibility is created. */
      readonly _tag: "SpawnSpecialist";
      readonly mission: string;
      readonly constraints: ReadonlyArray<string>;
    }
  | {
      /** ACR-8 (DID v1.19): P7 dependency lifecycle is frozen. The
       * dependencyId/consumerWorkId/expectedConsumerWorkRevision are
       * trusted Runtime facts bound at the handler; the matcher — never
       * the model — decides satisfaction. */
      readonly _tag: "DeclareDependency";
      readonly producerBinding:
        | { readonly _tag: "AnyProducer" }
        | { readonly _tag: "WorkspaceBound"; readonly workspaceId: WorkspaceId }
        | { readonly _tag: "WorkBound"; readonly workId: WorkId };
      readonly expectedDeliverable: {
        readonly kind: string;
        readonly requiredArtifactRoles: ReadonlyArray<string>;
      };
    }
  | {
      /** The model proposes; a human RecordDecision remains the governance
       * gate. When initial Work is proposed, its verification mission is
       * explicit and survives formation unchanged (DID v1.26 VDC). */
      readonly _tag: "ProposeChildWorkspace";
      readonly proposal: {
        readonly name: string;
        readonly rationale: string;
        readonly responsibilityDraft: {
          readonly purpose: string;
          readonly ownedResponsibilities: ReadonlyArray<string>;
          readonly obligations: ReadonlyArray<string>;
          readonly includes: ReadonlyArray<string>;
          readonly excludes: ReadonlyArray<string>;
          readonly interfaces: ReadonlyArray<string>;
        };
        readonly resourceBoundaryDraft: {
          readonly addresses: ReadonlyArray<
            | { readonly _tag: "FileTree"; readonly path: string }
            | { readonly _tag: "GitWorktree"; readonly path: string }
          >;
        };
        readonly initialWork?: {
          readonly objective: string;
          readonly why: string;
          readonly constraints: ReadonlyArray<string>;
          readonly completionExpectation: string;
          readonly verificationMission: {
            readonly goal: string;
            readonly criteria: ReadonlyArray<{
              readonly criterionId: string;
              readonly requirement: string;
              readonly required: boolean;
            }>;
            readonly riskRequirements: ReadonlyArray<string>;
          };
        };
      };
    };

export interface ControlToolInvocation {
  readonly invocation: ToolInvocation;
  readonly action: AgentAction;
}

export type ControlToolDecodeError =
  | { readonly _tag: "UnknownControlTool"; readonly toolName: string }
  | {
      readonly _tag: "InvalidControlArguments";
      readonly toolName: string;
      readonly reason: string;
    };

export type AgentActionOutcome =
  | {
      readonly _tag: "Observation";
      readonly source: "Runtime";
      readonly observation: BoundedObservation;
    }
  | { readonly _tag: "Settle"; readonly settlement: ExecutionSettlement };

export interface AgentActionHandlerInput {
  readonly action: AgentAction;
  readonly invocation: ToolInvocation;
  readonly execution: Execution;
  readonly context: CommandSubmissionContext;
}

export interface AgentActionHandler {
  readonly action: AgentAction["_tag"];
  readonly handle: (
    input: AgentActionHandlerInput,
  ) => Effect.Effect<AgentActionOutcome, AgentActionError>;
}

export interface AgentActionError {
  readonly _tag: "AgentActionError";
  readonly cause: unknown;
}

export type ExecutableInvocationOutcome =
  | {
      readonly _tag: "Observation";
      readonly source: "Runtime" | "Tool";
      readonly observation: BoundedObservation;
      readonly status?: import("@arbor/ports").PortableToolResultStatus;
      readonly resultRef?: string;
      readonly artifactRefs?: ReadonlyArray<string>;
    }
  | { readonly _tag: "Settle"; readonly settlement: ExecutionSettlement };

export interface ExecutableInvocationInput {
  readonly invocation: ToolInvocation;
  readonly execution: Execution;
  readonly context: CommandSubmissionContext;
  readonly controlBasis: ControlBasis;
}

export interface ExecutableInvocationHandler {
  readonly handle: (
    input: ExecutableInvocationInput,
  ) => Effect.Effect<ExecutableInvocationOutcome, AgentActionError>;
}

export interface ControlToolRegistryService
  extends ControlToolCatalogPortService {
  readonly definitions: () => ReadonlyArray<ModelFacingControlToolDefinition>;
  readonly classify: (toolName: string) => "Control" | "NotControl";
  readonly decode: (
    invocation: ToolInvocation,
  ) => Effect.Effect<ControlToolInvocation, ControlToolDecodeError>;
  readonly handle: (
    input: AgentActionHandlerInput,
  ) => Effect.Effect<AgentActionOutcome, AgentActionError>;
}

export class ControlToolRegistry extends Context.Service<
  ControlToolRegistry,
  ControlToolRegistryService
>()("arbor/ControlToolRegistry") {}
