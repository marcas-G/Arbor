import { createHash } from "node:crypto";
import type { SandboxPolicyDecisionCommittedInternalV1 } from "@arbor/domain";
import {
  CommandId,
  ExecutionId,
  encodeEffectivePolicySummaryV1,
  encodeNetworkPolicyV1,
  encodeSandboxPolicyDecisionCommittedInternalV1,
  PermissionGrantId,
  ProjectId,
  parse,
  WorkspaceId,
} from "@arbor/domain";
import {
  SandboxPolicyDecisionStore as SandboxPolicyDecisionStorePort,
  TransactionPort as TransactionPortTag,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { layer } from "../src/client.js";
import { SandboxPolicyDecisionStoreLive } from "../src/sandbox-policy-decision-store.js";
import { TransactionPortLive } from "../src/transaction.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const permissionGrantId = parse(PermissionGrantId)(
  "pgr_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const grantPermissionCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const decisionCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789a2",
);
const episodeBinding = {
  _tag: "InboxEpisode" as const,
  entryKey: "entry:one",
  inputKind: "HumanMessage",
};
const summary = {
  version: 1 as const,
  kind: "OsEnforced" as const,
  projectId,
  workspaceId,
  executionId,
  episodeBinding,
  workspaceRevision: 1,
  resourceBoundaryRevision: 1,
  resourceBoundaryDigest: "a".repeat(64),
  sandboxEnvironmentBasisDigest: "b".repeat(64),
  policyRevision: 1,
  expiresAt: "2026-10-20T00:00:00.000Z",
  profile: "ReadOnly" as const,
  providerId: "bwrap",
  providerVersion: "0.8.0",
  capabilityRevision: 1,
  osFamily: "Linux" as const,
  osBuild: "linux-6.8",
  qualificationEvidenceRef: `blob:sha256:${"1".repeat(64)}`,
  networkPolicy: {
    version: 1 as const,
    mode: "Disabled" as const,
    destinations: [],
  },
  networkPolicyDigest: createHash("sha256")
    .update(
      encodeNetworkPolicyV1({ version: 1, mode: "Disabled", destinations: [] }),
    )
    .digest("hex"),
  networkBrokerControls: {
    version: 1 as const,
    egress: "BrokerOnly" as const,
    dns: "BrokerResolveAndPin" as const,
    addressPolicy: "SandboxPublicInternetDenyV1" as const,
    redirectMaxHops: 5 as const,
    tlsIdentity: "OriginCertificateSniHostMatch" as const,
  },
  providerRegistryRevision: 1,
  providerRegistryDigest: "c".repeat(64),
  sandboxHandleBindingDigest: "d".repeat(64),
  mounts: [
    {
      mountId: "workspace",
      targetRef: "workspace",
      targetIdentityDigest: "e".repeat(64),
      access: "ReadOnly" as const,
    },
  ],
  environmentAllowlist: ["PATH"],
  limits: {
    wallTimeMs: 1000,
    stdoutBytes: 1000,
    stderrBytes: 1000,
    processCount: 1,
    memoryBytes: 1024,
    cpuTimeMs: 1000,
  },
  auditRefs: ["audit:one"],
  authorityBundleRevision: 1,
  authorityBundleDigest: "f".repeat(64),
  operatorConfigRevision: 1,
  operatorConfigDigest: "0".repeat(64),
};
const policyDigest = createHash("sha256")
  .update(encodeEffectivePolicySummaryV1(summary))
  .digest("hex");
const committedResult: SandboxPolicyDecisionCommittedInternalV1 = {
  version: 1,
  commandId: decisionCommandId,
  projectId,
  workspaceId,
  executionId,
  episodeBinding,
  policyRevision: 1,
  policyDigest,
  effectivePolicySnapshot: summary,
};
const decision = {
  projectId,
  workspaceId,
  executionId,
  episodeBinding,
  policyRevision: 1,
  expectedExecutionRevision: 1,
  expectedPolicyRevision: 0,
  profile: "ReadOnly" as const,
  providerId: "bwrap",
  networkPolicy: {
    kind: "OsEnforced" as const,
    policy: {
      version: 1 as const,
      mode: "Disabled" as const,
      destinations: [],
    },
  },
  policyDigest,
  permissionGrantId,
  grantPermissionCommandId,
  grantIssuerPrincipal: "user:operator" as never,
  operatorConfigRevision: 1,
  operatorConfigDigest: "b".repeat(64),
  actorPrincipal: "user:subject" as never,
  decisionCommandId,
  issuedAt: "2026-10-19T00:00:00.000Z",
  expiresAt: "2026-10-20T00:00:00.000Z",
};

const createTable = `CREATE TABLE sandbox_policy_decisions (
  project_id TEXT NOT NULL, workspace_id TEXT NOT NULL, execution_id TEXT NOT NULL,
  episode_binding_json TEXT NOT NULL, policy_revision INTEGER NOT NULL,
  expected_execution_revision INTEGER NOT NULL, expected_policy_revision INTEGER NOT NULL,
  profile_id TEXT NOT NULL, provider_id TEXT NOT NULL, network_policy_json TEXT NOT NULL,
  policy_digest TEXT NOT NULL, permission_grant_id TEXT NOT NULL,
  grant_permission_command_id TEXT NOT NULL, grant_issuer_principal TEXT NOT NULL,
  operator_config_revision INTEGER NOT NULL, operator_config_digest TEXT NOT NULL,
  actor_principal TEXT NOT NULL, decision_command_id TEXT NOT NULL,
  issued_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  PRIMARY KEY (project_id, workspace_id, execution_id, episode_binding_json, policy_revision)
)`;
const createCommands = `CREATE TABLE commands (
  command_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, schema_version TEXT NOT NULL,
  resolution TEXT NOT NULL, result_json TEXT
)`;

describe("SandboxPolicyDecisionStore", () => {
  it("round-trips the exact decision key and returns the current immutable head", async () => {
    const base = layer({ filename: ":memory:" });
    const app = Layer.mergeAll(
      base,
      Layer.provide(TransactionPortLive, base),
      Layer.provide(SandboxPolicyDecisionStoreLive, base),
    );
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* sql.unsafe(createCommands);
          yield* sql.unsafe(createTable);
          const transactions = yield* TransactionPortTag;
          const store = yield* SandboxPolicyDecisionStorePort;
          yield* transactions.transact(store.insertCommitted(decision));
          yield* sql.unsafe(
            "INSERT INTO commands (command_id, project_id, schema_version, resolution, result_json) VALUES (?, ?, '1', 'Committed', ?)",
            [
              decisionCommandId,
              projectId,
              encodeSandboxPolicyDecisionCommittedInternalV1(committedResult),
            ],
          );
          const exact = yield* transactions.transact(store.findExact(decision));
          expect(Option.getOrNull(exact)).toEqual({
            decision,
            result: committedResult,
          });
          const current = yield* transactions.transact(
            store.findCurrentForExecution(projectId, workspaceId, executionId),
          );
          expect(Option.getOrNull(current)).toEqual({
            decision,
            result: committedResult,
          });
        }),
        app,
      ),
    );
  });

  it("fails closed on non-canonical or corrupt stored policy JSON", async () => {
    const base = layer({ filename: ":memory:" });
    const app = Layer.mergeAll(
      base,
      Layer.provide(TransactionPortLive, base),
      Layer.provide(SandboxPolicyDecisionStoreLive, base),
    );
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* sql.unsafe(createCommands);
          yield* sql.unsafe(createTable);
          const transactions = yield* TransactionPortTag;
          const store = yield* SandboxPolicyDecisionStorePort;
          yield* transactions.transact(store.insertCommitted(decision));
          yield* sql.unsafe(
            "INSERT INTO commands (command_id, project_id, schema_version, resolution, result_json) VALUES (?, ?, '1', 'Committed', ?)",
            [
              decisionCommandId,
              projectId,
              encodeSandboxPolicyDecisionCommittedInternalV1(committedResult),
            ],
          );
          yield* sql.unsafe(
            "UPDATE sandbox_policy_decisions SET network_policy_json = ? WHERE decision_command_id = ?",
            [
              '{"kind":"OsEnforced","policy":{"version":1,"mode":"Disabled","destinations":[],"extra":true}}',
              decisionCommandId,
            ],
          );
          const outcome = yield* Effect.match(
            transactions.transact(
              store.findCurrentForExecution(
                projectId,
                workspaceId,
                executionId,
              ),
            ),
            {
              onFailure: (error) => ({ _tag: "Left" as const, error }),
              onSuccess: (value) => ({ _tag: "Right" as const, value }),
            },
          );
          if (outcome._tag === "Left") {
            expect(outcome.error).toMatchObject({
              _tag: "PersistenceCorruption",
              repository: "SandboxPolicyDecisionStore",
              operation: "find-current-for-execution",
            });
          } else {
            throw new Error("corrupt decision unexpectedly decoded");
          }
        }),
        app,
      ),
    );
  });

  it("fails closed when the immutable row has no matching command result", async () => {
    const base = layer({ filename: ":memory:" });
    const app = Layer.mergeAll(
      base,
      Layer.provide(TransactionPortLive, base),
      Layer.provide(SandboxPolicyDecisionStoreLive, base),
    );
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* sql.unsafe(createCommands);
          yield* sql.unsafe(createTable);
          const transactions = yield* TransactionPortTag;
          const store = yield* SandboxPolicyDecisionStorePort;
          yield* transactions.transact(store.insertCommitted(decision));
          yield* sql.unsafe(
            "INSERT INTO commands (command_id, project_id, schema_version, resolution, result_json) VALUES (?, ?, '1', 'Committed', ?)",
            [decisionCommandId, projectId, "{}"],
          );
          const outcome = yield* Effect.match(
            transactions.transact(
              store.findCurrentForExecution(
                projectId,
                workspaceId,
                executionId,
              ),
            ),
            {
              onFailure: (error) => ({ _tag: "Left" as const, error }),
              onSuccess: (value) => ({ _tag: "Right" as const, value }),
            },
          );
          expect(outcome._tag).toBe("Left");
          if (outcome._tag === "Left") {
            expect(outcome.error).toMatchObject({
              _tag: "PersistenceCorruption",
              repository: "SandboxPolicyDecisionStore",
              operation: "find-current-for-execution",
            });
          }
        }),
        app,
      ),
    );
  });
});
