import {
  Actor,
  ExecutionId,
  Principal,
  ProjectId,
  parse,
  SessionId,
  ToolInvocationId,
  WorkspaceId,
} from "@arbor/domain";
import type {
  InvocationApproval,
  ToolDefinition,
  ToolExecutionContext,
  ToolIntent,
} from "@arbor/ports";
import { ToolInvocationStore, TransactionPort } from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  actionDigestOf,
  matchApproval,
} from "../../../packages/tool-runtime/src/index.js";
import {
  layer,
  P4_MIGRATIONS,
  runMigrations,
  ToolInvocationStoreLive,
  TransactionPortLive,
} from "../src/index.js";

const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const principal = parse(Principal)("worker:a");
const actor = parse(Actor)("worker:a");
const invocationId = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789a1",
);

const definition: ToolDefinition = {
  name: "shell",
  version: "1",
  hash: "shell-v1",
  description: "shell",
  inputSchemaJson: "{}",
  resultSchemaJson: "{}",
  capabilityMetadata: ["shell:exec"],
  sideEffectSemantics: "Reconcilable",
  source: "Builtin",
};
const intent: ToolIntent = {
  callRef: "c",
  toolName: "shell",
  toolVersion: "1",
  argumentsJson: '{"command":"ls"}',
  invocationId,
  approvalId: null,
};
const context = {
  executionId,
  workspaceId,
  sessionId,
  projectId,
  actor,
  authenticatedPrincipal: principal,
  authority: {
    principal,
    workspaceId,
    executionId,
    toolName: "shell",
    toolVersion: "1",
    resourceSpaceIds: ["filesystem"],
    allowedCapabilities: ["shell:exec"],
    controlBasisDigest: "d",
    expiresAt: "2999-01-01T00:00:00.000Z",
    delegationDepth: 0,
  },
  controlBasisDigest: "d",
  requestedAt: "t",
} as ToolExecutionContext;

const approval: InvocationApproval = {
  approvalId: "apr_1",
  toolName: "shell",
  toolVersion: "1",
  actionDigest: actionDigestOf(intent),
  targetResourceSpaceIds: ["filesystem"],
  controlBasisDigest: "d",
  expiresAt: "2999-01-01T00:00:00.000Z",
  consumedBy: null,
};
const regions = [{ resourceSpaceId: "filesystem", normalizedRegion: {} }];

const makeApp = () => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base);
  return Layer.mergeAll(
    infra,
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(ToolInvocationStoreLive, infra),
  );
};

describe("P4 InvocationApproval", () => {
  it("matches an exact intent and denies mismatch/expiry/consumed", () => {
    expect(
      matchApproval({
        approval,
        intent,
        definition,
        context,
        regions,
        now: "2026-01-01T00:00:00.000Z",
      })._tag,
    ).toBe("Ok");
    expect(
      matchApproval({
        approval: { ...approval, actionDigest: "x" },
        intent,
        definition,
        context,
        regions,
        now: "2026-01-01T00:00:00.000Z",
      })._tag,
    ).toBe("Denied");
    expect(
      matchApproval({
        approval: { ...approval, expiresAt: "2000-01-01T00:00:00.000Z" },
        intent,
        definition,
        context,
        regions,
        now: "2026-01-01T00:00:00.000Z",
      })._tag,
    ).toBe("Denied");
    expect(
      matchApproval({
        approval: { ...approval, consumedBy: invocationId },
        intent,
        definition,
        context,
        regions,
        now: "2026-01-01T00:00:00.000Z",
      })._tag,
    ).toBe("Denied");
  });

  it("consumes an approval atomically at most once", async () => {
    const app = makeApp();
    const program = Effect.gen(function* () {
      yield* runMigrations(P4_MIGRATIONS);
      const sql = yield* SqlClient;
      yield* sql.unsafe(
        "INSERT INTO invocation_approvals (approval_id, tool_name, tool_version, action_digest, target_resource_space_ids_json, control_basis_digest, expires_at, consumed_by) VALUES (?,?,?,?,?,?,?,NULL)",
        [
          approval.approvalId,
          approval.toolName,
          approval.toolVersion,
          approval.actionDigest,
          JSON.stringify(approval.targetResourceSpaceIds),
          approval.controlBasisDigest,
          approval.expiresAt,
        ],
      );
      const tx = yield* TransactionPort;
      const store = yield* ToolInvocationStore;
      const first = yield* tx.transact(
        store.consumeApproval("apr_1", invocationId),
      );
      const second = yield* tx.transact(
        store.consumeApproval("apr_1", invocationId),
      );
      const found = yield* tx.transact(store.findApproval("apr_1"));
      return { first, second, found };
    });
    const r = await Effect.runPromise(
      Effect.provide(program, app) as Effect.Effect<unknown, unknown, never>,
    );
    expect((r as { first: boolean }).first).toBe(true);
    expect((r as { second: boolean }).second).toBe(false);
    expect((r as { found: { _tag: string } }).found._tag).toBe("Some");
  });
});
