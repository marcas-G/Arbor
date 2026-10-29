import { Effect } from "effect";

const { P39WriterLockClient, p39WriterLockLayer } = await import(
  "../../../adapters/persistence-sqlite/dist/index.js"
);
const [lockFilename] = process.argv.slice(2);
if (lockFilename === undefined) {
  throw new Error("usage: p39-release-construction-child.mjs <lock-file>");
}

const scopedLayer = Effect.scoped(
  Effect.gen(function* () {
    const client = yield* P39WriterLockClient;
    const permit = yield* client.acquire("RuntimeShared");
    const releaseEffect = client.release(permit);
    void releaseEffect;
  }).pipe(Effect.provide(p39WriterLockLayer(lockFilename, 250))),
);

await Effect.runPromise(scopedLayer);
process.stdout.write("LAYER_CLOSED\n");
process.stdin.setEncoding("utf8");
await new Promise((resolve) => process.stdin.once("data", resolve));
