import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  P1_MIGRATIONS,
  runMigrations,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  type CloseProjectPayload,
  CommandGateway,
  type RenameProjectPayload,
  semanticRequestFingerprint,
  type VerifiedCommandAuthority,
} from "../packages/application/src/index.js";
import {
  CommandId,
  ProjectId,
  parse,
  Revision,
  SessionId,
  WorkspaceId,
} from "../packages/domain/src/index.js";
import {
  eventTypes,
  makeP1App,
  runP1,
  seedProject,
  testActor,
  testPrincipal,
} from "./support/p1-app.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789f1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789f1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789f1");
const command = (seed: string) =>
  parse(CommandId)(`cmd_018f2b3c-4d5e-7abc-8def-${seed}`);
const revision = parse(Revision);

const authority = (
  commandType: "RenameProject" | "CloseProject",
  commandId: CommandId,
  payload: RenameProjectPayload | CloseProjectPayload,
): VerifiedCommandAuthority => ({
  _tag: "ProjectGovernanceAuthority",
  principal: testPrincipal,
  commandId,
  semanticRequestFingerprint: semanticRequestFingerprint({
    commandType,
    projectId,
    actor: testActor,
    schemaVersion: "1",
    payload,
  }),
  projectId,
  commandType,
});

describe("P15 project management commands", () => {
  it("renames then archives with durable events; Closed project refuses a new rename", async () => {
    const app = makeP1App();
    const result = await runP1(
      Effect.gen(function* () {
        yield* runMigrations(P1_MIGRATIONS);
        yield* seedProject({
          projectId,
          rootWorkspaceId: workspaceId,
          sessionId,
          commandId: command("000000000001"),
        });
        const gateway = yield* CommandGateway;
        const rename: RenameProjectPayload = {
          name: "Arbor Next",
          expectedRevision: revision(0),
        };
        const renamed = yield* gateway.execute(
          {
            commandType: "RenameProject",
            commandId: command("000000000002"),
            projectId,
            actor: testActor,
            issuedAt: "t2",
            payload: rename,
          },
          { _tag: "External", principal: testPrincipal },
          authority("RenameProject", command("000000000002"), rename),
        );
        const close: CloseProjectPayload = {
          expectedRevision: revision(1),
          confirmed: true,
        };
        const closed = yield* gateway.execute(
          {
            commandType: "CloseProject",
            commandId: command("000000000003"),
            projectId,
            actor: testActor,
            issuedAt: "t3",
            payload: close,
          },
          { _tag: "External", principal: testPrincipal },
          authority("CloseProject", command("000000000003"), close),
        );
        const rejectedRename: RenameProjectPayload = {
          name: "Must Not Apply",
          expectedRevision: revision(2),
        };
        const rejected = yield* gateway.execute(
          {
            commandType: "RenameProject",
            commandId: command("000000000004"),
            projectId,
            actor: testActor,
            issuedAt: "t4",
            payload: rejectedRename,
          },
          { _tag: "External", principal: testPrincipal },
          authority("RenameProject", command("000000000004"), rejectedRename),
        );
        return { renamed, closed, rejected, events: yield* eventTypes };
      }),
      app,
    );
    expect(result.renamed.resolution._tag).toBe("Committed");
    expect(result.closed.resolution._tag).toBe("Committed");
    expect(result.rejected.resolution._tag).toBe("TerminalRejected");
    expect(result.events).toEqual([
      "ProjectCreated",
      "WorkspaceCreated",
      "ProjectRenamed",
      "ProjectClosed",
    ]);
  });
});
