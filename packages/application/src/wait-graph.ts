import {
  Actor,
  type Dependency,
  type DependencyId,
  type ProjectId,
  parse,
  type WakeCondition,
  type WorkId,
  type WorkLifecycle,
  type WorkspaceId,
} from "@arbor/domain";
import type {
  DependencyRepositoryError,
  DependencyRepositoryService,
  PendingDomainEvent,
  RunnableWorkSourceError,
  RunnableWorkSourceService,
  TransactionOperationalFailure,
  WorkRepositoryError,
  WorkRepositoryService,
  WorkWaitStoreError,
  WorkWaitStoreService,
} from "@arbor/ports";
import { TransactionPort, TransactionScope } from "@arbor/ports";
import { Effect, Option } from "effect";

/** P7 `05` — wait-for graph (derived view), deterministic deadlock detection
 * and the `DeadlockAttentionRequested` fact. Zero mutation: detection only
 * produces facts; escalation stays human/Parent cognition (G4, S3 step 12).
 * The graph is a pure function over (dependencies × work_waits × works) —
 * no new canonical entity, no new store. */

// --- §1 pure graph construction ---

export type WaitEdgeTarget =
  | { readonly kind: "Work"; readonly workId: WorkId }
  | { readonly kind: "Choice"; readonly candidates: ReadonlyArray<WorkId> };

/** Conservative degeneration markers (05 §1, frozen): a Choice target with
 * exactly one eligible producer candidate participates in hard-deadlock
 * determination as a plain Work edge; zero and ≥2 candidates do not. */
export type WaitEdgeExclusion = "VacantWorkspace" | "ChoiceNotDegenerate";

export interface WaitGraphEdge {
  readonly consumerWorkId: WorkId;
  readonly dependencyId: DependencyId;
  readonly target: WaitEdgeTarget;
  readonly exclusion: WaitEdgeExclusion | null;
}

export interface WaitGraph {
  readonly edges: ReadonlyArray<WaitGraphEdge>;
}

export interface WaitGraphWork {
  readonly workId: WorkId;
  readonly lifecycle: WorkLifecycle;
  readonly workspaceId: WorkspaceId;
}

export interface WaitGraphWait {
  readonly workId: WorkId;
  readonly conditions: ReadonlyArray<WakeCondition>;
  readonly active: true;
}

const waitReferencesDependency = (
  wait: WaitGraphWait,
  dependencyId: DependencyId,
): boolean =>
  wait.conditions.some(
    (condition) =>
      condition._tag === "DependencyChanged" &&
      condition.dependencyId === dependencyId,
  );

/** Valid edge predicate = `03` §3 blocking(d, w), quoted whole:
 * `d.state = Unsatisfied ∧ d.consumerWorkId = w ∧ ∃ active WorkWait of w
 * containing DependencyChanged(d.dependencyId, _)` (any observedRevision).
 * The Unsatisfied conjunct is not optional: during the wake-latency window
 * where a dependency is terminal but the consumer wait is not yet cleared,
 * the dependency is not a valid edge (ghost-edge guard, G3 — waiting is a
 * cognitive decision). Consumers are nodes: Open Works only. */
export const buildWaitGraph = (args: {
  readonly works: ReadonlyArray<WaitGraphWork>;
  readonly waits: ReadonlyArray<WaitGraphWait>;
  readonly dependencies: ReadonlyArray<Dependency>;
}): WaitGraph => {
  const openWorks = args.works.filter((work) => work.lifecycle === "Open");
  const openIds = new Set(openWorks.map((work) => work.workId));
  const openByWorkspace = new Map<WorkspaceId, WorkId[]>();
  for (const work of openWorks) {
    const previous = openByWorkspace.get(work.workspaceId) ?? [];
    previous.push(work.workId);
    openByWorkspace.set(work.workspaceId, previous);
  }
  for (const candidates of openByWorkspace.values()) {
    candidates.sort();
  }

  const waitsByWork = new Map<WorkId, WaitGraphWait[]>();
  for (const wait of args.waits) {
    const previous = waitsByWork.get(wait.workId) ?? [];
    previous.push(wait);
    waitsByWork.set(wait.workId, previous);
  }

  const edges: WaitGraphEdge[] = [];
  for (const dependency of [...args.dependencies].sort((a, b) =>
    a.dependencyId < b.dependencyId
      ? -1
      : a.dependencyId > b.dependencyId
        ? 1
        : 0,
  )) {
    if (dependency.state !== "Unsatisfied") {
      continue;
    }
    const consumer = dependency.consumerWorkId;
    if (!openIds.has(consumer)) {
      continue;
    }
    const referenced = (waitsByWork.get(consumer) ?? []).some((wait) =>
      waitReferencesDependency(wait, dependency.dependencyId),
    );
    if (!referenced) {
      continue;
    }
    const binding = dependency.producerBinding;
    if (binding._tag === "AnyProducer") {
      continue;
    }
    if (binding._tag === "WorkBound") {
      // Plain Work edge; a terminal producer target simply has no outgoing
      // edges of its own, so it can never close a cycle.
      edges.push({
        consumerWorkId: consumer,
        dependencyId: dependency.dependencyId,
        target: { kind: "Work", workId: binding.workId },
        exclusion: null,
      });
      continue;
    }
    const candidates = openByWorkspace.get(binding.workspaceId) ?? [];
    const exclusion =
      candidates.length === 1
        ? null
        : candidates.length === 0
          ? "VacantWorkspace"
          : "ChoiceNotDegenerate";
    edges.push({
      consumerWorkId: consumer,
      dependencyId: dependency.dependencyId,
      target: { kind: "Choice", candidates },
      exclusion,
    });
  }
  return { edges };
};

// --- §2 cycle detection ---

export interface ClassifyOutputForGate {
  readonly workspaceId: WorkspaceId;
  readonly current: Option.Option<WorkId>;
  readonly runnable: ReadonlyArray<WorkId>;
}

export interface DeadlockFact {
  readonly cycleWorkIds: ReadonlyArray<WorkId>;
  readonly dependencyIds: ReadonlyArray<DependencyId>;
  readonly detectedAt: string;
}

/** Plain directed edge handed to the cycle detector. Degenerate choices
 * (exactly one eligible candidate) collapse to that candidate here. */
export interface ParticipatingEdge {
  readonly from: WorkId;
  readonly to: WorkId;
  readonly dependencyId: DependencyId;
}

export interface DetectedCycle {
  readonly cycleWorkIds: ReadonlyArray<WorkId>;
  readonly dependencyIds: ReadonlyArray<DependencyId>;
}

/** Replaceable detector boundary (05 §2 seam): an OR-aware choice-aware SCC
 * upgrade replaces only this component — graph construction, the valid-edge
 * predicate and the Project-Idle gate stay untouched. Introducing one is a
 * governance change, never an implementation invention. */
export interface DeadlockDetector {
  readonly findCycle: (
    edges: ReadonlyArray<ParticipatingEdge>,
  ) => DetectedCycle | null;
}

/** Deterministic DFS cycle detection over the plain-edge set: nodes are
 * visited and neighbors explored in sorted order, so the reported cycle is
 * a pure function of the graph. Self-loops (a work waiting on its own
 * dependency) are cycles of one. */
export const conservativeDetector: DeadlockDetector = {
  findCycle: (edges) => {
    const adjacency = new Map<WorkId, ParticipatingEdge[]>();
    for (const edge of edges) {
      const previous = adjacency.get(edge.from) ?? [];
      previous.push(edge);
      adjacency.set(edge.from, previous);
    }
    for (const outgoing of adjacency.values()) {
      outgoing.sort((a, b) =>
        a.to < b.to
          ? -1
          : a.to > b.to
            ? 1
            : a.dependencyId < b.dependencyId
              ? -1
              : a.dependencyId > b.dependencyId
                ? 1
                : 0,
      );
    }

    const color = new Map<WorkId, "gray" | "black">();
    const pathWorks: WorkId[] = [];
    const pathEdges: ParticipatingEdge[] = [];
    let found: DetectedCycle | null = null;

    const visit = (node: WorkId): void => {
      color.set(node, "gray");
      pathWorks.push(node);
      for (const edge of adjacency.get(node) ?? []) {
        if (found !== null) {
          return;
        }
        const targetColor = color.get(edge.to);
        if (targetColor === "gray") {
          const start = pathWorks.indexOf(edge.to);
          const cycleWorks = pathWorks.slice(start);
          const cycleEdges = [...pathEdges.slice(start), edge];
          found = {
            cycleWorkIds: [...new Set(cycleWorks)].sort(),
            dependencyIds: [
              ...new Set(cycleEdges.map((hop) => hop.dependencyId)),
            ].sort(),
          };
          return;
        }
        if (targetColor === undefined) {
          pathEdges.push(edge);
          visit(edge.to);
          pathEdges.pop();
        }
      }
      color.set(node, "black");
      pathWorks.pop();
    };

    for (const node of [...adjacency.keys()].sort()) {
      if (found !== null) {
        break;
      }
      if (!color.has(node)) {
        visit(node);
      }
    }
    return found;
  },
};

/** `hasDeadlock(graph)` = a wait-cycle whose members are all blocked ∧ the
 * Project is universally Idle (No.20 quantified over every workspace of the
 * Project — classify is the only runnability authority, `03` §2). Blocked
 * membership is guaranteed by construction: every participating edge exists
 * only where the `03` §3 predicate holds (Unsatisfied ∧ referenced active
 * wait), so every cycle member — each owns an outgoing participating edge —
 * is blocked. Pure: no mutation, injectable clock. */
export const detectDeadlock = (
  graph: WaitGraph,
  args: {
    readonly classifyOutputs: ReadonlyArray<ClassifyOutputForGate>;
    readonly now: string;
  },
  detector: DeadlockDetector = conservativeDetector,
): DeadlockFact | null => {
  const projectIdle = args.classifyOutputs.every(
    (output) => Option.isNone(output.current) && output.runnable.length === 0,
  );
  if (!projectIdle) {
    return null;
  }
  const participating: ParticipatingEdge[] = [];
  for (const edge of graph.edges) {
    if (edge.exclusion !== null) {
      continue;
    }
    if (edge.target.kind === "Work") {
      participating.push({
        from: edge.consumerWorkId,
        to: edge.target.workId,
        dependencyId: edge.dependencyId,
      });
      continue;
    }
    // exclusion === null ⇒ exactly one candidate (05 §1 degeneration)
    const [candidate] = edge.target.candidates;
    if (candidate === undefined) {
      continue;
    }
    participating.push({
      from: edge.consumerWorkId,
      to: candidate,
      dependencyId: edge.dependencyId,
    });
  }
  const cycle = detector.findCycle(participating);
  return cycle === null ? null : { ...cycle, detectedAt: args.now };
};

/** Boolean projection of detectDeadlock (re-check call sites only need the
 * predicate; the fact/event projection is owned by evaluateDeadlock). */
export const hasDeadlock = (
  graph: WaitGraph,
  classifyOutputs: ReadonlyArray<ClassifyOutputForGate>,
): boolean => detectDeadlock(graph, { classifyOutputs, now: "" }) !== null;

/** Re-check trigger principle (05 §2, frozen — the principle, not a closed
 * event list): any canonical fact commit that changes (a) runnability,
 * (b) the wait-for relation, (c) the eligible producer candidate set, or
 * (d) a Dependency open/terminal state must trigger re-check. The list
 * below is the current derivation, illustrative and non-exhaustive — the
 * principle governs. WorkWait upsert/clear are store-level facts, hence
 * their marker names rather than domain event types. */
export const DEADLOCK_RECHECK_TRIGGERS: ReadonlyArray<string> = [
  "DependencyDeclared",
  "DependencySatisfied",
  "DependencyWithdrawn",
  "DependencyMarkedUnfulfillable",
  "DependencyContractRevised",
  "DeliverableProduced",
  "WorkWaitUpsert",
  "WorkWaitCleared",
  "WorkAssigned",
  "WorkCancelled",
  "WorkCompleted",
  "WorkspaceRetired",
];

// --- runtime entry (read-only snapshot; fact returned, not committed) ---

export interface WaitGraphReadFailure {
  readonly _tag: "WaitGraphReadFailure";
  readonly cause: unknown;
}

export type WaitGraphReadError =
  | WaitGraphReadFailure
  | WorkRepositoryError
  | DependencyRepositoryError
  | WorkWaitStoreError
  | RunnableWorkSourceError;

export interface EvaluateDeadlockDependencies {
  readonly projectId: ProjectId;
  /** Enumerates every workspace of the Project for the universal Idle gate
   * and the per-workspace Open-work read. No project-scoped enumeration
   * port exists yet, so this is the caller-supplied seam. */
  readonly listWorkspaceIds: () => Effect.Effect<
    ReadonlyArray<WorkspaceId>,
    WaitGraphReadError,
    TransactionScope
  >;
  readonly works: Pick<WorkRepositoryService, "listByWorkspace">;
  readonly dependencies: Pick<
    DependencyRepositoryService,
    "listUnsatisfiedByProject"
  >;
  readonly waits: Pick<WorkWaitStoreService, "listActive">;
  readonly classify: RunnableWorkSourceService["classify"];
}

export interface DeadlockDetection {
  readonly fact: DeadlockFact;
  /** `DeadlockAttentionRequested` as a PendingDomainEvent — the caller
   * (011 consumption pipeline / 012 acceptance) commits it at a reliable
   * boundary via gateway or journal; this task wires no daemon. */
  readonly event: PendingDomainEvent;
}

export const DEADLOCK_DETECTOR_ACTOR: Actor = parse(Actor)(
  "runtime:deadlock-detector",
);

const deadlockEvent = (
  projectId: ProjectId,
  fact: DeadlockFact,
): PendingDomainEvent => ({
  projectId,
  eventType: "DeadlockAttentionRequested",
  eventVersion: 1,
  occurredAt: fact.detectedAt,
  aggregateRef: `deadlock:${[...fact.cycleWorkIds].sort().join("+")}`,
  actor: DEADLOCK_DETECTOR_ACTOR,
  payload: {
    _tag: "DeadlockAttentionRequested",
    cycleWorkIds: fact.cycleWorkIds,
    dependencyIds: fact.dependencyIds,
    detectedAt: fact.detectedAt,
  },
});

/** One read-only snapshot over (works × dependencies × work_waits ×
 * classify), then the pure detection. Detection emits facts only — no
 * Work/Dependency lifecycle change, no WorkWait registration/clearing, no
 * journal write; the event draft is returned for the caller to commit. */
export const evaluateDeadlock = (
  deps: EvaluateDeadlockDependencies,
  now: string,
): Effect.Effect<
  Option.Option<DeadlockDetection>,
  WaitGraphReadError | TransactionOperationalFailure,
  TransactionPort
> =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const body = Effect.gen(function* () {
      const workspaceIds = yield* deps.listWorkspaceIds();

      const works: WaitGraphWork[] = [];
      for (const workspaceId of workspaceIds) {
        const open = yield* deps.works.listByWorkspace(workspaceId, "Open");
        for (const work of open) {
          works.push({
            workId: work.workId,
            lifecycle: work.lifecycle,
            workspaceId: work.workspaceId,
          });
        }
      }

      const unsatisfied = yield* deps.dependencies.listUnsatisfiedByProject(
        deps.projectId,
      );
      const activeWaits = yield* deps.waits.listActive();
      const waits: WaitGraphWait[] = activeWaits.map((wait) => ({
        workId: wait.workId,
        conditions: wait.waitSpec.conditions,
        active: true,
      }));

      const classifyOutputs: ClassifyOutputForGate[] = [];
      for (const workspaceId of workspaceIds) {
        const output = yield* deps.classify(workspaceId);
        classifyOutputs.push({
          workspaceId,
          current: output.current,
          runnable: output.runnable,
        });
      }

      const graph = buildWaitGraph({
        works,
        waits,
        dependencies: unsatisfied,
      });
      const fact = detectDeadlock(graph, { classifyOutputs, now });
      if (fact === null) {
        return Option.none<DeadlockDetection>();
      }
      return Option.some({
        fact,
        event: deadlockEvent(deps.projectId, fact),
      });
    });
    const ambient = yield* Effect.serviceOption(TransactionScope);
    if (Option.isSome(ambient)) {
      return yield* Effect.provideService(
        body,
        TransactionScope,
        ambient.value,
      );
    }
    return yield* tx.transact(body);
  });
