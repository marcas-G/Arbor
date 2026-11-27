import { Effect } from "effect";

const { DatabaseWriterLockClient, databaseWriterLockLayer } = await import(
  "../../../adapters/persistence-sqlite/dist/index.js"
);
const [lockFilename] = process.argv.slice(2);
if (lockFilename === undefined) {
  throw new Error("usage: release-construction-child.mjs <lock-file>");
}

const scopedLayer = Effect.scoped(
  Effect.gen(function* () {
    const client = yield* DatabaseWriterLockClient;
    const permit = yield* client.acquire("RuntimeShared");
    const releaseEffect = client.release(permit);
    void releaseEffect;
  }).pipe(Effect.provide(databaseWriterLockLayer(lockFilename, 250))),
);

await Effect.runPromise(scopedLayer);
process.stdout.write("LAYER_CLOSED\n");
process.stdin.setEncoding("utf8");
await new Promise((resolve) => process.stdin.once("data", resolve));
