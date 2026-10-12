import { TransactionScope } from "@arbor/ports";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { makeRetryVerificationHandler } from "../src/commands/retry-verification.js";

const VER = (tail: string) => `ver_00000000-0000-7000-8000-00000000000${tail}`;
const EXE = (tail: string) => `exe_00000000-0000-7000-8000-00000000000${tail}`;
const WORK = "wrk_00000000-0000-7000-8000-000000000001";
const PROJECT = "prj_00000000-0000-7000-8000-000000000001";
const OWNER = "ws_00000000-0000-7000-8000-000000000001";

const mission = {
  goal: "independently verify the work",
  criteria: [
    {
      criterionId: "proof",
      requirement: "proof.txt is correct",
      required: true,
    },
  ],
  riskRequirements: [],
};

const setup = () => {
  const work = {
    workId: WORK,
    projectId: PROJECT,
    workspaceId: OWNER,
    revision: 1,
    lifecycle: "Open",
  };
  const old = {
    verificationId: VER("1"),
    workId: WORK,
    targetWorkRevision: 1,
    ownerWorkspaceId: OWNER,
    missionSnapshot: mission,
    targetDeliverables: [],
    targetArtifactVersions: [],
    targetEnvironmentRevision: null,
    environmentSnapshotRef: null,
    evidenceRefs: [],
    verificationExecutionIds: [EXE("1")],
    summaryRef: null,
    state: { status: "Open" },
  };
  const execution = {
    executionId: EXE("1"),
    projectId: PROJECT,
    workspaceId: OWNER,
    binding: {
      _tag: "ExecutionBoundAgentBinding",
      parentExecutionId: null,
      mission: "verify",
    },
    sessionId: "ses_00000000-0000-7000-8000-000000000001",
    admittedAt: "2026-10-12T00:00:00.000Z",
    stopRequestedAt: null,
    state: {
      status: "Settled",
      settlement: { _tag: "Completed", result: { _tag: "NoOp" } },
    },
  };
  let stored: typeof old | undefined = old;
  let storedSummary: Uint8Array | undefined;
  const verifications = {
    findById: (id: string) =>
      Effect.succeed(
        stored?.verificationId === id
          ? Option.some(stored as never)
          : Option.none(),
      ),
    findByExecutionId: (id: string) =>
      Effect.succeed(
        stored?.verificationExecutionIds.includes(id as never)
          ? Option.some(stored as never)
          : Option.none(),
      ),
    findOpenByWorkRevision: () =>
      Effect.succeed(
        stored?.state.status === "Open"
          ? Option.some(stored as never)
          : Option.none(),
      ),
    concludeIfOpen: (
      id: string,
      verdict: string,
      summaryRef: string,
      conclusionReason: string,
    ) => {
      if (stored?.verificationId !== id || stored.state.status !== "Open")
        return Effect.succeed(Option.none());
      stored = {
        ...stored,
        summaryRef,
        state: { status: "Concluded", verdict, conclusionReason },
      } as never;
      return Effect.succeed(Option.some(stored as never));
    },
    insert: (
      verification: unknown,
      _projectId: string,
      ownerWorkspaceId: string,
    ) => {
      stored = { ...(verification as typeof old), ownerWorkspaceId };
      return Effect.void;
    },
  };
  const handler = makeRetryVerificationHandler({
    works: {
      findById: () => Effect.succeed(Option.some(work as never)),
    } as never,
    verifications: verifications as never,
    executions: {
      findById: () => Effect.succeed(Option.some(execution as never)),
    } as never,
    projects: {
      findById: () =>
        Effect.succeed(Option.some({ rootWorkspaceId: OWNER } as never)),
    } as never,
    workspaces: {
      findById: () =>
        Effect.succeed(Option.some({ projectId: PROJECT } as never)),
    } as never,
    blobs: {
      put: (bytes: Uint8Array) => {
        storedSummary = bytes.slice();
        return Effect.succeed("blob:summary");
      },
      get: () => Effect.succeed(storedSummary ?? new Uint8Array()),
    } as never,
    governance: { authenticatedHumans: [], directParentOf: [] },
    start: {
      works: { findById: () => Effect.succeed(Option.some(work as never)) },
      verifications,
      environmentRevisions: { current: () => Effect.succeed(Option.none()) },
      deliverables: {
        findById: () => Effect.succeed(Option.none()),
        listArtifacts: () => Effect.succeed([]),
      },
    } as never,
    conclude: {
      verifications,
      evidence: { listByVerification: () => Effect.succeed([]) },
      works: { findById: () => Effect.succeed(Option.some(work as never)) },
    } as never,
  });
  const envelope = {
    commandType: "RetryVerification",
    commandId: "cmd_00000000-0000-7000-8000-000000000001",
    projectId: PROJECT,
    actor: "user:local",
    issuedAt: "2026-10-12T00:00:00.000Z",
    resolvedAuthority: {
      _tag: "RetryVerificationAuthority",
      principal: "user:local",
      commandId: "cmd_00000000-0000-7000-8000-000000000001",
      semanticRequestFingerprint: "fp-retry-test",
      projectId: PROJECT,
      targetWorkspaceId: OWNER,
      currentOwnerId: OWNER,
      workId: WORK,
      expectedWorkRevision: 1,
      verificationId: VER("1"),
      settledVerifierExecutionIds: [EXE("1")],
    },
    payload: {
      workId: WORK,
      verificationId: VER("1"),
      expectedWorkRevision: 1,
      summaryContent: "settled before conclusion",
      successorVerificationId: VER("2"),
      verifierExecutionId: EXE("2"),
    },
  };
  const context = { _tag: "External", principal: "user:local" };
  return { handler, envelope, context, getStored: () => stored };
};

describe("RetryVerification P8 handoff", () => {
  it("concludes the exact orphan and creates the preallocated successor under one handler outcome", async () => {
    const test = setup();
    const response = await Effect.runPromise(
      Effect.provideService(
        test.handler.execute(test.envelope as never, test.context as never),
        TransactionScope,
        { session: { id: "retry-verification-test" } },
      ),
    );
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.value.result).toMatchObject({
      orphanedVerificationId: VER("1"),
      successorVerificationId: VER("2"),
      verifierExecutionId: EXE("2"),
      state: "OrphanedAndRetried",
    });
    expect(response.value.events.map((event) => event.eventType)).toEqual([
      "VerificationConcluded",
      "VerificationStarted",
    ]);
    expect(test.getStored()).toMatchObject({
      verificationId: VER("2"),
      ownerWorkspaceId: OWNER,
      verificationExecutionIds: [EXE("2")],
      state: { status: "Open" },
    });
  });

  it("does not let an Agent or an agent PermissionGrant invoke the human retry face", async () => {
    const test = setup();
    const response = await Effect.runPromise(
      Effect.provideService(
        test.handler.execute(
          test.envelope as never,
          { _tag: "External", principal: "agent:worker" } as never,
        ),
        TransactionScope,
        { session: { id: "retry-verification-test" } },
      ),
    );
    expect(response).toMatchObject({
      ok: false,
      error: { _tag: "AuthorityDenied" },
    });
    expect(test.getStored()).toMatchObject({
      verificationId: VER("1"),
      state: { status: "Open" },
    });
  });
});
