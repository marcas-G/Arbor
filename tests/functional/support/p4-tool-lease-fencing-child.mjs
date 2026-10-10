import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import {
  main,
  runDaemonForever,
} from "../../../apps/single-workspace/dist/main.js";
import {
  makeProjectResourceProfilePort,
  projectResourceProfilesFromEnvironment,
} from "../../../apps/single-workspace/dist/project-resource-profiles.js";
import { SHELL_DEFINITION } from "../../../packages/tool-runtime/dist/catalog.js";

const role = process.env.ARBOR_P4_FENCE_ROLE;
if (role !== "old" && role !== "new") {
  throw new Error("P4 fencing child needs role=old|new");
}
const databaseFile = process.env.ARBOR_DB;
if (databaseFile === undefined) {
  throw new Error("P4 fencing child needs ARBOR_DB");
}
const gateDirectory = join(dirname(databaseFile), "p4-fence-gates");

const emit = (event) =>
  process.stdout.write(
    `${JSON.stringify({ tag: "P4_FENCE_PROBE", role, ...event })}\n`,
  );

const waitForGate = async (name, event) => {
  const gatePath = join(gateDirectory, `${role}-${name}.release`);
  const deadline = Date.now() + 120_000;
  while (!existsSync(gatePath)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `P4 fencing gate timed out: role=${role}, gate=${name}, event=${JSON.stringify(event)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

if (process.env.ARBOR_P4_FENCE_NON_IDEMPOTENT === "1") {
  SHELL_DEFINITION.hash = "shell-v2-p4-lease-fencing";
  SHELL_DEFINITION.sideEffectSemantics = "NonIdempotent";
}

const toolQualificationProbe = async (event) => {
  if (
    role === "old" &&
    event.boundary === "AH7AfterToolEffectBeforeSettlement"
  ) {
    emit(event);
    await waitForGate("tool-effect", event);
    return;
  }
  if (
    role === "old" &&
    (event.boundary === "AH7AfterToolSettlementCommit" ||
      event.boundary === "AH7ToolSettlementFenceRejected")
  ) {
    emit(event);
  }
};

const executionLeaseQualificationProbe = async (event) => {
  if (event.boundary === "AH10AfterLeaseAcquired") {
    emit(event);
    if (role === "new" && process.env.ARBOR_P4_FENCE_PAUSE_NEW === "1") {
      await waitForGate("new-driver", event);
    }
    return;
  }
  if (
    role === "old" &&
    event.boundary === "AH10BeforeLeaseRenewal" &&
    existsSync(join(gateDirectory, "old-freeze-renewal.request"))
  ) {
    emit(event);
    await waitForGate("old-renewal", event);
  }
};

const port = Number(process.env.ARBOR_HTTP_PORT);
const config = {
  tickIntervalMs: 25,
  projectResourceProfiles: makeProjectResourceProfilePort(
    projectResourceProfilesFromEnvironment(),
  ),
  webTransport: {
    staticRoot: process.env.ARBOR_WEB_DIST,
    port,
    host: "127.0.0.1",
  },
  toolQualificationProbe,
  executionLeaseQualificationProbe,
};

await Effect.runPromise(
  Effect.provide(Effect.scoped(runDaemonForever(config)), main(config)),
);
