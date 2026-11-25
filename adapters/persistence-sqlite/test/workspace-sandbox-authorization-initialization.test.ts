import {
  CommandId,
  type GrantedWorkspaceSandboxAuthorization,
  Principal,
  ProjectId,
  parse,
  WorkspaceId,
  type WorkspaceSandboxAuthorization,
} from "@arbor/domain";
import { TransactionScope } from "@arbor/ports";
import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";
import { makeWorkspaceSandboxAuthorizationInitialization } from "../src/workspace-sandbox-authorization-initialization.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-000000000001");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-000000000001",
);
const parentWorkspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-000000000002",
);
const commandId = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-000000000001");
const request = {
  projectId,
  workspaceId,
  commandId,
  actorPrincipal: parse(Principal)("user:local"),
  resourceBoundaryRevision: 0,
  workspacePolicyRevision: 0,
  recordedAt: "2026-11-24T00:00:00.000Z",
  providerId: "linux-bwrap",
  networkPolicy: {
    version: 1 as const,
    mode: "Enabled" as const,
    destinations: [],
  },
};

const run = (
  qualified: boolean,
  current: Option.Option<WorkspaceSandboxAuthorization>,
  parentAuthorization?: GrantedWorkspaceSandboxAuthorization,
) => {
  const append = vi.fn(() => Effect.void);
  const service = makeWorkspaceSandboxAuthorizationInitialization({
    qualified,
    store: {
      findCurrent: () => Effect.succeed(current),
      appendCommitted: append,
    },
  });
  return {
    append,
    result: Effect.runPromise(
      Effect.provideService(
        service.initialize({
          ...request,
          ...(parentAuthorization === undefined ? {} : { parentAuthorization }),
        }),
        TransactionScope,
        { session: { id: "test" } },
      ),
    ),
  };
};

describe("Workspace sandbox initialization", () => {
  it("does not create a baseline when the exact tuple is unavailable", async () => {
    const { append, result } = run(false, Option.none());
    await expect(result).resolves.toEqual({
      _tag: "Unavailable",
      reason:
        "qualified linux-bwrap WorkspaceWrite × Enabled tuple unavailable",
    });
    expect(append).not.toHaveBeenCalled();
  });

  it("creates the first system-origin baseline", async () => {
    const { append, result } = run(true, Option.none());
    await expect(result).resolves.toMatchObject({
      _tag: "Initialized",
      authorization: {
        authorizationRevision: 1,
        origin: { kind: "SystemInitialization" },
        profile: "WorkspaceWrite",
        providerId: "linux-bwrap",
        networkPolicy: { version: 1, mode: "Enabled", destinations: [] },
      },
    });
    expect(append).toHaveBeenCalledTimes(1);
  });

  it("is idempotent for a matching existing baseline", async () => {
    const first = run(true, Option.none());
    const initialized = await first.result;
    if (initialized._tag !== "Initialized") throw new Error("not initialized");
    const { append, result } = run(
      true,
      Option.some(initialized.authorization),
    );
    await expect(result).resolves.toEqual({
      _tag: "AlreadyInitialized",
      authorization: initialized.authorization,
    });
    expect(append).not.toHaveBeenCalled();
  });

  it("does not overwrite a revoked head", async () => {
    const revoked = {
      version: 1 as const,
      projectId,
      workspaceId,
      authorizationRevision: 2,
      commandId,
      actorPrincipal: parse(Principal)("user:local"),
      recordedAt: "2026-11-24T00:00:00.000Z",
      state: "Revoked" as const,
    };
    const { append, result } = run(true, Option.some(revoked));
    await expect(result).resolves.toEqual({ _tag: "Revoked" });
    expect(append).not.toHaveBeenCalled();
  });

  it("does not give a Child more profile capability than its Parent", async () => {
    const parentAuthorization: WorkspaceSandboxAuthorization = {
      version: 1,
      projectId,
      workspaceId: parentWorkspaceId,
      authorizationRevision: 1,
      commandId,
      actorPrincipal: parse(Principal)("user:local"),
      recordedAt: request.recordedAt,
      state: "Granted",
      origin: { kind: "SystemInitialization" },
      resourceBoundaryRevision: 0,
      workspacePolicyRevision: 0,
      profile: "ReadOnly",
      providerId: "linux-bwrap",
      networkPolicy: request.networkPolicy,
      expiresAt: null,
    };
    const { append, result } = run(true, Option.none(), parentAuthorization);
    await expect(result).resolves.toMatchObject({ _tag: "Unavailable" });
    expect(append).not.toHaveBeenCalled();
  });
});
