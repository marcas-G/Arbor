import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect } from "vitest";
import {
  SANDBOX_ENV_ALLOWLIST,
  sandboxEnvironment,
} from "../../adapters/sandbox-local/dist/index.js";
import { SecretEnvLive } from "../../adapters/secret-env/dist/index.js";
import {
  admitExecution,
  buildSingleWorkspaceLayer,
  evaluateAndSelect,
} from "../../apps/single-workspace/src/index.js";
import {
  type AssignWorkPayload,
  CommandGateway,
  type CreateProjectPayload,
  type GatewayEnvelope,
  semanticRequestFingerprint,
  type VerifiedCommandAuthority,
} from "../../packages/application/dist/index.js";
import {
  Actor,
  CommandId,
  type CommandSubmissionContext,
  ContextEpochNumber,
  ExecutionId,
  makeProjectPolicy,
  makeWorkspacePolicy,
  Principal,
  ProjectId,
  parse,
  ResourceBoundaryRevision,
  ResponsibilityRevision,
  Revision,
  responsibilityBound,
  SessionId,
  WorkId,
  WorkRevision,
  WorkspaceId,
} from "../../packages/domain/dist/index.js";
import { runExecution } from "../../packages/execution-runtime/src/index.js";
import {
  ResourceOwnershipRepository,
  type SecretMaterial,
  type SecretStoreError,
  SecretStorePort,
  secretRef,
  TransactionPort,
} from "../../packages/ports/dist/index.js";
import {
  createSchema44CaseDatabase,
  itWithCurrentAppTimeout,
} from "./support.js";

// ---------------------------------------------------------------------------
// story 4 (`03`): SecretStorePort resolves a SecretRef; no material leaks
// ---------------------------------------------------------------------------

const secretProjectId = parse(ProjectId)(
  "prj_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const secretWorkspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const secretSessionId = parse(SessionId)(
  "ses_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const secretWorkId = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789ab");
const secretPrincipal = parse(Principal)("user:test");
const secretContext: CommandSubmissionContext = {
  _tag: "System",
  principal: secretPrincipal,
  causationRef: "c",
};
const secretDefinition = {
  purpose: "p",
  ownedResponsibilities: [],
  obligations: [],
  includes: [],
  excludes: [],
  interfaces: [],
};
const secretProjectPayload = (): CreateProjectPayload => ({
  name: "Arbor",
  revision: parse(Revision)(0),
  projectPolicy: makeProjectPolicy(),
  projectPolicyRevision: parse(Revision)(0),
  defaultConfiguration: {},
  environmentRef: "local",
  rootWorkspaceId: secretWorkspaceId,
  primarySession: {
    sessionId: secretSessionId,
    contextEpoch: parse(ContextEpochNumber)(0),
  },
  rootWorkspace: {
    name: "root",
    responsibilityDefinition: secretDefinition,
    responsibilityRevision: parse(ResponsibilityRevision)(0),
    resourceSelection: { _tag: "ConversationOnly" },
    agentBinding: responsibilityBound(secretWorkspaceId),
    workspacePolicy: makeWorkspacePolicy(),
    workspacePolicyRevision: parse(Revision)(0),
    revision: parse(Revision)(0),
  },
});
const secretWorkPayload = (): AssignWorkPayload => ({
  workId: secretWorkId,
  workspaceId: secretWorkspaceId,
  expectedWorkspaceRevision: parse(Revision)(0),
  objective: "ship the slice",
  why: "P12-013",
  constraints: [],
  completionExpectation: "done",
  verificationMission: {
    goal: "g",
    criteria: [
      {
        criterionId: "runtime-safety-proof",
        requirement: "the runtime safety result is observable",
        required: true,
      },
    ],
    riskRequirements: [],
  },
  provenance: { predecessorWorkId: null, reason: "initial" },
  revision: parse(WorkRevision)(0),
});
const secretEnvelope = <P>(
  commandType: string,
  payload: P,
  suffix: string,
): GatewayEnvelope<P> => ({
  commandType,
  commandId: parse(CommandId)(
    `cmd_018f2b3c-4d5e-7abc-8def-0123456789a${suffix}`,
  ),
  projectId: secretProjectId,
  actor: parse(Actor)("user:test"),
  issuedAt: "t",
  payload,
});
const secretAuthority = (
  tag: "CreateProjectAuthority" | "AssignWorkAuthority",
  payload: CreateProjectPayload | AssignWorkPayload,
  suffix: string,
): VerifiedCommandAuthority =>
  ({
    _tag: tag,
    principal: secretPrincipal,
    commandId: parse(CommandId)(
      `cmd_018f2b3c-4d5e-7abc-8def-0123456789a${suffix}`,
    ),
    semanticRequestFingerprint: semanticRequestFingerprint({
      commandType:
        tag === "CreateProjectAuthority" ? "CreateProject" : "AssignWork",
      projectId: secretProjectId,
      actor: parse(Actor)("user:test"),
      schemaVersion: tag === "CreateProjectAuthority" ? "2" : "1",
      payload,
    }),
    projectId: secretProjectId,
    ...(tag === "AssignWorkAuthority"
      ? { targetWorkspaceId: secretWorkspaceId }
      : {}),
  }) as VerifiedCommandAuthority;

describe("-acceptance story 4 — secret store + no-leak invariant", () => {
  itWithCurrentAppTimeout(
    "story 4: a resolved SecretRef is redacted and never reaches any durable/observable surface",
    async () => {
      const store = SecretEnvLive({
        ambient: { PROVIDER_KEY: "env-secret", OLD_KEY: "stale" },
        expiries: { OLD_KEY: "2000-01-01T00:00:00.000Z" },
      });
      const adapter = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const port = yield* SecretStorePort;
            const ok = yield* port.resolve(secretRef("PROVIDER_KEY"));
            const missing = yield* Effect.flip(
              port.resolve(secretRef("ABSENT")),
            );
            const expired = yield* Effect.flip(
              port.resolve(secretRef("OLD_KEY")),
            );
            return { ok, missing, expired };
          }),
          store,
        ) as Effect.Effect<
          {
            ok: SecretMaterial;
            missing: SecretStoreError;
            expired: SecretStoreError;
          },
          unknown,
          never
        >,
      );
      expect(adapter.ok.reveal()).toBe("env-secret");
      expect(JSON.stringify({ material: adapter.ok })).toBe(
        '{"material":"[REDACTED]"}',
      );
      expect(String(adapter.ok)).toBe("[REDACTED]");
      expect(adapter.missing._tag).toBe("SecretNotFound");
      expect(adapter.expired._tag).toBe("SecretExpired");

      const sentinelKey = `SENTINEL_SECRET_${randomUUID().replace(/-/g, "")}`;
      const projected = sandboxEnvironment({
        PATH: "/usr/bin:/bin",
        HOME: "/home/op",
        [sentinelKey]: "must-not-leak",
      });
      expect(sentinelKey in projected).toBe(false);
      expect(
        Object.keys(projected).every((key) =>
          SANDBOX_ENV_ALLOWLIST.includes(key),
        ),
      ).toBe(true);

      // end-to-end: a sentinel secret resolved during a real slice run never
      // appears in any SQLite table or stdout/stderr
      const sentinelEnv = `SENTINEL_SECRET_${randomUUID().replace(/-/g, "")}`;
      const sentinelValue = `sentinel-value-${randomUUID()}`;
      process.env[sentinelEnv] = sentinelValue;
      const database = createSchema44CaseDatabase();
      const app = buildSingleWorkspaceLayer({
        databaseFile: database.databaseFilename,
        providerTurns: [
          [
            {
              _tag: "ToolCallProposed",
              callRef: "c1",
              toolName: "wait",
              argumentsJson: JSON.stringify({
                reason: "secret-store sentinel completion",
                waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
              }),
            },
            { _tag: "TurnCompleted", finishReason: "ToolCall" },
          ],
        ],
        secretRef: secretRef(sentinelEnv),
      });

      const captured: string[] = [];
      const origOut = process.stdout.write.bind(process.stdout);
      const origErr = process.stderr.write.bind(process.stderr);
      const capture =
        (orig: typeof origOut) =>
        (chunk: unknown, ...args: ReadonlyArray<unknown>) => {
          captured.push(typeof chunk === "string" ? chunk : String(chunk));
          return (orig as (...a: ReadonlyArray<unknown>) => boolean)(
            chunk,
            ...args,
          );
        };
      process.stdout.write = capture(origOut) as typeof process.stdout.write;
      process.stderr.write = capture(origErr) as typeof process.stderr.write;

      let allRows = "";
      let settlement = "";
      try {
        const result = await Effect.runPromise(
          Effect.provide(
            Effect.gen(function* () {
              const gateway = yield* CommandGateway;
              yield* gateway.execute(
                secretEnvelope("CreateProject", secretProjectPayload(), "1"),
                secretContext,
                secretAuthority(
                  "CreateProjectAuthority",
                  secretProjectPayload(),
                  "1",
                ),
              );
              yield* gateway.execute(
                secretEnvelope("AssignWork", secretWorkPayload(), "2"),
                secretContext,
                secretAuthority(
                  "AssignWorkAuthority",
                  secretWorkPayload(),
                  "2",
                ),
              );
              const ownership = yield* ResourceOwnershipRepository;
              const tx0 = yield* TransactionPort;
              yield* tx0.transact(
                ownership.insertClaim({
                  claimId: "roc_018f2b3c-4d5e-7abc-8def-0123456789a1",
                  workspaceId: secretWorkspaceId,
                  region: {
                    resourceSpaceId: "filesystem",
                    normalizedRegion: { kind: "FileTree", path: "." },
                  },
                  sourceAddressSnapshot: { _tag: "FileTree", path: "." },
                  resourceBoundaryRevision: parse(ResourceBoundaryRevision)(0),
                  resolvedAtEnvironmentRevision: "local",
                  createdAt: "t",
                  releasedAt: null,
                }),
              );
              yield* evaluateAndSelect(secretWorkspaceId, secretPrincipal, {
                _tag: "WorkSelected",
              });
              yield* admitExecution(
                secretWorkspaceId,
                parse(ExecutionId)("exe_018f2b3c-4d5e-7abc-8def-0123456789a1"),
                { _tag: "Work", workId: secretWorkId },
                secretPrincipal,
              );
              const settled = yield* runExecution(
                parse(ExecutionId)("exe_018f2b3c-4d5e-7abc-8def-0123456789a1"),
                { _tag: "WorkSelected" },
                secretPrincipal,
              );
              const sql = yield* SqlClient;
              const tables = yield* sql.unsafe<{ name: string }>(
                "SELECT name FROM sqlite_master WHERE type = 'table'",
              );
              let dump = "";
              for (const table of tables) {
                if (table.name.startsWith("sqlite_")) {
                  continue;
                }
                const rows = yield* sql.unsafe(`SELECT * FROM "${table.name}"`);
                dump += JSON.stringify(rows);
              }
              return { dump, settlement: settled._tag };
            }),
            app,
          ) as unknown as Effect.Effect<
            { dump: string; settlement: string },
            unknown,
            never
          >,
        );
        allRows = result.dump;
        settlement = result.settlement;
      } finally {
        process.stdout.write = origOut as typeof process.stdout.write;
        process.stderr.write = origErr as typeof process.stderr.write;
        delete process.env[sentinelEnv];
        database.cleanup();
      }

      expect(settlement).toBe("Completed");
      expect(allRows).not.toContain(sentinelValue);
      expect(captured.join("")).not.toContain(sentinelValue);
      expect(captured.join("")).not.toContain(sentinelEnv);
    },
  );
});
