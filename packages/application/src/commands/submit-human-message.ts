/**
 * P14 `01` — SubmitHumanMessage: the human-facing chat-turn command
 * (Authenticated Human → Root Workspace). Frozen semantics:
 *  - payload {messageId, targetWorkspaceId, bodyRef}; the human principal
 *    comes from the authority fact (authenticated External context), NEVER
 *    from the payload (no self-declared sender);
 *  - root-only is enforced at the authority layer (resolver); this handler
 *    binds the fact to the exact target;
 *  - durable Pending write + `HumanMessageSubmitted` event + root Inbox
 *    admission (kind=HumanConversation) in ONE transaction;
 *  - no Work mutation, no steer semantics (S3: ≠ WorkSteered/≠HumanInput).
 */
import type {
  CommandId,
  CommandSubmissionContext,
  Principal,
  ProjectId,
  WorkspaceId,
} from "@arbor/domain";
import type {
  HumanMessageRecord,
  HumanMessageStoreService,
  InboxProjectionStoreService,
  PendingDomainEvent,
  ProjectRepositoryError,
  TransactionScope,
} from "@arbor/ports";
import { Effect } from "effect";
import { commandErr, commandOk } from "../command-result.js";
import { semanticRequestFingerprint } from "../fingerprint.js";
import type { CommandHandler } from "../gateway.js";

export const MAX_HUMAN_BODY_REF_LENGTH = 8192;

export interface SubmitHumanMessagePayload {
  readonly messageId: string;
  readonly targetWorkspaceId: WorkspaceId;
  readonly bodyRef: string;
}

export interface SubmitHumanMessageResult {
  readonly messageId: string;
  readonly state: HumanMessageRecord["state"];
}

export interface SubmitHumanMessageDependencies {
  readonly messages: Pick<
    HumanMessageStoreService,
    "insertPending" | "findById"
  >;
  readonly inbox: Pick<InboxProjectionStoreService, "admitUpsert">;
  /** Composition-provided project root lookup (defense in depth beside the
   * resolver's root-only authority rule). */
  readonly rootWorkspaceOf: (
    projectId: ProjectId,
  ) => Effect.Effect<WorkspaceId, ProjectRepositoryError, TransactionScope>;
}

export const makeSubmitHumanMessageHandler = (
  dependencies: SubmitHumanMessageDependencies,
): CommandHandler<SubmitHumanMessagePayload, SubmitHumanMessageResult> => ({
  commandType: "SubmitHumanMessage",
  schemaVersion: "1",
  authority: {
    tag: "SubmitHumanMessageAuthority",
    targetMatches: (authority, payload) =>
      authority._tag === "SubmitHumanMessageAuthority" &&
      authority.targetWorkspaceId === payload.targetWorkspaceId &&
      authority.messageId === payload.messageId,
  },
  stopAdmission: { _tag: "Unclassified" },
  execute: (envelope, context) =>
    Effect.gen(function* () {
      const payload = envelope.payload;
      if (
        typeof payload.messageId !== "string" ||
        typeof payload.targetWorkspaceId !== "string" ||
        typeof payload.bodyRef !== "string" ||
        payload.messageId.length === 0
      ) {
        return commandErr({
          _tag: "AuthorityDenied",
          reason: "SubmitHumanMessage payload shape invalid",
        });
      }
      if (
        payload.bodyRef.length === 0 ||
        payload.bodyRef.length > MAX_HUMAN_BODY_REF_LENGTH
      ) {
        return commandErr({
          _tag: "ResourceExhausted",
          reason: `bodyRef must be 1..${MAX_HUMAN_BODY_REF_LENGTH} chars (got ${payload.bodyRef.length})`,
        });
      }
      // Root-only exact binding (P14 `01` §1): the authority layer already
      // guarantees target === root; the handler asserts it again against
      // the declared root source — defense in depth, zero UI trust.
      // Fail closed: an unresolvable root can never authorize the command.
      const root = yield* Effect.match(
        dependencies.rootWorkspaceOf(envelope.projectId),
        { onFailure: () => null, onSuccess: (workspaceId) => workspaceId },
      );
      if (root === null) {
        return commandErr({
          _tag: "AuthorityDenied",
          reason:
            "SubmitHumanMessage cannot resolve the project root workspace",
        });
      }
      if (payload.targetWorkspaceId !== root) {
        return commandErr({
          _tag: "AuthorityDenied",
          reason:
            "SubmitHumanMessage target must be the project root workspace",
        });
      }
      const humanPrincipal = humanPrincipalOf(context);
      if (humanPrincipal === null) {
        return commandErr({
          _tag: "AuthorityDenied",
          reason:
            "SubmitHumanMessage requires an authenticated human principal",
        });
      }

      const record: HumanMessageRecord = {
        messageId: payload.messageId,
        projectId: envelope.projectId,
        rootWorkspaceId: root,
        humanPrincipal,
        bodyRef: payload.bodyRef,
        commandId: envelope.commandId,
        fingerprint: fingerprintOf(
          envelope.commandType,
          envelope.projectId,
          envelope.actor,
          payload,
        ),
        state: "Pending",
        claimedByExecutionId: null,
        createdAt: envelope.issuedAt,
        settledAt: null,
        responseBody: null,
        attemptNo: 0,
      };

      // insertPending fails with HumanMessageConflict when the messageId
      // already exists — same fingerprint converges (semantic idempotency),
      // different fingerprint rejects (P14 `01` §2).
      const insertOutcome = yield* dependencies.messages
        .insertPending(record)
        .pipe(
          Effect.map(() => ({ kind: "inserted" as const })),
          Effect.catchTag("HumanMessageConflict", (conflict) =>
            Effect.succeed({
              kind: "existing" as const,
              existing: conflict.existing,
            }),
          ),
        );
      if (insertOutcome.kind === "existing") {
        const existing = insertOutcome.existing;
        return existing.fingerprint === record.fingerprint
          ? commandOk({
              result: {
                messageId:
                  existing.messageId as SubmitHumanMessageResult["messageId"],
                state: existing.state,
              },
              events: [],
            })
          : commandErr({
              _tag: "IdempotencyConflict",
              commandId: envelope.commandId,
            });
      }

      // Root Inbox admission — kind=HumanConversation (≠ HumanInput steer).
      yield* dependencies.inbox.admitUpsert({
        recipientWorkspaceId: root,
        entryKey: `humanmsg:${payload.messageId}`,
        kind: "HumanConversation",
        summary: boundedSummary(payload.bodyRef),
        admittedAt: envelope.issuedAt,
      });

      const events: PendingDomainEvent[] = [
        {
          projectId: envelope.projectId,
          eventType: "HumanMessageSubmitted",
          eventVersion: 1,
          occurredAt: envelope.issuedAt,
          aggregateRef: payload.messageId,
          actor: envelope.actor,
          causedByCommandId: envelope.commandId,
          payload: {
            messageId: payload.messageId,
            rootWorkspaceId: root,
            humanPrincipal,
            bodyRef: payload.bodyRef,
          },
        },
      ];

      return commandOk({
        result: {
          messageId: payload.messageId,
          state: "Pending" as const,
        },
        events,
      });
    }),
});

/** The human principal comes from the authenticated External submission
 * context (P12 `10` §3 transport proof) — the payload never declares a
 * sender (P14 `01` §1). */
const humanPrincipalOf = (
  context: CommandSubmissionContext,
): Principal | null => (context._tag === "External" ? context.principal : null);

/** Semantic request fingerprint over the frozen payload shape (P1 §8 rule,
 * application's frozen algorithm) — the store's logical-dedup anchor. */
const fingerprintOf = (
  commandType: string,
  projectId: ProjectId,
  actor: string,
  payload: SubmitHumanMessagePayload,
): string =>
  semanticRequestFingerprint({
    commandType,
    projectId,
    actor: actor as never,
    schemaVersion: "1",
    payload: payload as unknown,
  });

const boundedSummary = (bodyRef: string): string =>
  bodyRef.length <= 80 ? bodyRef : `${bodyRef.slice(0, 77)}…`;
