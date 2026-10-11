import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import {
  main,
  runDaemonForever,
} from "../../../apps/single-workspace/dist/main.js";
import {
  makeProjectResourceProfilePort,
  projectResourceProfilesFromEnvironment,
} from "../../../apps/single-workspace/dist/project-resource-profiles.js";
import { createFunctionalDaemonListenReporter } from "./functional-daemon-lifecycle.mjs";

// This entry is used only by P37 functional child processes. Production
// composition never reads these environment variables and leaves every probe
// absent. Each pause is inside the current process; killing this child models
// an OS-process crash against the shared file-backed SQLite database.
const role = process.env.ARBOR_P37_ROLE;
if (role !== "old" && role !== "new") {
  throw new Error("P37 test child needs role=old|new");
}
const databaseFile = process.env.ARBOR_DB;
if (databaseFile === undefined)
  throw new Error("P37 test child needs ARBOR_DB");

const gateDirectory = join(dirname(databaseFile), "p37-gates");
const emit = (event) =>
  process.stdout.write(
    `${JSON.stringify({ tag: "P37_DELIVER_PROBE", role, ...event })}\n`,
  );

const waitForGate = async (name, event) => {
  const gatePath = join(gateDirectory, `${role}-${name}.release`);
  const deadline = Date.now() + 120_000;
  while (!existsSync(gatePath)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `P37 gate timed out: role=${role}, gate=${name}, event=${JSON.stringify(event)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const holdConfiguredBoundary = async (boundary, event) => {
  if (
    process.env.ARBOR_P37_PAUSE_ROLE !== role ||
    !process.env.ARBOR_P37_PAUSE_BOUNDARY?.split(",").includes(boundary)
  ) {
    return;
  }
  emit({ ...event, boundary });
  await waitForGate(`boundary-${boundary}`, event);
};

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
    event.boundary === "AH7AfterActionIntentCommit" &&
    event.actionIndex === 0
  ) {
    const actionKind = readActionKind(event.logicalActionId);
    const configuredKind = process.env.ARBOR_P37_GATE_ACTION_KIND;
    if (configuredKind === undefined || configuredKind === actionKind) {
      emit({ ...event, actionKind });
      await holdConfiguredBoundary(event.boundary, event);
    }
  }
  if (
    event.boundary === "AH10AfterControlHandlerReturnBeforeObservationCommit"
  ) {
    emit(event);
    await holdConfiguredBoundary(event.boundary, event);
  }
};

const executionLeaseQualificationProbe = async (event) => {
  if (event.boundary === "AH10AfterLeaseAcquired") emit(event);
  if (event.boundary === "AH10BeforeLeaseRenewal") {
    emit(event);
    await holdConfiguredBoundary(event.boundary, event);
  }
};

const gatewayQualificationProbe = async (event) => {
  if (event.boundary === "AH10BeforeFencedReceiptCommit") {
    emit(event);
    await holdConfiguredBoundary(event.boundary, event);
  }
};

const deliverReplayQualificationProbe = async (event) => {
  if (event.boundary === "BeforeDeliverReplayAttentionCommit") {
    emit(event);
    await holdConfiguredBoundary(event.boundary, event);
    return;
  }
  if (event.boundary === "AfterDeliverReplayAttentionCommit") {
    emit(event);
    await holdConfiguredBoundary(event.boundary, event);
  }
};

const attentionProjectionQualificationProbe = async (event) => {
  if (event.boundary === "P10AfterAttentionRowWriteBeforeConsumerCommit") {
    emit(event);
    await holdConfiguredBoundary(event.boundary, event);
  }
};

const attentionPollQualificationProbe = async (event) => {
  if (event.boundary === "P10AfterDeliverAttentionConsumerCommit") {
    emit(event);
    await holdConfiguredBoundary(event.boundary, event);
  }
};

const config = {
  tickIntervalMs: 25,
  onWebTransportListening: createFunctionalDaemonListenReporter(),
  projectResourceProfiles: makeProjectResourceProfilePort(
    projectResourceProfilesFromEnvironment(),
  ),
  webTransport: {
    staticRoot: process.env.ARBOR_WEB_DIST,
    port: Number(process.env.ARBOR_HTTP_PORT),
    host: "127.0.0.1",
  },
  qualificationProbe,
  gatewayQualificationProbe,
  executionLeaseQualificationProbe,
  deliverReplayQualificationProbe,
  attentionProjectionQualificationProbe,
  // Added by the P37 L5 composition seam. Until that implementation is
  // integrated this is intentionally an unknown no-op config property.
  attentionPollQualificationProbe,
};

await Effect.runPromise(
  Effect.provide(Effect.scoped(runDaemonForever(config)), main(config)),
);
