import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "vitest";
import { startProductionFixture } from "../../support/production-fixture.js";
import {
  createFunctionalProject,
  makePublicClient,
  proposeAndApproveChildWithInitialWork,
  proposeAndApproveChildWithoutWork,
  submitHumanMessage,
  waitForApproval,
  waitForPublic,
} from "../../support/public-client.js";
import {
  type Ah10ScenarioState,
  approveWorkspaceFormation,
  fixtures,
  pushProbe,
} from "./support.js";

export const ah10PhaseFormation = async (
  s: Ah10ScenarioState,
): Promise<void> => {
  const {
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
    events,
    listWorkspaceCalls,
    assignWorkCalls,
    providerTrace,
  } = s;
  const fixture = await startProductionFixture({
    isolatedPortHandshake: true,
    admitWorkspaceDirectory: true,
    reply: (call, index) => {
      const context = JSON.stringify(call.messages);
      providerTrace.push({ index, tail: context.slice(-1_000) });
      if (!context.includes(marker)) {
        return { _tag: "HttpError", status: 422 };
      }
      const available = new Set(
        call.tools
          .map((tool) => tool.function?.name)
          .filter((name): name is string => name !== undefined),
      );
      const latestUserIndex = call.messages.findLastIndex(
        (message) => message.role === "user",
      );
      const latestUser =
        latestUserIndex < 0
          ? undefined
          : call.messages[latestUserIndex]?.content;
      const proposalRecordedForLatestUser =
        latestUserIndex >= 0 &&
        call.messages
          .slice(latestUserIndex + 1)
          .some(
            (message) =>
              message.role === "tool" &&
              message.content?.includes("ProposalRecorded(") === true,
          );
      const proposalFor = (
        name: string,
        purpose: string,
        initialWork?: Readonly<Record<string, unknown>>,
      ) => ({
        _tag: "ToolCall" as const,
        name: "propose_workspace",
        arguments: {
          name,
          rationale: `formation fixture for ${marker}`,
          responsibilityDraft: {
            purpose,
            ownedResponsibilities: [marker],
            obligations: ["accept precisely scoped Work from the Parent"],
            includes: ["the named child outcome"],
            excludes: ["Parent Workspace files and external side effects"],
            interfaces: [
              "Parent assigns Work through a scoped direct-child ref",
            ],
          },
          resourceBoundaryDraft: {
            addresses: [{ _tag: "FileTree", path: fixture.workspaceDirectory }],
          },
          ...(initialWork === undefined ? {} : { initialWork }),
        },
      });

      if (
        available.has("propose_workspace") &&
        !available.has("claim_completion") &&
        latestUser?.includes(`Propose ${childName} for ${marker}`) === true
      ) {
        return proposalRecordedForLatestUser
          ? { _tag: "Text", text: `Proposed ${childName}` }
          : proposalFor(
              childName,
              `own the bounded responsibility for ${marker}`,
            );
      }
      if (
        available.has("propose_workspace") &&
        !available.has("claim_completion") &&
        latestUser?.includes(`Propose ${siblingName} for ${marker}`) === true
      ) {
        return proposalRecordedForLatestUser
          ? { _tag: "Text", text: `Proposed ${siblingName}` }
          : proposalFor(
              siblingName,
              `own a separate sibling responsibility for ${marker}`,
            );
      }
      if (
        available.has("propose_workspace") &&
        !available.has("claim_completion") &&
        latestUser?.includes(`Propose ${parentName} for ${marker}`) === true
      ) {
        return proposalRecordedForLatestUser
          ? { _tag: "Text", text: `Proposed ${parentName}` }
          : proposalFor(parentName, `parent responsibility for ${marker}`, {
              objective: sourceObjective,
              why: "host the Parent WorkEpisode for direct-child assignment qualification",
              constraints: [
                "the resulting Work must target the listed direct child",
              ],
              completionExpectation:
                "one exact child Work is assigned under the Parent",
              verificationMission: {
                goal: `Verify assignment to the existing child ${marker}`,
                criteria: [
                  {
                    criterionId: "parent-assigned-child",
                    requirement:
                      "the Work is assigned to the exact listed child Workspace",
                    required: true,
                  },
                ],
                riskRequirements: [],
              },
            });
      }
      if (
        available.has("claim_completion") &&
        nonRootParent &&
        context.includes(sourceObjective)
      ) {
        if (!s.targetProposalApproved) {
          if (!s.targetProposalIssued) {
            s.targetProposalIssued = true;
            return proposalFor(
              childName,
              `own the bounded responsibility for ${marker}`,
            );
          }
          return {
            _tag: "ToolCall",
            name: "wait",
            arguments: {
              reason: `await exact Parent approval for ${childName}`,
              waitSpec: {
                mode: "Any",
                conditions: [{ _tag: "Manual" }],
              },
            },
          };
        }
        if (!s.siblingProposalApproved) {
          if (!s.siblingProposalIssued) {
            s.siblingProposalIssued = true;
            return proposalFor(
              siblingName,
              `own a separate sibling responsibility for ${marker}`,
            );
          }
          return {
            _tag: "ToolCall",
            name: "wait",
            arguments: {
              reason: `await exact Parent approval for ${siblingName}`,
              waitSpec: {
                mode: "Any",
                conditions: [{ _tag: "Manual" }],
              },
            },
          };
        }
      }
      if (
        available.has("claim_completion") &&
        context.includes(sourceObjective) &&
        !s.parentSeedWaitIssued
      ) {
        s.parentSeedWaitIssued = true;
        return {
          _tag: "ToolCall",
          name: "wait",
          arguments: {
            reason: "hold the seeded Parent Work until AH10 probes are enabled",
            waitSpec: {
              mode: "Any",
              conditions: [{ _tag: "Manual" }],
            },
          },
        };
      }
      if (
        !available.has("claim_completion") &&
        !nonRootParent &&
        latestUser?.includes(`Create Parent Work ${sourceObjective}`) === true
      ) {
        return context.includes("WorkAssigned(")
          ? { _tag: "Text", text: `Parent Work assigned for ${marker}` }
          : {
              _tag: "ToolCall",
              name: "assign_work",
              arguments: {
                objective: sourceObjective,
                why: "host the Parent WorkEpisode for direct-child assignment qualification",
                constraints: [
                  "the resulting Work must target the listed direct child",
                ],
                completionExpectation:
                  "one exact child Work is assigned under the Parent",
                verificationMission: {
                  goal: `Verify assignment to the existing child ${marker}`,
                  criteria: [
                    {
                      criterionId: "parent-assigned-child",
                      requirement:
                        "the Work is assigned to the exact listed child Workspace",
                      required: true,
                    },
                  ],
                  riskRequirements: [],
                },
                reason: "AH10 process fixture",
              },
            };
      }
      if (assignWorkCalls.length > 0 && context.includes("WorkAssigned(")) {
        return {
          _tag: "Text",
          text: `The child Work is assigned for ${marker}.`,
        };
      }
      if (!s.listRequested) {
        if (!available.has("list_workspaces")) {
          return { _tag: "HttpError", status: 422 };
        }
        s.listRequested = true;
        listWorkspaceCalls.push(index);
        return {
          _tag: "ToolCall",
          name: "list_workspaces",
          arguments: { query: marker },
        };
      }
      let ref: string | undefined;
      for (const message of [...call.messages].reverse()) {
        if (typeof message.content !== "string") continue;
        try {
          const result = JSON.parse(message.content) as {
            directChildren?: ReadonlyArray<{
              name?: string;
              ref?: string;
            }>;
          };
          const child = result.directChildren?.find(
            (candidate) => candidate.name === childName,
          );
          if (child?.ref !== undefined) {
            ref = child.ref;
            break;
          }
        } catch {
          // Other provider messages are not control results.
        }
      }
      if (ref === undefined || !available.has("assign_work")) {
        return { _tag: "HttpError", status: 422 };
      }
      s.targetWorkspaceRef = ref;
      assignWorkCalls.push(index);
      return {
        _tag: "ToolCall",
        name: "assign_work",
        arguments: {
          targetWorkspaceRef: ref,
          objective: targetObjective,
          why: targetWhy,
          constraints,
          completionExpectation: `the direct child owns a verified outcome for ${marker}`,
          verificationMission: mission,
          reason: targetReason,
        },
      };
    },
    onDaemonStdout: (line) => pushProbe(events, line),
  });
  fixtures.push(fixture);
  s.fixture = fixture;
  s.recoveryDatabaseFile = fixture.databaseFile;
  mkdirSync(resolve(fixture.directory, "ah10-gates"), { recursive: true });

  const client = makePublicClient(fixture.baseUrl);
  const project = await createFunctionalProject(
    client,
    fixture.workspaceDirectory,
    `AH10 direct-child AssignWork ${marker}`,
    {
      resourceSelection: "Profile",
      rootWorkspacePolicy: {
        controlApprovalPolicy: {
          "core.control.assign-work": "Ask",
        },
      },
    },
  );
  s.client = client;
  s.project = project;
  s.assignmentParentWorkspaceId = project.rootWorkspaceId;
  s.childWorkspaceId = "";
  s.siblingWorkspaceId = "";
  s.parentWorkId = "";
  const childDirectory = fixture.workspaceDirectory;
  if (nonRootParent) {
    const parent = await proposeAndApproveChildWithInitialWork(
      client,
      project,
      marker,
      `Propose ${parentName} for ${marker}`,
      {
        name: parentName,
        rationale:
          "form the Parent responsibility for nested direct-child qualification",
        responsibilityDraft: {
          purpose: `parent responsibility for ${marker}`,
          ownedResponsibilities: [`parent-${marker}`],
          obligations: ["assign bounded child Work"],
          includes: ["the direct child assignment fixture"],
          excludes: ["unrelated root responsibilities"],
          interfaces: ["one direct child is assigned through PlacementContext"],
        },
        resourceBoundaryDraft: {
          addresses: [{ _tag: "FileTree", path: fixture.workspaceDirectory }],
        },
        initialWork: {
          objective: sourceObjective,
          why: "host the Parent WorkEpisode for direct-child assignment qualification",
          constraints: [
            "the resulting Work must target the listed direct child",
          ],
          completionExpectation:
            "one exact child Work is assigned under the Parent",
          verificationMission: {
            goal: `Verify assignment to the existing child ${marker}`,
            criteria: [
              {
                criterionId: "parent-assigned-child",
                requirement:
                  "the Work is assigned to the exact listed child Workspace",
                required: true,
              },
            ],
            riskRequirements: [],
          },
        },
      },
    );
    s.assignmentParentWorkspaceId = parent.workspaceId;
    s.parentWorkId = parent.currentWork.workId;
    expect(parent.currentWork.objective).toBe(sourceObjective);
  } else {
    const child = await proposeAndApproveChildWithoutWork(
      client,
      project,
      marker,
      `Propose ${childName} for ${marker}`,
      {
        name: childName,
        rationale: "form the target responsibility for AH10 qualification",
        responsibilityDraft: {
          purpose: `own the bounded responsibility for ${marker}`,
          ownedResponsibilities: [marker],
          obligations: ["accept precisely scoped Work from the Parent"],
          includes: ["the named child outcome"],
          excludes: ["Parent Workspace files and external side effects"],
          interfaces: ["Parent assigns Work through a scoped direct-child ref"],
        },
        resourceBoundaryDraft: {
          addresses: [{ _tag: "FileTree", path: childDirectory }],
        },
      },
    );
    s.childWorkspaceId = child.workspaceId;
    const sibling = await proposeAndApproveChildWithoutWork(
      client,
      project,
      siblingName,
      `Propose ${siblingName} for ${marker}`,
      {
        name: siblingName,
        rationale: "form a distinct sibling for target binding qualification",
        responsibilityDraft: {
          purpose: `own a separate sibling responsibility for ${marker}`,
          ownedResponsibilities: [`sibling-${marker}`],
          obligations: ["remain distinct from the assigned child"],
          includes: ["sibling-only scope"],
          excludes: ["the assigned child responsibility"],
          interfaces: ["Parent may assign Work independently"],
        },
        resourceBoundaryDraft: {
          addresses: [{ _tag: "FileTree", path: childDirectory }],
        },
      },
    );
    s.siblingWorkspaceId = sibling.workspaceId;
  }

  if (!nonRootParent) {
    await submitHumanMessage(
      client,
      project,
      `Create Parent Work ${sourceObjective}`,
    );
    const parentApproval = await waitForApproval(client, project, marker);
    await client.command(project.projectId, "ResolveControlApproval", {
      approvalId: parentApproval.approvalId,
      expectedRevision: parentApproval.revision,
      decision: "Approve",
      reason: "AH10 Root Parent Work seed approval",
    });
    const parentWork = await waitForPublic(
      () =>
        client.view<{
          workId?: string;
          objective?: string;
          revision: number;
        } | null>("current-work", {
          workspaceId: s.assignmentParentWorkspaceId,
        }),
      (work) =>
        work?.objective === sourceObjective && work.workId !== undefined,
    );
    const rootParentWorkId = parentWork?.workId;
    if (parentWork === null || rootParentWorkId === undefined) {
      throw new Error("Root assign_work did not expose the Parent WorkId");
    }
    s.parentWorkId = rootParentWorkId;
  }

  if (nonRootParent) {
    const target = await approveWorkspaceFormation(
      client,
      project,
      s.assignmentParentWorkspaceId,
      marker,
      childName,
    );
    s.childWorkspaceId = target.workspaceId;
    s.targetProposalApproved = true;
    const afterTargetProposal = await client.view<{
      workId?: string;
      revision: number;
      status: string;
    } | null>("current-work", {
      workspaceId: s.assignmentParentWorkspaceId,
    });
    expect(afterTargetProposal).toMatchObject({
      workId: s.parentWorkId,
      revision: 0,
      status: "Open",
    });
    await client.command(project.projectId, "SteerWork", {
      workId: s.parentWorkId,
      workspaceId: s.assignmentParentWorkspaceId,
      expectedWorkRevision: 0,
      steer: {
        severity: "Normal",
        guidance: `Continue Parent formation seed ${marker}.`,
      },
      provenance: { source: "HumanInput" },
    });
    const sibling = await approveWorkspaceFormation(
      client,
      project,
      s.assignmentParentWorkspaceId,
      siblingName,
      siblingName,
    );
    s.siblingWorkspaceId = sibling.workspaceId;
    s.siblingProposalApproved = true;
    const afterSiblingProposal = await client.view<{
      workId?: string;
      revision: number;
      status: string;
    } | null>("current-work", {
      workspaceId: s.assignmentParentWorkspaceId,
    });
    expect(afterSiblingProposal).toMatchObject({
      workId: s.parentWorkId,
      revision: 1,
      status: "Open",
    });
    await client.command(project.projectId, "SteerWork", {
      workId: s.parentWorkId,
      workspaceId: s.assignmentParentWorkspaceId,
      expectedWorkRevision: 1,
      steer: {
        severity: "Normal",
        guidance: `Continue Parent formation seed ${marker}.`,
      },
      provenance: { source: "HumanInput" },
    });
  }

  const seedParentWork = await waitForPublic(
    () =>
      client.view<{
        workId?: string;
        objective?: string;
        revision: number;
        status: string;
        activeExecution?: { executionId: string };
      } | null>("current-work", {
        workspaceId: s.assignmentParentWorkspaceId,
      }),
    (work) =>
      s.parentSeedWaitIssued &&
      work?.workId === s.parentWorkId &&
      work.objective === sourceObjective &&
      work.status === "Open" &&
      work.activeExecution === undefined,
  );
  if (seedParentWork === null || seedParentWork.workId !== s.parentWorkId) {
    throw new Error("Parent Work did not reach the expected seed wait");
  }
  const seededRevision = nonRootParent ? 2 : 0;
  expect(seedParentWork.revision).toBe(seededRevision);
  if (nonRootParent) {
    const childDetail = await client.view<{
      boundary?: {
        addresses?: ReadonlyArray<{ _tag: string; path?: string }>;
      };
    }>("workspace-detail", { workspaceId: s.childWorkspaceId });
    expect(childDetail.boundary?.addresses).toContainEqual({
      _tag: "FileTree",
      path: childDirectory,
    });
  }
  Object.assign(s, { seedParentWork });
};
