import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  SANDBOX_ENV_ALLOWLIST,
  sandboxEnvironment,
} from "../adapters/sandbox-local/dist/index.js";
import { SecretEnvLive } from "../adapters/secret-env/dist/index.js";
import { SecretFileLive } from "../adapters/secret-file/dist/index.js";
import {
  admitExecution,
  buildSliceLayer,
  evaluateAndSelect,
  P7_MIGRATIONS,
  runMigrations,
} from "../apps/single-workspace/src/index.js";
import {
  type AssignWorkPayload,
  CommandGateway,
  type CreateProjectPayload,
  type GatewayEnvelope,
  semanticRequestFingerprint,
  type VerifiedCommandAuthority,
} from "../packages/application/dist/index.js";
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
} from "../packages/domain/dist/index.js";
import { runExecution } from "../packages/execution-runtime/dist/index.js";
import {
  ResourceOwnershipRepository,
  SecretMaterial,
  type SecretStoreError,
  SecretStorePort,
  secretRef,
  TransactionPort,
} from "../packages/ports/dist/index.js";

const repoRoot = join(import.meta.dirname, "..");

describe("P12-003 secret types", () => {
  it("SecretMaterial redacts under JSON.stringify and String by default (P12 `03` §6)", () => {
    const material = SecretMaterial.of("raw-credential-xyz");
    expect(JSON.stringify({ material })).toBe('{"material":"[REDACTED]"}');
    expect(String(material)).toBe("[REDACTED]");
    expect(material.reveal()).toBe("raw-credential-xyz");
  });
});

describe("P12-003 secret-env adapter", () => {
  it("resolves an env-var SecretRef; missing -> SecretNotFound (no silent fallback)", async () => {
    const layer = SecretEnvLive({ ambient: { PROVIDER_KEY: "env-secret" } });
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const store = yield* SecretStorePort;
          const ok = yield* store.resolve(secretRef("PROVIDER_KEY"));
          const missing = yield* Effect.flip(
            store.resolve(secretRef("ABSENT")),
          );
          return { value: ok.reveal(), missing };
        }),
        layer,
      ) as Effect.Effect<
        { value: string; missing: SecretStoreError },
        unknown,
        never
      >,
    );
    expect(result.value).toBe("env-secret");
    expect(result.missing._tag).toBe("SecretNotFound");
  });

  it("reports SecretExpired", async () => {
    const layer = SecretEnvLive({
      ambient: { OLD_KEY: "stale" },
      expiries: { OLD_KEY: "2000-01-01T00:00:00.000Z" },
    });
    const error = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const store = yield* SecretStorePort;
          return yield* Effect.flip(store.resolve(secretRef("OLD_KEY")));
        }),
        layer,
      ) as Effect.Effect<SecretStoreError, unknown, never>,
    );
    expect(error._tag).toBe("SecretExpired");
  });
});

describe("P12-003 secret-file adapter", () => {
  it("resolves inside its root; escape -> SecretInaccessible; missing -> SecretNotFound; expired envelope -> SecretExpired", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-secret-"));
    writeFileSync(join(root, "api-key"), "file-secret");
    writeFileSync(
      join(root, "expired.json"),
      JSON.stringify({
        value: "stale",
        expiresAt: "2000-01-01T00:00:00.000Z",
      }),
    );
    const layer = SecretFileLive({ root });
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const store = yield* SecretStorePort;
          const ok = yield* store.resolve(secretRef("api-key"));
          const missing = yield* Effect.flip(
            store.resolve(secretRef("absent")),
          );
          const escaped = yield* Effect.flip(
            store.resolve(secretRef("../escape")),
          );
          const expired = yield* Effect.flip(
            store.resolve(secretRef("expired.json")),
          );
          return {
            value: ok.reveal(),
            missing: missing._tag,
            escaped: escaped._tag,
            expired: expired._tag,
          };
        }),
        layer,
      ) as Effect.Effect<
        {
          value: string;
          missing: string;
          escaped: string;
          expired: string;
        },
        unknown,
        never
      >,
    );
    expect(result.value).toBe("file-secret");
    expect(result.missing).toBe("SecretNotFound");
    expect(result.escaped).toBe("SecretInaccessible");
    expect(result.expired).toBe("SecretExpired");
  });
});

describe("P12-003 driver + sandbox mechanism", () => {
  it("driver no longer hardcodes a raw secretRef (P12 `03` §6 / B5)", () => {
    const source = readFileSync(
      join(repoRoot, "packages/agent-runtime/src/driver.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/secretRef\s*:\s*"secret"/);
  });

  it("sandbox env projection excludes secret-env material (P12 `03` §3 / NEW-14)", () => {
    const sentinel = `SENTINEL_SECRET_${randomUUID().replace(/-/g, "")}`;
    const projected = sandboxEnvironment({
      PATH: "/usr/bin:/bin",
      HOME: "/home/op",
      [sentinel]: "must-not-leak",
    });
    expect(sentinel in projected).toBe(false);
    expect(
      Object.keys(projected).every((key) =>
        SANDBOX_ENV_ALLOWLIST.includes(key),
      ),
    ).toBe(true);
  });
});

// --- end-to-end sentinel no-leak story (EC-4 / B5) ---

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789ab");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789ab");
const workId = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789ab");
const exe1 = parse(ExecutionId)("exe_018f2b3c-4d5e-7abc-8def-0123456789a1");
const actor = parse(Actor)("user:test");
const principal = parse(Principal)("user:test");
const context: CommandSubmissionContext = {
  _tag: "System",
  principal,
  causationRef: "c",
};

const definition = {
  purpose: "p",
  ownedResponsibilities: [],
  obligations: [],
  includes: [],
  excludes: [],
  interfaces: [],
};

const projectPayload: CreateProjectPayload = {
  name: "Arbor",
  revision: parse(Revision)(0),
  projectPolicy: makeProjectPolicy(),
  projectPolicyRevision: parse(Revision)(0),
  defaultConfiguration: {},
  environmentRef: "local",
  rootWorkspaceId: workspaceId,
  primarySession: {
    sessionId,
    contextEpoch: parse(ContextEpochNumber)(0),
  },
  rootWorkspace: {
    name: "root",
    responsibilityDefinition: definition,
    responsibilityRevision: parse(ResponsibilityRevision)(0),
    resourceBoundary: {
      basisResponsibilityRevision: parse(ResponsibilityRevision)(0),
      addresses: [{ _tag: "FileTree", path: "." }],
    },
    resourceBoundaryRevision: parse(ResourceBoundaryRevision)(0),
    agentBinding: responsibilityBound(workspaceId),
    workspacePolicy: makeWorkspacePolicy(),
    workspacePolicyRevision: parse(Revision)(0),
    revision: parse(Revision)(0),
  },
};

const workPayload: AssignWorkPayload = {
  workId,
  workspaceId,
  expectedWorkspaceRevision: parse(Revision)(0),
  objective: "ship the slice",
  why: "P12-003",
  constraints: [],
  completionExpectation: "done",
  verificationMission: { goal: "g", criteria: [], riskRequirements: [] },
  provenance: { predecessorWorkId: null, reason: "initial" },
  revision: parse(WorkRevision)(0),
};

const commandId = (suffix: string) =>
  parse(CommandId)(`cmd_018f2b3c-4d5e-7abc-8def-0123456789a${suffix}`);

const p1Authority = (
  tag: "CreateProjectAuthority" | "AssignWorkAuthority",
  payload: CreateProjectPayload | AssignWorkPayload,
  id: CommandId,
): VerifiedCommandAuthority =>
  ({
    _tag: tag,
    principal,
    commandId: id,
    semanticRequestFingerprint: semanticRequestFingerprint({
      commandType:
        tag === "CreateProjectAuthority" ? "CreateProject" : "AssignWork",
      projectId,
      actor,
      schemaVersion: "1",
      payload,
    }),
    projectId,
    ...(tag === "AssignWorkAuthority"
      ? { targetWorkspaceId: workspaceId }
      : {}),
  }) as VerifiedCommandAuthority;

const envelope = <P>(
  commandType: string,
  payload: P,
  id: CommandId,
): GatewayEnvelope<P> => ({
  commandType,
  commandId: id,
  projectId,
  actor,
  issuedAt: "t",
  payload,
});

const turns = [
  [
    {
      _tag: "ToolCallProposed" as const,
      callRef: "c1",
      toolName: "arbor_directive",
      argumentsJson: JSON.stringify({
        _tag: "CompletionClaim",
        claim: { claimRef: "claim-1", workRevision: 0 },
      }),
    },
    { _tag: "TurnCompleted" as const, finishReason: "ToolCall" as const },
  ],
];

describe("P12-003 sentinel no-leak", () => {
  it("a resolved sentinel secret never appears in any SQLite table row or stdout/stderr (EC-4 / B5)", async () => {
    const sentinelEnv = `SENTINEL_SECRET_${randomUUID().replace(/-/g, "")}`;
    const sentinelValue = `sentinel-value-${randomUUID()}`;
    process.env[sentinelEnv] = sentinelValue;

    const dir = mkdtempSync(join(tmpdir(), "p12-secret-"));
    const app = buildSliceLayer({
      databaseFile: join(dir, "slice.db"),
      providerTurns: turns,
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
            yield* runMigrations(P7_MIGRATIONS);
            const gateway = yield* CommandGateway;
            yield* gateway.execute(
              envelope("CreateProject", projectPayload, commandId("1")),
              context,
              p1Authority(
                "CreateProjectAuthority",
                projectPayload,
                commandId("1"),
              ),
            );
            yield* gateway.execute(
              envelope("AssignWork", workPayload, commandId("2")),
              context,
              p1Authority("AssignWorkAuthority", workPayload, commandId("2")),
            );

            const ownership = yield* ResourceOwnershipRepository;
            const tx0 = yield* TransactionPort;
            yield* tx0.transact(
              ownership.insertClaim({
                claimId: "roc_018f2b3c-4d5e-7abc-8def-0123456789a1",
                workspaceId,
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

            yield* evaluateAndSelect(workspaceId, principal, {
              _tag: "WorkSelected",
            });
            yield* admitExecution(
              workspaceId,
              exe1,
              { _tag: "Work", workId },
              principal,
            );
            const settled = yield* runExecution(
              exe1,
              { _tag: "WorkSelected" },
              principal,
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
    }

    // the turn completed: the sentinel SecretRef WAS resolved through the adapter.
    expect(settlement).toBe("Completed");
    // and it leaked nowhere: not in any table, not in captured stdout/stderr.
    expect(allRows).not.toContain(sentinelValue);
    expect(captured.join("")).not.toContain(sentinelValue);
    expect(captured.join("")).not.toContain(sentinelEnv);
  });
});
