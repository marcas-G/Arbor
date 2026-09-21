import type { DirectiveHandler, DirectiveOutcome } from "@arbor/agent-runtime";
import {
  CommandGateway,
  deriveFormationIds,
  formationAssignPlan,
  formationCreatePlan,
  formationPathOf,
  isChildWorkspaceProposal,
  newFormationProposalId,
  newUuid7,
  semanticRequestFingerprint,
  validateCapabilityCeiling,
} from "@arbor/application";
import {
  admitFormationProposal,
  CommandId,
  ExecutionId,
  FormationProposalId,
  parse,
  SessionId,
  ToolInvocationId,
} from "@arbor/domain";
import {
  AgentExecutionStateStore,
  type BoundedObservation,
  type CanonicalToolObservation,
  Clock,
  type ExecutionDriverError,
  FormationProposalStore,
  InboxProjectionStore,
  MessageStore,
  SkillRegistry,
  type ToolExecutionContext,
  type ToolIntent,
  ToolRuntimePort,
  TransactionPort,
  WorkspaceRepository,
} from "@arbor/ports";
import { Context, Effect, Layer, Option } from "effect";
import { makeRequestGovernanceHandler } from "./governance-directive.js";

/** P5 `03` §2. The slice's directive handler set: `InvokeTool` (P4), plus the
 * observation-only directives. Directives whose owning phase is absent are left
 * to the driver's `DirectiveUnsupported` path. */
export class SliceDirectiveHandlers extends Context.Service<
  SliceDirectiveHandlers,
  ReadonlyArray<DirectiveHandler>
>()("arbor/SliceDirectiveHandlers") {}

const MAX_OBSERVATION_CHARS = 2000;

const bounded = (text: string): BoundedObservation =>
  text.length > MAX_OBSERVATION_CHARS
    ? { text: text.slice(0, MAX_OBSERVATION_CHARS), truncated: true }
    : { text, truncated: false };

const driverError = (cause: unknown): ExecutionDriverError => ({
  _tag: "ExecutionDriverError",
  cause,
});

const observation = (
  source: "Runtime" | "Tool",
  text: string,
): DirectiveOutcome => ({
  _tag: "Observation",
  source,
  observation: bounded(text),
});

const toOutcome = (result: CanonicalToolObservation): DirectiveOutcome => {
  switch (result._tag) {
    case "Success":
    case "ExpectedFailure":
      return {
        _tag: "Observation",
        source: "Tool",
        observation: result.observation,
      };
    case "Denied":
      return observation("Runtime", `tool denied: ${result.reason}`);
    case "Interrupted":
      return observation("Runtime", "tool invocation interrupted");
    case "OutcomeUnknown":
      return observation("Runtime", "tool outcome unknown");
    case "RuntimeFailure":
      return observation("Runtime", `tool runtime failure: ${result.cause}`);
  }
};

export interface ProposeChildWorkspaceDependencies {
  readonly gateway: import("@arbor/application").CommandGatewayService;
  readonly workspaces: import("@arbor/ports").WorkspaceRepositoryService;
  readonly proposals: import("@arbor/ports").FormationProposalStoreService;
  readonly tx: import("@arbor/ports").TransactionPortService;
  readonly clock: import("@arbor/ports").ClockService;
}

/** P6 `01` §4: first-layer proposals go to the governance gate (D1);
 * deep-layer formation executes directly under the projected
 * `CreateChildWorkspaceAuthority` (P6 `03` §3). Exported for task-level
 * tests; wired into the slice handler set below. */
export const makeProposeChildWorkspaceHandler = (
  dependencies: ProposeChildWorkspaceDependencies,
): DirectiveHandler => ({
  kind: "ProposeChildWorkspace",
  handle: ({ directive, execution, context }) =>
    Effect.gen(function* () {
      if (directive._tag !== "ProposeChildWorkspace") {
        return {
          _tag: "Unsupported" as const,
          reason: "not a ProposeChildWorkspace",
        };
      }
      if (!isChildWorkspaceProposal(directive.spec)) {
        return observation(
          "Runtime",
          "formation proposal rejected: malformed ChildWorkspaceProposal payload",
        );
      }
      const spec = directive.spec;
      const proposalId = newFormationProposalId();
      const record = admitFormationProposal({
        proposalId,
        parentWorkspaceId: execution.workspaceId,
        proposal: spec,
      });
      const parent = yield* dependencies.tx.transact(
        dependencies.workspaces.findById(execution.workspaceId),
      );
      if (Option.isNone(parent)) {
        return observation(
          "Runtime",
          "formation rejected (non-fatal): proposing workspace not found",
        );
      }
      const ceilingError = validateCapabilityCeiling({
        parentBoundary: parent.value.resourceBoundary,
        draftBoundary: spec.resourceBoundaryDraft,
      });
      if (ceilingError !== null) {
        return observation(
          "Runtime",
          `formation rejected (non-fatal): ${JSON.stringify(ceilingError)}`,
        );
      }
      const path = formationPathOf(parent.value);
      if (path === "FirstLayer") {
        yield* dependencies.tx.transact(dependencies.proposals.insert(record));
        return observation(
          "Runtime",
          `governance: formation proposal ${proposalId} admitted (revision 1); human approval required before workspace creation`,
        );
      }
      const formationIds = deriveFormationIds(proposalId, 1);
      const create = formationCreatePlan({
        snapshot: record,
        ids: formationIds,
        projectId: execution.projectId,
        actor: context.principal as never,
        principal: context.principal,
      });
      const createReceipt = yield* dependencies.gateway.execute(
        {
          commandType: "CreateChildWorkspace",
          commandId: formationIds.createCommandId,
          projectId: execution.projectId,
          actor: context.principal as never,
          issuedAt: yield* dependencies.clock.now(),
          payload: create.payload,
        },
        context,
        create.authority,
      );
      if (createReceipt.resolution._tag !== "Committed") {
        const reason =
          createReceipt.resolution._tag === "TerminalRejected"
            ? JSON.stringify(createReceipt.resolution.error)
            : "operational failure";
        return observation(
          "Runtime",
          `formation rejected (non-fatal): ${reason}`,
        );
      }
      const assign = formationAssignPlan({
        snapshot: record,
        ids: formationIds,
        projectId: execution.projectId,
        actor: context.principal as never,
        principal: context.principal,
      });
      if (assign !== null) {
        yield* dependencies.gateway.execute(
          {
            commandType: "AssignWork",
            commandId: formationIds.assignCommandId,
            projectId: execution.projectId,
            actor: context.principal as never,
            issuedAt: yield* dependencies.clock.now(),
            payload: assign.payload,
          },
          context,
          assign.authority,
        );
      }
      return observation(
        "Runtime",
        `formed child workspace ${formationIds.workspaceId} (deep layer)`,
      );
    }).pipe(Effect.mapError(driverError)),
});

/** P6 `01` §3: SpawnSpecialist submits AdmitExecution(ExecutionBound) with
 * caller-preallocated ids (DID v1.7 G5); after StopExecution the current
 * execution's quiescence refuses new spawn admission (DID §3.4). */
export const makeSpawnSpecialistHandler = (
  dependencies: ProposeChildWorkspaceDependencies,
): DirectiveHandler => ({
  kind: "SpawnSpecialist",
  handle: ({ directive, execution, context }) =>
    Effect.gen(function* () {
      if (directive._tag !== "SpawnSpecialist") {
        return {
          _tag: "Unsupported" as const,
          reason: "not a SpawnSpecialist",
        };
      }
      const spec = directive.spec as { mission?: unknown };
      if (
        typeof spec !== "object" ||
        spec === null ||
        typeof spec.mission !== "string" ||
        spec.mission.length === 0
      ) {
        return observation(
          "Runtime",
          "specialist spawn rejected: malformed SpecialistSpec payload",
        );
      }
      if (execution.stopRequestedAt !== null) {
        return observation(
          "Runtime",
          "specialist spawn refused: execution is in quiescence (stop requested)",
        );
      }
      const executionId = parse(ExecutionId)(
        `exe_${newUuid7("specialist", execution.executionId)}`,
      );
      const sessionId = parse(SessionId)(
        `ses_${newUuid7("specialist", execution.executionId)}`,
      );
      const commandId = parse(CommandId)(
        `cmd_${newUuid7("specialist-admit", execution.executionId)}`,
      );
      const payload = {
        _tag: "ExecutionBound" as const,
        executionId,
        workspaceId: execution.workspaceId,
        parentExecutionId: execution.executionId,
        mission: spec.mission,
        sessionId,
      };
      const authority = {
        _tag: "AdmitExecutionAuthority" as const,
        submissionOrigin: "ExecutionOrigin" as const,
        principal: context.principal,
        commandId,
        semanticRequestFingerprint: semanticRequestFingerprint({
          commandType: "AdmitExecution",
          projectId: execution.projectId,
          actor: context.principal as never,
          schemaVersion: "1",
          payload,
        }),
        projectId: execution.projectId,
        commandKind: "AdmitExecution" as const,
        workspaceId: execution.workspaceId,
        bindingKind: "ExecutionBound" as const,
      };
      const receipt = yield* dependencies.gateway.execute(
        {
          commandType: "AdmitExecution",
          commandId,
          projectId: execution.projectId,
          actor: context.principal as never,
          issuedAt: yield* dependencies.clock.now(),
          payload,
        },
        context,
        authority,
      );
      if (receipt.resolution._tag !== "Committed") {
        const reason =
          receipt.resolution._tag === "TerminalRejected"
            ? JSON.stringify(receipt.resolution.error)
            : "operational failure";
        return observation(
          "Runtime",
          `specialist spawn rejected (non-fatal): ${reason}`,
        );
      }
      return observation(
        "Runtime",
        `specialist admitted ${executionId} (ExecutionBound, mission: ${spec.mission})`,
      );
    }).pipe(Effect.mapError(driverError)),
});

export const SliceDirectiveHandlersLive: Layer.Layer<
  SliceDirectiveHandlers,
  never,
  | ToolRuntimePort
  | SkillRegistry
  | AgentExecutionStateStore
  | Clock
  | TransactionPort
  | CommandGateway
  | WorkspaceRepository
  | FormationProposalStore
  | InboxProjectionStore
  | MessageStore
> = Layer.effect(
  SliceDirectiveHandlers,
  Effect.gen(function* () {
    const tools = yield* ToolRuntimePort;
    const skills = yield* SkillRegistry;
    const states = yield* AgentExecutionStateStore;
    const clock = yield* Clock;
    const tx = yield* TransactionPort;
    const gateway = yield* CommandGateway;
    const workspaces = yield* WorkspaceRepository;
    const proposals = yield* FormationProposalStore;

    const invokeTool: DirectiveHandler = {
      kind: "InvokeTool",
      handle: ({ directive, execution, context }) =>
        Effect.gen(function* () {
          if (directive._tag !== "InvokeTool") {
            return {
              _tag: "Unsupported" as const,
              reason: "not an InvokeTool",
            };
          }
          const requestedAt = yield* clock.now();
          const toolVersion = "1";
          const intent: ToolIntent = {
            callRef: directive.intent.callRef,
            toolName: directive.intent.toolName,
            toolVersion,
            argumentsJson: directive.intent.argumentsJson,
            invocationId: parse(ToolInvocationId)(
              `tin_018f2b3c-4d5e-7abc-8def-${directive.intent.callRef.padEnd(12, "0").slice(0, 12)}`,
            ),
            approvalId: null,
          };
          const toolContext: ToolExecutionContext = {
            executionId: execution.executionId,
            workspaceId: execution.workspaceId,
            sessionId: execution.sessionId,
            projectId: execution.projectId,
            actor: context.principal as never,
            authenticatedPrincipal: context.principal,
            authority: {
              principal: context.principal,
              workspaceId: execution.workspaceId,
              executionId: execution.executionId,
              toolName: directive.intent.toolName,
              toolVersion,
              resourceSpaceIds: ["filesystem"],
              allowedCapabilities: ["fs:read", "fs:write", "shell:exec"],
              controlBasisDigest: "slice",
              expiresAt: "2999-01-01T00:00:00.000Z",
              delegationDepth: 0,
            },
            controlBasisDigest: "slice",
            requestedAt,
          };
          const result = yield* tools.invoke(intent, toolContext);
          return toOutcome(result);
        }).pipe(Effect.mapError(driverError)),
    };

    const communicate: DirectiveHandler = {
      kind: "Communicate",
      handle: ({ directive }) =>
        Effect.succeed(
          directive._tag === "Communicate"
            ? observation("Runtime", directive.message.text)
            : { _tag: "Unsupported" as const, reason: "not a Communicate" },
        ),
    };

    const loadSkill: DirectiveHandler = {
      kind: "LoadSkill",
      handle: ({ directive }) =>
        Effect.gen(function* () {
          if (directive._tag !== "LoadSkill") {
            return { _tag: "Unsupported" as const, reason: "not a LoadSkill" };
          }
          const loaded = yield* skills
            .load(directive.skillId, directive.tier)
            .pipe(
              Effect.map((skill) => skill.content),
              Effect.orElseSucceed(() => "skill unavailable"),
            );
          return observation("Runtime", loaded);
        }),
    };

    const changeMode: DirectiveHandler = {
      kind: "ChangeMode",
      handle: ({ directive, execution }) =>
        Effect.gen(function* () {
          if (directive._tag !== "ChangeMode") {
            return { _tag: "Unsupported" as const, reason: "not a ChangeMode" };
          }
          const existing = yield* tx.transact(
            states.find(execution.executionId),
          );
          const now = yield* clock.now();
          if (Option.isSome(existing)) {
            yield* tx.transact(
              states.upsert({
                ...existing.value,
                currentMode: directive.mode,
                updatedAt: now,
              }),
            );
          }
          return observation("Runtime", `mode set to ${directive.mode}`);
        }).pipe(Effect.mapError(driverError)),
    };

    // P6 `02` §6: FormationApproval / DecisionRequest are minimally routed;
    // every other governance kind keeps the P5 observation-only behavior.
    void communicate;

    return [
      invokeTool,
      communicate,
      loadSkill,
      changeMode,
      makeRequestGovernanceHandler({
        gateway,
        workspaces,
        proposals,
        inbox: yield* InboxProjectionStore,
        tx,
        clock,
        messages: yield* MessageStore,
      }),
      makeProposeChildWorkspaceHandler({
        gateway,
        workspaces,
        proposals,
        tx,
        clock,
      }),
      makeSpawnSpecialistHandler({
        gateway,
        workspaces,
        proposals,
        tx,
        clock,
      }),
    ];
  }),
);
