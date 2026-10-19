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
  SandboxPolicyDecisionStoreLive,
  TransactionPortLive,
} from "@arbor/persistence-sqlite";
import {
  Clock,
  CommandStore,
  ExecutionRepository,
  PermissionGrantRepository,
  SandboxPolicyDecisionStore,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";

const [databaseFile, requestedStage] = process.argv.slice(2);
if (databaseFile === undefined || requestedStage === undefined) {
  throw new Error("database filename and stage are required");
}
const stage = requestedStage;
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
  expectedSandboxHandleBindingDigest: "c".repeat(64),
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
const snapshot = {
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
      targetRef: "target_workspace",
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
const executions = Layer.provide(ExecutionRepositoryLive, infra);
const grants = Layer.provide(PermissionGrantRepositoryLive, infra);
const repos = Layer.mergeAll(
  transaction,
  commandStore,
  eventJournal,
  decisions,
  projects,
  executions,
  grants,
);
const registry = Layer.provide(
  Layer.unwrap(
    Effect.gen(function* () {
      const grantRepo = yield* PermissionGrantRepository;
      const executionRepo = yield* ExecutionRepository;
      const decisionStore = yield* SandboxPolicyDecisionStore;
      const clock = yield* Clock;
      const handler = makeDecideSandboxPolicyHandler({
        grants: grantRepo,
        executions: executionRepo,
        decisions: decisionStore,
        preparation: {
          prepare: () => Effect.succeed(snapshot),
          currentPreconditions: () =>
            Effect.succeed({
              kind: "TrustedLocalUnconfinedV1" as const,
              expectedEpisodeRevision: 2,
              latestCommittedPolicyRevision: 0,
              episodeBinding,
              workspaceRevision: 3,
              resourceBoundaryRevision: 1,
              sandboxHandleBindingDigest:
                payload.expectedSandboxHandleBindingDigest,
              authorityBundleRevision: 4,
              authorityBundleDigest: "e".repeat(64),
              operatorConfigRevision: 4,
              operatorConfigDigest: "f".repeat(64),
            }),
        },
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
          process.kill(process.pid, "SIGKILL");
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
  if (stage === "after-commit") process.kill(process.pid, "SIGKILL");
  void grantRepository;
});

Effect.runPromise(Effect.provide(program, app)).catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 2;
});
