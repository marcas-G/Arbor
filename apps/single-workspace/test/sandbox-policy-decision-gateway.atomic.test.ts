import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CommandGateway,
  type CommandHandler,
  CommandHandlerRegistryLive,
  type DecideSandboxPolicyPayload,
  type DecideSandboxPolicyPreparation,
  FenceStopCheckInertLive,
  makeCommandGatewayLive,
  makeDecideSandboxPolicyHandler as makeDecisionHandler,
  semanticRequestFingerprint,
} from "@arbor/application";
import {
  Actor,
  CommandId,
  ExecutionId,
  encodeNetworkPolicyV1,
  encodeSandboxAuthorityBundleV2,
  encodeSandboxAuthorityHighWaterV2,
  encodeSandboxOperatorPolicyConfigV1,
  encodeSandboxPolicyGrantIssuerConfigV1,
  encodeSandboxProviderQualificationRegistryV1,
  networkBrokerControlsV1ForMode,
  type PermissionGrant,
  PermissionGrantId,
  Principal,
  ProjectId,
  parse,
  produceSandboxBoundaryV1,
  type SandboxAuthorityBundleSnapshotV2,
  type SandboxAuthorityBundleV2,
  SemanticRequestFingerprint,
  WorkId,
  WorkspaceId,
} from "@arbor/domain";
import {
  ClockLive,
  CommandStoreLive,
  CURRENT_MIGRATIONS,
  DomainEventJournalLive,
  ExecutionRepositoryLive,
  IdGeneratorLive,
  layer,
  P39_MAINTENANCE_MIGRATIONS,
  PermissionGrantRepositoryLive,
  ProjectRepositoryLive,
  ResourceOwnershipRepositoryLive,
  runMigrations,
  SandboxPolicyDecisionStoreLive,
  splitStatements,
  TransactionPortLive,
  WorkspaceRepositoryLive,
  WorktreeStoreLive,
} from "@arbor/persistence-sqlite";
import {
  Clock,
  CommandStore,
  DomainEventJournal,
  type DomainEventJournalService,
  EnvironmentResolverPort,
  ExecutionRepository,
  PermissionGrantRepository,
  ResourceOwnershipRepository,
  SandboxPolicyDecisionStore,
  TransactionPort,
  WorkspaceRepository,
  WorktreeStore,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { makeSandboxPolicyDecisionPreparation } from "../src/sandbox-policy-decision-preparation.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const commandId = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789a1");
const grantId = parse(PermissionGrantId)(
  "pgr_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const grantCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789a2",
);
const sessionId = "ses_018f2b3c-4d5e-7abc-8def-0123456789a1";
const workId = "wrk_018f2b3c-4d5e-7abc-8def-0123456789a1";
const operator = parse(Principal)("user:operator");
const principal = parse(Principal)("user:subject");
const actor = parse(Actor)(String(principal));
const now = "2026-10-19T00:00:00.000Z";
const episodeBinding = {
  _tag: "WorkEpisode" as const,
  workId: parse(WorkId)(workId),
  targetWorkRevision: 2 as never,
};
const grant: PermissionGrant = {
  permissionGrantId: grantId,
  scope: `DecideSandboxPolicy@${executionId}`,
  issuer: operator,
  lifetime: "Bounded",
  subject: { _tag: "HumanPrincipal", principal },
  capability: "DecideSandboxPolicy",
  target: executionId,
  validFrom: "2026-10-18T00:00:00.000Z",
  expiresAt: "2099-10-20T00:00:00.000Z",
  revision: 1,
  state: "Active",
};
const provenance = {
  permissionGrantId: grantId,
  grantPermissionCommandId: grantCommandId,
  issuerPrincipal: operator,
  operatorConfigRevision: 4,
  operatorConfigDigest: "f".repeat(64),
};
const networkPolicy = {
  version: 1 as const,
  mode: "Disabled" as const,
  destinations: [],
};
const networkPolicyDigest = createHash("sha256")
  .update(encodeNetworkPolicyV1(networkPolicy))
  .digest("hex");
const limits = {
  wallTimeMs: 60_000,
  stdoutBytes: 8192,
  stderrBytes: 8192,
  processCount: 16,
  memoryBytes: 268_435_456,
  cpuTimeMs: 30_000,
};
const payload: DecideSandboxPolicyPayload = {
  projectId,
  workspaceId,
  executionId,
  episodeBinding,
  expectedEpisodeRevision: 2,
  expectedPolicyRevision: 0,
  expectedWorkspaceRevision: 3,
  expectedResourceBoundaryRevision: 1,
  expectedSandboxHandleBindingDigest: "c".repeat(64),
  expectedAuthorityBundleRevision: 4,
  expectedAuthorityBundleDigest: "e".repeat(64),
  expectedOperatorConfigRevision: 4,
  expectedOperatorConfigDigest: "f".repeat(64),
  expectedProviderRegistryRevision: 3,
  expectedProviderRegistryDigest: "2".repeat(64),
  profile: "ReadOnly",
  providerId: "bwrap",
  networkPolicy: { kind: "OsEnforced", policy: networkPolicy },
  decisionExpiresAt: "2099-10-19T12:00:00.000Z",
};
const snapshot = {
  version: 1 as const,
  kind: "OsEnforced" as const,
  projectId,
  workspaceId,
  executionId,
  episodeBinding,
  workspaceRevision: 3,
  resourceBoundaryRevision: 1,
  resourceBoundaryDigest: "a".repeat(64),
  sandboxEnvironmentBasisDigest: "b".repeat(64),
  policyRevision: 1,
  expiresAt: payload.decisionExpiresAt,
  profile: "ReadOnly" as const,
  providerId: "bwrap",
  providerVersion: "0.8.0",
  capabilityRevision: 1,
  osFamily: "Linux" as const,
  osBuild: "linux-6.8",
  qualificationEvidenceRef: `blob:sha256:${"1".repeat(64)}`,
  networkPolicy,
  networkPolicyDigest,
  networkBrokerControls: networkBrokerControlsV1ForMode("Disabled"),
  providerRegistryRevision: 3,
  providerRegistryDigest: "2".repeat(64),
  sandboxHandleBindingDigest: payload.expectedSandboxHandleBindingDigest,
  mounts: [
    {
      mountId: "workspace",
      targetRef: {
        version: 1,
        kind: "RegionDigest",
        resourceSpace: "filesystem",
        regionIdentityDigest: "9".repeat(64),
      },
      targetIdentityDigest: "d".repeat(64),
      access: "ReadOnly" as const,
    },
  ],
  environmentAllowlist: ["PATH"],
  limits: {
    wallTimeMs: 60_000,
    stdoutBytes: 8192,
    stderrBytes: 8192,
    processCount: 16,
    memoryBytes: 268_435_456,
    cpuTimeMs: 30_000,
  },
  auditRefs: ["audit:decision"],
  authorityBundleRevision: 4,
  authorityBundleDigest: "e".repeat(64),
  operatorConfigRevision: 4,
  operatorConfigDigest: "f".repeat(64),
};

const trustedAuthoritySnapshot: SandboxAuthorityBundleSnapshotV2 = {
  bundle: {
    version: 2,
    sourceIdentity: "host:gateway-fixture",
    bundleRevision: 4,
    issuerConfigRevision: 1,
    issuerConfigDigest: "1".repeat(64),
    issuerConfig: {
      version: 1,
      revision: 1,
      issuers: [String(operator)],
    },
    operatorConfigRevision: 4,
    operatorConfigDigest: "f".repeat(64),
    operatorConfig: {
      version: 1,
      revision: 4,
      environmentAllowlist: ["PATH"],
      limitsByProfile: [
        {
          profile: "ReadOnly",
          limits: {
            wallTimeMs: 60_000,
            stdoutBytes: 8192,
            stderrBytes: 8192,
            processCount: 16,
            memoryBytes: 268_435_456,
            cpuTimeMs: 30_000,
          },
        },
        {
          profile: "WorkspaceWrite",
          limits: {
            wallTimeMs: 60_000,
            stdoutBytes: 8192,
            stderrBytes: 8192,
            processCount: 16,
            memoryBytes: 268_435_456,
            cpuTimeMs: 30_000,
          },
        },
        {
          profile: "FullAccess",
          limits: {
            wallTimeMs: 60_000,
            stdoutBytes: 8192,
            stderrBytes: 8192,
            processCount: 16,
            memoryBytes: 268_435_456,
            cpuTimeMs: 30_000,
          },
        },
      ],
      trustedLocalRuntimeVersion: "builtin-v1",
    },
    providerRegistryRevision: 3,
    providerRegistryDigest: "2".repeat(64),
    providerRegistry: { version: 1, revision: 3, entries: [] },
  },
  bundleDigest: "e".repeat(64),
  canonicalJson: "{}",
};

const makeTrustedAuthoritySource = () => {
  const issuerConfig = {
    version: 1 as const,
    revision: 1,
    issuers: [String(operator)],
  };
  const operatorConfig = {
    version: 1 as const,
    revision: 4,
    environmentAllowlist: ["PATH"],
    limitsByProfile: [
      { profile: "ReadOnly" as const, limits },
      { profile: "WorkspaceWrite" as const, limits },
      { profile: "FullAccess" as const, limits },
    ],
    trustedLocalRuntimeVersion: "builtin-v1" as const,
  };
  const providerRegistry = { version: 1 as const, revision: 3, entries: [] };
  const hash = (value: string) =>
    createHash("sha256").update(value, "utf8").digest("hex");
  const issuerConfigDigest = hash(
    encodeSandboxPolicyGrantIssuerConfigV1(issuerConfig),
  );
  const operatorConfigDigest = hash(
    encodeSandboxOperatorPolicyConfigV1(operatorConfig),
  );
  const providerRegistryDigest = hash(
    encodeSandboxProviderQualificationRegistryV1(providerRegistry),
  );
  const bundle: SandboxAuthorityBundleV2 = {
    version: 2,
    sourceIdentity: "host:gateway-test",
    bundleRevision: 4,
    issuerConfigRevision: issuerConfig.revision,
    issuerConfigDigest,
    issuerConfig,
    operatorConfigRevision: operatorConfig.revision,
    operatorConfigDigest,
    operatorConfig,
    providerRegistryRevision: providerRegistry.revision,
    providerRegistryDigest,
    providerRegistry,
  };
  const bundleJson = encodeSandboxAuthorityBundleV2(bundle);
  const bundleDigest = hash(bundleJson);
  const highWaterJson = encodeSandboxAuthorityHighWaterV2({
    version: 2,
    sourceIdentity: bundle.sourceIdentity,
    bundleRevision: bundle.bundleRevision,
    bundleDigest,
    issuerConfigRevision: bundle.issuerConfigRevision,
    issuerConfigDigest: bundle.issuerConfigDigest,
    operatorConfigRevision: bundle.operatorConfigRevision,
    operatorConfigDigest: bundle.operatorConfigDigest,
    providerRegistryRevision: bundle.providerRegistryRevision,
    providerRegistryDigest: bundle.providerRegistryDigest,
  });
  return {
    bundle,
    bundleDigest,
    operatorConfigDigest,
    source: {
      readVerifiedSandboxAuthorityBundle: () =>
        Effect.succeed({
          sourceIdentity: bundle.sourceIdentity,
          canonicalJson: bundleJson,
        }),
      readSandboxAuthorityHighWater: () => Effect.succeed(highWaterJson),
      commitSandboxAuthorityHighWater: () => Effect.succeed(false),
      appendSandboxAuthorityAudit: () => Effect.succeed(true),
    },
  };
};

const environmentResolverTestLayer = Layer.succeed(EnvironmentResolverPort, {
  observe: (projectId, addresses) => {
    const entries = addresses.map((address) => {
      const resolved =
        address._tag === "GitWorktree"
          ? {
              resourceSpaceId: "filesystem",
              normalizedRegion: { kind: "GitWorktree", path: address.path },
            }
          : {
              resourceSpaceId: "filesystem",
              normalizedRegion: { kind: "FileTree", path: address.path },
            };
      return { address, resolved, probe: {} as never };
    });
    return Effect.succeed({
      projectId,
      observedRevision: "0",
      fingerprint: "9".repeat(64) as never,
      snapshotBlobRef: `blob:sha256:${"9".repeat(64)}`,
      changedRegions: entries.map((entry) => entry.resolved),
      entries,
    });
  },
});

const makeTestStack = (
  options: {
    readonly failDecisionEventOnce?: boolean;
    readonly staleWorkspaceRevision?: boolean;
    readonly productionPreparation?: boolean;
    readonly authoritySnapshot?: SandboxAuthorityBundleSnapshotV2;
  } = {},
  databaseFile = ":memory:",
) => {
  let failed = false;
  let preparationCalls = 0;
  let latestPolicyRevision = 0;
  const base = layer({ filename: databaseFile });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const realJournal = Layer.provide(DomainEventJournalLive, infra);
  const journal = Layer.provide(
    Layer.effect(
      DomainEventJournal,
      Effect.gen(function* () {
        const underlying = yield* DomainEventJournal;
        const service: DomainEventJournalService = {
          ...underlying,
          append: (events) => {
            if (
              options.failDecisionEventOnce === true &&
              !failed &&
              events.some(
                (event) => event.eventType === "SandboxPolicyDecisionRecorded",
              )
            ) {
              failed = true;
              return Effect.fail({
                _tag: "PersistenceUnavailable" as const,
                repository: "DomainEventJournal" as const,
                operation: "sandbox-decision-test-failure",
                retryDisposition: "retryable" as const,
                sourceTag: "InjectedFailure",
                cause: "decision event failure before transaction commit",
              });
            }
            return underlying.append(events);
          },
        };
        return service;
      }),
    ),
    realJournal,
  );
  const transaction = Layer.provide(TransactionPortLive, infra);
  const commands = Layer.provide(CommandStoreLive, infra);
  const decisions = Layer.provide(SandboxPolicyDecisionStoreLive, infra);
  const projects = Layer.provide(ProjectRepositoryLive, infra);
  const workspaces = Layer.provide(WorkspaceRepositoryLive, infra);
  const ownership = Layer.provide(ResourceOwnershipRepositoryLive, infra);
  const worktrees = Layer.provide(WorktreeStoreLive, infra);
  const executions = Layer.provide(ExecutionRepositoryLive, infra);
  const grantRepository = Layer.provide(PermissionGrantRepositoryLive, infra);
  const repos = Layer.mergeAll(
    transaction,
    commands,
    decisions,
    journal,
    projects,
    workspaces,
    ownership,
    worktrees,
    executions,
    grantRepository,
    environmentResolverTestLayer,
  );
  const registry = Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const grants = yield* PermissionGrantRepository;
        const executionRepository = yield* ExecutionRepository;
        const decisionStore = yield* SandboxPolicyDecisionStore;
        const clock = yield* Clock;
        let preparation: DecideSandboxPolicyPreparation = {
          prepare: () =>
            Effect.sync(() => {
              preparationCalls += 1;
              return snapshot;
            }),
          currentPreconditions: () =>
            Effect.succeed({
              kind: "OsEnforced" as const,
              expectedEpisodeRevision: 2,
              latestCommittedPolicyRevision: latestPolicyRevision,
              episodeBinding,
              workspaceRevision:
                options.staleWorkspaceRevision === true ? 4 : 3,
              resourceBoundaryRevision: 1,
              sandboxHandleBindingDigest:
                payload.expectedSandboxHandleBindingDigest,
              authorityBundleRevision: 4,
              authorityBundleDigest: "e".repeat(64),
              operatorConfigRevision: 4,
              operatorConfigDigest: "f".repeat(64),
              providerRegistryRevision: 3,
              providerRegistryDigest: "2".repeat(64),
            }),
        };
        if (options.productionPreparation === true) {
          preparation = makeSandboxPolicyDecisionPreparation({
            transaction: yield* TransactionPort,
            workspaces: yield* WorkspaceRepository,
            executions: executionRepository,
            decisions: decisionStore,
            ownership: yield* ResourceOwnershipRepository,
            worktrees: yield* WorktreeStore,
            environmentResolver: yield* EnvironmentResolverPort,
            authoritySnapshot:
              options.authoritySnapshot ?? trustedAuthoritySnapshot,
          });
        }
        const handler = makeDecisionHandler({
          grants,
          executions: executionRepository,
          decisions: decisionStore,
          preparation,
          clock,
        }) as unknown as CommandHandler<unknown, unknown>;
        return CommandHandlerRegistryLive([handler]);
      }),
    ),
    Layer.mergeAll(infra, repos),
  );
  const app = Layer.mergeAll(
    infra,
    repos,
    registry,
    FenceStopCheckInertLive,
    Layer.provide(
      makeCommandGatewayLive(),
      Layer.mergeAll(infra, repos, registry, FenceStopCheckInertLive),
    ),
  );
  return {
    app,
    preparationCalls: () => preparationCalls,
    setLatestPolicyRevision: (revision: number) => {
      latestPolicyRevision = revision;
    },
  };
};

const envelope = (id = commandId, commandPayload = payload) => ({
  commandType: "DecideSandboxPolicy",
  commandId: id,
  projectId,
  actor,
  issuedAt: "1999-01-01T00:00:00.000Z",
  payload: commandPayload,
});

const seedSchema50AndGrant = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* runMigrations(
    CURRENT_MIGRATIONS.filter((migration) => migration.id < 39),
  );
  const p39 = P39_MAINTENANCE_MIGRATIONS.find(
    (migration) => migration.id === 39,
  );
  if (p39 === undefined) throw new Error("P39 test fixture migration missing");
  yield* sql.unsafe("PRAGMA foreign_keys = OFF");
  yield* sql.unsafe("PRAGMA legacy_alter_table = ON");
  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (const statement of splitStatements(p39.sql)) {
        yield* sql.unsafe(statement);
      }
      yield* sql.unsafe("PRAGMA user_version = 39");
    }),
  );
  yield* sql.unsafe("PRAGMA legacy_alter_table = OFF");
  yield* sql.unsafe("PRAGMA foreign_keys = ON");
  yield* runMigrations(CURRENT_MIGRATIONS, { allowOfflineOnly: true });
  const tx = yield* TransactionPort;
  yield* tx.transact(seed(sql));
  const grants = yield* PermissionGrantRepository;
  const commandStore = yield* CommandStore;
  yield* tx.transact(
    Effect.gen(function* () {
      yield* commandStore.insertCommitted(
        grantCommandId,
        projectId,
        parse(SemanticRequestFingerprint)("g".repeat(64)),
        "1",
        1,
        JSON.stringify({ permissionGrantId: grantId, state: "Active" }),
      );
      yield* grants.put(grant, projectId);
      yield* grants.insertSandboxPolicyGrantIssuerProvenance(provenance);
    }),
  );
});

describe("schema-50 SQLite DecideSandboxPolicy Gateway atomicity", () => {
  it("commits decision, canonical result, receipt and event; exact replay does not reprepare", async () => {
    // The implementation below uses a fresh in-memory SQLite database and the
    // exact schema-50 migration chain. No repository-owned or online DB is opened.
    const stack = makeTestStack();
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* seedSchema50AndGrant;
          const sql = yield* SqlClient;
          const gateway = yield* CommandGateway;
          const fingerprint = semanticRequestFingerprint({
            commandType: "DecideSandboxPolicy",
            projectId,
            actor,
            schemaVersion: "1",
            payload,
          });
          const auth = makeAuthority(fingerprint);
          const first = yield* gateway.execute(
            envelope(),
            { _tag: "External", principal },
            auth,
          );
          const replay = yield* gateway.execute(
            envelope(),
            { _tag: "External", principal },
            auth,
          );
          const rows = yield* sql.unsafe<{
            decisions: number;
            commands: number;
            events: number;
          }>(
            `SELECT
              (SELECT COUNT(*) FROM sandbox_policy_decisions WHERE decision_command_id = ?) AS decisions,
              (SELECT COUNT(*) FROM commands WHERE command_id = ?) AS commands,
              (SELECT COUNT(*) FROM domain_events WHERE event_type = 'SandboxPolicyDecisionRecorded') AS events`,
            [commandId, commandId],
          );
          return { first, replay, counts: rows[0] };
        }),
        stack.app,
      ),
    );
    expect(result.first.resolution._tag).toBe("Committed");
    expect(result.replay.resolution).toEqual(result.first.resolution);
    expect(result.counts).toEqual({ decisions: 1, commands: 1, events: 1 });
    expect(stack.preparationCalls()).toBe(1);
  });

  it("rolls decision and receipt back when event append fails, then retry commits once", async () => {
    const stack = makeTestStack({ failDecisionEventOnce: true });
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* seedSchema50AndGrant;
          const sql = yield* SqlClient;
          const gateway = yield* CommandGateway;
          const fingerprint = semanticRequestFingerprint({
            commandType: "DecideSandboxPolicy",
            projectId,
            actor,
            schemaVersion: "1",
            payload,
          });
          const auth = makeAuthority(fingerprint);
          const first = yield* Effect.match(
            gateway.execute(envelope(), { _tag: "External", principal }, auth),
            {
              onFailure: (error) => ({ _tag: "Failure" as const, error }),
              onSuccess: (receipt) => ({ _tag: "Receipt" as const, receipt }),
            },
          );
          const afterFailure = yield* sql.unsafe<{
            decisions: number;
            receipts: number;
            events: number;
          }>(
            `SELECT
              (SELECT COUNT(*) FROM sandbox_policy_decisions WHERE decision_command_id = ?) AS decisions,
              (SELECT COUNT(*) FROM commands WHERE command_id = ?) AS receipts,
              (SELECT COUNT(*) FROM domain_events WHERE event_type = 'SandboxPolicyDecisionRecorded') AS events`,
            [commandId, commandId],
          );
          const retry = yield* gateway.execute(
            envelope(),
            { _tag: "External", principal },
            auth,
          );
          const afterRetry = yield* sql.unsafe<{
            decisions: number;
            receipts: number;
            events: number;
          }>(
            `SELECT
              (SELECT COUNT(*) FROM sandbox_policy_decisions WHERE decision_command_id = ?) AS decisions,
              (SELECT COUNT(*) FROM commands WHERE command_id = ?) AS receipts,
              (SELECT COUNT(*) FROM domain_events WHERE event_type = 'SandboxPolicyDecisionRecorded') AS events`,
            [commandId, commandId],
          );
          return {
            first,
            afterFailure: afterFailure[0],
            retry,
            afterRetry: afterRetry[0],
          };
        }),
        stack.app,
      ),
    );
    expect(result.first._tag).toBe("Failure");
    expect(result.afterFailure).toEqual({
      decisions: 0,
      receipts: 0,
      events: 0,
    });
    expect(result.retry.resolution._tag).toBe("Committed");
    expect(result.afterRetry).toEqual({ decisions: 1, receipts: 1, events: 1 });
    expect(stack.preparationCalls()).toBe(2);
  });

  it("persists only the safe stale-CAS receipt, with no decision or event", async () => {
    const stack = makeTestStack({ staleWorkspaceRevision: true });
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* seedSchema50AndGrant;
          const sql = yield* SqlClient;
          const gateway = yield* CommandGateway;
          const fingerprint = semanticRequestFingerprint({
            commandType: "DecideSandboxPolicy",
            projectId,
            actor,
            schemaVersion: "1",
            payload,
          });
          const receipt = yield* gateway.execute(
            envelope(),
            { _tag: "External", principal },
            makeAuthority(fingerprint),
          );
          const rows = yield* sql.unsafe<{
            decisions: number;
            receipts: number;
            events: number;
          }>(
            `SELECT
              (SELECT COUNT(*) FROM sandbox_policy_decisions WHERE decision_command_id = ?) AS decisions,
              (SELECT COUNT(*) FROM commands WHERE command_id = ?) AS receipts,
              (SELECT COUNT(*) FROM domain_events WHERE event_type = 'SandboxPolicyDecisionRecorded') AS events`,
            [commandId, commandId],
          );
          return { receipt, counts: rows[0] };
        }),
        stack.app,
      ),
    );
    expect(result.receipt.resolution).toMatchObject({
      _tag: "TerminalRejected",
      error: {
        _tag: "StaleSandboxPolicyInputs",
        safeDetails: { field: "WorkspaceRevision" },
      },
    });
    expect(result.counts).toEqual({ decisions: 0, receipts: 1, events: 0 });
  });

  it("rejects expectedPolicyRevision against an existing SQLite decision head", async () => {
    const stack = makeTestStack();
    const retryCommandId = parse(CommandId)(
      "cmd_018f2b3c-4d5e-7abc-8def-0123456789a4",
    );
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* seedSchema50AndGrant;
          const gateway = yield* CommandGateway;
          const fingerprint = semanticRequestFingerprint({
            commandType: "DecideSandboxPolicy",
            projectId,
            actor,
            schemaVersion: "1",
            payload,
          });
          const committed = yield* gateway.execute(
            envelope(),
            { _tag: "External", principal },
            makeAuthority(fingerprint),
          );
          stack.setLatestPolicyRevision(1);
          const stale = yield* gateway.execute(
            envelope(retryCommandId),
            { _tag: "External", principal },
            makeAuthority(fingerprint, retryCommandId),
          );
          return { committed, stale };
        }),
        stack.app,
      ),
    );
    expect(result.committed.resolution._tag).toBe("Committed");
    expect(result.stale.resolution).toMatchObject({
      _tag: "TerminalRejected",
      error: {
        _tag: "StaleSandboxPolicyInputs",
        safeDetails: { field: "PolicyRevision" },
      },
    });
  });

  it("uses production materialization with schema-50 SQLite commit, replay, and stale policy-head CAS", async () => {
    const trusted = makeTrustedAuthoritySource();
    const authoritySnapshot: SandboxAuthorityBundleSnapshotV2 = {
      bundle: trusted.bundle,
      bundleDigest: trusted.bundleDigest,
      canonicalJson: encodeSandboxAuthorityBundleV2(trusted.bundle),
    };
    const stack = makeTestStack({
      productionPreparation: true,
      authoritySnapshot,
    });
    const worktreePath = process.cwd();
    const p11Region = {
      resourceSpaceId: "filesystem",
      normalizedRegion: { kind: "GitWorktree", path: worktreePath },
    } as const;
    const p11Boundary = {
      basisResponsibilityRevision: 1,
      addresses: [{ _tag: "GitWorktree" as const, path: worktreePath }],
    } as const;
    const boundary = produceSandboxBoundaryV1(
      {
        workspaceId,
        resourceBoundaryRevision: 1,
        responsibilityRevision: 1,
        boundary: p11Boundary,
        resolvedRegions: [p11Region],
        primaryManagedGitWorktreeRegion: p11Region,
        ownershipClaims: [],
        policyKind: "TrustedLocalUnconfinedV1",
        profile: "FullAccess",
      },
      (value) => createHash("sha256").update(value, "utf8").digest("hex"),
    );
    expect(boundary).toBeDefined();
    if (boundary === undefined) return;
    const trustedPayload: DecideSandboxPolicyPayload = {
      projectId,
      workspaceId,
      executionId,
      episodeBinding,
      expectedEpisodeRevision: 2,
      expectedPolicyRevision: 0,
      expectedWorkspaceRevision: 3,
      expectedResourceBoundaryRevision: 1,
      expectedSandboxHandleBindingDigest: boundary.sandboxHandleBindingDigest,
      expectedAuthorityBundleRevision: trusted.bundle.bundleRevision,
      expectedAuthorityBundleDigest: trusted.bundleDigest,
      expectedOperatorConfigRevision: trusted.bundle.operatorConfigRevision,
      expectedOperatorConfigDigest: trusted.bundle.operatorConfigDigest,
      profile: "FullAccess",
      providerId: "TrustedLocal",
      networkPolicy: { kind: "TrustedLocalUnconfinedV1", version: 1 },
      decisionExpiresAt: "2099-10-19T12:00:00.000Z",
    };
    const v2GrantId = parse(PermissionGrantId)(
      "pgr_018f2b3c-4d5e-7abc-8def-0123456789a3",
    );
    const v2GrantCommandId = parse(CommandId)(
      "cmd_018f2b3c-4d5e-7abc-8def-0123456789a3",
    );
    const v2Grant = { ...grant, permissionGrantId: v2GrantId };
    const v2Provenance = {
      ...provenance,
      permissionGrantId: v2GrantId,
      grantPermissionCommandId: v2GrantCommandId,
      operatorConfigRevision: trusted.bundle.operatorConfigRevision,
      operatorConfigDigest: trusted.bundle.operatorConfigDigest,
    };
    const retryCommandId = parse(CommandId)(
      "cmd_018f2b3c-4d5e-7abc-8def-0123456789a6",
    );
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* seedSchema50AndGrant;
          const sql = yield* SqlClient;
          yield* seedManagedWorktree(sql, worktreePath);
          const transactions = yield* TransactionPort;
          const grants = yield* PermissionGrantRepository;
          const commandStore = yield* CommandStore;
          yield* transactions.transact(
            Effect.gen(function* () {
              yield* commandStore.insertCommitted(
                v2GrantCommandId,
                projectId,
                parse(SemanticRequestFingerprint)("v".repeat(64)),
                "1",
                1,
                JSON.stringify({
                  permissionGrantId: v2GrantId,
                  state: "Active",
                }),
              );
              yield* grants.put(v2Grant, projectId);
              yield* grants.insertSandboxPolicyGrantIssuerProvenance(
                v2Provenance,
              );
            }),
          );
          const gateway = yield* CommandGateway;
          const fingerprint = semanticRequestFingerprint({
            commandType: "DecideSandboxPolicy",
            projectId,
            actor,
            schemaVersion: "1",
            payload: trustedPayload,
          });
          const authorityFor = (id: CommandId) => ({
            ...makeAuthority(fingerprint, id),
            permissionGrant: v2Grant,
            issuerProvenance: v2Provenance,
            authorityBundleRevision: trusted.bundle.bundleRevision,
            authorityBundleDigest: trusted.bundleDigest,
            providerRegistryRevision: trusted.bundle.providerRegistryRevision,
            providerRegistryDigest: trusted.bundle.providerRegistryDigest,
            operatorConfigRevision: trusted.bundle.operatorConfigRevision,
            operatorConfigDigest: trusted.bundle.operatorConfigDigest,
          });
          const first = yield* gateway.execute(
            envelope(commandId, trustedPayload),
            { _tag: "External", principal },
            authorityFor(commandId),
          );
          const replay = yield* gateway.execute(
            envelope(commandId, trustedPayload),
            { _tag: "External", principal },
            authorityFor(commandId),
          );
          const stale = yield* gateway.execute(
            envelope(retryCommandId, trustedPayload),
            { _tag: "External", principal },
            authorityFor(retryCommandId),
          );
          const rows = yield* sql.unsafe<{
            decisions: number;
            receipts: number;
            events: number;
          }>(
            `SELECT
              (SELECT COUNT(*) FROM sandbox_policy_decisions WHERE execution_id = ?) AS decisions,
              (SELECT COUNT(*) FROM commands WHERE command_id IN (?, ?)) AS receipts,
              (SELECT COUNT(*) FROM domain_events WHERE event_type = 'SandboxPolicyDecisionRecorded') AS events`,
            [executionId, commandId, retryCommandId],
          );
          return { first, replay, stale, counts: rows[0] };
        }),
        stack.app,
      ),
    );
    expect(result.first.resolution._tag).toBe("Committed");
    expect(result.replay.resolution).toEqual(result.first.resolution);
    expect(result.stale.resolution).toMatchObject({
      _tag: "TerminalRejected",
      error: {
        _tag: "StaleSandboxPolicyInputs",
        safeDetails: { field: "PolicyRevision" },
      },
    });
    expect(result.counts).toEqual({ decisions: 1, receipts: 2, events: 1 });
  });

  it("survives child-process kills immediately before and after the SQLite commit", async () => {
    const folder = mkdtempSync(join(tmpdir(), "arbor-sandbox-decision-crash-"));
    const childPath = fileURLToPath(
      new URL(
        "./sandbox-policy-decision-gateway.crash-child.ts",
        import.meta.url,
      ),
    );
    const launch = (databaseFile: string, stage: string, nonce: string) =>
      spawnSync(
        process.execPath,
        ["--experimental-strip-types", childPath, databaseFile, stage, nonce],
        { encoding: "utf8", timeout: 30_000 },
      );
    const expectChildHandshake = (
      result: ReturnType<typeof launch>,
      nonce: string,
      stage: string,
    ) => {
      const escapedNonce = nonce.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      const marker = new RegExp(
        `^ARBOR_SANDBOX_GATEWAY_KILL_V1:${escapedNonce}:${stage}:([0-9]+)$`,
        "gmu",
      );
      const matches = [...result.stdout.matchAll(marker)];
      expect(matches, JSON.stringify(result)).toHaveLength(1);
      expect(matches[0]?.[1]).toBe(String(result.pid));
    };
    const expectExactKillResult = (result: ReturnType<typeof launch>) => {
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe("");
      if (process.platform === "win32") {
        expect(result.status).toBe(1);
        expect(result.signal).toBeNull();
      } else {
        expect(result.signal).toBe("SIGKILL");
        expect([null, 137]).toContain(result.status);
      }
    };
    const readCounts = Effect.gen(function* () {
      const sql = yield* SqlClient;
      return yield* sql.unsafe<{
        decisions: number;
        receipts: number;
        events: number;
      }>(
        `SELECT
          (SELECT COUNT(*) FROM sandbox_policy_decisions WHERE decision_command_id = 'cmd_018f2b3c-4d5e-7abc-8def-0123456789a3') AS decisions,
          (SELECT COUNT(*) FROM commands WHERE command_id = 'cmd_018f2b3c-4d5e-7abc-8def-0123456789a3') AS receipts,
          (SELECT COUNT(*) FROM domain_events WHERE event_type = 'SandboxPolicyDecisionRecorded') AS events`,
      );
    });
    try {
      const beforeDb = join(folder, "before.db");
      const beforeStack = makeTestStack({}, beforeDb);
      await Effect.runPromise(
        Effect.provide(seedSchema50AndGrant, beforeStack.app),
      );
      const beforeNonce = randomUUID();
      const before = launch(beforeDb, "before-commit", beforeNonce);
      expectChildHandshake(before, beforeNonce, "before-commit");
      expectExactKillResult(before);
      expect(
        await Effect.runPromise(Effect.provide(readCounts, beforeStack.app)),
      ).toEqual([{ decisions: 0, receipts: 0, events: 0 }]);

      const afterDb = join(folder, "after.db");
      const afterStack = makeTestStack({}, afterDb);
      await Effect.runPromise(
        Effect.provide(seedSchema50AndGrant, afterStack.app),
      );
      const afterNonce = randomUUID();
      const after = launch(afterDb, "after-commit", afterNonce);
      expectChildHandshake(after, afterNonce, "after-commit");
      expectExactKillResult(after);
      expect(
        await Effect.runPromise(Effect.provide(readCounts, afterStack.app)),
      ).toEqual([{ decisions: 1, receipts: 1, events: 1 }]);
      const replayNonce = randomUUID();
      const replay = launch(afterDb, "replay", replayNonce);
      expectChildHandshake(replay, replayNonce, "replay");
      expect(replay.status).toBe(0);
      expect(replay.signal).toBeNull();
      expect(replay.stderr).toBe("");
      expect(
        await Effect.runPromise(Effect.provide(readCounts, afterStack.app)),
      ).toEqual([{ decisions: 1, receipts: 1, events: 1 }]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

const makeAuthority = (
  fingerprint: ReturnType<typeof semanticRequestFingerprint>,
  id = commandId,
) => ({
  _tag: "SandboxPolicyDecisionAuthority" as const,
  principal,
  commandId: id,
  semanticRequestFingerprint: fingerprint,
  projectId,
  workspaceId,
  executionId,
  episodeBinding,
  episodeRevision: 2,
  permissionGrant: grant,
  issuerProvenance: provenance,
  authorityBundleRevision: 4,
  authorityBundleDigest: "e".repeat(64),
  providerRegistryRevision: 3,
  providerRegistryDigest: "2".repeat(64),
  operatorConfigRevision: 4,
  operatorConfigDigest: "f".repeat(64),
});

const seed = (sql: SqlClient) =>
  Effect.gen(function* () {
    yield* sql.unsafe(
      `INSERT INTO projects (project_id, name, root_workspace_id, project_policy,
        project_policy_revision, default_configuration, environment_ref, lifecycle,
        revision, created_at, updated_at)
       VALUES (?, 'sandbox-test', ?, '{}', 0, '{}', 'env:test', 'Open', 1, ?, ?)`,
      [projectId, workspaceId, now, now],
    );
    yield* sql.unsafe(
      `INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id,
        context_epoch, created_at)
       VALUES (?, 'WorkspacePrimary', ?, NULL, 0, ?)`,
      [sessionId, workspaceId, now],
    );
    yield* sql.unsafe(
      `INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name,
        responsibility_definition, responsibility_revision, resource_boundary,
        resource_boundary_revision, agent_binding, primary_session_id, current_work_id,
        workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at)
       VALUES (?, ?, NULL, 'sandbox-test', ?, 1, ?, 1, ?, ?, NULL, '{}', 0, 3, 'Active', ?, ?)`,
      [
        workspaceId,
        projectId,
        JSON.stringify({
          purpose: "test",
          ownedResponsibilities: [],
          obligations: [],
          includes: [],
          excludes: [],
          interfaces: [],
        }),
        JSON.stringify({ basisResponsibilityRevision: 1, addresses: [] }),
        JSON.stringify({
          _tag: "ResponsibilityBoundAgentBinding",
          workspaceId,
        }),
        sessionId,
        now,
        now,
      ],
    );
    yield* sql.unsafe(
      `INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id,
        episode_kind, episode_ref, episode_revision, parent_execution_id, mission,
        session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at)
       VALUES (?, ?, 'workspace', ?, 'WorkEpisode', ?, 2, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL)`,
      [executionId, projectId, workspaceId, workId, sessionId, now],
    );
  });

const seedManagedWorktree = (sql: SqlClient, path: string) =>
  Effect.gen(function* () {
    const resourceBoundary = {
      basisResponsibilityRevision: 1,
      addresses: [{ _tag: "GitWorktree", path }],
    };
    yield* sql.unsafe(
      "UPDATE workspaces SET resource_boundary = ?, resource_boundary_revision = 1, responsibility_revision = 1 WHERE workspace_id = ?",
      [JSON.stringify(resourceBoundary), workspaceId],
    );
    yield* sql.unsafe(
      `INSERT INTO worktrees (
        worktree_id, project_id, workspace_id, path, repository_ref, branch,
        state, created_at, retired_at
      ) VALUES (?, ?, ?, ?, NULL, NULL, 'Active', ?, NULL)`,
      ["wt_sandbox_policy", projectId, workspaceId, path, now],
    );
  });
