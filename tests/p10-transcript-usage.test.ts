import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type {
  TranscriptRes,
  UsageRes,
} from "../packages/api-contracts/src/index.js";
import {
  parse,
  type SessionId,
  WorkId,
} from "../packages/domain/dist/index.js";
import {
  buildTreeView,
  deriveTranscriptPage,
  deriveUsageRows,
  parseUsageJson,
} from "../packages/projection-runtime/src/index.js";
import {
  insertExecutionRow,
  insertProjectRootRow,
  insertProviderTurnRow,
  insertSessionEntryRow,
  insertWorkRow,
  insertWorkspaceRow,
  makeP10App,
  makeP10Deps,
  migrate,
  p10Child,
  p10Leaf,
  p10Project,
  p10Root,
  runP10,
  seedCanonical,
  setCurrentWork,
  snapshotDatabase,
} from "./support/p10-fixture.js";

const UNKNOWN_PRICING = {
  _tag: "Unknown",
  reason: "PricingUnavailable",
} as const;
const UNKNOWN_USAGE = { _tag: "Unknown", reason: "UsageUnavailable" } as const;

const W_ROOT = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000f1");
const W_CHILD = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000f2");
const EXE_ROOT = "exe_00000000-0000-7000-8000-0000000000f1";
const EXE_CHILD = "exe_00000000-0000-7000-8000-0000000000f2";

const seedTranscriptUsage = seedCanonical(
  Effect.gen(function* () {
    yield* insertProjectRootRow(p10Root, p10Project);
    yield* insertWorkspaceRow(
      { workspaceId: p10Root, parentWorkspaceId: null, name: "root" },
      p10Project,
    );
    yield* insertWorkspaceRow(
      { workspaceId: p10Child, parentWorkspaceId: p10Root, name: "child" },
      p10Project,
    );
    yield* insertWorkspaceRow(
      { workspaceId: p10Leaf, parentWorkspaceId: p10Child, name: "leaf" },
      p10Project,
    );
    yield* insertWorkRow(
      { workId: W_ROOT, workspaceId: p10Root, objective: "usage" },
      p10Project,
    );
    yield* insertWorkRow(
      { workId: W_CHILD, workspaceId: p10Child, objective: "child usage" },
      p10Project,
    );
    yield* setCurrentWork(p10Root, W_ROOT);
    yield* insertExecutionRow(
      { executionId: EXE_ROOT, workspaceId: p10Root, focusWorkId: W_ROOT },
      p10Project,
    );
    yield* insertExecutionRow(
      { executionId: EXE_CHILD, workspaceId: p10Child, focusWorkId: W_CHILD },
      p10Project,
    );

    // session entries: workspace-primary session of root (2 rows) and the
    // execution session of EXE_ROOT (3 rows); child has its own session.
    const rootPrimary = `ses:${p10Root}`;
    const rootExec = `ses:exec:${EXE_ROOT}`;
    const childPrimary = `ses:${p10Child}`;
    const entries: Array<[string, string, string]> = [
      [rootPrimary, "Input", "t1"],
      [rootPrimary, "ModelOutput", "t2"],
      [rootExec, "Input", "t3"],
      [rootExec, "Observation", "t4"],
      [rootExec, "CheckpointReference", "t5"],
      [childPrimary, "Input", "t6"],
    ];
    for (const [sessionId, entryKind, at] of entries) {
      yield* insertSessionEntryRow({
        sessionId,
        entryKind: entryKind as "Input",
        payload: entryKind === "CheckpointReference" ? { ref: "ckpt:1" } : {},
        createdAt: at,
      });
    }

    // provider turns: root (2 settled, 1 unsettled), child (1 settled)
    yield* insertProviderTurnRow({
      providerTurnId: "ptn_00000000-0000-7000-8000-0000000000f1",
      executionId: EXE_ROOT,
      sessionId: rootExec,
      usage: { _tag: "UsageReported", inputTokens: 100, outputTokens: 50 },
      settledAt: "t2",
    });
    yield* insertProviderTurnRow({
      providerTurnId: "ptn_00000000-0000-7000-8000-0000000000f2",
      executionId: EXE_ROOT,
      sessionId: rootExec,
      usage: {
        _tag: "UsageReported",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 1,
        cacheWriteTokens: 2,
      },
      settledAt: "t3",
    });
    yield* insertProviderTurnRow({
      providerTurnId: "ptn_00000000-0000-7000-8000-0000000000f3",
      executionId: EXE_ROOT,
      sessionId: rootExec,
      usage: { _tag: "UsageReported", inputTokens: 999, outputTokens: 1 },
      settledAt: null,
    });
    yield* insertProviderTurnRow({
      providerTurnId: "ptn_00000000-0000-7000-8000-0000000000f4",
      executionId: EXE_CHILD,
      sessionId: childPrimary,
      usage: { _tag: "UsageReported", inputTokens: 7, outputTokens: 3 },
      settledAt: "t6",
    });
  }),
);

describe("P10-007 Transcript — production read path over session_entries", () => {
  it("pages across sessions in the deterministic (sessionId, sequence) order with replay-stable cursors", async () => {
    await runP10(
      Effect.gen(function* () {
        yield* migrate;
        yield* seedTranscriptUsage;
        const deps = yield* makeP10Deps();
        const before = yield* snapshotDatabase();

        // root sees its primary session (ses:ws..root) + execution session
        // (ses:exe:..f1); total order: ses:exe:... < ses:ws:... (string)
        // P14 `03` union: legacy arm + conversation-turn arms (this harness
        // passes no conversationTurns, so only legacy entries occur).
        const walk: Array<TranscriptRes["entries"][number]> = [];
        const pages: Array<ReadonlyArray<{ kind: string }>> = [];
        let cursor: string | undefined;
        let guard = 0;
        do {
          const page: TranscriptRes = yield* deriveTranscriptPage(
            { workspaceId: p10Root, cursor, limit: 2 },
            deps.transcript,
          );
          pages.push(page.entries.map((entry) => ({ kind: entry.kind })));
          walk.push(...page.entries);
          cursor = page.nextCursor;
          guard += 1;
          expect(guard).toBeLessThan(10);
        } while (cursor !== undefined);

        expect(pages).toEqual([
          [{ kind: "Input" }, { kind: "Observation" }], // ses:exe:..f1 seq0-1
          [
            { kind: "CheckpointReference" }, // ses:exe:..f1 seq2
            { kind: "Input" }, // ses:ws..root seq0
          ],
          [{ kind: "ModelOutput" }], // ses:ws..root seq1 — last page, no nextCursor
        ]);
        // checkpoint entry renders its payload ref; the rest self-reference
        expect(walk.find((e) => e.kind === "CheckpointReference")).toEqual({
          kind: "CheckpointReference",
          summaryRef: "ckpt:1",
          at: "t5",
        });
        expect(walk[0]).toEqual({
          kind: "Input",
          summaryRef: `session-entry:ses:exec:${EXE_ROOT}:0`,
          at: "t3",
        });

        // replay: same walk from scratch yields identical pages
        const replay: Array<ReadonlyArray<{ kind: string }>> = [];
        let replayCursor: string | undefined;
        do {
          const page: TranscriptRes = yield* deriveTranscriptPage(
            { workspaceId: p10Root, cursor: replayCursor, limit: 2 },
            deps.transcript,
          );
          replay.push(page.entries.map((entry) => ({ kind: entry.kind })));
          replayCursor = page.nextCursor;
        } while (replayCursor !== undefined);
        expect(replay).toEqual(pages);

        // read-only: the Transcript is a debug projection, never truth,
        // and never writes.
        const after = yield* snapshotDatabase();
        expect(after).toBe(before);
      }),
      makeP10App(),
    );
  });

  it("sessionId scope restricts the page; malformed cursor and non-positive limit are typed read failures", async () => {
    await runP10(
      Effect.gen(function* () {
        yield* migrate;
        yield* seedTranscriptUsage;
        const deps = yield* makeP10Deps();

        const scoped: TranscriptRes = yield* deriveTranscriptPage(
          {
            workspaceId: p10Root,
            // fixture-created execution session id (not a uuid-shaped
            // SessionId — the read face is string-keyed)
            sessionId: `ses:exec:${EXE_ROOT}` as SessionId,
            limit: 10,
          },
          deps.transcript,
        );
        expect(scoped.entries.map((entry) => entry.kind)).toEqual([
          "Input",
          "Observation",
          "CheckpointReference",
        ]);
        expect(scoped.nextCursor).toBeUndefined();

        const malformed = yield* Effect.flip(
          deriveTranscriptPage(
            { workspaceId: p10Root, cursor: "not-a-cursor", limit: 5 },
            deps.transcript,
          ),
        );
        expect(malformed._tag).toBe("ProjectionReadFailure");

        const zeroLimit = yield* Effect.flip(
          deriveTranscriptPage(
            { workspaceId: p10Root, limit: 0 },
            deps.transcript,
          ),
        );
        expect(zeroLimit._tag).toBe("ProjectionReadFailure");
      }),
      makeP10App(),
    );
  });
});

describe("P10-007 Usage — observe-only aggregation over provider_turns.usage_json (invariant 45)", () => {
  it("tokens sum every reported token count; unsettled turns are excluded; cost renders Unknown (never 0)", () => {
    expect(
      parseUsageJson(
        JSON.stringify({
          _tag: "UsageReported",
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 1,
          cacheWriteTokens: 2,
        }),
        "t1",
      ),
    ).toEqual({ tokens: 18, cost: UNKNOWN_PRICING, settled: true });
    expect(parseUsageJson(null, null)).toEqual({
      tokens: 0,
      cost: UNKNOWN_USAGE,
      settled: false,
    });
    expect(parseUsageJson("{broken", "t1")).toEqual({
      tokens: 0,
      cost: UNKNOWN_PRICING,
      settled: true,
    });
  });

  it("groupBy workspace / subtree / project are mechanical sums; Tree usageSummary is the same aggregation", async () => {
    await runP10(
      Effect.gen(function* () {
        yield* migrate;
        yield* seedTranscriptUsage;
        const deps = yield* makeP10Deps();
        const before = yield* snapshotDatabase();

        // root: 150 + 18 = 168 tokens / 2 turns (unsettled 1000 excluded);
        // child: 10 tokens / 1 turn; leaf: none
        const byWorkspace: UsageRes = {
          rows: yield* deriveUsageRows(
            { projectId: p10Project, groupBy: "workspace" },
            deps.usage,
          ),
        };
        const usageOf = (rows: UsageRes["rows"]) =>
          new Map(rows.map((row) => [row.workspaceId, row]));
        const ws = usageOf(byWorkspace.rows);
        expect(ws.get(p10Root)).toEqual({
          workspaceId: p10Root,
          tokens: 168,
          cost: UNKNOWN_PRICING,
          turns: 2,
        });
        expect(ws.get(p10Child)).toEqual({
          workspaceId: p10Child,
          tokens: 10,
          cost: UNKNOWN_PRICING,
          turns: 1,
        });
        expect(ws.get(p10Leaf)).toEqual({
          workspaceId: p10Leaf,
          tokens: 0,
          cost: UNKNOWN_USAGE,
          turns: 0,
        });

        // subtree: root = own + descendants
        const bySubtree: UsageRes = {
          rows: yield* deriveUsageRows(
            { projectId: p10Project, groupBy: "subtree" },
            deps.usage,
          ),
        };
        const sub = usageOf(bySubtree.rows);
        expect(sub.get(p10Root)?.tokens).toBe(178);
        expect(sub.get(p10Child)?.tokens).toBe(10);
        expect(sub.get(p10Leaf)?.tokens).toBe(0);

        // project: a single row keyed by the root workspace
        const byProject: UsageRes = {
          rows: yield* deriveUsageRows(
            { projectId: p10Project, groupBy: "project" },
            deps.usage,
          ),
        };
        expect(byProject.rows).toEqual([
          {
            workspaceId: p10Root,
            tokens: 178,
            cost: UNKNOWN_PRICING,
            turns: 3,
          },
        ]);

        // Tree usageSummary consistency: the same aggregate source, no
        // second derivation (tree.ts consumes aggregateUsageByWorkspace).
        const tree = yield* buildTreeView({ projectId: p10Project }, deps.tree);
        const flatten = (node: typeof tree): ReadonlyArray<typeof tree> => [
          node,
          ...node.children.flatMap(flatten),
        ];
        for (const node of flatten(tree)) {
          const expected = ws.get(node.workspaceId) ?? {
            tokens: 0,
            cost: UNKNOWN_USAGE,
            turns: 0,
          };
          expect(node.usageSummary).toEqual({
            tokens: expected.tokens,
            cost: expected.cost,
            turns: expected.turns,
          });
        }

        // observe-only: aggregation influenced nothing
        const after = yield* snapshotDatabase();
        expect(after).toBe(before);
      }),
      makeP10App(),
    );
  });
});
