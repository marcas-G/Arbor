import {
  EnvironmentRevisionStore,
  OwnershipWriteService,
  ResourceOwnershipRepository,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { P1_MIGRATIONS, runMigrations } from "../../src/index.js";
import {
  address,
  claim,
  makeApp,
  OBSERVED,
  projectId,
  seed,
  workspaceId,
} from "./support.js";

describe("ownership write service", () => {
  it("writes claims and records the observed environment revision", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P1_MIGRATIONS);
      yield* seed;
      const ownership = yield* OwnershipWriteService;
      const revisions = yield* EnvironmentRevisionStore;
      const repository = yield* ResourceOwnershipRepository;
      const tx = yield* TransactionPort;
      const result = yield* ownership.resolveAndWrite(
        projectId,
        [address],
        [claim("c1", "/repo/a")],
      );
      const current = yield* tx.transact(revisions.current(projectId));
      const active = yield* tx.transact(
        repository.listActiveByWorkspace(workspaceId),
      );
      return { result, current, active };
    });
    const { result, current, active } = await Effect.runPromise(
      Effect.provide(program, makeApp()),
    );
    expect(result.regions).toHaveLength(1);
    expect(result.claims).toHaveLength(1);
    expect(Option.isSome(current) && current.value).toBe(OBSERVED);
    expect(active.map((entry) => entry.claimId)).toEqual(["c1"]);
    expect(active[0]?.releasedAt).toBeNull();
  });

  it("rejects overlapping active claims", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P1_MIGRATIONS);
      yield* seed;
      const ownership = yield* OwnershipWriteService;
      yield* ownership.resolveAndWrite(
        projectId,
        [address],
        [claim("c1", "/repo/a")],
      );
      return yield* ownership
        .resolveAndWrite(projectId, [address], [claim("c2", "/repo/a/b")])
        .pipe(Effect.flip);
    });
    const error = await Effect.runPromise(Effect.provide(program, makeApp()));
    expect(error).toMatchObject({
      _tag: "PersistenceConstraintViolation",
      repository: "ResourceOwnershipRepository",
      constraint: "active-resource-overlap",
    });
  });

  it("allows a new claim once the conflicting claim is released", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P1_MIGRATIONS);
      yield* seed;
      const ownership = yield* OwnershipWriteService;
      const repository = yield* ResourceOwnershipRepository;
      const tx = yield* TransactionPort;
      yield* ownership.resolveAndWrite(
        projectId,
        [address],
        [claim("c1", "/repo/a")],
      );
      yield* tx.transact(repository.releaseClaim("c1", "t1"));
      return yield* ownership.resolveAndWrite(
        projectId,
        [address],
        [claim("c2", "/repo/a/b")],
      );
    });
    const result = await Effect.runPromise(Effect.provide(program, makeApp()));
    expect(result.claims.map((entry) => entry.claimId)).toEqual(["c2"]);
  });

  it("fails with ResourceResolutionStale when the revision moved", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P1_MIGRATIONS);
      yield* seed;
      const revisions = yield* EnvironmentRevisionStore;
      const ownership = yield* OwnershipWriteService;
      const tx = yield* TransactionPort;
      yield* tx.transact(revisions.record(projectId, "rev-old"));
      return yield* ownership
        .resolveAndWrite(projectId, [address], [claim("c1", "/repo/a")])
        .pipe(Effect.flip);
    });
    const error = await Effect.runPromise(Effect.provide(program, makeApp()));
    expect(error._tag).toBe("ResourceResolutionStale");
  });
});
