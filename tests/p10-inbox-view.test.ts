import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { InboxViewRes } from "../packages/api-contracts/src/index.js";
import {
  parse,
  settlementFingerprint,
  WorkId,
} from "../packages/domain/dist/index.js";
import {
  InboxProjectionStore,
  TransactionPort,
} from "../packages/ports/src/index.js";
import {
  canonicalFactRefOfKey,
  deriveInboxView,
  reconcileInbox,
} from "../packages/projection-runtime/src/index.js";
import {
  insertEventRow,
  insertExecutionRow,
  insertInboxRow,
  insertMessageRow,
  insertProjectRootRow,
  insertWorkRow,
  insertWorkspaceRow,
  makeP10App,
  makeP10Deps,
  migrate,
  p10Child,
  p10Project,
  p10Root,
  runP10,
  seedCanonical,
  setCurrentWork,
  snapshotDatabase,
} from "./support/p10-fixture.js";

const W_ROOT = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000c1");
const EXE_SPECIALIST = "exe_00000000-0000-7000-8000-0000000000c1";

const specialistSettlement = {
  _tag: "Completed",
  result: { _tag: "QueryCompleted" },
} as const;

const specialistFingerprint = settlementFingerprint(
  specialistSettlement as never,
);

const seedBase = seedCanonical(
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
    yield* insertWorkRow(
      { workId: W_ROOT, workspaceId: p10Root, objective: "inbox" },
      p10Project,
    );
    yield* setCurrentWork(p10Root, W_ROOT);
    // a settled specialist execution of the CHILD workspace — its
    // settlement fact targets the PARENT (root) inbox
    yield* insertExecutionRow(
      {
        executionId: EXE_SPECIALIST,
        workspaceId: p10Child,
        focusWorkId: null,
        settlement: specialistSettlement as never,
        settledAt: "t1",
      },
      p10Project,
    );
    // one journal event so the watermark is observable
    yield* insertEventRow({
      eventId: "evt_00000000-0000-7000-8000-0000000000c1",
      projectId: p10Project,
      eventType: "WorkAssigned",
      payload: { workId: W_ROOT },
      occurredAt: "t1",
    });
  }),
);

/** The no-drift canonical shape: both messages admitted (one consumed),
 * the specialist settlement admitted. */
const seedConsistent = seedCanonical(
  Effect.gen(function* () {
    yield* insertMessageRow({
      messageId: "msg_00000000-0000-7000-8000-0000000000c1",
      senderWorkspaceId: p10Child,
      recipientWorkspaceId: p10Root,
      kind: "Report",
      bodyRef: "blob:r1",
      sentAt: "t2",
    });
    yield* insertInboxRow({
      workspaceId: p10Root,
      entryKey: "msg:msg_00000000-0000-7000-8000-0000000000c1",
      kind: "Message",
      summary: "blob:r1",
      admittedAt: "t2",
    });
    yield* insertMessageRow({
      messageId: "msg_00000000-0000-7000-8000-0000000000c2",
      senderWorkspaceId: p10Child,
      recipientWorkspaceId: p10Root,
      kind: "Query",
      bodyRef: "blob:q1",
      correlationId: "corr-1",
      sentAt: "t3",
    });
    yield* insertInboxRow({
      workspaceId: p10Root,
      entryKey: "msg:msg_00000000-0000-7000-8000-0000000000c2",
      kind: "Message",
      summary: "blob:q1",
      correlationId: "corr-1",
      admittedAt: "t3",
      consumedAt: "t4",
    });
    yield* insertInboxRow({
      workspaceId: p10Root,
      entryKey: `spc:${EXE_SPECIALIST}:${specialistFingerprint}`,
      kind: "SpecialistSettled",
      summary: "specialist settlement",
      admittedAt: "t1",
    });
  }),
);

describe("P10-008 Inbox view (01 §1 InboxViewReq/Res; P9 05 §3.2)", () => {
  it("unconsumed entries carry the read-time journal watermark; consumed entries stay canonical but leave the view", async () => {
    await runP10(
      Effect.gen(function* () {
        yield* migrate;
        yield* seedBase;
        yield* seedConsistent;
        const deps = yield* makeP10Deps();
        const before = yield* snapshotDatabase();

        const view: InboxViewRes = yield* deriveInboxView(
          p10Root,
          deps.inboxView,
        );
        expect(view.unconsumed).toEqual([
          {
            entryKey: `spc:${EXE_SPECIALIST}:${specialistFingerprint}`,
            kind: "SpecialistSettled",
            summary: "specialist settlement",
            watermark: 1,
          },
          {
            entryKey: "msg:msg_00000000-0000-7000-8000-0000000000c1",
            kind: "Message",
            summary: "blob:r1",
            watermark: 1,
          },
        ]);

        const after = yield* snapshotDatabase();
        expect(after).toBe(before);
      }),
      makeP10App(),
    );
  });
});

describe("P10-008 Inbox state reconciliation (04 §2 — audit face)", () => {
  it("consistent state reports zero drift; the audit pass never writes", async () => {
    await runP10(
      Effect.gen(function* () {
        yield* migrate;
        yield* seedBase;
        yield* seedConsistent;
        const deps = yield* makeP10Deps();
        const before = yield* snapshotDatabase();

        const report = yield* reconcileInbox(p10Root, deps.inboxReconcile);
        expect(report.drift).toEqual([]);
        expect(report.repairHints).toEqual([]);

        const after = yield* snapshotDatabase();
        expect(after).toBe(before);
      }),
      makeP10App(),
    );
  });

  it("drift fixtures: missing / extra / duplicated shapes produce the exact report with P6-path-only repair hints", async () => {
    await runP10(
      Effect.gen(function* () {
        yield* migrate;
        yield* seedBase;
        // MISSING: canonical message with no inbox row
        yield* insertMessageRow({
          messageId: "msg_00000000-0000-7000-8000-0000000000c9",
          senderWorkspaceId: p10Child,
          recipientWorkspaceId: p10Root,
          kind: "Report",
          bodyRef: "blob:r9",
          sentAt: "t9",
        });
        // EXTRA: inbox row over the audited key space with no canonical
        // message behind it
        yield* insertInboxRow({
          workspaceId: p10Root,
          entryKey: "msg:msg_00000000-0000-7000-8000-00000000dead",
          kind: "Message",
          summary: "orphan",
          admittedAt: "t8",
        });
        // DUPLICATED: one specialist execution marked twice (two
        // fingerprints), canonical fact = fp1 only
        yield* insertInboxRow({
          workspaceId: p10Root,
          entryKey: `spc:${EXE_SPECIALIST}:${specialistFingerprint}`,
          kind: "SpecialistSettled",
          summary: "specialist settlement",
          admittedAt: "t1",
        });
        yield* insertInboxRow({
          workspaceId: p10Root,
          entryKey: `spc:${EXE_SPECIALIST}:corrupted-fingerprint`,
          kind: "SpecialistSettled",
          summary: "stale duplicate",
          admittedAt: "t1",
        });
        // out-of-scope key space: HumanInput/Governance rows are
        // command-side maintained — never reported by this audit
        yield* insertInboxRow({
          workspaceId: p10Root,
          entryKey: "steer:wrk_x:1",
          kind: "HumanInput",
          summary: "steer",
          admittedAt: "t2",
        });
        const deps = yield* makeP10Deps();
        const before = yield* snapshotDatabase();

        const report = yield* reconcileInbox(p10Root, deps.inboxReconcile);

        // deterministic order: kind:entryKey (DuplicateFact < ExtraEntry
        // < MissingEntry alphabetically; '_' sorts before 'c')
        const duplicateMembers = `spc:${EXE_SPECIALIST}:${specialistFingerprint}, spc:${EXE_SPECIALIST}:corrupted-fingerprint`;
        expect(report.drift).toEqual([
          {
            kind: "DuplicateFact",
            workspaceId: p10Root,
            entryKey: `spc:${EXE_SPECIALIST}:${specialistFingerprint}`,
            canonicalFactRef: `specialist-settlement:${EXE_SPECIALIST}`,
            detail: `canonical fact specialist-settlement:${EXE_SPECIALIST} is marked 2 times (${duplicateMembers})`,
          },
          {
            kind: "DuplicateFact",
            workspaceId: p10Root,
            entryKey: `spc:${EXE_SPECIALIST}:corrupted-fingerprint`,
            canonicalFactRef: `specialist-settlement:${EXE_SPECIALIST}`,
            detail: `canonical fact specialist-settlement:${EXE_SPECIALIST} is marked 2 times (${duplicateMembers})`,
          },
          {
            kind: "ExtraEntry",
            workspaceId: p10Root,
            entryKey: "msg:msg_00000000-0000-7000-8000-00000000dead",
            canonicalFactRef:
              "message:msg_00000000-0000-7000-8000-00000000dead",
            detail:
              "inbox row msg:msg_00000000-0000-7000-8000-00000000dead matches no canonical message:msg_00000000-0000-7000-8000-00000000dead fact",
          },
          {
            kind: "MissingEntry",
            workspaceId: p10Root,
            entryKey: "msg:msg_00000000-0000-7000-8000-0000000000c9",
            canonicalFactRef:
              "message:msg_00000000-0000-7000-8000-0000000000c9",
            detail:
              "canonical fact message:msg_00000000-0000-7000-8000-0000000000c9 has no inbox row",
          },
        ]);

        // repair hints point ONLY at the P6 admission/consumption paths
        for (const hint of report.repairHints) {
          expect(
            hint.via === "P6InboxAdmission" ||
              hint.via === "P6InboxConsumption",
          ).toBe(true);
        }
        const admit = report.repairHints.find(
          (hint) => hint.action === "admit",
        );
        expect(admit?.entry).toEqual({
          recipientWorkspaceId: p10Root,
          entryKey: "msg:msg_00000000-0000-7000-8000-0000000000c9",
          kind: "Message",
          summary: "blob:r9",
          correlationId: undefined,
          admittedAt: "t9",
        });

        // canonical rows untouched by the audit pass itself
        const after = yield* snapshotDatabase();
        expect(after).toBe(before);

        // --- operator-triggered repair via the P6 faces only ---
        const inbox = yield* InboxProjectionStore;
        const txPort = yield* TransactionPort;
        yield* txPort.transact(
          Effect.gen(function* () {
            for (const hint of report.repairHints) {
              if (hint.action === "admit" && hint.entry !== undefined) {
                yield* inbox.admitUpsert(hint.entry);
              }
              if (hint.action === "review" || hint.action === "consume") {
                for (const key of hint.entryKey
                  .split(",")
                  .map((entryKey) => entryKey.trim())) {
                  yield* inbox.markConsumed(p10Root, key);
                }
              }
            }
          }),
        );

        // convergence: the same audit now reports zero drift
        const converged = yield* reconcileInbox(p10Root, deps.inboxReconcile);
        expect(converged.drift).toEqual([]);
      }),
      makeP10App(),
    );
  });

  it("canonicalFactRefOfKey parses the two audited key spaces only", () => {
    expect(canonicalFactRefOfKey("msg:msg_1")).toBe("message:msg_1");
    expect(canonicalFactRefOfKey("spc:exe_1:fp")).toBe(
      "specialist-settlement:exe_1",
    );
    expect(canonicalFactRefOfKey("steer:wrk_1:2")).toBeNull();
    expect(canonicalFactRefOfKey("dec:prp_1:1:Approve")).toBeNull();
  });
});
