import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import { durableSnapshot } from "../../support/ah-durable-snapshot.js";
import { waitForPublic } from "../../support/public-client.js";
import type { Ah7CrashContext } from "./start-fixture.js";
import {
  findExactSourceReturn,
  readEffectAttempts,
  readP4InvocationApprovalBinding,
  readReconciliationFacts,
  readTestExternalEffects,
  readToolResultForCall,
  reconciliationChild,
  waitForReconciliationSourceReturn,
} from "./support.js";

const runAh7SigkillRecovery = async (ctx: Ah7CrashContext): Promise<void> => {
  const { fixture, hit, targetExecutionId, effectFile, marker } = ctx;
  const { reconciliationMode, proofMismatch } = ctx.flags;
  if (reconciliationMode === undefined)
    throw new Error("AH7 SIGKILL recovery requires a reconciliation mode");
  mkdirSync(join(fixture.directory, "ah10-gates"), { recursive: true });
  await fixture.restart({
    entry: reconciliationChild,
    daemonEnvironment: {
      ARBOR_AH10_ROLE: "old",
      ARBOR_AH10_GATE_ACTION_KIND: "__disabled__",
      ARBOR_AH10_PAUSE_LEASE_RENEWAL: "1",
      ARBOR_AH7_TEST_RECONCILIATION_MODE: reconciliationMode,
      ARBOR_AH7_TEST_CRASH_BOUNDARY: "disabled",
      ARBOR_AH7_TEST_TRACE_RECONCILIATION_IO: "1",
      ARBOR_AH7_TEST_PAUSE_RECONCILIATION_IO: "1",
    },
  });
  const gen0SourceCall = await waitForPublic(
    async () =>
      ctx.processEvents.find(
        (event) =>
          event.boundary === "AH7ReconciliationSourceIO" &&
          event.role === "old" &&
          event.invocationId === hit?.invocationId,
      ),
    (event) => event !== undefined,
    30_000,
  );
  if (gen0SourceCall === undefined || hit?.invocationId === undefined) {
    throw new Error("AH7 old daemon did not pause inside source lookup");
  }
  const invocationId = hit.invocationId;
  const oldProcess = fixture.daemonProcessSnapshot();
  if (oldProcess?.pid === undefined || !oldProcess.alive) {
    throw new Error("AH7 old daemon PID is unavailable at source pause");
  }
  expect(oldProcess.alive).toBe(true);
  const sourcePauseDb = new DatabaseSync(fixture.databaseFile, {
    readOnly: true,
  });
  let oldLease:
    | {
        generation: number;
        worker_incarnation_id: string;
        expires_at: string;
      }
    | undefined;
  try {
    oldLease = sourcePauseDb
      .prepare(
        `SELECT generation, worker_incarnation_id, expires_at
                 FROM execution_leases WHERE execution_id = ?`,
      )
      .get(targetExecutionId) as typeof oldLease;
    expect(oldLease).toBeDefined();
    expect(readReconciliationFacts(fixture.databaseFile, invocationId)).toEqual(
      [],
    );
    expect(
      readP4InvocationApprovalBinding(
        fixture.databaseFile,
        targetExecutionId,
        invocationId,
      ),
    ).toMatchObject({
      selected_attempt_no: null,
      selected_fact_id: null,
      settlement_kind: null,
      settled_at: null,
    });
    expect(readEffectAttempts(fixture.databaseFile, invocationId)).toEqual([
      expect.objectContaining({
        attempt_no: 0,
        admission_state: "MayHaveStarted",
      }),
    ]);
    const sourceCall = sourcePauseDb
      .prepare(
        `SELECT attempt_no, role, observed_effect
                 FROM ah7_test_reconciliation_calls WHERE invocation_id = ?`,
      )
      .get(invocationId);
    expect(sourceCall).toMatchObject({
      attempt_no: 0,
      role: "old",
      observed_effect: 0,
    });
    expect(
      findExactSourceReturn(
        join(fixture.directory, "ah10-gates"),
        invocationId,
        "old",
        0,
        0,
      ),
    ).toEqual([]);
  } finally {
    sourcePauseDb.close();
  }

  await fixture.crash();
  const killedProcess = fixture.daemonProcessSnapshot();
  expect(killedProcess).toMatchObject({
    pid: oldProcess.pid,
    alive: false,
  });
  if (process.platform !== "win32") {
    expect(killedProcess?.signalCode).toBe("SIGKILL");
  }
  expect(readReconciliationFacts(fixture.databaseFile, invocationId)).toEqual(
    [],
  );
  expect(
    readP4InvocationApprovalBinding(
      fixture.databaseFile,
      targetExecutionId,
      invocationId,
    ),
  ).toMatchObject({
    selected_attempt_no: null,
    selected_fact_id: null,
    settlement_kind: null,
    settled_at: null,
  });
  expect(readEffectAttempts(fixture.databaseFile, invocationId)).toEqual([
    expect.objectContaining({
      attempt_no: 0,
      admission_state: "MayHaveStarted",
    }),
  ]);

  const oldLeaseExpiry = Date.parse(oldLease?.expires_at ?? "");
  if (!Number.isFinite(oldLeaseExpiry)) {
    throw new Error("AH7 old source-lookup lease expiry is invalid");
  }
  await waitForPublic(
    async () => Date.now(),
    (now) => now >= oldLeaseExpiry,
    Math.max(30_000, oldLeaseExpiry - Date.now() + 10_000),
  );
  await fixture.restart({
    entry: reconciliationChild,
    daemonEnvironment: {
      ARBOR_AH10_ROLE: "new",
      ARBOR_AH10_GATE_ACTION_KIND: "__disabled__",
      ARBOR_AH7_TEST_RECONCILIATION_MODE: reconciliationMode,
      ...(proofMismatch === undefined
        ? {}
        : { ARBOR_AH7_TEST_PROOF_MISMATCH: proofMismatch }),
      ARBOR_AH7_TEST_CRASH_BOUNDARY: "disabled",
      ARBOR_AH7_TEST_TRACE_RECONCILIATION_IO: "1",
    },
  });
  const gen1Lease = await waitForPublic(
    async () =>
      ctx.processEvents.find(
        (event) =>
          event.boundary === "AH10AfterLeaseAcquired" &&
          event.role === "new" &&
          event.executionId === targetExecutionId,
      ),
    (event) => event !== undefined,
    45_000,
  );
  expect(gen1Lease?.fencingGeneration).toBe(Number(oldLease?.generation) + 1);
  const gen1SourceCall = await waitForPublic(
    async () =>
      ctx.processEvents.find(
        (event) =>
          event.boundary === "AH7ReconciliationSourceIO" &&
          event.role === "new" &&
          event.invocationId === invocationId,
      ),
    (event) => event !== undefined,
    30_000,
  );
  expect(gen1SourceCall).toMatchObject({
    attemptNo: 0,
    observedEffect: 0,
  });
  const recoveredAfterKill = await waitForPublic(
    async () => durableSnapshot(fixture.databaseFile),
    (value) =>
      value.toolInvocations.some(
        (invocation) =>
          invocation.invocation_id === invocationId &&
          invocation.settlement_kind === "Success",
      ) &&
      value.actions.some(
        (action) =>
          action.execution_id === targetExecutionId &&
          action.call_ref === hit?.callRef &&
          action.state === "Applied",
      ),
    45_000,
  );
  const recoveredBinding = readP4InvocationApprovalBinding(
    fixture.databaseFile,
    targetExecutionId,
    invocationId,
  );
  const recoveredFacts = readReconciliationFacts(
    fixture.databaseFile,
    invocationId,
  );
  const recoveredAttempts = readEffectAttempts(
    fixture.databaseFile,
    invocationId,
  );
  expect(recoveredFacts).toHaveLength(1);
  expect(recoveredFacts[0]).toMatchObject({
    attempt_no: 0,
    outcome: "NotOccurred",
    fact_disposition: "RecoveryInput",
  });
  expect(recoveredBinding).toMatchObject({
    selected_attempt_no: null,
    selected_fact_id: null,
    settlement_kind: "Success",
    settlement_provenance: "Ordinary",
    observation_format_version: "p4-canonical-tool-observation-v1",
    observation_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
  });
  expect(recoveredAttempts.map((attempt) => attempt.attempt_no)).toEqual([
    0, 1,
  ]);
  expect(recoveredAttempts[0]?.effect_key).toBe(
    recoveredAttempts[1]?.effect_key,
  );
  expect(recoveredAttempts[0]?.binding_sha256).toBe(
    recoveredAttempts[1]?.binding_sha256,
  );
  expect(recoveredAttempts[0]?.profile_id).toBe(
    recoveredAttempts[1]?.profile_id,
  );
  expect(recoveredAttempts[0]?.profile_version).toBe(
    recoveredAttempts[1]?.profile_version,
  );
  expect(recoveredAttempts[0]?.profile_hash).toBe(
    recoveredAttempts[1]?.profile_hash,
  );
  expect(readTestExternalEffects(fixture.databaseFile)).toEqual([
    expect.objectContaining({
      effect_key: `ah7-test:${invocationId}`,
    }),
  ]);
  expect(
    readFileSync(join(fixture.workspaceDirectory, effectFile), "utf8")
      .split(/\r?\n/u)
      .filter((line) => line === marker),
  ).toHaveLength(1);
  expect(
    recoveredAfterKill.toolResults.filter(
      (row) => readToolResultForCall([row], hit?.callRef ?? "") !== undefined,
    ),
  ).toHaveLength(1);
  expect(
    recoveredAfterKill.actions.filter(
      (action) =>
        action.execution_id === targetExecutionId &&
        action.call_ref === hit?.callRef,
    ),
  ).toHaveLength(1);
  await waitForReconciliationSourceReturn(
    join(fixture.directory, "ah10-gates"),
    fixture.databaseFile,
    invocationId,
    "new",
    0,
    0,
  );
  const callsAfterRestartDb = new DatabaseSync(fixture.databaseFile, {
    readOnly: true,
  });
  try {
    const calls = callsAfterRestartDb
      .prepare(
        `SELECT attempt_no, role, observed_effect
                 FROM ah7_test_reconciliation_calls WHERE invocation_id = ?
                ORDER BY call_no`,
      )
      .all(invocationId);
    expect(calls).toEqual([
      expect.objectContaining({
        attempt_no: 0,
        role: "old",
        observed_effect: 0,
      }),
      expect.objectContaining({
        attempt_no: 0,
        role: "new",
        observed_effect: 0,
      }),
    ]);
  } finally {
    callsAfterRestartDb.close();
  }
  expect(fixture.daemonProcessSnapshot()?.alive).toBe(true);
  expect(fixture.daemonProcessSnapshot()?.pid).not.toBe(oldProcess.pid);
  expect(fixture.daemonErrors).toEqual([]);
};

import { describe, it, vi } from "vitest";
import { assertAh7Recovered } from "./assert-recovered.js";
import { convergeAh7Recovery } from "./converge.js";
import {
  admitAh7WorkAndApproveShell,
  reachAh7BoundaryAndCrash,
} from "./drive-to-crash.js";
import { ah7FamilyScenarios, ah7ScenarioTestName } from "./scenarios.js";
import { startAh7Fixture } from "./start-fixture.js";
import { createAh7FixtureLifecycle } from "./support.js";

const lifecycle = createAh7FixtureLifecycle();

describe("AH7 Reconcilable tool intent after process crash", () => {
  vi.setConfig({ testTimeout: 180_000 });
  for (const scenario of ah7FamilyScenarios("sigkill-recovery")) {
    it(ah7ScenarioTestName(scenario), async () => {
      const setupCtx = await startAh7Fixture(scenario, lifecycle);
      const admittedCtx = await admitAh7WorkAndApproveShell(setupCtx);
      const crashCtx = await reachAh7BoundaryAndCrash(admittedCtx);
      await runAh7SigkillRecovery(crashCtx);
      const recoveredCtx = await convergeAh7Recovery(crashCtx);
      await assertAh7Recovered(recoveredCtx);
    });
  }
});
