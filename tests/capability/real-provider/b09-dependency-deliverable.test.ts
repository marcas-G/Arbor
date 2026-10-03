import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterEach, describe } from "vitest";
import { ProductionDaemonService } from "../../../apps/single-workspace/src/production.js";
import { secretRef } from "../../../packages/ports/dist/provider.js";
import { defineCapabilityTest, metadataFor } from "../harness.js";
import { runAndCapture } from "../support/capture.js";
import {
  makePublicProject,
  newCapabilityId,
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
    "MAC-P3: a real producer creates and delivers a formal result; matcher satisfies",
    async () => {
      await runAndCapture({
        caseId: "MAC-P3-DELIVERY-L3-REAL",
        body: async (runtime, calls) => {
          const marker = `MAC3_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
          const project = makePublicProject(`mac3-${marker}`);
          const directory = join(tmpdir(), `arbor-mac3-real-${randomUUID()}`);
          mkdirSync(directory, { recursive: true });
          temporaryDirectories.push(directory);
          let dependencyState = "missing";
          let deliveredMessages = 0;
          let settlement: unknown;
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
              const consumer = await submitWork(
                handle,
                project,
                `consume ${marker} report`,
              );
              const childWorkspaceId = newCapabilityId("ws");
              const child = await handle.postCommand({
                commandType: "CreateChildWorkspace",
                commandId: newCapabilityId("cmd"),
                projectId: project.projectId,
                actor: "user:capability-test",
                issuedAt: new Date().toISOString(),
                payload: {
                  parentWorkspaceId: project.rootWorkspaceId,
                  workspaceId: childWorkspaceId,
                  primarySession: {
                    sessionId: newCapabilityId("ses"),
                    contextEpoch: 0,
                  },
                  name: "producer",
                  responsibilityDefinition: {
                    purpose: `produce ${marker} results`,
                    ownedResponsibilities: [],
                    obligations: [],
                    includes: [],
                    excludes: [],
                    interfaces: [],
                  },
                  responsibilityRevision: 1,
                  resourceBoundary: {
                    basisResponsibilityRevision: 1,
                    addresses: [],
                  },
                  resourceBoundaryRevision: 1,
                  agentBinding: {
                    _tag: "ResponsibilityBoundAgentBinding",
                    workspaceId: childWorkspaceId,
                  },
                  workspacePolicy: {},
                  workspacePolicyRevision: 0,
                  revision: 0,
                },
              });
              if (
                child.status !== 200 ||
                (child.payload.body as { resolution?: string } | undefined)
                  ?.resolution !== "Committed"
              ) {
                throw new Error(
                  `CreateChildWorkspace failed: ${JSON.stringify(child)}`,
                );
              }
              const producer = await submitWork(
                handle,
                project,
                `先调用 produce_deliverable，kind 必须为 ${marker}-report，artifacts 为空数组。` +
                  "收到 DeliverableProduced 结果后，从结果中提取 del_ 标识并调用 deliver，summary 为 report ready。" +
                  "最后调用 wait（Manual）。不要调用 satisfy_dependency。",
                {
                  createProject: false,
                  workspaceId: childWorkspaceId,
                  expectedWorkspaceRevision: 0,
                },
              );
              const dependencyId = newCapabilityId("dep");
              await handle.run(
                Effect.gen(function* () {
                  const sql = yield* SqlClient;
                  yield* sql.unsafe(
                    "INSERT INTO dependencies (dependency_id, project_id, consumer_work_id, producer_binding, expected_deliverable, revision, state, satisfied_by_deliverable_id, satisfied_at_dependency_revision, created_at, updated_at) VALUES (?,?,?,?,?,0,'Unsatisfied',NULL,NULL,'t','t')",
                    [
                      dependencyId,
                      project.projectId,
                      consumer.workId,
                      JSON.stringify({
                        _tag: "WorkspaceBound",
                        workspaceId: childWorkspaceId,
                      }),
                      JSON.stringify({
                        kind: `${marker}-report`,
                        requiredArtifactRoles: [],
                      }),
                    ],
                  );
                }),
              );
              settlement = (
                await driveWorkExecution(handle, project, producer, {
                  workspaceId: childWorkspaceId,
                })
              ).settlement;
              await handle.run(
                Effect.gen(function* () {
                  const daemon = yield* ProductionDaemonService;
                  yield* daemon.daemon.pollConsumers;
                  yield* daemon.daemon.pollConsumers;
                }),
              );
              const durable = await handle.run(
                Effect.gen(function* () {
                  const sql = yield* SqlClient;
                  const dependencies = yield* sql.unsafe<{ state: string }>(
                    "SELECT state FROM dependencies WHERE dependency_id = ?",
                    [dependencyId],
                  );
                  const messages = yield* sql.unsafe<{ n: number }>(
                    "SELECT COUNT(*) AS n FROM messages WHERE kind = 'Deliver'",
                  );
                  return {
                    state: dependencies[0]?.state ?? "missing",
                    messages: Number(messages[0]?.n ?? -1),
                  };
                }),
              );
              dependencyState = durable.state;
              deliveredMessages = durable.messages;
            },
          );
          return {
            marker,
            dependencyState,
            deliveredMessages,
            settlement,
            providerCalls: calls,
          };
        },
        verify: (result) => {
          if (result.dependencyState !== "Satisfied") {
            throw new Error(
              `dependency was not satisfied: ${result.dependencyState}`,
            );
          }
          if (result.deliveredMessages !== 1) {
            throw new Error(
              `expected one formal Deliver message, found ${result.deliveredMessages}`,
            );
          }
          const wire = result.providerCalls
            .map((call) => {
              if (call.responseBodyBase64 === undefined) return "";
              return Buffer.from(call.responseBodyBase64, "base64").toString(
                "utf8",
              );
            })
            .join("\n");
          if (
            !wire.includes("produce_deliverable") ||
            !wire.includes('"deliver"') ||
            wire.includes("satisfy_dependency")
          ) {
            throw new Error(
              "real producer did not follow produce→deliver with model-free satisfy",
            );
          }
        },
      });
    },
  );

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
            "你的第一个动作必须是调用 declare_dependency，参数 JSON：" +
            `{"producerBinding": {"_tag": "AnyProducer"}, "expectedDeliverable": {"kind": "${marker}-report", "requiredArtifactRoles": ["report"]}}。` +
            "禁止调用 list、read、shell、patch。第二个动作调用 wait（reason done，waitSpec Any + Manual）。";
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
              "declare_dependency",
            ),
          );
          if (!advertised) {
            throw new Error(
              "declare_dependency was never advertised to the real model",
            );
          }
        },
      });
    },
  );
});
