import type {
  AgentActionError,
  AgentActionHandler,
  AgentActionHandlerInput,
} from "@arbor/agent-runtime";
import { Actor, parse, workEpisode } from "@arbor/domain";
import type {
  AgentLoopStepActionRecord,
  AgentLoopStepRecord,
  AgentLoopStepStoreService,
  ClockService,
  DomainEventJournalService,
  IdGeneratorService,
  PendingDomainEvent,
  ProviderTurnStoreService,
  SessionRepositoryService,
  TransactionPortService,
  WorkBlockerStoreService,
  WorkRepositoryService,
} from "@arbor/ports";
import { IdGenerator, sha256Hex } from "@arbor/ports";
import { Effect, Option } from "effect";

export interface ResolveWorkBlockerActionDependencies {
  readonly tx: TransactionPortService;
  readonly blockers: WorkBlockerStoreService;
  readonly works: Pick<WorkRepositoryService, "findById">;
  readonly loopSteps: AgentLoopStepStoreService;
  readonly providerTurns: Pick<ProviderTurnStoreService, "findManifestByTurn">;
  readonly sessionWrites: Pick<
    SessionRepositoryService,
    "appendItemIdempotent"
  >;
  readonly journal: Pick<DomainEventJournalService, "append">;
  readonly clock: ClockService;
  readonly ids: IdGeneratorService;
}

const rejected = (safeMessage: string): AgentActionError => ({
  _tag: "AgentActionRejected",
  code: "action/precondition",
  safeMessage,
  correction: "ChooseAlternative",
});

const mapActionError = (cause: unknown): AgentActionError =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  cause._tag === "AgentActionRejected"
    ? (cause as AgentActionError)
    : failure("ResolveWorkBlocker")(cause);

const failure =
  (operation: string) =>
  (cause: unknown): AgentActionError => ({
    _tag: "AgentActionOperationalFailure",
    operation,
    cause,
  });

const orderOf = (row: {
  readonly identity: {
    readonly logicalStepNo: number;
    readonly repairAttempt: number;
  };
  readonly actionIndex: number;
}) =>
  [
    row.identity.logicalStepNo,
    row.identity.repairAttempt,
    row.actionIndex,
  ] as const;

const compareOrder = (
  left: Parameters<typeof orderOf>[0],
  right: Parameters<typeof orderOf>[0],
): number => {
  const a = orderOf(left);
  const b = orderOf(right);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
};

const recordOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const hasPinnedExecutableDefinition = (
  step: AgentLoopStepRecord,
  action: AgentLoopStepActionRecord,
  providerTurns: ResolveWorkBlockerActionDependencies["providerTurns"],
): Effect.Effect<boolean, unknown, import("@arbor/ports").TransactionScope> =>
  Effect.gen(function* () {
    if (step.manifestId === undefined) return false;
    const manifest = yield* providerTurns.findManifestByTurn(
      step.providerTurnId,
    );
    if (manifest === null || manifest.manifestId !== step.manifestId)
      return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifest.manifestJson);
    } catch {
      return false;
    }
    const record = recordOf(parsed);
    if (
      record?.providerTurnId !== step.providerTurnId ||
      record.executionId !== step.identity.executionId ||
      record.logicalStepNo !== step.identity.logicalStepNo ||
      record.repairAttempt !== step.identity.repairAttempt ||
      !Array.isArray(record.toolRoutes)
    ) {
      return false;
    }
    return record.toolRoutes.some((candidate) => {
      const route = recordOf(candidate);
      return (
        route?.name === action.actionKind &&
        route.route === "Executable" &&
        typeof route.stableId === "string" &&
        typeof route.version === "string" &&
        typeof route.hash === "string"
      );
    });
  });

export const resolveWorkBlockerHandler = (
  dependencies: ResolveWorkBlockerActionDependencies,
): AgentActionHandler => ({
  action: "ResolveWorkBlocker",
  handle: (input: AgentActionHandlerInput) =>
    Effect.gen(function* () {
      if (input.action._tag !== "ResolveWorkBlocker") {
        return yield* Effect.fail(
          failure("ResolveWorkBlocker.dispatch")(
            "handler received a different action",
          ),
        );
      }
      const action = input.action;
      const episode = workEpisode(input.execution);
      const context = input.actionContext;
      const fence = input.loopStepFence;
      if (episode === null || context === undefined || fence === undefined) {
        return yield* Effect.fail(
          rejected("resolve_work_blocker requires an exact active WorkEpisode"),
        );
      }
      const now = yield* dependencies.clock.now();
      const output = yield* dependencies.tx.transact(
        Effect.gen(function* () {
          const work = yield* dependencies.works.findById(episode.workId);
          if (
            Option.isNone(work) ||
            work.value.lifecycle !== "Open" ||
            work.value.workspaceId !== input.execution.workspaceId ||
            work.value.revision !== episode.targetWorkRevision
          ) {
            return yield* Effect.fail(
              rejected(
                "Work revision changed; resolve the current blocker after a new turn",
              ),
            );
          }
          const currentStep = yield* dependencies.loopSteps.find(
            context.identity,
          );
          if (
            Option.isNone(currentStep) ||
            currentStep.value.state !== "ActionsInProgress" ||
            currentStep.value.providerTurnId !== context.providerTurnId
          ) {
            return yield* Effect.fail(
              rejected("the current P9 action identity is stale"),
            );
          }
          const actionRows = yield* dependencies.loopSteps.listActions(
            context.identity,
          );
          const currentAction = actionRows.find(
            (row) =>
              row.actionIndex === context.actionIndex &&
              row.callRef === context.callRef &&
              row.logicalActionId === input.logicalActionId &&
              row.state === "Pending" &&
              row.routeKind === "Control" &&
              row.actionKind === "resolve_work_blocker",
          );
          if (currentAction === undefined) {
            return yield* Effect.fail(
              rejected("resolve_work_blocker P9 action is not Pending"),
            );
          }

          const chain: AgentLoopStepRecord[] = [];
          let cursor: AgentLoopStepRecord | undefined = currentStep.value;
          for (let count = 0; cursor !== undefined && count < 256; count += 1) {
            chain.push(cursor);
            if (cursor.predecessor === undefined) break;
            const previous: Option.Option<AgentLoopStepRecord> =
              yield* dependencies.loopSteps.find(cursor.predecessor);
            if (Option.isNone(previous)) {
              return yield* Effect.fail(
                rejected(
                  "P9 action history is incomplete; cannot verify recovery refs",
                ),
              );
            }
            cursor = previous.value;
          }
          if (cursor?.predecessor !== undefined) {
            return yield* Effect.fail(
              rejected("P9 action history exceeded the bounded recovery scan"),
            );
          }
          chain.sort(
            (a, b) =>
              a.identity.logicalStepNo - b.identity.logicalStepNo ||
              a.identity.repairAttempt - b.identity.repairAttempt,
          );
          const history: Array<{
            readonly step: AgentLoopStepRecord;
            readonly action: AgentLoopStepActionRecord;
          }> = [];
          for (const step of chain) {
            const rows = yield* dependencies.loopSteps.listActions(
              step.identity,
            );
            history.push(...rows.map((action) => ({ step, action })));
          }
          const resolvedIds: string[] = [];
          const events: PendingDomainEvent[] = [];
          const actor = parse(Actor)("agent:runtime");
          for (const resolution of action.resolutions) {
            const blocker = yield* dependencies.blockers.findById(
              resolution.blockerId as never,
            );
            if (Option.isNone(blocker)) {
              return yield* Effect.fail(
                rejected("the requested blocker no longer exists"),
              );
            }
            const row = blocker.value;
            if (
              row.state === "Resolved" &&
              row.workId === episode.workId &&
              row.targetWorkRevision === episode.targetWorkRevision
            ) {
              resolvedIds.push(row.blockerId);
              continue;
            }
            if (
              row.state !== "Open" ||
              row.workId !== episode.workId ||
              row.targetWorkRevision !== episode.targetWorkRevision ||
              row.workspaceId !== input.execution.workspaceId
            ) {
              return yield* Effect.fail(
                rejected("the blocker is not open on this exact Work revision"),
              );
            }
            const successful = resolution.successfulActionRefs.map((ref) =>
              history.filter(({ action }) => action.logicalActionId === ref),
            );
            if (successful.some((matches) => matches.length !== 1)) {
              return yield* Effect.fail(
                rejected(
                  "each successfulActionRef must identify one exact P9 action",
                ),
              );
            }
            const successRows = [] as (typeof history)[number][];
            for (const matches of successful) {
              const success = matches[0];
              if (success === undefined) {
                return yield* Effect.fail(
                  rejected("successful action ref could not be resolved"),
                );
              }
              successRows.push(success);
            }
            for (const success of successRows) {
              const disposition = recordOf(success.action.disposition);
              if (
                success.action.state !== "Applied" ||
                success.action.routeKind !== "Executable" ||
                disposition?.status !== "Succeeded" ||
                compareOrder(success.action, {
                  identity: context.identity,
                  actionIndex: context.actionIndex,
                }) >= 0 ||
                !(yield* hasPinnedExecutableDefinition(
                  success.step,
                  success.action,
                  dependencies.providerTurns,
                ))
              ) {
                return yield* Effect.fail(
                  rejected(
                    "successful action ref is not a later exact executable success",
                  ),
                );
              }
            }
            for (const deniedRef of row.failedActionRefs) {
              const denied = history.find(
                ({ step, action }) =>
                  step.identity.logicalStepNo === deniedRef.logicalStepNo &&
                  step.identity.repairAttempt === deniedRef.repairAttempt &&
                  action.actionIndex === deniedRef.actionIndex &&
                  action.logicalActionId === deniedRef.logicalActionId &&
                  action.callRef === deniedRef.callRef,
              );
              if (denied === undefined) {
                return yield* Effect.fail(
                  rejected(
                    "the blocker’s failed P9 action evidence is no longer available",
                  ),
                );
              }
              const matchingRecovery = successRows.some(
                (success) =>
                  success.action.actionKind === denied.action.actionKind &&
                  success.action.inputHash === denied.action.inputHash &&
                  compareOrder(success.action, denied.action) > 0,
              );
              if (!matchingRecovery) {
                return yield* Effect.fail(
                  rejected(
                    "each denied action requires a later successful action with matching input",
                  ),
                );
              }
            }
            yield* dependencies.blockers.resolve({
              blockerId: row.blockerId,
              workId: row.workId,
              targetWorkRevision: row.targetWorkRevision,
              successfulActionRefs: resolution.successfulActionRefs,
            });
            resolvedIds.push(row.blockerId);
            events.push({
              projectId: row.projectId,
              eventType: "WorkBlockerResolved",
              eventVersion: 1,
              occurredAt: now,
              aggregateRef: row.workId,
              actor,
              payload: {
                blockerId: row.blockerId,
                workId: row.workId,
                workRevision: row.targetWorkRevision,
                resolvedAt: now,
              },
            });
          }

          const observation = {
            text: `Resolved ${resolvedIds.length} verified Work blocker(s).`,
            truncated: false,
          };
          const sessionPayload = {
            source: "Runtime",
            observation,
            status: "Succeeded" as const,
            disposition: "Applied",
          };
          const resultRef = `result_${sha256Hex(JSON.stringify(sessionPayload))}`;
          const observationSourceRef = `observation_${input.execution.executionId}_${sha256Hex(
            JSON.stringify({
              providerTurnId: context.providerTurnId,
              callRef: context.callRef,
              resultRef,
            }),
          )}`;
          yield* dependencies.sessionWrites.appendItemIdempotent(
            input.execution.sessionId,
            {
              item: {
                _tag: "ControlResult",
                callRef: context.callRef,
                actionKind: "resolve_work_blocker",
                status: "Succeeded",
                disposition: "Applied",
                outputText: observation.text,
                truncated: false,
                canonicalRefs: resolvedIds,
                observationRef: observationSourceRef,
              },
              contextEpoch: context.contextEpoch,
              source: { kind: "AgentLoopAction", ref: observationSourceRef },
              contentHash: sha256Hex(
                JSON.stringify({
                  _tag: "ControlResult",
                  callRef: context.callRef,
                  actionKind: "resolve_work_blocker",
                  status: "Succeeded",
                  disposition: "Applied",
                  outputText: observation.text,
                  truncated: false,
                  canonicalRefs: resolvedIds,
                  observationRef: observationSourceRef,
                }),
              ),
            },
            fence,
          );
          yield* dependencies.loopSteps.transitionAction(
            {
              identity: context.identity,
              actionIndex: context.actionIndex,
              expectedRevision: currentAction.revision,
              expectedState: "Pending",
              next: {
                ...currentAction,
                state: "Applied",
                resultRef,
                disposition: { _tag: "Applied", status: "Succeeded" },
                observationSourceRef,
                revision: currentAction.revision + 1,
                updatedAt: now,
              },
            },
            fence,
          );
          const nextStep = yield* dependencies.loopSteps.transition(
            {
              identity: context.identity,
              expectedRevision: currentStep.value.revision,
              expectedState: "ActionsInProgress",
              next: {
                ...currentStep.value,
                nextActionIndex: Math.max(
                  currentStep.value.nextActionIndex,
                  context.actionIndex + 1,
                ),
                revision: currentStep.value.revision + 1,
                updatedAt: now,
              },
            },
            fence,
          );
          if (events.length > 0) yield* dependencies.journal.append(events);
          return { nextStep, observation, resolvedIds, observationSourceRef };
        }).pipe(Effect.provideService(IdGenerator, dependencies.ids)),
      );
      return {
        _tag: "Observation" as const,
        source: "Runtime" as const,
        observation: output.observation,
        durableActionCommit: { loopStep: output.nextStep },
      };
    }).pipe(Effect.mapError(mapActionError)),
});
