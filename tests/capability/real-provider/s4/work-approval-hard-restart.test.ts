// REAL S4-B exact shell EAP and TrustedLocal P1 policy across a same-DB
// hard restart (B5 split). The test body is moved verbatim from the former
// monolithic public-s4-recovery.test.ts.
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  createFunctionalProject,
  functionalId,
  submitHumanMessage,
  waitForApproval,
  waitForExecutableApproval,
} from "../../../functional/support/public-client.js";
import {
  commitTrustedLocalP11Policy,
  createTrustedLocalP11FixtureEnvironment,
  grantTrustedLocalP11Permission,
  initializeTrustedLocalP11Worktree,
  readCommittedTrustedLocalP11Snapshot,
} from "../../../functional/support/trusted-local-fixture.js";
import {
  armProviderResponseGate,
  captureWorkspaceSnapshot,
  makeDeadlinePublicClient,
  providerRequestsMatching,
  readProviderCaptures,
  releaseProviderResponse,
  startedProviderRequests,
  waitForHeldProviderResponse,
} from "../public-real-journey-support.js";
import {
  readPendingApprovalBinding,
  readSuccessfulShellInvocation,
  readWorkEpisodeBinding,
} from "./support/approval-binding.js";
import {
  assertPrivateFixturePaths,
  CAPTURE_FILE_ENV,
  isStrictlyInside,
  JOURNEY_BUDGET_MS,
  publicStateOracle,
  publicWorkDetail,
  RESPONSE_GATE_DIRECTORY_ENV,
  requireBoundProviderRequests,
  skipReason,
  waitWithinDeadline,
  withRealFixture,
  workspaceWorkProviderRequestIds,
} from "./support/journey.js";
import { requireSingleShellGetDateToolCall } from "./support/shell-get-date.js";

it.skipIf(skipReason !== undefined)(
  skipReason === undefined
    ? "REAL S4-B: exact shell EAP and TrustedLocal P1 policy survive same-DB hard restart"
    : `REAL NOT QUALIFIED: ${skipReason}`,
  async () => {
    const p11Fixture = createTrustedLocalP11FixtureEnvironment();
    await withRealFixture({
      caseId: "s4-b-work-approval-hard-restart",
      responseGate: true,
      requiredDaemonEnvironment: p11Fixture.daemonEnvironment,
      setupProbe: p11Fixture.setupProbe,
      body: async (run, deadlineAt) => {
        assertPrivateFixturePaths(run.fixture);
        const client = makeDeadlinePublicClient(run.fixture, deadlineAt);
        const marker = `S4B-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
        const expiresAt = new Date(deadlineAt).toISOString();
        const resourceCatalog = await client.projectResources();
        const availableProfiles = resourceCatalog.profiles.filter(
          (profile) => profile.available,
        );
        expect(availableProfiles).toHaveLength(1);
        expect(availableProfiles[0]).toMatchObject({
          resourceProfileRef: "project-root",
          available: true,
        });
        const project = await createFunctionalProject(
          client,
          run.fixture.workspaceDirectory,
          `Real public S4 approval ${marker}`,
          { resourceSelection: "Profile" },
        );
        const currentWorkBeforeSubmission = await client.view<{
          readonly workId?: string;
          readonly revision: number;
        } | null>("current-work", { workspaceId: project.rootWorkspaceId });
        expect(currentWorkBeforeSubmission).toBeNull();
        await initializeTrustedLocalP11Worktree({
          databaseFile: run.fixture.databaseFile,
          projectId: project.projectId,
          workspaceId: project.rootWorkspaceId,
          path: run.fixture.workspaceDirectory,
        });
        const authoritySourceFile =
          p11Fixture.daemonEnvironment.ARBOR_SANDBOX_AUTHORITY_SOURCE_FILE;
        if (authoritySourceFile === undefined) {
          throw new Error(
            "P11 setupProbe did not add its private authority source",
          );
        }
        expect(
          isStrictlyInside(run.fixture.directory, authoritySourceFile),
        ).toBe(true);
        const workspaceBaseline = captureWorkspaceSnapshot(
          run.fixture.workspaceDirectory,
        );
        await client.command(project.projectId, "GrantPermission", {
          permissionGrantId: functionalId("pgr"),
          issuer: "user:local",
          subject: {
            _tag: "WorkspaceAgent",
            workspaceId: project.rootWorkspaceId,
          },
          capability: "shell:exec",
          target: project.rootWorkspaceId,
          expiresAt,
        });
        const gateSelector = {
          requiredAdvertisedToolName: "shell",
          requiredResponseToolCall: {
            name: "shell",
            requiredArguments: {
              command: "Get-Date",
              cwd: { mount: "workspace", path: "." },
            },
            allowedAdditionalArguments: ["timeoutMs"],
            numericArgumentMaximums: { timeoutMs: 5_000 },
          },
        } as const;
        armProviderResponseGate(run, gateSelector);
        const startsBeforeWork = startedProviderRequests(
          readProviderCaptures(run.captureFile),
        ).length;
        await submitHumanMessage(
          client,
          project,
          `Please create a Work for ${marker}. Its only executable action must be exactly one shell call running Get-Date in the current workspace. Do not use patch, read, another tool, or any file/network effect. In the Work turn call shell immediately with command Get-Date, cwd {mount:"workspace",path:"."}, and timeoutMs 5000; Runtime will intercept that exact ActionCall and create the required approval. Do not wait, send_message, or ask conversationally before the call. After the approved call resumes, report the timestamp without claiming Work completion.`,
        );
        const rootApproval = await waitForApproval(client, project, marker);
        await client.command(project.projectId, "ResolveControlApproval", {
          approvalId: rootApproval.approvalId,
          expectedRevision: rootApproval.revision,
          decision: "Approve",
          reason: `public Root Work admission for ${marker}`,
        });
        const admittedWork = await waitWithinDeadline({
          deadlineAt,
          label: "new public Current Work after Root approval",
          read: () =>
            client.view<{
              readonly workId?: string;
              readonly revision: number;
            } | null>("current-work", {
              workspaceId: project.rootWorkspaceId,
            }),
          predicate: (value) => value?.workId !== undefined,
        });
        const workId = admittedWork?.workId;
        if (workId === undefined) {
          throw new Error(
            "Root approval did not expose the new public Work id",
          );
        }
        const workBefore = await waitWithinDeadline({
          deadlineAt,
          label: "same Open Work before its shell action",
          read: () =>
            publicWorkDetail(
              client,
              project.projectId,
              project.rootWorkspaceId,
              workId,
            ),
          predicate: (value) =>
            value.workId === workId && value.lifecycle === "Open",
        });
        const held = await waitForHeldProviderResponse(run, {
          afterSequence: startsBeforeWork,
          deadlineAt,
          selector: gateSelector,
        });
        const heldRequest = held.request;
        if (heldRequest === undefined) {
          throw new Error("held real Provider response lacks its request body");
        }
        const shellCall = requireSingleShellGetDateToolCall(
          held.responseBodyBase64,
        );
        expect(shellCall.arguments.command).toBe("Get-Date");
        expect(JSON.stringify(heldRequest)).toContain(
          "In a WorkspaceWork turn bound to a current Work",
        );
        const heldMessages = heldRequest.messages;
        const rootWorkAssignmentLeakedIntoHeldRequest =
          Array.isArray(heldMessages) &&
          heldMessages.some(
            (message) =>
              typeof message === "object" &&
              message !== null &&
              (message as { role?: unknown }).role === "tool" &&
              (message as { content?: unknown }).content ===
                `WorkAssigned(${workId}, ${project.rootWorkspaceId})`,
          );
        expect(rootWorkAssignmentLeakedIntoHeldRequest).toBe(false);
        expect(JSON.stringify(heldRequest)).toContain(marker);
        const heldStartEvidence = requireBoundProviderRequests(
          providerRequestsMatching(
            readProviderCaptures(run.captureFile),
            (request) =>
              JSON.stringify(request) === JSON.stringify(heldRequest),
          ),
          "held WorkspaceWork shell call",
        ).find((evidence) => evidence.requestId === held.requestId);
        expect(heldStartEvidence?.requestStart.processId).toBe(
          run.fixture.daemonProcessSnapshot()?.pid,
        );
        const currentWorkAtGate = await waitWithinDeadline({
          deadlineAt,
          label: "active Execution while exact shell response is held",
          read: () =>
            client.view<{
              readonly workId?: string;
              readonly revision: number;
              readonly activeExecution?: { readonly executionId?: string };
            } | null>("current-work", {
              workspaceId: project.rootWorkspaceId,
            }),
          predicate: (value) =>
            value?.workId === workId &&
            value.activeExecution?.executionId !== undefined,
        });
        const executionId = currentWorkAtGate?.activeExecution?.executionId;
        if (executionId === undefined) {
          throw new Error(
            "current Work omitted exact active Execution at held gate",
          );
        }
        expect(
          readWorkEpisodeBinding(run.fixture.databaseFile, executionId),
        ).toMatchObject({
          execution_id: executionId,
          project_id: project.projectId,
          workspace_id: project.rootWorkspaceId,
          episode_kind: "WorkEpisode",
          episode_ref: workId,
        });
        await grantTrustedLocalP11Permission({
          client,
          projectId: project.projectId,
          executionId,
          expiresAt,
        });
        releaseProviderResponse(run, held.requestId);
        const approval = await waitForExecutableApproval(
          client,
          project.rootWorkspaceId,
          marker,
          Math.min(90_000, deadlineAt - Date.now()),
        );
        const bindingBefore = readPendingApprovalBinding(
          run.fixture.databaseFile,
          approval.approvalId,
        );
        expect(bindingBefore.approvalRevision).toBe(approval.revision);
        expect(bindingBefore).toMatchObject({
          workId,
          approvalId: approval.approvalId,
          routeKind: "Executable",
          executionId,
          episodeKind: "WorkEpisode",
          toolName: "shell",
          sideEffectSemantics: "NonIdempotent",
          arguments: {
            command: "Get-Date",
            cwd: { mount: "workspace", path: "." },
          },
          targetResourceSpaceIds: ["filesystem"],
          approvalState: "Pending",
          approvalRevision: 0,
          actionState: "Pending",
          invocationCount: 0,
        });
        expect(
          readCommittedTrustedLocalP11Snapshot(
            run.fixture.databaseFile,
            executionId,
          ),
        ).toBeUndefined();
        expect(
          captureWorkspaceSnapshot(run.fixture.workspaceDirectory),
        ).toEqual(workspaceBaseline);

        // The public P1 policy is committed while this exact P4 EAP remains
        // pending. P1 supplies the process context; it is not the EAP source.
        const { snapshot: sandboxPolicySnapshot } =
          await commitTrustedLocalP11Policy({
            client,
            baseUrl: run.fixture.baseUrl,
            databaseFile: run.fixture.databaseFile,
            projectId: project.projectId,
            workspaceId: project.rootWorkspaceId,
            executionId,
            expiresAt,
          });
        expect(sandboxPolicySnapshot).toMatchObject({
          kind: "TrustedLocalUnconfinedV1",
          projectId: project.projectId,
          workspaceId: project.rootWorkspaceId,
          executionId,
          profile: "FullAccess",
          trustedRuntimeIdentity: "TrustedLocal",
        });
        expect(
          readPendingApprovalBinding(
            run.fixture.databaseFile,
            approval.approvalId,
          ),
        ).toEqual(bindingBefore);
        expect(
          captureWorkspaceSnapshot(run.fixture.workspaceDirectory),
        ).toEqual(workspaceBaseline);
        const pendingInvocationBeforeRestart = readSuccessfulShellInvocation({
          databaseFile: run.fixture.databaseFile,
          executionId,
          approvalId: approval.approvalId,
          toolInvocationId: bindingBefore.toolInvocationId,
          callRef: bindingBefore.callRef,
        });
        expect(pendingInvocationBeforeRestart.executionInvocations).toEqual([]);
        expect(pendingInvocationBeforeRestart.executionToolResultCount).toBe(0);
        expect(pendingInvocationBeforeRestart.executionApprovals).toEqual([
          {
            approval_id: approval.approvalId,
            state: "Pending",
            tool_invocation_id: bindingBefore.toolInvocationId,
          },
        ]);
        const workRequestIdsBeforeRestart = workspaceWorkProviderRequestIds(
          readProviderCaptures(run.captureFile),
          marker,
        );
        expect(workRequestIdsBeforeRestart).toContain(held.requestId);

        const oldDaemonPid = run.fixture.daemonProcessSnapshot()?.pid;
        await run.fixture.crash();
        expect(run.fixture.daemonsExited()).toBe(true);
        await run.fixture.restart({
          daemonEnvironment: {
            [CAPTURE_FILE_ENV]: run.captureFile,
            [RESPONSE_GATE_DIRECTORY_ENV]: "",
          },
        });
        const newDaemonPid = run.fixture.daemonProcessSnapshot()?.pid;
        expect(newDaemonPid).toBeDefined();
        expect(newDaemonPid).not.toBe(oldDaemonPid);
        const restartedEnvironmentKeys =
          run.fixture.daemonProcessSnapshot()?.environmentKeys ?? [];
        expect(restartedEnvironmentKeys).toContain(
          "ARBOR_SANDBOX_AUTHORITY_SOURCE_FILE",
        );
        expect(restartedEnvironmentKeys).toContain("ARBOR_AUTH_TOKENS");

        const resumedWork = await waitWithinDeadline({
          deadlineAt,
          label: "same active Work and Execution after restart",
          read: () =>
            client.view<{
              readonly workId?: string;
              readonly revision: number;
              readonly activeExecution?: { readonly executionId?: string };
            } | null>("current-work", {
              workspaceId: project.rootWorkspaceId,
            }),
          predicate: (value) =>
            value?.workId === workId &&
            value.activeExecution?.executionId === executionId,
        });
        if (resumedWork === null || resumedWork.workId !== workId) {
          throw new Error(
            "same Work disappeared from Current Work after restart",
          );
        }
        expect(resumedWork.revision).toBe(workBefore.revision);
        const resumedWorkDetail = await publicWorkDetail(
          client,
          project.projectId,
          project.rootWorkspaceId,
          workId,
        );
        expect(resumedWorkDetail).toMatchObject({
          workId,
          workspaceId: project.rootWorkspaceId,
          lifecycle: "Open",
          revision: workBefore.revision,
        });
        const resumedApproval = await waitForExecutableApproval(
          client,
          project.rootWorkspaceId,
          marker,
          Math.min(90_000, deadlineAt - Date.now()),
        );
        expect(resumedApproval).toEqual(approval);
        const bindingAfter = readPendingApprovalBinding(
          run.fixture.databaseFile,
          approval.approvalId,
        );
        expect(bindingAfter).toEqual(bindingBefore);
        expect(
          readCommittedTrustedLocalP11Snapshot(
            run.fixture.databaseFile,
            executionId,
          ),
        ).toEqual(sandboxPolicySnapshot);
        const pendingInvocation = readSuccessfulShellInvocation({
          databaseFile: run.fixture.databaseFile,
          executionId,
          approvalId: approval.approvalId,
          toolInvocationId: bindingBefore.toolInvocationId,
          callRef: bindingBefore.callRef,
        });
        expect(pendingInvocation.invocationRows).toEqual([]);
        expect(pendingInvocation.effectAttempts).toEqual([]);
        expect(pendingInvocation.approvalsForInvocation).toEqual([
          { approval_id: approval.approvalId },
        ]);
        expect(pendingInvocation.executionApprovals).toEqual([
          {
            approval_id: approval.approvalId,
            state: "Pending",
            tool_invocation_id: bindingBefore.toolInvocationId,
          },
        ]);
        expect(pendingInvocation.executionInvocations).toEqual([]);
        expect(pendingInvocation.executionToolResultCount).toBe(0);
        expect(pendingInvocation.exactToolResults).toEqual([]);
        expect(
          captureWorkspaceSnapshot(run.fixture.workspaceDirectory),
        ).toEqual(workspaceBaseline);
        const quietWindowMs = Math.min(1_500, deadlineAt - Date.now());
        if (quietWindowMs <= 0) {
          throw new Error(
            "S4 deadline expired before bounded approval idle window",
          );
        }
        await new Promise((resolveWait) =>
          setTimeout(resolveWait, quietWindowMs),
        );
        const stillPending = await waitForExecutableApproval(
          client,
          project.rootWorkspaceId,
          marker,
          Math.min(15_000, deadlineAt - Date.now()),
        );
        expect(stillPending).toEqual(approval);
        expect(
          readPendingApprovalBinding(
            run.fixture.databaseFile,
            approval.approvalId,
          ),
        ).toEqual(bindingBefore);
        const capturesWhilePending = readProviderCaptures(run.captureFile);
        expect(
          workspaceWorkProviderRequestIds(capturesWhilePending, marker),
        ).toEqual(workRequestIdsBeforeRestart);
        expect(
          startedProviderRequests(capturesWhilePending).filter(
            (capture) => capture.processId === newDaemonPid,
          ),
        ).toEqual([]);
        expect(
          captureWorkspaceSnapshot(run.fixture.workspaceDirectory),
        ).toEqual(workspaceBaseline);

        expect(
          await client.command(project.projectId, "ResolveExecutableApproval", {
            approvalId: approval.approvalId,
            expectedRevision: approval.revision,
            decision: "Approve",
            reason: `approve the exact shell Get-Date action for ${marker} after restart`,
          }),
        ).toMatchObject({ body: { resolution: "Committed" } });
        const successfulInvocation = await waitWithinDeadline({
          deadlineAt,
          label: "same shell ToolInvocation and ToolResult succeed once",
          read: async () =>
            readSuccessfulShellInvocation({
              databaseFile: run.fixture.databaseFile,
              executionId,
              approvalId: approval.approvalId,
              toolInvocationId: bindingBefore.toolInvocationId,
              callRef: bindingBefore.callRef,
            }),
          predicate: (snapshot) =>
            snapshot.invocationRows.length === 1 &&
            snapshot.invocationRows[0]?.settlement_kind === "Success" &&
            snapshot.exactToolResults.length === 1,
        });
        expect(successfulInvocation.invocationRows).toMatchObject([
          {
            invocation_id: bindingBefore.toolInvocationId,
            execution_id: executionId,
            tool_name: "shell",
            side_effect_semantics: "NonIdempotent",
            approval_id: approval.approvalId,
            settlement_kind: "Success",
            result_ref: null,
          },
        ]);
        expect(successfulInvocation.invocationRows[0]?.settled_at).toBeTruthy();
        const rawObservation =
          successfulInvocation.invocationRows[0]?.observation_json;
        if (rawObservation === undefined || rawObservation === null) {
          throw new Error(
            "successful shell ToolInvocation lacks observation JSON",
          );
        }
        const canonicalObservation = JSON.parse(rawObservation) as {
          readonly _tag?: unknown;
          readonly observation?: {
            readonly text?: unknown;
            readonly truncated?: unknown;
          };
          readonly resultRef?: unknown;
        };
        expect(canonicalObservation._tag).toBe("Success");
        expect(canonicalObservation.resultRef).toBeNull();
        const boundedObservation = canonicalObservation.observation;
        if (
          typeof boundedObservation?.text !== "string" ||
          typeof boundedObservation.truncated !== "boolean"
        ) {
          throw new Error("successful shell observation is not bounded text");
        }
        expect(boundedObservation.text.length).toBeLessThanOrEqual(2_000);
        expect(boundedObservation.truncated).toBe(false);
        expect(successfulInvocation.effectAttempts).toEqual([
          { attempt_no: 0, admission_state: "MayHaveStarted" },
        ]);
        expect(successfulInvocation.approvalRows).toMatchObject([
          {
            approval_id: approval.approvalId,
            route_kind: "Executable",
            execution_id: executionId,
            state: "Consumed",
            consumed_by: bindingBefore.toolInvocationId,
            tool_invocation_id: bindingBefore.toolInvocationId,
          },
        ]);
        expect(successfulInvocation.executionApprovals).toEqual([
          {
            approval_id: approval.approvalId,
            state: "Consumed",
            tool_invocation_id: bindingBefore.toolInvocationId,
          },
        ]);
        expect(
          successfulInvocation.executionApprovals.filter(
            (row) => row.state === "Pending",
          ),
        ).toEqual([]);
        expect(successfulInvocation.executionInvocations).toEqual([
          {
            invocation_id: bindingBefore.toolInvocationId,
            tool_name: "shell",
            approval_id: approval.approvalId,
            settlement_kind: "Success",
          },
        ]);
        expect(successfulInvocation.executionToolResultCount).toBe(1);
        expect(successfulInvocation.approvalsForInvocation).toEqual([
          { approval_id: approval.approvalId },
        ]);
        expect(successfulInvocation.exactToolResults).toHaveLength(1);
        const releasedCaptures = readProviderCaptures(run.captureFile).filter(
          (capture) =>
            capture.event === "response-released" &&
            capture.requestId === held.requestId,
        );
        expect(releasedCaptures).toHaveLength(1);
        expect(
          readProviderCaptures(run.captureFile).filter(
            (capture) =>
              capture.event === "response-held" &&
              capture.processId === newDaemonPid,
          ),
        ).toEqual([]);
        expect(
          captureWorkspaceSnapshot(run.fixture.workspaceDirectory),
        ).toEqual(workspaceBaseline);
        const successQuietWindowMs = Math.min(1_500, deadlineAt - Date.now());
        if (successQuietWindowMs <= 0) {
          throw new Error(
            "S4 deadline expired before bounded post-approval stability window",
          );
        }
        await new Promise((resolveWait) =>
          setTimeout(resolveWait, successQuietWindowMs),
        );
        const stableSuccessfulInvocation = readSuccessfulShellInvocation({
          databaseFile: run.fixture.databaseFile,
          executionId,
          approvalId: approval.approvalId,
          toolInvocationId: bindingBefore.toolInvocationId,
          callRef: bindingBefore.callRef,
        });
        expect(stableSuccessfulInvocation).toEqual(successfulInvocation);
        expect(
          captureWorkspaceSnapshot(run.fixture.workspaceDirectory),
        ).toEqual(workspaceBaseline);
        const continuedWork = await waitWithinDeadline({
          deadlineAt,
          label: "same Work remains publicly inspectable after approved action",
          read: () =>
            publicWorkDetail(
              client,
              project.projectId,
              project.rootWorkspaceId,
              workId,
            ),
          predicate: (value) => value.workId === workId,
        });
        expect(continuedWork.workspaceId).toBe(project.rootWorkspaceId);
        expect(run.fixture.providerCalls).toHaveLength(0);
        expect(run.fixture.daemonErrors).toEqual([]);

        return {
          oracleLayer: publicStateOracle,
          approvalBindingOracle: "ReadOnlySQLiteAuxiliary",
          projectId: project.projectId,
          workspaceId: project.rootWorkspaceId,
          resourceProfileRef: availableProfiles[0]?.resourceProfileRef,
          workId,
          workRevisionBeforeRestart: workBefore.revision,
          workRevisionAfterRestartBeforeApproval: resumedWork.revision,
          executableApprovalId: approval.approvalId,
          shellResponseRequestId: held.requestId,
          shellResponseProcessId: held.processId,
          executionId: bindingBefore.executionId,
          toolInvocationId: bindingBefore.toolInvocationId,
          logicalStepNo: bindingBefore.logicalStepNo,
          repairAttempt: bindingBefore.repairAttempt,
          actionIndex: bindingBefore.actionIndex,
          logicalActionId: bindingBefore.logicalActionId,
          callRef: bindingBefore.callRef,
          sameApprovalAndActionBindingSurvivedRestart: true,
          sameToolInvocationSucceededOnce: true,
          exactToolResultCount: successfulInvocation.exactToolResults.length,
          approvalWaitQuietWindowMs: quietWindowMs,
          oldDaemonPid,
          newDaemonPid,
          p1TrustedLocalPolicySnapshot: sandboxPolicySnapshot,
          workspaceBaselineUnchanged: true,
          fixtureDatabase: run.fixture.databaseFile,
          captureFile: run.captureFile,
        };
      },
    });
  },
  JOURNEY_BUDGET_MS + 2 * 60_000,
);
