import type { InboxEntry, WorkspaceId } from "@arbor/domain";
import { messageEntryKey } from "@arbor/domain";
import type { MessageRecord } from "@arbor/ports";
import { Effect } from "effect";
import type { ProjectionReadError } from "./errors.js";

// --- P10 `04` §2 Inbox M1: state-reconciliation audit face ---------------
//
// The P6 inbox store is command-path maintained (NOT event-replayed), so
// its "rebuild" face is STATE RECONCILIATION: compare inbox_entries
// against canonical message / specialist-settlement facts and produce a
// drift report + repair hints. The audit pass itself NEVER writes —
// repair goes via the P6 admission/consumption paths (operator-triggered
// only; no automatic repair; P6 semantics unchanged).

export type InboxDriftKind = "MissingEntry" | "ExtraEntry" | "DuplicateFact";

export interface InboxDriftItem {
  readonly kind: InboxDriftKind;
  readonly workspaceId: WorkspaceId;
  /** The inbox row key involved (extra/duplicate) or the expected key
   * (missing). */
  readonly entryKey: string;
  /** Canonical fact the key should bind to ("message:{id}" /
   * "specialist-settlement:{executionId}"). */
  readonly canonicalFactRef: string;
  readonly detail: string;
}

/** A repair instruction — executable ONLY through the P6 faces
 * (InboxProjectionStore admission / consumption), never a direct write. */
export interface InboxRepairHint {
  readonly entryKey: string;
  readonly via: "P6InboxAdmission" | "P6InboxConsumption";
  readonly action: "admit" | "consume" | "review";
  /** For `admit`: the exact entry the P6 admission path re-admits. */
  readonly entry?: InboxEntry;
  readonly reason: string;
}

export interface InboxReconcileReport {
  readonly workspaceId: WorkspaceId;
  readonly drift: ReadonlyArray<InboxDriftItem>;
  readonly repairHints: ReadonlyArray<InboxRepairHint>;
}

/** One inbox_entries row (consumed or not) — the audit reads all rows. */
export interface InboxRowFact {
  readonly entryKey: string;
  readonly kind: InboxEntry["kind"];
  readonly summary: string;
  readonly correlationId: string | null;
  readonly admittedAt: string;
  readonly consumedAt: string | null;
}

/** Canonical specialist-settlement fact (P6 `01` §3 D3): the fingerprint
 * keys the replay-safe entry (specialistSettlementEntryKey). */
export interface SpecialistSettlementFact {
  readonly specialistExecutionId: string;
  readonly settlementFingerprint: string;
}

export interface InboxReconcileDeps {
  readonly listInboxRows: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<InboxRowFact>, ProjectionReadError>;
  readonly listMessagesForRecipient: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<MessageRecord>, ProjectionReadError>;
  readonly listSpecialistSettlementFacts: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<
    ReadonlyArray<SpecialistSettlementFact>,
    ProjectionReadError
  >;
}

const MESSAGE_KEY_PREFIX = "msg:";
const SPECIALIST_KEY_PREFIX = "spc:";

/** The canonical fact identity an inbox key binds to — the duplicate
 * detector's grouping (e.g. two spc keys over the same execution are the
 * same fact admitted twice). null = key outside the audited P6 key
 * spaces (HumanInput steer:/Governance dec: rows are command-side
 * maintained and out of the frozen comparison scope). */
export const canonicalFactRefOfKey = (entryKey: string): string | null => {
  if (entryKey.startsWith(MESSAGE_KEY_PREFIX)) {
    return `message:${entryKey.slice(MESSAGE_KEY_PREFIX.length)}`;
  }
  if (entryKey.startsWith(SPECIALIST_KEY_PREFIX)) {
    const rest = entryKey.slice(SPECIALIST_KEY_PREFIX.length);
    const executionId = rest.split(":")[0] ?? "";
    return `specialist-settlement:${executionId}`;
  }
  return null;
};

/** The audit pass — pure read + compare, zero canonical mutation. */
export const reconcileInbox = (
  workspaceId: WorkspaceId,
  deps: InboxReconcileDeps,
): Effect.Effect<InboxReconcileReport, ProjectionReadError> =>
  Effect.gen(function* () {
    const rows = yield* deps.listInboxRows(workspaceId);
    const messages = yield* deps.listMessagesForRecipient(workspaceId);
    const settlements = yield* deps.listSpecialistSettlementFacts(workspaceId);

    const expectedKeys = new Map<string, InboxEntry>();
    for (const message of messages) {
      const entryKey = messageEntryKey(message.messageId);
      expectedKeys.set(entryKey, {
        recipientWorkspaceId: workspaceId,
        entryKey,
        kind: "Message",
        summary: message.message.bodyRef,
        correlationId: message.message.correlationId,
        admittedAt: message.sentAt,
      });
    }
    for (const settlement of settlements) {
      const entryKey = `spc:${settlement.specialistExecutionId}:${settlement.settlementFingerprint}`;
      expectedKeys.set(entryKey, {
        recipientWorkspaceId: workspaceId,
        entryKey,
        kind: "SpecialistSettled",
        summary: "specialist settlement",
        admittedAt: "",
      });
    }

    const drift: Array<InboxDriftItem> = [];
    const repairHints: Array<InboxRepairHint> = [];

    const rowKeys = new Set(rows.map((row) => row.entryKey));
    // The LIVE marker set: unconsumed rows are the projection's current
    // face; consumed rows are historical (canonical, P6-owned — they
    // stay). Extra/duplicate detection therefore ranges over unconsumed
    // rows only, so operator repair via the P6 consumption path
    // converges the report to zero drift without deleting anything.
    const liveRows = rows.filter((row) => row.consumedAt === null);
    const _liveKeys = new Set(liveRows.map((row) => row.entryKey));

    // 1. Missing: canonical fact exists, no inbox row for its key
    //    (row existence at all counts — consumed or not).
    for (const [entryKey, entry] of [...expectedKeys].sort(([a], [b]) =>
      a < b ? -1 : 1,
    )) {
      if (!rowKeys.has(entryKey)) {
        const canonicalFactRef = canonicalFactRefOfKey(entryKey) ?? entryKey;
        drift.push({
          kind: "MissingEntry",
          workspaceId,
          entryKey,
          canonicalFactRef,
          detail: `canonical fact ${canonicalFactRef} has no inbox row`,
        });
        repairHints.push({
          entryKey,
          via: "P6InboxAdmission",
          action: "admit",
          entry,
          reason: `re-admit ${canonicalFactRef} through the P6 admission path (InboxProjectionStore upsert-by-entryKey); never a direct write`,
        });
      }
    }

    // 2. Extra: live audited-key-space row whose canonical fact identity
    // matches NO expected fact (a row over a represented identity is a
    // duplicate candidate, reported once by the duplicate detector).
    const expectedIdentities = new Set(
      [...expectedKeys.keys()]
        .map((entryKey) => canonicalFactRefOfKey(entryKey))
        .filter((ref): ref is string => ref !== null),
    );
    for (const row of liveRows) {
      const canonicalFactRef = canonicalFactRefOfKey(row.entryKey);
      if (
        canonicalFactRef === null ||
        expectedKeys.has(row.entryKey) ||
        expectedIdentities.has(canonicalFactRef)
      ) {
        continue;
      }
      drift.push({
        kind: "ExtraEntry",
        workspaceId,
        entryKey: row.entryKey,
        canonicalFactRef,
        detail: `inbox row ${row.entryKey} matches no canonical ${canonicalFactRef} fact`,
      });
      repairHints.push({
        entryKey: row.entryKey,
        via: "P6InboxConsumption",
        action: "review",
        reason: `operator reviews the orphaned row; if stale, consume it through the P6 consumption path (markConsumed) — no automatic repair`,
      });
    }

    // 3. Duplicated: multiple LIVE audited rows binding the same
    // canonical fact identity (impossible at the PK level for identical
    // keys; the detector catches same-fact different-key shapes, e.g.
    // two spc fingerprints over one specialist execution).
    const byFact = new Map<string, Array<{ entryKey: string }>>();
    for (const row of liveRows) {
      const canonicalFactRef = canonicalFactRefOfKey(row.entryKey);
      if (canonicalFactRef === null) {
        continue;
      }
      const group = byFact.get(canonicalFactRef) ?? [];
      group.push({ entryKey: row.entryKey });
      byFact.set(canonicalFactRef, group);
    }
    for (const [canonicalFactRef, group] of [...byFact].sort(([a], [b]) =>
      a < b ? -1 : 1,
    )) {
      if (group.length <= 1) {
        continue;
      }
      const members = group
        .map((other) => other.entryKey)
        .sort()
        .join(", ");
      for (const member of group) {
        drift.push({
          kind: "DuplicateFact",
          workspaceId,
          entryKey: member.entryKey,
          canonicalFactRef,
          detail: `canonical fact ${canonicalFactRef} is marked ${group.length} times (${members})`,
        });
      }
      repairHints.push({
        entryKey: members,
        via: "P6InboxConsumption",
        action: "consume",
        reason: `operator keeps the fact-current row and consumes the superseded duplicates through the P6 consumption path (markConsumed); the audit never writes`,
      });
    }

    drift.sort((a, b) =>
      `${a.kind}:${a.entryKey}` < `${b.kind}:${b.entryKey}` ? -1 : 1,
    );

    return { workspaceId, drift, repairHints };
  });
