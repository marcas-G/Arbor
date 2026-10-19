import { ExecutionId, parse } from "@arbor/domain";
import {
  P4_TOOL_OBSERVATION_FORMAT_V1,
  P4SandboxOutcomeReadPort,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { layer } from "../src/index.js";
import { P4SandboxOutcomeReadPortLive } from "../src/p4-sandbox-outcome-read-port.js";
import { encodeToolObservationEvidence } from "../src/tool-observation-evidence-codec.js";

const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const workspaceId = "ws_018f2b3c-4d5e-7abc-8def-0123456789a1";
const summary =
  "required sandbox capability was unavailable or could not be verified; execution did not start";

describe("P4 sandbox outcome read port", () => {
  it("reads only a strictly decoded terminal no-effect provider outcome", async () => {
    const observation = {
      _tag: "ExpectedFailure" as const,
      observation: { text: summary, truncated: false },
      sandboxProviderUnavailable: {
        policyRevision: 2,
        policyDigest: "a".repeat(64),
        profile: "WorkspaceWrite" as const,
        providerId: "os-sandbox",
        providerVersion: "1.4.2",
        capabilityRevision: "cap-17",
        probeEvidenceRef: "probe:evidence-1",
        failureCode: "sandbox/probe-interrupted",
        effectDisposition: "NoEffect" as const,
      },
    };
    const encoded = encodeToolObservationEvidence({
      settlement: { _tag: "ExpectedFailure" },
      observation,
      resultRef: null,
    });
    expect(encoded._tag).toBe("Encoded");
    if (encoded._tag !== "Encoded") return;

    const infra = layer({ filename: ":memory:" });
    const app = Layer.mergeAll(
      infra,
      Layer.provide(P4SandboxOutcomeReadPortLive, infra),
    );
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* sql.unsafe(
            `CREATE TABLE tool_invocations (
              invocation_id TEXT NOT NULL, execution_id TEXT NOT NULL,
              workspace_id TEXT NOT NULL, effect_admission_state TEXT NOT NULL,
              settled_at TEXT, settlement_kind TEXT, result_ref TEXT,
              observation_format_version TEXT, observation_json BLOB,
              observation_sha256 TEXT
            )`,
          );
          yield* sql.unsafe(
            `INSERT INTO tool_invocations VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [
              "tin_018f2b3c-4d5e-7abc-8def-0123456789a1",
              executionId,
              workspaceId,
              "MayHaveStarted",
              "2026-10-19T00:00:00.000Z",
              "ExpectedFailure",
              null,
              P4_TOOL_OBSERVATION_FORMAT_V1,
              encoded.evidence.bytes,
              encoded.evidence.sha256,
            ],
          );
          const port = yield* P4SandboxOutcomeReadPort;
          return yield* port.findUnavailableByExecutionAndRevision(
            executionId,
            2,
          );
        }),
        app,
      ).pipe(
        Effect.provideService(TransactionScope, {
          session: { id: "p4-sandbox-read-test" },
        }),
      ),
    );
    expect(result).toEqual([
      {
        ...observation.sandboxProviderUnavailable,
        invocationId: "tin_018f2b3c-4d5e-7abc-8def-0123456789a1",
        executionId,
        workspaceId,
        summary,
      },
    ]);
  });

  it("fails closed when the typed provider outcome is not a no-effect admitted row", async () => {
    const observation = {
      _tag: "ExpectedFailure" as const,
      observation: { text: summary, truncated: false },
      sandboxProviderUnavailable: {
        policyRevision: 2,
        policyDigest: "a".repeat(64),
        profile: "ReadOnly" as const,
        providerId: "os-sandbox",
        providerVersion: "1.4.2",
        capabilityRevision: "cap-17",
        probeEvidenceRef: null,
        failureCode: "sandbox/probe-interrupted",
        effectDisposition: "NoEffect" as const,
      },
    };
    const encoded = encodeToolObservationEvidence({
      settlement: { _tag: "ExpectedFailure" },
      observation,
      resultRef: null,
    });
    if (encoded._tag !== "Encoded") throw new Error("expected encoded body");
    const infra = layer({ filename: ":memory:" });
    const app = Layer.mergeAll(
      infra,
      Layer.provide(P4SandboxOutcomeReadPortLive, infra),
    );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql.unsafe(
          `CREATE TABLE tool_invocations (
            invocation_id TEXT NOT NULL, execution_id TEXT NOT NULL,
            workspace_id TEXT NOT NULL, effect_admission_state TEXT NOT NULL,
            settled_at TEXT, settlement_kind TEXT, result_ref TEXT,
            observation_format_version TEXT, observation_json BLOB,
            observation_sha256 TEXT
          )`,
        );
        yield* sql.unsafe(
          `INSERT INTO tool_invocations VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [
            "tin_018f2b3c-4d5e-7abc-8def-0123456789a1",
            executionId,
            workspaceId,
            "NotAdmitted",
            "2026-10-19T00:00:00.000Z",
            "ExpectedFailure",
            null,
            P4_TOOL_OBSERVATION_FORMAT_V1,
            encoded.evidence.bytes,
            encoded.evidence.sha256,
          ],
        );
        const port = yield* P4SandboxOutcomeReadPort;
        return yield* Effect.result(
          port.findUnavailableByExecutionAndRevision(executionId, 2),
        );
      }).pipe(
        Effect.provide(app),
        Effect.provideService(TransactionScope, {
          session: { id: "p4-sandbox-read-invalid-test" },
        }),
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toMatchObject({
        _tag: "PersistenceCorruption",
        operation: "sandbox-view-read",
      });
    }
  });
});
