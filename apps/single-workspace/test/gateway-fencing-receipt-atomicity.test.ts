import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CommandGateway,
  CommandHandlerRegistryLive,
  FenceStopCheck,
  makeCommandGatewayLive,
  makeRecordVerificationEvidenceHandler,
  semanticRequestFingerprint,
} from "@arbor/application";
import {
  CommandId,
  ExecutionId,
  LeaseGeneration,
  Principal,
  ProjectId,
  parse,
  VerificationId,
} from "@arbor/domain";
import {
  CommandStoreLive,
  layer as sqliteLayer,
  TransactionPortLive,
} from "@arbor/persistence-sqlite";
import { Clock, DomainEventJournal, IdGenerator } from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789ab");
const principal = parse(Principal)("agent:stale-verifier");
const actor = principal as never;
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const verificationId = parse(VerificationId)(
  "ver_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const commandId = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789ab");
const now = "2026-10-17T00:00:00.000Z";

const externalRows = (filename: string) => {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    return {
      commands: db
        .prepare(
          "SELECT command_id,resolution,terminal_error_json FROM commands WHERE command_id=?",
        )
        .all(commandId) as Array<{
        command_id: string;
        resolution: string;
        terminal_error_json: string | null;
      }>,
      attempts: db
        .prepare(
          "SELECT command_id,attempt_no,outcome FROM command_attempts WHERE command_id=?",
        )
        .all(commandId) as Array<{
        command_id: string;
        attempt_no: number;
        outcome: string;
      }>,
    };
  } finally {
    db.close();
  }
};

describe("Gateway stale-fence receipt transaction atomicity", () => {
  it("keeps the exact FencingRejected receipt invisible to a second SQLite connection until COMMIT", async () => {
    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), "arbor-gateway-fenced-receipt-"),
    );
    const filename = join(temporaryDirectory, "commands.sqlite");
    const payload = {
      verificationId,
      evidence: {
        evidenceId: "evd_018f2b3c-4d5e-7abc-8def-0123456789ab" as never,
        criterionId: "stale-fence-atomicity",
        kind: "ReasoningTrace" as const,
        recordedAt: now,
      },
    };
    const fingerprint = semanticRequestFingerprint({
      commandType: "RecordVerificationEvidence",
      projectId,
      actor,
      schemaVersion: "1",
      payload,
    });
    const context = {
      _tag: "ExecutionOrigin" as const,
      principal,
      executionId,
      fencingGeneration: parse(LeaseGeneration)(0),
    };
    let probeRead: ReturnType<typeof externalRows> | undefined;

    const handler = makeRecordVerificationEvidenceHandler({
      verifications: {
        findById: () => Effect.succeed(Option.none()),
      } as never,
      evidence: {
        append: () => Effect.void,
        listByVerification: () => Effect.succeed([]),
      } as never,
    });
    const sqlite = sqliteLayer({ filename });
    const clockLayer = Layer.succeed(Clock, {
      now: () => Effect.succeed(now),
    });
    const infra = Layer.merge(sqlite, clockLayer);
    const dependencies = Layer.mergeAll(
      infra,
      Layer.provide(TransactionPortLive, infra),
      Layer.provide(CommandStoreLive, infra),
      CommandHandlerRegistryLive([handler as never]),
      Layer.succeed(FenceStopCheck, {
        check: () => Effect.succeed("FencingRejected"),
      }),
      Layer.succeed(DomainEventJournal, {
        append: () => Effect.void,
        appendReturningIds: () => Effect.succeed([]),
        readAfter: () => Effect.succeed([]),
        readAfterRaw: () => Effect.succeed([]),
        decodeRaw: () =>
          Effect.succeed({ _tag: "Poison", reason: "MalformedEnvelope" }),
        lastSequence: () => Effect.succeed(0),
      } as never),
      Layer.succeed(IdGenerator, {
        generate: <T>() =>
          Effect.succeed("evt_018f2b3c-4d5e-7abc-8def-0123456789ab" as T),
      }),
    );
    const gatewayLayer = Layer.provideMerge(
      makeCommandGatewayLive(async (event) => {
        if (
          event.boundary === "AH10BeforeFencedReceiptCommit" &&
          event.commandId === commandId
        ) {
          probeRead = externalRows(filename);
        }
      }),
      dependencies,
    );
    const app = Layer.mergeAll(dependencies, gatewayLayer);

    const program = Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`
        CREATE TABLE commands (
          command_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          semantic_request_fingerprint TEXT NOT NULL,
          schema_version TEXT NOT NULL,
          fingerprint_algorithm_version INTEGER NOT NULL,
          resolution TEXT NOT NULL,
          result_json TEXT,
          terminal_error_json TEXT,
          created_at TEXT NOT NULL,
          settled_at TEXT NOT NULL
        )
      `);
      yield* sql.unsafe(`
        CREATE TABLE command_attempts (
          command_id TEXT NOT NULL,
          attempt_no INTEGER NOT NULL,
          started_at TEXT NOT NULL,
          settled_at TEXT,
          outcome TEXT NOT NULL,
          failure_kind TEXT,
          metadata_json TEXT,
          PRIMARY KEY(command_id,attempt_no)
        )
      `);
      const gateway = yield* CommandGateway;
      return yield* gateway.execute(
        {
          commandType: "RecordVerificationEvidence",
          commandId,
          projectId,
          actor,
          issuedAt: now,
          payload,
        },
        context,
        {
          _tag: "VerifierExecutionAuthority",
          principal,
          commandId,
          semanticRequestFingerprint: fingerprint,
          projectId,
          verificationId,
          executionId,
        },
      );
    });

    try {
      const receipt = await Effect.runPromise(Effect.provide(program, app));
      expect(receipt.resolution).toMatchObject({
        _tag: "TerminalRejected",
        error: { _tag: "FencingRejected" },
      });
      expect(probeRead).toEqual({ commands: [], attempts: [] });
      expect(externalRows(filename)).toEqual({
        commands: [
          {
            command_id: commandId,
            resolution: "TerminalRejected",
            terminal_error_json: '{"_tag":"FencingRejected"}',
          },
        ],
        attempts: [
          {
            command_id: commandId,
            attempt_no: 0,
            outcome: "TerminalRejected",
          },
        ],
      });
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
