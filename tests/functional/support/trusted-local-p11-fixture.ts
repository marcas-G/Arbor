import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer } from "effect";
import {
  ClockLive,
  layer as sqliteLayer,
  TransactionPortLive,
  WorkspaceRepositoryLive,
  WorktreeStoreLive,
} from "../../../adapters/persistence-sqlite/src/index.js";
import {
  TransactionPort,
  WorkspaceRepository,
  WorktreeStore,
} from "../../../packages/ports/src/index.js";
import type { ProductionFixtureSetupProbeEvent } from "./production-fixture.js";
import {
  functionalId,
  type PublicClient,
  waitForPublic,
} from "./public-client.js";
import {
  sandboxPolicyV2TestPair,
  writeSandboxPolicyV2TestPair,
} from "./sandbox-policy-v2-source.js";

export interface TrustedLocalP11CandidateRead {
  readonly commonPreconditions: {
    readonly episodeBinding: Record<string, unknown>;
    readonly expectedEpisodeRevision: number;
    readonly latestCommittedPolicyRevision: number;
    readonly workspaceRevision: number;
    readonly resourceBoundaryRevision: number;
    readonly authorityBundleRevision: number;
    readonly authorityBundleDigest: string;
    readonly operatorConfigRevision: number;
    readonly operatorConfigDigest: string;
  };
  readonly candidates: ReadonlyArray<{
    readonly kind: string;
    readonly candidateId: string;
    readonly sandboxHandleBindingDigest: string;
  }>;
}

interface WorkspaceDetailForP11 {
  readonly sandboxPolicyCandidateRead?: TrustedLocalP11CandidateRead;
}

export const createTrustedLocalP11FixtureEnvironment = () => {
  const daemonEnvironment: Record<string, string> = {
    ARBOR_AUTH_TOKENS: "local=user:local,operator=user:operator",
  };
  const setupProbe = async (event: ProductionFixtureSetupProbeEvent) => {
    if (event.stage !== "after-clone") return;
    const sourceDirectory = resolve(
      event.directory,
      "sandbox-policy-v2-source",
    );
    const sourcePair = sandboxPolicyV2TestPair({
      bundleRevision: 1,
      registryRevision: 1,
    });
    daemonEnvironment.ARBOR_SANDBOX_AUTHORITY_SOURCE_FILE =
      writeSandboxPolicyV2TestPair(sourceDirectory, sourcePair);
  };
  return { daemonEnvironment, setupProbe };
};

/** Create the exact P11 primary GitWorktree that the public decision will bind. */
export const initializeTrustedLocalP11Worktree = async (input: {
  readonly databaseFile: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly path: string;
}) => {
  execFileSync("git", ["init", "--quiet"], {
    cwd: input.path,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "Arbor Test"], {
    cwd: input.path,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.email", "arbor-test@example.invalid"], {
    cwd: input.path,
    stdio: "ignore",
  });
  execFileSync("git", ["add", "proof.txt"], {
    cwd: input.path,
    stdio: "ignore",
  });
  execFileSync("git", ["commit", "--quiet", "-m", "P11 lease fixture"], {
    cwd: input.path,
    stdio: "ignore",
  });

  const infra = Layer.mergeAll(
    sqliteLayer({ filename: input.databaseFile }),
    ClockLive,
  );
  const app = Layer.mergeAll(
    infra,
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(WorktreeStoreLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
  );
  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const tx = yield* TransactionPort;
        const workspaces = yield* WorkspaceRepository;
        const worktrees = yield* WorktreeStore;
        const workspace = yield* tx.transact(
          workspaces.findById(input.workspaceId as never),
        );
        if (workspace._tag === "None")
          throw new Error("P11 fixture Workspace is absent");
        const current = workspace.value;
        const nextWorkspaceRevision = current.revision + 1;
        const nextBoundaryRevision = current.resourceBoundaryRevision + 1;
        yield* tx.transact(
          Effect.gen(function* () {
            yield* workspaces.updateResourceBoundaryIfRevision(
              input.workspaceId as never,
              current.revision,
              {
                basisResponsibilityRevision: current.responsibilityRevision,
                addresses: [{ _tag: "GitWorktree" as const, path: input.path }],
              },
              nextBoundaryRevision as never,
              nextWorkspaceRevision as never,
            );
            yield* worktrees.insert({
              worktreeId: functionalId("wt") as never,
              projectId: input.projectId as never,
              workspaceId: input.workspaceId as never,
              address: { _tag: "GitWorktree", path: input.path },
              state: "Active",
              createdAt: new Date().toISOString(),
            });
          }),
        );
      }),
      app,
    ),
  );
};

export const grantTrustedLocalP11Permission = async (input: {
  readonly client: PublicClient;
  readonly projectId: string;
  readonly executionId: string;
  readonly expiresAt: string;
}) =>
  input.client.command(input.projectId, "GrantPermission", {
    permissionGrantId: functionalId("pgr"),
    issuer: "user:local",
    subject: { _tag: "HumanPrincipal", principal: "user:operator" },
    capability: "DecideSandboxPolicy",
    target: input.executionId,
    expiresAt: input.expiresAt,
  });

export const commitTrustedLocalP11Policy = async (input: {
  readonly client: PublicClient;
  readonly baseUrl: string;
  readonly databaseFile: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly executionId: string;
  readonly expiresAt: string;
}) => {
  const detail = await waitForPublic(
    () =>
      input.client.view<WorkspaceDetailForP11>("workspace-detail", {
        workspaceId: input.workspaceId,
      }),
    (value) => value.sandboxPolicyCandidateRead !== undefined,
    45_000,
  );
  const read = detail.sandboxPolicyCandidateRead;
  if (read === undefined)
    throw new Error("P11 candidate read disappeared after wait");
  const candidate = read.candidates.find(
    (entry) => entry.kind === "TrustedLocalUnconfinedV1",
  );
  if (candidate === undefined)
    throw new Error("P11 candidate read lacks TrustedLocal FullAccess");
  const payload = {
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    executionId: input.executionId,
    episodeBinding: read.commonPreconditions.episodeBinding,
    expectedEpisodeRevision: read.commonPreconditions.expectedEpisodeRevision,
    expectedPolicyRevision:
      read.commonPreconditions.latestCommittedPolicyRevision,
    expectedWorkspaceRevision: read.commonPreconditions.workspaceRevision,
    expectedResourceBoundaryRevision:
      read.commonPreconditions.resourceBoundaryRevision,
    expectedSandboxHandleBindingDigest: candidate.sandboxHandleBindingDigest,
    expectedAuthorityBundleRevision:
      read.commonPreconditions.authorityBundleRevision,
    expectedAuthorityBundleDigest:
      read.commonPreconditions.authorityBundleDigest,
    expectedOperatorConfigRevision:
      read.commonPreconditions.operatorConfigRevision,
    expectedOperatorConfigDigest: read.commonPreconditions.operatorConfigDigest,
    profile: "FullAccess",
    providerId: "TrustedLocal",
    networkPolicy: { kind: "TrustedLocalUnconfinedV1", version: 1 },
    decisionExpiresAt: input.expiresAt,
  };
  const response = await fetch(`${input.baseUrl}/commands`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer operator",
    },
    body: JSON.stringify({
      commandType: "DecideSandboxPolicy",
      commandId: functionalId("cmd"),
      projectId: input.projectId,
      actor: "user:operator",
      issuedAt: new Date().toISOString(),
      payload,
    }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (
    !response.ok ||
    (body.body as { readonly resolution?: string } | undefined)?.resolution !==
      "Committed"
  ) {
    throw new Error(
      `DecideSandboxPolicy did not commit: ${JSON.stringify(body)}`,
    );
  }
  const snapshot = readCommittedTrustedLocalP11Snapshot(
    input.databaseFile,
    input.executionId,
  );
  if (
    snapshot?.kind !== "TrustedLocalUnconfinedV1" ||
    snapshot.executionId !== input.executionId ||
    snapshot.workspaceId !== input.workspaceId ||
    snapshot.profile !== "FullAccess" ||
    snapshot.episodeBinding === undefined
  ) {
    throw new Error(
      `committed P11 snapshot is not bound to the exact execution/workspace: ${JSON.stringify(snapshot)}`,
    );
  }
  const mounts = Array.isArray(snapshot.mounts)
    ? (snapshot.mounts as Array<Record<string, unknown>>)
    : [];
  if (
    !mounts.some(
      (mount) =>
        mount.mountId === "workspace" &&
        typeof mount.targetRef === "object" &&
        mount.targetRef !== null &&
        "resourceSpace" in mount.targetRef &&
        mount.targetRef.resourceSpace === "filesystem" &&
        mount.access === "ReadWrite",
    )
  ) {
    throw new Error("committed P11 snapshot omitted writable workspace mount");
  }
  return { snapshot, read };
};

export const readCommittedTrustedLocalP11Snapshot = (
  databaseFile: string,
  executionId: string,
): Record<string, unknown> | undefined => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const row = db
      .prepare(
        `SELECT c.result_json FROM sandbox_policy_decisions d
           JOIN commands c ON c.command_id = d.decision_command_id
          WHERE d.execution_id = ? ORDER BY d.policy_revision DESC LIMIT 1`,
      )
      .get(executionId) as { readonly result_json?: string | null } | undefined;
    if (row?.result_json === undefined || row.result_json === null)
      return undefined;
    const result = JSON.parse(row.result_json) as {
      readonly effectivePolicySnapshot?: unknown;
    };
    if (
      typeof result.effectivePolicySnapshot !== "object" ||
      result.effectivePolicySnapshot === null ||
      Array.isArray(result.effectivePolicySnapshot)
    ) {
      return undefined;
    }
    return result.effectivePolicySnapshot as Record<string, unknown>;
  } finally {
    db.close();
  }
};
