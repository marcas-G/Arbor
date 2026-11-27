import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect } from "vitest";
import type { LiveOwnerLeasePauseEvidence } from "../../support/lease-qualification.js";
import type { ProductionFixture } from "../../support/production-fixture.js";
import {
  type FunctionalProject,
  type PublicClient,
  waitForPublic,
} from "../../support/public-client.js";
import type { ControlResult, readRows } from "./support-rows.js";

interface Probe {
  readonly tag: "AH10_PROBE";
  readonly role: "old" | "new";
  readonly boundary: string;
  readonly executionId: string;
  readonly fencingGeneration?: number;
  readonly pauseRequested?: boolean;
  readonly workerId?: string;
  readonly workerIncarnationId?: string;
  readonly providerTurnId?: string;
  readonly logicalActionId?: string;
  readonly actionKind?: string;
  readonly callRef?: string;
  readonly actionIndex?: number;
  readonly commandId?: string;
  readonly committedCommandId?: string;
}

export type Ah10CrashSide =
  | "before"
  | "after"
  | "committed"
  | "corrupt-sibling"
  | "binding-before"
  | "approval-committed"
  | "approval-fencing-before"
  | "legacy-p32-upgrade"
  | "legacy-unbound"
  | "retired-after-commit"
  | "grant-revoked-after-commit"
  | "non-root-parent"
  | "attention-before"
  | "attention-after"
  | "corrupt-result-before"
  | "corrupt-result-after"
  | "wrong-shape-result";

type Ah10AdditionalDaemon = Awaited<
  ReturnType<ProductionFixture["startAdditionalDaemon"]>
>;

export interface Ah10ScenarioState {
  readonly crashSide: Ah10CrashSide;
  readonly marker: string;
  readonly childName: string;
  readonly siblingName: string;
  readonly parentName: string;
  readonly sourceObjective: string;
  readonly targetObjective: string;
  readonly targetWhy: string;
  readonly targetReason: string;
  readonly constraints: ReadonlyArray<string>;
  readonly mission: {
    readonly goal: string;
    readonly criteria: ReadonlyArray<{
      readonly criterionId: string;
      readonly requirement: string;
      readonly required: boolean;
    }>;
    readonly riskRequirements: ReadonlyArray<string>;
  };
  readonly nonRootParent: boolean;
  readonly corruptResult: boolean;
  readonly attentionBefore: boolean;
  readonly attentionAfter: boolean;
  readonly events: Probe[];
  readonly listWorkspaceCalls: number[];
  readonly assignWorkCalls: number[];
  readonly providerTrace: Array<{ index: number; tail: string }>;
  listRequested: boolean;
  targetWorkspaceRef: string | undefined;
  parentSeedWaitIssued: boolean;
  targetProposalIssued: boolean;
  targetProposalApproved: boolean;
  siblingProposalIssued: boolean;
  siblingProposalApproved: boolean;
  fixture: ProductionFixture | undefined;
  recoveryDatabaseFile: string;
  client: PublicClient | undefined;
  project: FunctionalProject | undefined;
  assignmentParentWorkspaceId: string;
  childWorkspaceId: string;
  siblingWorkspaceId: string;
  parentWorkId: string;
  seedParentWork:
    | {
        readonly workId?: string;
        readonly objective?: string;
        readonly revision: number;
        readonly status: string;
        readonly activeExecution?: { readonly executionId: string };
      }
    | undefined;
  oldAction: Probe | undefined;
  providerTurnId: string | undefined;
  logicalActionId: string | undefined;
  callRef: string | undefined;
  listControlRow:
    | ReturnType<typeof readRows>["controlResults"][number]
    | undefined;
  listControlResult: ControlResult | undefined;
  assignmentGrantId: string | undefined;
  grantRows: ReturnType<typeof readRows>["permissionGrants"];
  priorCommittedCommandId: string | undefined;
  corruptedResultJson: string | undefined;
  liveOwnerPauseEvidence: LiveOwnerLeasePauseEvidence | undefined;
  oldLeaseOwner: Probe | undefined;
  oldLeaseOwnerWorkerId: string | undefined;
  oldLeaseOwnerIncarnationId: string | undefined;
  assignWorkAuthorizedPause: Probe | undefined;
  newDaemon: Ah10AdditionalDaemon | undefined;
  newLease: Probe | undefined;
  resultDaemon: Ah10AdditionalDaemon | undefined;
  oldRejectedCommandId: string;
}

export const createAh10ScenarioState = (
  rawCrashSide: Ah10CrashSide,
): Ah10ScenarioState => {
  const marker = `AH10-direct-child-${crypto.randomUUID().slice(0, 8)}`;
  const childName = `child-${marker}`;
  const siblingName = `sibling-${crypto.randomUUID().slice(0, 8)}`;
  const parentName = `parent-${marker}`;
  const sourceObjective = `Assign a bounded outcome to ${childName}.`;
  const targetObjective = `Direct-child Work for ${marker}.`;
  const targetWhy = `The existing child owns the responsibility for ${marker}.`;
  const targetReason = `The Parent Work delegates this bounded outcome to ${childName}.`;
  const constraints = [
    "Do not modify files owned by the Parent Workspace.",
    "Preserve the stated scope and do not add external side effects.",
  ];
  const mission = {
    goal: `Verify the bounded child outcome for ${marker}.`,
    criteria: [
      {
        criterionId: "direct-child-result",
        requirement: `the child Work records the requested result for ${marker}`,
        required: true,
      },
    ],
    riskRequirements: ["do not weaken either Work constraint"],
  };
  const nonRootParent = rawCrashSide === "non-root-parent";
  const corruptResult =
    rawCrashSide === "corrupt-result-before" ||
    rawCrashSide === "corrupt-result-after" ||
    rawCrashSide === "wrong-shape-result";
  const attentionBefore =
    rawCrashSide === "attention-before" ||
    rawCrashSide === "corrupt-result-before";
  const attentionAfter =
    rawCrashSide === "attention-after" ||
    rawCrashSide === "corrupt-result-after";
  const events: Probe[] = [];
  const listWorkspaceCalls: number[] = [];
  const assignWorkCalls: number[] = [];
  const providerTrace: Array<{ index: number; tail: string }> = [];
  return {
    crashSide: rawCrashSide,
    marker,
    childName,
    siblingName,
    parentName,
    sourceObjective,
    targetObjective,
    targetWhy,
    targetReason,
    constraints,
    mission,
    nonRootParent,
    corruptResult,
    attentionBefore,
    attentionAfter,
    events,
    listWorkspaceCalls,
    assignWorkCalls,
    providerTrace,
    listRequested: false,
    targetWorkspaceRef: undefined,
    parentSeedWaitIssued: false,
    targetProposalIssued: false,
    targetProposalApproved: false,
    siblingProposalIssued: false,
    siblingProposalApproved: false,
    fixture: undefined,
    recoveryDatabaseFile: "",
    client: undefined,
    project: undefined,
    assignmentParentWorkspaceId: "",
    childWorkspaceId: "",
    siblingWorkspaceId: "",
    parentWorkId: "",
    seedParentWork: undefined,
    oldAction: undefined,
    providerTurnId: undefined,
    logicalActionId: undefined,
    callRef: undefined,
    listControlRow: undefined,
    listControlResult: undefined,
    assignmentGrantId: undefined,
    grantRows: [],
    priorCommittedCommandId: undefined,
    corruptedResultJson: undefined,
    liveOwnerPauseEvidence: undefined,
    oldLeaseOwner: undefined,
    oldLeaseOwnerWorkerId: undefined,
    oldLeaseOwnerIncarnationId: undefined,
    assignWorkAuthorizedPause: undefined,
    newDaemon: undefined,
    newLease: undefined,
    resultDaemon: undefined,
    oldRejectedCommandId: "",
  };
};

export const fixtures: ProductionFixture[] = [];
export const ah10Child = resolve("tests/functional/support/process-child.mjs");

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

export const pushProbe = (events: Probe[], line: string) => {
  try {
    const event = JSON.parse(line) as Probe;
    if (event.tag === "AH10_PROBE") events.push(event);
  } catch {
    // Retain daemon output in the fixture for failure diagnostics.
  }
};

export const approveWorkspaceFormation = async (
  client: PublicClient,
  project: FunctionalProject,
  parentWorkspaceId: string,
  marker: string,
  childName: string,
): Promise<{ readonly workspaceId: string; readonly name: string }> => {
  const inbox = await waitForPublic(
    () =>
      client.view<{
        unconsumed: Array<{ entryKey: string; kind: string; summary: string }>;
      }>("inbox-view", { workspaceId: parentWorkspaceId }),
    (value) =>
      value.unconsumed.some(
        (entry) =>
          entry.kind === "Governance" &&
          entry.summary.includes(marker) &&
          /^gov:fpr_[^:]+:\d+$/u.test(entry.entryKey),
      ),
  );
  const entry = inbox.unconsumed.find(
    (candidate) =>
      candidate.kind === "Governance" &&
      candidate.summary.includes(marker) &&
      /^gov:fpr_[^:]+:\d+$/u.test(candidate.entryKey),
  );
  const formation =
    entry === undefined
      ? null
      : /^gov:(fpr_[^:]+):(\d+)$/u.exec(entry.entryKey);
  if (formation === null) {
    throw new Error(
      `Parent Inbox exposed no exact FormationProposal for ${marker}`,
    );
  }
  const before = await client.view<{
    nodes: Array<{ parentWorkspaceId: string | null; name: string }>;
  }>("responsibility-tree", { projectId: project.projectId });
  expect(
    before.nodes.some(
      (node) =>
        node.parentWorkspaceId === parentWorkspaceId && node.name === childName,
    ),
  ).toBe(false);
  await client.command(project.projectId, "RecordDecision", {
    proposalId: formation[1],
    expectedProposalRevision: Number(formation[2]),
    outcome: { _tag: "Approve" },
  });
  const tree = await waitForPublic(
    () =>
      client.view<{
        nodes: Array<{
          workspaceId: string;
          parentWorkspaceId: string | null;
          name: string;
          currentWork?: { workId?: string };
        }>;
      }>("responsibility-tree", { projectId: project.projectId }),
    (value) =>
      value.nodes.some(
        (node) =>
          node.parentWorkspaceId === parentWorkspaceId &&
          node.name === childName &&
          node.currentWork === undefined,
      ),
  );
  const child = tree.nodes.find(
    (node) =>
      node.parentWorkspaceId === parentWorkspaceId && node.name === childName,
  );
  if (child === undefined || child.currentWork !== undefined) {
    throw new Error(
      `approved Formation unexpectedly lacks empty child ${childName}`,
    );
  }
  return { workspaceId: child.workspaceId, name: child.name };
};

export const releaseGate = (
  fixture: ProductionFixture,
  role: "old" | "new",
  gate: string,
) => {
  writeFileSync(
    resolve(fixture.directory, "ah10-gates", `${role}-${gate}.release`),
    "release",
  );
};

export const retargetBindingToSibling = (
  databaseFile: string,
  commandId: string,
  siblingWorkspaceId: string,
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    db.prepare(
      "UPDATE assign_work_target_bindings SET target_workspace_id = ? WHERE command_id = ?",
    ).run(siblingWorkspaceId, commandId);
  } finally {
    db.close();
  }
};

export const removeBindingForLegacyFixture = (
  databaseFile: string,
  commandId: string,
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    db.prepare(
      "DELETE FROM assign_work_target_bindings WHERE command_id = ?",
    ).run(commandId);
  } finally {
    db.close();
  }
};

export const retireTargetAfterCommit = (
  databaseFile: string,
  workspaceId: string,
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    db.prepare(
      "UPDATE workspaces SET lifecycle = 'Retired', revision = revision + 1 WHERE workspace_id = ? AND lifecycle = 'Active'",
    ).run(workspaceId);
  } finally {
    db.close();
  }
};
