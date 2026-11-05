import { Effect, Layer, Option } from "effect";
import {
  layer,
  ToolInvocationStoreLive,
  TransactionPortLive,
} from "../../../adapters/persistence-sqlite/dist/index.js";
import {
  ToolInvocationStore,
  TransactionPort,
} from "../../../packages/ports/dist/index.js";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`required environment variable absent: ${name}`);
  return value;
};

const databaseFile = required("ARBOR_AH7_STORE_DB");
const mode = required("ARBOR_AH7_STORE_MODE");
const boundary = process.env.ARBOR_AH7_STORE_BOUNDARY ?? "none";
const invocationId = required("ARBOR_AH7_STORE_INVOCATION_ID");
const approvalId = required("ARBOR_AH7_STORE_APPROVAL_ID");
const executionId = required("ARBOR_AH7_STORE_EXECUTION_ID");
const workspaceId = required("ARBOR_AH7_STORE_WORKSPACE_ID");
const workerId = required("ARBOR_AH7_STORE_WORKER_ID");
const workerIncarnationId = required("ARBOR_AH7_STORE_WORKER_INCARNATION_ID");
const now = "2026-10-11T00:00:01.000Z";
const fence = {
  executionId,
  workerId,
  workerIncarnationId,
  fencingGeneration: 0,
};
const intent = {
  invocationId,
  executionId,
  workspaceId,
  toolName: "read",
  toolVersion: "1",
  sideEffectSemantics: "Idempotent",
  argumentsJson: "{}",
  resolvedRegions: [],
  approvalId,
  intentAt: now,
};

const sqlite = layer({ filename: databaseFile });
const app = Layer.mergeAll(
  sqlite,
  Layer.provide(TransactionPortLive, sqlite),
  Layer.provide(ToolInvocationStoreLive, sqlite),
);

const pause = async () => {
  // Keep the OS process alive after the probe message. An unresolved Promise
  // alone does not keep Node's event loop open, so without this referenced
  // timer the child could exit naturally before the parent sends SIGKILL.
  setInterval(() => {}, 1_000);
  process.stdout.write(
    `${JSON.stringify({
      tag: "AH7_P4_STORE_BOUNDARY",
      mode,
      boundary,
      invocationId,
      executionId,
      pid: process.pid,
      childAlive: true,
    })}\n`,
  );
  await new Promise(() => {});
};

const program = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  const store = yield* ToolInvocationStore;

  if (mode === "claim") {
    yield* tx.transact(
      Effect.gen(function* () {
        const prior = yield* store.findById(invocationId);
        const approval = yield* store.findApproval(approvalId);
        if (
          Option.isSome(prior) &&
          prior.value.executionId === executionId &&
          prior.value.workspaceId === workspaceId &&
          prior.value.toolName === intent.toolName &&
          prior.value.toolVersion === intent.toolVersion &&
          prior.value.argumentsJson === intent.argumentsJson &&
          prior.value.approvalId === approvalId &&
          prior.value.effectAdmissionState === "NotAdmitted" &&
          prior.value.settlement === null &&
          Option.isSome(approval) &&
          approval.value.consumedBy === invocationId
        ) {
          return;
        }

        const intentResult = yield* store.recordIntent(intent, fence, now);
        if (intentResult === "ExecutionStopping") {
          return yield* Effect.fail(
            new Error("claim rejected by StopExecution"),
          );
        }
        const consumed = yield* store.consumeApproval(
          approvalId,
          invocationId,
          fence,
          now,
        );
        if (!consumed) {
          return yield* Effect.fail(new Error("approval claim CAS lost"));
        }
        if (boundary === "beforeCommit") yield* Effect.promise(pause);
      }),
    );
    if (boundary === "afterCommit") yield* Effect.promise(pause);
    return;
  }

  if (mode === "denial") {
    yield* tx.transact(
      Effect.gen(function* () {
        const result = yield* store.recordNoEffectDenial(
          intent,
          "InvocationAuthorityDenied",
          now,
          fence,
          now,
        );
        if (result === "ExecutionStopping") {
          return yield* Effect.fail(
            new Error("no-effect denial raced StopExecution"),
          );
        }
        if (boundary === "beforeCommit") yield* Effect.promise(pause);
      }),
    );
    if (boundary === "afterCommit") yield* Effect.promise(pause);
    return;
  }

  if (mode === "interruption") {
    const settled = yield* tx.transact(
      Effect.gen(function* () {
        const result = yield* store.recordNoEffectInterruption(
          invocationId,
          now,
          fence,
          now,
        );
        if (!result) {
          return yield* Effect.fail(new Error("interruption CAS lost"));
        }
        if (boundary === "beforeCommit") yield* Effect.promise(pause);
        return result;
      }),
    );
    if (boundary === "afterCommit") yield* Effect.promise(pause);
    return settled;
  }

  return yield* Effect.fail(new Error(`unknown store-process mode: ${mode}`));
});

await Effect.runPromise(Effect.provide(program, app));
