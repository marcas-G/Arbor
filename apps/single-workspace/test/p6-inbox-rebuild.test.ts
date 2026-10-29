import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  linkSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  P39_REPORT_APPLICATION_ID,
  P39_REPORT_USER_VERSION,
  p39WriterLockFilename,
  RetryVerificationOriginRepositoryLive,
  layer as sqliteLayer,
  TransactionPortLive,
} from "@arbor/persistence-sqlite";
import {
  RetryVerificationOriginRepository,
  sha256Hex,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { p39WindowsTestEnvironment } from "../../../tests/support/p39-windows-deployment-test.js";
import {
  createSchema48TestDatabaseFactory,
  type Schema48TestDatabase,
  type Schema48TestDatabaseFactory,
} from "../../../tests/support/schema44-database.js";
import {
  canonicalP6InboxJson,
  deriveTrustedSchema48Signature,
  p6InboxManifestEnvelope,
  p6InboxRebuildUsage,
  parseP6InboxRebuildArguments,
  validateP6InboxManifestText,
} from "../src/p6-inbox-rebuild.js";
import { rejectSqliteArtifactAliases } from "../src/schema-upgrade.js";
import {
  descriptorHashesThrough,
  logicalSqliteDigest,
} from "../src/schema-upgrade-manifest.js";
import { viewQueryFaceWithRetryAvailability } from "../src/transport/composition.js";
import { seedP6InboxRebuildFixture } from "./support/p6-inbox-rebuild-fixture.js";

let schema48Factory: Schema48TestDatabaseFactory | undefined;

beforeAll(async () => {
  schema48Factory = await createSchema48TestDatabaseFactory({
    prefix: "p6-schema48-template-",
  });
}, 120_000);

afterAll(() => schema48Factory?.cleanup(), 120_000);

interface CleanupTreeResult {
  readonly confirmed: boolean;
  readonly attempts: number;
  readonly elapsedMs: number;
  readonly lastTaskkillExit: number | null;
  readonly lastTaskkillError: string | null;
  readonly helperStopped: boolean;
  readonly directExited: boolean;
  readonly rootAlive: boolean;
}

interface TaskkillHelperControl {
  readonly exited: Promise<{
    readonly exitCode: number | null;
    readonly error?: string;
  }>;
  readonly terminate: () => boolean;
}

const cleanupProcessTreeUntilDeadline = async (options: {
  readonly totalDeadlineMs: number;
  readonly retryDelayMs: number;
  readonly now: () => number;
  readonly killTree: (remainingMs: number) => Promise<{
    readonly exitCode: number | null;
    readonly helperStopped: boolean;
    readonly error?: string;
  }>;
  readonly waitForDirectExit: (remainingMs: number) => Promise<boolean>;
  readonly isRootAlive: () => boolean;
  readonly sleep: (durationMs: number) => Promise<void>;
}): Promise<CleanupTreeResult> => {
  const startedAt = options.now();
  const deadline = startedAt + options.totalDeadlineMs;
  let attempts = 0;
  let lastTaskkillExit: number | null = null;
  let lastTaskkillError: string | null = null;
  let helperStopped = true;
  let directExited = false;
  let rootAlive = true;
  while (options.now() < deadline) {
    attempts += 1;
    const remainingForKill = Math.max(0, deadline - options.now());
    const kill = await options.killTree(remainingForKill);
    lastTaskkillExit = kill.exitCode;
    lastTaskkillError = kill.error ?? null;
    helperStopped = kill.helperStopped;
    if (!helperStopped) {
      const remainingForClose = Math.max(0, deadline - options.now());
      if (remainingForClose > 0)
        directExited = await options.waitForDirectExit(remainingForClose);
      rootAlive = options.isRootAlive();
      break;
    }
    const remainingForClose = Math.max(0, deadline - options.now());
    if (remainingForClose > 0)
      directExited = await options.waitForDirectExit(remainingForClose);
    rootAlive = options.isRootAlive();
    if (lastTaskkillExit === 0 && directExited && !rootAlive)
      return {
        confirmed: true,
        attempts,
        elapsedMs: options.now() - startedAt,
        lastTaskkillExit,
        lastTaskkillError,
        helperStopped,
        directExited,
        rootAlive,
      };
    const remainingForRetry = Math.max(0, deadline - options.now());
    if (remainingForRetry > 0)
      await options.sleep(Math.min(options.retryDelayMs, remainingForRetry));
  }
  return {
    confirmed: false,
    attempts,
    elapsedMs: Math.min(options.now() - startedAt, options.totalDeadlineMs),
    lastTaskkillExit,
    lastTaskkillError,
    helperStopped,
    directExited,
    rootAlive,
  };
};

const withTimeout = async <A>(
  promise: Promise<A>,
  timeoutMs: number,
): Promise<
  { readonly timedOut: true } | { readonly timedOut: false; readonly value: A }
> =>
  new Promise((resolveWithTimeout) => {
    const timeout = setTimeout(
      () => resolveWithTimeout({ timedOut: true }),
      timeoutMs,
    );
    void promise.then(
      (value) => {
        clearTimeout(timeout);
        resolveWithTimeout({ timedOut: false, value });
      },
      () => {
        clearTimeout(timeout);
        resolveWithTimeout({ timedOut: true });
      },
    );
  });

const runTaskkillHelperWithTimeout = async (
  helper: TaskkillHelperControl,
  commandDeadlineMs: number,
  terminateDeadlineMs: number,
): Promise<{
  readonly exitCode: number | null;
  readonly helperStopped: boolean;
  readonly error?: string;
}> => {
  const command = await withTimeout(helper.exited, commandDeadlineMs);
  if (!command.timedOut) return { ...command.value, helperStopped: true };
  let terminateRequested = false;
  let terminateError: string | undefined;
  try {
    terminateRequested = helper.terminate();
  } catch (cause) {
    terminateError = String(cause);
  }
  const terminated = await withTimeout(helper.exited, terminateDeadlineMs);
  if (!terminated.timedOut)
    return {
      exitCode: terminated.value.exitCode,
      helperStopped: true,
      error: `taskkill timed out; terminateRequested=${terminateRequested}`,
    };
  return {
    exitCode: null,
    helperStopped: false,
    error:
      `taskkill timeout; terminateRequested=${terminateRequested}` +
      (terminateError === undefined
        ? ""
        : `; terminateError=${terminateError}`),
  };
};

describe("P6 operator subprocess timeout cleanup", () => {
  it("bounds repeated taskkill failures by one total deadline", async () => {
    let fakeNow = 0;
    let attempts = 0;
    const result = await cleanupProcessTreeUntilDeadline({
      totalDeadlineMs: 100,
      retryDelayMs: 10,
      now: () => fakeNow,
      killTree: async (remainingMs) => {
        attempts += 1;
        fakeNow += Math.min(20, remainingMs);
        return {
          exitCode: 1,
          helperStopped: true,
          error: "fake taskkill failure",
        };
      },
      waitForDirectExit: async (remainingMs) => {
        fakeNow += Math.min(20, remainingMs);
        return false;
      },
      isRootAlive: () => true,
      sleep: async (durationMs) => {
        fakeNow += durationMs;
      },
    });
    expect(result.confirmed).toBe(false);
    expect(result.lastTaskkillExit).toBe(1);
    expect(result.lastTaskkillError).toBe("fake taskkill failure");
    expect(result.directExited).toBe(false);
    expect(result.rootAlive).toBe(true);
    expect(result.elapsedMs).toBeLessThanOrEqual(100);
    expect(attempts).toBe(result.attempts);
    expect(attempts).toBeGreaterThan(0);
    expect(attempts).toBeLessThan(10);
  });

  it("does not launch another taskkill while a timed-out helper is still active", async () => {
    let fakeNow = 0;
    let killTreeCalls = 0;
    const result = await cleanupProcessTreeUntilDeadline({
      totalDeadlineMs: 100,
      retryDelayMs: 10,
      now: () => fakeNow,
      killTree: async () => {
        killTreeCalls += 1;
        fakeNow += 10;
        return {
          exitCode: null,
          helperStopped: false,
          error: "fake helper termination was not confirmed",
        };
      },
      waitForDirectExit: async (remainingMs) => {
        fakeNow += remainingMs;
        return false;
      },
      isRootAlive: () => true,
      sleep: async (durationMs) => {
        fakeNow += durationMs;
      },
    });
    expect(result.confirmed).toBe(false);
    expect(result.helperStopped).toBe(false);
    expect(killTreeCalls).toBe(1);
    expect(result.attempts).toBe(1);
  });

  it("terminates a timed-out taskkill helper and waits for its close", async () => {
    let resolveHelperExit:
      | ((value: { exitCode: number | null }) => void)
      | null = null;
    let terminateCalls = 0;
    let helperActive = true;
    const helper: TaskkillHelperControl = {
      exited: new Promise((resolveExit) => {
        resolveHelperExit = resolveExit;
      }),
      terminate: () => {
        terminateCalls += 1;
        helperActive = false;
        resolveHelperExit?.({ exitCode: null });
        return true;
      },
    };
    const result = await runTaskkillHelperWithTimeout(helper, 5, 100);
    expect(terminateCalls).toBe(1);
    expect(helperActive).toBe(false);
    expect(result.helperStopped).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.error).toContain("terminateRequested=true");
  });
});

describe("P6 Inbox operator rebuild CLI contract", () => {
  it("requires explicit absolute database, P39 sidecar and JSONL manifest paths", () => {
    expect(() => parseP6InboxRebuildArguments([])).toThrow(/required/u);
    expect(() =>
      parseP6InboxRebuildArguments([
        "--database",
        "relative.sqlite",
        "--p39-sidecar",
        "C:\\tmp\\p39.sqlite",
        "--manifest",
        "C:\\tmp\\manifest.jsonl",
      ]),
    ).toThrow(/absolute/u);
    expect(
      parseP6InboxRebuildArguments([
        "--database",
        "C:\\tmp\\primary.sqlite",
        "--p39-sidecar",
        "C:\\tmp\\p39.sqlite",
        "--manifest",
        "C:\\tmp\\manifest.jsonl",
      ]),
    ).toMatchObject({ resume: false });
  });

  it("rejects unknown/repeated options and documents the isolated operator-only flags", () => {
    expect(() =>
      parseP6InboxRebuildArguments([
        "--database",
        "C:\\tmp\\primary.sqlite",
        "--database",
        "C:\\tmp\\other.sqlite",
        "--p39-sidecar",
        "C:\\tmp\\p39.sqlite",
        "--manifest",
        "C:\\tmp\\manifest.jsonl",
      ]),
    ).toThrow(/unsupported/u);
    expect(p6InboxRebuildUsage()).toContain("--p39-sidecar");
    expect(p6InboxRebuildUsage()).toContain("--manifest");
  });

  it("derives the exact version-48 schema signature from trusted descriptors", async () => {
    expect(await deriveTrustedSchema48Signature()).toMatch(/^[0-9a-f]{64}$/u);
  }, 120_000);

  it("validates the canonical manifest hash-chain and rejects tamper/torn records", () => {
    const created = p6InboxManifestEnvelope(0, null, {
      kind: "Created",
      schema: "arbor-p6-unbound-legacy-inbox-rebuild-manifest/v1",
      nonce: "a".repeat(64),
      operation: "rebuild-unbound-legacy-inbox-projections",
      schemaVersion: 48,
      schemaSignature: "b".repeat(64),
      descriptors: descriptorHashesThrough(48),
      initialDatabaseDigest: "c".repeat(64),
    });
    const prepared = p6InboxManifestEnvelope(1, created.hash, {
      kind: "Prepared",
      nonce: "a".repeat(64),
      schemaVersion: 48,
      schemaSignature: "b".repeat(64),
      preWriteDatabaseDigest: "c".repeat(64),
      canonicalInputDigest: "d".repeat(64),
      projectionBefore: [],
      projectionBeforeDigest: sha256Hex("[]"),
      operationId: "f".repeat(64),
    });
    const text = `${canonicalP6InboxJson(created)}\n${canonicalP6InboxJson(prepared)}\n`;
    expect(validateP6InboxManifestText(text)).toHaveLength(2);
    expect(() =>
      validateP6InboxManifestText(
        `${text.replace('"kind":"Prepared"', '"kind":"Committed"')}`,
      ),
    ).toThrow(/hash chain/u);
    expect(() => validateP6InboxManifestText(text.slice(0, -1))).toThrow(
      /torn/u,
    );
  });

  it("rejects operator evidence paths aliasing every SQLite protected-file suffix", () => {
    const primary = "C:\\Arbor\\primary.sqlite";
    const reportSidecar = "C:\\Arbor\\p39-report.sqlite";
    for (const suffix of ["-wal", "-shm", "-journal"] as const) {
      expect(() =>
        rejectSqliteArtifactAliases([primary], [`${primary}${suffix}`]),
      ).toThrow(/sidecar/u);
      expect(() =>
        rejectSqliteArtifactAliases(
          [reportSidecar],
          [`${reportSidecar}${suffix}`],
        ),
      ).toThrow(/sidecar/u);
    }
  });

  const repositoryRoot = resolve(
    process.cwd(),
    process
      .cwd()
      .replaceAll("\\", "/")
      .toLowerCase()
      .endsWith("apps/single-workspace")
      ? "../.."
      : ".",
  );
  const productionCli = resolve(
    repositoryRoot,
    "apps/single-workspace/dist/p6-inbox-rebuild.js",
  );
  const processCli = resolve(
    repositoryRoot,
    "apps/single-workspace/test/p6-inbox-rebuild-process-child.mjs",
  );
  const caseTimeoutMs = 105_000;

  interface P6FixtureContext {
    readonly fixture: Schema48TestDatabase;
    readonly manifest: string;
  }

  const withP6Fixture = async (
    run: (context: P6FixtureContext) => Promise<void>,
  ): Promise<void> => {
    if (schema48Factory === undefined)
      throw new Error("P6 schema-48 template was not initialized");
    const fixture = schema48Factory.create();
    seedP6InboxRebuildFixture(fixture.databaseFilename);
    let qualificationFailure: unknown;
    try {
      await run({
        fixture,
        manifest: join(fixture.directory, "p6-rebuild.jsonl"),
      });
    } catch (cause) {
      qualificationFailure = cause;
    }
    let cleanupFailure: unknown;
    try {
      fixture.cleanup();
    } catch (cause) {
      cleanupFailure = cause;
    }
    if (qualificationFailure !== undefined) {
      if (cleanupFailure !== undefined)
        throw new AggregateError(
          [qualificationFailure, cleanupFailure],
          "P6 qualification failed and fixture cleanup also failed",
        );
      throw qualificationFailure;
    }
    if (cleanupFailure !== undefined) throw cleanupFailure;
  };

  const commitInitialProjection = async ({
    fixture,
    manifest,
  }: P6FixtureContext): Promise<string> => {
    const committed = await runOperatorCli(
      processCli,
      fixture.databaseFilename,
      fixture.p39ReportFilename,
      manifest,
      false,
    );
    expect(committed.code, committed.output).toBe(0);
    return readFileSync(manifest, "utf8");
  };

  it(
    "qualifies one production CLI ACL path and resumes database-committed",
    () =>
      withP6Fixture(async ({ fixture, manifest }) => {
        const interrupted = await stopOperatorCliAtBoundary(
          productionCli,
          fixture.databaseFilename,
          fixture.p39ReportFilename,
          manifest,
          "database-committed",
        );
        expect(interrupted.code).not.toBe(0);
        const preparedText = readFileSync(manifest, "utf8");
        expect(
          validateP6InboxManifestText(preparedText).map(
            ({ record }) => record.kind,
          ),
        ).toEqual(["Created", "Prepared"]);
        const readback = new DatabaseSync(fixture.databaseFilename, {
          readOnly: true,
        });
        try {
          expect(
            readback
              .prepare(
                "SELECT workspace_id,kind,summary,correlation_id,admitted_at,consumed_at,revision FROM inbox_entries WHERE entry_key = ?",
              )
              .get(
                "retry-verification-unbound:cmd_018f2b3c-4d5e-7abc-8def-01234567a459",
              ),
          ).toMatchObject({
            workspace_id: "ws_018f2b3c-4d5e-7abc-8def-01234567a457",
            kind: "Governance",
            summary:
              "A historical RetryVerification receipt has incomplete origin evidence.",
            correlation_id: "cmd_018f2b3c-4d5e-7abc-8def-01234567a459",
            admitted_at: "2026-10-18T00:00:00.000Z",
            consumed_at: null,
            revision: 1,
          });
          expect(readback.prepare("PRAGMA foreign_key_check").all()).toEqual(
            [],
          );
        } finally {
          readback.close();
        }
        await assertUnboundLegacyReadSurface(fixture.databaseFilename);
        const resumed = await runOperatorCli(
          processCli,
          fixture.databaseFilename,
          fixture.p39ReportFilename,
          manifest,
          true,
        );
        expect(resumed.code, resumed.output).toBe(0);
        const committedText = readFileSync(manifest, "utf8");
        expect(committedText.startsWith(preparedText)).toBe(true);
        const records = validateP6InboxManifestText(committedText);
        expect(records.map(({ record }) => record.kind)).toEqual([
          "Created",
          "Prepared",
          "Committed",
        ]);
        expect(records[0]?.record.descriptors).toEqual(
          descriptorHashesThrough(48),
        );
        expect(records[1]?.record.canonicalInputDigest).toBe(
          records[2]?.record.canonicalInputDigest,
        );
        expect(records[2]?.record).toMatchObject({
          inserted: 0,
          moved: 0,
          noOp: 1,
        });
      }),
    caseTimeoutMs,
  );

  it(
    "rejects evidence aliases and permits the exact protected app target",
    () =>
      withP6Fixture(async ({ fixture }) => {
        const aliasPath = `${fixture.p39ReportFilename}-journal`;
        const primaryBefore = logicalSqliteDigest(fixture.databaseFilename);
        const reportBefore = logicalSqliteDigest(fixture.p39ReportFilename);
        const alias = await runOperatorCli(
          processCli,
          fixture.databaseFilename,
          fixture.p39ReportFilename,
          aliasPath,
          false,
        );
        expect(alias.code, alias.output).not.toBe(0);
        expect(existsSync(aliasPath)).toBe(false);
        expect(logicalSqliteDigest(fixture.databaseFilename)).toBe(
          primaryBefore,
        );
        expect(logicalSqliteDigest(fixture.p39ReportFilename)).toBe(
          reportBefore,
        );
        const sameTarget = await runOperatorCli(
          processCli,
          fixture.databaseFilename,
          join(fixture.directory, "p6-same-target-report.sqlite"),
          join(fixture.directory, "p6-same-target-application.jsonl"),
          false,
          { ARBOR_DB: fixture.databaseFilename },
        );
        expect(sameTarget.code, sameTarget.output).toBe(0);
      }),
    caseTimeoutMs,
  );

  it(
    "does not let stale prepared route replay undo a later move",
    () =>
      withP6Fixture(async (context) => {
        const { fixture } = context;
        await commitInitialProjection(context);
        const entryKey =
          "retry-verification-unbound:cmd_018f2b3c-4d5e-7abc-8def-01234567a459";
        const moved = new DatabaseSync(fixture.databaseFilename);
        try {
          moved
            .prepare(
              "UPDATE inbox_entries SET workspace_id = 'ws_018f2b3c-4d5e-7abc-8def-01234567a458', revision = 2, updated_at = 'projection-preimage' WHERE entry_key = ?",
            )
            .run(entryKey);
        } finally {
          moved.close();
        }
        const firstManifest = join(
          fixture.directory,
          "p6-first-route-move.jsonl",
        );
        const first = await stopOperatorCliAtBoundary(
          processCli,
          fixture.databaseFilename,
          fixture.p39ReportFilename,
          firstManifest,
          "prepared",
        );
        expect(first.code).not.toBe(0);
        const secondManifest = join(
          fixture.directory,
          "p6-second-route-move.jsonl",
        );
        const second = await runOperatorCli(
          processCli,
          fixture.databaseFilename,
          fixture.p39ReportFilename,
          secondManifest,
          false,
        );
        expect(second.code, second.output).toBe(0);
        expect(
          validateP6InboxManifestText(readFileSync(secondManifest, "utf8"))[2]
            ?.record,
        ).toMatchObject({ inserted: 0, moved: 1, noOp: 0 });
        const after = new DatabaseSync(fixture.databaseFilename, {
          readOnly: true,
        });
        let updatedAt = "";
        try {
          const row = after
            .prepare(
              "SELECT workspace_id,revision,updated_at FROM inbox_entries WHERE entry_key = ?",
            )
            .get(entryKey) as {
            workspace_id: string;
            revision: number;
            updated_at: string;
          };
          expect(row).toMatchObject({
            workspace_id: "ws_018f2b3c-4d5e-7abc-8def-01234567a457",
            revision: 3,
          });
          updatedAt = row.updated_at;
        } finally {
          after.close();
        }
        const digest = logicalSqliteDigest(fixture.databaseFilename);
        const replay = await runOperatorCli(
          processCli,
          fixture.databaseFilename,
          fixture.p39ReportFilename,
          firstManifest,
          true,
        );
        expect(replay.code, replay.output).toBe(0);
        expect(logicalSqliteDigest(fixture.databaseFilename)).toBe(digest);
        const finalRead = new DatabaseSync(fixture.databaseFilename, {
          readOnly: true,
        });
        try {
          expect(
            finalRead
              .prepare(
                "SELECT workspace_id,revision,updated_at FROM inbox_entries WHERE entry_key = ?",
              )
              .get(entryKey),
          ).toEqual({
            workspace_id: "ws_018f2b3c-4d5e-7abc-8def-01234567a457",
            revision: 3,
            updated_at: updatedAt,
          });
        } finally {
          finalRead.close();
        }
        expect(
          validateP6InboxManifestText(readFileSync(firstManifest, "utf8"))[2]
            ?.record,
        ).toMatchObject({ inserted: 0, moved: 0, noOp: 1 });
      }),
    caseTimeoutMs,
  );

  it(
    "fails Created resume on input drift then resumes after restoration",
    () =>
      withP6Fixture(async ({ fixture }) => {
        const manifest = join(fixture.directory, "p6-created-drift.jsonl");
        const stopped = await stopOperatorCliAtBoundary(
          processCli,
          fixture.databaseFilename,
          fixture.p39ReportFilename,
          manifest,
          "created",
        );
        expect(stopped.code).not.toBe(0);
        expect(
          validateP6InboxManifestText(readFileSync(manifest, "utf8")).map(
            ({ record }) => record.kind,
          ),
        ).toEqual(["Created"]);
        const db = new DatabaseSync(fixture.databaseFilename);
        try {
          db.prepare(
            "UPDATE works SET revision=1, updated_at='drift' WHERE work_id='wrk_p6_operator_fixture'",
          ).run();
        } finally {
          db.close();
        }
        const drift = logicalSqliteDigest(fixture.databaseFilename);
        const refused = await runOperatorCli(
          processCli,
          fixture.databaseFilename,
          fixture.p39ReportFilename,
          manifest,
          true,
        );
        expect(refused.code, refused.output).not.toBe(0);
        expect(logicalSqliteDigest(fixture.databaseFilename)).toBe(drift);
        const restore = new DatabaseSync(fixture.databaseFilename);
        try {
          restore
            .prepare(
              "UPDATE works SET revision=0, updated_at='t0' WHERE work_id='wrk_p6_operator_fixture'",
            )
            .run();
        } finally {
          restore.close();
        }
        const resumed = await runOperatorCli(
          processCli,
          fixture.databaseFilename,
          fixture.p39ReportFilename,
          manifest,
          true,
        );
        expect(resumed.code, resumed.output).toBe(0);
      }),
    caseTimeoutMs,
  );

  it(
    "rejects a Created manifest with a changed descriptor prefix",
    () =>
      withP6Fixture(async ({ fixture }) => {
        const manifest = join(fixture.directory, "p6-descriptor-drift.jsonl");
        const stopped = await stopOperatorCliAtBoundary(
          processCli,
          fixture.databaseFilename,
          fixture.p39ReportFilename,
          manifest,
          "created",
        );
        expect(stopped.code).not.toBe(0);
        const created = validateP6InboxManifestText(
          readFileSync(manifest, "utf8"),
        )[0];
        const changed = p6InboxManifestEnvelope(0, null, {
          ...created?.record,
          descriptors: descriptorHashesThrough(48).slice(0, -1),
        });
        writeFileSync(manifest, `${canonicalP6InboxJson(changed)}\n`, {
          flag: "w",
          mode: 0o600,
        });
        const digest = logicalSqliteDigest(fixture.databaseFilename);
        const refused = await runOperatorCli(
          processCli,
          fixture.databaseFilename,
          fixture.p39ReportFilename,
          manifest,
          true,
        );
        expect(refused.code, refused.output).not.toBe(0);
        expect(logicalSqliteDigest(fixture.databaseFilename)).toBe(digest);
      }),
    caseTimeoutMs,
  );

  it(
    "fails Prepared resume on input drift then resumes after restoration",
    () =>
      withP6Fixture(async (context) => {
        const { fixture } = context;
        await commitInitialProjection(context);
        const manifest = join(fixture.directory, "p6-prepared-drift.jsonl");
        const stopped = await stopOperatorCliAtBoundary(
          processCli,
          fixture.databaseFilename,
          fixture.p39ReportFilename,
          manifest,
          "prepared",
        );
        expect(stopped.code).not.toBe(0);
        const db = new DatabaseSync(fixture.databaseFilename);
        try {
          db.prepare(
            "UPDATE works SET revision=1, updated_at='drift' WHERE work_id='wrk_p6_operator_fixture'",
          ).run();
        } finally {
          db.close();
        }
        const drift = logicalSqliteDigest(fixture.databaseFilename);
        const refused = await runOperatorCli(
          processCli,
          fixture.databaseFilename,
          fixture.p39ReportFilename,
          manifest,
          true,
        );
        expect(refused.code, refused.output).not.toBe(0);
        expect(logicalSqliteDigest(fixture.databaseFilename)).toBe(drift);
        const restore = new DatabaseSync(fixture.databaseFilename);
        try {
          restore
            .prepare(
              "UPDATE works SET revision=0, updated_at='t0' WHERE work_id='wrk_p6_operator_fixture'",
            )
            .run();
        } finally {
          restore.close();
        }
        const beforeResume = logicalSqliteDigest(fixture.databaseFilename);
        const resumed = await runOperatorCli(
          processCli,
          fixture.databaseFilename,
          fixture.p39ReportFilename,
          manifest,
          true,
        );
        expect(resumed.code, resumed.output).toBe(0);
        expect(logicalSqliteDigest(fixture.databaseFilename)).toBe(
          beforeResume,
        );
        expect(
          validateP6InboxManifestText(readFileSync(manifest, "utf8")).map(
            ({ record }) => record.kind,
          ),
        ).toEqual(["Created", "Prepared", "Committed"]);
      }),
    caseTimeoutMs,
  );

  it(
    "rejects missing and tampered resume manifests without mutation",
    () =>
      withP6Fixture(async (context) => {
        const { fixture } = context;
        const committed = await commitInitialProjection(context);
        const digest = logicalSqliteDigest(fixture.databaseFilename);
        const missing = await runOperatorCli(
          processCli,
          fixture.databaseFilename,
          fixture.p39ReportFilename,
          join(fixture.directory, "missing.jsonl"),
          true,
        );
        expect(missing.code, missing.output).not.toBe(0);
        const tampered = join(fixture.directory, "tampered.jsonl");
        writeFileSync(
          tampered,
          committed.replace('"kind":"Committed"', '"kind":"Forged"'),
          { flag: "wx", mode: 0o600 },
        );
        const forged = await runOperatorCli(
          processCli,
          fixture.databaseFilename,
          fixture.p39ReportFilename,
          tampered,
          true,
        );
        expect(forged.code, forged.output).not.toBe(0);
        expect(existsSync(tampered)).toBe(true);
        expect(logicalSqliteDigest(fixture.databaseFilename)).toBe(digest);
      }),
    caseTimeoutMs,
  );

  it.each(["schema47", "schema49", "pseudo48"] as const)(
    "rejects the %s migration prefix without evidence mutation",
    (invalidPrefix) =>
      withP6Fixture(async ({ fixture }) => {
        const invalidDatabase = join(
          fixture.directory,
          `${invalidPrefix}.sqlite`,
        );
        copyFileSync(fixture.databaseFilename, invalidDatabase);
        const db = new DatabaseSync(invalidDatabase);
        try {
          if (invalidPrefix === "schema47") db.exec("PRAGMA user_version=47");
          else if (invalidPrefix === "schema49")
            db.exec("PRAGMA user_version=49");
          else db.exec("CREATE TABLE p6_schema_tamper(id TEXT PRIMARY KEY)");
        } finally {
          db.close();
        }
        const before = logicalSqliteDigest(invalidDatabase);
        const manifest = join(fixture.directory, `${invalidPrefix}.jsonl`);
        const refused = await runOperatorCli(
          processCli,
          invalidDatabase,
          fixture.p39ReportFilename,
          manifest,
          false,
        );
        expect(refused.code, refused.output).not.toBe(0);
        expect(existsSync(manifest)).toBe(false);
        expect(logicalSqliteDigest(invalidDatabase)).toBe(before);
      }),
    caseTimeoutMs,
  );

  it(
    "serializes competing rebuild processes through the SQLite writer lock",
    () =>
      withP6Fixture(async ({ fixture }) => {
        await raceOperatorSidecar(
          repositoryRoot,
          processCli,
          fixture.databaseFilename,
          fixture.directory,
        );
      }),
    caseTimeoutMs,
  );

  it(
    "rolls back all Inbox rows when a later candidate fails",
    () =>
      withP6Fixture(async ({ fixture }) => {
        seedFailAfterFirstCandidate(fixture.databaseFilename);
        const before = logicalSqliteDigest(fixture.databaseFilename);
        const manifest = join(fixture.directory, "p6-rollback.jsonl");
        const result = await runOperatorCli(
          processCli,
          fixture.databaseFilename,
          fixture.p39ReportFilename,
          manifest,
          false,
        );
        expect(result.code, result.output).not.toBe(0);
        expect(logicalSqliteDigest(fixture.databaseFilename)).toBe(before);
        expect(
          validateP6InboxManifestText(readFileSync(manifest, "utf8")).map(
            ({ record }) => record.kind,
          ),
        ).toEqual(["Created", "Prepared"]);
        const db = new DatabaseSync(fixture.databaseFilename, {
          readOnly: true,
        });
        try {
          expect(
            db
              .prepare(
                "SELECT entry_key FROM inbox_entries WHERE entry_key LIKE 'retry-verification-unbound:%'",
              )
              .all(),
          ).toEqual([]);
        } finally {
          db.close();
        }
      }),
    caseTimeoutMs,
  );

  it(
    "rejects protected app, WAL and hard-link evidence aliases",
    () =>
      withP6Fixture(async (context) => {
        const { fixture } = context;
        await commitInitialProjection(context);
        const protectedApp = join(
          fixture.directory,
          "protected-empty-application.sqlite",
        );
        new DatabaseSync(protectedApp).close();
        const appDigest = logicalSqliteDigest(protectedApp);
        const appManifest = join(fixture.directory, "p6-protected-app.jsonl");
        const appAlias = await runOperatorCli(
          processCli,
          fixture.databaseFilename,
          protectedApp,
          appManifest,
          false,
          { ARBOR_DB: protectedApp },
        );
        expect(appAlias.code, appAlias.output).not.toBe(0);
        expect(existsSync(appManifest)).toBe(false);
        expect(logicalSqliteDigest(protectedApp)).toBe(appDigest);
        const protectedWal = join(
          fixture.directory,
          "protected-wal-application.sqlite",
        );
        const walDb = new DatabaseSync(protectedWal);
        try {
          walDb.exec(
            "PRAGMA journal_mode=WAL; CREATE TABLE protected_data(value TEXT)",
          );
          walDb
            .prepare("INSERT INTO protected_data VALUES ('protected')")
            .run();
          const digest = logicalSqliteDigest(protectedWal);
          const walManifest = join(fixture.directory, "p6-protected-wal.jsonl");
          const walAlias = await runOperatorCli(
            processCli,
            fixture.databaseFilename,
            `${protectedWal}-wal`,
            walManifest,
            false,
            { ARBOR_DB: protectedWal },
          );
          expect(walAlias.code, walAlias.output).not.toBe(0);
          expect(existsSync(walManifest)).toBe(false);
          expect(logicalSqliteDigest(protectedWal)).toBe(digest);
          const hardlink = join(fixture.directory, "p6-wal-hardlink.sqlite");
          linkSync(`${protectedWal}-wal`, hardlink);
          try {
            const hardlinkManifest = join(
              fixture.directory,
              "p6-wal-hardlink.jsonl",
            );
            const hardlinkAlias = await runOperatorCli(
              processCli,
              fixture.databaseFilename,
              hardlink,
              hardlinkManifest,
              false,
              { ARBOR_DB: protectedWal },
            );
            expect(hardlinkAlias.code, hardlinkAlias.output).not.toBe(0);
            expect(existsSync(hardlinkManifest)).toBe(false);
          } finally {
            if (existsSync(hardlink)) unlinkSync(hardlink);
          }
        } finally {
          walDb.close();
        }
      }),
    caseTimeoutMs,
  );

  it(
    "rejects the exact writer-lock file as an evidence sidecar",
    () =>
      withP6Fixture(async (context) => {
        const { fixture } = context;
        await commitInitialProjection(context);
        const stat = statSync(fixture.databaseFilename, { bigint: true });
        const lock = join(
          fixture.directory,
          ".arbor-p39-writer-" +
            sha256Hex(`${String(stat.dev)}:${String(stat.ino)}`) +
            ".sqlite",
        );
        expect(existsSync(lock)).toBe(true);
        const before = logicalSqliteDigest(fixture.databaseFilename);
        const manifest = join(fixture.directory, "p6-writer-lock-alias.jsonl");
        const alias = await runOperatorCli(
          processCli,
          fixture.databaseFilename,
          lock,
          manifest,
          false,
        );
        expect(alias.code, alias.output).not.toBe(0);
        expect(existsSync(manifest)).toBe(false);
        expect(logicalSqliteDigest(fixture.databaseFilename)).toBe(before);
      }),
    caseTimeoutMs,
  );

  it(
    "refuses while another process owns the writer lock",
    () =>
      withP6Fixture(async (context) => {
        const { fixture } = context;
        await commitInitialProjection(context);
        const stat = statSync(fixture.databaseFilename, { bigint: true });
        const lock = join(
          fixture.directory,
          ".arbor-p39-writer-" +
            sha256Hex(`${String(stat.dev)}:${String(stat.ino)}`) +
            ".sqlite",
        );
        const holder = spawn(
          process.execPath,
          [
            join(
              repositoryRoot,
              "apps/single-workspace/test/p6-writer-lock-holder.mjs",
            ),
            lock,
          ],
          {
            cwd: repositoryRoot,
            windowsHide: true,
            env: {
              ...p39WindowsTestEnvironment(),
              ARBOR_P6_LOCK_DIAGNOSTIC: join(
                fixture.directory,
                "lock-holder-diagnostic.txt",
              ),
            },
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        let output = "";
        holder.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          output += chunk;
        });
        holder.stderr.setEncoding("utf8").on("data", (chunk: string) => {
          output += chunk;
        });
        const closed = new Promise<number | null>((resolveClose) =>
          holder.once("close", resolveClose),
        );
        try {
          await waitForOutput(holder, "READY\n", 30_000);
          const before = logicalSqliteDigest(fixture.databaseFilename);
          const manifest = join(fixture.directory, "p6-shared-refused.jsonl");
          const refused = await runOperatorCli(
            processCli,
            fixture.databaseFilename,
            fixture.p39ReportFilename,
            manifest,
            false,
            { ARBOR_P6_TEST_LOCK_BUSY_TIMEOUT_MS: "3000" },
          );
          expect(refused.code, refused.output).not.toBe(0);
          expect(existsSync(manifest)).toBe(false);
          expect(logicalSqliteDigest(fixture.databaseFilename)).toBe(before);
        } finally {
          if (holder.exitCode === null && holder.stdin.writable)
            holder.stdin.end("release\n");
        }
        expect(await closed, output).toBe(0);
      }),
    caseTimeoutMs,
  );
});

const runOperatorCli = async (
  cli: string,
  database: string,
  p39Sidecar: string,
  manifest: string,
  resume: boolean,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ readonly code: number | null; readonly output: string }> => {
  const args = [
    cli,
    "--database",
    database,
    "--p39-sidecar",
    p39Sidecar,
    "--manifest",
    manifest,
  ];
  if (resume) args.push("--resume");
  return new Promise((resolveRun, reject) => {
    const startedAt = Date.now();
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => key.toLowerCase() !== "psmodulepath",
      ),
    ) as NodeJS.ProcessEnv;
    const systemRoot = env.WINDIR ?? env.SystemRoot ?? "C:\\Windows";
    env.PSModulePath = join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "Modules",
    );
    Object.assign(env, extraEnv);
    const processChild = spawn(process.execPath, args, {
      cwd: process.cwd(),
      windowsHide: true,
      env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    processChild.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    processChild.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const childClosed = new Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }>((resolveClosed) =>
      processChild.once("close", (code, signal) =>
        resolveClosed({ code, signal }),
      ),
    );
    const timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      const pid = processChild.pid;
      void (async () => {
        const cleanupStartedAt = performance.now();
        const cleanup = await cleanupProcessTreeUntilDeadline({
          totalDeadlineMs: 30_000,
          retryDelayMs: 250,
          now: () => performance.now(),
          killTree: async (remainingMs) => {
            if (pid === undefined)
              return {
                exitCode: null,
                helperStopped: true,
                error: "child PID unavailable",
              };
            if (process.platform !== "win32") {
              const killed = processChild.kill("SIGTERM");
              return killed
                ? { exitCode: 0, helperStopped: true }
                : {
                    exitCode: null,
                    helperStopped: true,
                    error: "SIGTERM request failed",
                  };
            }
            if (remainingMs < 2)
              return {
                exitCode: null,
                helperStopped: true,
                error: "cleanup budget exhausted before taskkill could run",
              };
            const treeKill = spawn(
              "taskkill.exe",
              ["/PID", String(pid), "/T", "/F"],
              { windowsHide: true, stdio: "ignore" },
            );
            let spawnError: string | undefined;
            const helper: TaskkillHelperControl = {
              exited: new Promise((resolveExit) => {
                treeKill.once("close", (code) =>
                  resolveExit({
                    exitCode: code,
                    ...(spawnError === undefined ? {} : { error: spawnError }),
                  }),
                );
                treeKill.once("error", (cause) => {
                  spawnError = `taskkill spawn failed: ${String(cause)}`;
                });
              }),
              terminate: () => treeKill.kill("SIGTERM"),
            };
            const commandDeadlineMs = Math.max(
              1,
              Math.floor(remainingMs * 0.6),
            );
            const terminateDeadlineMs = Math.max(
              1,
              remainingMs - commandDeadlineMs,
            );
            return runTaskkillHelperWithTimeout(
              helper,
              commandDeadlineMs,
              terminateDeadlineMs,
            );
          },
          waitForDirectExit: async (remainingMs) => {
            const result = await withTimeout(childClosed, remainingMs);
            return !result.timedOut;
          },
          isRootAlive: () => {
            if (pid === undefined) return true;
            try {
              process.kill(pid, 0);
              return true;
            } catch (cause) {
              const code =
                typeof cause === "object" && cause !== null && "code" in cause
                  ? String((cause as { code?: unknown }).code)
                  : "unknown";
              return code !== "ESRCH" && code !== "EINVAL";
            }
          },
          sleep: (durationMs) =>
            new Promise((resolveSleep) => setTimeout(resolveSleep, durationMs)),
        });
        settled = true;
        clearTimeout(timeout);
        reject(
          new Error(
            `P6 CLI timeout pid=${pid ?? "unknown"} elapsedMs=${Date.now() - startedAt} ` +
              `cleanupMs=${Math.round(performance.now() - cleanupStartedAt)} ` +
              `cleanupConfirmed=${cleanup.confirmed} attempts=${cleanup.attempts} ` +
              `taskkillHelperStopped=${cleanup.helperStopped} ` +
              `lastTaskkillExit=${cleanup.lastTaskkillExit ?? "null"} ` +
              `lastTaskkillError=${cleanup.lastTaskkillError ?? "none"} ` +
              `directExited=${cleanup.directExited} rootAlive=${cleanup.rootAlive} ` +
              `stdout=${stdout.slice(-4000)} stderr=${stderr.slice(-4000)}`,
          ),
        );
      })();
    }, 180_000);
    timeout.unref();
    processChild.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    void childClosed.then(({ code, signal }) => {
      if (settled || timedOut) return;
      settled = true;
      clearTimeout(timeout);
      resolveRun({
        code,
        output: `signal=${signal ?? "null"} stdout=${stdout} stderr=${stderr}`,
      });
    });
  });
};

const stopOperatorCliAtBoundary = async (
  cli: string,
  database: string,
  p39Sidecar: string,
  manifest: string,
  boundary: "created" | "prepared" | "database-committed",
): Promise<{ readonly code: number | null; readonly output: string }> => {
  const args = [
    cli,
    "--database",
    database,
    "--p39-sidecar",
    p39Sidecar,
    "--manifest",
    manifest,
  ];
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key.toLowerCase() !== "psmodulepath",
    ),
  ) as NodeJS.ProcessEnv;
  const systemRoot = env.WINDIR ?? env.SystemRoot ?? "C:\\Windows";
  env.PSModulePath = join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "Modules",
  );
  env.NODE_ENV = "test";
  env.ARBOR_P6_TEST_HOLD_BOUNDARY = boundary;
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    windowsHide: true,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
  });
  const closed = new Promise<number | null>((resolveClose) =>
    child.once("close", resolveClose),
  );
  try {
    await waitForOutput(
      child,
      `P6_REBUILD_TEST_BOUNDARY:${boundary}\n`,
      120_000,
    );
  } catch (cause) {
    throw new Error(`${String(cause)} ${output}`);
  }
  child.kill();
  return { code: await closed, output };
};

const startOperatorCliPausedAtP39 = async (
  repositoryRoot: string,
  cli: string,
  database: string,
  p39Sidecar: string,
  manifest: string,
): Promise<{
  readonly child: ChildProcessWithoutNullStreams;
  readonly close: Promise<number | null>;
  readonly getOutput: () => string;
}> => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key.toLowerCase() !== "psmodulepath",
    ),
  ) as NodeJS.ProcessEnv;
  const systemRoot = env.WINDIR ?? env.SystemRoot ?? "C:\\Windows";
  env.PSModulePath = join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "Modules",
  );
  env.NODE_ENV = "test";
  env.ARBOR_P6_TEST_HOLD_BOUNDARY = "before-p39";
  const child = spawn(
    process.execPath,
    [
      cli,
      "--database",
      database,
      "--p39-sidecar",
      p39Sidecar,
      "--manifest",
      manifest,
    ],
    {
      cwd: repositoryRoot,
      windowsHide: true,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
  });
  const close = new Promise<number | null>((resolveClose) =>
    child.once("close", resolveClose),
  );
  try {
    await waitForOutput(
      child,
      "P6_REBUILD_TEST_BOUNDARY:before-p39\n",
      120_000,
    );
  } catch (cause) {
    throw new Error(`${String(cause)} ${output}`);
  }
  return { child, close, getOutput: () => output };
};

const raceOperatorSidecar = async (
  repositoryRoot: string,
  cli: string,
  database: string,
  directory: string,
): Promise<void> => {
  const racedSidecar = join(directory, "p6-raced-report.sqlite");
  const racedManifest = join(directory, "p6-raced.jsonl");
  const racers = await Promise.all([
    startOperatorCliPausedAtP39(
      repositoryRoot,
      cli,
      database,
      racedSidecar,
      racedManifest,
    ),
    startOperatorCliPausedAtP39(
      repositoryRoot,
      cli,
      database,
      racedSidecar,
      racedManifest,
    ),
  ]);
  const racerOne = racers[0];
  const racerTwo = racers[1];
  if (racerOne === undefined || racerTwo === undefined)
    throw new Error("both P6 race processes must be started");
  racerOne.child.stdin.end("release\n");
  racerTwo.child.stdin.end("release\n");
  const raceResults = await Promise.all(
    racers.map(async ({ close, getOutput }) => ({
      code: await close,
      output: getOutput(),
    })),
  );
  expect(
    raceResults.filter(({ code }) => code === 0),
    JSON.stringify(raceResults),
  ).toHaveLength(1);
  expect(
    raceResults.filter(({ code }) => code !== 0),
    JSON.stringify(raceResults),
  ).toHaveLength(1);
  expect(
    validateP6InboxManifestText(readFileSync(racedManifest, "utf8")).map(
      ({ record }) => record.kind,
    ),
  ).toEqual(["Created", "Prepared", "Committed"]);
  const racedReport = new DatabaseSync(racedSidecar, { readOnly: true });
  try {
    expect(
      (
        racedReport.prepare("PRAGMA application_id").get() as {
          application_id: number;
        }
      ).application_id,
    ).toBe(P39_REPORT_APPLICATION_ID);
    expect(
      (
        racedReport.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }
      ).user_version,
    ).toBe(P39_REPORT_USER_VERSION);
    expect(
      (
        racedReport
          .prepare("SELECT COUNT(*) AS count FROM p39_migration_block_reports")
          .get() as { count: number }
      ).count,
    ).toBe(0);
  } finally {
    racedReport.close();
  }
};

const waitForOutput = (
  child: ChildProcessWithoutNullStreams,
  marker: string,
  timeoutMs: number,
): Promise<void> =>
  new Promise((resolveMarker, reject) => {
    let text = "";
    const timeout = setTimeout(
      () => reject(new Error("P39 lock holder did not become ready")),
      timeoutMs,
    );
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      text += chunk;
      if (text.includes(marker)) {
        clearTimeout(timeout);
        resolveMarker();
      }
    });
    child.once("error", (cause) => {
      clearTimeout(timeout);
      reject(cause);
    });
    child.once("close", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        reject(
          new Error(
            `P39 lock holder exited before readiness (${code}): ${text}`,
          ),
        );
      }
    });
  });

export const qualifySidecarCrashRestart = async (
  repositoryRoot: string,
  cli: string,
  database: string,
  existingP39Sidecar: string,
  directory: string,
): Promise<void> => {
  const cases = [
    ["writer-lock-initialized-before-permit", "initialized"],
    ["report-initial-file-identity", "empty"],
    ["report-profile-init-transaction-open", "pristine"],
    ["report-profile-init-before-commit", "pristine"],
    ["report-profile-init-commit-complete", "initialized"],
    ["report-final-path-and-identity", "initialized"],
  ] as const;
  for (const [phase, state] of cases) {
    const sidecar = join(directory, `p6-sidecar-${phase}.sqlite`);
    const manifest = join(directory, `p6-sidecar-${phase}.jsonl`);
    const primaryBefore = logicalSqliteDigest(database);
    const crashed = await crashOperatorCliAtP39Phase(
      repositoryRoot,
      cli,
      database,
      sidecar,
      manifest,
      phase,
    );
    expect(
      crashed.signal === "SIGTERM" ||
        (crashed.code === 1 &&
          crashed.output.includes(`P6_P39_TEST_CRASH_PHASE:${phase}\n`)),
      `${phase} code=${crashed.code} signal=${crashed.signal}: ${crashed.output}`,
    ).toBe(true);
    expect(existsSync(manifest)).toBe(false);
    expect(logicalSqliteDigest(database)).toBe(primaryBefore);
    if (state === "empty") {
      expect(statSync(sidecar).size).toBe(0);
    } else {
      const sidecarDb = new DatabaseSync(sidecar, { readOnly: true });
      try {
        const applicationId = (
          sidecarDb.prepare("PRAGMA application_id").get() as {
            application_id: number;
          }
        ).application_id;
        const userVersion = (
          sidecarDb.prepare("PRAGMA user_version").get() as {
            user_version: number;
          }
        ).user_version;
        if (state === "pristine") {
          expect(applicationId).toBe(0);
          expect(userVersion).toBe(0);
          expect(
            sidecarDb
              .prepare(
                "SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
              )
              .all(),
          ).toEqual([]);
        } else {
          expect(applicationId).toBe(P39_REPORT_APPLICATION_ID);
          expect(userVersion).toBe(P39_REPORT_USER_VERSION);
          expect(
            (
              sidecarDb
                .prepare(
                  "SELECT COUNT(*) AS count FROM p39_migration_block_reports",
                )
                .get() as { count: number }
            ).count,
          ).toBe(0);
        }
      } finally {
        sidecarDb.close();
      }
    }
    if (phase === "writer-lock-initialized-before-permit") {
      const lockPath = p39WriterLockFilename(database);
      expect(typeof lockPath).toBe("string");
      if (typeof lockPath !== "string")
        throw new Error("P39 writer-lock path was unavailable after crash");
      const lockDb = new DatabaseSync(lockPath, { readOnly: true });
      try {
        expect(
          lockDb
            .prepare("SELECT lock_id FROM p39_writer_lock WHERE lock_id = 1")
            .all(),
        ).toEqual([{ lock_id: 1 }]);
      } finally {
        lockDb.close();
      }
    }
    const retry = await runOperatorCli(cli, database, sidecar, manifest, false);
    expect(retry.code, `${phase}: ${retry.output}`).toBe(0);
    expect(
      validateP6InboxManifestText(readFileSync(manifest, "utf8")).map(
        ({ record }) => record.kind,
      ),
    ).toEqual(["Created", "Prepared", "Committed"]);
  }
  expect(existsSync(existingP39Sidecar)).toBe(true);
};

export const crashOperatorCliAtP39Phase = async (
  repositoryRoot: string,
  cli: string,
  database: string,
  sidecar: string,
  manifest: string,
  phase: string,
): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly output: string;
}> => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key.toLowerCase() !== "psmodulepath",
    ),
  ) as NodeJS.ProcessEnv;
  const systemRoot = env.WINDIR ?? env.SystemRoot ?? "C:\\Windows";
  env.PSModulePath = join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "Modules",
  );
  env.NODE_ENV = "test";
  env.ARBOR_P6_TEST_CRASH_P39_PHASE = phase;
  const child = spawn(
    process.execPath,
    [
      cli,
      "--database",
      database,
      "--p39-sidecar",
      sidecar,
      "--manifest",
      manifest,
    ],
    {
      cwd: repositoryRoot,
      windowsHide: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
  });
  const closed = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolveClose) =>
    child.once("close", (code, signal) => resolveClose({ code, signal })),
  );
  const result = await closed;
  return { code: result.code, signal: result.signal, output };
};

const seedFailAfterFirstCandidate = (databaseFilename: string): void => {
  const db = new DatabaseSync(databaseFilename);
  try {
    db.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
    db.prepare("DELETE FROM inbox_entries WHERE entry_key = ?").run(
      "retry-verification-unbound:cmd_018f2b3c-4d5e-7abc-8def-01234567a459",
    );
    db.prepare(
      `INSERT INTO works (
        work_id,project_id,workspace_id,objective,why,constraints,
        completion_expectation,verification_mission,provenance,lifecycle,
        revision,created_at,updated_at
      ) VALUES ('wrk_p6_operator_bad',?,'ws_018f2b3c-4d5e-7abc-8def-01234567a458',
        'legacy bad','legacy bad','[]','legacy','{}','{}','Open',0,'t0','t0')`,
    ).run("prj_p6_operator_fixture");
    db.prepare(
      `INSERT INTO verifications (
        verification_id,project_id,work_id,target_work_revision,owner_workspace_id,
        mission_snapshot,target_deliverables,target_artifact_versions,
        target_environment_revision,environment_snapshot_ref,
        verification_execution_ids,state,verdict,conclusion_reason,created_at,
        updated_at,summary_ref,criteria_results,snapshot_status
      ) VALUES ('ver_p6_operator_bad','prj_p6_operator_fixture','wrk_p6_operator_bad',
        0,'ws_018f2b3c-4d5e-7abc-8def-01234567a458','{}','[]','[]',NULL,NULL,
        '[]','Concluded','Unknown','Orphaned','t0','t0','blob:p6-operator-bad',
        '[]','NotApplicableOrphaned')`,
    ).run();
    db.prepare(
      `INSERT INTO commands (
        command_id,project_id,semantic_request_fingerprint,schema_version,
        fingerprint_algorithm_version,resolution,result_json,terminal_error_json,
        created_at,settled_at
      ) VALUES ('cmd_018f2b3c-4d5e-7abc-8def-01234567a460',
        'prj_p6_operator_fixture','fp:cmd_018f2b3c-4d5e-7abc-8def-01234567a460',
        '1',1,'Committed','{}',NULL,'2026-10-18T00:00:00.000Z',
        '2026-10-18T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO retry_verification_legacy_dispositions (
        command_id,project_id,source_work_id,source_verification_id,
        disposition,reason_code,created_at
      ) VALUES ('cmd_018f2b3c-4d5e-7abc-8def-01234567a460',
        'prj_p6_operator_fixture','wrk_p6_operator_fixture','ver_p6_operator_bad',
        'UnboundLegacy','OriginEvidenceIncomplete','2026-10-18T00:00:00.000Z')`,
    ).run();
    db.exec("COMMIT");
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK");
    db.close();
  }
};

const assertUnboundLegacyReadSurface = async (
  databaseFilename: string,
): Promise<void> => {
  const parentWorkspaceId = "ws_018f2b3c-4d5e-7abc-8def-01234567a457";
  const ownerWorkspaceId = "ws_018f2b3c-4d5e-7abc-8def-01234567a458";
  const projectId = "prj_p6_operator_fixture";
  const commandId = "cmd_018f2b3c-4d5e-7abc-8def-01234567a459";
  const sqlite = sqliteLayer({ filename: databaseFilename });
  const services = Layer.mergeAll(
    sqlite,
    Layer.provide(TransactionPortLive, sqlite),
    Layer.provide(RetryVerificationOriginRepositoryLive, sqlite),
  );
  const listProjection = (workspaceId: string) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            const tx = yield* TransactionPort;
            const origins = yield* RetryVerificationOriginRepository;
            return yield* tx.transact(
              origins.listCurrentUnboundLegacyInbox(workspaceId as never),
            );
          }),
          services,
        ),
      ),
    );
  const projections = await listProjection(parentWorkspaceId);
  expect(projections).toHaveLength(1);
  const projection = projections[0];
  if (projection === undefined) throw new Error("Inbox projection missing");
  const row = {
    entryKey: `retry-verification-unbound:${commandId}`,
    kind: "Governance" as const,
    summary:
      "A historical RetryVerification receipt has incomplete origin evidence.",
    watermark: 1,
    target: {
      kind: "RetryVerificationUnboundLegacy" as const,
      commandId: projection.commandId,
      projectId: projection.projectId,
      sourceWorkId: projection.sourceWorkId,
      sourceVerificationId: projection.sourceVerificationId,
      disposition: projection.disposition,
      reasonCode: projection.reasonCode,
      createdAt: projection.createdAt,
      revision: projection.revision,
      updatedAt: projection.updatedAt,
    },
  };
  const rawInboxPort = {
    query: () =>
      Effect.succeed({
        value: { unconsumed: [row] },
        watermark: 1,
        lag: 0,
      }),
  };
  const loadInputs = () =>
    Effect.succeed({
      canonicalFacts: {
        projectId,
        project: { rootWorkspaceId: "ws_018f2b3c-4d5e-7abc-8def-01234567a455" },
        work: {
          workId: projection.sourceWorkId,
          projectId,
          workspaceId: ownerWorkspaceId,
        },
        workspace: {
          workspaceId: ownerWorkspaceId,
          projectId,
          parentWorkspaceId,
        },
      },
      grants: [],
      governance: {
        authenticatedHumans: [],
        directParentOf: [
          { workspaceId: ownerWorkspaceId, parentPrincipal: "user:parent" },
        ],
      },
      policy: {},
    } as never);
  const face = viewQueryFaceWithRetryAvailability(
    rawInboxPort as never,
    {} as never,
    loadInputs as never,
    (workspaceId) => Effect.promise(() => listProjection(workspaceId)) as never,
  );
  const digestBefore = logicalSqliteDigest(databaseFilename);
  const query = (principal: string) =>
    Effect.runPromise(
      face.query(
        "inbox-view",
        { workspaceId: parentWorkspaceId as never },
        undefined,
        principal as never,
      ),
    );
  const parentRead = await query("user:parent");
  expect(parentRead.value.unconsumed).toHaveLength(1);
  const foreignHumanRead = await query("user:foreign");
  expect(foreignHumanRead.value.unconsumed).toEqual([]);
  const agentRead = await query("agent:parent");
  expect(agentRead.value.unconsumed).toEqual([]);
  const repeatedParentRead = await query("user:parent");
  expect(repeatedParentRead.value.unconsumed).toHaveLength(1);
  expect(logicalSqliteDigest(databaseFilename)).toBe(digestBefore);
  const after = new DatabaseSync(databaseFilename, { readOnly: true });
  try {
    expect(
      after
        .prepare(
          "SELECT consumed_at,revision FROM inbox_entries WHERE entry_key = ?",
        )
        .get(`retry-verification-unbound:${commandId}`),
    ).toEqual({ consumed_at: null, revision: 1 });
  } finally {
    after.close();
  }
};
