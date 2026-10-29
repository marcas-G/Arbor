import { pathToFileURL } from "node:url";
import {
  CommandGateway,
  executeShrinkWorkspaceResourceBoundary,
  semanticRequestFingerprint,
} from "@arbor/application";
import {
  Actor,
  type CommandId,
  Principal,
  ProjectId,
  parse,
  WorkspaceId,
} from "@arbor/domain";
import {
  Clock,
  ConversationResponseJobStore,
  ExecutionRepository,
  IdGenerator,
  ProjectRepository,
  ResourceOwnershipRepository,
  TransactionPort,
  WorkRepository,
  WorkspaceRepository,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { main } from "./main.js";

const TARGET_PROJECT_ID = parse(ProjectId)(
  "prj_01a12e7b-6329-7598-92a1-433fed86e35b",
);
const TARGET_WORKSPACE_ID = parse(WorkspaceId)(
  "ws_01a12e7b-6329-79bc-960f-d2364b70e683",
);
const LOCAL_ADMIN = parse(Principal)("user:local-resource-admin");
const LOCAL_ACTOR = parse(Actor)("user:local-resource-admin");

const usage =
  "Usage: powershell -ExecutionPolicy Bypass -File .\\scripts\\shrink-acceptance-boundary.ps1 " +
  "-Mode Preview -WorkspaceId ws_01a12e7b-6329-79bc-960f-d2364b70e683 " +
  "-ProviderConfig <existing-config> (Apply adds -ExpectedRevision N)";

interface Options {
  readonly mode: "preview" | "apply";
  readonly workspaceId: string;
  readonly expectedRevision?: number;
}

const parseArgs = (args: ReadonlyArray<string>): Options => {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--preview" || arg === "--apply") {
      flags.add(arg);
      continue;
    }
    if (arg === "--workspace" || arg === "--expected-revision") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      values.set(arg, value);
      index += 1;
      continue;
    }
    throw new Error(`unsupported argument: ${arg}`);
  }
  const preview = flags.has("--preview");
  const apply = flags.has("--apply");
  if (preview === apply)
    throw new Error("choose exactly one of --preview or --apply");
  const workspaceId = values.get("--workspace");
  if (workspaceId !== TARGET_WORKSPACE_ID) {
    throw new Error(
      "--workspace must match the hardcoded acceptance Workspace",
    );
  }
  const revisionText = values.get("--expected-revision");
  let expectedRevision: number | undefined;
  if (revisionText !== undefined) {
    if (!/^(0|[1-9][0-9]*)$/.test(revisionText)) {
      throw new Error("--expected-revision must be a non-negative integer");
    }
    expectedRevision = Number(revisionText);
    if (!Number.isSafeInteger(expectedRevision)) {
      throw new Error("--expected-revision must be a safe integer");
    }
  }
  if (apply && expectedRevision === undefined) {
    throw new Error(
      "--apply requires --expected-revision from a fresh preview",
    );
  }
  return {
    mode: preview ? "preview" : "apply",
    workspaceId,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  };
};

const run = (options: Options) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const projects = yield* ProjectRepository;
    const workspaces = yield* WorkspaceRepository;
    const works = yield* WorkRepository;
    const executions = yield* ExecutionRepository;
    const responseJobs = yield* ConversationResponseJobStore;
    const ownership = yield* ResourceOwnershipRepository;
    const gateway = yield* CommandGateway;
    const clock = yield* Clock;
    const ids = yield* IdGenerator;

    const {
      project,
      workspace,
      projectUnsettledExecutions,
      openWorks,
      rootResponseJobs,
      activeClaims,
    } = yield* tx.transact(
      Effect.gen(function* () {
        const foundProject = yield* projects.findById(TARGET_PROJECT_ID);
        const foundWorkspace = yield* workspaces.findById(TARGET_WORKSPACE_ID);
        if (Option.isNone(foundProject) || Option.isNone(foundWorkspace)) {
          return yield* Effect.fail(
            new Error("exact acceptance target not found"),
          );
        }
        return {
          project: foundProject.value,
          workspace: foundWorkspace.value,
          projectUnsettledExecutions:
            (yield* executions.findUnsettledExecutions()).filter(
              (execution) => execution.projectId === TARGET_PROJECT_ID,
            ),
          openWorks: yield* works.listByWorkspace(TARGET_WORKSPACE_ID, "Open"),
          rootResponseJobs:
            yield* responseJobs.listForWorkspace(TARGET_WORKSPACE_ID),
          activeClaims:
            yield* ownership.listActiveByWorkspace(TARGET_WORKSPACE_ID),
        };
      }),
    );

    const hasBoundaryResources =
      workspace.resourceBoundary.addresses.length > 0 ||
      activeClaims.length > 0;
    const blockers = [
      ...(project.lifecycle === "Closed" && hasBoundaryResources
        ? ["project is Closed while boundary resources remain"]
        : []),
      ...(workspace.projectId !== TARGET_PROJECT_ID
        ? ["workspace/project mismatch"]
        : []),
      ...(workspace.lifecycle !== "Active"
        ? [`workspace lifecycle=${workspace.lifecycle}`]
        : []),
      ...(projectUnsettledExecutions.length > 0
        ? [
            `project unsettled Execution count=${projectUnsettledExecutions.length}`,
          ]
        : []),
    ];
    const responseJobsClosedByCommand = rootResponseJobs.filter(
      (job) =>
        job.state._tag !== "Answered" &&
        job.state._tag !== "Cancelled" &&
        job.state._tag !== "Running",
    );
    const summary = {
      mode: options.mode,
      projectId: TARGET_PROJECT_ID,
      workspaceId: TARGET_WORKSPACE_ID,
      workspaceRevision: workspace.revision,
      resourceBoundaryRevision: workspace.resourceBoundaryRevision,
      resourceBoundaryAddressCount: workspace.resourceBoundary.addresses.length,
      activeClaimCount: activeClaims.length,
      projectUnsettledExecutionCount: projectUnsettledExecutions.length,
      responseJobCountCancelledByCloseProject:
        responseJobsClosedByCommand.length,
      currentWorkId: workspace.currentWorkId,
      openWorkCount: openWorks.length,
      followUp: "shrink boundary, then CloseProject to block future admission",
      blockers,
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (blockers.length > 0) {
      return yield* Effect.fail(
        new Error("preflight blocked; no command submitted"),
      );
    }
    if (options.mode === "preview") return;
    if (workspace.revision !== options.expectedRevision) {
      return yield* Effect.fail(
        new Error(
          `workspace revision changed: expected ${options.expectedRevision}, actual ${workspace.revision}; no command submitted`,
        ),
      );
    }

    if (hasBoundaryResources) {
      const commandId = yield* ids.generate<CommandId>("CommandId");
      const receipt = yield* executeShrinkWorkspaceResourceBoundary({
        gateway,
        commandId,
        projectId: TARGET_PROJECT_ID,
        workspaceId: TARGET_WORKSPACE_ID,
        expectedWorkspaceRevision: options.expectedRevision as never,
        actor: LOCAL_ACTOR,
        principal: LOCAL_ADMIN,
        issuedAt: yield* clock.now(),
      });
      process.stdout.write(
        `${JSON.stringify(
          {
            commandId: receipt.commandId,
            commandType: "UpdateResourceBoundary",
            resolution: receipt.resolution._tag,
            ...(receipt.resolution._tag === "Committed"
              ? { result: receipt.resolution.result }
              : { rejection: receipt.resolution.error }),
          },
          null,
          2,
        )}\n`,
      );
      if (receipt.resolution._tag !== "Committed") {
        return yield* Effect.fail(
          new Error(
            `UpdateResourceBoundary ${receipt.commandId} rejected: ${receipt.resolution.error._tag}; keep the daemon stopped`,
          ),
        );
      }
    }

    if (project.lifecycle === "Closed") return;
    const closePayload = {
      expectedRevision: project.revision,
      confirmed: true as const,
    };
    const closeCommandId = yield* ids.generate<CommandId>("CommandId");
    const closeFingerprint = semanticRequestFingerprint({
      commandType: "CloseProject",
      projectId: TARGET_PROJECT_ID,
      actor: LOCAL_ACTOR,
      schemaVersion: "1",
      payload: closePayload,
    });
    const closeReceipt = yield* gateway.execute(
      {
        commandType: "CloseProject",
        commandId: closeCommandId,
        projectId: TARGET_PROJECT_ID,
        actor: LOCAL_ACTOR,
        issuedAt: yield* clock.now(),
        payload: closePayload,
      },
      {
        _tag: "System",
        principal: LOCAL_ADMIN,
        causationRef: "trusted-local-acceptance-project-retirement",
      },
      {
        _tag: "ProjectGovernanceAuthority",
        principal: LOCAL_ADMIN,
        commandId: closeCommandId,
        semanticRequestFingerprint: closeFingerprint,
        projectId: TARGET_PROJECT_ID,
        commandType: "CloseProject",
      },
    );
    process.stdout.write(
      `${JSON.stringify(
        {
          commandId: closeReceipt.commandId,
          commandType: "CloseProject",
          resolution: closeReceipt.resolution._tag,
          ...(closeReceipt.resolution._tag === "Committed"
            ? { result: closeReceipt.resolution.result }
            : { rejection: closeReceipt.resolution.error }),
        },
        null,
        2,
      )}\n`,
    );
    if (closeReceipt.resolution._tag !== "Committed") {
      return yield* Effect.fail(
        new Error(
          `CloseProject ${closeReceipt.commandId} rejected: ${closeReceipt.resolution.error._tag}; keep the daemon stopped`,
        ),
      );
    }
  });

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  try {
    if (process.env.ARBOR_RELEASE_OFFLINE_CHECKED !== "1") {
      throw new Error(
        "run through scripts/shrink-acceptance-boundary.ps1 so PID/port state is checked before SQLite opens",
      );
    }
    const options = parseArgs(process.argv.slice(2));
    Effect.runPromise(
      Effect.scoped(Effect.provide(run(options), main())),
    ).catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : "resource boundary shrink failed"}\n${usage}\n`,
      );
      process.exitCode = 1;
    });
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "invalid arguments"}\n${usage}\n`,
    );
    process.exitCode = 2;
  }
}
