import { writeFileSync } from "node:fs";
import { Effect } from "effect";
import {
  buildSingleWorkspaceLayer,
  ProductionDaemonService,
} from "../../../apps/single-workspace/dist/index.js";

const [databaseFile, projectId, mode, markerFile] = process.argv.slice(2);
if (!databaseFile || !projectId || !mode || !markerFile) {
  throw new Error("expected databaseFile, projectId, mode, and markerFile");
}

const config = {
  databaseFile,
  projectId,
  ...(mode === "hold-before-commit"
    ? {
        attentionProjectionQualificationProbe: async (event) => {
          if (
            event.boundary ===
              "P10AfterAttentionRowWriteBeforeConsumerCommit" &&
            event.projectId === projectId
          ) {
            writeFileSync(markerFile, event.attentionFactId, "utf8");
            await new Promise(() => {});
          }
        },
      }
    : {}),
};

const layer = buildSingleWorkspaceLayer(config);
await Effect.runPromise(
  Effect.scoped(
    Effect.provide(
      Effect.gen(function* () {
        const daemon = yield* ProductionDaemonService;
        yield* daemon.daemon.start;
        yield* daemon.daemon.pollConsumers;
        writeFileSync(markerFile, "poll-committed", "utf8");
        yield* Effect.promise(() => new Promise(() => {}));
      }),
      layer,
    ),
  ),
);
