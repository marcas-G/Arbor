import type {
  CommandSubmissionContext,
  Execution,
  ExecutionSettlement,
} from "@arbor/domain";
import type { AgentDirective } from "@arbor/model-context";
import type { BoundedObservation, ExecutionDriverError } from "@arbor/ports";
import type { Effect } from "effect";

/** P5 `03`; DID v1.9 G3. A directive whose owning phase is not implemented in
 * the running slice returns this non-fatal, model-visible directive execution
 * result. It is NOT an `AgentDirective`, `DomainError`, `CommandRejection`, or
 * Execution failure. */
export interface DirectiveUnsupported {
  readonly _tag: "DirectiveUnsupported";
  readonly directiveKind: string;
  readonly reason: string;
}

export type DirectiveOutcome =
  | {
      readonly _tag: "Observation";
      readonly observation: BoundedObservation;
      readonly source: "Runtime" | "Tool";
    }
  | { readonly _tag: "Unsupported"; readonly reason: string }
  | { readonly _tag: "Settle"; readonly settlement: ExecutionSettlement };

export interface DirectiveHandler {
  readonly kind: AgentDirective["_tag"];
  readonly handle: (input: {
    readonly directive: AgentDirective;
    readonly execution: Execution;
    readonly context: CommandSubmissionContext;
  }) => Effect.Effect<DirectiveOutcome, ExecutionDriverError>;
}
