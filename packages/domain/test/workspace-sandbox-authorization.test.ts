import { describe, expect, it } from "vitest";
import {
  CommandId,
  decodeCanonicalWorkspaceSandboxAuthorization,
  decodeWorkspaceSandboxAuthorization,
  ExecutionId,
  encodeWorkspaceSandboxAuthorization,
  type GrantedWorkspaceSandboxAuthorization,
  Principal,
  ProjectId,
  parse,
  ResourceBoundaryRevision,
  Revision,
  resolveWorkspaceSandboxAuthorization,
  WorkspaceId,
  type WorkspaceSandboxAuthorization,
  type WorkspaceSandboxAuthorizationSnapshot,
} from "../src/index.js";

const uuid = (n: number) =>
  `018f2b3c-4d5e-7abc-8def-${String(n).padStart(12, "0")}`;
const projectId = parse(ProjectId)(`prj_${uuid(1)}`);
const root = parse(WorkspaceId)(`ws_${uuid(1)}`);
const child = parse(WorkspaceId)(`ws_${uuid(2)}`);
const grandchild = parse(WorkspaceId)(`ws_${uuid(3)}`);
const human = parse(Principal)("user:local");
const grant = (
  workspaceId = root,
  patch: Partial<GrantedWorkspaceSandboxAuthorization> = {},
): GrantedWorkspaceSandboxAuthorization => ({
  version: 1,
  projectId,
  workspaceId,
  authorizationRevision: 1,
  commandId: parse(CommandId)(`cmd_${uuid(1)}`),
  actorPrincipal: human,
  recordedAt: "2026-11-16T00:00:00Z",
  state: "Granted",
  origin: { kind: "Human", principal: human },
  resourceBoundaryRevision: parse(ResourceBoundaryRevision)(0),
  workspacePolicyRevision: parse(Revision)(0),
  profile: "WorkspaceWrite",
  providerId: "linux-bwrap",
  networkPolicy: { version: 1, mode: "Enabled", destinations: [] },
  expiresAt: null,
  ...patch,
});
const systemGrant = (
  workspaceId = root,
): GrantedWorkspaceSandboxAuthorization =>
  grant(workspaceId, {
    origin: { kind: "SystemInitialization" },
  });
const allocation = (workspaceId = child, parentWorkspaceId = root) =>
  grant(workspaceId, {
    actorPrincipal: parse(Principal)("agent:worker"),
    origin: {
      kind: "Parent",
      parentWorkspaceId,
      parentAuthorizationRevision: 1,
      parentExecutionId: parse(ExecutionId)(`exe_${uuid(1)}`),
    },
  });
const workspace = (
  workspaceId = root,
  parentWorkspaceId: WorkspaceId | null = null,
): WorkspaceSandboxAuthorizationSnapshot["workspaces"][number] => ({
  projectId,
  workspaceId,
  parentWorkspaceId,
  lifecycle: "Active",
  resourceBoundaryRevision: parse(ResourceBoundaryRevision)(0),
  workspacePolicyRevision: parse(Revision)(0),
});
const snapshot = (): WorkspaceSandboxAuthorizationSnapshot => ({
  heads: [grant(), allocation(), allocation(grandchild, child)],
  workspaces: [
    workspace(),
    workspace(child, root),
    workspace(grandchild, child),
  ],
});
const resolve = (
  facts = snapshot(),
  workspaceId = grandchild,
  now = "2036-11-16T00:00:00Z",
) =>
  resolveWorkspaceSandboxAuthorization({
    ...facts,
    projectId,
    workspaceId,
    now,
  });

describe("durable Workspace sandbox authorization", () => {
  it("round trips exact closed facts and keeps canonical bytes strict", () => {
    for (const fact of [
      grant(),
      allocation(),
      {
        version: 1,
        projectId,
        workspaceId: root,
        authorizationRevision: 2,
        commandId: parse(CommandId)(`cmd_${uuid(2)}`),
        actorPrincipal: human,
        recordedAt: "2026-11-16T01:00:00Z",
        state: "Revoked",
      } satisfies WorkspaceSandboxAuthorization,
    ]) {
      const encoded = encodeWorkspaceSandboxAuthorization(fact);
      expect(decodeCanonicalWorkspaceSandboxAuthorization(encoded)).toEqual(
        fact,
      );
      expect(
        decodeCanonicalWorkspaceSandboxAuthorization(` ${encoded}`),
      ).toBeUndefined();
      expect(
        decodeWorkspaceSandboxAuthorization({ ...fact, version: 2 }),
      ).toBeUndefined();
      expect(
        decodeWorkspaceSandboxAuthorization({ ...fact, unknown: true }),
      ).toBeUndefined();
    }
  });

  it("treats a system initialization head as a terminal workspace grant", () => {
    const fact = systemGrant();
    expect(decodeWorkspaceSandboxAuthorization(fact)).toEqual(fact);
    expect(
      resolveWorkspaceSandboxAuthorization({
        projectId,
        workspaceId: root,
        now: "2036-11-16T00:00:00Z",
        heads: [fact],
        workspaces: [workspace()],
      }),
    ).toEqual({
      _tag: "Authorized",
      authorization: fact,
      lineage: [fact],
    });
  });

  it.each([
    { authorizationRevision: 0 },
    { authorizationRevision: Number.MAX_SAFE_INTEGER + 1 },
    { resourceBoundaryRevision: -1 },
    { workspacePolicyRevision: 0.5 },
    { commandId: "cmd_invalid" },
    { projectId: "prj_invalid" },
    { workspaceId: "ws_invalid" },
    { profile: "FullAccess" },
    { providerId: "TrustedLocal" },
    { providerId: "LocalTrusted" },
    { expiresAt: undefined },
    { expiresAt: "2026-11-16T00:00:00Z" },
    { recordedAt: "invalid" },
    { actorPrincipal: "agent:worker" },
    { networkPolicy: { version: 1, mode: "Restricted", destinations: [] } },
    { origin: { kind: "Human", principal: "agent:worker" } },
    {
      origin: {
        kind: "Parent",
        parentWorkspaceId: root,
        parentAuthorizationRevision: 1,
        parentExecutionId: `exe_${uuid(1)}`,
      },
    },
  ])("rejects malformed or unconfined durable facts %#", (patch) => {
    expect(
      decodeWorkspaceSandboxAuthorization({ ...grant(), ...patch }),
    ).toBeUndefined();
  });

  it("keeps a bounded multilevel allocation valid years after its originating Execution ends", () => {
    const result = resolve();
    expect(result._tag).toBe("Authorized");
    if (result._tag === "Authorized")
      expect(result.lineage.map((fact) => fact.workspaceId)).toEqual([
        grandchild,
        child,
        root,
      ]);
    // No Task, Session, general Workspace revision or originating Execution
    // lifecycle enters the evaluator's authority lifetime.
    expect(resolve(snapshot(), root)).toMatchObject({ _tag: "Authorized" });
  });

  it.each([
    { state: "Revoked", authorizationRevision: 2 },
    { authorizationRevision: 2 },
    { expiresAt: "2026-11-17T00:00:00Z" },
    { resourceBoundaryRevision: 1 },
    { workspacePolicyRevision: 1 },
  ])("invalidates descendants when a source changes %#", (patch) => {
    const facts = snapshot();
    const source =
      patch.state === "Revoked"
        ? ({
            version: 1,
            projectId,
            workspaceId: root,
            authorizationRevision: 2,
            commandId: parse(CommandId)(`cmd_${uuid(2)}`),
            actorPrincipal: human,
            recordedAt: "2026-11-16T01:00:00Z",
            state: "Revoked",
          } as const)
        : decodeWorkspaceSandboxAuthorization({ ...grant(root), ...patch });
    if (source === undefined) throw new Error("invalid test source");
    expect(
      resolve({
        ...facts,
        heads: [source, allocation(), allocation(grandchild, child)],
      })._tag,
    ).toBe("Denied");
  });

  it("never falls back to a historical head or accepts an ambiguous current snapshot", () => {
    const facts = snapshot();
    expect(resolve({ ...facts, heads: [...facts.heads, grant()] })).toEqual({
      _tag: "Denied",
      reason: "MissingOrAmbiguousHead",
    });
    expect(
      resolve({ ...facts, workspaces: [...facts.workspaces, workspace()] }),
    ).toEqual({ _tag: "Denied", reason: "MissingOrAmbiguousWorkspace" });
    expect(
      resolve({
        ...facts,
        heads: facts.heads.filter((head) => head.workspaceId !== root),
      })._tag,
    ).toBe("Denied");
    expect(
      resolve({
        ...facts,
        workspaces: facts.workspaces.map((value) =>
          value.workspaceId === root
            ? { ...value, projectId: parse(ProjectId)(`prj_${uuid(2)}`) }
            : value,
        ),
      })._tag,
    ).toBe("Denied");
  });

  it("rejects retirement, reparenting, cycles, future facts and boundary changes", () => {
    const facts = snapshot();
    for (const patch of [
      { lifecycle: "Retired" as const },
      { parentWorkspaceId: null },
      { resourceBoundaryRevision: parse(ResourceBoundaryRevision)(1) },
      { workspacePolicyRevision: parse(Revision)(1) },
    ]) {
      expect(
        resolve({
          ...facts,
          workspaces: facts.workspaces.map((value) =>
            value.workspaceId === child ? { ...value, ...patch } : value,
          ),
        })._tag,
      ).toBe("Denied");
    }
    expect(resolve(facts, child, "invalid")).toEqual({
      _tag: "Denied",
      reason: "InvalidTime",
    });
    expect(resolve(facts, child, "2020-11-16T00:00:00Z")).toEqual({
      _tag: "Denied",
      reason: "OutsideValidity",
    });
    expect(
      resolve(
        {
          heads: [allocation(root, child), allocation(child, root)],
          workspaces: [workspace(root, child), workspace(child, root)],
        },
        child,
      ),
    ).toEqual({ _tag: "Denied", reason: "Cycle" });
  });

  it("bounds every hop's write, provider, network and expiry ceiling", () => {
    const check = (
      parent: GrantedWorkspaceSandboxAuthorization,
      target: GrantedWorkspaceSandboxAuthorization,
    ) =>
      resolve(
        {
          heads: [parent, target],
          workspaces: [workspace(), workspace(child, root)],
        },
        child,
      );
    const parent = grant(root, {
      profile: "ReadOnly",
      networkPolicy: {
        version: 1,
        mode: "Restricted",
        destinations: ["https://example.com"],
      },
      expiresAt: "2040-01-01T00:00:00Z",
    });
    const valid = allocation();
    const target = {
      ...valid,
      profile: "ReadOnly" as const,
      networkPolicy: parent.networkPolicy,
      expiresAt: parent.expiresAt,
    };
    expect(check(parent, target)._tag).toBe("Authorized");
    for (const patch of [
      { profile: "WorkspaceWrite" as const },
      { providerId: "other-provider" },
      { expiresAt: null },
      { expiresAt: "2041-01-01T00:00:00Z" },
      {
        networkPolicy: {
          version: 1 as const,
          mode: "Enabled" as const,
          destinations: [],
        },
      },
      {
        networkPolicy: {
          version: 1 as const,
          mode: "Restricted" as const,
          destinations: ["https://other.example"],
        },
      },
    ])
      expect(check(parent, { ...target, ...patch })).toEqual({
        _tag: "Denied",
        reason: "CeilingExceeded",
      });
    expect(
      check(parent, {
        ...target,
        networkPolicy: { version: 1, mode: "Disabled", destinations: [] },
      })._tag,
    ).toBe("Authorized");
    expect(
      check(
        grant(root, {
          networkPolicy: { version: 1, mode: "Disabled", destinations: [] },
        }),
        allocation(),
      )._tag,
    ).toBe("Denied");
  });
});
