import { ArtifactService, TransactionPort } from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { ArtifactServiceLive } from "../../../packages/tool-runtime/src/index.js";
import { BlobStorePortLive } from "../../blob-local/src/index.js";
import {
  ArtifactMetadataRepositoryLive,
  layer,
  P4_MIGRATIONS,
  runMigrations,
  TransactionPortLive,
} from "../src/index.js";

const makeApp = () => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base);
  const deps = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(ArtifactMetadataRepositoryLive, infra),
    BlobStorePortLive,
  );
  return Layer.mergeAll(infra, deps, Layer.provide(ArtifactServiceLive, deps));
};

describe("P4 artifact service", () => {
  it("stores bytes as an artifact and loads them back", async () => {
    const app = makeApp();
    const program = Effect.gen(function* () {
      yield* runMigrations(P4_MIGRATIONS);
      const artifacts = yield* ArtifactService;
      const tx = yield* TransactionPort;
      const bytes = new TextEncoder().encode("hello artifact");
      const artifact = yield* tx.transact(
        artifacts.store(bytes, "tool-result", {}, "t"),
      );
      const loaded = yield* tx.transact(artifacts.load(artifact.artifactId));
      const missing = yield* tx.transact(
        artifacts.load("art_missing" as never),
      );
      return { artifact, loaded, missing };
    });
    const r = await Effect.runPromise(
      Effect.provide(program, app) as Effect.Effect<unknown, unknown, never>,
    );
    const artifact = (
      r as { artifact: { byteSize: number; contentHash: string } }
    ).artifact;
    expect(artifact.byteSize).toBe(14);
    expect(artifact.contentHash).toHaveLength(64);
    const loaded = (r as { loaded: Option.Option<Uint8Array> }).loaded;
    expect(Option.isSome(loaded)).toBe(true);
    if (Option.isSome(loaded)) {
      expect(new TextDecoder().decode(loaded.value)).toBe("hello artifact");
    }
    expect(
      Option.isNone((r as { missing: Option.Option<Uint8Array> }).missing),
    ).toBe(true);
  });
});
