import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe } from "vitest";
import {
  CommandGateway,
  semanticRequestFingerprint,
  spawnVerifier,
} from "../../../packages/application/src/index.js";
import {
  CommandId,
  ExecutionId,
  Principal,
  ProjectId,
  parse,
  VerificationId,
  WorkId,
  WorkspaceId,
} from "../../../packages/domain/src/index.js";
import { runExecution } from "../../../packages/execution-runtime/src/index.js";
import { secretRef } from "../../../packages/ports/dist/provider.js";
import {
  BlobStorePort,
  Clock,
  EnvironmentRevisionStore,
  ExecutionRepository,
  TransactionPort,
  VerificationRepository,
} from "../../../packages/ports/src/index.js";
import { defineCapabilityTest, metadataFor } from "../harness.js";
import { runAndCapture } from "../support/capture.js";
import {
  makePublicProject,
  newCapabilityId,
  withPublicConversationApp,
} from "../support/public-chat.js";
import { queryDurableEffects, submitWork } from "../support/work-execution.js";
import { makeHttpProviderClient } from "./http-sdk-client.js";

const systemPrincipal = parse(Principal)("runtime:system");

describe("B10 L3 — independent real-provider Verification", () => {
  defineCapabilityTest(
    metadataFor("B10", "L3"),
    "B10: a real verifier binds exact tool evidence and concludes with a durable summary",
    async () => {
      await runAndCapture({
        caseId: "B10-L3-REAL",
        body: async (runtime, calls) => {
          const root = mkdtempSync(join(tmpdir(), "arbor-b10-real-"));
          const repository = join(root, "repo");
          execFileSync("git", ["init", "--quiet", repository]);
          const marker = `B10_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
          writeFileSync(
            join(repository, "verification-evidence.txt"),
            `verified:${marker}\n`,
          );
          const project = makePublicProject(`b10-${marker}`, repository, true);
          const verificationId = newCapabilityId("ver");
          const verifierExecutionId = newCapabilityId("exe");
          let result!: {
            readonly settlement: unknown;
            readonly verification:
              | {
                  readonly state: string;
                  readonly verdict: string | null;
                  readonly summary_ref: string | null;
                }
              | undefined;
            readonly evidence: ReadonlyArray<{
              readonly tool_invocation_id: string | null;
              readonly observation_ref: string | null;
              readonly call_ref: string | null;
            }>;
            readonly workLifecycle: string | undefined;
            readonly summary: string;
            readonly invocations: Awaited<
              ReturnType<typeof queryDurableEffects>
            >["invocations"];
            readonly providerCalls: typeof calls;
          };
          try {
            await withPublicConversationApp(
              {
                databaseFile: join(root, "b10.db"),
                blobRoot: join(root, "blobs"),
                project,
                modelRef: runtime.model,
                provider: makeHttpProviderClient({
                  runtime,
                  ...(process.env.ARBOR_CAPABILITY_API_KEY === undefined
                    ? {}
                    : { apiKey: process.env.ARBOR_CAPABILITY_API_KEY }),
                  captures: calls,
                }),
                modelCapability: {
                  contextWindow: runtime.contextWindow,
                  outputCeiling: runtime.outputCeiling,
                },
                ...(runtime.authMode === "env"
                  ? { secretRef: secretRef("ARBOR_CAPABILITY_API_KEY") }
                  : {}),
              },
              async (handle) => {
                const mission = {
                  goal: `独立验证隔离证据 ${marker}`,
                  criteria: [
                    {
                      criterionId: "evidence-token",
                      requirement: `verification-evidence.txt 去掉末尾换行后严格等于 verified:${marker}`,
                      required: true,
                    },
                  ],
                  riskRequirements: [
                    "只读验证；不得修改 producer 文件",
                    "结论必须绑定真实 ToolResult evidence",
                  ],
                };
                const fixture = await submitWork(
                  handle,
                  project,
                  `交付 verification-evidence.txt，内容为 verified:${marker}`,
                  {
                    completionExpectation:
                      "独立 Verifier 读取文件并提交 exact-source evidence 与总结。",
                    verificationMission: mission,
                  },
                );
                await handle.run(
                  Effect.gen(function* () {
                    const tx = yield* TransactionPort;
                    const revisions = yield* EnvironmentRevisionStore;
                    yield* tx.transact(
                      revisions.record(
                        parse(ProjectId)(project.projectId),
                        "0",
                      ),
                    );
                  }),
                );
                const started = await handle.run(
                  Effect.gen(function* () {
                    const gateway = yield* CommandGateway;
                    const commandId = parse(CommandId)(newCapabilityId("cmd"));
                    const projectId = parse(ProjectId)(project.projectId);
                    const workspaceId = parse(WorkspaceId)(
                      project.rootWorkspaceId,
                    );
                    const workId = parse(WorkId)(fixture.workId);
                    const payload = {
                      verificationId: parse(VerificationId)(verificationId),
                      workId,
                      observedWorkRevision: 0 as never,
                      missionSnapshot: mission,
                      targetDeliverables: [],
                      verifierExecutionId:
                        parse(ExecutionId)(verifierExecutionId),
                      executableMission: true,
                    };
                    return yield* gateway.execute(
                      {
                        commandType: "StartVerification",
                        commandId,
                        projectId,
                        actor: systemPrincipal as never,
                        issuedAt: yield* (yield* Clock).now(),
                        payload,
                      },
                      {
                        _tag: "System",
                        principal: systemPrincipal,
                        causationRef: `b10:${verificationId}`,
                      },
                      {
                        _tag: "StartVerificationAuthority",
                        principal: systemPrincipal,
                        commandId,
                        semanticRequestFingerprint: semanticRequestFingerprint({
                          commandType: "StartVerification",
                          projectId,
                          actor: systemPrincipal as never,
                          schemaVersion: "1",
                          payload,
                        }),
                        projectId,
                        targetWorkspaceId: workspaceId,
                        workId,
                      },
                    );
                  }),
                );
                if (started.resolution._tag !== "Committed") {
                  throw new Error(
                    `StartVerification failed: ${JSON.stringify(started.resolution)}`,
                  );
                }
                await handle.run(
                  Effect.gen(function* () {
                    const tx = yield* TransactionPort;
                    const verifications = yield* VerificationRepository;
                    const executions = yield* ExecutionRepository;
                    const gateway = yield* CommandGateway;
                    const clock = yield* Clock;
                    const stored = yield* tx.transact(
                      verifications.findById(
                        parse(VerificationId)(verificationId),
                      ),
                    );
                    if (Option.isNone(stored)) {
                      return yield* Effect.die("B10 verification missing");
                    }
                    yield* spawnVerifier(
                      {
                        verification: stored.value,
                        projectId: parse(ProjectId)(project.projectId),
                        ownerWorkspaceId: parse(WorkspaceId)(
                          project.rootWorkspaceId,
                        ),
                        verifierExecutionId:
                          parse(ExecutionId)(verifierExecutionId),
                        missionDigest: mission.goal,
                      },
                      {
                        gateway,
                        verifications,
                        executions,
                        tx,
                        clock,
                        principal: systemPrincipal,
                      },
                    );
                  }),
                );
                const settlement = await handle.run(
                  runExecution(
                    parse(ExecutionId)(verifierExecutionId),
                    { _tag: "WorkSelected" },
                    systemPrincipal,
                  ),
                );
                const durable = await queryDurableEffects(handle);
                result = await handle.run(
                  Effect.gen(function* () {
                    const sql = yield* SqlClient;
                    const verifications = yield* sql.unsafe<{
                      state: string;
                      verdict: string | null;
                      summary_ref: string | null;
                    }>(
                      "SELECT state, verdict, summary_ref FROM verifications WHERE verification_id = ?",
                      [verificationId],
                    );
                    const evidence = yield* sql.unsafe<{
                      tool_invocation_id: string | null;
                      observation_ref: string | null;
                      call_ref: string | null;
                    }>(
                      "SELECT tool_invocation_id, observation_ref, call_ref FROM verification_evidence WHERE verification_id = ?",
                      [verificationId],
                    );
                    const works = yield* sql.unsafe<{ lifecycle: string }>(
                      "SELECT lifecycle FROM works WHERE work_id = ?",
                      [fixture.workId],
                    );
                    const summaryRef = verifications[0]?.summary_ref;
                    const summary =
                      summaryRef === undefined || summaryRef === null
                        ? ""
                        : new TextDecoder().decode(
                            yield* (yield* BlobStorePort).get(summaryRef),
                          );
                    return {
                      settlement,
                      verification: verifications[0],
                      evidence,
                      workLifecycle: works[0]?.lifecycle,
                      summary,
                      invocations: durable.invocations,
                      providerCalls: calls,
                    };
                  }),
                );
              },
            );
            return { marker, ...result };
          } finally {
            rmSync(root, {
              recursive: true,
              force: true,
              maxRetries: 5,
              retryDelay: 100,
            });
          }
        },
        verify: (result) => {
          if (result.verification?.state !== "Concluded") {
            throw new Error("B10 Verification was not concluded");
          }
          if (result.verification.verdict !== "Pass") {
            throw new Error(
              `B10 verifier verdict was ${result.verification.verdict}`,
            );
          }
          if (
            result.verification.summary_ref === null ||
            result.summary.trim().length === 0
          ) {
            throw new Error("B10 conclusion has no durable summary content");
          }
          if (
            !JSON.stringify(result.settlement).includes("VerificationConcluded")
          ) {
            throw new Error("B10 verifier Execution did not settle concluded");
          }
          if (result.workLifecycle !== "Open") {
            throw new Error("B10 Pass bypassed Parent Acceptance");
          }
          if (
            result.evidence.length === 0 ||
            result.evidence.some(
              (row) =>
                row.tool_invocation_id === null ||
                row.observation_ref === null ||
                row.call_ref === null,
            )
          ) {
            throw new Error("B10 evidence lacks exact canonical identity");
          }
          if (
            !result.invocations.some((row) => row.settlement_kind === "Success")
          ) {
            throw new Error("B10 has no successful executable observation");
          }
          const wire = result.providerCalls
            .filter((call) => call.responseBodyBase64 !== undefined)
            .map((call) =>
              Buffer.from(call.responseBodyBase64 as string, "base64").toString(
                "utf8",
              ),
            )
            .join("\n");
          if (
            !wire.includes("record_verification_evidence") ||
            !wire.includes("conclude_verification")
          ) {
            throw new Error("B10 provider trace lacks verification controls");
          }
        },
      });
    },
  );
});
