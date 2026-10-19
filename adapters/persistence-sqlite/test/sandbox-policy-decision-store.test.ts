import {
  CommandId,
  ExecutionId,
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
    version: 1 as const,
    mode: "Disabled" as const,
    destinations: [],
  },
  policyDigest: "a".repeat(64),
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
          yield* sql.unsafe(createTable);
          const transactions = yield* TransactionPortTag;
          const store = yield* SandboxPolicyDecisionStorePort;
          yield* transactions.transact(store.insertCommitted(decision));
          const exact = yield* transactions.transact(store.findExact(decision));
          expect(Option.getOrNull(exact)).toEqual(decision);
          const current = yield* transactions.transact(
            store.findCurrentForExecution(projectId, workspaceId, executionId),
          );
          expect(Option.getOrNull(current)).toEqual(decision);
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
          yield* sql.unsafe(createTable);
          const transactions = yield* TransactionPortTag;
          const store = yield* SandboxPolicyDecisionStorePort;
          yield* transactions.transact(store.insertCommitted(decision));
          yield* sql.unsafe(
            "UPDATE sandbox_policy_decisions SET network_policy_json = ? WHERE decision_command_id = ?",
            [
              '{"version":1,"mode":"Disabled","destinations":[],"extra":true}',
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
});
