import type {
  ExecutionId,
  ExecutionSettlement,
  WakeReason,
  WorkspaceId,
} from "@arbor/domain";
import {
  type SpecialistSettled,
  settlementFingerprint,
  specialistSettlementEntryKey,
} from "@arbor/domain";
import type {
  InboxProjectionStoreError,
  InboxProjectionStoreService,
  TransactionScope,
} from "@arbor/ports";
import { Effect } from "effect";

/** P6 `01` §3 (D3 frozen constraint): a specialist Execution settlement
 * enters ONLY the parent Workspace Inbox projection. This module imports no
 * Session-related service (no session store, no driver/consumer session
 * writer) — that import surface is the D3 ban "no direct Parent Session
 * write" made checkable in code. Settlement flows exclusively through
 * InboxProjectionStore admission. */
export interface SpecialistSettlementAdmissionInput {
  readonly specialistExecutionId: ExecutionId;
  readonly parentWorkspaceId: WorkspaceId;
  readonly settlement: ExecutionSettlement;
  readonly summary: string;
  readonly occurredAt: string;
}

export interface AdmissionOutcome {
  readonly entryKey: string;
  readonly deduplicated: boolean;
  readonly wakeReason: WakeReason | null;
}

export interface SpecialistSettlementDependencies {
  readonly inbox: Pick<
    InboxProjectionStoreService,
    "admitUpsert" | "countByKey"
  >;
}

/** P6 `01` §3 (D3). Admit a specialist settlement observation into the
 * parent Workspace Inbox. Dedup key = specialistExecutionId +
 * settlementFingerprint (replay-safe: at-least-once redelivery of the same
 * settlement is a no-op upsert; the Inbox keeps at most one entry per
 * key). */
export const admitSpecialistSettlement = (
  input: SpecialistSettlementAdmissionInput,
  deps: SpecialistSettlementDependencies,
): Effect.Effect<
  AdmissionOutcome,
  InboxProjectionStoreError,
  TransactionScope
> =>
  Effect.gen(function* () {
    const observation: SpecialistSettled = {
      _tag: "SpecialistSettled",
      specialistExecutionId: input.specialistExecutionId,
      settlementFingerprint: settlementFingerprint(input.settlement),
      summary: input.summary,
    };
    const entryKey = specialistSettlementEntryKey(
      observation.specialistExecutionId,
      observation.settlementFingerprint,
    );

    // Pre-admit count decides first-vs-replayed (0 = first admission).
    const existing = yield* deps.inbox.countByKey(
      input.parentWorkspaceId,
      entryKey,
    );
    const deduplicated = existing > 0;

    yield* deps.inbox.admitUpsert({
      recipientWorkspaceId: input.parentWorkspaceId,
      entryKey,
      kind: "SpecialistSettled",
      summary: observation.summary,
      admittedAt: input.occurredAt,
    });

    // DID v1.7 §8.18 WakeReason has no dedicated Inbox variant; InputArrived
    // is the variant closest to "inbox arrival". Repeated wakes are harmless
    // (P2 durable wait semantics are idempotent).
    const wakeReason: WakeReason = { _tag: "InputArrived" };

    return { entryKey, deduplicated, wakeReason };
  });
