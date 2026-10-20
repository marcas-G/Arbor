import { createHash, createPrivateKey, sign } from "node:crypto";
import { win32 } from "node:path";
import type { DecideSandboxPolicyPayload } from "@arbor/application";
import type {
  CanonicalResourceRegion,
  Execution,
  ResourceAddress,
  ResourceBoundary,
  SandboxAuthorityBundleSnapshotCurrent,
  Workspace,
} from "@arbor/domain";
import {
  CommandId,
  decodeCanonicalWindowsNativeOperatorTrustSetV1,
  decodeEffectivePolicySummaryV1,
  ExecutionId,
  encodeSandboxEnforcementRuleSetV1,
  encodeWindowsNativeManifestSignatureV1,
  Principal,
  ProjectId,
  parse,
  sandboxEnforcementRuleSetV1ForProvider,
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
import {
  encodeWindowsNativeArtifactManifestV1,
  fixedWindowsNativeProductionArtifactPaths,
  WINDOWS_NATIVE_PROCESS_HOST_COMPILER_ARGUMENTS_V1,
  type WindowsNativeArtifactManifestV1,
  type WindowsNativeQualificationIo,
} from "@arbor/sandbox-windows";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { sandboxPolicyCurrentHostV1 } from "../src/current-sandbox-authority-snapshot-port.js";
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

type TrustedLocalDecisionPayload = Extract<
  DecideSandboxPolicyPayload,
  { readonly networkPolicy: { readonly kind: "TrustedLocalUnconfinedV1" } }
>;
type OsEnforcedDecisionPayload = Extract<
  DecideSandboxPolicyPayload,
  { readonly networkPolicy: { readonly kind: "OsEnforced" } }
>;

const payload = (
  overrides: Partial<TrustedLocalDecisionPayload> = {},
): TrustedLocalDecisionPayload => ({
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

const osPayload = (
  overrides: Partial<OsEnforcedDecisionPayload> = {},
): OsEnforcedDecisionPayload => ({
  ...payload(),
  expectedProviderRegistryRevision: 3,
  expectedProviderRegistryDigest: "3".repeat(64),
  profile: "ReadOnly",
  providerId: "bwrap",
  providerVersion: "0.8.0",
  capabilityRevision: 1,
  networkPolicy: {
    kind: "OsEnforced",
    policy: { version: 1, mode: "Disabled", destinations: [] },
  },
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

const hash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

const makeSignedWindowsAuthority = () => {
  const host = sandboxPolicyCurrentHostV1();
  if (host === undefined || host.osFamily !== "Windows")
    throw new Error(
      "Windows host identity required by this qualification test",
    );
  const paths = fixedWindowsNativeProductionArtifactPaths();
  const providerId = "windows-restricted-appcontainer-job";
  const providerVersion = "t3d-v1";
  const capabilityRevision = 4;
  const ruleSet = sandboxEnforcementRuleSetV1ForProvider(providerId);
  if (ruleSet === undefined) throw new Error("provider ruleset missing");
  const ruleSetDigest = hash(encodeSandboxEnforcementRuleSetV1(ruleSet));
  const fileBytes = new Map<string, Buffer>([
    [paths.source, Buffer.from("fixed process host source")],
    [paths.compiler, Buffer.from("fixed framework compiler")],
    [paths.binary, Buffer.from("shipped PE bytes")],
    [
      win32.join(paths.testControlRoot, "control-token.artifact"),
      Buffer.from("control"),
    ],
  ]);
  const manifest: WindowsNativeArtifactManifestV1 = {
    version: 1,
    providerId,
    providerVersion,
    capabilityRevision,
    osFamily: "Windows",
    osBuild: host.osBuild,
    platformPrimitiveSetId:
      "windows-restricted-token-lowintegrity-appcontainer-job-namedpipe-v1",
    qualificationRows: [
      {
        profile: "ReadOnly",
        networkMode: "Disabled",
        networkPolicyCodecVersion: 1,
        enforcementRuleSetDigest: ruleSetDigest,
      },
    ],
    sourceSha256: hash(fileBytes.get(paths.source) ?? ""),
    compilerSha256: hash(fileBytes.get(paths.compiler) ?? ""),
    compilerVersion: "4.8.9037.0",
    compilerArgumentsSha256: hash(
      WINDOWS_NATIVE_PROCESS_HOST_COMPILER_ARGUMENTS_V1.join("\n"),
    ),
    binarySha256: hash(fileBytes.get(paths.binary) ?? ""),
    buildMethod: "fixed-framework64-csc",
    buildVersion: "1",
    testControlArtifactHashes: [
      { artifactId: "control-token", sha256: hash("control") },
    ],
    limits,
    operatorConfigRevision: operatorConfig.revision,
    operatorConfigDigest: "2".repeat(64),
    discoveryMethod: "fixed-windows-build-probe",
    discoveryVersion: "1",
    matrixResults: [{ matrixId: "disabled-readonly", result: "Pass" }],
    hostControls: [
      {
        controlId: "appcontainer-token",
        artifactId: "control-token",
        result: "Pass",
      },
    ],
  };
  const manifestBytes = Buffer.from(
    encodeWindowsNativeArtifactManifestV1(manifest),
  );
  fileBytes.set(paths.manifest, manifestBytes);
  const seed = Buffer.from(
    "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    "hex",
  );
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      seed,
    ]),
    format: "der",
    type: "pkcs8",
  });
  const signature = sign(
    null,
    Buffer.concat([
      Buffer.from("Arbor.WindowsNativeQualificationManifestV1\0", "ascii"),
      manifestBytes,
    ]),
    privateKey,
  );
  fileBytes.set(
    paths.signature,
    Buffer.from(
      encodeWindowsNativeManifestSignatureV1({
        version: 1,
        keyId: "operator-2026-a",
        signatureBase64: signature.toString("base64"),
      }),
    ),
  );
  const trust = decodeCanonicalWindowsNativeOperatorTrustSetV1(
    '{"version":1,"revision":1,"sourceIdentity":"host:test","providerId":"windows-restricted-appcontainer-job","keys":[{"keyId":"operator-2026-a","algorithm":"Ed25519","publicKeySpkiDerBase64":"MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=","publicKeySpkiSha256":"06e3fd8fda29bb60ab59557de61edb0aecdb231134be30e75b455f8e1b792fa9","validFrom":"2026-10-20T00:00:00.000Z","validUntil":"2027-10-20T00:00:00.000Z","status":"Active"}],"revokedKeyIds":[]}',
    (bytes) => hash(Buffer.from(bytes)),
  );
  if (trust === undefined) throw new Error("test trust-set KAT rejected");
  const row = {
    providerId,
    providerVersion,
    capabilityRevision,
    osFamily: host.osFamily,
    osBuild: host.osBuild,
    tuple: {
      profile: "ReadOnly" as const,
      networkMode: "Disabled" as const,
      networkPolicyCodecVersion: 1 as const,
      enforcementRuleSetDigest: ruleSetDigest,
    },
    status: "Supported" as const,
    qualificationEvidenceRef: `blob:sha256:${hash(manifestBytes)}`,
  };
  const snapshot = {
    ...authorityBundleSnapshot,
    bundle: {
      ...authorityBundleSnapshot.bundle,
      version: 3 as const,
      providerRegistry: { version: 1 as const, revision: 3, entries: [row] },
      windowsOperatorTrustSetRevision: 1,
      windowsOperatorTrustSetDigest: "5".repeat(64),
      windowsOperatorTrustSet: trust,
    },
  } satisfies SandboxAuthorityBundleSnapshotCurrent;
  const io: WindowsNativeQualificationIo = {
    lstat: (path) => ({
      isFile: () => fileBytes.has(path),
      isDirectory: () => false,
      isSymbolicLink: () => false,
    }),
    realpath: (path) => path,
    read: (path) => {
      const bytes = fileBytes.get(path);
      if (bytes === undefined) throw new Error("test artifact missing");
      return bytes;
    },
  };
  return { host, row, snapshot, io };
};

const fixture = (
  mutate?: (state: {
    workspace: Workspace;
    claims: ResourceOwnershipClaimRecord[];
    worktrees: WorktreeRecord[];
    latestPolicyRevision: number;
  }) => void,
  environmentResolver: EnvironmentResolverService = resolver,
  authoritySnapshotOverride: SandboxAuthorityBundleSnapshotCurrent | null = authorityBundleSnapshot,
  qualificationIo?: WindowsNativeQualificationIo,
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
    clock: { now: () => Effect.succeed("2026-10-20T00:00:00.000Z") },
    authoritySnapshot: authoritySnapshotOverride ?? undefined,
    ...(qualificationIo === undefined ? {} : { qualificationIo }),
  };
  mutate?.(state);
  return {
    preparation: makeSandboxPolicyDecisionPreparation(dependencies),
    transaction,
    state,
  };
};

describe("production sandbox decision materializer", () => {
  it("selects one exact Supported OS tuple only after V3 signed evidence verifies", async () => {
    const signed = makeSignedWindowsAuthority();
    const { preparation, transaction } = fixture(
      undefined,
      resolver,
      signed.snapshot,
      signed.io,
    );
    const request = osPayload({
      providerId: signed.row.providerId,
      providerVersion: signed.row.providerVersion,
      capabilityRevision: signed.row.capabilityRevision,
      expectedProviderRegistryRevision: 3,
      expectedProviderRegistryDigest: "3".repeat(64),
    });
    const prepared = await Effect.runPromise(
      preparation.prepare(request, authority),
    );
    expect(prepared).toMatchObject({
      kind: "OsEnforced",
      providerId: signed.row.providerId,
      providerVersion: signed.row.providerVersion,
      capabilityRevision: signed.row.capabilityRevision,
      osFamily: signed.host.osFamily,
      osBuild: signed.host.osBuild,
      qualificationEvidenceRef: signed.row.qualificationEvidenceRef,
      providerRegistryRevision: 3,
      providerRegistryDigest: "3".repeat(64),
      networkPolicy: request.networkPolicy.policy,
    });
    expect(decodeEffectivePolicySummaryV1(prepared, hash)).toEqual(prepared);
    expect(JSON.stringify(prepared)).not.toContain("/repo/workspace");
    const current = await Effect.runPromise(
      transaction.transact(preparation.currentPreconditions(request)),
    );
    expect(current.kind).toBe("OsEnforced");
    expect(current.sandboxHandleBindingDigest).toBe(
      prepared.sandboxHandleBindingDigest,
    );
  });

  it("rejects absent, duplicate, non-Supported, and mismatched exact tuples", async () => {
    const signed = makeSignedWindowsAuthority();
    const exactRow = signed.row;
    const request = osPayload({
      providerId: signed.row.providerId,
      providerVersion: signed.row.providerVersion,
      capabilityRevision: signed.row.capabilityRevision,
    });
    const cases = [
      [],
      [{ ...exactRow, status: "Experimental" as const }],
      [exactRow, { ...exactRow }],
      [{ ...exactRow, qualificationEvidenceRef: null }],
      [{ ...exactRow, providerVersion: "other-version" }],
    ];
    for (const entries of cases) {
      const snapshot = {
        ...signed.snapshot,
        bundle: {
          ...signed.snapshot.bundle,
          providerRegistry: { version: 1 as const, revision: 3, entries },
        },
      } satisfies SandboxAuthorityBundleSnapshotCurrent;
      const { preparation } = fixture(undefined, resolver, snapshot, signed.io);
      await expect(
        Effect.runPromise(preparation.prepare(request, authority)),
      ).rejects.toMatchObject({
        _tag: "TransactionOperationalFailure",
      });
    }
    const paths = fixedWindowsNativeProductionArtifactPaths();
    const badSignatureIo: WindowsNativeQualificationIo = {
      ...signed.io,
      read: (path) =>
        path === paths.signature
          ? Buffer.from("tampered signature")
          : signed.io.read(path),
    };
    const { preparation } = fixture(
      undefined,
      resolver,
      signed.snapshot,
      badSignatureIo,
    );
    await expect(
      Effect.runPromise(preparation.prepare(request, authority)),
    ).rejects.toMatchObject({
      _tag: "TransactionOperationalFailure",
    });
  });

  it("binds P1 preparation to complete current V3 bundle revision/digest", async () => {
    const v3 = {
      ...authorityBundleSnapshot,
      bundle: {
        ...authorityBundleSnapshot.bundle,
        version: 3 as const,
        bundleRevision: 6,
        windowsOperatorTrustSetRevision: 1,
        windowsOperatorTrustSetDigest: "6".repeat(64),
        windowsOperatorTrustSet: {
          version: 1 as const,
          revision: 1,
          sourceIdentity: "host:test",
          providerId: "windows-restricted-appcontainer-job" as const,
          keys: [
            {
              keyId: "operator-2026-a",
              algorithm: "Ed25519" as const,
              publicKeySpkiDerBase64:
                "MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=",
              publicKeySpkiSha256:
                "06e3fd8fda29bb60ab59557de61edb0aecdb231134be30e75b455f8e1b792fa9",
              validFrom: "2026-10-20T00:00:00.000Z",
              validUntil: "2027-10-20T00:00:00.000Z",
              status: "Active" as const,
            },
          ],
          revokedKeyIds: [],
        },
      },
      bundleDigest: "7".repeat(64),
    } satisfies SandboxAuthorityBundleSnapshotCurrent;
    const { preparation } = fixture(undefined, resolver, v3);
    const v3Payload = payload({
      expectedAuthorityBundleRevision: 6,
      expectedAuthorityBundleDigest: "7".repeat(64),
    });
    const v3Authority = {
      ...(authority as object),
      authorityBundleRevision: 6,
      authorityBundleDigest: "7".repeat(64),
    } as never;
    const prepared = await Effect.runPromise(
      preparation.prepare(v3Payload, v3Authority),
    );
    expect(prepared).toMatchObject({
      authorityBundleRevision: 6,
      authorityBundleDigest: "7".repeat(64),
    });
  });

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
    expect(decodeEffectivePolicySummaryV1(prepared, hash)).toEqual(prepared);
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
      Effect.match(preparation.prepare(osPayload(), authority), {
        onFailure: (error) => ({ _tag: "Left" as const, error }),
        onSuccess: (value) => ({ _tag: "Right" as const, value }),
      }),
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
