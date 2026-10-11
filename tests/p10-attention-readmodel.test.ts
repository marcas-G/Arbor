import { Cause, Effect, Exit } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ProjectId,
  parse,
  WorkId,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import type {
  AttentionFacts,
  AttentionReadDeps,
  AttentionRow,
} from "../packages/projection-runtime/src/index.js";
import {
  attentionCountsByWorkspace,
  deadlockCycleFingerprint,
  deriveAttentionRows,
  deriveProjectAttention,
  subtreeAttentionAggregate,
} from "../packages/projection-runtime/src/index.js";
import {
  insertDependencyRow,
  insertEventRow,
  insertExecutionRow,
  insertProjectRootRow,
  insertVerificationRow,
  insertWorkRow,
  insertWorkspaceRow,
  makeP10App,
  makeP10Deps,
  migrate,
  p10Child,
  p10Flagged,
  p10Leaf,
  p10Project,
  p10Root,
  runP10,
  seedCanonical,
  snapshotDatabase,
} from "./support/p10-fixture.js";

const WS_CONSUMER = parse(WorkspaceId)(
  "ws_00000000-0000-7000-8000-0000000000c1",
);
const WS_A = parse(WorkspaceId)("ws_00000000-0000-7000-8000-0000000000a1");
const WS_B = parse(WorkspaceId)("ws_00000000-0000-7000-8000-0000000000b1");
const WS_X = parse(WorkspaceId)("ws_00000000-0000-7000-8000-0000000000e1");
const WS_VACANT = parse(WorkspaceId)("ws_00000000-0000-7000-8000-0000000000d1");
const WS_RETIRED_PRODUCER = parse(WorkspaceId)(
  "ws_00000000-0000-7000-8000-000000000091",
);
const W_CONS = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000c1");
const W_A = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000a1");
const W_B = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000b1");

const sixSourceFacts: AttentionFacts = {
  unfulfillableEvents: [
    {
      dependencyId: "dep_u1",
      dependencyRevision: 2,
      consumerWorkId: W_CONS,
      occurredAt: "t1",
    },
  ],
  deadlockEvents: [
    {
      cycleWorkIds: [W_A, W_B],
      dependencyIds: ["dep_d1", "dep_d2"],
      detectedAt: "t2",
    },
  ],
  safetyStopSettlements: [
    { executionId: "exe_s1", workspaceId: WS_X, settledAt: "t3" },
  ],
  reconciliationEscalatedEvents: [
    {
      executionId: "exe_r1",
      invocationRefsFingerprint: "fp1",
      workspaceId: WS_X,
      occurredAt: "t4",
    },
  ],
  openVerifications: [
    {
      verificationId: "ver_o1",
      ownerWorkspaceId: p10Leaf,
      executionIds: ["exe_v1"],
    },
  ],
  executionSettlements: [
    { executionId: "exe_v1", settled: true, settledAt: "t5" },
  ],
  vacantProducerCandidates: [
    {
      dependencyId: "dep_g1",
      producerWorkspaceId: WS_VACANT,
      consumerWorkId: W_CONS,
    },
    {
      // GAP-01 negative: retired producer with no Open Work must NOT report
      dependencyId: "dep_g2",
      producerWorkspaceId: WS_RETIRED_PRODUCER,
      consumerWorkId: W_CONS,
    },
  ],
  workspaceVacancies: [
    { workspaceId: WS_VACANT, lifecycle: "Active", hasOpenWork: false },
    {
      workspaceId: WS_RETIRED_PRODUCER,
      lifecycle: "Retired",
      hasOpenWork: false,
    },
  ],
  workOwners: [
    { workId: W_CONS, workspaceId: WS_CONSUMER },
    { workId: W_A, workspaceId: WS_A },
    { workId: W_B, workspaceId: WS_B },
  ],
};

const rowsOf = (
  source: AttentionRow["source"],
  rows: ReadonlyArray<AttentionRow>,
): ReadonlyArray<AttentionRow> => rows.filter((row) => row.source === source);

describe("P10-004 Attention read-model — six sources / severity / target / dedupKey (02 §1)", () => {
  it("Normal is the absence of facts — no rows, no Normal rows", () => {
    expect(
      deriveAttentionRows({
        unfulfillableEvents: [],
        deadlockEvents: [],
        safetyStopSettlements: [],
        reconciliationEscalatedEvents: [],
        openVerifications: [],
        executionSettlements: [],
        vacantProducerCandidates: [],
        workspaceVacancies: [],
        workOwners: [],
      }),
    ).toEqual([]);
  });

  it("one example per source with the frozen severity/target/dedupKey mapping", () => {
    const rows = deriveAttentionRows(sixSourceFacts);

    const unfulfillable = rowsOf("DependencyUnfulfillable", rows);
    expect(unfulfillable).toHaveLength(1);
    expect(unfulfillable[0]).toMatchObject({
      severity: "Attention",
      targetWorkspaceId: WS_CONSUMER,
      dedupKey: "unfulfillable:dep_u1:2",
      occurredAt: "t1",
    });

    // Deadlock: emitted only under the No.42 project-idle gate — every
    // emitted fact is already Action Required; each cycle-member
    // workspace gets its own row (gate semantics, no conditional branch).
    const deadlocks = rowsOf("Deadlock", rows);
    expect(deadlocks).toHaveLength(2);
    expect(deadlocks.every((row) => row.severity === "ActionRequired")).toBe(
      true,
    );
    expect(new Set(deadlocks.map((row) => row.targetWorkspaceId))).toEqual(
      new Set([WS_A, WS_B]),
    );
    const fingerprint = deadlockCycleFingerprint(
      [W_A, W_B],
      ["dep_d1", "dep_d2"],
    );
    expect(deadlocks.map((row) => row.dedupKey).sort()).toEqual(
      [
        `deadlock:${fingerprint}:${WS_A}`,
        `deadlock:${fingerprint}:${WS_B}`,
      ].sort(),
    );

    const safety = rowsOf("RuntimeSafetyEnvelope", rows);
    expect(safety).toHaveLength(1);
    expect(safety[0]).toMatchObject({
      severity: "Attention",
      targetWorkspaceId: WS_X,
      dedupKey: "safety-stop:exe_s1",
    });

    const escalation = rowsOf("ReconciliationEscalated", rows);
    expect(escalation).toHaveLength(1);
    expect(escalation[0]).toMatchObject({
      severity: "ActionRequired",
      targetWorkspaceId: WS_X,
      dedupKey: "reconciliation-escalated:exe_r1:fp1",
      occurredAt: "t4",
    });

    // Verifier orphan: open verification × settled executions → Attention
    // → owner workspace; occurredAt = when the last bound verifier settled.
    const orphan = rowsOf("VerifierOrphan", rows);
    expect(orphan).toHaveLength(1);
    expect(orphan[0]).toMatchObject({
      severity: "Attention",
      targetWorkspaceId: p10Leaf,
      dedupKey: "verifier-orphan:ver_o1",
      occurredAt: "t5",
    });

    // GAP-01 positive: vacant-and-active producer → Attention → consumer
    // workspace, view label WaitingOnVacantProducer.
    const vacant = rowsOf("WaitingOnVacantProducer", rows);
    expect(vacant).toHaveLength(1);
    expect(vacant[0]).toMatchObject({
      severity: "Attention",
      targetWorkspaceId: WS_CONSUMER,
      dedupKey: "vacant-producer:dep_g1",
      occurredAt: null,
    });
    expect(vacant[0]?.summary).toContain("vacant producer");

    // GAP-01 negative: the retired producer emitted nothing.
    expect(rows.some((row) => row.dedupKey === "vacant-producer:dep_g2")).toBe(
      false,
    );

    expect(rows).toHaveLength(7);
  });

  it("AssignWork binding failures map to Action Required at the Parent with fact-id dedup", () => {
    const attentionFactId = `att_${"a".repeat(64)}`;
    const rows = deriveAttentionRows({
      ...sixSourceFacts,
      assignWorkBindingFailureEvents: [
        {
          attentionFactId,
          executionId: "exe_assign_work_binding",
          targetWorkspaceId: WS_A,
          logicalActionId: "lac_assign_work_binding",
          committedCommandId: "cmd_assign_work_binding",
          failureCode: "ReceiptMismatch",
          occurredAt: "t6",
        },
        {
          attentionFactId,
          executionId: "exe_assign_work_binding",
          targetWorkspaceId: WS_A,
          logicalActionId: "lac_assign_work_binding",
          committedCommandId: "cmd_assign_work_binding",
          failureCode: "ReceiptMismatch",
          occurredAt: "t6",
        },
      ],
    });
    expect(rowsOf("AssignWorkTargetBindingFailure", rows)).toEqual([
      {
        source: "AssignWorkTargetBindingFailure",
        severity: "ActionRequired",
        targetWorkspaceId: WS_A,
        dedupKey: attentionFactId,
        summary: expect.stringContaining("ReceiptMismatch"),
        occurredAt: "t6",
      },
    ]);
  });

  it("GAP-01 predicate edge: active producer WITH Open Work does not report", () => {
    const rows = deriveAttentionRows({
      ...sixSourceFacts,
      vacantProducerCandidates: [
        {
          dependencyId: "dep_g3",
          producerWorkspaceId: WS_VACANT,
          consumerWorkId: W_CONS,
        },
      ],
      workspaceVacancies: [
        { workspaceId: WS_VACANT, lifecycle: "Active", hasOpenWork: true },
      ],
    });
    expect(rowsOf("WaitingOnVacantProducer", rows)).toEqual([]);
  });

  it("verifier-orphan derived condition: active bound execution or no bound execution are not orphans", () => {
    const base = {
      ...sixSourceFacts,
      vacantProducerCandidates: [],
    };
    const active = deriveAttentionRows({
      ...base,
      executionSettlements: [
        { executionId: "exe_v1", settled: false, settledAt: null },
      ],
    });
    expect(rowsOf("VerifierOrphan", active)).toEqual([]);

    const unbound = deriveAttentionRows({
      ...base,
      openVerifications: [
        {
          verificationId: "ver_o2",
          ownerWorkspaceId: p10Leaf,
          executionIds: [],
        },
      ],
    });
    expect(rowsOf("VerifierOrphan", unbound)).toEqual([]);
  });

  it("dedup on read keyed by the frozen identities — re-emissions collapse, distinct facts stay", () => {
    const rows = deriveAttentionRows({
      ...sixSourceFacts,
      deadlockEvents: [
        {
          cycleWorkIds: [W_A, W_B],
          dependencyIds: ["dep_d1", "dep_d2"],
          detectedAt: "t2",
        },
        {
          // same cycle, detected again later — same fingerprint
          cycleWorkIds: [W_B, W_A],
          dependencyIds: ["dep_d2", "dep_d1"],
          detectedAt: "t6",
        },
      ],
      reconciliationEscalatedEvents: [
        {
          executionId: "exe_r1",
          invocationRefsFingerprint: "fp1",
          workspaceId: WS_X,
          occurredAt: "t4",
        },
        {
          executionId: "exe_r1",
          invocationRefsFingerprint: "fp1",
          workspaceId: WS_X,
          occurredAt: "t7",
        },
        {
          // same execution, different refs fingerprint — distinct fact
          executionId: "exe_r1",
          invocationRefsFingerprint: "fp2",
          workspaceId: WS_X,
          occurredAt: "t8",
        },
      ],
    });
    expect(rowsOf("Deadlock", rows)).toHaveLength(2);
    const escalations = rowsOf("ReconciliationEscalated", rows);
    expect(escalations).toHaveLength(2);
    expect(new Set(escalations.map((row) => row.dedupKey))).toEqual(
      new Set([
        "reconciliation-escalated:exe_r1:fp1",
        "reconciliation-escalated:exe_r1:fp2",
      ]),
    );
  });
});

describe("P10-004 bubbling (02 §2; SD §12.3)", () => {
  const rows = deriveAttentionRows(sixSourceFacts);

  it("subtree summary = aggregated severity counts over self + descendants; context never copied upward", () => {
    const parentOf = (workspaceId: typeof p10Leaf) =>
      workspaceId === p10Leaf
        ? p10Child
        : workspaceId === p10Child
          ? p10Root
          : null;
    const summaries = subtreeAttentionAggregate(rows, parentOf);

    // leaf owns the verifier orphan (Attention); child and root bubble it
    expect(summaries.get(p10Leaf)).toEqual({ attention: 1, actionRequired: 0 });
    expect(summaries.get(p10Child)).toEqual({
      attention: 1,
      actionRequired: 0,
    });
    expect(summaries.get(p10Root)).toEqual({ attention: 1, actionRequired: 0 });

    // with the deadlock members also under root via WS_A/WS_B parents:
    const summariesWithCycle = subtreeAttentionAggregate(rows, (workspaceId) =>
      workspaceId === WS_A || workspaceId === WS_B
        ? p10Root
        : parentOf(workspaceId),
    );
    // bubbling aggregates deduplicated facts: 2 deadlock rows (ActionRequired)
    expect(summariesWithCycle.get(p10Root)).toEqual({
      attention: 1,
      actionRequired: 2,
    });

    // structurally: the summary carries counts only — no context fields
    for (const summary of summariesWithCycle.values()) {
      expect(Object.keys(summary).sort()).toEqual([
        "actionRequired",
        "attention",
      ]);
    }
  });

  it("attentionCountsByWorkspace feeds the status overlay (attentionFacts)", () => {
    const counts = attentionCountsByWorkspace(rows);
    expect(counts.get(WS_A)).toBe(1);
    expect(counts.get(WS_CONSUMER)).toBe(2);
    expect(counts.get(p10Root)).toBeUndefined();
  });
});

// --- live on-read derivation over canonical rows (loader + GAP-01 join) ---

const W_CONS_LIVE = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000c1");
const W_LEAF_LIVE = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000e1");
const W_FLAG_LIVE = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000f1");

const seedAttention = seedCanonical(
  Effect.gen(function* () {
    yield* insertProjectRootRow(p10Root, p10Project);
    yield* insertWorkspaceRow(
      { workspaceId: p10Root, parentWorkspaceId: null, name: "root" },
      p10Project,
    );
    yield* insertWorkspaceRow(
      { workspaceId: p10Child, parentWorkspaceId: p10Root, name: "child" },
      p10Project,
    );
    yield* insertWorkspaceRow(
      { workspaceId: p10Leaf, parentWorkspaceId: p10Child, name: "leaf" },
      p10Project,
    );
    yield* insertWorkspaceRow(
      { workspaceId: p10Flagged, parentWorkspaceId: p10Root, name: "flagged" },
      p10Project,
    );
    yield* insertWorkspaceRow(
      {
        workspaceId: WS_CONSUMER,
        parentWorkspaceId: p10Root,
        name: "consumer",
      },
      p10Project,
    );
    yield* insertWorkspaceRow(
      { workspaceId: WS_VACANT, parentWorkspaceId: p10Root, name: "vacant" },
      p10Project,
    );
    yield* insertWorkspaceRow(
      {
        workspaceId: WS_RETIRED_PRODUCER,
        parentWorkspaceId: p10Root,
        name: "retired-producer",
        lifecycle: "Retired",
      },
      p10Project,
    );

    yield* insertWorkRow(
      { workId: W_CONS_LIVE, workspaceId: WS_CONSUMER, objective: "consume" },
      p10Project,
    );
    yield* insertWorkRow(
      { workId: W_LEAF_LIVE, workspaceId: p10Leaf, objective: "verify-me" },
      p10Project,
    );
    yield* insertWorkRow(
      { workId: W_FLAG_LIVE, workspaceId: p10Flagged, objective: "cycle" },
      p10Project,
    );

    // source 1: DependencyMarkedUnfulfillable event + transitioned row
    yield* insertDependencyRow({
      dependencyId: "dep_u1",
      consumerWorkId: W_CONS_LIVE,
      producerWorkspaceId: WS_VACANT,
      state: "Unfulfillable",
      revision: 2,
    });
    yield* insertEventRow({
      eventId: "evt_00000000-0000-7000-8000-00000000u01",
      projectId: p10Project,
      eventType: "DependencyMarkedUnfulfillable",
      payload: {
        dependencyId: "dep_u1",
        dependencyRevision: 2,
        justification: "producer gone",
      },
      occurredAt: "t1",
    });

    // source 2: DeadlockAttentionRequested (No.42 gate emission)
    yield* insertEventRow({
      eventId: "evt_00000000-0000-7000-8000-00000000d01",
      projectId: p10Project,
      eventType: "DeadlockAttentionRequested",
      payload: {
        cycleWorkIds: [W_FLAG_LIVE],
        dependencyIds: ["dep_d1"],
        detectedAt: "t2",
      },
      occurredAt: "t2",
    });

    // source 3: Interrupted(RuntimeSafetyStop) settlement
    yield* insertExecutionRow(
      {
        executionId: "exe_s1",
        workspaceId: p10Leaf,
        focusWorkId: W_LEAF_LIVE,
        settlement: {
          _tag: "Interrupted",
          result: {
            _tag: "ControlledInterruption",
            reason: "RuntimeSafetyStop",
          },
        },
        settledAt: "t3",
      },
      p10Project,
    );

    // source 4: ReconciliationEscalated (unreconcilable side effect)
    yield* insertExecutionRow(
      {
        executionId: "exe_r1",
        workspaceId: p10Leaf,
        focusWorkId: W_LEAF_LIVE,
        settlement: {
          _tag: "OutcomeUnknown",
          reconciliation: {
            _tag: "ReconciliationRequired",
            invocationRefs: ["ref-1"],
          },
        },
        settledAt: "t4",
      },
      p10Project,
    );
    yield* insertEventRow({
      eventId: "evt_00000000-0000-7000-8000-00000000r01",
      projectId: p10Project,
      eventType: "ReconciliationEscalated",
      aggregateRef: "exe_r1",
      payload: {
        executionId: "exe_r1",
        invocationRefsFingerprint: "fp1",
        refs: ["ref-1"],
      },
      occurredAt: "t4",
    });

    // source 5: verifier orphan (open verification × settled execution)
    yield* insertExecutionRow(
      {
        executionId: "exe_v1",
        workspaceId: p10Leaf,
        focusWorkId: W_LEAF_LIVE,
        settlement: {
          _tag: "Completed",
          result: { _tag: "CoordinationCompleted" },
        },
        settledAt: "t5",
      },
      p10Project,
    );
    yield* insertVerificationRow({
      verificationId: "ver_o1",
      workId: W_LEAF_LIVE,
      targetWorkRevision: 0,
      ownerWorkspaceId: p10Leaf,
      executionIds: ["exe_v1"],
    });
    // negative: bound execution still active → not an orphan
    yield* insertExecutionRow(
      {
        executionId: "exe_v2",
        workspaceId: p10Leaf,
        focusWorkId: W_LEAF_LIVE,
      },
      p10Project,
    );
    yield* insertVerificationRow({
      verificationId: "ver_o2",
      workId: W_LEAF_LIVE,
      targetWorkRevision: 1,
      ownerWorkspaceId: p10Leaf,
      executionIds: ["exe_v2"],
    });

    // source 6 (GAP-01): Unsatisfied ∧ WorkspaceBound × vacant-and-active
    // producer (positive) and retired producer (mandatory negative)
    yield* insertDependencyRow({
      dependencyId: "dep_g1",
      consumerWorkId: W_CONS_LIVE,
      producerWorkspaceId: WS_VACANT,
    });
    yield* insertDependencyRow({
      dependencyId: "dep_g2",
      consumerWorkId: W_CONS_LIVE,
      producerWorkspaceId: WS_RETIRED_PRODUCER,
    });
  }),
);

describe("P10-004 Attention read-model over canonical rows (live join, zero mutation)", () => {
  it("deriveProjectAttention renders all six sources with severity/target/dedupKey; GAP-01 retired negative; canonical snapshot unchanged", async () => {
    await runP10(
      Effect.gen(function* () {
        yield* migrate;
        yield* seedAttention;
        const deps = yield* makeP10Deps();
        const before = yield* snapshotDatabase();

        const rows = yield* deriveProjectAttention(p10Project, deps.attention);

        const unfulfillable = rowsOf("DependencyUnfulfillable", rows);
        expect(unfulfillable).toHaveLength(1);
        expect(unfulfillable[0]).toMatchObject({
          severity: "Attention",
          targetWorkspaceId: WS_CONSUMER,
          dedupKey: "unfulfillable:dep_u1:2",
        });

        const deadlocks = rowsOf("Deadlock", rows);
        expect(deadlocks).toHaveLength(1);
        expect(deadlocks[0]).toMatchObject({
          severity: "ActionRequired",
          targetWorkspaceId: p10Flagged,
        });
        expect(deadlocks[0]?.dedupKey).toContain(
          deadlockCycleFingerprint([W_FLAG_LIVE], ["dep_d1"]),
        );

        const safety = rowsOf("RuntimeSafetyEnvelope", rows);
        expect(safety).toHaveLength(1);
        expect(safety[0]).toMatchObject({
          severity: "Attention",
          targetWorkspaceId: p10Leaf,
          dedupKey: "safety-stop:exe_s1",
        });

        const escalation = rowsOf("ReconciliationEscalated", rows);
        expect(escalation).toHaveLength(1);
        expect(escalation[0]).toMatchObject({
          severity: "ActionRequired",
          targetWorkspaceId: p10Leaf,
          dedupKey: "reconciliation-escalated:exe_r1:fp1",
        });

        const orphans = rowsOf("VerifierOrphan", rows);
        expect(orphans).toHaveLength(1);
        expect(orphans[0]).toMatchObject({
          severity: "Attention",
          targetWorkspaceId: p10Leaf,
          dedupKey: "verifier-orphan:ver_o1",
        });

        const vacant = rowsOf("WaitingOnVacantProducer", rows);
        expect(vacant).toHaveLength(1);
        expect(vacant[0]).toMatchObject({
          severity: "Attention",
          targetWorkspaceId: WS_CONSUMER,
          dedupKey: "vacant-producer:dep_g1",
        });
        expect(
          rows.some((row) => row.dedupKey === "vacant-producer:dep_g2"),
        ).toBe(false);

        // the read-model never performs canonical mutation (GQ3/G8)
        const after = yield* snapshotDatabase();
        expect(after).toBe(before);
      }),
      makeP10App(),
    );
  });

  it("omits old Work Episode Attention immediately across lag/re-read and fails closed on a cross-Workspace binding", async () => {
    const result = await runP10(
      Effect.gen(function* () {
        yield* migrate;
        yield* seedAttention;
        const sql = yield* SqlClient;
        const deps = yield* makeP10Deps();
        const duplicateBindingDeps: AttentionReadDeps = {
          ...deps.attention,
          listAttentionSourceExecutionBindings: (projectId, executionIds) =>
            deps.attention
              .listAttentionSourceExecutionBindings(projectId, executionIds)
              .pipe(
                Effect.map((bindings) => [
                  ...bindings,
                  ...bindings.filter(
                    (binding) => binding.executionId === "exe_s1",
                  ),
                ]),
              ),
        };
        const duplicateBinding = yield* Effect.exit(
          deriveProjectAttention(p10Project, duplicateBindingDeps),
        );
        const beforeSteer = yield* deriveProjectAttention(
          p10Project,
          deps.attention,
        );
        const rootSummary = (rows: ReadonlyArray<AttentionRow>) =>
          subtreeAttentionAggregate(rows, (workspaceId) =>
            workspaceId === p10Leaf
              ? p10Child
              : workspaceId === p10Child
                ? p10Root
                : null,
          ).get(p10Root);
        const beforeSummary = rootSummary(beforeSteer);
        const staleAttentionBefore = beforeSteer.filter(
          (row) => row.source === "RuntimeSafetyEnvelope",
        ).length;
        const staleActionRequiredBefore = beforeSteer.filter(
          (row) => row.source === "ReconciliationEscalated",
        ).length;

        // A committed Steer advances the canonical Work while P10 has not
        // consumed the WorkSteered wakeup. Its old source facts remain.
        yield* sql.unsafe("UPDATE works SET revision = 1 WHERE work_id = ?", [
          W_LEAF_LIVE,
        ]);
        yield* insertEventRow({
          eventId: "evt_00000000-0000-7000-8000-00000000st1",
          projectId: p10Project,
          eventType: "WorkSteered",
          payload: { workId: W_LEAF_LIVE, revision: 1 },
          occurredAt: "t9",
        });
        const first = yield* deriveProjectAttention(p10Project, deps.attention);
        const second = yield* deriveProjectAttention(
          p10Project,
          deps.attention,
        );
        yield* sql.unsafe(
          "DELETE FROM agent_execution_state WHERE execution_id = 'exe_s1'",
        );
        const missingEpisodeState = yield* Effect.exit(
          deriveProjectAttention(p10Project, deps.attention),
        );
        yield* sql.unsafe(
          `INSERT INTO agent_execution_state (
             execution_id, focus_json, episode_json, wake_reason,
             current_mode, active_skill_refs_json, turn_no,
             recent_directive_refs_json, recent_action_fingerprints_json,
             updated_at
           ) VALUES ('exe_s1', ?, ?, 'Seed', NULL, '[]', 0, '[]', '[]', 't0')`,
          [
            JSON.stringify({ _tag: "Work", workId: W_LEAF_LIVE }),
            JSON.stringify({
              _tag: "WorkEpisode",
              workId: W_LEAF_LIVE,
              targetWorkRevision: 0,
            }),
          ],
        );
        yield* sql.unsafe(
          "UPDATE agent_execution_state SET episode_json = '{malformed' WHERE execution_id = 'exe_s1'",
        );
        const malformedEpisode = yield* Effect.exit(
          deriveProjectAttention(p10Project, deps.attention),
        );
        yield* sql.unsafe(
          "UPDATE agent_execution_state SET episode_json = ? WHERE execution_id = 'exe_s1'",
          [
            JSON.stringify({
              _tag: "WorkEpisode",
              workId: W_LEAF_LIVE,
              targetWorkRevision: 2,
            }),
          ],
        );
        const futureEpisode = yield* Effect.exit(
          deriveProjectAttention(p10Project, deps.attention),
        );
        yield* sql.unsafe(
          "UPDATE agent_execution_state SET episode_json = ? WHERE execution_id = 'exe_s1'",
          [
            JSON.stringify({
              _tag: "WorkEpisode",
              workId: W_LEAF_LIVE,
              targetWorkRevision: 0,
            }),
          ],
        );
        const sourceAudit = yield* sql.unsafe<{ readonly count: number }>(
          `SELECT COUNT(*) AS count FROM domain_events
            WHERE project_id = ? AND event_type = 'ReconciliationEscalated'`,
          [p10Project],
        );
        const oldSafetySettlement = yield* sql.unsafe<{
          readonly count: number;
        }>(
          "SELECT COUNT(*) AS count FROM executions WHERE execution_id = 'exe_s1' AND settlement_kind = 'Interrupted'",
        );

        // The source execution is in the child Workspace, while its episode
        // is corrupted to point at a Work owned by a different child.
        yield* sql.unsafe(
          "UPDATE agent_execution_state SET episode_json = ? WHERE execution_id = 'exe_s1'",
          [
            JSON.stringify({
              _tag: "WorkEpisode",
              workId: W_CONS_LIVE,
              targetWorkRevision: 0,
            }),
          ],
        );
        const corrupted = yield* Effect.exit(
          deriveProjectAttention(p10Project, deps.attention),
        );
        yield* sql.unsafe(
          "UPDATE agent_execution_state SET episode_json = ? WHERE execution_id = 'exe_s1'",
          [JSON.stringify({ _tag: "WorkEpisodeV9", workId: W_LEAF_LIVE })],
        );
        const unknownVersion = yield* Effect.exit(
          deriveProjectAttention(p10Project, deps.attention),
        );
        yield* sql.unsafe(
          "UPDATE executions SET settlement_json = 'not-json' WHERE execution_id = 'exe_s1'",
        );
        const malformedSettlement = yield* Effect.exit(
          deriveProjectAttention(p10Project, deps.attention),
        );
        yield* sql.unsafe(
          "UPDATE executions SET settlement_json = ? WHERE execution_id = 'exe_s1'",
          [
            JSON.stringify({
              _tag: "Interrupted",
              result: {
                _tag: "ControlledInterruption",
                reason: "RuntimeSafetyStop",
              },
            }),
          ],
        );
        yield* sql.unsafe(
          "UPDATE agent_execution_state SET episode_json = ? WHERE execution_id = 'exe_s1'",
          [
            JSON.stringify({
              _tag: "WorkEpisode",
              workId: W_LEAF_LIVE,
              targetWorkRevision: 0,
            }),
          ],
        );
        yield* sql.unsafe(
          "UPDATE domain_events SET aggregate_ref = 'exe_wrong' WHERE event_id = 'evt_00000000-0000-7000-8000-00000000r01'",
        );
        const eventMismatch = yield* Effect.exit(
          deriveProjectAttention(p10Project, deps.attention),
        );
        yield* sql.unsafe(
          "UPDATE domain_events SET aggregate_ref = 'exe_r1' WHERE event_id = 'evt_00000000-0000-7000-8000-00000000r01'",
        );
        yield* insertEventRow({
          eventId: "evt_00000000-0000-7000-8000-00000000r02",
          projectId: p10Project,
          eventType: "ReconciliationEscalated",
          aggregateRef: "exe_missing",
          payload: {
            executionId: "exe_missing",
            invocationRefsFingerprint: "fp-missing",
            refs: ["ref-missing"],
          },
          occurredAt: "t10",
        });
        const missingExecution = yield* Effect.exit(
          deriveProjectAttention(p10Project, deps.attention),
        );
        yield* sql.unsafe(
          "DELETE FROM domain_events WHERE event_id = 'evt_00000000-0000-7000-8000-00000000r02'",
        );
        const foreignProject = parse(ProjectId)(
          "prj_00000000-0000-7000-8000-000000000099",
        );
        const foreignWorkspace = parse(WorkspaceId)(
          "ws_00000000-0000-7000-8000-000000000099",
        );
        const foreignWork = parse(WorkId)(
          "wrk_00000000-0000-7000-8000-000000000099",
        );
        yield* seedCanonical(
          Effect.gen(function* () {
            yield* insertProjectRootRow(foreignWorkspace, foreignProject);
            yield* insertWorkspaceRow(
              {
                workspaceId: foreignWorkspace,
                parentWorkspaceId: null,
                name: "foreign",
              },
              foreignProject,
            );
            yield* insertWorkRow(
              {
                workId: foreignWork,
                workspaceId: foreignWorkspace,
                objective: "foreign source",
              },
              foreignProject,
            );
            yield* insertExecutionRow(
              {
                executionId: "exe_foreign",
                workspaceId: foreignWorkspace,
                focusWorkId: foreignWork,
              },
              foreignProject,
            );
          }),
        );
        yield* insertEventRow({
          eventId: "evt_00000000-0000-7000-8000-00000000r03",
          projectId: p10Project,
          eventType: "ReconciliationEscalated",
          aggregateRef: "exe_foreign",
          payload: {
            executionId: "exe_foreign",
            invocationRefsFingerprint: "fp-foreign",
            refs: ["ref-foreign"],
          },
          occurredAt: "t11",
        });
        const foreignExecution = yield* Effect.exit(
          deriveProjectAttention(p10Project, deps.attention),
        );
        return {
          beforeSummary,
          duplicateBinding,
          staleAttentionBefore,
          staleActionRequiredBefore,
          first,
          second,
          missingEpisodeState,
          malformedEpisode,
          futureEpisode,
          eventCount: Number(sourceAudit[0]?.count ?? 0),
          settlementCount: Number(oldSafetySettlement[0]?.count ?? 0),
          corrupted,
          unknownVersion,
          malformedSettlement,
          eventMismatch,
          missingExecution,
          foreignExecution,
        };
      }),
      makeP10App(),
    );
    expect(result.staleAttentionBefore).toBe(1);
    expect(result.staleActionRequiredBefore).toBe(1);
    for (const rows of [result.first, result.second]) {
      expect(rows.some((row) => row.source === "RuntimeSafetyEnvelope")).toBe(
        false,
      );
      expect(rows.some((row) => row.source === "ReconciliationEscalated")).toBe(
        false,
      );
      // A child-only stale source cannot bubble into the parent summary.
      const summary = subtreeAttentionAggregate(rows, (workspaceId) =>
        workspaceId === p10Leaf
          ? p10Child
          : workspaceId === p10Child
            ? p10Root
            : null,
      ).get(p10Root);
      expect(summary?.attention).toBe(
        (result.beforeSummary?.attention ?? 0) - result.staleAttentionBefore,
      );
      expect(summary?.actionRequired).toBe(
        (result.beforeSummary?.actionRequired ?? 0) -
          result.staleActionRequiredBefore,
      );
    }
    expect(result.eventCount).toBe(1);
    expect(result.settlementCount).toBe(1);
    expect(Exit.isFailure(result.duplicateBinding)).toBe(true);
    if (Exit.isFailure(result.duplicateBinding)) {
      expect(Cause.squash(result.duplicateBinding.cause)).toMatchObject({
        _tag: "ProjectionIntegrityFailure",
        reasonCode: "SourceExecutionNonUnique",
        executionId: "exe_s1",
      });
    }
    for (const [exit, reasonCode] of [
      [result.missingEpisodeState, "SourceEpisodeStateMissing"],
      [result.malformedEpisode, "EpisodeMalformed"],
      [result.futureEpisode, "FutureWorkRevision"],
    ] as const) {
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          _tag: "ProjectionIntegrityFailure",
          reasonCode,
          executionId: "exe_s1",
        });
      }
    }
    expect(Exit.isFailure(result.corrupted)).toBe(true);
    if (Exit.isFailure(result.corrupted)) {
      expect(Cause.squash(result.corrupted.cause)).toMatchObject({
        _tag: "ProjectionIntegrityFailure",
        reasonCode: "WorkScopeMismatch",
        executionId: "exe_s1",
        workId: W_CONS_LIVE,
      });
      expect(
        JSON.stringify(Cause.squash(result.corrupted.cause)),
      ).not.toContain("SQLite");
    }
    expect(Exit.isFailure(result.unknownVersion)).toBe(true);
    if (Exit.isFailure(result.unknownVersion)) {
      expect(Cause.squash(result.unknownVersion.cause)).toMatchObject({
        _tag: "ProjectionIntegrityFailure",
        reasonCode: "EpisodeVersionUnsupported",
        executionId: "exe_s1",
      });
    }
    expect(Exit.isFailure(result.malformedSettlement)).toBe(true);
    if (Exit.isFailure(result.malformedSettlement)) {
      expect(Cause.squash(result.malformedSettlement.cause)).toMatchObject({
        _tag: "ProjectionIntegrityFailure",
        reasonCode: "SettlementMalformed",
        executionId: "exe_s1",
      });
    }
    expect(Exit.isFailure(result.eventMismatch)).toBe(true);
    if (Exit.isFailure(result.eventMismatch)) {
      expect(Cause.squash(result.eventMismatch.cause)).toMatchObject({
        _tag: "ProjectionIntegrityFailure",
        reasonCode: "SourceEventExecutionMismatch",
        executionId: "exe_r1",
      });
    }
    expect(Exit.isFailure(result.missingExecution)).toBe(true);
    if (Exit.isFailure(result.missingExecution)) {
      expect(Cause.squash(result.missingExecution.cause)).toMatchObject({
        _tag: "ProjectionIntegrityFailure",
        reasonCode: "SourceExecutionMissing",
        executionId: "exe_missing",
      });
    }
    expect(Exit.isFailure(result.foreignExecution)).toBe(true);
    if (Exit.isFailure(result.foreignExecution)) {
      expect(Cause.squash(result.foreignExecution.cause)).toMatchObject({
        _tag: "ProjectionIntegrityFailure",
        reasonCode: "SourceProjectMismatch",
        executionId: "exe_foreign",
        workspaceId: "ws_00000000-0000-7000-8000-000000000099",
      });
    }
  });
});
