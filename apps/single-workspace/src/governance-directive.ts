import type { DirectiveHandler, DirectiveOutcome } from "@arbor/agent-runtime";
import {
  type CommandGatewayService,
  newUuid7,
  sendMessagePlan,
} from "@arbor/application";
import {
  CommandId,
  type FormationProposalId,
  FormationProposalId as FormationProposalIdSchema,
  type GovernanceRequest,
  MessageId,
  parse,
} from "@arbor/domain";
import type {
  BoundedObservation,
  ClockService,
  ExecutionDriverError,
  FormationProposalStoreService,
  InboxProjectionStoreService,
  MessageStoreService,
  TransactionPortService,
  WorkspaceRepositoryService,
} from "@arbor/ports";
import { Effect, Option } from "effect";

const MAX_OBSERVATION_CHARS = 2000;

/** P6 `02` §2: bodyRef bounded by the frozen sender upload quota. */
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

const asProposalId = (value: unknown): FormationProposalId | null => {
  if (typeof value !== "string") {
    return null;
  }
  try {
    return parse(FormationProposalIdSchema)(value);
  } catch {
    return null;
  }
};

export interface RequestGovernanceDependencies {
  readonly gateway: CommandGatewayService;
  readonly proposals: FormationProposalStoreService;
  readonly inbox: InboxProjectionStoreService;
  readonly tx: TransactionPortService;
  readonly clock: ClockService;
  readonly workspaces: WorkspaceRepositoryService;
  readonly messages: MessageStoreService;
}

/** P6 `02` §6: RequestGovernance minimal routing. Exactly two request kinds
 * route (FormationApproval → human Inbox reference into the proposing
 * parent Workspace's Inbox; DecisionRequest → SendMessage to the parent
 * Workspace, consumed there as a DecisionRequest Message). The routing
 * itself performs no canonical mutation — Inbox admission is projection
 * only, and the SendMessage path is durable communication; adjudication
 * still goes through RecordDecision. Every other request kind keeps the P5
 * observation-only behavior. */
export const makeRequestGovernanceHandler = (
  dependencies: RequestGovernanceDependencies,
): DirectiveHandler => ({
  kind: "RequestGovernance",
  handle: ({ directive, execution, context }) =>
    Effect.gen(function* () {
      if (directive._tag !== "RequestGovernance") {
        return {
          _tag: "Unsupported" as const,
          reason: "not a RequestGovernance",
        };
      }
      const request = directive.request as
        | GovernanceRequest
        | {
            readonly _tag?: unknown;
          };
      const tag = (request as { readonly _tag?: unknown })._tag;

      if (tag === "FormationApproval") {
        const raw = request as {
          readonly proposalId?: unknown;
          readonly proposalRevision?: unknown;
        };
        const proposalId = asProposalId(raw.proposalId);
        if (proposalId === null || typeof raw.proposalRevision !== "number") {
          return observation(
            "Runtime",
            `governance: malformed FormationApproval request (recorded only): ${JSON.stringify(request)}`,
          );
        }
        const revision = raw.proposalRevision;
        const found = yield* dependencies.tx.transact(
          dependencies.proposals.findById(proposalId),
        );
        if (Option.isNone(found)) {
          return observation(
            "Runtime",
            `governance: unknown proposal ${proposalId} (no-op)`,
          );
        }
        const record = found.value;
        if (record.state !== "Pending") {
          return observation(
            "Runtime",
            `governance: proposal ${record.proposalId} is ${record.state}, not pending (no-op)`,
          );
        }
        // P6 `01` §4.2 (D1): the human Inbox reference goes to the
        // proposing parent Workspace (record.parentWorkspaceId) — projection
        // admission only, never a canonical mutation.
        yield* dependencies.tx.transact(
          dependencies.inbox.admitUpsert({
            recipientWorkspaceId: record.parentWorkspaceId,
            entryKey: `gov:${proposalId}:${revision}`,
            kind: "Governance",
            summary: `formation proposal "${record.proposal.name}" revision ${revision} awaiting human decision`,
            admittedAt: yield* dependencies.clock.now(),
          }),
        );
        return observation(
          "Runtime",
          `governance: proposal ${proposalId} rev ${revision} awaiting human decision`,
        );
      }

      if (tag === "DecisionRequest") {
        const raw = request as {
          readonly question?: unknown;
          readonly correlationId?: unknown;
        };
        if (
          typeof raw.question !== "string" ||
          raw.question.length === 0 ||
          (raw.correlationId !== undefined &&
            typeof raw.correlationId !== "string")
        ) {
          return observation(
            "Runtime",
            `governance: malformed DecisionRequest request (recorded only): ${JSON.stringify(request)}`,
          );
        }
        const question = raw.question;
        const correlationId =
          raw.correlationId === undefined ? undefined : raw.correlationId;
        const sender = yield* dependencies.tx.transact(
          dependencies.workspaces.findById(execution.workspaceId),
        );
        if (Option.isNone(sender)) {
          return observation(
            "Runtime",
            "governance: DecisionRequest from unknown workspace (recorded only)",
          );
        }
        const parentWorkspaceId = sender.value.parentWorkspaceId;
        if (parentWorkspaceId === null) {
          return observation(
            "Runtime",
            "governance: DecisionRequest from root has no parent (recorded only)",
          );
        }
        // Caller-preallocated deterministic ids (DID v1.7 G5): replaying the
        // same directive dedups at the gateway by commandId idempotency.
        const seed = `${execution.executionId}:${correlationId ?? ""}:${question}`;
        const messageId = parse(MessageId)(
          `msg_${newUuid7("gov-decision-message", seed)}`,
        );
        const commandId = parse(CommandId)(
          `cmd_${newUuid7("gov-decision-command", seed)}`,
        );
        const plan = sendMessagePlan({
          messageId,
          commandId,
          projectId: execution.projectId,
          senderWorkspaceId: execution.workspaceId,
          principal: context.principal,
          actor: context.principal as never,
          message: {
            kind: "DecisionRequest",
            recipientWorkspaceId: parentWorkspaceId,
            bodyRef: `q:${question}`.slice(0, MAX_BODY_REF_LENGTH),
            correlationId,
            urgency: "Normal",
          },
        });
        const receipt = yield* dependencies.gateway.execute(
          {
            commandType: "SendMessage",
            commandId,
            projectId: execution.projectId,
            actor: context.principal as never,
            issuedAt: yield* dependencies.clock.now(),
            payload: plan.payload,
          },
          context,
          plan.authority,
        );
        if (receipt.resolution._tag !== "Committed") {
          const reason =
            receipt.resolution._tag === "TerminalRejected"
              ? JSON.stringify(receipt.resolution.error)
              : "operational failure";
          return observation(
            "Runtime",
            `governance: decision request rejected (non-fatal): ${reason}`,
          );
        }
        return observation(
          "Runtime",
          "governance: decision request routed to parent",
        );
      }

      // P5 behavior: unknown governance request kinds are recorded only.
      return observation("Runtime", JSON.stringify(request));
    }).pipe(Effect.mapError(driverError)),
});
