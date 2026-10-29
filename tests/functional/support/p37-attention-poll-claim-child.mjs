import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import {
  AttentionPollStoreLive,
  layer,
  TransactionPortLive,
} from "../../../adapters/persistence-sqlite/dist/index.js";
import {
  AttentionPollStore,
  TransactionPort,
} from "../../../packages/ports/dist/index.js";

const [databaseFile, role, gateDirectory, now, mode, leaseTtlText] =
  process.argv.slice(2);
if (!databaseFile || !role || !gateDirectory || !now || !mode) {
  throw new Error(
    "expected databaseFile, role, gateDirectory, now, mode, and optional leaseTtlMs",
  );
}
const leaseTtlMs = Number(leaseTtlText ?? 5_000);

writeFileSync(join(gateDirectory, `${role}.ready`), "ready", "utf8");
const goFile = join(gateDirectory, "go");
const deadline = Date.now() + 30_000;
while (!existsSync(goFile)) {
  if (Date.now() >= deadline)
    throw new Error("P37 claim race barrier timed out");
  await new Promise((resolve) => setTimeout(resolve, 10));
}

const sqlite = layer({ filename: databaseFile });
const app = Layer.mergeAll(
  sqlite,
  Layer.provide(AttentionPollStoreLive, sqlite),
  Layer.provide(TransactionPortLive, sqlite),
);
const result = await Effect.runPromise(
  Effect.scoped(
    Effect.provide(
      Effect.gen(function* () {
        const poll = yield* AttentionPollStore;
        const transactions = yield* TransactionPort;
        const result = yield* transactions.transact(
          poll.tryClaim({
            leaseOwner: `worker:${role}`,
            now,
            leaseTtlMs,
            baseBackoffMs: 1_000,
            maxBackoffMs: 8_000,
            backoffExponentCap: 3,
          }),
        );
        if (mode === "complete" && result._tag === "Claimed") {
          yield* transactions.transact(poll.completeSuccess(result.claim, now));
        }
        return result;
      }),
      app,
    ),
  ),
);
writeFileSync(
  join(gateDirectory, `${role}.result.json`),
  JSON.stringify(result),
  "utf8",
);
if (mode === "hold") await new Promise(() => {});
