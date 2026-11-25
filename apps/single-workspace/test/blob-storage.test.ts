import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BlobStorePort } from "@arbor/ports";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createCurrentSchemaTestDatabase } from "../../../tests/support/schema44-database.js";
import { buildSingleWorkspaceLayer } from "../src/composition.js";

describe("production content storage wiring", () => {
  it.each([false, true])(
    "persists and reopens content using the effective root (custom=%s)",
    async (custom) => {
      const fixture = await createCurrentSchemaTestDatabase({
        prefix: "arbor-blob-composition-",
      });
      const root = custom
        ? join(fixture.directory, "custom-blobs")
        : `${fixture.databaseFilename}.blobs`;
      const config = {
        databaseFile: fixture.databaseFilename,
        ...(custom ? { blobRoot: root } : {}),
      };
      const bytes = new TextEncoder().encode("persistent production content");
      const run = <A>(
        action: (store: BlobStorePort["Service"]) => Effect.Effect<A, unknown>,
      ) =>
        Effect.runPromise(
          Effect.scoped(
            Effect.provide(
              Effect.flatMap(BlobStorePort, action),
              buildSingleWorkspaceLayer(config),
            ),
          ),
        );
      try {
        const ref = await run((store) => store.put(bytes));
        expect(existsSync(join(root, ref))).toBe(true);
        expect(new Uint8Array(readFileSync(join(root, ref)))).toEqual(bytes);
        expect(await run((store) => store.get(ref))).toEqual(bytes);
      } finally {
        fixture.cleanup();
      }
    },
    120_000,
  );
});
