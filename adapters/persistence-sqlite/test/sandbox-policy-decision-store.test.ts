import { createHash } from "node:crypto";
import type {
  SandboxPolicyDecisionCommittedInternalV1,
  SandboxPolicyDecisionCommittedInternalV2,
} from "@arbor/domain";
import {
  CommandId,
  ExecutionId,
  encodeEffectivePolicySummaryV1,
  encodeEffectivePolicySummaryV2,
  encodeNetworkPolicyV1,
  encodeSandboxPolicyDecisionCommittedInternalV1,
  encodeSandboxPolicyDecisionCommittedInternalV2,
  encodeSandboxPolicyDecisionCommittedInternalV3,
  networkBrokerControlsV1ForMode,
  networkBrokerControlsV2ForMode,
  PermissionGrantId,
  ProjectId,
  parse,
  WorkspaceId,
} from "@arbor/domain";
import {
  SandboxPolicyDecisionStore as SandboxPolicyDecisionStorePort,
  TransactionPort as TransactionPortTag,
} from "@arbor/ports";
import { it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect } from "vitest";
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
  networkBrokerControls: networkBrokerControlsV1ForMode("Disabled"),
  providerRegistryRevision: 1,
  providerRegistryDigest: "c".repeat(64),
  sandboxHandleBindingDigest: "d".repeat(64),
  mounts: [
    {
      mountId: "workspace",
      targetRef: {
        version: 1 as const,
        kind: "RegionDigest" as const,
        resourceSpace: "filesystem" as const,
        regionIdentityDigest: "9".repeat(64),
      },
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
  operatorConfigDigest: summary.operatorConfigDigest,
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
  it.effect(
    "reads the exact committed Linux V2 network policy instead of reporting corruption",
    () =>
      Effect.gen(function* () {
        const networkPolicy = {
          version: 1 as const,
          mode: "Enabled" as const,
          destinations: [],
        };
        const snapshot = {
          ...summary,
          version: 2 as const,
          providerId: "linux-bwrap",
          networkPolicy,
          networkPolicyDigest: createHash("sha256")
            .update(encodeNetworkPolicyV1(networkPolicy))
            .digest("hex"),
          networkBrokerControls: networkBrokerControlsV2ForMode("Enabled"),
        };
        const v2Digest = createHash("sha256")
          .update(encodeEffectivePolicySummaryV2(snapshot))
          .digest("hex");
        const result: SandboxPolicyDecisionCommittedInternalV2 = {
          ...committedResult,
          version: 2,
          policyDigest: v2Digest,
          effectivePolicySnapshot: snapshot,
        };
        const v2Decision = {
          ...decision,
          providerId: "linux-bwrap",
          policyDigest: v2Digest,
          networkPolicy: { kind: "OsEnforced" as const, policy: networkPolicy },
        };
        const base = layer({ filename: ":memory:" });
        const app = Layer.mergeAll(
          base,
          Layer.provide(TransactionPortLive, base),
          Layer.provide(SandboxPolicyDecisionStoreLive, base),
        );
        yield* Effect.provide(
          Effect.gen(function* () {
            const sql = yield* SqlClient;
            yield* sql.unsafe(createCommands);
            yield* sql.unsafe(createTable);
            const tx = yield* TransactionPortTag;
            const store = yield* SandboxPolicyDecisionStorePort;
            yield* tx.transact(store.insertCommitted(v2Decision));
            yield* sql.unsafe(
              "INSERT INTO commands (command_id, project_id, schema_version, resolution, result_json) VALUES (?, ?, '2', 'Committed', ?)",
              [
                decisionCommandId,
                projectId,
                encodeSandboxPolicyDecisionCommittedInternalV2(result),
              ],
            );
            expect(
              Option.getOrNull(yield* tx.transact(store.findExact(v2Decision))),
            ).toEqual({ decision: v2Decision, result });
            expect(
              Option.getOrNull(
                yield* tx.transact(
                  store.findCurrentForExecution(
                    projectId,
                    workspaceId,
                    executionId,
                  ),
                ),
              ),
            ).toEqual({ decision: v2Decision, result });
            // A V2 result cannot be carried under a V1 receipt schema.
            yield* sql.unsafe("UPDATE commands SET schema_version = '1'");
            const rejected = yield* Effect.result(
              tx.transact(store.findExact(v2Decision)),
            );
            expect(rejected._tag).toBe("Failure");
          }),
          app,
        );
      }),
  );

  it.effect(
    "round-trips Workspace provenance only with an exact V3 revision and schema1 receipt",
    () =>
      Effect.gen(function* () {
        const snapshot = {
          ...summary,
          version: 2 as const,
          providerId: "linux-bwrap",
          networkBrokerControls: networkBrokerControlsV2ForMode("Disabled"),
        };
        const digest = createHash("sha256")
          .update(encodeEffectivePolicySummaryV2(snapshot))
          .digest("hex");
        const result = {
          ...committedResult,
          version: 3 as const,
          workspaceAuthorizationRevision: 1,
          policyDigest: digest,
          effectivePolicySnapshot: snapshot,
        };
        const {
          permissionGrantId: _grant,
          grantPermissionCommandId: _grantCommand,
          grantIssuerPrincipal: _issuer,
          ...fields
        } = decision;
        const modern = {
          ...fields,
          providerId: "linux-bwrap",
          authorityKind: "WorkspaceAuthorization" as const,
          workspaceAuthorizationRevision: 1,
          actorPrincipal: "system:workspace-policy" as never,
          policyDigest: digest,
        };
        const base = layer({ filename: ":memory:" });
        const app = Layer.mergeAll(
          base,
          Layer.provide(TransactionPortLive, base),
          Layer.provide(SandboxPolicyDecisionStoreLive, base),
        );
        yield* Effect.provide(
          Effect.gen(function* () {
            const sql = yield* SqlClient;
            yield* sql.unsafe(createCommands);
            yield* sql.unsafe(
              createTable
                .replace(
                  "permission_grant_id TEXT NOT NULL",
                  "permission_grant_id TEXT",
                )
                .replace(
                  "grant_permission_command_id TEXT NOT NULL",
                  "grant_permission_command_id TEXT",
                )
                .replace(
                  "grant_issuer_principal TEXT NOT NULL",
                  "grant_issuer_principal TEXT",
                ),
            );
            yield* sql.unsafe(
              "ALTER TABLE sandbox_policy_decisions ADD COLUMN authority_kind TEXT NOT NULL DEFAULT 'LegacyHumanGrant'",
            );
            yield* sql.unsafe(
              "ALTER TABLE sandbox_policy_decisions ADD COLUMN workspace_authorization_revision INTEGER",
            );
            const tx = yield* TransactionPortTag;
            const store = yield* SandboxPolicyDecisionStorePort;
            yield* tx.transact(store.insertCommitted(modern));
            yield* sql.unsafe(
              "INSERT INTO commands VALUES (?, ?, '1', 'Committed', ?)",
              [
                decisionCommandId,
                projectId,
                encodeSandboxPolicyDecisionCommittedInternalV3(result),
              ],
            );
            expect(
              Option.getOrThrow(yield* tx.transact(store.findExact(modern))),
            ).toEqual({ decision: modern, result });
            const fails = () =>
              Effect.gen(function* () {
                expect(
                  (yield* Effect.result(tx.transact(store.findExact(modern))))
                    ._tag,
                ).toBe("Failure");
              });
            yield* sql.unsafe("UPDATE commands SET schema_version = '2'");
            yield* fails();
            yield* sql.unsafe("UPDATE commands SET schema_version = '1'");
            yield* sql.unsafe(
              "UPDATE sandbox_policy_decisions SET workspace_authorization_revision = 2",
            );
            yield* fails();
            yield* sql.unsafe(
              "UPDATE sandbox_policy_decisions SET workspace_authorization_revision = 1, permission_grant_id = ?",
              [permissionGrantId],
            );
            yield* fails();
            yield* sql.unsafe(
              "UPDATE sandbox_policy_decisions SET permission_grant_id = NULL, operator_config_digest = ?",
              ["b".repeat(64)],
            );
            yield* fails();
          }),
          app,
        );
      }),
  );

  it.effect(
    "rejects Workspace writes against a legacy schema without manufacturing grant provenance",
    () =>
      Effect.gen(function* () {
        const base = layer({ filename: ":memory:" });
        const app = Layer.mergeAll(
          base,
          Layer.provide(TransactionPortLive, base),
          Layer.provide(SandboxPolicyDecisionStoreLive, base),
        );
        yield* Effect.provide(
          Effect.gen(function* () {
            const sql = yield* SqlClient;
            yield* sql.unsafe(createCommands);
            yield* sql.unsafe(createTable);
            const tx = yield* TransactionPortTag;
            const store = yield* SandboxPolicyDecisionStorePort;
            const {
              permissionGrantId: _grant,
              grantPermissionCommandId: _command,
              grantIssuerPrincipal: _issuer,
              ...fields
            } = decision;
            expect(
              (yield* Effect.result(
                tx.transact(
                  store.insertCommitted({
                    ...fields,
                    authorityKind: "WorkspaceAuthorization",
                    workspaceAuthorizationRevision: 1,
                  }),
                ),
              ))._tag,
            ).toBe("Failure");
            expect(
              yield* sql.unsafe("SELECT * FROM sandbox_policy_decisions"),
            ).toEqual([]);
          }),
          app,
        );
      }),
  );

  it.effect(
    "round-trips the exact decision key and returns the current immutable head",
    () =>
      Effect.gen(function* () {
        const base = layer({ filename: ":memory:" });
        const app = Layer.mergeAll(
          base,
          Layer.provide(TransactionPortLive, base),
          Layer.provide(SandboxPolicyDecisionStoreLive, base),
        );
        yield* Effect.provide(
          Effect.gen(function* () {
            const sql = yield* SqlClient;
            yield* sql.unsafe(createCommands);
            yield* sql.unsafe(createTable);
            const transactions = yield* TransactionPortTag;
            const store = yield* SandboxPolicyDecisionStorePort;
            yield* transactions.transact(store.insertCommitted(decision));
            yield* sql.unsafe(
              "INSERT INTO commands (command_id, project_id, schema_version, resolution, result_json) VALUES (?, ?, '2', 'Committed', ?)",
              [
                decisionCommandId,
                projectId,
                encodeSandboxPolicyDecisionCommittedInternalV1(committedResult),
              ],
            );
            const exact = yield* transactions.transact(
              store.findExact(decision),
            );
            expect(Option.getOrNull(exact)).toEqual({
              decision,
              result: committedResult,
            });
            const current = yield* transactions.transact(
              store.findCurrentForExecution(
                projectId,
                workspaceId,
                executionId,
              ),
            );
            expect(Option.getOrNull(current)).toEqual({
              decision,
              result: committedResult,
            });
          }),
          app,
        );
      }),
  );

  it.effect("fails closed on non-canonical or corrupt stored policy JSON", () =>
    Effect.gen(function* () {
      const base = layer({ filename: ":memory:" });
      const app = Layer.mergeAll(
        base,
        Layer.provide(TransactionPortLive, base),
        Layer.provide(SandboxPolicyDecisionStoreLive, base),
      );
      yield* Effect.provide(
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
      );
    }),
  );

  it.effect(
    "does not reinterpret a legacy string targetRef in a stored receipt",
    () =>
      Effect.gen(function* () {
        const base = layer({ filename: ":memory:" });
        const app = Layer.mergeAll(
          base,
          Layer.provide(TransactionPortLive, base),
          Layer.provide(SandboxPolicyDecisionStoreLive, base),
        );
        yield* Effect.provide(
          Effect.gen(function* () {
            const sql = yield* SqlClient;
            yield* sql.unsafe(createCommands);
            yield* sql.unsafe(createTable);
            const transactions = yield* TransactionPortTag;
            const store = yield* SandboxPolicyDecisionStorePort;
            yield* transactions.transact(store.insertCommitted(decision));
            const objectTargetRef =
              '"targetRef":{"version":1,"kind":"RegionDigest","resourceSpace":"filesystem","regionIdentityDigest":"' +
              "9".repeat(64) +
              '"}';
            const encoded =
              encodeSandboxPolicyDecisionCommittedInternalV1(committedResult);
            expect(encoded).toContain(objectTargetRef);
            yield* sql.unsafe(
              "INSERT INTO commands (command_id, project_id, schema_version, resolution, result_json) VALUES (?, ?, '1', 'Committed', ?)",
              [
                decisionCommandId,
                projectId,
                encoded.replace(objectTargetRef, '"targetRef":"workspace"'),
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
              throw new Error("legacy string targetRef unexpectedly decoded");
            }
          }),
          app,
        );
      }),
  );

  it.effect(
    "fails closed when the immutable row has no matching command result",
    () =>
      Effect.gen(function* () {
        const base = layer({ filename: ":memory:" });
        const app = Layer.mergeAll(
          base,
          Layer.provide(TransactionPortLive, base),
          Layer.provide(SandboxPolicyDecisionStoreLive, base),
        );
        yield* Effect.provide(
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
        );
      }),
  );
});
