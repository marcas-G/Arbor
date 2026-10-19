import {
  CommandGateway,
  CommandHandlerRegistryLive,
  FenceStopCheckInertLive,
  makeCommandGatewayLive,
  makeDecideSandboxPolicyHandler,
  semanticRequestFingerprint,
} from "@arbor/application";
import {
  Actor,
  CommandId,
  ExecutionId,
  PermissionGrantId,
  Principal,
  ProjectId,
  parse,
  type SandboxAuthorityBundleSnapshotV2,
  WorkId,
  WorkspaceId,
} from "@arbor/domain";
import {
  ClockLive,
  CommandStoreLive,
  DomainEventJournalLive,
  ExecutionRepositoryLive,
  IdGeneratorLive,
  layer,
  PermissionGrantRepositoryLive,
  ProjectRepositoryLive,
  ResourceOwnershipRepositoryLive,
  SandboxPolicyDecisionStoreLive,
  TransactionPortLive,
  WorkspaceRepositoryLive,
  WorktreeStoreLive,
} from "@arbor/persistence-sqlite";
import {
  Clock,
  CommandStore,
  EnvironmentResolverPort,
  ExecutionRepository,
  PermissionGrantRepository,
  ResourceOwnershipRepository,
  SandboxPolicyDecisionStore,
  TransactionPort,
  WorkspaceRepository,
  WorktreeStore,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { makeSandboxPolicyDecisionPreparation } from "../dist/sandbox-policy-decision-preparation.js";

const [
  databaseFile,
  requestedStage,
  nonce,
  worktreePath,
  expectedHandleDigest,
] = process.argv.slice(2);
if (
  databaseFile === undefined ||
  requestedStage === undefined ||
  nonce === undefined ||
  worktreePath === undefined ||
  expectedHandleDigest === undefined
) {
  throw new Error("database filename, stage, and nonce are required");
}
const stage = requestedStage;
const emitHandshake = (markerStage: string, kill: boolean) =>
  new Promise<void>((resolve) => {
    process.stdout.write(
      `ARBOR_SANDBOX_GATEWAY_KILL_V1:${nonce}:${markerStage}:${process.pid}\n`,
      () => {
        if (!kill) {
          resolve();
          return;
        }
        try {
          if (!process.kill(process.pid, "SIGKILL")) {
            throw new Error("process.kill returned false");
          }
        } catch (error) {
          process.stderr.write(
            `ARBOR_SANDBOX_GATEWAY_KILL_FAILED_V1:${nonce}:${markerStage}:${String(error)}\n`,
            () => process.exit(86),
          );
        }
      },
    );
  });
const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const commandId = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789a3");
const grantId = parse(PermissionGrantId)(
  "pgr_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const grantCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789a2",
);
const operator = parse(Principal)("user:operator");
const principal = parse(Principal)("user:subject");
const actor = parse(Actor)(String(principal));
const episodeBinding = {
  _tag: "WorkEpisode" as const,
  workId: parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789a1"),
  targetWorkRevision: 2 as never,
};
const grant = {
  permissionGrantId: grantId,
  scope: `DecideSandboxPolicy@${executionId}`,
  issuer: operator,
  lifetime: "Bounded",
  subject: { _tag: "HumanPrincipal" as const, principal },
  capability: "DecideSandboxPolicy",
  target: executionId,
  validFrom: "2026-10-18T00:00:00.000Z",
  expiresAt: "2099-10-20T00:00:00.000Z",
  revision: 1,
  state: "Active" as const,
};
const provenance = {
  permissionGrantId: grantId,
  grantPermissionCommandId: grantCommandId,
  issuerPrincipal: operator,
  operatorConfigRevision: 4,
  operatorConfigDigest: "f".repeat(64),
};
const payload = {
  projectId,
  workspaceId,
  executionId,
  episodeBinding,
  expectedEpisodeRevision: 2,
  expectedPolicyRevision: 0,
  expectedWorkspaceRevision: 3,
  expectedResourceBoundaryRevision: 1,
  expectedSandboxHandleBindingDigest: expectedHandleDigest,
  expectedAuthorityBundleRevision: 4,
  expectedAuthorityBundleDigest: "e".repeat(64),
  expectedOperatorConfigRevision: 4,
  expectedOperatorConfigDigest: "f".repeat(64),
  profile: "FullAccess" as const,
  providerId: "TrustedLocal",
  networkPolicy: {
    kind: "TrustedLocalUnconfinedV1" as const,
    version: 1 as const,
  },
  decisionExpiresAt: "2099-10-19T12:00:00.000Z",
};
const _snapshot = {
  version: 1 as const,
  kind: "TrustedLocalUnconfinedV1" as const,
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
  trustedRuntimeIdentity: "TrustedLocal" as const,
  trustedRuntimeVersion: "builtin-v1" as const,
  profile: "FullAccess" as const,
  networkBoundary: "Unconfined" as const,
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
const authoritySnapshot = {
  bundle: {
    version: 2 as const,
    sourceIdentity: "host:gateway-fixture",
    bundleRevision: 4,
    issuerConfigRevision: 1,
    issuerConfigDigest: "1".repeat(64),
    issuerConfig: {
      version: 1 as const,
      revision: 1,
      issuers: [operator],
    },
    operatorConfigRevision: 4,
    operatorConfigDigest: "f".repeat(64),
    operatorConfig: {
      version: 1 as const,
      revision: 4,
      environmentAllowlist: ["PATH"],
      limitsByProfile: [
        {
          profile: "ReadOnly" as const,
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
          profile: "WorkspaceWrite" as const,
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
          profile: "FullAccess" as const,
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
      trustedLocalRuntimeVersion: "builtin-v1" as const,
    },
    providerRegistryRevision: 3,
    providerRegistryDigest: "2".repeat(64),
    providerRegistry: { version: 1 as const, revision: 3, entries: [] },
  },
  bundleDigest: "e".repeat(64),
  canonicalJson: "{}",
} satisfies SandboxAuthorityBundleSnapshotV2;
const environmentResolverTestLayer = Layer.succeed(EnvironmentResolverPort, {
  observe: (projectId, addresses) => {
    const entries = addresses.map((address) => {
      if (address._tag !== "GitWorktree" && address._tag !== "FileTree")
        throw new Error("test P11 resolver only supports filesystem addresses");
      return {
        address,
        resolved: {
          resourceSpaceId: "filesystem",
          normalizedRegion:
            address._tag === "GitWorktree"
              ? { kind: "GitWorktree", path: address.path }
              : { kind: "FileTree", path: address.path },
        },
        probe: {} as never,
      };
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

function makeAuthority(
  fingerprint: ReturnType<typeof semanticRequestFingerprint>,
) {
  return {
    _tag: "SandboxPolicyDecisionAuthority" as const,
    principal,
    commandId,
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
  };
}

const base = layer({ filename: databaseFile });
const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
const transaction = Layer.provide(TransactionPortLive, infra);
const commandStore = Layer.provide(CommandStoreLive, infra);
const eventJournal = Layer.provide(DomainEventJournalLive, infra);
const decisions = Layer.provide(SandboxPolicyDecisionStoreLive, infra);
const projects = Layer.provide(ProjectRepositoryLive, infra);
const workspaces = Layer.provide(WorkspaceRepositoryLive, infra);
const ownership = Layer.provide(ResourceOwnershipRepositoryLive, infra);
const worktrees = Layer.provide(WorktreeStoreLive, infra);
const executions = Layer.provide(ExecutionRepositoryLive, infra);
const grants = Layer.provide(PermissionGrantRepositoryLive, infra);
const repos = Layer.mergeAll(
  transaction,
  commandStore,
  eventJournal,
  decisions,
  projects,
  workspaces,
  ownership,
  worktrees,
  executions,
  grants,
  environmentResolverTestLayer,
);
const registry = Layer.provide(
  Layer.unwrap(
    Effect.gen(function* () {
      const grantRepo = yield* PermissionGrantRepository;
      const executionRepo = yield* ExecutionRepository;
      const decisionStore = yield* SandboxPolicyDecisionStore;
      const transactionPort = yield* TransactionPort;
      const workspaceRepo = yield* WorkspaceRepository;
      const ownershipRepo = yield* ResourceOwnershipRepository;
      const worktreeStore = yield* WorktreeStore;
      const environmentResolver = yield* EnvironmentResolverPort;
      const clock = yield* Clock;
      const handler = makeDecideSandboxPolicyHandler({
        grants: grantRepo,
        executions: executionRepo,
        decisions: decisionStore,
        preparation: makeSandboxPolicyDecisionPreparation({
          transaction: transactionPort,
          workspaces: workspaceRepo,
          executions: executionRepo,
          decisions: decisionStore,
          ownership: ownershipRepo,
          worktrees: worktreeStore,
          environmentResolver,
          authoritySnapshot,
        }),
        clock,
      });
      return CommandHandlerRegistryLive([handler as never]);
    }),
  ),
  Layer.mergeAll(infra, repos),
);
const qualificationProbe =
  stage === "before-commit"
    ? async (event: { readonly boundary: string }) => {
        if (event.boundary === "SandboxPolicyDecisionBeforeCommit") {
          return emitHandshake("before-commit", true);
        }
      }
    : undefined;
const gateway = Layer.provide(
  makeCommandGatewayLive(qualificationProbe as never),
  Layer.mergeAll(infra, repos, registry, FenceStopCheckInertLive),
);
const app = Layer.mergeAll(
  infra,
  repos,
  registry,
  FenceStopCheckInertLive,
  gateway,
);

const program = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  const grantRepository = yield* PermissionGrantRepository;
  const commands = yield* CommandStore;
  const already = yield* tx.transact(commands.findResolution(commandId));
  const gatewayService = yield* CommandGateway;
  if (Option.isSome(already)) {
    const fingerprint = semanticRequestFingerprint({
      commandType: "DecideSandboxPolicy",
      projectId,
      actor,
      schemaVersion: "1",
      payload,
    });
    const replayed = yield* gatewayService.execute(
      {
        commandType: "DecideSandboxPolicy",
        commandId,
        projectId,
        actor,
        issuedAt: "1999-01-01T00:00:00.000Z",
        payload,
      },
      { _tag: "External", principal },
      makeAuthority(fingerprint),
    );
    if (replayed.resolution._tag !== "Committed") process.exitCode = 3;
    yield* Effect.promise(() => emitHandshake("replay", false));
    return;
  }
  const fingerprint = semanticRequestFingerprint({
    commandType: "DecideSandboxPolicy",
    projectId,
    actor,
    schemaVersion: "1",
    payload,
  });
  const receipt = yield* gatewayService.execute(
    {
      commandType: "DecideSandboxPolicy",
      commandId,
      projectId,
      actor,
      issuedAt: "1999-01-01T00:00:00.000Z",
      payload,
    },
    { _tag: "External", principal },
    makeAuthority(fingerprint),
  );
  if (receipt.resolution._tag !== "Committed") {
    process.exitCode = 2;
    return;
  }
  if (stage === "after-commit") {
    yield* Effect.promise(() => emitHandshake("after-commit", true));
  }
  void grantRepository;
});

Effect.runPromise(Effect.provide(program, app)).catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 2;
});
