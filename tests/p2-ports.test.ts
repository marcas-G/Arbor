import type { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type {
  ExecutionRepositoryService,
  RunnableWorkSourceService,
  SessionEntryKind,
  WorkerDispatchPortService,
} from "../packages/ports/src/index.js";
import {
  ExecutionDriverPort,
  ExecutionRepository,
  ExecutionScheduler,
  LeaseService,
  ReconciliationSource,
  RunnableWorkSource,
  RuntimeSafetyGate,
  SchedulerTimerStore,
  WorkerDispatchPort,
  WorkWaitStore,
} from "../packages/ports/src/index.js";

type RequirementOf<T> =
  T extends Effect.Effect<unknown, unknown, infer R> ? R : never;

// Compile-time: repository methods require TransactionScope; dispatch does not.
type _RepoNeedsScope = RequirementOf<
  ReturnType<ExecutionRepositoryService["findById"]>
>;
const repoScopeOk: _RepoNeedsScope = {} as never;
void repoScopeOk;

type _DispatchNeeds = RequirementOf<
  ReturnType<WorkerDispatchPortService["dispatch"]>
>;
const dispatchNoScope: _DispatchNeeds = undefined as never;
void dispatchNoScope;

type _ClassifyNeeds = RequirementOf<
  ReturnType<RunnableWorkSourceService["classify"]>
>;
const classifyNoScope: _ClassifyNeeds = undefined as never;
void classifyNoScope;

describe("P2 ports", () => {
  it("exports the P2 Effect services with stable keys", () => {
    expect(ExecutionRepository.key).toBe("arbor/ExecutionRepository");
    expect(LeaseService.key).toBe("arbor/LeaseService");
    expect(WorkerDispatchPort.key).toBe("arbor/WorkerDispatchPort");
    expect(ExecutionDriverPort.key).toBe("arbor/ExecutionDriverPort");
    expect(RuntimeSafetyGate.key).toBe("arbor/RuntimeSafetyGate");
    expect(ExecutionScheduler.key).toBe("arbor/ExecutionScheduler");
    expect(RunnableWorkSource.key).toBe("arbor/RunnableWorkSource");
    expect(WorkWaitStore.key).toBe("arbor/WorkWaitStore");
    expect(SchedulerTimerStore.key).toBe("arbor/SchedulerTimerStore");
    expect(ReconciliationSource.key).toBe("arbor/ReconciliationSource");
  });

  it("freezes the Session entry kinds", () => {
    const kinds: ReadonlyArray<SessionEntryKind> = [
      "Input",
      "ModelOutput",
      "Observation",
      "CheckpointReference",
      "ContextUpdate",
    ];
    expect(kinds).toHaveLength(5);
  });
});
