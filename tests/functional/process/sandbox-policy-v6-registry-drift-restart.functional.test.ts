import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { EnvironmentResolverLocalLive } from "../../../adapters/environment-resolver-local/src/index.js";
import {
  ClockLive,
  ResourceOwnershipRepositoryLive,
  layer as sqliteLayer,
  TransactionPortLive,
  WorkspaceRepositoryLive,
  WorktreeStoreLive,
} from "../../../adapters/persistence-sqlite/src/index.js";
import { SandboxPolicyCandidateBoundaryReadPortLive } from "../../../apps/single-workspace/src/sandbox-policy-candidate-boundary-read-port.js";
import {
  SandboxPolicyCandidateBoundaryReadPort,
  TransactionPort,
} from "../../../packages/ports/src/index.js";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";
import {
  createFunctionalProject,
  functionalId,
  makePublicClient,
  waitForPublic,
} from "../support/public-client.js";
import { seedSandboxPolicyPendingAction } from "../support/sandbox-policy-pending-action-fixture.js";
import {
  sandboxPolicyV2TestPair,
  writeSandboxPolicyV2TestPair,
} from "../support/sandbox-policy-v2-source.js";

interface SandboxCandidate {
  readonly kind: string;
  readonly candidateId: string;
  readonly sandboxHandleBindingDigest: string;
}

interface CandidateRead {
  readonly commonPreconditions: {
    readonly episodeBinding: Record<string, unknown>;
    readonly expectedEpisodeRevision: number;
    readonly latestCommittedPolicyRevision: number;
    readonly workspaceRevision: number;
    readonly resourceBoundaryRevision: number;
    readonly authorityBundleRevision: number;
    readonly authorityBundleDigest: string;
    readonly operatorConfigRevision: number;
    readonly operatorConfigDigest: string;
  };
  readonly candidates: ReadonlyArray<SandboxCandidate>;
}

interface WorkspaceDetailForSandbox {
  readonly sandboxPolicyCandidateRead?: CandidateRead;
  readonly sandboxPolicy?: { readonly status?: string };
}

const child = resolve(
  "tests/functional/support/sandbox-policy-v2-daemon-child.mjs",
);
const fixtures: ProductionFixture[] = [];

const durableSandboxRead = (databaseFile: string, executionId: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    db.exec("BEGIN");
    const data = {
      lease: db
        .prepare(
          "SELECT execution_id, generation FROM execution_leases WHERE execution_id = ?",
        )
        .get(executionId),
      actions: db
        .prepare(
          `SELECT logical_action_id, state, action_index, logical_step_no,
                  repair_attempt, revision
             FROM agent_loop_step_actions WHERE execution_id = ? ORDER BY action_index`,
        )
        .all(executionId),
      step: db
        .prepare(
          `SELECT state, next_action_index, revision FROM agent_loop_steps
            WHERE execution_id = ? ORDER BY logical_step_no DESC LIMIT 1`,
        )
        .get(executionId),
      invocation: db
        .prepare(
          `SELECT invocation_id, effect_admission_state, recovery_binding_state,
                  recovery_binding_sha256, settled_at, settlement_kind
             FROM tool_invocations WHERE execution_id = ?`,
        )
        .get(executionId),
      decisions: db
        .prepare(
          `SELECT COUNT(*) AS count FROM sandbox_policy_decisions
            WHERE execution_id = ?`,
        )
        .get(executionId),
      decisionEvents: db
        .prepare(
          `SELECT COUNT(*) AS count FROM domain_events
            WHERE event_type = 'SandboxPolicyDecisionRecorded'
              AND aggregate_ref = ?`,
        )
        .get(executionId),
    };
    db.exec("COMMIT");
    return data;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
};

const readProductionBoundary = (
  databaseFile: string,
  input: { readonly projectId: string; readonly workspaceId: string },
) => {
  const infra = Layer.mergeAll(
    sqliteLayer({ filename: databaseFile }),
    ClockLive,
  );
  const resolver = Layer.provideMerge(EnvironmentResolverLocalLive, infra);
  const sources = Layer.mergeAll(
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(ResourceOwnershipRepositoryLive, infra),
    Layer.provide(WorktreeStoreLive, infra),
    resolver,
  );
  const app = Layer.mergeAll(
    infra,
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(SandboxPolicyCandidateBoundaryReadPortLive, sources),
  );
  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const tx = yield* TransactionPort;
        const boundary = yield* SandboxPolicyCandidateBoundaryReadPort;
        return yield* tx.transact(
          boundary.readCurrentForWorkspace(input as never),
        );
      }),
      app,
    ),
  );
};

const policyPayload = (input: {
  readonly read: CandidateRead;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly executionId: string;
  readonly expiresAt: string;
}) => {
  const trusted = input.read.candidates.find(
    (candidate) => candidate.kind === "TrustedLocalUnconfinedV1",
  );
  if (trusted === undefined) throw new Error("TrustedLocal candidate missing");
  return {
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    executionId: input.executionId,
    episodeBinding: input.read.commonPreconditions.episodeBinding,
    expectedEpisodeRevision:
      input.read.commonPreconditions.expectedEpisodeRevision,
    expectedPolicyRevision:
      input.read.commonPreconditions.latestCommittedPolicyRevision,
    expectedWorkspaceRevision: input.read.commonPreconditions.workspaceRevision,
    expectedResourceBoundaryRevision:
      input.read.commonPreconditions.resourceBoundaryRevision,
    expectedSandboxHandleBindingDigest: trusted.sandboxHandleBindingDigest,
    expectedAuthorityBundleRevision:
      input.read.commonPreconditions.authorityBundleRevision,
    expectedAuthorityBundleDigest:
      input.read.commonPreconditions.authorityBundleDigest,
    expectedOperatorConfigRevision:
      input.read.commonPreconditions.operatorConfigRevision,
    expectedOperatorConfigDigest:
      input.read.commonPreconditions.operatorConfigDigest,
    profile: "FullAccess",
    providerId: "TrustedLocal",
    networkPolicy: { kind: "TrustedLocalUnconfinedV1", version: 1 },
    decisionExpiresAt: input.expiresAt,
  };
};

const operatorCommand = async (
  baseUrl: string,
  projectId: string,
  commandType: string,
  payload: unknown,
) => {
  const response = await fetch(`${baseUrl}/commands`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer operator",
    },
    body: JSON.stringify({
      commandType,
      commandId: functionalId("cmd"),
      projectId,
      actor: "user:operator",
      issuedAt: new Date().toISOString(),
      payload,
    }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok)
    throw new Error(
      `${commandType} operator command failed: ${JSON.stringify(body)}`,
    );
  return body;
};

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

describe("V6-E V2 registry-only drift across daemon restart", () => {
  it("parks a previously approved TrustedLocal action before reapproval and rejects the old candidate CAS", async () => {
    let sourceFilename: string | undefined;
    const daemonEnvironment: Record<string, string> = {};
    daemonEnvironment.ARBOR_AUTH_TOKENS =
      "local=user:local,operator=user:operator";
    let providerCalls = 0;
    const fixture = await startProductionFixture({
      firstDaemonEntry: child,
      daemonEnvironment,
      reply: () => {
        providerCalls += 1;
        return { _tag: "Text", text: "unexpected provider call" };
      },
      setupProbe: async (event) => {
        if (event.stage !== "after-clone") return;
        const sourceDir = resolve(event.directory, "sandbox-policy-v2-source");
        sourceFilename = writeSandboxPolicyV2TestPair(
          sourceDir,
          sandboxPolicyV2TestPair({ bundleRevision: 1, registryRevision: 1 }),
        );
        daemonEnvironment.ARBOR_SANDBOX_AUTHORITY_SOURCE_FILE = sourceFilename;
      },
    });
    fixtures.push(fixture);
    if (sourceFilename === undefined)
      throw new Error("schema-50 V2 source fixture setup was incomplete");
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "V6 E registry drift",
    );
    const seeded = await seedSandboxPolicyPendingAction({
      databaseFilename: fixture.databaseFile,
      primaryWorktreePath: fixture.workspaceDirectory,
      projectId: project.projectId,
      workspaceId: project.rootWorkspaceId,
      sessionId: project.rootSessionId,
    });
    try {
      await readProductionBoundary(fixture.databaseFile, {
        projectId: project.projectId,
        workspaceId: project.rootWorkspaceId,
      });
    } catch (error) {
      throw new Error(`P11 candidate boundary read failed: ${String(error)}`, {
        cause: error,
      });
    }
    let initialDetail: WorkspaceDetailForSandbox;
    try {
      initialDetail = await client.view<WorkspaceDetailForSandbox>(
        "workspace-detail",
        { workspaceId: seeded.workspace },
      );
    } catch (error) {
      const audit = readFileSync(`${sourceFilename}.audit`, "utf8");
      throw new Error(`${String(error)}; V2 audit=${audit}`, { cause: error });
    }
    const initialRead = initialDetail.sandboxPolicyCandidateRead;
    if (initialRead === undefined)
      throw new Error(
        `initial candidate read missing: ${JSON.stringify(initialDetail)}`,
      );
    const beforeGrant = durableSandboxRead(
      fixture.databaseFile,
      seeded.execution,
    );
    expect(beforeGrant.lease).toBeUndefined();
    expect(beforeGrant.actions).toMatchObject([
      {
        logical_action_id: seeded.logicalActionId,
        state: "Pending",
        action_index: 0,
      },
    ]);
    expect(beforeGrant.invocation).toMatchObject({
      invocation_id: seeded.invocation,
      effect_admission_state: "NotAdmitted",
      recovery_binding_state: "Bound",
      settled_at: null,
    });

    const grantId = functionalId("pgr");
    const grantExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    await client.command(project.projectId, "GrantPermission", {
      permissionGrantId: grantId,
      issuer: "user:local",
      subject: { _tag: "HumanPrincipal", principal: "user:operator" },
      capability: "DecideSandboxPolicy",
      target: seeded.execution,
      expiresAt: grantExpiresAt,
    });
    const oldPayload = policyPayload({
      read: initialRead,
      projectId: project.projectId,
      workspaceId: seeded.workspace,
      executionId: seeded.execution,
      expiresAt: grantExpiresAt,
    });
    let approved: Record<string, unknown>;
    try {
      approved = await operatorCommand(
        fixture.baseUrl,
        project.projectId,
        "DecideSandboxPolicy",
        oldPayload,
      );
    } catch (error) {
      const db = new DatabaseSync(fixture.databaseFile, { readOnly: true });
      let commandDiagnostic: unknown;
      try {
        commandDiagnostic = {
          commands: db
            .prepare(
              `SELECT command_id, resolution, result_json,
                      terminal_error_json FROM commands ORDER BY created_at DESC LIMIT 4`,
            )
            .all(),
          attempts: db
            .prepare(
              `SELECT command_id, attempt_no, outcome, failure_kind,
                      metadata_json FROM command_attempts ORDER BY started_at DESC LIMIT 6`,
            )
            .all(),
        };
      } finally {
        db.close();
      }
      throw new Error(
        `initial P1 decision failed: ${String(error)}; daemonErrors=${JSON.stringify(fixture.daemonErrors)}; commands=${JSON.stringify(commandDiagnostic)}`,
        { cause: error },
      );
    }
    if (
      (approved.body as { readonly resolution?: string } | undefined)
        ?.resolution !== "Committed"
    )
      throw new Error(
        `initial P1 receipt was not committed: ${JSON.stringify(approved)}`,
      );
    const approvedState = durableSandboxRead(
      fixture.databaseFile,
      seeded.execution,
    );
    expect(approvedState).toMatchObject({
      decisions: { count: 1 },
      decisionEvents: { count: 1 },
    });

    const oldPid = fixture.daemonProcessSnapshot()?.pid;
    writeSandboxPolicyV2TestPair(
      resolve(fixture.directory, "sandbox-policy-v2-source"),
      sandboxPolicyV2TestPair({ bundleRevision: 2, registryRevision: 2 }),
    );
    await fixture.crash();
    await fixture.restart({ entry: child });
    expect(fixture.daemonProcessSnapshot()?.pid).not.toBe(oldPid);

    const parkedDetail = await waitForPublic(
      () =>
        client.view<WorkspaceDetailForSandbox>("workspace-detail", {
          workspaceId: seeded.workspace,
        }),
      (detail) => detail.sandboxPolicyCandidateRead !== undefined,
    );
    const refreshedRead = parkedDetail.sandboxPolicyCandidateRead;
    if (refreshedRead === undefined)
      throw new Error("refreshed candidate read missing");
    expect(refreshedRead.commonPreconditions.authorityBundleRevision).toBe(2);
    expect(refreshedRead.commonPreconditions.authorityBundleDigest).not.toBe(
      initialRead.commonPreconditions.authorityBundleDigest,
    );
    const parkedState = durableSandboxRead(
      fixture.databaseFile,
      seeded.execution,
    );
    expect(parkedState.lease).toBeUndefined();
    expect(parkedState.actions).toEqual(beforeGrant.actions);
    expect(parkedState.step).toEqual(beforeGrant.step);
    expect(parkedState.invocation).toEqual(beforeGrant.invocation);
    expect(providerCalls).toBe(0);
    expect(fixture.providerCalls).toHaveLength(0);

    const stale = await operatorCommand(
      fixture.baseUrl,
      project.projectId,
      "DecideSandboxPolicy",
      oldPayload,
    );
    expect(stale).toMatchObject({
      body: {
        resolution: "TerminalRejected",
        rejection: "StaleSandboxPolicyInputs",
      },
    });
    const afterStale = durableSandboxRead(
      fixture.databaseFile,
      seeded.execution,
    );
    expect(afterStale.decisions).toEqual(approvedState.decisions);
    expect(afterStale.decisionEvents).toEqual(approvedState.decisionEvents);
    expect(afterStale.lease).toBeUndefined();
    expect(providerCalls).toBe(0);
  }, 180_000);
});
