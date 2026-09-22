import { describe, expect, it } from "vitest";
import type {
  DeliverableMatchView,
  Dependency,
  ExpectedDeliverable,
  ProducerLossFacts,
} from "../src/index.js";
import {
  Actor,
  ArtifactRole,
  anyProducer,
  createAcceptance,
  DeliverableId,
  DeliverableKind,
  DependencyId,
  DependencyRevision,
  declareDependency,
  markDependencyUnfulfillable,
  markUnfulfillableOnProducerLoss,
  matchesExpectedDeliverable,
  parse,
  reviseExpectedContract,
  satisfyDependency,
  VerificationId,
  WorkId,
  WorkRevision,
  WorkspaceId,
  withdrawDependenciesOnWorkCancel,
  withdrawDependency,
  workBound,
  workspaceBound,
} from "../src/index.js";

const workId = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789ab");
const otherWorkId = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789ac");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const deliverableId = parse(DeliverableId)(
  "del_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const kind = parse(DeliverableKind)("code");
const otherKind = parse(DeliverableKind)("report");
const role = parse(ArtifactRole)("src");

const revision = (value: number) => parse(DependencyRevision)(value);

const expected = (
  over: Partial<ExpectedDeliverable> = {},
): ExpectedDeliverable => ({
  kind,
  requiredArtifactRoles: [role],
  ...over,
});

const candidate = (
  over: Partial<DeliverableMatchView> = {},
): DeliverableMatchView => ({
  deliverableId,
  sourceWorkId: workId,
  sourceWorkspaceId: workspaceId,
  kind,
  artifactRoles: new Set([role]),
  ...over,
});

const declare = (
  over: Partial<Parameters<typeof declareDependency>[0]> = {},
): Dependency =>
  declareDependency({
    dependencyId: parse(DependencyId)(
      "dep_018f2b3c-4d5e-7abc-8def-0123456789ab",
    ),
    consumerWorkId: workId,
    producerBinding: workBound(workId),
    revision: revision(1),
    expectedDeliverable: expected(),
    ...over,
  });

describe("deterministic dependency matcher", () => {
  it("matches producer binding, kind, and required artifact roles", () => {
    expect(
      matchesExpectedDeliverable(anyProducer, expected(), candidate()),
    ).toBe(true);
    expect(
      matchesExpectedDeliverable(
        workspaceBound(workspaceId),
        expected(),
        candidate(),
      ),
    ).toBe(true);
    expect(
      matchesExpectedDeliverable(workBound(workId), expected(), candidate()),
    ).toBe(true);
    expect(
      matchesExpectedDeliverable(
        workBound(otherWorkId),
        expected(),
        candidate(),
      ),
    ).toBe(false);
    expect(
      matchesExpectedDeliverable(
        workspaceBound(otherWorkId as unknown as WorkspaceId),
        expected(),
        candidate(),
      ),
    ).toBe(false);
    expect(
      matchesExpectedDeliverable(
        anyProducer,
        expected({ kind: otherKind }),
        candidate(),
      ),
    ).toBe(false);
    expect(
      matchesExpectedDeliverable(
        anyProducer,
        expected({
          requiredArtifactRoles: [role, parse(ArtifactRole)("tests")],
        }),
        candidate(),
      ),
    ).toBe(false);
  });
});

describe("dependency lifecycle", () => {
  it("declares Unsatisfied and satisfies only a matching deliverable", () => {
    const dependency = declare();
    expect(dependency.state).toBe("Unsatisfied");
    const mismatch = satisfyDependency(
      dependency,
      candidate({ kind: otherKind }),
    );
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.error._tag).toBe("DependencyNotSatisfiable");
    }
    const satisfied = satisfyDependency(dependency, candidate());
    expect(satisfied.ok).toBe(true);
    if (satisfied.ok) {
      expect(satisfied.value.state).toBe("Satisfied");
      expect(satisfied.value.satisfiedByDeliverableId).toBe(deliverableId);
      expect(satisfied.value.satisfiedAtDependencyRevision).toBe(
        dependency.revision,
      );
    }
  });

  it("rejects terminal mutation and enforces revision binding", () => {
    const satisfied = satisfyDependency(declare(), candidate());
    expect(satisfied.ok).toBe(true);
    if (!satisfied.ok) {
      throw new Error("expected satisfy");
    }
    for (const result of [
      satisfyDependency(satisfied.value, candidate()),
      withdrawDependency(satisfied.value),
      markDependencyUnfulfillable(satisfied.value),
      reviseExpectedContract(satisfied.value, {
        authorized: true,
        expectedDeliverable: expected(),
        revision: revision(2),
      }),
    ]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error._tag).toBe("TerminalLifecycleMutation");
      }
    }
  });

  it("revises the contract with authority and a new revision", () => {
    const unauthorized = reviseExpectedContract(declare(), {
      authorized: false,
      expectedDeliverable: expected(),
      revision: revision(2),
    });
    expect(unauthorized.ok).toBe(false);
    if (!unauthorized.ok) {
      expect(unauthorized.error._tag).toBe("AuthorityDenied");
    }
    const revised = reviseExpectedContract(declare(), {
      authorized: true,
      expectedDeliverable: expected({ kind: otherKind }),
      revision: revision(2),
    });
    expect(revised.ok).toBe(true);
    if (revised.ok) {
      expect(revised.value.revision).toBe(2);
      expect(revised.value.state).toBe("Unsatisfied");
    }
  });

  it("withdraws and unfulfills only Unsatisfied dependencies", () => {
    const withdrawn = withdrawDependency(declare());
    expect(withdrawn.ok).toBe(true);
    if (withdrawn.ok) {
      expect(withdrawn.value.state).toBe("Withdrawn");
    }
    const unfulfilled = markDependencyUnfulfillable(declare());
    expect(unfulfilled.ok).toBe(true);
    if (unfulfilled.ok) {
      expect(unfulfilled.value.state).toBe("Unfulfillable");
    }
  });
});

describe("acceptance and cross-aggregate consequences", () => {
  it("creates an immutable acceptance bound to work revision + verification", () => {
    const acceptance = createAcceptance({
      acceptanceId: "acc_00000000-0000-7000-8000-000000000001" as never,
      workId,
      targetWorkRevision: parse(WorkRevision)(7),
      verificationId: parse(VerificationId)(
        "ver_018f2b3c-4d5e-7abc-8def-0123456789ab",
      ),
      actor: parse(Actor)("user:gaolei"),
      acceptedAt: "2026-09-20T00:00:00.000Z",
    });
    expect(acceptance.targetWorkRevision).toBe(7);
    expect(acceptance.verificationId).toBe(
      "ver_018f2b3c-4d5e-7abc-8def-0123456789ab",
    );
  });

  it("withdraws a cancelled consumer's Unsatisfied dependencies only", () => {
    const deps = [declare(), declare({ consumerWorkId: otherWorkId })];
    const after = withdrawDependenciesOnWorkCancel(workId, deps);
    expect(after[0]?.state).toBe("Withdrawn");
    expect(after[1]?.state).toBe("Unsatisfied");
  });

  it("marks Unfulfillable per ProducerBinding rules", () => {
    const wsDep = declare({ producerBinding: workspaceBound(workspaceId) });
    const anyDep = declare({ producerBinding: anyProducer });
    const workLoss: ProducerLossFacts = {
      binding: workBound(workId),
      lost: { _tag: "WorkCancelled", workId },
      replacedInSameGovernanceChange: false,
    };
    const wsLoss: ProducerLossFacts = {
      binding: workspaceBound(workspaceId),
      lost: { _tag: "WorkspaceRetired", workspaceId },
      replacedInSameGovernanceChange: false,
    };
    const replacedLoss: ProducerLossFacts = {
      ...workLoss,
      replacedInSameGovernanceChange: true,
    };
    const workCancelledUnderWorkspace: ProducerLossFacts = {
      binding: workspaceBound(workspaceId),
      lost: { _tag: "WorkCancelled", workId },
      replacedInSameGovernanceChange: false,
    };

    expect(
      markUnfulfillableOnProducerLoss([workLoss], [declare()])[0]?.state,
    ).toBe("Unfulfillable");
    expect(markUnfulfillableOnProducerLoss([wsLoss], [wsDep])[0]?.state).toBe(
      "Unfulfillable",
    );
    expect(
      markUnfulfillableOnProducerLoss([workLoss], [anyDep])[0]?.state,
    ).toBe("Unsatisfied");
    expect(
      markUnfulfillableOnProducerLoss([replacedLoss], [declare()])[0]?.state,
    ).toBe("Unsatisfied");
    expect(
      markUnfulfillableOnProducerLoss([workCancelledUnderWorkspace], [wsDep])[0]
        ?.state,
    ).toBe("Unsatisfied");
  });
});
