import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { parse, WorkId, WorkspaceId } from "../packages/domain/dist/index.js";
import type {
  AttentionFacts,
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
        workspaceId: p10Child,
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
        workspaceId: p10Child,
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
          targetWorkspaceId: p10Child,
          dedupKey: "safety-stop:exe_s1",
        });

        const escalation = rowsOf("ReconciliationEscalated", rows);
        expect(escalation).toHaveLength(1);
        expect(escalation[0]).toMatchObject({
          severity: "ActionRequired",
          targetWorkspaceId: p10Child,
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
});
