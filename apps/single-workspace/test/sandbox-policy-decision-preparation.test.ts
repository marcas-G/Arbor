import type { DecideSandboxPolicyPayload } from "@arbor/application";
import type {
  CanonicalResourceRegion,
  Execution,
  ResourceAddress,
  ResourceBoundary,
  SandboxAuthorityBundleSnapshotV2,
  Workspace,
} from "@arbor/domain";
import {
  CommandId,
  ExecutionId,
  Principal,
  ProjectId,
  parse,
  WorkspaceId,
} from "@arbor/domain";
import type {
  EnvironmentResolverService,
  ResourceOwnershipClaimRecord,
  TransactionOperationalFailure,
  TransactionPortService,
  WorktreeRecord,
} from "@arbor/ports";
import { TransactionScope } from "@arbor/ports";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import type { SandboxPolicyDecisionPreparationDependencies } from "../src/sandbox-policy-decision-preparation.js";
import { makeSandboxPolicyDecisionPreparation } from "../src/sandbox-policy-decision-preparation.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const commandId = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789a1");
const episodeBinding = {
  _tag: "InboxEpisode" as const,
  entryKey: "inbox:policy",
  inputKind: "HumanMessage" as const,
};
const primaryAddress: ResourceAddress = {
  _tag: "GitWorktree",
  path: "/repo/workspace",
};
const boundary = {
  basisResponsibilityRevision: 0 as never,
  addresses: [primaryAddress],
} as ResourceBoundary;
const workspace = {
  workspaceId,
  projectId,
  lifecycle: "Active",
  revision: 8,
  responsibilityRevision: 0,
  resourceBoundaryRevision: 4,
  resourceBoundary: boundary,
} as Workspace;
const execution = {
  executionId,
  projectId,
  workspaceId,
  binding: { _tag: "WorkspaceExecution", workspaceId, episode: episodeBinding },
  sessionId: "ses_policy" as never,
  admittedAt: "2026-10-19T00:00:00.000Z",
  stopRequestedAt: null,
  state: { status: "Active", settlement: null },
} as Execution;
const primaryWorktree: WorktreeRecord = {
  worktreeId: "wt_primary",
  projectId,
  workspaceId,
  address: primaryAddress as Extract<ResourceAddress, { _tag: "GitWorktree" }>,
  state: "Active",
  createdAt: "2026-10-18T00:00:00.000Z",
};

const limits = {
  wallTimeMs: 60_000,
  stdoutBytes: 8192,
  stderrBytes: 8192,
  processCount: 4,
  memoryBytes: 128 * 1024 * 1024,
  cpuTimeMs: 30_000,
};
const operatorConfig = {
  version: 1 as const,
  revision: 2,
  environmentAllowlist: ["PATH"],
  limitsByProfile: [
    { profile: "ReadOnly" as const, limits },
    { profile: "WorkspaceWrite" as const, limits },
    { profile: "FullAccess" as const, limits },
  ],
  trustedLocalRuntimeVersion: "builtin-v1" as const,
};
const authorityBundleSnapshot = {
  bundle: {
    version: 2 as const,
    sourceIdentity: "host:test",
    bundleRevision: 5,
    issuerConfigRevision: 1,
    issuerConfigDigest: "1".repeat(64),
    issuerConfig: {
      version: 1 as const,
      revision: 1,
      issuers: [parse(Principal)("user:operator")],
    },
    operatorConfigRevision: operatorConfig.revision,
    operatorConfigDigest: "2".repeat(64),
    operatorConfig,
    providerRegistryRevision: 3,
    providerRegistryDigest: "3".repeat(64),
    providerRegistry: { version: 1 as const, revision: 3, entries: [] },
  },
  bundleDigest: "4".repeat(64),
  canonicalJson: "{}",
};

const payload = (
  overrides: Partial<DecideSandboxPolicyPayload> = {},
): DecideSandboxPolicyPayload => ({
  projectId,
  workspaceId,
  executionId,
  episodeBinding,
  expectedEpisodeRevision: 2,
  expectedPolicyRevision: 0,
  expectedWorkspaceRevision: 8,
  expectedResourceBoundaryRevision: 4,
  expectedSandboxHandleBindingDigest: "5".repeat(64),
  expectedAuthorityBundleRevision: 5,
  expectedAuthorityBundleDigest: "4".repeat(64),
  expectedOperatorConfigRevision: operatorConfig.revision,
  expectedOperatorConfigDigest: "2".repeat(64),
  providerId: "TrustedLocal",
  profile: "FullAccess",
  networkPolicy: { kind: "TrustedLocalUnconfinedV1", version: 1 },
  decisionExpiresAt: "2026-10-19T12:00:00.000Z",
  ...overrides,
});

const authority = {
  _tag: "SandboxPolicyDecisionAuthority",
  principal: "user:subject",
  commandId,
  semanticRequestFingerprint: "a".repeat(64),
  projectId,
  workspaceId,
  executionId,
  episodeBinding,
  episodeRevision: 2,
  permissionGrant: {} as never,
  issuerProvenance: {} as never,
  authorityBundleRevision: 5,
  authorityBundleDigest: "4".repeat(64),
  providerRegistryRevision: 3,
  providerRegistryDigest: "3".repeat(64),
  operatorConfigRevision: operatorConfig.revision,
  operatorConfigDigest: "2".repeat(64),
} as never;

const resolvedRegion = (address: ResourceAddress): CanonicalResourceRegion => {
  if (address._tag === "GitWorktree")
    return {
      resourceSpaceId: "filesystem",
      normalizedRegion: { kind: "GitWorktree", path: address.path },
    };
  throw new Error("unexpected fixture address");
};

const resolver: EnvironmentResolverService = {
  observe: (projectId, addresses) =>
    Effect.succeed({
      projectId,
      observedRevision: "0",
      fingerprint: "0".repeat(64) as never,
      snapshotBlobRef: "blob:test",
      changedRegions: addresses.map(resolvedRegion),
      entries: addresses.map((address) => ({
        address,
        resolved: resolvedRegion(address),
        probe: {} as never,
      })),
    }),
};

const fixture = (
  mutate?: (state: {
    workspace: Workspace;
    claims: ResourceOwnershipClaimRecord[];
    worktrees: WorktreeRecord[];
    latestPolicyRevision: number;
  }) => void,
  environmentResolver: EnvironmentResolverService = resolver,
  authoritySnapshotOverride: SandboxAuthorityBundleSnapshotV2 | null = authorityBundleSnapshot,
) => {
  const state = {
    workspace,
    claims: [] as ResourceOwnershipClaimRecord[],
    worktrees: [primaryWorktree],
    latestPolicyRevision: 0,
  };
  let transactionActive = false;
  const transaction: TransactionPortService = {
    transact: <A, E, R>(body: Effect.Effect<A, E, R | TransactionScope>) => {
      const run = Effect.suspend(() => {
        if (transactionActive)
          return Effect.fail({
            _tag: "TransactionOperationalFailure",
            cause: "nested transaction rejected by test sentinel",
          } satisfies TransactionOperationalFailure) as Effect.Effect<
            A,
            E | TransactionOperationalFailure,
            Exclude<R, TransactionScope>
          >;
        transactionActive = true;
        return Effect.ensuring(
          Effect.provideService(body, TransactionScope, {
            session: { id: "preparation-test" },
          }),
          Effect.sync(() => {
            transactionActive = false;
          }),
        );
      });
      return run as Effect.Effect<
        A,
        E | TransactionOperationalFailure,
        Exclude<R, TransactionScope>
      >;
    },
  };
  const dependencies: SandboxPolicyDecisionPreparationDependencies = {
    transaction,
    workspaces: {
      findById: () => Effect.succeed(Option.some(state.workspace)),
    } as never,
    executions: {
      findById: () => Effect.succeed(Option.some(execution)),
      findEpisodeRevision: () => Effect.succeed(Option.some(2)),
    } as never,
    decisions: {
      findCurrentForExecution: () =>
        Effect.succeed(
          state.latestPolicyRevision === 0
            ? Option.none()
            : Option.some({
                decision: { policyRevision: state.latestPolicyRevision },
                result: {} as never,
              }),
        ),
    } as never,
    ownership: {
      listActiveByWorkspace: () => Effect.succeed(state.claims),
    } as never,
    worktrees: {
      findByWorkspace: () => Effect.succeed(state.worktrees),
    } as never,
    environmentResolver,
    authoritySnapshot: authoritySnapshotOverride ?? undefined,
  };
  mutate?.(state);
  return {
    preparation: makeSandboxPolicyDecisionPreparation(dependencies),
    transaction,
    state,
  };
};

describe("production sandbox decision materializer", () => {
  it("materializes TrustedLocal from one V2 bundle and complete P11 boundary", async () => {
    const { preparation, transaction } = fixture();
    const request = payload();
    const prepared = await Effect.runPromise(
      preparation.prepare(request, authority),
    );
    expect(prepared).toMatchObject({
      kind: "TrustedLocalUnconfinedV1",
      profile: "FullAccess",
      trustedRuntimeIdentity: "TrustedLocal",
      trustedRuntimeVersion: "builtin-v1",
      environmentAllowlist: ["PATH"],
      limits,
      authorityBundleRevision: 5,
      authorityBundleDigest: "4".repeat(64),
      operatorConfigRevision: 2,
      operatorConfigDigest: "2".repeat(64),
      auditRefs: [String(commandId)],
    });
    expect(JSON.stringify(prepared)).not.toContain("/repo/workspace");
    expect(prepared.sandboxHandleBindingDigest).not.toBe("5".repeat(64));
    const current = await Effect.runPromise(
      transaction.transact(preparation.currentPreconditions(request)),
    );
    expect(current.sandboxHandleBindingDigest).toBe(
      prepared.sandboxHandleBindingDigest,
    );
    expect(current.kind).toBe("TrustedLocalUnconfinedV1");
  });

  it("fails closed for missing, duplicate, or retired managed worktrees", async () => {
    for (const worktrees of [
      [],
      [primaryWorktree, { ...primaryWorktree, worktreeId: "wt_duplicate" }],
      [{ ...primaryWorktree, state: "Retired" as const }],
    ]) {
      const { preparation } = fixture((state) => {
        state.worktrees = worktrees;
      });
      const outcome = await Effect.runPromise(
        Effect.match(preparation.prepare(payload(), authority), {
          onFailure: (error) => ({ _tag: "Left" as const, error }),
          onSuccess: (value) => ({ _tag: "Right" as const, value }),
        }),
      );
      expect(outcome._tag).toBe("Left");
    }
  });

  it("never downgrades an OsEnforced request to TrustedLocal", async () => {
    const { preparation } = fixture();
    const outcome = await Effect.runPromise(
      Effect.match(
        preparation.prepare(
          payload({
            providerId: "bwrap",
            profile: "ReadOnly",
            networkPolicy: {
              kind: "OsEnforced",
              policy: { version: 1, mode: "Disabled", destinations: [] },
            },
          }),
          authority,
        ),
        {
          onFailure: (error) => ({ _tag: "Left" as const, error }),
          onSuccess: (value) => ({ _tag: "Right" as const, value }),
        },
      ),
    );
    expect(outcome).toMatchObject({
      _tag: "Left",
      error: { _tag: "TransactionOperationalFailure" },
    });
  });

  it("fails closed when the startup V2 authority snapshot is unavailable", async () => {
    const { preparation } = fixture(undefined, resolver, null);
    const outcome = await Effect.runPromise(
      Effect.match(preparation.prepare(payload(), authority), {
        onFailure: (error) => ({ _tag: "Left" as const, error }),
        onSuccess: (value) => ({ _tag: "Right" as const, value }),
      }),
    );
    expect(outcome).toMatchObject({
      _tag: "Left",
      error: { _tag: "TransactionOperationalFailure" },
    });
  });

  it("rejects inconsistent P11 observation entries and normalized region set", async () => {
    const inconsistentResolver: EnvironmentResolverService = {
      observe: (project, addresses) =>
        resolver.observe(project, addresses).pipe(
          Effect.map((observation) => ({
            ...observation,
            changedRegions: [],
          })),
        ),
    };
    const { preparation } = fixture(undefined, inconsistentResolver);
    const result = await Effect.runPromise(
      Effect.match(preparation.prepare(payload(), authority), {
        onFailure: (error) => ({ _tag: "Left" as const, error }),
        onSuccess: (value) => ({ _tag: "Right" as const, value }),
      }),
    );
    expect(result).toMatchObject({
      _tag: "Left",
      error: { _tag: "TransactionOperationalFailure" },
    });
  });
});
