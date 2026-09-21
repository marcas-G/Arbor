import { Schema } from "effect";
import type { Actor } from "./actor.js";
import {
  ArtifactId,
  DeliverableId,
  type DependencyId,
  type VerificationId,
  WorkId,
  type WorkspaceId,
} from "./ids.js";
import { type DependencyRevision, WorkRevision } from "./ordinals.js";
import type { DomainResult } from "./result.js";
import { err, ok } from "./result.js";

export const DeliverableKind = Schema.String.pipe(
  Schema.brand("DeliverableKind"),
);
export type DeliverableKind = Schema.Schema.Type<typeof DeliverableKind>;

export const ArtifactRole = Schema.String.pipe(Schema.brand("ArtifactRole"));
export type ArtifactRole = Schema.Schema.Type<typeof ArtifactRole>;

export type ProducerBinding =
  | { readonly _tag: "AnyProducer" }
  | { readonly _tag: "WorkspaceBound"; readonly workspaceId: WorkspaceId }
  | { readonly _tag: "WorkBound"; readonly workId: WorkId };

export const anyProducer: ProducerBinding = { _tag: "AnyProducer" };

export const workspaceBound = (workspaceId: WorkspaceId): ProducerBinding => ({
  _tag: "WorkspaceBound",
  workspaceId,
});

export const workBound = (workId: WorkId): ProducerBinding => ({
  _tag: "WorkBound",
  workId,
});

export const ExpectedDeliverable = Schema.Struct({
  kind: DeliverableKind,
  requiredArtifactRoles: Schema.Array(ArtifactRole),
});
export type ExpectedDeliverable = Schema.Schema.Type<
  typeof ExpectedDeliverable
>;

export const DeliverableArtifact = Schema.Struct({
  role: ArtifactRole,
  artifactId: ArtifactId,
});
export type DeliverableArtifact = Schema.Schema.Type<
  typeof DeliverableArtifact
>;

export const Deliverable = Schema.Struct({
  deliverableId: DeliverableId,
  sourceWorkId: WorkId,
  sourceWorkRevision: WorkRevision,
  kind: DeliverableKind,
  artifacts: Schema.Array(DeliverableArtifact),
});
export type Deliverable = Schema.Schema.Type<typeof Deliverable>;

export interface DeliverableMatchView {
  readonly deliverableId: DeliverableId;
  readonly sourceWorkId: WorkId;
  readonly sourceWorkspaceId: WorkspaceId;
  readonly kind: DeliverableKind;
  readonly artifactRoles: ReadonlySet<ArtifactRole>;
}

export const matchesExpectedDeliverable = (
  producerBinding: ProducerBinding,
  expected: ExpectedDeliverable,
  candidate: DeliverableMatchView,
): boolean => {
  const producerMatches =
    producerBinding._tag === "AnyProducer" ||
    (producerBinding._tag === "WorkspaceBound" &&
      candidate.sourceWorkspaceId === producerBinding.workspaceId) ||
    (producerBinding._tag === "WorkBound" &&
      candidate.sourceWorkId === producerBinding.workId);
  if (!producerMatches) {
    return false;
  }
  if (candidate.kind !== expected.kind) {
    return false;
  }
  return expected.requiredArtifactRoles.every((role) =>
    candidate.artifactRoles.has(role),
  );
};

export type DependencyLifecycle =
  | "Unsatisfied"
  | "Satisfied"
  | "Withdrawn"
  | "Unfulfillable";

export interface Dependency {
  readonly dependencyId: DependencyId;
  readonly consumerWorkId: WorkId;
  readonly producerBinding: ProducerBinding;
  readonly revision: DependencyRevision;
  readonly expectedDeliverable: ExpectedDeliverable;
  readonly state: DependencyLifecycle;
  readonly satisfiedByDeliverableId: DeliverableId | null;
  readonly satisfiedAtDependencyRevision: DependencyRevision | null;
}

const isTerminal = (state: DependencyLifecycle): boolean =>
  state !== "Unsatisfied";

const terminalError = () => ({
  _tag: "TerminalLifecycleMutation" as const,
  entity: "Dependency",
  lifecycle: "terminal",
});

export interface DeclareDependencyInput {
  readonly dependencyId: DependencyId;
  readonly consumerWorkId: WorkId;
  readonly producerBinding: ProducerBinding;
  readonly revision: DependencyRevision;
  readonly expectedDeliverable: ExpectedDeliverable;
}

export const declareDependency = (
  input: DeclareDependencyInput,
): Dependency => ({
  dependencyId: input.dependencyId,
  consumerWorkId: input.consumerWorkId,
  producerBinding: input.producerBinding,
  revision: input.revision,
  expectedDeliverable: input.expectedDeliverable,
  state: "Unsatisfied",
  satisfiedByDeliverableId: null,
  satisfiedAtDependencyRevision: null,
});

export interface ReviseExpectedContractInput {
  readonly authorized: boolean;
  readonly expectedDeliverable: ExpectedDeliverable;
  readonly revision: DependencyRevision;
}

export const reviseExpectedContract = (
  dependency: Dependency,
  input: ReviseExpectedContractInput,
): DomainResult<Dependency> => {
  if (isTerminal(dependency.state)) {
    return err(terminalError());
  }
  if (!input.authorized) {
    return err({
      _tag: "AuthorityDenied",
      reason: "reviseExpectedContract requires authority",
    });
  }
  return ok({
    ...dependency,
    expectedDeliverable: input.expectedDeliverable,
    revision: input.revision,
  });
};

export const satisfyDependency = (
  dependency: Dependency,
  candidate: DeliverableMatchView,
): DomainResult<Dependency> => {
  if (isTerminal(dependency.state)) {
    return err(terminalError());
  }
  if (
    !matchesExpectedDeliverable(
      dependency.producerBinding,
      dependency.expectedDeliverable,
      candidate,
    )
  ) {
    return err({
      _tag: "DependencyNotSatisfiable",
      dependencyId: dependency.dependencyId,
    });
  }
  return ok({
    ...dependency,
    state: "Satisfied",
    satisfiedByDeliverableId: candidate.deliverableId,
    satisfiedAtDependencyRevision: dependency.revision,
  });
};

export const withdrawDependency = (
  dependency: Dependency,
): DomainResult<Dependency> => {
  if (isTerminal(dependency.state)) {
    return err(terminalError());
  }
  return ok({ ...dependency, state: "Withdrawn" });
};

export const markDependencyUnfulfillable = (
  dependency: Dependency,
): DomainResult<Dependency> => {
  if (isTerminal(dependency.state)) {
    return err(terminalError());
  }
  return ok({ ...dependency, state: "Unfulfillable" });
};

export interface Acceptance {
  readonly workId: WorkId;
  readonly targetWorkRevision: WorkRevision;
  readonly verificationId: VerificationId;
  readonly actor: Actor;
  readonly acceptedAt: string;
}

export const createAcceptance = (input: Acceptance): Acceptance => ({
  ...input,
});

export const withdrawDependenciesOnWorkCancel = (
  consumerWorkId: WorkId,
  dependencies: ReadonlyArray<Dependency>,
): ReadonlyArray<Dependency> =>
  dependencies.map((dependency) =>
    dependency.consumerWorkId === consumerWorkId &&
    dependency.state === "Unsatisfied"
      ? { ...dependency, state: "Withdrawn" }
      : dependency,
  );

export type ProducerLoss =
  | { readonly _tag: "WorkCancelled"; readonly workId: WorkId }
  | { readonly _tag: "WorkspaceRetired"; readonly workspaceId: WorkspaceId };

export interface ProducerLossFacts {
  readonly binding: ProducerBinding;
  readonly lost: ProducerLoss;
  readonly replacedInSameGovernanceChange: boolean;
}

const factAffectsBinding = (
  fact: ProducerLossFacts,
  binding: ProducerBinding,
): boolean => {
  if (fact.replacedInSameGovernanceChange) {
    return false;
  }
  if (
    binding._tag === "WorkBound" &&
    fact.binding._tag === "WorkBound" &&
    fact.lost._tag === "WorkCancelled"
  ) {
    return (
      binding.workId === fact.binding.workId &&
      binding.workId === fact.lost.workId
    );
  }
  if (
    binding._tag === "WorkspaceBound" &&
    fact.binding._tag === "WorkspaceBound" &&
    fact.lost._tag === "WorkspaceRetired"
  ) {
    return (
      binding.workspaceId === fact.binding.workspaceId &&
      binding.workspaceId === fact.lost.workspaceId
    );
  }
  return false;
};

export const markUnfulfillableOnProducerLoss = (
  facts: ReadonlyArray<ProducerLossFacts>,
  dependencies: ReadonlyArray<Dependency>,
): ReadonlyArray<Dependency> =>
  dependencies.map((dependency) => {
    if (dependency.state !== "Unsatisfied") {
      return dependency;
    }
    if (dependency.producerBinding._tag === "AnyProducer") {
      return dependency;
    }
    const affected = facts.some((fact) =>
      factAffectsBinding(fact, dependency.producerBinding),
    );
    return affected ? { ...dependency, state: "Unfulfillable" } : dependency;
  });

// --- P7 directive specs (P7 `01` §9, `02` §8; DID v1.10 §8.15) ---

/** DeclareDependency directive payload (consumer side). */
export interface DeclareDependencySpec {
  readonly consumerWorkId: WorkId;
  readonly producerBinding: ProducerBinding;
  readonly expectedDeliverable: ExpectedDeliverable;
}

/** ProduceDeliverable directive payload (producer side). */
export interface ProduceDeliverableSpec {
  readonly sourceWorkId: WorkId;
  readonly kind: DeliverableKind;
  readonly artifacts: ReadonlyArray<{
    readonly role: ArtifactRole;
    readonly artifactId: ArtifactId;
  }>;
}

/** SatisfyDependency directive payload (consumer side; the matcher stays
 * authoritative — request ≠ satisfaction, v1.10 G6). */
export interface SatisfyDependencySpec {
  readonly dependencyId: DependencyId;
  readonly deliverableId: DeliverableId;
}
