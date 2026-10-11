import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";
import {
  AttentionPollStoreLive,
  layer,
  P37_MIGRATIONS,
  runMigrations,
  TransactionPortLive,
} from "../../../adapters/persistence-sqlite/src/index.js";
import {
  type AttentionPollStore,
  TransactionPort,
} from "../../../packages/ports/src/index.js";

type PollClaim =
  | { readonly _tag: "NoClaim" }
  | {
      readonly _tag: "Claimed";
      readonly claim: {
        readonly projectId: string;
        readonly leaseOwner: string;
        readonly leaseGeneration: number;
        readonly attemptSequence: number;
        readonly leaseExpiresAt: string;
      };
    };

interface PollProjectSeed {
  readonly suffix: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly workId: string;
  readonly logicalActionId: string;
  readonly messageId: string;
  readonly factId: string;
  readonly eventId: string;
}

const time = {
  start: "2026-10-11T00:00:00.000Z",
  plus500ms: "2026-10-11T00:00:00.500Z",
  plus1001ms: "2026-10-11T00:00:01.001Z",
  plus1002ms: "2026-10-11T00:00:01.002Z",
  plus1003ms: "2026-10-11T00:00:01.003Z",
  plus2001ms: "2026-10-11T00:00:02.001Z",
  plus2002ms: "2026-10-11T00:00:02.002Z",
  plus2003ms: "2026-10-11T00:00:02.003Z",
  plus3002ms: "2026-10-11T00:00:03.002Z",
  plus3003ms: "2026-10-11T00:00:03.003Z",
  plus3004ms: "2026-10-11T00:00:03.004Z",
  plus3005ms: "2026-10-11T00:00:03.005Z",
} as const;

const makePollApp = (databaseFile: string) => {
  const sqlite = layer({ filename: databaseFile });
  return Layer.mergeAll(
    sqlite,
    Layer.provide(AttentionPollStoreLive, sqlite),
    Layer.provide(TransactionPortLive, sqlite),
  );
};

const runPollDb = <A>(
  databaseFile: string,
  program: Effect.Effect<
    A,
    unknown,
    SqlClient | AttentionPollStore | TransactionPort
  >,
) =>
  Effect.runPromise(
    Effect.scoped(Effect.provide(program, makePollApp(databaseFile))),
  );

const projectSeeds = (
  suffixes: ReadonlyArray<string>,
): ReadonlyArray<PollProjectSeed> =>
  suffixes.map((suffix) => ({
    suffix,
    projectId: `prj_p37_poll_${suffix}`,
    workspaceId: `ws_p37_poll_${suffix}`,
    sessionId: `ses_p37_poll_${suffix}`,
    executionId: `exe_p37_poll_${suffix}`,
    workId: `wrk_p37_poll_${suffix}`,
    logicalActionId: `act_p37_poll_${suffix}`,
    messageId: `msg_p37_poll_${suffix}`,
    factId: `att_p37_poll_${suffix}`,
    eventId: `evt_p37_poll_${suffix}`,
  }));

const seedQueueProjects = (
  suffixes: ReadonlyArray<string>,
  options: {
    readonly expiredProject?: string;
    readonly leaseGeneration?: number;
    readonly nextAttemptSequence?: number;
    readonly leaseExpiresAt?: string;
  } = {},
) => {
  const projects = projectSeeds(suffixes);
  return Effect.gen(function* () {
    yield* runMigrations(P37_MIGRATIONS);
    const tx = yield* TransactionPort;
    const sql = yield* SqlClient;
    yield* tx.transact(
      Effect.gen(function* () {
        for (const project of projects) {
          yield* sql.unsafe(
            `INSERT INTO projects (
              project_id, name, root_workspace_id, project_policy,
              project_policy_revision, default_configuration, environment_ref,
              lifecycle, revision, created_at, updated_at
            ) VALUES (?, ?, ?, '{}', 0, '{}', 'environment:test', 'Open', 0, ?, ?)`,
            [
              project.projectId,
              `P37 ${project.suffix}`,
              project.workspaceId,
              time.start,
              time.start,
            ],
          );
          yield* sql.unsafe(
            `INSERT INTO sessions (
              session_id, binding_kind, workspace_id, execution_id,
              context_epoch, created_at
            ) VALUES (?, 'WorkspacePrimary', ?, NULL, 0, ?)`,
            [project.sessionId, project.workspaceId, time.start],
          );
          yield* sql.unsafe(
            `INSERT INTO workspaces (
              workspace_id, project_id, parent_workspace_id, name,
              responsibility_definition, responsibility_revision,
              resource_boundary, resource_boundary_revision, agent_binding,
              primary_session_id, current_work_id, workspace_policy,
              workspace_policy_revision, revision, lifecycle, created_at, updated_at
            ) VALUES (?, ?, NULL, ?, '{}', 0, '{}', 0, '{}', ?, NULL, '{}', 0, 0, 'Active', ?, ?)`,
            [
              project.workspaceId,
              project.projectId,
              `Root ${project.suffix}`,
              project.sessionId,
              time.start,
              time.start,
            ],
          );
          yield* sql.unsafe(
            `INSERT INTO executions (
              execution_id, project_id, binding_kind, workspace_id,
              episode_kind, episode_ref, episode_revision, parent_execution_id,
              mission, session_id, admitted_at, stop_requested_at,
              settlement_kind, settlement_json, settled_at
            ) VALUES (?, ?, 'workspace', ?, 'WorkEpisode', ?, 0, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL)`,
            [
              project.executionId,
              project.projectId,
              project.workspaceId,
              project.workId,
              project.sessionId,
              time.start,
            ],
          );
          yield* sql.unsafe(
            `INSERT INTO deliver_replay_attention_facts (
              attention_fact_id, event_id, project_id, execution_id,
              target_workspace_id, logical_action_id, message_id,
              failure_code, first_detected_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'LegacyMessageMissingEvent', ?)`,
            [
              project.factId,
              project.eventId,
              project.projectId,
              project.executionId,
              project.workspaceId,
              project.logicalActionId,
              project.messageId,
              time.start,
            ],
          );
          yield* sql.unsafe(
            `INSERT INTO deliver_replay_attention_pending
              (project_id, attention_fact_id, enqueued_at) VALUES (?, ?, ?)`,
            [project.projectId, project.factId, time.start],
          );
          yield* sql.unsafe(
            `INSERT INTO p10_attention_project_poll_state
              (project_id, last_attempt_sequence, consecutive_failed_attempts,
               next_eligible_at, last_failure_code, last_failure_at)
             VALUES (?, 0, 0, ?, NULL, NULL)`,
            [project.projectId, time.start],
          );
        }
        if (options.expiredProject !== undefined) {
          const expired = projects.find(
            (project) => project.suffix === options.expiredProject,
          );
          if (expired === undefined) {
            throw new Error(
              `unknown expired test project ${options.expiredProject}`,
            );
          }
          yield* sql.unsafe(
            `UPDATE p10_attention_dispatch_state
                SET active_project_id = ?, lease_owner = 'expired-owner',
                    lease_generation = ?, claim_started_at = ?, lease_expires_at = ?,
                    next_attempt_sequence = ?
              WHERE singleton = 1`,
            [
              expired.projectId,
              options.leaseGeneration ?? 7,
              time.start,
              options.leaseExpiresAt ?? time.start,
              options.nextAttemptSequence ?? 0,
            ],
          );
        }
      }),
    );
  }).pipe(Effect.map(() => projects));
};

const readDispatch = (databaseFile: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return {
      dispatch: db
        .prepare(
          "SELECT * FROM p10_attention_dispatch_state WHERE singleton = 1",
        )
        .get() as Record<string, unknown>,
      schedules: db
        .prepare(
          "SELECT project_id, last_attempt_sequence, consecutive_failed_attempts, next_eligible_at, last_failure_code, last_failure_at FROM p10_attention_project_poll_state ORDER BY project_id",
        )
        .all() as Array<Record<string, unknown>>,
    };
  } finally {
    db.close();
  }
};

const claimChild = resolve(
  "tests/functional/support/p37-attention-poll-claim-child.mjs",
);
const temporaryDirectories: string[] = [];
const children = new Set<ChildProcess>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
  }
  children.clear();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const startClaimRacerPair = async (
  databaseFile: string,
  gateDirectory: string,
  now: string,
) => {
  const processes = ["poll-daemon-a", "poll-daemon-b"].map((role) => {
    const child = spawn(
      process.execPath,
      [claimChild, databaseFile, role, gateDirectory, now, "leave", "5000"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    children.add(child);
    return { role, child };
  });
  const waitForFile = async (path: string) => {
    const deadline = Date.now() + 30_000;
    while (!existsSync(path)) {
      if (Date.now() >= deadline)
        throw new Error(`claim racer timed out: ${path}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  };
  await Promise.all(
    processes.map(({ role }) =>
      waitForFile(join(gateDirectory, `${role}.ready`)),
    ),
  );
  writeFileSync(join(gateDirectory, "go"), "go", "utf8");
  const results = await Promise.all(
    processes.map(async ({ role, child }) => {
      const outputPath = join(gateDirectory, `${role}.result.json`);
      await waitForFile(outputPath);
      await waitForChildExit(child, role);
      children.delete(child);
      return JSON.parse(readFileSync(outputPath, "utf8")) as PollClaim;
    }),
  );
  return results;
};

const waitForChildExit = (child: ChildProcess, role: string) => {
  return new Promise<void>((resolveExit, rejectExit) => {
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) resolveExit();
      else rejectExit(new Error(`${role} exit code=${code} signal=${signal}`));
    };
    child.once("error", rejectExit);
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      onExit(child.exitCode, child.signalCode);
    }
  });
};

const startClaimWorker = async (
  databaseFile: string,
  gateDirectory: string,
  role: string,
  now: string,
  mode: "leave" | "complete" | "hold",
  leaseTtlMs = 1_000,
) => {
  mkdirSync(gateDirectory, { recursive: true });
  const child = spawn(
    process.execPath,
    [
      claimChild,
      databaseFile,
      role,
      gateDirectory,
      now,
      mode,
      String(leaseTtlMs),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  children.add(child);
  const waitForFile = async (path: string) => {
    const deadline = Date.now() + 30_000;
    while (!existsSync(path)) {
      if (Date.now() >= deadline)
        throw new Error(`poll worker timed out: ${path}`);
      if (child.exitCode !== null) {
        throw new Error(`${role} exited before publishing ${path}`);
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  };
  await waitForFile(join(gateDirectory, `${role}.ready`));
  writeFileSync(join(gateDirectory, "go"), "go", "utf8");
  const resultPath = join(gateDirectory, `${role}.result.json`);
  await waitForFile(resultPath);
  const result = JSON.parse(readFileSync(resultPath, "utf8")) as PollClaim;
  if (mode !== "hold") {
    await waitForChildExit(child, role);
    children.delete(child);
  }
  return { child, result };
};

const killPollWorker = async (child: ChildProcess, role: string) => {
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGKILL");
  await new Promise<void>((resolveExit, rejectExit) => {
    if (child.signalCode !== null || child.exitCode !== null) {
      resolveExit();
      return;
    }
    child.once("error", (error) =>
      rejectExit(new Error(`${role} failed to terminate: ${error.message}`)),
    );
    child.once("exit", (code, signal) => {
      if (code === null && signal !== null) resolveExit();
      else rejectExit(new Error(`${role} did not terminate by process signal`));
    });
  });
  children.delete(child);
};

describe("pending P37 v1.43 Attention fairness and capacity qualification", () => {
  it("continues attempts for healthy B/C while repeatedly expired hot A is backoff-scheduled across app reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "p37-poll-fairness-"));
    temporaryDirectories.push(directory);
    const databaseFile = join(directory, "poll.db");
    const seeded = await runPollDb(
      databaseFile,
      Effect.gen(function* () {
        return yield* seedQueueProjects(["A", "B", "C"]);
      }),
    );
    const projects = seeded as unknown as ReadonlyArray<PollProjectSeed>;
    const projectId = (suffix: string) =>
      projects.find((project) => project.suffix === suffix)?.projectId;
    const gateDirectory = join(directory, "fairness-gates");
    mkdirSync(gateDirectory, { recursive: true });
    const firstCrash = await startClaimWorker(
      databaseFile,
      gateDirectory,
      "hot-a-first",
      time.start,
      "hold",
    );
    expect(firstCrash.result._tag).toBe("Claimed");
    if (firstCrash.result._tag !== "Claimed")
      throw new Error("hot A was not claimed");
    expect(firstCrash.result.claim.projectId).toBe(projectId("A"));
    await killPollWorker(firstCrash.child, "hot-a-first");

    const beforeNoClaim = readDispatch(databaseFile);
    const validLeaseNoClaim = await startClaimWorker(
      databaseFile,
      gateDirectory,
      "valid-lease-observer",
      time.plus500ms,
      "leave",
    );
    expect(validLeaseNoClaim.result).toEqual({ _tag: "NoClaim" });
    expect(readDispatch(databaseFile)).toEqual(beforeNoClaim);

    const afterFirstCrash = await startClaimWorker(
      databaseFile,
      gateDirectory,
      "healthy-b-first",
      time.plus1001ms,
      "complete",
    );
    expect(afterFirstCrash.result._tag).toBe("Claimed");
    if (afterFirstCrash.result._tag !== "Claimed")
      throw new Error("B did not progress after A expired");
    expect(afterFirstCrash.result.claim.projectId).toBe(projectId("B"));

    const healthyC = await startClaimWorker(
      databaseFile,
      gateDirectory,
      "healthy-c-first",
      time.plus1003ms,
      "complete",
    );
    expect(healthyC.result._tag).toBe("Claimed");
    if (healthyC.result._tag !== "Claimed")
      throw new Error("C was not attempted");
    expect(healthyC.result.claim.projectId).toBe(projectId("C"));

    const secondCrash = await startClaimWorker(
      databaseFile,
      gateDirectory,
      "hot-a-second",
      time.plus2001ms,
      "hold",
    );
    expect(secondCrash.result._tag).toBe("Claimed");
    if (secondCrash.result._tag !== "Claimed")
      throw new Error("hot A did not retry");
    expect(secondCrash.result.claim.projectId).toBe(projectId("A"));
    await killPollWorker(secondCrash.child, "hot-a-second");

    const healthyBAfterSecondCrash = await startClaimWorker(
      databaseFile,
      gateDirectory,
      "healthy-b-second",
      time.plus3002ms,
      "complete",
    );
    expect(healthyBAfterSecondCrash.result._tag).toBe("Claimed");
    if (healthyBAfterSecondCrash.result._tag !== "Claimed") {
      throw new Error("healthy B stopped after A's second crash");
    }
    expect(healthyBAfterSecondCrash.result.claim.projectId).toBe(
      projectId("B"),
    );

    const healthyCAfterSecondCrash = await startClaimWorker(
      databaseFile,
      gateDirectory,
      "healthy-c-second",
      time.plus3005ms,
      "complete",
    );
    expect(healthyCAfterSecondCrash.result._tag).toBe("Claimed");
    if (healthyCAfterSecondCrash.result._tag !== "Claimed") {
      throw new Error("healthy C stopped after A's second crash");
    }
    expect(healthyCAfterSecondCrash.result.claim.projectId).toBe(
      projectId("C"),
    );

    const persisted = readDispatch(databaseFile);
    const hotSchedule = persisted.schedules.find(
      (state) => state.project_id === projectId("A"),
    );
    expect(Number(hotSchedule?.consecutive_failed_attempts)).toBe(2);
    expect(hotSchedule?.last_failure_code).toBe("PollLeaseExpired");
    expect(hotSchedule?.next_eligible_at).toBe("2026-10-11T00:00:05.002Z");
  }, 120_000);

  it("has exactly one CAS winner when two OS poll workers race an expired global lease", async () => {
    const directory = mkdtempSync(join(tmpdir(), "p37-poll-cas-"));
    temporaryDirectories.push(directory);
    const databaseFile = join(directory, "poll.db");
    const gateDirectory = join(directory, "race-gates");
    const seeded = await runPollDb(
      databaseFile,
      Effect.gen(function* () {
        return yield* seedQueueProjects(["A", "B", "C"], {
          expiredProject: "A",
          leaseGeneration: 7,
          nextAttemptSequence: 12,
          leaseExpiresAt: time.start,
        });
      }),
    );
    expect(seeded).toHaveLength(3);
    mkdirSync(gateDirectory, { recursive: true });
    const results = await startClaimRacerPair(
      databaseFile,
      gateDirectory,
      time.plus1001ms,
    );
    expect(results.filter((result) => result._tag === "Claimed")).toHaveLength(
      1,
    );
    expect(results.filter((result) => result._tag === "NoClaim")).toHaveLength(
      1,
    );
    const claim = results.find((result) => result._tag === "Claimed");
    expect(claim?._tag).toBe("Claimed");
    const snapshot = readDispatch(databaseFile);
    expect(snapshot.dispatch).toMatchObject({
      lease_generation: 8,
      next_attempt_sequence: 13,
      lease_owner:
        claim?._tag === "Claimed" ? claim.claim.leaseOwner : undefined,
    });
  }, 120_000);

  it("returns non-mutating NoClaim to two independent workers while a valid global lease is held", async () => {
    const directory = mkdtempSync(join(tmpdir(), "p37-poll-no-claim-"));
    temporaryDirectories.push(directory);
    const databaseFile = join(directory, "poll.db");
    const gateDirectory = join(directory, "holder-gates");
    const racedDirectory = join(directory, "observer-gates");
    mkdirSync(racedDirectory, { recursive: true });
    const seeded = await runPollDb(
      databaseFile,
      Effect.gen(function* () {
        return yield* seedQueueProjects(["A", "B", "C"]);
      }),
    );
    expect(seeded).toHaveLength(3);
    const holder = await startClaimWorker(
      databaseFile,
      gateDirectory,
      "lease-holder",
      time.start,
      "hold",
      10_000,
    );
    expect(holder.result._tag).toBe("Claimed");
    const beforeObservers = readDispatch(databaseFile);
    const observerResults = await startClaimRacerPair(
      databaseFile,
      racedDirectory,
      time.plus500ms,
    );
    expect(observerResults).toEqual([{ _tag: "NoClaim" }, { _tag: "NoClaim" }]);
    expect(readDispatch(databaseFile)).toEqual(beforeObservers);
    await killPollWorker(holder.child, "lease-holder");
  }, 120_000);

  describe("pending deployment-profile capacity gate", () => {
    it.todo(
      "requires an owner-selected P37 profileId/profileRevision before measuring max population, poll daemons, backoff and due-healthy fairness",
    );
    it.todo(
      "measures queue INSERT/ACK/requeue counts and same-window rates, burst/drain, depth/age and distinct P1/P10 batch sizes",
    );
    it.todo(
      "measures raw preflight, full poll lock hold, SQLite/P9 writer waits and rebuild at the declared maximum population",
    );
    it.todo(
      "recomputes DeliverReplay Qualified/OutOfEnvelope/InsufficientEvidence and combined SQLiteSufficient only from validated profile evidence",
    );
  });
});

// Evidence selection is a manual deployment gate. The current checked-in
// P12 artifact has only the base four-dimensional envelope; no DeliverReplay
// numeric profile or capacity result is invented by this test source.
void readFileSync;
