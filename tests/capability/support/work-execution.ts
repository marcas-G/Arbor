import { resolve } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  admitExecution,
  evaluateAndSelect,
} from "../../../apps/single-workspace/src/index.js";
import {
  ExecutionId,
  Principal,
  parse,
  ResourceBoundaryRevision,
  WorkId,
} from "../../../packages/domain/src/index.js";
import { runExecution } from "../../../packages/execution-runtime/src/index.js";
import {
  ResourceOwnershipRepository,
  TransactionPort,
} from "../../../packages/ports/src/index.js";
import type { PublicAppHandle, PublicProject } from "./public-chat.js";
import { newCapabilityId } from "./public-chat.js";

const capabilityPrincipal = parse(Principal)("user:capability-test");

export interface WorkFixture {
  readonly workId: string;
  readonly executionId: string;
}

/** Submit CreateProject + AssignWork through the public HTTP command face. */
export const submitWork = async (
  handle: PublicAppHandle,
  project: PublicProject,
  objective: string,
): Promise<WorkFixture> => {
  const created = await handle.postCommand({
    commandType: "CreateProject",
    commandId: newCapabilityId("cmd"),
    projectId: project.projectId,
    actor: "user:capability-test",
    issuedAt: new Date().toISOString(),
    payload: project,
  });
  if (
    created.status !== 200 ||
    (created.payload.body as { resolution?: string } | undefined)
      ?.resolution !== "Committed"
  ) {
    throw new Error(
      `public CreateProject failed: ${created.status} ${JSON.stringify(created.payload)}`,
    );
  }
  const workId = newCapabilityId("wrk");
  const assigned = await handle.postCommand({
    commandType: "AssignWork",
    commandId: newCapabilityId("cmd"),
    projectId: project.projectId,
    actor: "user:capability-test",
    issuedAt: new Date().toISOString(),
    payload: {
      workId,
      workspaceId: project.rootWorkspaceId,
      expectedWorkspaceRevision: 0,
      objective,
      why: "capability L3 sentinel",
      constraints: [],
      completionExpectation: "report the observation",
      verificationMission: { goal: "g", criteria: [], riskRequirements: [] },
      provenance: { predecessorWorkId: null, reason: "initial" },
      revision: 0,
    },
  });
  if (
    assigned.status !== 200 ||
    (assigned.payload.body as { resolution?: string } | undefined)
      ?.resolution !== "Committed"
  ) {
    throw new Error(
      `public AssignWork failed: ${assigned.status} ${JSON.stringify(assigned.payload)}`,
    );
  }
  return {
    workId,
    executionId: newCapabilityId("exe"),
  };
};

/** Governance fact the P1–P4 command set cannot establish (p5-slice
 * acceptance precedent): the Workspace owns its filesystem boundary region.
 * Required only when the sentinel expects the model to use an executable
 * tool that touches resources. */
export const seedFilesystemOwnership = (
  handle: PublicAppHandle,
  project: PublicProject,
): Promise<void> =>
  handle.run(
    Effect.gen(function* () {
      const ownership = yield* ResourceOwnershipRepository;
      const tx = yield* TransactionPort;
      yield* tx.transact(
        ownership.insertClaim({
          claimId: newCapabilityId("roc"),
          workspaceId: project.rootWorkspaceId as never,
          region: {
            resourceSpaceId: "filesystem",
            normalizedRegion: { kind: "FileTree", path: resolve(".") },
          },
          sourceAddressSnapshot: { _tag: "FileTree", path: "." },
          resourceBoundaryRevision: parse(ResourceBoundaryRevision)(0),
          resolvedAtEnvironmentRevision: "local",
          createdAt: "t",
          releasedAt: null,
        }),
      );
    }),
  );

export interface WorkDriveOutcome {
  readonly settlement: unknown;
}

/** Drive the admitted WorkspaceMain execution through the production P2/P3
 * runner (the same seam the daemon uses) and return the settlement. */
export const driveWorkExecution = (
  handle: PublicAppHandle,
  project: PublicProject,
  fixture: WorkFixture,
): Promise<WorkDriveOutcome> =>
  handle.run(
    Effect.gen(function* () {
      yield* evaluateAndSelect(
        project.rootWorkspaceId as never,
        capabilityPrincipal,
        { _tag: "WorkSelected" },
      );
      yield* admitExecution(
        project.rootWorkspaceId as never,
        parse(ExecutionId)(fixture.executionId),
        {
          _tag: "Work",
          workId: parse(WorkId)(fixture.workId),
        },
        capabilityPrincipal,
      );
      const settlement = yield* runExecution(
        parse(ExecutionId)(fixture.executionId),
        { _tag: "WorkSelected" },
        capabilityPrincipal,
      );
      return { settlement } as WorkDriveOutcome;
    }),
  );

export interface ToolInvocationRow {
  readonly tool_name: string;
  readonly settlement_kind: string;
  readonly arguments_json: string;
  readonly settlement_json: string | null;
}

export interface WorkWaitRow {
  readonly work_id: string;
}

export interface ExecutionRow {
  readonly settlement_kind: string | null;
  readonly settlement_json: string | null;
}

/** Durable observation queries the sentinels use as external oracles. */
export const queryDurableEffects = (
  handle: PublicAppHandle,
): Promise<{
  readonly invocations: ReadonlyArray<ToolInvocationRow>;
  readonly waits: ReadonlyArray<WorkWaitRow>;
  readonly executions: ReadonlyArray<ExecutionRow>;
}> =>
  handle.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const invocations = yield* sql.unsafe<ToolInvocationRow>(
        "SELECT tool_name, settlement_kind, arguments_json, settlement_json FROM tool_invocations",
      );
      const waits = yield* sql.unsafe<WorkWaitRow>(
        "SELECT work_id FROM work_waits",
      );
      const executions = yield* sql.unsafe<ExecutionRow>(
        "SELECT settlement_kind, settlement_json FROM executions",
      );
      return { invocations, waits, executions };
    }),
  );
