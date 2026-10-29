import { ProjectId, parse, WorkId, WorkspaceId } from "@arbor/domain";
import { deriveAttentionRows } from "@arbor/projection-runtime";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  type AnyProducerEvidenceDependencies,
  type AnyProducerEvidenceFacts,
  hasAnyProducerEvidence,
  isSettledAnyProducerWaitEligible,
} from "../src/any-producer-evidence.js";

const projectId = parse(ProjectId)("prj_018f0000-0000-7000-8000-000000000001");
const rootId = parse(WorkspaceId)("ws_018f0000-0000-7000-8000-000000000002");
const childId = parse(WorkspaceId)("ws_018f0000-0000-7000-8000-000000000003");
const consumerId = parse(WorkId)("wrk_018f0000-0000-7000-8000-000000000004");
const producerId = parse(WorkId)("wrk_018f0000-0000-7000-8000-000000000005");

const baseDependencies = (
  overrides: Partial<AnyProducerEvidenceDependencies> = {},
): AnyProducerEvidenceDependencies =>
  ({
    projects: {
      findById: () =>
        Effect.succeed(
          Option.some({ projectId, rootWorkspaceId: rootId } as never),
        ),
    },
    workspaces: {
      findById: (workspace: unknown) =>
        Effect.succeed(
          Option.fromNullishOr(
            workspace === rootId
              ? ({ workspaceId: rootId, projectId } as never)
              : workspace === childId
                ? ({ workspaceId: childId, projectId } as never)
                : undefined,
          ),
        ),
    },
    listWorkspaceIdsByProject: () => Effect.succeed([rootId, childId]),
    works: {
      listByWorkspace: (workspace: unknown) =>
        Effect.succeed(
          workspace === childId
            ? ([
                {
                  workId: producerId,
                  workspaceId: childId,
                  projectId,
                  lifecycle: "Open",
                },
              ] as never)
            : ([] as never),
        ),
    },
    proposals: { listByParent: () => Effect.succeed([]) },
    fulfillments: {
      findByProposal: () => Effect.succeed(Option.none()),
    },
    deliverables: {
      listByProject: () => Effect.succeed([]),
      listArtifactRoles: () => Effect.succeed([]),
    },
    tx: { transact: (effect: never) => effect },
    ...overrides,
  }) as AnyProducerEvidenceDependencies;

const request = {
  projectId,
  consumerWorkId: consumerId,
  expectedDeliverable: {
    kind: "report",
    requiredArtifactRoles: ["evidence"],
  },
};

describe("APW-1 AnyProducer evidence query", () => {
  it("accepts another same-Project Open Work without inspecting its prose", async () => {
    await expect(
      Effect.runPromise(hasAnyProducerEvidence(baseDependencies(), request)),
    ).resolves.toBe(true);
  });

  it("does not count the consumer Work itself as a producer", async () => {
    const dependencies = baseDependencies({
      works: {
        listByWorkspace: () =>
          Effect.succeed([
            {
              workId: consumerId,
              workspaceId: childId,
              projectId,
              lifecycle: "Open",
            },
          ] as never),
      },
    });
    await expect(
      Effect.runPromise(hasAnyProducerEvidence(dependencies, request)),
    ).resolves.toBe(false);
  });

  it("counts only exact Approved in-flight formation fulfillment", async () => {
    const dependencies = baseDependencies({
      works: { listByWorkspace: () => Effect.succeed([]) },
      proposals: {
        listByParent: () =>
          Effect.succeed([
            { proposalId: "prp_approved", revision: 4, state: "Approved" },
          ] as never),
      },
      fulfillments: {
        findByProposal: (_id: unknown, revision: number) =>
          Effect.succeed(
            revision === 4
              ? Option.some({
                  state: "PendingApplication",
                  expectedInitialWorkId: parse(WorkId)(
                    "wrk_018f0000-0000-7000-8000-000000000006",
                  ),
                } as never)
              : Option.none(),
          ),
      },
    });
    await expect(
      Effect.runPromise(hasAnyProducerEvidence(dependencies, request)),
    ).resolves.toBe(true);
  });

  it("rejects Pending proposals and non-materializing Approved fulfillment", async () => {
    const noOpenWorks = { listByWorkspace: () => Effect.succeed([]) };
    const pendingProposal = baseDependencies({
      works: noOpenWorks,
      proposals: {
        listByParent: () =>
          Effect.succeed([
            {
              proposalId: "prp_018f0000-0000-7000-8000-000000000010",
              revision: 4,
              state: "Pending",
            },
          ] as never),
      },
      fulfillments: {
        findByProposal: () =>
          Effect.succeed(
            Option.some({
              state: "PendingApplication",
              expectedInitialWorkId: parse(WorkId)(
                "wrk_018f0000-0000-7000-8000-000000000006",
              ),
            } as never),
          ),
      },
    });
    await expect(
      Effect.runPromise(hasAnyProducerEvidence(pendingProposal, request)),
    ).resolves.toBe(false);

    const appliedFulfillment = baseDependencies({
      works: noOpenWorks,
      proposals: {
        listByParent: () =>
          Effect.succeed([
            {
              proposalId: "prp_018f0000-0000-7000-8000-000000000010",
              revision: 4,
              state: "Approved",
            },
          ] as never),
      },
      fulfillments: {
        findByProposal: () =>
          Effect.succeed(
            Option.some({
              state: "Applied",
              expectedInitialWorkId: parse(WorkId)(
                "wrk_018f0000-0000-7000-8000-000000000006",
              ),
            } as never),
          ),
      },
    });
    await expect(
      Effect.runPromise(hasAnyProducerEvidence(appliedFulfillment, request)),
    ).resolves.toBe(false);
  });

  it("requires a same-Project P7-matching persisted Deliverable", async () => {
    const dependencies = baseDependencies({
      works: {
        listByWorkspace: (workspace: unknown) =>
          Effect.succeed(
            workspace === childId
              ? ([
                  {
                    workId: producerId,
                    workspaceId: childId,
                    projectId,
                    lifecycle: "Completed",
                  },
                ] as never)
              : ([] as never),
          ),
      },
      deliverables: {
        listByProject: () =>
          Effect.succeed([
            {
              deliverableId: "del_018f0000-0000-7000-8000-000000000008",
              sourceWorkId: producerId,
              sourceWorkRevision: 1,
              kind: "report",
            },
          ] as never),
        listArtifactRoles: () => Effect.succeed(["evidence"]),
      },
    });
    await expect(
      Effect.runPromise(hasAnyProducerEvidence(dependencies, request)),
    ).resolves.toBe(true);

    const unmatched = baseDependencies({
      works: dependencies.works,
      deliverables: {
        listByProject: () =>
          Effect.succeed([
            {
              deliverableId: "del_018f0000-0000-7000-8000-000000000008",
              sourceWorkId: producerId,
              sourceWorkRevision: 1,
              kind: "different-kind",
            },
          ] as never),
        listArtifactRoles: () => Effect.succeed(["evidence"]),
      },
    });
    await expect(
      Effect.runPromise(hasAnyProducerEvidence(unmatched, request)),
    ).resolves.toBe(false);
  });

  it("ignores candidate Work that belongs to another Project", async () => {
    const dependencies = baseDependencies({
      works: {
        listByWorkspace: () =>
          Effect.succeed([
            {
              workId: producerId,
              workspaceId: childId,
              projectId: parse(ProjectId)(
                "prj_018f0000-0000-7000-8000-000000000009",
              ),
              lifecycle: "Open",
            },
          ] as never),
      },
    });
    await expect(
      Effect.runPromise(hasAnyProducerEvidence(dependencies, request)),
    ).resolves.toBe(false);
  });
});

const eligibilityInput = (overrides: Record<string, unknown> = {}) =>
  ({
    projectId,
    projectOpen: true,
    projectHasActiveExecution: false,
    dependency: {
      dependencyId: "dep_018f0000-0000-7000-8000-000000000007",
      consumerWorkId: consumerId,
      producerBinding: { _tag: "AnyProducer" },
      revision: 2,
      expectedDeliverable: { kind: "report", requiredArtifactRoles: [] },
      state: "Unsatisfied",
    },
    consumerWork: {
      workId: consumerId,
      projectId,
      workspaceId: childId,
      lifecycle: "Open",
      revision: 1,
    },
    wait: {
      workId: consumerId,
      waitSpec: {
        mode: "Any",
        conditions: [
          {
            _tag: "DependencyChanged",
            dependencyId: "dep_018f0000-0000-7000-8000-000000000007",
            observedRevision: 2,
          },
        ],
      },
      registeredAt: "t0",
      updatedAt: "t0",
    },
    evidence: {
      workspaceIds: [rootId, childId],
      otherOpenWork: false,
      approvedMaterializingFormation: false,
      matchingDeliverables: [],
      pendingFormation: false,
      projectOpen: true,
    },
    matchingDeliverableMayConverge: false,
    ...overrides,
  }) as never;

const evidenceFacts = (
  overrides: Partial<AnyProducerEvidenceFacts> = {},
): AnyProducerEvidenceFacts => ({
  workspaceIds: [rootId, childId],
  otherOpenWork: false,
  approvedMaterializingFormation: false,
  matchingDeliverables: [],
  pendingFormation: false,
  projectOpen: true,
  ...overrides,
});

describe("APW-3 settled AnyProducer Attention eligibility", () => {
  it("accepts only a current dependency wait in an otherwise idle, vacant Project", () => {
    expect(isSettledAnyProducerWaitEligible(eligibilityInput())).toBe(true);
    expect(
      isSettledAnyProducerWaitEligible(
        eligibilityInput({
          wait: {
            workId: consumerId,
            registeredAt: "t0",
            updatedAt: "t0",
            waitSpec: {
              mode: "Any",
              conditions: [
                {
                  _tag: "DependencyChanged",
                  dependencyId: "dep_018f0000-0000-7000-8000-000000000007",
                  observedRevision: 1,
                },
              ],
            },
          },
        }),
      ),
    ).toBe(false);
  });

  it.each([
    ["active execution", { projectHasActiveExecution: true }],
    [
      "pending formation",
      { evidence: evidenceFacts({ pendingFormation: true }) },
    ],
    ["another Open Work", { evidence: evidenceFacts({ otherOpenWork: true }) }],
    [
      "approved fulfillment",
      {
        evidence: evidenceFacts({ approvedMaterializingFormation: true }),
      },
    ],
    [
      "matching nonterminal deliverable",
      { matchingDeliverableMayConverge: true },
    ],
  ])(
    "suppresses Attention when %s could still converge",
    (_label, override) => {
      expect(isSettledAnyProducerWaitEligible(eligibilityInput(override))).toBe(
        false,
      );
    },
  );

  it("projects only the existing source and fixed non-content summary", () => {
    const dependency = "dep_018f0000-0000-7000-8000-000000000007";
    const rows = deriveAttentionRows({
      unfulfillableEvents: [],
      deadlockEvents: [],
      safetyStopSettlements: [],
      reconciliationEscalatedEvents: [],
      openVerifications: [],
      executionSettlements: [],
      vacantProducerCandidates: [],
      anyProducerSettledWaits: [
        { dependencyId: dependency, consumerWorkspaceId: childId },
      ],
      workspaceVacancies: [],
      workOwners: [],
    });
    expect(rows).toEqual([
      {
        source: "WaitingOnVacantProducer",
        severity: "Attention",
        targetWorkspaceId: childId,
        dedupKey: `vacant-producer:${dependency}`,
        summary:
          "An AnyProducer dependency is waiting with no eligible producer route.",
        occurredAt: null,
      },
    ]);
  });
});
