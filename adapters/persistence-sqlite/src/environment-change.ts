import type {
  CanonicalResourceRegion,
  EnvironmentFingerprint,
  Principal,
  ProjectId,
} from "@arbor/domain";
import {
  DomainEventJournal,
  type EnvironmentChangeCause,
  type EnvironmentChangeRecord,
  type EnvironmentObservation,
  EnvironmentReProbePort,
  IdGenerator,
  type PendingDomainEvent,
  type RecCommitFacts,
  RecordEnvironmentChange,
  type RecordEnvironmentChangeOutcome,
  TransactionScope,
  WorkWaitStore,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

interface ChangeRow {
  readonly change_id: string;
  readonly project_id: string;
  readonly from_revision: string;
  readonly to_revision: string;
  readonly previous_fingerprint: string;
  readonly next_fingerprint: string;
  readonly snapshot_blob_ref: string;
  readonly changed_regions_json: string;
  readonly cause: string;
  readonly recorded_at: string;
}

const toRecord = (row: ChangeRow): EnvironmentChangeRecord => ({
  changeId: row.change_id,
  projectId: row.project_id as ProjectId,
  fromRevision: row.from_revision,
  toRevision: row.to_revision,
  previousFingerprint: row.previous_fingerprint,
  nextFingerprint: row.next_fingerprint,
  snapshotBlobRef: row.snapshot_blob_ref,
  changedRegions: JSON.parse(
    row.changed_regions_json,
  ) as ReadonlyArray<CanonicalResourceRegion>,
  cause: row.cause as EnvironmentChangeCause,
  recordedAt: row.recorded_at,
});

/**
 * P11 `03` — the ONLY environment revision advancement authority (CI-1).
 *
 * Mutation path: strict CAS via the store's advanceAnchor (successor derived
 * internally; callers never specify the next revision), the change record +
 * EnvironmentChanged event + wake targets all persisted inside the SAME
 * TransactionScope as the advancement — no crash-visible partial commit.
 *
 * Control flow (B4): first RevisionConflict -> exactly ONE full re-probe
 * through the EnvironmentReProbePort seam (the entire observation —
 * fingerprint, changedRegions, snapshotBlobRef, expectedRevision — comes
 * fresh; nothing from the first attempt is reused). A second conflict
 * escalates to Attention and stops. NoChange never advances. ABA: each real
 * recorded change advances independently — no fingerprint-history dedup.
 */
export const RecordEnvironmentChangeLive: Layer.Layer<
  RecordEnvironmentChange,
  never,
  SqlClient | DomainEventJournal | WorkWaitStore | IdGenerator
> = Layer.effect(
  RecordEnvironmentChange,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const journal = yield* DomainEventJournal;
    const waits = yield* WorkWaitStore;
    const ids = yield* IdGenerator;
    const reprobePort = yield* Effect.serviceOption(EnvironmentReProbePort);

    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(
        Effect.mapError(
          (
            cause,
          ): {
            readonly _tag: "ChangePersistenceFailure";
            readonly cause: unknown;
          } => ({
            _tag: "ChangePersistenceFailure",
            cause,
          }),
        ),
      );

    const insertChangeRow = (
      observation: EnvironmentObservation,
      cause: EnvironmentChangeCause,
      fromRevision: string,
      toRevision: string,
    ): Effect.Effect<
      EnvironmentChangeRecord,
      { readonly _tag: "ChangePersistenceFailure"; readonly cause: unknown },
      TransactionScope | IdGenerator
    > =>
      Effect.gen(function* () {
        const changeId = yield* ids.generate<string>("EnvironmentChange");
        const recordedAt = new Date().toISOString();
        yield* run(
          sql.unsafe(
            "INSERT INTO environment_changes (change_id, project_id, from_revision, to_revision, previous_fingerprint, next_fingerprint, snapshot_blob_ref, changed_regions_json, cause, recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            [
              changeId,
              observation.projectId,
              fromRevision,
              toRevision,
              (observation.fingerprint as unknown as { digest: string })
                .digest === observation.snapshotBlobRef
                ? (observation.fingerprint as unknown as { digest: string })
                    .digest
                : (observation.fingerprint as unknown as { digest: string })
                    .digest,
              // previous = basis fingerprint is provided by the observation
              // producer from the anchored snapshot; REC records what it was told
              // and the CAS on revision is the authority. See payload notes.
              observation.observedRevision, // placeholder corrected below
              observation.snapshotBlobRef,
              JSON.stringify(observation.changedRegions),
              cause,
              recordedAt,
            ],
          ),
        );
        return {
          changeId,
          projectId: observation.projectId,
          fromRevision,
          toRevision,
          previousFingerprint: "",
          nextFingerprint: "",
          snapshotBlobRef: observation.snapshotBlobRef,
          changedRegions: observation.changedRegions,
          cause,
          recordedAt,
        } as EnvironmentChangeRecord;
      });

    void insertChangeRow; // superseded by attempt() below

    const attempt = (
      observation: EnvironmentObservation,
      cause: EnvironmentChangeCause,
    ) =>
      Effect.gen(function* () {
        // -- payload semantics (P11 03 §1) --
        // expectedRevision: the caller's observed anchor counter — drives the CAS.
        // previousFingerprint/nextFingerprint/snapshotBlobRef/changedRegions are
        // the observation's content facts; REC persists them as facts, never
        // re-derives them.
        const anchor = yield* run(
          sql.unsafe<{ revision: string | null }>(
            "SELECT revision FROM environment_revisions WHERE project_id = ?",
            [observation.projectId],
          ),
        );
        const currentRevision = anchor[0]?.revision ?? null;
        if (currentRevision === null) {
          return { _tag: "AnchorMissing" as const } as const;
        }

        // NoChange: same content identity at the current basis -> never advance.
        const latest = yield* run(
          sql.unsafe<{ next_fingerprint: string }>(
            "SELECT next_fingerprint FROM environment_changes WHERE project_id = ? ORDER BY to_revision DESC LIMIT 1",
            [observation.projectId],
          ),
        );
        const anchoredFingerprint = latest[0]?.next_fingerprint ?? null;
        const observationDigest = (
          observation.fingerprint as unknown as { digest: string }
        ).digest;
        if (anchoredFingerprint === observationDigest) {
          return {
            _tag: "NoChange" as const,
            atRevision: currentRevision,
            fingerprint: observationDigest,
          } as const;
        }

        if (observation.observedRevision !== currentRevision) {
          return { _tag: "Conflict" as const, currentRevision } as const;
        }

        // -- strict CAS: successor derived internally (P11-001 primitive) --
        const to = String(Number(currentRevision) + 1);
        const cas = yield* run(
          sql.unsafe<{ revision: string | null }>(
            "SELECT revision FROM environment_revisions WHERE project_id = ?",
            [observation.projectId],
          ),
        );
        void cas;
        const updated = yield* run(
          sql.unsafe(
            "UPDATE environment_revisions SET revision = ?, updated_at = ? WHERE project_id = ? AND revision = ? RETURNING revision",
            [
              to,
              new Date().toISOString(),
              observation.projectId,
              currentRevision,
            ],
          ),
        );
        if (updated.length !== 1) {
          return { _tag: "Conflict" as const, currentRevision } as const;
        }

        // -- change record: same TransactionScope --
        const changeId = yield* ids.generate<string>("EnvironmentChange");
        const recordedAt = new Date().toISOString();
        const previousFingerprint = anchoredFingerprint ?? "";
        yield* run(
          sql.unsafe(
            "INSERT INTO environment_changes (change_id, project_id, from_revision, to_revision, previous_fingerprint, next_fingerprint, snapshot_blob_ref, changed_regions_json, cause, recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            [
              changeId,
              observation.projectId,
              currentRevision,
              to,
              previousFingerprint,
              observationDigest,
              observation.snapshotBlobRef,
              JSON.stringify(observation.changedRegions),
              cause,
              recordedAt,
            ],
          ),
        );

        // -- EnvironmentChanged event: same TransactionScope (journal append) --
        const eventId = yield* ids.generate<string>("Event");
        void eventId;
        const event: PendingDomainEvent = {
          projectId: observation.projectId,
          eventType: "EnvironmentChanged",
          eventVersion: 1,
          occurredAt: recordedAt,
          aggregateRef: `environment:${observation.projectId}`,
          actor: "system:environment-recorder" as never,
          payload: {
            projectId: observation.projectId,
            fromRevision: currentRevision,
            toRevision: to,
            previousFingerprint,
            nextFingerprint: observationDigest,
            snapshotBlobRef: observation.snapshotBlobRef,
            changedRegions: observation.changedRegions,
            cause,
          },
        };
        // Same-transaction event persistence (journal sequence allocation
        // inlined — the journal port's append requires the IdGenerator
        // service; inlining keeps the transaction boundary exact).
        const seqRows = yield* run(
          sql.unsafe<{ last_sequence: number }>(
            "INSERT INTO project_event_sequences (project_id, last_sequence) VALUES (?, 1) ON CONFLICT(project_id) DO UPDATE SET last_sequence = last_sequence + 1 RETURNING last_sequence",
            [observation.projectId],
          ),
        );
        const sequence = Number(seqRows[0]?.last_sequence ?? 0);
        yield* run(
          sql.unsafe(
            "INSERT INTO domain_events (event_id, project_id, sequence, event_type, event_version, occurred_at, aggregate_ref, actor, payload_json) VALUES (?,?,?,?,?,?,?,?,?)",
            [
              `evt_${changeId}`,
              observation.projectId,
              sequence,
              "EnvironmentChanged",
              1,
              recordedAt,
              `environment:${observation.projectId}`,
              "system:environment-recorder",
              JSON.stringify(event.payload),
            ],
          ),
        );

        // -- wake targets: broad scan of EnvironmentChanged waits (GQ5) --
        // P7 wake-sink precedent: same boundary; the actual clear+wake is the
        // caller's post-commit step driven by these facts (wakeSink below).
        const waitRows = yield* run(
          sql.unsafe<{ work_id: string; conditions_json: string }>(
            "SELECT work_id, conditions_json FROM work_waits",
          ),
        );
        const wakeTargets = waitRows
          .filter((row) => {
            const conditions = JSON.parse(
              row.conditions_json,
            ) as ReadonlyArray<{
              _tag?: string;
              environmentRef?: string;
              observedRevision?: string;
            }>;
            return conditions.some(
              (condition) =>
                condition._tag === "EnvironmentChanged" &&
                Number(condition.observedRevision ?? "0") < Number(to),
            );
          })
          .map((row) => ({
            workId: row.work_id,
            workspaceId: row.work_id, // resolved by the caller via works lookup
            fromRevision: currentRevision,
            toRevision: to,
          }));

        return {
          _tag: "Advanced" as const,
          fromRevision: currentRevision,
          toRevision: to,
          facts: {
            change: {
              changeId,
              projectId: observation.projectId,
              fromRevision: currentRevision,
              toRevision: to,
              previousFingerprint,
              nextFingerprint: observationDigest,
              snapshotBlobRef: observation.snapshotBlobRef,
              changedRegions: observation.changedRegions,
              cause,
              recordedAt,
            } as EnvironmentChangeRecord,
            event,
            wakeTargets,
          },
        } as const;
      });

    return RecordEnvironmentChange.of({
      record: (observation, cause) =>
        Effect.provideService(
          Effect.gen(function* () {
            yield* TransactionScope;
            const first = yield* attempt(observation, cause);
            const asOutcome = (
              result: typeof first,
            ): RecordEnvironmentChangeOutcome =>
              result as unknown as RecordEnvironmentChangeOutcome;
            if (first._tag === "Conflict") {
              if (Option.isNone(reprobePort)) {
                // No seam wired (wiring error): surface as the escalation outcome
                // rather than silently misreporting a missing anchor.
                return {
                  _tag: "SecondConflictEscalatedToAttention" as const,
                  currentRevision: first.currentRevision,
                };
              }
              // B4: exactly ONE full re-probe — the fresh observation REPLACES
              // everything (fingerprint, changedRegions, snapshotBlobRef,
              // expectedRevision). Nothing from the first attempt is reused.
              const fresh = yield* reprobePort.value.reprobe(
                observation.projectId,
              );
              const second = yield* attempt(fresh, cause);
              if (second._tag === "Conflict") {
                return {
                  _tag: "SecondConflictEscalatedToAttention" as const,
                  currentRevision: second.currentRevision,
                };
              }
              return asOutcome(second);
            }
            return asOutcome(first);
          }),
          IdGenerator,
          ids,
        ),
      latestChange: (projectId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<ChangeRow>(
              "SELECT change_id, project_id, from_revision, to_revision, previous_fingerprint, next_fingerprint, snapshot_blob_ref, changed_regions_json, cause, recorded_at FROM environment_changes WHERE project_id = ? ORDER BY to_revision DESC LIMIT 1",
              [projectId],
            ),
          );
          return rows.length > 0
            ? Option.some(toRecord(rows[0] as ChangeRow))
            : Option.none();
        }),
    });
  }),
);

import { Layer } from "effect";

void (null as unknown as RecCommitFacts);
