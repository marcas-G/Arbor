import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  P1_MIGRATIONS,
  runMigrations,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  CommandGateway,
  type CreateChildWorkspacePayload,
  type CreateProjectPayload,
  type GatewayEnvelope,
  semanticRequestFingerprint,
  type VerifiedCommandAuthority,
} from "../packages/application/src/index.js";
import {
  Actor,
  CommandId,
  ContextEpochNumber,
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
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import { makeP1App, runP1 } from "./support/p1-app.js";

const actor = parse(Actor)("user:test");
const principal = parse(Principal)("user:test");

const projectA = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const projectB = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789b1");
const rootWorkspace = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const rootSession = parse(SessionId)(
  "ses_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const childWorkspace = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a2",
);
const childSession = parse(SessionId)(
  "ses_018f2b3c-4d5e-7abc-8def-0123456789a2",
);

const definition = {
  purpose: "p",
  ownedResponsibilities: [],
  obligations: [],
  includes: [],
  excludes: [],
  interfaces: [],
};

const projectPayload = (): CreateProjectPayload => ({
  name: "Arbor",
  revision: parse(Revision)(0),
  projectPolicy: makeProjectPolicy(),
  projectPolicyRevision: parse(Revision)(0),
  defaultConfiguration: {},
  environmentRef: "local",
  rootWorkspaceId: rootWorkspace,
  primarySession: {
    sessionId: rootSession,
    contextEpoch: parse(ContextEpochNumber)(0),
  },
  rootWorkspace: {
    name: "root",
    responsibilityDefinition: definition,
    responsibilityRevision: parse(ResponsibilityRevision)(0),
    resourceBoundary: {
      basisResponsibilityRevision: parse(ResponsibilityRevision)(0),
      addresses: [],
    },
    resourceBoundaryRevision: parse(ResourceBoundaryRevision)(0),
    agentBinding: responsibilityBound(rootWorkspace),
    workspacePolicy: makeWorkspacePolicy(),
    workspacePolicyRevision: parse(Revision)(0),
    revision: parse(Revision)(0),
  },
});

const childPayload = (
  parentWorkspaceId = rootWorkspace,
  workspaceId = childWorkspace,
  sessionId = childSession,
): CreateChildWorkspacePayload => ({
  parentWorkspaceId,
  workspaceId,
  primarySession: { sessionId, contextEpoch: parse(ContextEpochNumber)(0) },
  name: "child",
  responsibilityDefinition: definition,
  responsibilityRevision: parse(ResponsibilityRevision)(0),
  resourceBoundary: {
    basisResponsibilityRevision: parse(ResponsibilityRevision)(0),
    addresses: [],
  },
  resourceBoundaryRevision: parse(ResourceBoundaryRevision)(0),
  agentBinding: responsibilityBound(workspaceId),
  workspacePolicy: makeWorkspacePolicy(),
  workspacePolicyRevision: parse(Revision)(0),
  revision: parse(Revision)(0),
});

const envelope = <P>(
  commandType: string,
  projectId: ProjectId,
  commandId: CommandId,
  payload: P,
): GatewayEnvelope<P> => ({
  commandType,
  commandId,
  projectId,
  actor,
  issuedAt: "t",
  payload,
});

const authority = <P>(
  tag: "CreateProjectAuthority" | "CreateChildWorkspaceAuthority",
  commandType: string,
  projectId: ProjectId,
  commandId: CommandId,
  payload: P,
  extra: Record<string, unknown> = {},
): VerifiedCommandAuthority =>
  ({
    _tag: tag,
    principal,
    commandId,
    semanticRequestFingerprint: semanticRequestFingerprint({
      commandType,
      projectId,
      actor,
      schemaVersion: "1",
      payload,
    }),
    projectId,
    ...extra,
  }) as VerifiedCommandAuthority;

const seedProject = Effect.gen(function* () {
  const gw = yield* CommandGateway;
  const payload = projectPayload();
  const commandId = parse(CommandId)(
    "cmd_018f2b3c-4d5e-7abc-8def-0123456789a1",
  );
  return yield* gw.execute(
    envelope("CreateProject", projectA, commandId, payload),
    { _tag: "External", principal },
    authority(
      "CreateProjectAuthority",
      "CreateProject",
      projectA,
      commandId,
      payload,
    ),
  );
});

describe("P1-011 CreateChildWorkspace", () => {
  it("creates a child workspace + session and emits WorkspaceCreated", async () => {
    const app = makeP1App();
    const program = Effect.gen(function* () {
      yield* runMigrations(P1_MIGRATIONS);
      yield* seedProject;
      const gw = yield* CommandGateway;
      const payload = childPayload();
      const commandId = parse(CommandId)(
        "cmd_018f2b3c-4d5e-7abc-8def-0123456789a2",
      );
      const receipt = yield* gw.execute(
        envelope("CreateChildWorkspace", projectA, commandId, payload),
        { _tag: "External", principal },
        authority(
          "CreateChildWorkspaceAuthority",
          "CreateChildWorkspace",
          projectA,
          commandId,
          payload,
          { parentWorkspaceId: rootWorkspace },
        ),
      );
      const sql = yield* SqlClient;
      const child = yield* sql.unsafe<{
        parent_workspace_id: string;
        project_id: string;
      }>(
        "SELECT parent_workspace_id, project_id FROM workspaces WHERE workspace_id = ?",
        [childWorkspace],
      );
      return { receipt, child };
    });
    const { receipt, child } = await runP1(program, app);
    expect(receipt.resolution._tag).toBe("Committed");
    if (receipt.resolution._tag === "Committed") {
      expect(receipt.resolution.result).toEqual({
        workspaceId: childWorkspace,
        projectId: projectA,
        parentWorkspaceId: rootWorkspace,
        primarySessionId: childSession,
      });
    }
    expect(child[0]?.parent_workspace_id).toBe(rootWorkspace);
    expect(child[0]?.project_id).toBe(projectA);
  });

  it("rejects a missing parent with WorkspaceNotFound", async () => {
    const app = makeP1App();
    const program = Effect.gen(function* () {
      yield* runMigrations(P1_MIGRATIONS);
      yield* seedProject;
      const gw = yield* CommandGateway;
      const missingParent = parse(WorkspaceId)(
        "ws_018f2b3c-4d5e-7abc-8def-0123456789ff",
      );
      const payload = childPayload(missingParent);
      const commandId = parse(CommandId)(
        "cmd_018f2b3c-4d5e-7abc-8def-0123456789b2",
      );
      return yield* gw.execute(
        envelope("CreateChildWorkspace", projectA, commandId, payload),
        { _tag: "External", principal },
        authority(
          "CreateChildWorkspaceAuthority",
          "CreateChildWorkspace",
          projectA,
          commandId,
          payload,
          { parentWorkspaceId: missingParent },
        ),
      );
    });
    const receipt = await runP1(program, app);
    expect(receipt.resolution._tag).toBe("TerminalRejected");
    if (receipt.resolution._tag === "TerminalRejected") {
      expect(receipt.resolution.error._tag).toBe("WorkspaceNotFound");
    }
  });

  it("rejects a foreign-project parent with AuthorityDenied", async () => {
    const app = makeP1App();
    const program = Effect.gen(function* () {
      yield* runMigrations(P1_MIGRATIONS);
      yield* seedProject;
      const gw = yield* CommandGateway;
      const payload = childPayload();
      const commandId = parse(CommandId)(
        "cmd_018f2b3c-4d5e-7abc-8def-0123456789b3",
      );
      return yield* gw.execute(
        envelope("CreateChildWorkspace", projectB, commandId, payload),
        { _tag: "External", principal },
        authority(
          "CreateChildWorkspaceAuthority",
          "CreateChildWorkspace",
          projectB,
          commandId,
          payload,
          { parentWorkspaceId: rootWorkspace },
        ),
      );
    });
    const receipt = await runP1(program, app);
    expect(receipt.resolution._tag).toBe("TerminalRejected");
    if (receipt.resolution._tag === "TerminalRejected") {
      expect(receipt.resolution.error._tag).toBe("AuthorityDenied");
    }
  });

  it("rejects a retired parent with TerminalLifecycleMutation", async () => {
    const app = makeP1App();
    const program = Effect.gen(function* () {
      yield* runMigrations(P1_MIGRATIONS);
      yield* seedProject;
      const sql = yield* SqlClient;
      yield* sql.unsafe(
        "UPDATE workspaces SET lifecycle = 'Retired' WHERE workspace_id = ?",
        [rootWorkspace],
      );
      const gw = yield* CommandGateway;
      const payload = childPayload();
      const commandId = parse(CommandId)(
        "cmd_018f2b3c-4d5e-7abc-8def-0123456789b4",
      );
      return yield* gw.execute(
        envelope("CreateChildWorkspace", projectA, commandId, payload),
        { _tag: "External", principal },
        authority(
          "CreateChildWorkspaceAuthority",
          "CreateChildWorkspace",
          projectA,
          commandId,
          payload,
          { parentWorkspaceId: rootWorkspace },
        ),
      );
    });
    const receipt = await runP1(program, app);
    expect(receipt.resolution._tag).toBe("TerminalRejected");
    if (receipt.resolution._tag === "TerminalRejected") {
      expect(receipt.resolution.error._tag).toBe("TerminalLifecycleMutation");
    }
  });
});
