import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import {
  main,
  runDaemonForever,
} from "../../../apps/single-workspace/dist/main.js";

const role = process.env.ARBOR_AH10_ROLE;
if (role !== "old" && role !== "new") {
  throw new Error("AH10 test child needs role=old|new");
}
const databaseFile = process.env.ARBOR_DB;
if (databaseFile === undefined)
  throw new Error("AH10 test child needs ARBOR_DB");
const gateDirectory = join(dirname(databaseFile), "ah10-gates");

const waitForGate = async (name, event) => {
  const gatePath = join(gateDirectory, `${role}-${name}.release`);
  const deadline = Date.now() + 120_000;
  while (!existsSync(gatePath)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `AH10 gate timed out: role=${role}, gate=${name}, event=${JSON.stringify(event)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const emit = (event) =>
  process.stdout.write(
    `${JSON.stringify({ tag: "AH10_PROBE", role, ...event })}\n`,
  );

const readActionKind = (logicalActionId) => {
  if (logicalActionId === undefined) return undefined;
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT action_kind FROM agent_loop_step_actions WHERE logical_action_id = ?",
      )
      .get(logicalActionId)?.action_kind;
  } finally {
    db.close();
  }
};

const qualificationProbe = async (event) => {
  if (
    event.boundary === "AH10AfterControlHandlerReturnBeforeObservationCommit"
  ) {
    const actionKind = readActionKind(event.logicalActionId);
    const gateActionKind = process.env.ARBOR_AH10_PAUSE_AFTER_CONTROL_KIND;
    if (
      process.env.ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN === "1" &&
      (gateActionKind === undefined || actionKind === gateActionKind)
    ) {
      emit({ ...event, actionKind });
      await waitForGate("control-return", event);
    }
  }
  if (
    event.boundary === "AH7AfterActionIntentCommit" &&
    event.actionIndex === 0
  ) {
    const actionKind = readActionKind(event.logicalActionId);
    emit({ ...event, actionKind });
    const gateActionKind = process.env.ARBOR_AH10_GATE_ACTION_KIND;
    if (gateActionKind === undefined || actionKind === gateActionKind) {
      await waitForGate("action-intent", event);
    }
  }
  if (
    role === "old" &&
    event.boundary === "AH9BeforeTerminalActionCommit" &&
    event.actionIndex === 0 &&
    process.env.ARBOR_AH10_PAUSE_BEFORE_TERMINAL_ACTION === "1"
  ) {
    const actionKind = readActionKind(event.logicalActionId);
    if (actionKind === process.env.ARBOR_AH10_GATE_ACTION_KIND) {
      emit({ ...event, actionKind });
      await waitForGate("terminal-action", event);
    }
  }
  if (
    role === "new" &&
    event.boundary === "AH7AfterActionResultCommit" &&
    event.actionIndex === 0
  ) {
    emit(event);
    await waitForGate("action-result", event);
  }
};

const executionLeaseQualificationProbe = async (event) => {
  if (event.boundary === "AH10AfterLeaseAcquired") emit(event);
  if (event.boundary === "AH10BeforeLeaseRenewal") {
    emit(event);
    await waitForGate("lease-renewal", event);
  }
};

const gatewayQualificationProbe = async (event) => {
  if (role !== "old" || event.boundary !== "AH10BeforeFencedReceiptCommit") {
    return;
  }
  emit(event);
  if (process.env.ARBOR_AH10_PAUSE_BEFORE_FENCED_RECEIPT === "1") {
    await waitForGate("fenced-receipt", event);
  }
};

const port = Number(process.env.ARBOR_HTTP_PORT);
const config = {
  tickIntervalMs: 25,
  webTransport: {
    staticRoot: process.env.ARBOR_WEB_DIST,
    port,
    host: "127.0.0.1",
  },
  qualificationProbe,
  executionLeaseQualificationProbe,
  gatewayQualificationProbe,
};

await Effect.runPromise(
  Effect.provide(Effect.scoped(runDaemonForever(config)), main(config)),
);
