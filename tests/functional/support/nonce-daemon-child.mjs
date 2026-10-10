import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import {
  main,
  runDaemonForever,
} from "../../../apps/single-workspace/dist/main.js";
import {
  makeProjectResourceProfilePort,
  projectResourceProfilesFromEnvironment,
} from "../../../apps/single-workspace/dist/project-resource-profiles.js";
import { parse, WorkspaceId } from "../../../packages/domain/dist/index.js";

const nonce = randomUUID();
const pid = process.pid;
const report = (tag, fields) =>
  process.stdout.write(`${JSON.stringify({ tag, nonce, pid, ...fields })}\n`);

report("FUNCTIONAL_DAEMON_STARTED", {});

const projectResourceProfiles = makeProjectResourceProfilePort(
  projectResourceProfilesFromEnvironment(),
);
const port = Number(process.env.ARBOR_HTTP_PORT ?? "0");
const host = process.env.ARBOR_HTTP_HOST ?? "127.0.0.1";
const webTransport = {
  ...(process.env.ARBOR_WEB_DIST !== undefined
    ? { staticRoot: process.env.ARBOR_WEB_DIST }
    : {}),
  port,
  host,
};
const config = {
  projectResourceProfiles,
  webTransport,
  onWebTransportListening: (actualPort) =>
    report("FUNCTIONAL_DAEMON_LISTENING", { port: actualPort }),
  ...(process.env.ARBOR_WORKSPACE_ID !== undefined
    ? { workspaceId: parse(WorkspaceId)(process.env.ARBOR_WORKSPACE_ID) }
    : {}),
};

await Effect.runPromise(
  Effect.provide(
    Effect.scoped(runDaemonForever(config)),
    main({ projectResourceProfiles }),
  ),
);
