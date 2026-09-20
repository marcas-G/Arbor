import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  P1_MIGRATIONS,
  runMigrations,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  type AssignWorkPayload,
  CommandGateway,
  type GatewayEnvelope,
  semanticRequestFingerprint,
  type VerifiedCommandAuthority,
} from "../packages/application/src/index.js";
import {
  CommandId,
  ProjectId,
  parse,
  Revision,
  SessionId,
  WorkId,
  WorkRevision,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  eventTypes,
  makeP1App,
  runP1,
  seedProject,
  testActor,
  testPrincipal,
} from "./support/p1-app.js";

const projectA = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789c1");
const projectB = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789c2");
const rootWorkspace = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789c1",
);
const rootSession = parse(SessionId)(
  "ses_018f2b3c-4d5e-7abc-8def-0123456789c1",
);
const seedCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789c1",
);
const workId = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789c1");

const assignPayload = (
  overrides: Partial<AssignWorkPayload> = {},
): AssignWorkPayload => ({
  workId,
  workspaceId: rootWorkspace,
  expectedWorkspaceRevision: parse(Revision)(0),
  objective: "ship",
  why: "P1",
  constraints: [],
  completionExpectation: "green",
  verificationMission: { goal: "g", criteria: [], riskRequirements: [] },
  provenance: { predecessorWorkId: null, reason: "initial" },
  revision: parse(WorkRevision)(0),
  ...overrides,
});

const assignEnvelope = (
  commandId: CommandId,
  projectId: ProjectId,
  payload: AssignWorkPayload,
): GatewayEnvelope<AssignWorkPayload> => ({
  commandType: "AssignWork",
  commandId,
  projectId,
  actor: testActor,
  issuedAt: "t",
  payload,
});

const assignAuthority = (
  commandId: CommandId,
  projectId: ProjectId,
  payload: AssignWorkPayload,
): VerifiedCommandAuthority => ({
  _tag: "AssignWorkAuthority",
  principal: testPrincipal,
  commandId,
  semanticRequestFingerprint: semanticRequestFingerprint({
    commandType: "AssignWork",
    projectId,
    actor: testActor,
    schemaVersion: "1",
    payload,
  }),
  projectId,
  targetWorkspaceId: payload.workspaceId,
});

const withSeed = <A>(
  body: Effect.Effect<A, unknown, CommandGateway | SqlClient>,
) =>
  Effect.gen(function* () {
    yield* runMigrations(P1_MIGRATIONS);
    yield* seedProject({
      projectId: projectA,
      rootWorkspaceId: rootWorkspace,
      sessionId: rootSession,
      commandId: seedCommandId,
    });
    return yield* body;
  });

describe("P1-012 AssignWork", () => {
  it("creates an Open work bound to the workspace and emits WorkAssigned", async () => {
    const app = makeP1App();
    const commandId = parse(CommandId)(
      "cmd_018f2b3c-4d5e-7abc-8def-0123456789c2",
    );
    const payload = assignPayload();
    const program = withSeed(
      Effect.gen(function* () {
        const gw = yield* CommandGateway;
        const receipt = yield* gw.execute(
          assignEnvelope(commandId, projectA, payload),
          { _tag: "External", principal: testPrincipal },
          assignAuthority(commandId, projectA, payload),
        );
        const sql = yield* SqlClient;
        const work = yield* sql.unsafe<{ lifecycle: string; revision: number }>(
          "SELECT lifecycle, revision FROM works WHERE work_id = ?",
          [workId],
        );
        return { receipt, work, events: yield* eventTypes };
      }),
    );
    const { receipt, work, events } = await runP1(program, app);
    expect(receipt.resolution._tag).toBe("Committed");
    if (receipt.resolution._tag === "Committed") {
      expect(receipt.resolution.result).toEqual({
        workId,
        workspaceId: rootWorkspace,
        lifecycle: "Open",
        revision: 0,
      });
    }
    expect(work[0]?.lifecycle).toBe("Open");
    expect(events).toContain("WorkAssigned");
  });

  it("rejects a workspace in another project with AuthorityDenied", async () => {
    const app = makeP1App();
    const commandId = parse(CommandId)(
      "cmd_018f2b3c-4d5e-7abc-8def-0123456789c3",
    );
    const payload = assignPayload();
    const program = withSeed(
      Effect.gen(function* () {
        const gw = yield* CommandGateway;
        return yield* gw.execute(
          assignEnvelope(commandId, projectB, payload),
          { _tag: "External", principal: testPrincipal },
          assignAuthority(commandId, projectB, payload),
        );
      }),
    );
    const receipt = await runP1(program, app);
    expect(receipt.resolution._tag).toBe("TerminalRejected");
    if (receipt.resolution._tag === "TerminalRejected") {
      expect(receipt.resolution.error._tag).toBe("AuthorityDenied");
    }
  });

  it("rejects a closed project with TerminalLifecycleMutation", async () => {
    const app = makeP1App();
    const commandId = parse(CommandId)(
      "cmd_018f2b3c-4d5e-7abc-8def-0123456789c4",
    );
    const payload = assignPayload();
    const program = withSeed(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql.unsafe(
          "UPDATE projects SET lifecycle = 'Closed' WHERE project_id = ?",
          [projectA],
        );
        const gw = yield* CommandGateway;
        return yield* gw.execute(
          assignEnvelope(commandId, projectA, payload),
          { _tag: "External", principal: testPrincipal },
          assignAuthority(commandId, projectA, payload),
        );
      }),
    );
    const receipt = await runP1(program, app);
    expect(receipt.resolution._tag).toBe("TerminalRejected");
    if (receipt.resolution._tag === "TerminalRejected") {
      expect(receipt.resolution.error._tag).toBe("TerminalLifecycleMutation");
      if (receipt.resolution.error._tag === "TerminalLifecycleMutation") {
        expect(receipt.resolution.error.entity).toBe("Project");
      }
    }
  });

  it("rejects a retired workspace with TerminalLifecycleMutation", async () => {
    const app = makeP1App();
    const commandId = parse(CommandId)(
      "cmd_018f2b3c-4d5e-7abc-8def-0123456789c5",
    );
    const payload = assignPayload();
    const program = withSeed(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql.unsafe(
          "UPDATE workspaces SET lifecycle = 'Retired' WHERE workspace_id = ?",
          [rootWorkspace],
        );
        const gw = yield* CommandGateway;
        return yield* gw.execute(
          assignEnvelope(commandId, projectA, payload),
          { _tag: "External", principal: testPrincipal },
          assignAuthority(commandId, projectA, payload),
        );
      }),
    );
    const receipt = await runP1(program, app);
    expect(receipt.resolution._tag).toBe("TerminalRejected");
    if (receipt.resolution._tag === "TerminalRejected") {
      expect(receipt.resolution.error._tag).toBe("TerminalLifecycleMutation");
      if (receipt.resolution.error._tag === "TerminalLifecycleMutation") {
        expect(receipt.resolution.error.entity).toBe("Workspace");
      }
    }
  });

  it("rejects a stale workspace revision with RevisionConflict", async () => {
    const app = makeP1App();
    const commandId = parse(CommandId)(
      "cmd_018f2b3c-4d5e-7abc-8def-0123456789c6",
    );
    const payload = assignPayload({
      expectedWorkspaceRevision: parse(Revision)(5),
    });
    const program = withSeed(
      Effect.gen(function* () {
        const gw = yield* CommandGateway;
        return yield* gw.execute(
          assignEnvelope(commandId, projectA, payload),
          { _tag: "External", principal: testPrincipal },
          assignAuthority(commandId, projectA, payload),
        );
      }),
    );
    const receipt = await runP1(program, app);
    expect(receipt.resolution._tag).toBe("TerminalRejected");
    if (receipt.resolution._tag === "TerminalRejected") {
      expect(receipt.resolution.error._tag).toBe("RevisionConflict");
    }
  });

  it("replays the existing receipt for the same logical request", async () => {
    const app = makeP1App();
    const commandId = parse(CommandId)(
      "cmd_018f2b3c-4d5e-7abc-8def-0123456789c7",
    );
    const payload = assignPayload();
    const program = withSeed(
      Effect.gen(function* () {
        const gw = yield* CommandGateway;
        const first = yield* gw.execute(
          assignEnvelope(commandId, projectA, payload),
          { _tag: "External", principal: testPrincipal },
          assignAuthority(commandId, projectA, payload),
        );
        const replay = yield* gw.execute(
          assignEnvelope(commandId, projectA, payload),
          { _tag: "External", principal: testPrincipal },
          assignAuthority(commandId, projectA, payload),
        );
        const sql = yield* SqlClient;
        const works = yield* sql.unsafe<{ count: number }>(
          "SELECT COUNT(*) AS count FROM works WHERE work_id = ?",
          [workId],
        );
        return { first, replay, count: Number(works[0]?.count ?? 0) };
      }),
    );
    const { first, replay, count } = await runP1(program, app);
    expect(first.resolution._tag).toBe("Committed");
    expect(replay.resolution._tag).toBe("Committed");
    expect(count).toBe(1);
  });
});
