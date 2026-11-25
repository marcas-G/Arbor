import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  CommandId,
  type Execution,
  ExecutionId,
  encodeSandboxEnforcementRuleSetV2,
  type GrantedWorkspaceSandboxAuthorization,
  Principal,
  ProjectId,
  parse,
  SessionId,
  sandboxEnforcementRuleSetV2ForProvider,
  type Verification,
  VerificationId,
  type Work,
  WorkId,
  WorkRevision,
  type Workspace,
  WorkspaceId,
  type WorkspaceSandboxAuthorization,
} from "@arbor/domain";
import {
  type CurrentSandboxAuthoritySnapshotV2Result,
  sha256Hex,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Exit, Fiber, Option, Scope } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  makeVerificationCommandEnvironmentPreparation,
  type VerificationCommandEnvironmentDependencies,
} from "../src/verification-command-environment.js";

const roots: string[] = [];
const scopes: Scope.Closeable[] = [];
const execFileAsync = promisify(execFile);
afterEach(async () => {
  for (const scope of scopes.splice(0))
    await Effect.runPromise(Scope.close(scope, Exit.void));
  for (const root of roots.splice(0))
    await rm(root, { force: true, recursive: true });
});

/** Trusted-record orchestration fixtures plus real filesystem captures. They
 * are not SQL authority, native qualification or installed journey evidence. */
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "arbor-verifier-preparation-"));
  roots.push(root);
  const source = join(root, "真实 项目");
  const runtimeDirectory = join(root, "runtime");
  await mkdir(source, { mode: 0o700 });
  await mkdir(runtimeDirectory, { mode: 0o700 });
  await writeFile(
    join(source, "index.js"),
    "export const sum = (a,b) => a+b;\n",
  );
  const uuid = "00000000-0000-7000-8000-000000000001";
  const projectId = parse(ProjectId)(`prj_${uuid}`);
  const workspaceId = parse(WorkspaceId)(`ws_${uuid}`);
  const executionId = parse(ExecutionId)(`exe_${uuid}`);
  const workId = parse(WorkId)(`wrk_${uuid}`);
  const verificationId = parse(VerificationId)(`ver_${uuid}`);
  const now = "2026-11-16T12:00:00.000Z";
  const workspace = {
    projectId,
    workspaceId,
    parentWorkspaceId: null,
    lifecycle: "Active",
    revision: 0,
    responsibilityRevision: 0,
    workspacePolicyRevision: 0,
    resourceBoundaryRevision: 0,
    resourceBoundary: {
      basisResponsibilityRevision: 0,
      addresses: [{ _tag: "FileTree", path: source }],
    },
  } as unknown as Workspace;
  let execution: Execution = {
    projectId,
    workspaceId,
    executionId,
    sessionId: parse(SessionId)(`ses_${uuid}`),
    admittedAt: now,
    stopRequestedAt: null,
    binding: {
      _tag: "ExecutionBoundAgentBinding",
      parentExecutionId: null,
      mission: "independent verifier",
    },
    state: { status: "Active", settlement: null },
  };
  let work = {
    projectId,
    workspaceId,
    workId,
    lifecycle: "Open",
    revision: parse(WorkRevision)(3),
  } as Work;
  let verification: Verification = {
    verificationId,
    workId,
    ownerWorkspaceId: workspaceId,
    targetWorkRevision: work.revision,
    missionSnapshot: {
      goal: "verify sum",
      criteria: [
        { criterionId: "sum", requirement: "sum is correct", required: true },
      ],
      riskRequirements: [],
    },
    criteriaResults: null,
    snapshotStatus: "Pending",
    targetDeliverables: [],
    targetArtifactVersions: [],
    targetEnvironmentRevision: null,
    environmentSnapshotRef: null,
    evidenceRefs: [],
    verificationExecutionIds: [executionId],
    summaryRef: null,
    state: { status: "Open" },
  };
  const grant: GrantedWorkspaceSandboxAuthorization = {
    version: 1,
    projectId,
    workspaceId,
    authorizationRevision: 1,
    commandId: parse(CommandId)(`cmd_${uuid}`),
    actorPrincipal: parse(Principal)("user:local"),
    recordedAt: now,
    state: "Granted",
    origin: { kind: "Human", principal: parse(Principal)("user:local") },
    resourceBoundaryRevision: 0,
    workspacePolicyRevision: 0,
    profile: "ReadOnly",
    providerId: "linux-bwrap",
    networkPolicy: { version: 1, mode: "Enabled", destinations: [] },
    expiresAt: null,
  };
  const workspaces = new Map<WorkspaceId, Workspace>([
    [workspaceId, workspace],
  ]);
  const heads = new Map<WorkspaceId, WorkspaceSandboxAuthorization>([
    [workspaceId, grant],
  ]);
  const region = {
    resourceSpaceId: "filesystem",
    normalizedRegion: { kind: "FileTree", path: source },
  };
  const rule = sandboxEnforcementRuleSetV2ForProvider("linux-bwrap");
  if (rule === undefined) throw new Error("missing Linux rules");
  let host = {
    _tag: "Available",
    currentHost: { osFamily: "Linux", osBuild: "fixture-linux" },
    snapshot: {
      bundleDigest: "a".repeat(64),
      bundle: {
        bundleRevision: 1,
        operatorConfigRevision: 1,
        operatorConfigDigest: "b".repeat(64),
        providerRegistryRevision: 1,
        providerRegistryDigest: "c".repeat(64),
        providerRegistry: {
          entries: [
            {
              status: "Supported",
              providerId: "linux-bwrap",
              providerVersion: "fixture-only",
              capabilityRevision: 1,
              osFamily: "Linux",
              osBuild: "fixture-linux",
              qualificationEvidenceRef: `blob:sha256:${"d".repeat(64)}`,
              tuple: {
                profile: "WorkspaceWrite",
                networkMode: "Enabled",
                networkPolicyCodecVersion: 1,
                enforcementRuleSetDigest: sha256Hex(
                  encodeSandboxEnforcementRuleSetV2(rule),
                ),
              },
            },
          ],
        },
      },
    },
  } as unknown as CurrentSandboxAuthoritySnapshotV2Result;
  const loadHost = vi.fn(() => Effect.succeed(host));
  const dependencies: VerificationCommandEnvironmentDependencies = {
    transaction: {
      transact: (body) =>
        Effect.provideService(body, TransactionScope, {
          session: { id: "fixture" },
        }),
    } as VerificationCommandEnvironmentDependencies["transaction"],
    clock: { now: () => Effect.succeed(now) },
    executions: { findById: () => Effect.succeed(Option.some(execution)) },
    works: { findById: () => Effect.succeed(Option.some(work)) },
    verifications: {
      findByExecutionId: () => Effect.succeed(Option.some(verification)),
    },
    workspaces: {
      findById: (id) =>
        Effect.succeed(Option.fromUndefinedOr(workspaces.get(id))),
    },
    authorizations: {
      findCurrent: (_project, id) =>
        Effect.succeed(Option.fromUndefinedOr(heads.get(id))),
    },
    boundary: {
      readCurrentForWorkspace: () =>
        Effect.succeed({
          workspace: workspaces.get(workspaceId) as Workspace,
          ownershipClaims: [],
          worktrees: [],
          resolvedRegions: [region],
          primaryResourceRegion: region,
        }),
    },
    currentHost: { loadCurrentVerifiedV2: loadHost },
    runtimeDirectory,
  };
  const scope = await Effect.runPromise(Scope.make());
  scopes.push(scope);
  const rawService =
    makeVerificationCommandEnvironmentPreparation(dependencies);
  const service = {
    prepare: (id: ExecutionId) => Scope.provide(rawService.prepare(id), scope),
  };
  return {
    root,
    source,
    runtimeDirectory,
    workspace,
    grant,
    heads,
    workspaces,
    executionId,
    dependencies,
    service,
    loadHost,
    scope,
    setExecution: (value: Execution) => {
      execution = value;
    },
    getExecution: () => execution,
    setWork: (value: Work) => {
      work = value;
    },
    getWork: () => work,
    setVerification: (value: Verification) => {
      verification = value;
    },
    getVerification: () => verification,
    setHost: (value: CurrentSandboxAuthoritySnapshotV2Result) => {
      host = value;
    },
    getHost: () => host,
  };
};

describe.skipIf(process.platform !== "linux")(
  "verification command environment preparation",
  () => {
    it("releases a successfully prepared environment when its owning scope closes", async () => {
      const f = await fixture();
      const prepared = await Effect.runPromise(
        f.service.prepare(f.executionId),
      );
      expect((await readdir(f.runtimeDirectory)).length).toBe(1);
      await Effect.runPromise(Scope.close(f.scope, Exit.void));
      expect(await readdir(f.runtimeDirectory)).toEqual([]);
      expect(await Effect.runPromise(prepared.revalidate())).toBe(false);
      expect(await readFile(join(f.source, "index.js"), "utf8")).toContain(
        "a+b",
      );
    });

    it("prepares writable copies of read-only sources with exact independent identity and current input checks", async () => {
      const f = await fixture();
      const prepared = await Effect.runPromise(
        f.service.prepare(f.executionId),
      );
      expect(prepared.binding.verificationId).toBe(
        f.getVerification().verificationId,
      );
      expect(prepared.binding.targetWorkRevision).toBe(3);
      expect(prepared).not.toHaveProperty("episodeBinding");
      expect(prepared.sources[0]?.access).toBe("ReadOnly");
      const copy = prepared.mounts[0];
      expect(copy?.access).toBe("ReadWrite");
      expect(copy?.address.path).not.toBe(f.source);
      expect(prepared.inputManifestJson).not.toContain(f.root);
      expect(await Effect.runPromise(prepared.revalidate())).toBe(true);
      await writeFile(
        join(copy?.address.path as string, "generated.js"),
        "build output",
      );
      expect(await readdir(f.source)).toEqual(["index.js"]);
      expect(await Effect.runPromise(prepared.revalidate())).toBe(true);
      await writeFile(join(f.source, "index.js"), "later user edit");
      expect(await Effect.runPromise(prepared.revalidate())).toBe(false);
      await Effect.runPromise(prepared.dispose());
      expect(await readdir(f.runtimeDirectory)).toEqual([]);
      expect(await Effect.runPromise(prepared.revalidate())).toBe(false);
      expect(await readFile(join(f.source, "index.js"), "utf8")).toBe(
        "later user edit",
      );
    });

    it("cannot use mission text to turn a Workspace execution into a verifier", async () => {
      const f = await fixture();
      f.setExecution({
        ...f.getExecution(),
        binding: {
          _tag: "WorkspaceExecution",
          workspaceId: f.workspace.workspaceId,
          episode: {
            _tag: "WorkEpisode",
            workId: f.getWork().workId,
            targetWorkRevision: f.getWork().revision,
          },
        },
      });
      expect(
        await Effect.runPromise(Effect.flip(f.service.prepare(f.executionId))),
      ).toMatchObject({ code: "ExecutionUnavailable" });
      expect(await readdir(f.runtimeDirectory)).toEqual([]);
    });

    it("rejects a foreign Verification owner and an unbound execution", async () => {
      const f = await fixture();
      f.setVerification({
        ...f.getVerification(),
        verificationExecutionIds: [],
      });
      expect(
        await Effect.runPromise(Effect.flip(f.service.prepare(f.executionId))),
      ).toMatchObject({ code: "VerificationUnavailable" });
      f.setVerification({
        ...f.getVerification(),
        verificationExecutionIds: [f.executionId],
        ownerWorkspaceId: parse(WorkspaceId)(
          "ws_00000000-0000-7000-8000-000000000009",
        ),
      });
      expect(
        await Effect.runPromise(Effect.flip(f.service.prepare(f.executionId))),
      ).toMatchObject({ code: "VerificationUnavailable" });
    });

    it("does not capture the new Work revision as an old Verification's input", async () => {
      const f = await fixture();
      f.setWork({ ...f.getWork(), revision: parse(WorkRevision)(4) });
      expect(
        await Effect.runPromise(Effect.flip(f.service.prepare(f.executionId))),
      ).toMatchObject({ code: "WorkVersionUnavailable" });
      expect(await readdir(f.runtimeDirectory)).toEqual([]);
    });

    it("does not revive a prepared environment after human revocation or a later reauthorization", async () => {
      const f = await fixture();
      const prepared = await Effect.runPromise(
        f.service.prepare(f.executionId),
      );
      const {
        origin: _origin,
        resourceBoundaryRevision: _boundary,
        workspacePolicyRevision: _policy,
        profile: _profile,
        providerId: _provider,
        networkPolicy: _network,
        expiresAt: _expiry,
        ...common
      } = f.grant;
      f.heads.set(f.workspace.workspaceId, {
        ...common,
        state: "Revoked",
        authorizationRevision: 2,
      });
      expect(await Effect.runPromise(prepared.revalidate())).toBe(false);
      expect(
        await Effect.runPromise(Effect.flip(f.service.prepare(f.executionId))),
      ).toMatchObject({ code: "AuthorizationUnavailable" });
      f.heads.set(f.workspace.workspaceId, {
        ...f.grant,
        authorizationRevision: 3,
      });
      expect(await Effect.runPromise(prepared.revalidate())).toBe(false);
      await Effect.runPromise(prepared.dispose());
    });

    it("rechecks the complete Parent lineage instead of only the Child head", async () => {
      const f = await fixture();
      const parentId = parse(WorkspaceId)(
        "ws_00000000-0000-7000-8000-000000000008",
      );
      f.workspaces.set(parentId, { ...f.workspace, workspaceId: parentId });
      f.workspaces.set(f.workspace.workspaceId, {
        ...f.workspace,
        parentWorkspaceId: parentId,
      });
      f.heads.set(parentId, { ...f.grant, workspaceId: parentId });
      f.heads.set(f.workspace.workspaceId, {
        ...f.grant,
        origin: {
          kind: "Parent",
          parentWorkspaceId: parentId,
          parentAuthorizationRevision: 1,
          parentExecutionId: parse(ExecutionId)(
            "exe_00000000-0000-7000-8000-000000000008",
          ),
        },
      });
      const prepared = await Effect.runPromise(
        f.service.prepare(f.executionId),
      );
      expect(await Effect.runPromise(prepared.revalidate())).toBe(true);
      f.heads.delete(parentId);
      expect(await Effect.runPromise(prepared.revalidate())).toBe(false);
      await Effect.runPromise(prepared.dispose());
    });

    it("cleans captures if canonical state changes during preparation", async () => {
      const f = await fixture();
      f.loadHost
        .mockImplementationOnce(() => Effect.succeed(f.getHost()))
        .mockImplementation(() => {
          const host = f.getHost();
          if (host._tag !== "Available") return Effect.succeed(host);
          return Effect.succeed({
            ...host,
            snapshot: { ...host.snapshot, bundleDigest: "e".repeat(64) },
          });
        });
      expect(
        await Effect.runPromise(Effect.flip(f.service.prepare(f.executionId))),
      ).toMatchObject({ code: "SourceChanged" });
      expect(await readdir(f.runtimeDirectory)).toEqual([]);
    });

    it("cleans earlier mounts if another source contains a socket", async () => {
      const f = await fixture();
      const extra = join(f.root, "another-source");
      await mkdir(extra);
      await writeFile(join(extra, "input.txt"), "another admitted source");
      const workspace = {
        ...f.workspace,
        resourceBoundary: {
          ...f.workspace.resourceBoundary,
          addresses: [
            ...f.workspace.resourceBoundary.addresses,
            { _tag: "FileTree" as const, path: extra },
          ],
        },
      };
      f.workspaces.set(workspace.workspaceId, workspace);
      const region = {
        resourceSpaceId: "filesystem",
        normalizedRegion: { kind: "FileTree", path: f.source },
      };
      vi.spyOn(
        f.dependencies.boundary,
        "readCurrentForWorkspace",
      ).mockImplementation(() =>
        Effect.succeed({
          workspace,
          ownershipClaims: [],
          worktrees: [],
          resolvedRegions: [
            region,
            {
              resourceSpaceId: "filesystem",
              normalizedRegion: { kind: "FileTree", path: extra },
            },
          ],
          primaryResourceRegion: region,
        }),
      );
      await execFileAsync("mkfifo", [join(f.source, "host.sock")]);
      try {
        expect(
          await Effect.runPromise(
            Effect.flip(f.service.prepare(f.executionId)),
          ),
        ).toMatchObject({ code: "PreparationFailed" });
        expect(await readdir(f.runtimeDirectory)).toEqual([]);
      } finally {
        await rm(join(f.source, "host.sock"), { force: true });
      }
    });

    it("joins partial capture cleanup when the preparing fiber is interrupted", async () => {
      const f = await fixture();
      await writeFile(
        join(f.source, "large.bin"),
        Buffer.alloc(32 * 1024 ** 2),
      );
      f.loadHost
        .mockImplementationOnce(() => Effect.succeed(f.getHost()))
        .mockImplementation(() => Effect.never);
      const fiber = Effect.runFork(f.service.prepare(f.executionId));
      try {
        await vi.waitFor(async () =>
          expect((await readdir(f.runtimeDirectory)).length).toBeGreaterThan(0),
        );
      } finally {
        await Effect.runPromise(Fiber.interrupt(fiber));
      }
      expect(await readdir(f.runtimeDirectory)).toEqual([]);
      expect((await readFile(join(f.source, "large.bin"))).byteLength).toBe(
        32 * 1024 ** 2,
      );
    });
  },
);
