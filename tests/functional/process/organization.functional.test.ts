import { afterEach, describe, expect, it } from "vitest";
import {
  type CapturedProviderCall,
  type ProductionFixture,
  type ScriptedProviderResponse,
  startProductionFixture,
} from "../support/production-fixture.js";
import {
  createFunctionalProject,
  makePublicClient,
  submitHumanMessage,
  waitForPublic,
} from "../support/public-client.js";
import { makeWorkProvider } from "../support/work-provider.js";

const fixtures: ProductionFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

const serialized = (call: CapturedProviderCall): string =>
  JSON.stringify(call.messages);

const tools = (call: CapturedProviderCall): ReadonlySet<string> =>
  new Set(
    call.tools
      .map((tool) => tool.function?.name)
      .filter((name): name is string => name !== undefined),
  );

describe("release-functional long-lived responsibility", () => {
  it("F18 proposes, approves, runs and parent-accepts a child result", async () => {
    const marker = `F18-CHILD-${crypto.randomUUID().slice(0, 8)}`;
    let childDirectory = "";
    const childWorkProvider = makeWorkProvider({ marker, verdict: "Pass" });
    const reply = (call: CapturedProviderCall): ScriptedProviderResponse => {
      const available = tools(call);
      const context = serialized(call);
      const readyResultRef = /rref_[a-f0-9]{64}/u.exec(context)?.[0];
      if (available.has("accept_result") && readyResultRef !== undefined) {
        return {
          _tag: "ToolCall",
          name: "accept_result",
          arguments: { resultRef: readyResultRef },
        };
      }
      if (
        available.has("accept_result") &&
        available.has("list_workspaces") &&
        context.includes("Child result ready")
      ) {
        return {
          _tag: "ToolCall",
          name: "list_workspaces",
          arguments: { query: marker },
        };
      }
      if (
        available.has("propose_workspace") &&
        !available.has("claim_completion") &&
        context.includes(marker)
      ) {
        if (context.includes("ProposalRecorded(")) {
          return {
            _tag: "Text",
            text: `Proposal for ${marker} awaits governance`,
          };
        }
        return {
          _tag: "ToolCall",
          name: "propose_workspace",
          arguments: {
            name: `child-${marker}`,
            rationale: "independent long-lived responsibility",
            responsibilityDraft: {
              purpose: `own ${marker}`,
              ownedResponsibilities: [marker],
              obligations: ["deliver a verified result"],
              includes: [],
              excludes: [],
              interfaces: [],
            },
            resourceBoundaryDraft: {
              addresses: [{ _tag: "FileTree", path: childDirectory }],
            },
            initialWork: {
              objective: `Complete ${marker}.`,
              why: "exercise child responsibility delivery",
              constraints: ["do not perform external side effects"],
              completionExpectation: "verified child result",
              verificationMission: {
                goal: `Verify ${marker}`,
                criteria: [
                  {
                    criterionId: "functional-criterion",
                    requirement: `proof.txt contains FUNCTIONAL_VERIFIED for ${marker}`,
                    required: true,
                  },
                ],
                riskRequirements: ["read-only verification"],
              },
            },
          },
        };
      }
      return childWorkProvider(call);
    };

    const fixture = await startProductionFixture({
      isolatedPortHandshake: true,
      admitWorkspaceDirectory: true,
      reply,
    });
    fixtures.push(fixture);
    childDirectory = fixture.workspaceDirectory;
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "F18 organization",
      { resourceSelection: "Profile" },
    );

    await submitHumanMessage(
      client,
      project,
      `请为独立长期职责 ${marker} 提议一个子工作区，并附带首个工作。`,
    );
    const governance = await waitForPublic(
      () =>
        client.view<{
          unconsumed: Array<{
            entryKey: string;
            kind: string;
            summary: string;
          }>;
        }>("inbox-view", { workspaceId: project.rootWorkspaceId }),
      (value) =>
        value.unconsumed.some(
          (entry) =>
            entry.kind === "Governance" &&
            entry.summary.includes(marker) &&
            /^gov:fpr_[^:]+:\d+$/u.test(entry.entryKey),
        ),
    );
    const entry = governance.unconsumed.find(
      (candidate) =>
        candidate.summary.includes(marker) &&
        /^gov:fpr_[^:]+:\d+$/u.test(candidate.entryKey),
    );
    const target =
      entry === undefined
        ? null
        : /^gov:(fpr_[^:]+):(\d+)$/u.exec(entry.entryKey);
    if (target === null) throw new Error("no public formation target");

    const before = await client.view<{
      nodes: Array<{ workspaceId: string; name: string }>;
    }>("responsibility-tree", { projectId: project.projectId });
    expect(before.nodes).toHaveLength(1);
    await client.command(project.projectId, "RecordDecision", {
      proposalId: target[1],
      expectedProposalRevision: Number(target[2]),
      outcome: { _tag: "Approve" },
    });

    const childWithWork = await waitForPublic(
      () =>
        client.view<{
          nodes: Array<{
            workspaceId: string;
            parentWorkspaceId: string | null;
            name: string;
            currentWork?: { workId?: string; objective: string };
          }>;
        }>("responsibility-tree", { projectId: project.projectId }),
      (tree) =>
        tree.nodes.some(
          (node) =>
            node.parentWorkspaceId === project.rootWorkspaceId &&
            node.name === `child-${marker}` &&
            node.currentWork?.workId !== undefined,
        ),
      45_000,
    );
    const child = childWithWork.nodes.find(
      (node) => node.parentWorkspaceId === project.rootWorkspaceId,
    );
    const workId = child?.currentWork?.workId;
    if (child === undefined || workId === undefined) {
      throw new Error("child initial Work is not publicly visible");
    }

    let verification: {
      verdict?: string;
      acceptance?: { acceptanceId: string };
    };
    try {
      verification = await waitForPublic(
        () =>
          client.view<{
            verdict?: string;
            acceptance?: { acceptanceId: string };
          }>("verification", { workId }),
        (value) => value.verdict === "Pass" && value.acceptance !== undefined,
        30_000,
      );
    } catch (error) {
      const parentInbox = await client.view<{
        unconsumed: Array<{ entryKey: string; summary: string }>;
      }>("inbox-view", { workspaceId: project.rootWorkspaceId });
      const providerSummary = fixture.providerCalls.map((call) => ({
        tools: [...tools(call)],
        resultRef: /rref_[a-f0-9]{64}/u.exec(serialized(call))?.[0],
      }));
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; parentInbox=${JSON.stringify(parentInbox)}; provider=${JSON.stringify(providerSummary)}; daemon=${fixture.daemonErrors.join(" | ")}`,
      );
    }
    expect(verification.acceptance?.acceptanceId).toBeTruthy();
    const completed = await waitForPublic(
      () =>
        client.view<{
          nodes: Array<{
            workspaceId: string;
            currentWork?: { workId?: string };
          }>;
        }>("responsibility-tree", { projectId: project.projectId }),
      (tree) =>
        tree.nodes.find((node) => node.workspaceId === child.workspaceId)
          ?.currentWork === undefined,
    );
    expect(
      completed.nodes.find((node) => node.workspaceId === child.workspaceId)
        ?.currentWork,
    ).toBeUndefined();
    expect(fixture.daemonErrors).toEqual([]);
  }, 90_000);
});
