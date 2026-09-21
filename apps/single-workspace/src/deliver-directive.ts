import type { DirectiveHandler, DirectiveOutcome } from "@arbor/agent-runtime";
import type { CommandHandlerError, CommandRejection } from "@arbor/application";
import { newUuid7 } from "@arbor/application";
import type {
  Actor,
  DeliverableId,
  DeliverDirectiveSpec,
  Principal,
  ProjectId,
  WorkspaceId,
} from "@arbor/domain";
import {
  CommandId,
  DeliverableId as DeliverableIdSchema,
  MessageId,
  parse,
} from "@arbor/domain";
import type { BoundedObservation, ExecutionDriverError } from "@arbor/ports";
import { Effect } from "effect";

const MAX_OBSERVATION_CHARS = 2000;

/** P6 `02` §2 (inherited by P7 `02` §3): bodyRef bounded view. */
const MAX_BODY_REF_LENGTH = 4096;

const bounded = (text: string): BoundedObservation =>
  text.length > MAX_OBSERVATION_CHARS
    ? { text: text.slice(0, MAX_OBSERVATION_CHARS), truncated: true }
    : { text, truncated: false };

const driverError = (cause: unknown): ExecutionDriverError => ({
  _tag: "ExecutionDriverError",
  cause,
});

const observation = (
  source: "Runtime" | "Tool",
  text: string,
): DirectiveOutcome => ({
  _tag: "Observation",
  source,
  observation: bounded(text),
});

const asDeliverableId = (value: unknown): DeliverableId | null => {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  try {
    return parse(DeliverableIdSchema)(value);
  } catch {
    return null;
  }
};

/** P7 `02` §8. Narrow the untrusted model-issued spec to DeliverDirectiveSpec
 * (deliverableId non-empty DeliverableId, bodyRef within the frozen quota,
 * optional string correlation/causation). */
export const isDeliverDirectiveSpec = (
  spec: unknown,
): spec is DeliverDirectiveSpec => {
  if (typeof spec !== "object" || spec === null) {
    return false;
  }
  const candidate = spec as {
    readonly deliverableId?: unknown;
    readonly bodyRef?: unknown;
    readonly correlationId?: unknown;
    readonly causationId?: unknown;
  };
  if (asDeliverableId(candidate.deliverableId) === null) {
    return false;
  }
  if (
    typeof candidate.bodyRef !== "string" ||
    candidate.bodyRef.length === 0 ||
    candidate.bodyRef.length > MAX_BODY_REF_LENGTH
  ) {
    return false;
  }
  if (
    (candidate.correlationId !== undefined &&
      typeof candidate.correlationId !== "string") ||
    (candidate.causationId !== undefined &&
      typeof candidate.causationId !== "string")
  ) {
    return false;
  }
  return true;
};

/** Composition-side view of `submitDeliver` (packages/application
 * deliver-command.ts): fully applied with its store dependencies and wrapped
 * in the caller's transaction, so the directive needs no services. */
export type SubmitDeliverCall = (args: {
  readonly senderWorkspaceId: WorkspaceId;
  readonly deliverableId: DeliverableId;
  readonly bodyRef: string;
  readonly correlationId?: string | undefined;
  readonly causationId?: string | undefined;
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly projectId: ProjectId;
  readonly actor: Actor;
  readonly principal: Principal;
}) => Effect.Effect<DeliverDirectiveResult, CommandHandlerError>;

/** Structural subset of the command-level DeliverSubmission the directive
 * consumes (full outcome fields stay command-owned). */
export type DeliverDirectiveResult =
  | {
      readonly _tag: "Delivered";
      readonly outcome: {
        readonly recipientWorkspaceId: WorkspaceId;
        readonly wakeSignal: {
          readonly reason: { readonly _tag: "ChildDelivered" };
        };
      };
    }
  | { readonly _tag: "Rejected"; readonly rejection: CommandRejection };

export interface DeliverDirectiveDependencies {
  readonly submitDeliver: SubmitDeliverCall;
}

/** P7 `02` §8. The Deliver directive: validates the spec, derives the
 * recipient (never model-chosen — the command resolves the sender's direct
 * parent structurally), allocates deterministic caller-preallocated ids
 * (replaying the same directive dedups at the command layer), and submits the
 * Deliver command. A typed rejection is a model-visible non-fatal
 * observation, not an Execution failure. */
export const makeDeliverDirectiveHandler = (
  dependencies: DeliverDirectiveDependencies,
): DirectiveHandler => ({
  kind: "Deliver" as unknown as DirectiveHandler["kind"],
  handle: ({ directive, execution, context }) =>
    Effect.gen(function* () {
      const tag = (directive as { readonly _tag: string })._tag;
      if (tag !== "Deliver") {
        return {
          _tag: "Unsupported" as const,
          reason: "not a Deliver",
        };
      }
      const spec = (directive as { readonly spec: unknown }).spec;
      if (!isDeliverDirectiveSpec(spec)) {
        return observation(
          "Runtime",
          "deliver rejected: malformed DeliverDirectiveSpec payload",
        );
      }
      const seed = `${execution.executionId}:${spec.deliverableId}`;
      const messageId = parse(MessageId)(
        `msg_${newUuid7("deliver-message", seed)}`,
      );
      const commandId = parse(CommandId)(
        `cmd_${newUuid7("deliver-command", seed)}`,
      );
      const submission = yield* dependencies.submitDeliver({
        senderWorkspaceId: execution.workspaceId,
        deliverableId: spec.deliverableId,
        bodyRef: spec.bodyRef,
        correlationId: spec.correlationId,
        causationId: spec.causationId,
        commandId,
        messageId,
        projectId: execution.projectId,
        actor: context.principal as never,
        principal: context.principal,
      });
      if (submission._tag === "Rejected") {
        return observation(
          "Runtime",
          `deliver rejected (non-fatal): ${JSON.stringify(submission.rejection)}`,
        );
      }
      return observation(
        "Runtime",
        `delivered ${spec.deliverableId} to parent ${submission.outcome.recipientWorkspaceId} (kind: Deliver)`,
      );
    }).pipe(Effect.mapError(driverError)),
});
