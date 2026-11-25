import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AhProbeHit,
  recordAhProbeLine,
} from "../support/ah-probe-line.js";
import {
  type CapturedProviderCall,
  type ProductionFixture,
  type ScriptedProviderResponse,
  startProductionFixture,
} from "../support/production-fixture.js";
import {
  createFunctionalProject,
  functionalId,
  makePublicClient,
  type PublicClient,
  submitHumanMessage,
  waitForApproval,
  waitForPublic,
} from "../support/public-client.js";

const fixtures: ProductionFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.stop();
  }
});

const serialized = (call: CapturedProviderCall): string =>
  JSON.stringify(call.messages);

const tools = (call: CapturedProviderCall): ReadonlySet<string> =>
  new Set(
    call.tools
      .map((tool) => tool.function?.name)
      .filter((name): name is string => name !== undefined),
  );

const transcript = (
  client: PublicClient,
  workspaceId: string,
  request: { readonly cursor?: string; readonly limit?: number } = {},
) =>
  client.view<{
    entries: Array<{
      kind: string;
      body?: string;
      messageId?: string;
      executionId?: string;
      responseStatus?: { state: string };
    }>;
    nextCursor?: string;
  }>("transcript", {
    workspaceId,
    limit: request.limit ?? 20,
    conversationOnly: true,
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
  });

const assignWork = (
  marker: string,
  requirement: string,
): ScriptedProviderResponse => ({
  _tag: "ToolCall",
  name: "assign_work",
  arguments: {
    objective: `Complete ${marker}.`,
    why: "functional release scenario",
    constraints: ["do not perform external side effects"],
    completionExpectation: "independently verified",
    verificationMission: {
      goal: `Verify ${marker}`,
      criteria: [
        {
          criterionId: "functional-criterion",
          requirement,
          required: true,
        },
      ],
      riskRequirements: ["do not perform external side effects"],
    },
    reason: "functional goal placement",
  },
});

const verdictProvider =
  (marker: string, verdict: "Fail" | "Unknown") =>
  (call: CapturedProviderCall): ScriptedProviderResponse => {
    const available = tools(call);
    const context = serialized(call);
    if (
      available.has("assign_work") &&
      !available.has("claim_completion") &&
      context.includes(marker)
    ) {
      return context.includes("WorkAssigned(")
        ? { _tag: "Text", text: `Work started for ${marker}` }
        : assignWork(
            marker,
            verdict === "Fail"
              ? "FUNCTIONAL_VERIFIED evidence demonstrates a required failure"
              : "FUNCTIONAL_VERIFIED evidence is insufficient for certainty",
          );
    }
    if (available.has("record_verification_evidence")) {
      const hasReadResult = call.messages.some(
        (message) =>
          message.role === "tool" &&
          message.content?.includes("FUNCTIONAL_VERIFIED") === true &&
          !message.content.includes("action/precondition"),
      );
      const evidenceIds = [...context.matchAll(/evd_[0-9a-f-]{36}/gu)].map(
        (match) => match[0],
      );
      if (!hasReadResult) {
        return {
          _tag: "ToolCall",
          name: "read",
          arguments: {
            target: { mount: "workspace", path: "proof.txt" },
            limit: 200,
          },
        };
      }
      if (evidenceIds.length === 0) {
        return {
          _tag: "ToolCall",
          name: "record_verification_evidence",
          arguments: {
            criterionId: "functional-criterion",
            sourceCallRef: "1",
          },
        };
      }
      return {
        _tag: "ToolCall",
        name: "conclude_verification",
        arguments: {
          verdict,
          criteriaResults: [
            {
              criterionId: "functional-criterion",
              requirement:
                verdict === "Fail"
                  ? "FUNCTIONAL_VERIFIED evidence demonstrates a required failure"
                  : "FUNCTIONAL_VERIFIED evidence is insufficient for certainty",
              required: true,
              verdict,
              evidenceRefs: [evidenceIds.at(-1)],
            },
          ],
          summary:
            verdict === "Fail"
              ? "Functional verifier found a required failure."
              : "Functional verifier cannot establish the criterion.",
        },
      };
    }
    if (available.has("claim_completion")) {
      return {
        _tag: "ToolCall",
        name: "claim_completion",
        arguments: { claim: `${marker} producer claim` },
      };
    }
    return { _tag: "Text", text: `Observed ${marker}` };
  };

describe("release-functional recovery and negative verdicts", () => {
  it("a denied file write becomes a durable visible blocker and stops requesting the model", async () => {
    const marker = `DENIED-WRITE-${crypto.randomUUID().slice(0, 8)}`;
    const request = "Grant write access to this project before continuing.";
    let writeGranted = false;
    let resumedWriteIssued = false;
    const fixture = await startProductionFixture({
      isolatedPortHandshake: true,
      admitWorkspaceDirectory: true,
      reply: (call) => {
        const available = tools(call);
        const context = serialized(call);
        if (!available.has("claim_completion")) {
          return context.includes("WorkAssigned(")
            ? { _tag: "Text", text: `Assigned ${marker}` }
            : assignWork(
                marker,
                "The project file contains the requested change.",
              );
        }
        if (writeGranted && resumedWriteIssued) {
          return {
            _tag: "ToolCall",
            name: "wait",
            arguments: {
              reason: "The resumed write is complete; await human review.",
              waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
            },
          };
        }
        if (!writeGranted && context.includes("tool authority denied")) {
          return {
            _tag: "ToolCall",
            name: "wait",
            arguments: { disposition: "Blocked", request },
          };
        }
        if (writeGranted) resumedWriteIssued = true;
        return {
          _tag: "ToolCall",
          name: "patch",
          arguments: {
            target: { mount: "workspace", path: "proof.txt" },
            unifiedDiff:
              "--- a/proof.txt\n+++ b/proof.txt\n@@ -1 +1 @@\n-FUNCTIONAL_VERIFIED\n+CHANGED\n",
          },
        };
      },
    });
    fixtures.push(fixture);
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "Denied write recovery",
      { resourceSelection: "Profile" },
    );
    await submitHumanMessage(client, project, `Complete ${marker}`);
    const approval = await waitForApproval(client, project, marker);
    await client.command(project.projectId, "ResolveControlApproval", {
      approvalId: approval.approvalId,
      expectedRevision: approval.revision,
      decision: "Approve",
      reason: "Approve this bounded Work; do not grant file write permission.",
    });
    const work = await waitForPublic(
      () =>
        client.view<{ workId: string } | null>("current-work", {
          workspaceId: project.rootWorkspaceId,
        }),
      (value) => value?.workId !== undefined,
    );
    if (work === null) throw new Error("Work missing");
    type Detail = {
      lifecycle: string;
      revision: number;
      blockedEpisode?: {
        sourceExecutionId: string;
        blockers: Array<{
          blockerId: string;
          failedActions: Array<{ denialCategory: string; request: string }>;
        }>;
      };
    };
    const detailRequest = {
      projectId: project.projectId,
      workspaceId: project.rootWorkspaceId,
      workId: work.workId,
    };
    const detail = await waitForPublic(
      () => client.view<Detail>("work-detail", detailRequest),
      (value) => (value.blockedEpisode?.blockers.length ?? 0) > 0,
    ).catch((error) => {
      throw new Error(
        `${String(error)}; daemon=${JSON.stringify(fixture.daemonErrors)}; provider=${JSON.stringify(fixture.providerCalls.slice(-4).map((call) => ({ tools: [...tools(call)], results: call.messages.filter((message) => message.role === "tool") })))}`,
      );
    });
    expect(detail.lifecycle).toBe("Open");
    expect(detail.blockedEpisode?.blockers[0]?.failedActions).toEqual([
      expect.objectContaining({
        denialCategory: "InvocationAuthorityDenied",
        request,
      }),
    ]);
    expect(
      readFileSync(join(fixture.workspaceDirectory, "proof.txt"), "utf8"),
    ).toBe("FUNCTIONAL_VERIFIED");
    const callsBeforeRestart = fixture.providerCalls.length;
    await fixture.restart();
    await waitForPublic(
      () => client.view<Detail>("work-detail", detailRequest),
      (value) =>
        value.blockedEpisode?.sourceExecutionId ===
        detail.blockedEpisode?.sourceExecutionId,
    );
    await new Promise((done) => setTimeout(done, 1500));
    expect(fixture.providerCalls).toHaveLength(callsBeforeRestart);
    await client.command(project.projectId, "GrantPermission", {
      permissionGrantId: functionalId("pgr"),
      issuer: "user:local",
      subject: {
        _tag: "WorkspaceAgent",
        workspaceId: project.rootWorkspaceId,
      },
      capability: "fs:write",
      target: project.rootWorkspaceId,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    writeGranted = true;
    await client.command(project.projectId, "SteerWork", {
      workId: work.workId,
      workspaceId: project.rootWorkspaceId,
      expectedWorkRevision: detail.revision,
      steer: {
        severity: "Normal",
        guidance: "File write access is now granted. Continue the change.",
      },
      provenance: { source: "HumanInput" },
    });
    await waitForPublic(
      async () =>
        readFileSync(join(fixture.workspaceDirectory, "proof.txt"), "utf8"),
      (value) => value.includes("CHANGED"),
    );
    const resumedDetail = await client.view<Detail>(
      "work-detail",
      detailRequest,
    );
    expect(resumedDetail.revision).toBe(detail.revision + 1);
    expect(resumedDetail.blockedEpisode).toBeUndefined();
    expect(fixture.daemonErrors).toEqual([]);
  }, 60_000);

  it("F10 rejection creates no Work and returns a visible correction", async () => {
    const marker = `F10-REJECT-${crypto.randomUUID().slice(0, 8)}`;
    const fixture = await startProductionFixture({
      isolatedPortHandshake: true,
      reply: (call) => {
        const context = serialized(call);
        if (context.includes(marker) && tools(call).has("assign_work")) {
          return context.includes("control_action_denied")
            ? { _tag: "Text", text: `未创建 ${marker}` }
            : assignWork(marker, "must never run after rejection");
        }
        return { _tag: "Text", text: "No action" };
      },
    });
    fixtures.push(fixture);
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "F10 rejection",
    );

    await submitHumanMessage(client, project, `请创建目标 ${marker}`);
    const approval = await waitForApproval(client, project, marker);
    expect(
      await client.view("current-work", {
        workspaceId: project.rootWorkspaceId,
      }),
    ).toBeNull();
    await client.command(project.projectId, "ResolveControlApproval", {
      approvalId: approval.approvalId,
      expectedRevision: approval.revision,
      decision: "Reject",
      reason: "functional rejection",
    });

    await waitForPublic(
      () => transcript(client, project.rootWorkspaceId),
      (page) =>
        page.entries.some(
          (entry) =>
            entry.kind === "AssistantConversationTurn" &&
            entry.body === `未创建 ${marker}`,
        ),
    );
    expect(
      await client.view("current-work", {
        workspaceId: project.rootWorkspaceId,
      }),
    ).toBeNull();
    expect(fixture.daemonErrors).toEqual([]);
  });

  it("F11 one provider outage recovers to one authoritative answer", async () => {
    const marker = `F11-RECOVER-${crypto.randomUUID().slice(0, 8)}`;
    let unavailable = true;
    const fixture = await startProductionFixture({
      isolatedPortHandshake: true,
      reply: (call) => {
        if (serialized(call).includes(marker) && unavailable) {
          unavailable = false;
          return { _tag: "HttpError", status: 503 };
        }
        return { _tag: "Text", text: `已恢复 ${marker}` };
      },
    });
    fixtures.push(fixture);
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "F11 recovery",
    );

    await submitHumanMessage(client, project, `请回复 ${marker}`);
    const page = await waitForPublic(
      () => transcript(client, project.rootWorkspaceId),
      (value) =>
        value.entries.some((entry) => entry.body === `已恢复 ${marker}`),
      45_000,
    );
    expect(
      page.entries.filter((entry) => entry.body === `已恢复 ${marker}`),
    ).toHaveLength(1);
    expect(
      fixture.providerCalls.filter((call) => serialized(call).includes(marker)),
    ).toHaveLength(2);
    expect(fixture.daemonErrors).toEqual([]);
  });

  for (const verdict of ["Fail", "Unknown"] as const) {
    it(`F${verdict === "Fail" ? "12" : "13"} Verification ${verdict} keeps Work Open`, async () => {
      const marker = `F${verdict === "Fail" ? "12-FAIL" : "13-UNKNOWN"}-${crypto.randomUUID().slice(0, 8)}`;
      const fixture = await startProductionFixture({
        isolatedPortHandshake: true,
        admitWorkspaceDirectory: true,
        reply: verdictProvider(marker, verdict),
      });
      fixtures.push(fixture);
      const client = makePublicClient(fixture.baseUrl);
      const project = await createFunctionalProject(
        client,
        fixture.workspaceDirectory,
        `${verdict} verification`,
        { resourceSelection: "Profile" },
      );

      await submitHumanMessage(client, project, `请创建并执行 ${marker}`);
      const approval = await waitForApproval(client, project, marker);
      await client.command(project.projectId, "ResolveControlApproval", {
        approvalId: approval.approvalId,
        expectedRevision: approval.revision,
        decision: "Approve",
        reason: `exercise ${verdict}`,
      });
      const work = await waitForPublic(
        () =>
          client.view<{
            workId?: string;
            objective: string;
            status: string;
            revision: number;
          } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
        (value) => value?.workId !== undefined,
      );
      if (work?.workId === undefined) throw new Error("Work not visible");
      let verification: {
        verdict?: string;
        evidenceRefs: string[];
        acceptance?: unknown;
      };
      try {
        verification = await waitForPublic(
          () =>
            client.view<{
              verdict?: string;
              evidenceRefs: string[];
              acceptance?: unknown;
            }>("verification", { workId: work.workId }),
          (value) => value.verdict === verdict,
          45_000,
        );
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; daemon=${fixture.daemonErrors.join(" | ")}; provider=${JSON.stringify(fixture.providerCalls.slice(-8))}`,
        );
      }
      expect(verification.evidenceRefs).toHaveLength(1);
      expect(verification.acceptance).toBeUndefined();
      expect(
        await client.view<{ workId?: string; status: string } | null>(
          "current-work",
          { workspaceId: project.rootWorkspaceId },
        ),
      ).toMatchObject({ workId: work.workId, status: "Open" });
      expect(fixture.daemonErrors).toEqual([]);
    }, 60_000);
  }

  it.each(["AH12BeforeSuccessCommit", "AH12AfterSuccessCommit"] as const)(
    "F16 crash at %s preserves the durable result boundary",
    async (boundary) => {
      const marker = `F16-CRASH-${crypto.randomUUID().slice(0, 8)}`;
      const hits: AhProbeHit[] = [];
      const committed = boundary === "AH12AfterSuccessCommit";
      const daemonOutput: string[] = [];
      const fixture = await startProductionFixture({
        isolatedPortHandshake: true,
        firstDaemonEntry: resolve(
          "tests/functional/support/ah-crash-child.mjs",
        ),
        daemonEnvironment: { ARBOR_AH_BOUNDARY: boundary },
        onDaemonStdout: (line) => {
          daemonOutput.push(line);
          recordAhProbeLine(hits, line);
        },
        reply: (call) => {
          const context = serialized(call);
          return {
            _tag: "Text",
            text: context.includes(marker) ? `RECOVERED ${marker}` : "ack",
          };
        },
      });
      fixtures.push(fixture);
      const baseUrlBeforeRestart = fixture.baseUrl;
      const client = makePublicClient(fixture.baseUrl);
      const project = await createFunctionalProject(
        client,
        fixture.workspaceDirectory,
        "F16 crash recovery",
      );

      await submitHumanMessage(client, project, `请回复 ${marker}`);
      await waitForPublic(
        async () => hits,
        (value) => value.some((hit) => hit.boundary === boundary),
      );
      expect(fixture.providerCalls).toHaveLength(1);
      await fixture.crash();
      await fixture.restart();
      expect(fixture.baseUrl).toBe(baseUrlBeforeRestart);

      const page = await waitForPublic(
        () => transcript(client, project.rootWorkspaceId),
        (value) =>
          value.entries.some((entry) =>
            committed
              ? entry.body === `RECOVERED ${marker}`
              : entry.kind === "HumanConversationTurn" &&
                entry.body?.includes(marker) === true &&
                entry.responseStatus?.state === "NeedsAttention",
          ),
        45_000,
      );
      expect(
        page.entries.filter((entry) => entry.body === `RECOVERED ${marker}`),
      ).toHaveLength(committed ? 1 : 0);
      const calls = fixture.providerCalls.filter((call) =>
        serialized(call).includes(marker),
      );
      expect(calls).toHaveLength(1);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
      const stable = await transcript(client, project.rootWorkspaceId);
      expect(
        stable.entries.filter((entry) => entry.body === `RECOVERED ${marker}`),
      ).toHaveLength(committed ? 1 : 0);
      expect(fixture.providerCalls).toHaveLength(1);
      const startupReports = daemonOutput
        .map((line) => {
          try {
            return JSON.parse(line) as {
              readonly tag?: string;
              readonly nonce?: string;
              readonly pid?: number;
              readonly port?: number;
            };
          } catch {
            return undefined;
          }
        })
        .filter(
          (report) =>
            report?.tag === "FUNCTIONAL_DAEMON_STARTED" ||
            report?.tag === "FUNCTIONAL_DAEMON_LISTENING",
        );
      const started = startupReports.filter(
        (report) => report?.tag === "FUNCTIONAL_DAEMON_STARTED",
      );
      const listening = startupReports.filter(
        (report) => report?.tag === "FUNCTIONAL_DAEMON_LISTENING",
      );
      expect(started).toHaveLength(2);
      expect(listening).toHaveLength(2);
      expect(started[1]?.nonce).not.toBe(started[0]?.nonce);
      expect(started[1]?.pid).not.toBe(started[0]?.pid);
      expect(listening.map((report) => report?.nonce)).toEqual(
        started.map((report) => report?.nonce),
      );
      expect(listening.map((report) => report?.pid)).toEqual(
        started.map((report) => report?.pid),
      );
      expect(listening.map((report) => report?.port)).toEqual([
        Number(new URL(baseUrlBeforeRestart).port),
        Number(new URL(baseUrlBeforeRestart).port),
      ]);
      expect(fixture.daemonErrors).toEqual([]);
    },
    90_000,
  );

  it("F17 reaches a third conversation page without duplicates", async () => {
    const prefix = `F17-PAGE-${crypto.randomUUID().slice(0, 8)}`;
    const fixture = await startProductionFixture({
      isolatedPortHandshake: true,
      reply: (call) => {
        const matches = [
          ...serialized(call).matchAll(/F17-PAGE-[A-Za-z0-9-]+-M\d/gu),
        ];
        const marker = matches.at(-1)?.[0] ?? "F17-NONE";
        return { _tag: "Text", text: `ECHO ${marker}` };
      },
    });
    fixtures.push(fixture);
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "F17 pagination",
    );

    for (let index = 0; index < 4; index += 1) {
      const marker = `${prefix}-M${index}`;
      await submitHumanMessage(client, project, marker);
      await waitForPublic(
        () => transcript(client, project.rootWorkspaceId),
        (page) => page.entries.some((entry) => entry.body === `ECHO ${marker}`),
      );
    }

    const first = await transcript(client, project.rootWorkspaceId, {
      limit: 2,
    });
    const firstCursor = first.nextCursor;
    if (firstCursor === undefined) throw new Error("first page has no cursor");
    const second = await transcript(client, project.rootWorkspaceId, {
      limit: 2,
      cursor: firstCursor,
    });
    const secondCursor = second.nextCursor;
    if (secondCursor === undefined) {
      throw new Error("second page has no cursor");
    }
    const third = await transcript(client, project.rootWorkspaceId, {
      limit: 2,
      cursor: secondCursor,
    });
    const entries = [...first.entries, ...second.entries, ...third.entries];
    const identities = entries.map(
      (entry) =>
        `${entry.kind}:${entry.messageId ?? entry.executionId ?? "unknown"}`,
    );
    expect(new Set(identities).size).toBe(identities.length);
    expect(entries).toHaveLength(6);
    expect(fixture.daemonErrors).toEqual([]);
  }, 60_000);
});
