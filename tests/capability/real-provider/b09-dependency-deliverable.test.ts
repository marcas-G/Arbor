import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterEach, describe } from "vitest";
import { secretRef } from "../../../packages/ports/dist/provider.js";
import { defineCapabilityTest, metadataFor } from "../harness.js";
import { runAndCapture } from "../support/capture.js";
import {
  makePublicProject,
  withPublicConversationApp,
} from "../support/public-chat.js";
import { driveWorkExecution, submitWork } from "../support/work-execution.js";
import { makeHttpProviderClient } from "./http-sdk-client.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("B09 L3 — dependency declaration through the adopted route", () => {
  defineCapabilityTest(
    metadataFor("B09", "L3"),
    "B09: a real model declares a dependency; only the matcher may ever satisfy it",
    async () => {
      await runAndCapture({
        caseId: "B09-L3-REAL",
        body: async (runtime, calls) => {
          const marker = `B09_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
          const project = makePublicProject(`b09-${marker}`);
          const directory = join(tmpdir(), `arbor-b09-real-${randomUUID()}`);
          mkdirSync(directory, { recursive: true });
          temporaryDirectories.push(directory);
          const objective =
            "你的第一个动作必须是调用 arbor_declare_dependency，参数 JSON：" +
            `{"producerBinding": {"_tag": "AnyProducer"}, "expectedDeliverable": {"kind": "${marker}-report", "requiredArtifactRoles": ["report"]}}。` +
            "禁止调用 list、read、shell、patch。第二个动作调用 arbor_wait（reason done，waitSpec Any + Manual）。";
          let settlement: unknown;
          let dependencies: ReadonlyArray<{
            dependency_id: string;
            state: string;
            expected_deliverable: string;
          }> = [];
          await withPublicConversationApp(
            {
              databaseFile: join(directory, "slice.db"),
              project,
              modelRef: runtime.model,
              provider: makeHttpProviderClient({
                runtime,
                ...(process.env.ARBOR_CAPABILITY_API_KEY === undefined
                  ? {}
                  : { apiKey: process.env.ARBOR_CAPABILITY_API_KEY }),
                captures: calls,
              }),
              ...(runtime.authMode === "env"
                ? { secretRef: secretRef("ARBOR_CAPABILITY_API_KEY") }
                : {}),
            },
            async (handle) => {
              const fixture = await submitWork(handle, project, objective);
              const driven = await driveWorkExecution(handle, project, fixture);
              settlement = driven.settlement;
              const rows = await handle.run(
                Effect.gen(function* () {
                  const sql = yield* SqlClient;
                  return yield* sql.unsafe<{
                    dependency_id: string;
                    state: string;
                    expected_deliverable: string;
                  }>(
                    "SELECT dependency_id, state, expected_deliverable FROM dependencies",
                  );
                }),
              );
              dependencies = rows;
            },
          );
          return { marker, settlement, dependencies, providerCalls: calls };
        },
        verify: (result) => {
          const dependency = result.dependencies[0];
          if (dependency === undefined) {
            throw new Error(
              "the real-model run persisted no dependency declaration",
            );
          }
          // Declaring never asserts satisfaction: the deterministic matcher
          // alone can flip the state.
          if (dependency.state !== "Unsatisfied") {
            throw new Error(
              `a fresh declaration must be Unsatisfied, found ${dependency.state}`,
            );
          }
          if (!dependency.dependency_id.startsWith("dep_")) {
            throw new Error("dependencyId is not a domain DependencyId");
          }
          if (
            !dependency.expected_deliverable.includes(`${result.marker}-report`)
          ) {
            throw new Error(
              "the persisted expectation does not carry the model's declared deliverable",
            );
          }
          const advertised = result.providerCalls.some((call) =>
            JSON.stringify(call.request.tools ?? []).includes(
              "arbor_declare_dependency",
            ),
          );
          if (!advertised) {
            throw new Error(
              "arbor_declare_dependency was never advertised to the real model",
            );
          }
        },
      });
    },
  );
});
