import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  f18ProcessCrashMarker,
  hasExpectedF18ProcessCrash,
  unexpectedF18DaemonErrors,
} from "../support/f18-process-crash-oracle.js";
import {
  archiveProductionFixtureFailure,
  writeProductionFixtureArchiveSkipped,
} from "../support/fixture-failure-evidence.js";
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
} from "../support/public-client.js";
import { removeFunctionalFixtureDirectory } from "../support/schema44-bootstrap.js";
import { makeWorkProvider } from "../support/work-provider.js";

// Bound one complete case, not just fixture setup: three daemon-start paths
// (initial, injected-crash restart, and recovery; the two recovery daemons run
// concurrently), every explicit public wait on the ordinary completion path,
// the frozen 5.5s lease-expiry wait, and 105s for direct commands, SQLite,
// concurrent source-validation coordination, and cleanup.
// Each successful daemon start is bounded by a 60s nonce/listen wait plus a
// 60s HTTP-readiness wait; the injected crash path is conservatively charged
// the same full bound. The 30s diagnostic lead writes a live checkpoint before
// Vitest's outer timeout; afterEach then stops and archives the fixture.
const F18_CASE_BUDGET = {
  initialDaemonNonceAndReadinessMs: 120_000,
  crashBoundaryDaemonStartupMs: 120_000,
  recoveryDaemonsStartupMs: 120_000,
  governancePublicWaitMs: 30_000,
  childWorkPublicWaitMs: 45_000,
  verificationPublicWaitMs: 30_000,
  parentAcceptancePublicWaitMs: 60_000,
  workCompletionPublicWaitMs: 30_000,
  leaseExpiryWaitMs: 5_500,
  fixtureCommandsCoordinationAndCleanupSlackMs: 105_000,
} as const;

const F18_CASE_TIMEOUT_MS =
  F18_CASE_BUDGET.initialDaemonNonceAndReadinessMs +
  F18_CASE_BUDGET.crashBoundaryDaemonStartupMs +
  F18_CASE_BUDGET.recoveryDaemonsStartupMs +
  F18_CASE_BUDGET.governancePublicWaitMs +
  F18_CASE_BUDGET.childWorkPublicWaitMs +
  F18_CASE_BUDGET.verificationPublicWaitMs +
  F18_CASE_BUDGET.parentAcceptancePublicWaitMs +
  F18_CASE_BUDGET.workCompletionPublicWaitMs +
  F18_CASE_BUDGET.leaseExpiryWaitMs +
  F18_CASE_BUDGET.fixtureCommandsCoordinationAndCleanupSlackMs;

interface F18StageRecord {
  readonly name: string;
  readonly startedAt: string;
  readonly startedAtMs: number;
  endedAt?: string;
  elapsedMs?: number;
  outcome: "running" | "passed" | "failed";
  terminalFact?: unknown;
}

interface F18CaseDiagnostics {
  readonly boundary: string;
  readonly marker: string;
  readonly startedAt: string;
  readonly startedAtMs: number;
  readonly timeoutMs: number;
  readonly requestDeadlineAt: number;
  readonly deadlineController: AbortController;
  readonly stages: F18StageRecord[];
  projectId?: string;
  eventSequence?: number;
  fixture?: ProductionFixture;
  terminationCheckpoint?: Record<string, unknown>;
  complete: boolean;
  closed: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

let activeF18Case: F18CaseDiagnostics | undefined;
const fixtures: ProductionFixture[] = [];
const F18_DIAGNOSTIC_LEAD_MS = 30_000;
const F18_PROCESS_CRASH_CASES: ReadonlyArray<{
  readonly boundary: string;
  readonly expectedLeaseGeneration: 0 | 1;
  readonly phase: string | null;
  readonly inboxRows: number;
  readonly completed: boolean;
  readonly attention?: boolean;
}> = [
  {
    boundary: "AfterSourceValidationBeforeClaim",
    expectedLeaseGeneration: 0,
    phase: null,
    inboxRows: 0,
    completed: false,
  },
  {
    boundary: "AfterReconciliationLeaseClaimCommit",
    expectedLeaseGeneration: 1,
    phase: "Pending",
    inboxRows: 0,
    completed: false,
  },
  {
    boundary: "AfterVerificationWakeEffectBeforeDisposition",
    expectedLeaseGeneration: 1,
    phase: "Pending",
    inboxRows: 0,
    completed: false,
  },
  {
    boundary: "AfterVerificationWakeDispositionCommit",
    expectedLeaseGeneration: 1,
    phase: "VerificationWakeDelivered",
    inboxRows: 0,
    completed: false,
  },
  {
    boundary: "BeforeParentInboxDispositionCommit",
    expectedLeaseGeneration: 1,
    phase: "VerificationWakeDelivered",
    inboxRows: 0,
    completed: false,
  },
  {
    boundary: "AfterParentInboxDispositionCommit",
    expectedLeaseGeneration: 1,
    phase: "ParentInboxCommitted",
    inboxRows: 1,
    completed: false,
  },
  {
    boundary: "AfterParentWakeEffectBeforeDisposition",
    expectedLeaseGeneration: 1,
    phase: "ParentInboxCommitted",
    inboxRows: 1,
    completed: false,
  },
  {
    boundary: "AfterParentWakeDispositionCommit",
    expectedLeaseGeneration: 1,
    phase: "ParentWakeDelivered",
    inboxRows: 1,
    completed: false,
  },
  {
    boundary: "BeforeCompletedDispositionCommit",
    expectedLeaseGeneration: 1,
    phase: "ParentWakeDelivered",
    inboxRows: 1,
    completed: false,
  },
  {
    boundary: "AfterCompletedDispositionCommit",
    expectedLeaseGeneration: 1,
    phase: "Completed",
    inboxRows: 1,
    completed: true,
  },
  {
    boundary: "BeforeAttentionCommit",
    expectedLeaseGeneration: 0,
    phase: null,
    inboxRows: 0,
    completed: false,
    attention: true,
  },
  {
    boundary: "AfterAttentionCommit",
    expectedLeaseGeneration: 0,
    phase: "Attention",
    inboxRows: 0,
    completed: false,
    attention: true,
  },
] as const;

const readF18ProgressFacts = (
  fixture: ProductionFixture,
  projectId: string | undefined,
  eventSequence: number | undefined,
): unknown => {
  if (projectId === undefined) return { projectId: null, state: "not-created" };
  const database = new DatabaseSync(fixture.databaseFile, { readOnly: true });
  try {
    database.exec("BEGIN");
    const reconciliations = database
      .prepare(
        `SELECT event_sequence, event_id, verification_id, phase,
                lease_generation, failure_code
           FROM verification_signal_reconciliations
          WHERE project_id = ?
          ORDER BY event_sequence DESC LIMIT 3`,
      )
      .all(projectId);
    const offset = database
      .prepare(
        `SELECT last_sequence FROM consumer_offsets
          WHERE consumer_id = 'workflow-signals' AND project_id = ?`,
      )
      .get(projectId) as { last_sequence: number } | undefined;
    const deadLetter =
      eventSequence === undefined
        ? undefined
        : database
            .prepare(
              `SELECT reason FROM consumer_dead_letters
                WHERE consumer_id = 'workflow-signals' AND project_id = ?
                  AND sequence = ?`,
            )
            .get(projectId, eventSequence);
    const inboxCounts =
      eventSequence === undefined
        ? undefined
        : database
            .prepare(
              `SELECT
                 (SELECT COUNT(*) FROM inbox_entries i
                   JOIN workspaces w ON w.workspace_id = i.workspace_id
                  WHERE w.project_id = ? AND i.entry_key LIKE 'child-result:%') AS inbox_rows,
                 (SELECT COUNT(*) FROM verification_signal_reconciliation_attention_facts
                  WHERE project_id = ? AND event_sequence = ?) AS attention_facts,
                 (SELECT COUNT(*) FROM verification_signal_reconciliation_attention_queue
                  WHERE project_id = ?) AS attention_queue`,
            )
            .get(projectId, projectId, eventSequence, projectId);
    database.exec("COMMIT");
    return {
      projectId,
      eventSequence: eventSequence ?? null,
      reconciliations,
      workflowOffset: offset?.last_sequence ?? null,
      deadLetter: deadLetter ?? null,
      inboxAndAttention: inboxCounts ?? null,
    };
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original diagnostic read failure.
    }
    return {
      projectId,
      eventSequence: eventSequence ?? null,
      snapshotError: error instanceof Error ? error.message : String(error),
    };
  } finally {
    database.close();
  }
};

const writeF18Progress = (
  run: F18CaseDiagnostics,
  event: string,
  extra: Readonly<Record<string, unknown>> = {},
) => {
  if (run.closed) return;
  const fixture = run.fixture;
  if (fixture === undefined) return;
  const now = Date.now();
  const progress = {
    schemaVersion: 1,
    event,
    boundary: run.boundary,
    marker: run.marker,
    startedAt: run.startedAt,
    elapsedMs: now - run.startedAtMs,
    timeoutMs: run.timeoutMs,
    projectId: run.projectId ?? null,
    eventSequence: run.eventSequence ?? null,
    activeStage:
      [...run.stages].reverse().find((stage) => stage.outcome === "running")
        ?.name ?? null,
    stages: run.stages.map((stage) => ({
      ...stage,
      elapsedMs:
        stage.elapsedMs ??
        (stage.outcome === "running" ? now - stage.startedAtMs : undefined),
    })),
    facts: readF18ProgressFacts(fixture, run.projectId, run.eventSequence),
    ...extra,
  };
  writeFileSync(
    join(fixture.directory, "f18-case-progress.json"),
    `${JSON.stringify(progress, null, 2)}\n`,
  );
};

const beginF18Stage = (run: F18CaseDiagnostics, name: string) => {
  if (run.closed) throw new Error("F18 case is already closed");
  const stage: F18StageRecord = {
    name,
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    outcome: "running",
  };
  run.stages.push(stage);
  writeF18Progress(run, "stage-started");
  return stage;
};

const finishF18Stage = (
  run: F18CaseDiagnostics,
  stage: F18StageRecord,
  outcome: "passed" | "failed",
  terminalFact?: unknown,
) => {
  if (run.closed) return;
  stage.outcome = outcome;
  stage.endedAt = new Date().toISOString();
  stage.elapsedMs = Date.now() - stage.startedAtMs;
  if (terminalFact !== undefined) stage.terminalFact = terminalFact;
  writeF18Progress(run, `stage-${outcome}`);
};

const runF18Stage = async <T>(
  run: F18CaseDiagnostics,
  name: string,
  action: () => Promise<T>,
  fact: (value: T) => unknown = (value) => value,
): Promise<T> => {
  if (run.closed) throw new Error("F18 case is already closed");
  const stage = beginF18Stage(run, name);
  try {
    const value = await awaitBeforeF18Deadline(run, action);
    if (run.closed) throw new Error("F18 case closed before stage completion");
    finishF18Stage(run, stage, "passed", fact(value));
    return value;
  } catch (error) {
    if (!run.closed) {
      finishF18Stage(run, stage, "failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
};

const awaitBeforeF18Deadline = async <T>(
  run: F18CaseDiagnostics,
  action: () => Promise<T>,
): Promise<T> => {
  if (run.closed) throw new Error("F18 case is already closed");
  if (Date.now() >= run.requestDeadlineAt) {
    run.deadlineController.abort(
      new Error("F18 case absolute deadline exceeded"),
    );
  }
  const signal = run.deadlineController.signal;
  if (signal.aborted) {
    throw signal.reason ?? new Error("F18 case absolute deadline exceeded");
  }
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    onAbort = () =>
      reject(signal.reason ?? new Error("F18 case absolute deadline exceeded"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const pending = action();
    return await Promise.race([pending, deadline]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
};

const waitForF18Public = async <A>(
  run: F18CaseDiagnostics,
  read: () => Promise<A>,
  predicate: (value: A) => boolean,
  timeoutMs = 30_000,
): Promise<A> => {
  const stageDeadline = Date.now() + timeoutMs;
  const deadline = Math.min(stageDeadline, run.requestDeadlineAt);
  let last: A | undefined;
  while (Date.now() < deadline && !run.closed) {
    try {
      last = await read();
      if (run.closed || Date.now() >= deadline) break;
      if (predicate(last)) return last;
    } catch {
      // Preserve the existing public wait's retry-on-process-race behavior.
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await new Promise((resolveWait) =>
        setTimeout(resolveWait, Math.min(100, remainingMs)),
      );
    }
  }
  if (run.closed) throw new Error("F18 case closed during public wait");
  if (run.requestDeadlineAt <= stageDeadline) {
    throw new Error(
      `F18 case public request deadline exceeded; last=${JSON.stringify(last)}`,
    );
  }
  throw new Error(`public functional timeout; last=${JSON.stringify(last)}`);
};

afterEach(async ({ task }) => {
  const run = activeF18Case;
  if (run?.timer !== undefined) clearTimeout(run.timer);
  const failed = (task.result?.errors?.length ?? 0) > 0;
  if (run !== undefined) {
    const unfinished = run.stages.filter(
      (stage) => stage.outcome === "running",
    );
    for (const stage of unfinished) {
      finishF18Stage(run, stage, failed ? "failed" : "passed", {
        terminal: failed ? "test-failed-before-stage-return" : "stage-returned",
        testErrorCount: task.result?.errors?.length ?? 0,
      });
    }
    if (!run.complete && failed) {
      run.terminationCheckpoint ??= {
        capturedAt: new Date().toISOString(),
        elapsedMs: Date.now() - run.startedAtMs,
        activeStage: null,
        terminal: "test-failed-or-timed-out-before-explicit-completion",
      };
    }
  }
  if (run !== undefined) {
    run.closed = true;
    run.deadlineController.abort(new Error("F18 case closed during cleanup"));
  }
  for (const fixture of fixtures.splice(0)) {
    let stopError: unknown;
    try {
      await fixture.stop();
    } catch (error) {
      stopError = error;
    }
    const currentRun = run;
    if (!failed && stopError === undefined) {
      removeFunctionalFixtureDirectory(fixture.directory);
      continue;
    }
    const resultDirectory = process.env.ARBOR_TEST_RESULT_DIRECTORY;
    const evidence = {
      testName: task.name,
      boundary: currentRun?.boundary ?? "unknown",
      marker: currentRun?.marker ?? null,
      elapsedMs:
        currentRun === undefined ? null : Date.now() - currentRun.startedAtMs,
      timeoutMs: currentRun?.timeoutMs ?? F18_CASE_TIMEOUT_MS,
      projectId: currentRun?.projectId ?? null,
      eventSequence: currentRun?.eventSequence ?? null,
      stages: currentRun?.stages ?? [],
      currentFacts: readF18ProgressFacts(
        fixture,
        currentRun?.projectId,
        currentRun?.eventSequence,
      ),
      terminationCheckpoint: currentRun?.terminationCheckpoint ?? null,
      primaryDaemon: fixture.daemonProcessSnapshot(),
      startupDiagnostics: fixture.startupDiagnostics(),
      daemonErrors: fixture.daemonErrors,
      cleanupError: stopError instanceof Error ? stopError.message : stopError,
    };
    if (resultDirectory === undefined || resultDirectory.length === 0) {
      process.stderr.write(
        `[F18_ARCHIVE_SKIPPED] result directory missing; fixture=${fixture.directory}; database=${fixture.databaseFile}\n`,
      );
    } else {
      try {
        const archivedDirectory = archiveProductionFixtureFailure({
          fixture,
          resultDirectory,
          artifactPrefix: "f18-organization-timeout",
          evidence,
        });
        process.stderr.write(
          `[F18_FAILURE_ARTIFACT] ${JSON.stringify({ boundary: currentRun?.boundary, archivedDirectory })}\n`,
        );
      } catch (archiveError) {
        try {
          const skippedPath = writeProductionFixtureArchiveSkipped({
            fixture,
            resultDirectory,
            evidence: {
              ...evidence,
              archiveError:
                archiveError instanceof Error
                  ? archiveError.message
                  : String(archiveError),
            },
          });
          process.stderr.write(`[F18_ARCHIVE_SKIPPED] ${skippedPath}\n`);
        } catch (skipError) {
          process.stderr.write(
            `[F18_ARCHIVE_SKIPPED] archive=${archiveError instanceof Error ? archiveError.message : String(archiveError)}; skipRecord=${skipError instanceof Error ? skipError.message : String(skipError)}; fixture=${fixture.directory}; database=${fixture.databaseFile}\n`,
          );
        }
      }
    }
  }
  activeF18Case = undefined;
});

const serialized = (call: CapturedProviderCall): string =>
  JSON.stringify(call.messages);

const tools = (call: CapturedProviderCall): ReadonlySet<string> =>
  new Set(
    call.tools
      .map((tool) => tool.function?.name)
      .filter((name): name is string => name !== undefined),
  );

const waitForF18PublicStage = async <T>(
  fixture: ProductionFixture,
  projectId: string,
  stage: string,
  run: () => Promise<T>,
): Promise<T> => {
  const diagnostics = activeF18Case;
  const stageRecord =
    diagnostics === undefined ? undefined : beginF18Stage(diagnostics, stage);
  try {
    const value = await run();
    if (diagnostics?.closed === true) {
      throw new Error("F18 case closed before public stage completion");
    }
    if (diagnostics !== undefined && stageRecord !== undefined) {
      finishF18Stage(diagnostics, stageRecord, "passed", {
        publicStage: stage,
        facts: readF18ProgressFacts(
          fixture,
          projectId,
          diagnostics.eventSequence,
        ),
      });
    }
    return value;
  } catch (error) {
    if (diagnostics?.closed === true) throw error;
    const database = new DatabaseSync(fixture.databaseFile, { readOnly: true });
    let facts: unknown;
    try {
      const reconciliations = database
        .prepare(
          `SELECT event_sequence, phase, lease_generation, failure_code
             FROM verification_signal_reconciliations
            WHERE project_id = ? ORDER BY event_sequence DESC LIMIT 3`,
        )
        .all(projectId);
      const offset = database
        .prepare(
          `SELECT last_sequence FROM consumer_offsets
            WHERE consumer_id = 'workflow-signals' AND project_id = ?`,
        )
        .get(projectId) as { last_sequence: number } | undefined;
      facts = { reconciliations, offset: offset?.last_sequence ?? null };
    } catch {
      facts = { databaseFacts: "unavailable" };
    } finally {
      database.close();
    }
    if (diagnostics !== undefined && stageRecord !== undefined) {
      finishF18Stage(diagnostics, stageRecord, "failed", {
        publicStage: stage,
        error: error instanceof Error ? error.message : String(error),
        facts,
      });
    }
    throw new Error(
      `F18 public wait failed at ${stage}; facts=${JSON.stringify(facts)}`,
      { cause: error },
    );
  }
};

describe("release-functional long-lived responsibility", () => {
  it.each(F18_PROCESS_CRASH_CASES)(
    "F18 reconciles and recovers after $boundary",
    async ({
      boundary,
      expectedLeaseGeneration,
      phase: expectedPhase,
      inboxRows,
      completed: wasCompleted,
      attention = false,
    }) => {
      const marker = `F18-CHILD-${crypto.randomUUID().slice(0, 8)}`;
      const startedAtMs = Date.now();
      const run: F18CaseDiagnostics = {
        boundary,
        marker,
        startedAt: new Date(startedAtMs).toISOString(),
        startedAtMs,
        timeoutMs: F18_CASE_TIMEOUT_MS,
        requestDeadlineAt:
          startedAtMs + F18_CASE_TIMEOUT_MS - F18_DIAGNOSTIC_LEAD_MS,
        deadlineController: new AbortController(),
        stages: [],
        complete: false,
        closed: false,
      };
      activeF18Case = run;
      run.timer = setTimeout(() => {
        run.terminationCheckpoint = {
          capturedAt: new Date().toISOString(),
          elapsedMs: Date.now() - run.startedAtMs,
          activeStage:
            [...run.stages]
              .reverse()
              .find((stage) => stage.outcome === "running")?.name ?? null,
          daemon: run.fixture?.daemonProcessSnapshot() ?? null,
        };
        try {
          writeF18Progress(run, "case-timeout-checkpoint", {
            checkpoint: run.terminationCheckpoint,
          });
          process.stderr.write(
            `[F18_TIMEOUT_CHECKPOINT] ${JSON.stringify(run.terminationCheckpoint)}\n`,
          );
        } catch (error) {
          process.stderr.write(
            `[F18_TIMEOUT_CHECKPOINT_ERROR] ${error instanceof Error ? error.message : String(error)}\n`,
          );
        } finally {
          run.deadlineController.abort(
            new Error("F18 case absolute request deadline reached"),
          );
        }
      }, run.requestDeadlineAt - Date.now());
      let childDirectory = "";
      let allowParentAcceptance = false;
      const childWorkProvider = makeWorkProvider({ marker, verdict: "Pass" });
      const reply = (call: CapturedProviderCall): ScriptedProviderResponse => {
        const available = tools(call);
        const context = serialized(call);
        const readyResultRef = /rref_[a-f0-9]{64}/u.exec(context)?.[0];
        if (
          available.has("accept_result") &&
          readyResultRef !== undefined &&
          allowParentAcceptance
        ) {
          return {
            _tag: "ToolCall",
            name: "accept_result",
            arguments: { resultRef: readyResultRef },
          };
        }
        if (available.has("accept_result") && readyResultRef !== undefined) {
          return {
            _tag: "Text",
            text: "The result is waiting for durable recovery qualification.",
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

      const fixture = await runF18Stage(
        run,
        "fixture-startup",
        () =>
          startProductionFixture({
            isolatedPortHandshake: true,
            admitWorkspaceDirectory: true,
            preserveDirectoryOnStop: true,
            reply,
            daemonEnvironment: {
              NODE_ENV: "test",
              ARBOR_F18_TEST_LEASE_TTL_MS: "5000",
            },
          }),
        (started) => ({
          httpPort: Number(new URL(started.baseUrl).port),
          daemon: started.daemonProcessSnapshot(),
        }),
      );
      run.fixture = fixture;
      fixtures.push(fixture);
      childDirectory = fixture.workspaceDirectory;
      writeF18Progress(run, "fixture-ready");
      const client = makePublicClient(fixture.baseUrl, {
        deadlineAt: run.requestDeadlineAt,
      });
      const project = await runF18Stage(
        run,
        "project-created",
        () =>
          createFunctionalProject(
            client,
            fixture.workspaceDirectory,
            "F18 organization",
            { resourceSelection: "Profile" },
          ),
        (created) => ({
          projectId: created.projectId,
          rootWorkspaceId: created.rootWorkspaceId,
        }),
      );
      run.projectId = project.projectId;
      writeF18Progress(run, "project-created", {
        rootWorkspaceId: project.rootWorkspaceId,
      });

      await runF18Stage(
        run,
        "formation-request-submitted",
        () =>
          submitHumanMessage(
            client,
            project,
            `请为独立长期职责 ${marker} 提议一个子工作区，并附带首个工作。`,
          ),
        () => ({ acceptedByPublicCommand: true }),
      );
      const governance = await waitForF18PublicStage(
        fixture,
        project.projectId,
        "governance-entry",
        () =>
          waitForF18Public(
            run,
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
      await runF18Stage(
        run,
        "formation-approved",
        () =>
          client.command(project.projectId, "RecordDecision", {
            proposalId: target[1],
            expectedProposalRevision: Number(target[2]),
            outcome: { _tag: "Approve" },
          }),
        () => ({ proposalId: target[1], revision: Number(target[2]) }),
      );

      const childWithWork = await waitForF18PublicStage(
        fixture,
        project.projectId,
        "child-work-created",
        () =>
          waitForF18Public(
            run,
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
          ),
      );
      const child = childWithWork.nodes.find(
        (node) => node.parentWorkspaceId === project.rootWorkspaceId,
      );
      const workId = child?.currentWork?.workId;
      if (child === undefined || workId === undefined) {
        throw new Error("child initial Work is not publicly visible");
      }

      const verification = await waitForF18PublicStage(
        fixture,
        project.projectId,
        "initial-verification-snapshot",
        () =>
          waitForF18Public(
            run,
            () =>
              client.view<{
                verdict?: string;
                criteriaResults?: Array<{
                  criterionId: string;
                  requirement: string;
                  required: boolean;
                  verdict: string;
                }>;
              }>("verification", { workId }),
            (value) =>
              value.verdict === "Pass" &&
              value.criteriaResults?.some(
                (result) =>
                  result.criterionId === "functional-criterion" &&
                  result.verdict === "Pass",
              ) === true,
            30_000,
          ),
      );
      expect(verification.verdict).toBe("Pass");
      expect(verification.criteriaResults).toHaveLength(1);
      expect(verification.criteriaResults?.[0]).toMatchObject({
        criterionId: "functional-criterion",
        required: true,
        verdict: "Pass",
      });
      expect(verification.criteriaResults?.[0]?.requirement).toContain(marker);

      await runF18Stage(run, "stop-before-reconciliation-fixture", () =>
        fixture.crash(),
      );
      const database = new DatabaseSync(fixture.databaseFile);
      let eventSequence = 0;
      let inboxKey = "";
      const seedStage = beginF18Stage(run, "seed-dead-letter-and-offset");
      try {
        database.exec("BEGIN IMMEDIATE");
        const event = database
          .prepare(
            `SELECT event_id, sequence, payload_json FROM domain_events
            WHERE project_id = ? AND event_type = 'VerificationConcluded'
            ORDER BY sequence DESC LIMIT 1`,
          )
          .get(project.projectId) as
          | { event_id: string; sequence: number; payload_json: string }
          | undefined;
        if (event === undefined)
          throw new Error("F18 conclusion event missing");
        eventSequence = Number(event.sequence);
        const payload = JSON.parse(event.payload_json) as {
          verificationId: string;
          targetWorkRevision: number;
          [key: string]: unknown;
        };
        const expectedInboxKey = `child-result:${payload.verificationId}:${payload.targetWorkRevision}`;
        inboxKey = expectedInboxKey;
        database
          .prepare(
            `INSERT OR IGNORE INTO consumer_dead_letters
            (consumer_id, project_id, sequence, reason, created_at)
           VALUES ('workflow-signals', ?, ?, 'unsupported eventVersion 2', ?)`,
          )
          .run(project.projectId, eventSequence, new Date().toISOString());
        if (attention) {
          database
            .prepare(
              `UPDATE domain_events SET aggregate_ref = ?
              WHERE project_id = ? AND sequence = ?`,
            )
            .run("ver_f18_wrong_aggregate", project.projectId, eventSequence);
        }
        database
          .prepare(
            `INSERT INTO consumer_offsets
            (consumer_id, project_id, last_sequence, updated_at)
           VALUES ('workflow-signals', ?, ?, ?)
           ON CONFLICT(consumer_id, project_id) DO UPDATE SET
             last_sequence = MAX(consumer_offsets.last_sequence, excluded.last_sequence),
             updated_at = excluded.updated_at`,
          )
          .run(project.projectId, eventSequence, new Date().toISOString());
        database
          .prepare(
            "DELETE FROM inbox_entries WHERE workspace_id = ? AND entry_key = ?",
          )
          .run(project.rootWorkspaceId, expectedInboxKey);
        database.exec("COMMIT");
        run.eventSequence = eventSequence;
        const offset = database
          .prepare(
            `SELECT last_sequence FROM consumer_offsets
            WHERE consumer_id = 'workflow-signals' AND project_id = ?`,
          )
          .get(project.projectId) as { last_sequence: number } | undefined;
        expect(Number(offset?.last_sequence ?? 0)).toBeGreaterThanOrEqual(
          eventSequence,
        );
        finishF18Stage(run, seedStage, "passed", {
          eventSequence,
          inboxKey,
          deadLetterReason: "unsupported eventVersion 2",
          offset: Number(offset?.last_sequence ?? 0),
          attentionCorruption: attention,
        });
      } catch (error) {
        database.exec("ROLLBACK");
        finishF18Stage(run, seedStage, "failed", {
          eventSequence,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        database.close();
      }

      let crashRestartError: unknown;
      const crashStage = beginF18Stage(run, "restart-to-injected-boundary");
      try {
        await awaitBeforeF18Deadline(run, () =>
          fixture.restart({
            daemonEnvironment: {
              NODE_ENV: "test",
              ARBOR_F18_TEST_LEASE_TTL_MS: "5000",
              ARBOR_F18_TEST_CRASH_BOUNDARY: boundary,
            },
          }),
        );
      } catch (error) {
        crashRestartError = error;
      }
      const expectedCrashMarker = f18ProcessCrashMarker({
        boundary,
        projectId: project.projectId,
        eventSequence,
        leaseGeneration: expectedLeaseGeneration,
      });
      const crashProcess = fixture.daemonProcessSnapshot();
      if (
        !(crashRestartError instanceof Error) ||
        !hasExpectedF18ProcessCrash({
          exitCode: crashProcess?.exitCode,
          daemonErrors: fixture.daemonErrors,
          marker: expectedCrashMarker,
        })
      ) {
        finishF18Stage(run, crashStage, "failed", {
          expectedCrashMarker,
          exitCode: crashProcess?.exitCode ?? null,
          error:
            crashRestartError instanceof Error
              ? crashRestartError.message
              : String(crashRestartError),
          facts: readF18ProgressFacts(
            fixture,
            project.projectId,
            eventSequence,
          ),
        });
        const diagnostic = new DatabaseSync(fixture.databaseFile, {
          readOnly: true,
        });
        let reconciliationRows: unknown[] = [];
        try {
          reconciliationRows = diagnostic
            .prepare(
              `SELECT project_id, event_sequence, event_id, verification_id,
                    owner_workspace_id, parent_workspace_id, phase, failure_code
               FROM verification_signal_reconciliations
              WHERE project_id = ? ORDER BY event_sequence`,
            )
            .all(project.projectId);
        } finally {
          diagnostic.close();
        }
        throw new Error(
          `expected exit 86 and exact F18 crash marker ${expectedCrashMarker}; actual=${String(crashRestartError)}; process=${JSON.stringify(crashProcess)}; reconciliation=${JSON.stringify(reconciliationRows)}; daemon=${fixture.daemonErrors.join(" | ")}`,
          { cause: crashRestartError },
        );
      }
      finishF18Stage(run, crashStage, "passed", {
        expectedCrashMarker,
        exitCode: crashProcess?.exitCode ?? null,
        reconciliationFacts: readF18ProgressFacts(
          fixture,
          project.projectId,
          eventSequence,
        ),
      });
      const postCrashFactsStage = beginF18Stage(
        run,
        "post-crash-durable-invariants",
      );
      const afterInboxCommit = new DatabaseSync(fixture.databaseFile, {
        readOnly: true,
      });
      try {
        const phase = afterInboxCommit
          .prepare(
            `SELECT phase, lease_generation FROM verification_signal_reconciliations
            WHERE consumer_id = 'workflow-signals' AND project_id = ?
              AND event_sequence = ?`,
          )
          .get(project.projectId, eventSequence) as
          | { phase: string; lease_generation: number }
          | undefined;
        if (expectedPhase === null) {
          expect(phase).toBeUndefined();
        } else {
          expect(phase?.phase).toBe(expectedPhase);
          expect(phase?.lease_generation).toBe(
            expectedPhase === "Attention" ? 0 : 1,
          );
        }
        const restoredInbox = afterInboxCommit
          .prepare(
            `SELECT consumed_at FROM inbox_entries
            WHERE workspace_id = ? AND entry_key = ?`,
          )
          .get(project.rootWorkspaceId, inboxKey) as
          | { consumed_at: string | null }
          | undefined;
        const deadLetterReason = afterInboxCommit
          .prepare(
            `SELECT reason FROM consumer_dead_letters
            WHERE consumer_id = 'workflow-signals' AND project_id = ?
              AND sequence = ?`,
          )
          .get(project.projectId, eventSequence) as
          | { reason: string }
          | undefined;
        const persistedOffset = afterInboxCommit
          .prepare(
            `SELECT last_sequence FROM consumer_offsets
            WHERE consumer_id = 'workflow-signals' AND project_id = ?`,
          )
          .get(project.projectId) as { last_sequence: number } | undefined;
        const concludedEvents = Number(
          (
            afterInboxCommit
              .prepare(
                `SELECT COUNT(*) AS n FROM domain_events
                WHERE project_id = ? AND event_type = 'VerificationConcluded'`,
              )
              .get(project.projectId) as { n: number }
          ).n,
        );
        expect(restoredInbox === undefined ? 0 : 1).toBe(inboxRows);
        expect(deadLetterReason?.reason).toBe("unsupported eventVersion 2");
        expect(Number(persistedOffset?.last_sequence ?? 0)).toBe(eventSequence);
        expect(concludedEvents).toBe(1);
        const attentionFacts = Number(
          (
            afterInboxCommit
              .prepare(
                `SELECT COUNT(*) AS n
                 FROM verification_signal_reconciliation_attention_facts
                WHERE project_id = ? AND event_sequence = ?`,
              )
              .get(project.projectId, eventSequence) as { n: number }
          ).n,
        );
        const attentionQueue = Number(
          (
            afterInboxCommit
              .prepare(
                `SELECT COUNT(*) AS n
                 FROM verification_signal_reconciliation_attention_queue
                WHERE project_id = ?`,
              )
              .get(project.projectId) as { n: number }
          ).n,
        );
        expect(attentionFacts).toBe(
          attention && boundary === "AfterAttentionCommit" ? 1 : 0,
        );
        expect(attentionQueue).toBe(
          attention && boundary === "AfterAttentionCommit" ? 1 : 0,
        );
        finishF18Stage(run, postCrashFactsStage, "passed", {
          phase: phase?.phase ?? null,
          leaseGeneration: phase?.lease_generation ?? null,
          inboxRows: restoredInbox === undefined ? 0 : 1,
          deadLetterReason: deadLetterReason?.reason ?? null,
          persistedOffset: Number(persistedOffset?.last_sequence ?? 0),
          conclusionEventCount: concludedEvents,
          attentionFacts,
          attentionQueue,
        });
      } finally {
        afterInboxCommit.close();
      }

      if (attention) {
        if (boundary === "BeforeAttentionCommit") {
          await runF18Stage(run, "attention-recovery-restart", () =>
            fixture.restart({
              daemonEnvironment: {
                NODE_ENV: "test",
                ARBOR_F18_TEST_LEASE_TTL_MS: "5000",
                ARBOR_F18_TEST_CRASH_BOUNDARY: "",
              },
            }),
          );
          await waitForF18PublicStage(
            fixture,
            project.projectId,
            "attention-recovery-after-rollback",
            async () =>
              waitForF18Public(
                run,
                async () => {
                  const database = new DatabaseSync(fixture.databaseFile, {
                    readOnly: true,
                  });
                  try {
                    const row = database
                      .prepare(
                        `SELECT phase FROM verification_signal_reconciliations
                        WHERE project_id = ? AND event_sequence = ?`,
                      )
                      .get(project.projectId, eventSequence) as
                      | { phase: string }
                      | undefined;
                    return row?.phase;
                  } finally {
                    database.close();
                  }
                },
                (phase) => phase === "Attention",
                30_000,
              ),
          );
        }
        const attentionRecovery = new DatabaseSync(fixture.databaseFile, {
          readOnly: true,
        });
        try {
          const counts = attentionRecovery
            .prepare(
              `SELECT
               (SELECT COUNT(*) FROM verification_signal_reconciliation_attention_facts
                 WHERE project_id = ? AND event_sequence = ?) AS fact_count,
               (SELECT COUNT(*) FROM verification_signal_reconciliation_attention_queue
                 WHERE project_id = ?) AS queue_count`,
            )
            .get(project.projectId, eventSequence, project.projectId) as {
            fact_count: number;
            queue_count: number;
          };
          expect(counts.fact_count).toBe(1);
          expect(counts.queue_count).toBe(1);
        } finally {
          attentionRecovery.close();
        }
        const attentionTerminalStage = beginF18Stage(
          run,
          "attention-terminal-facts",
        );
        finishF18Stage(run, attentionTerminalStage, "passed", {
          factCount: 1,
          queueCount: 1,
        });
        run.complete = true;
        writeF18Progress(run, "case-completed", {
          terminalFact: "Attention fact and durable queue row both present",
        });
        return;
      }

      await runF18Stage(
        run,
        "lease-expiry-wait",
        () =>
          new Promise<void>((resolveWait) => setTimeout(resolveWait, 5_500)),
        () => ({ elapsedMs: F18_CASE_BUDGET.leaseExpiryWaitMs }),
      );
      allowParentAcceptance = true;
      const barrierDirectory = join(
        fixture.directory,
        "f18-source-validation-barrier",
      );
      mkdirSync(barrierDirectory, { recursive: true });
      const competingEnvironment = {
        NODE_ENV: "test",
        ARBOR_F18_TEST_LEASE_TTL_MS: "5000",
        ARBOR_F18_TEST_CRASH_BOUNDARY: "",
        ARBOR_F18_TEST_BARRIER_DIR: barrierDirectory,
      };
      let additionalDaemon:
        | Awaited<ReturnType<typeof fixture.startAdditionalDaemon>>
        | undefined;
      await runF18Stage(
        run,
        "recovery-restart-and-source-validation-barrier",
        async () => {
          if (wasCompleted) {
            await fixture.restart({ daemonEnvironment: competingEnvironment });
          } else {
            [additionalDaemon] = await Promise.all([
              fixture.startAdditionalDaemon({
                entry: resolve(
                  "tests/functional/support/nonce-daemon-child.mjs",
                ),
                daemonEnvironment: competingEnvironment,
              }),
              fixture.restart({ daemonEnvironment: competingEnvironment }),
            ]);
            expect(
              readdirSync(barrierDirectory).filter((name) =>
                name.startsWith("arrived-"),
              ),
            ).toHaveLength(2);
          }
          return {
            primaryDaemon: fixture.daemonProcessSnapshot(),
            barrierArrivals: readdirSync(barrierDirectory).filter((name) =>
              name.startsWith("arrived-"),
            ).length,
          };
        },
      );
      const recoveredFactsStage = beginF18Stage(
        run,
        "recovered-durable-invariants",
      );
      const competed = new DatabaseSync(fixture.databaseFile, {
        readOnly: true,
      });
      try {
        const phase = competed
          .prepare(
            `SELECT phase, lease_generation FROM verification_signal_reconciliations
            WHERE consumer_id = 'workflow-signals' AND project_id = ?
              AND event_sequence = ?`,
          )
          .get(project.projectId, eventSequence) as
          | { phase: string; lease_generation: number }
          | undefined;
        const inboxCount = Number(
          (
            competed
              .prepare(
                `SELECT COUNT(*) AS n FROM inbox_entries
                WHERE workspace_id = ? AND entry_key = ?`,
              )
              .get(project.rootWorkspaceId, inboxKey) as { n: number }
          ).n,
        );
        const recoveryOffset = competed
          .prepare(
            `SELECT last_sequence FROM consumer_offsets
            WHERE consumer_id = 'workflow-signals' AND project_id = ?`,
          )
          .get(project.projectId) as { last_sequence: number } | undefined;
        const retainedDeadLetter = competed
          .prepare(
            `SELECT reason FROM consumer_dead_letters
            WHERE consumer_id = 'workflow-signals' AND project_id = ?
              AND sequence = ?`,
          )
          .get(project.projectId, eventSequence) as
          | { reason: string }
          | undefined;
        const recoveredConclusionEvents = Number(
          (
            competed
              .prepare(
                `SELECT COUNT(*) AS n FROM domain_events
                WHERE project_id = ? AND event_type = 'VerificationConcluded'`,
              )
              .get(project.projectId) as { n: number }
          ).n,
        );
        expect(phase?.phase).toBe("Completed");
        expect(phase?.lease_generation).toBe(
          wasCompleted ? 1 : expectedPhase === null ? 1 : 2,
        );
        expect(inboxCount).toBe(1);
        expect(Number(recoveryOffset?.last_sequence ?? 0)).toBe(eventSequence);
        expect(retainedDeadLetter?.reason).toBe("unsupported eventVersion 2");
        expect(recoveredConclusionEvents).toBe(1);
        finishF18Stage(run, recoveredFactsStage, "passed", {
          phase: phase?.phase ?? null,
          leaseGeneration: phase?.lease_generation ?? null,
          inboxRows: inboxCount,
          workflowOffset: Number(recoveryOffset?.last_sequence ?? 0),
          deadLetterReason: retainedDeadLetter?.reason ?? null,
          conclusionEventCount: recoveredConclusionEvents,
        });
      } finally {
        competed.close();
      }
      await runF18Stage(run, "stop-competing-daemon", async () => {
        await additionalDaemon?.crash();
        return { stopped: additionalDaemon !== undefined };
      });
      const accepted = await waitForF18PublicStage(
        fixture,
        project.projectId,
        "parent-acceptance",
        () =>
          waitForF18Public(
            run,
            () =>
              client.view<{
                verdict?: string;
                criteriaResults?: Array<{
                  criterionId: string;
                  requirement: string;
                  required: boolean;
                  verdict: string;
                }>;
                acceptance?: { acceptanceId: string };
              }>("verification", { workId }),
            (value) =>
              value.verdict === "Pass" &&
              value.acceptance !== undefined &&
              value.criteriaResults?.some(
                (result) =>
                  result.criterionId === "functional-criterion" &&
                  result.verdict === "Pass",
              ) === true,
            60_000,
          ),
      );
      expect(accepted.acceptance?.acceptanceId).toBeTruthy();
      const completed = await waitForF18PublicStage(
        fixture,
        project.projectId,
        "child-work-completion",
        () =>
          waitForF18Public(
            run,
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
          ),
      );
      expect(
        completed.nodes.find((node) => node.workspaceId === child.workspaceId)
          ?.currentWork,
      ).toBeUndefined();
      expect(
        unexpectedF18DaemonErrors(fixture.daemonErrors, expectedCrashMarker),
      ).toEqual([]);
      run.complete = true;
      writeF18Progress(run, "case-completed", {
        terminalFact:
          "public parent Acceptance and child Work completion observed",
      });
    },
    F18_CASE_TIMEOUT_MS,
  );
});
