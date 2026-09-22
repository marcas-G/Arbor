import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  layer,
  P12_MIGRATIONS,
  runMigrations,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  HealthPort,
  P12_MIGRATION_BASELINE,
  PersistenceHealthProbe,
  type PersistenceHealthProbeService,
  type ReadinessState,
} from "../packages/ports/src/index.js";
import {
  deriveUsage,
  HealthPortLive,
  isReady,
  type UsageFacts,
  UsageService,
  UsageServiceLive,
} from "../packages/projection-runtime/src/index.js";

// --- P12 `04` §3: Usage derivation (E-15) --------------------------------

const factsNoPricing: UsageFacts = {
  turns: [
    {
      providerTurnId: "ptn-1",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
      },
    },
  ],
  attempts: [{ providerTurnId: "ptn-1", attemptNo: 1, outcome: "Success" }],
  toolInvocations: [{ invocationId: "inv-1", outcome: "Success" }],
  executions: [
    {
      executionId: "exe-1",
      admittedAt: "2026-09-22T00:00:00.000Z",
      settledAt: "2026-09-22T00:00:02.000Z",
    },
  ],
};

describe("P12-004 UsageCost derivation (E-15, CI-3)", () => {
  it("derive(attemptWithoutPricingVersion).cost._tag === 'Unknown' (unknown cost never 0)", () => {
    const derived = deriveUsage(factsNoPricing);
    expect(derived.cost._tag).toBe("Unknown");
    expect(derived.cost).toEqual({
      _tag: "Unknown",
      reason: "PricingUnavailable",
    });
  });

  it("no path constructs Known { amount: 0 } when pricing is absent", () => {
    const candidates: ReadonlyArray<UsageFacts> = [
      factsNoPricing,
      { ...factsNoPricing },
      {
        ...factsNoPricing,
        priceSheet: { version: "", currency: "USD", unitPrices: {} },
      },
      {
        ...factsNoPricing,
        priceSheet: { version: "ps-1", currency: "", unitPrices: {} },
      },
    ];
    for (const facts of candidates) {
      const cost = deriveUsage(facts).cost;
      expect(cost._tag).toBe("Unknown");
      if (cost._tag === "Known") {
        expect(cost.amount).not.toBe(0);
      }
    }
  });

  it("turns without usage -> Unknown('UsageUnavailable') (never Known { amount: 0 })", () => {
    expect(deriveUsage({ ...factsNoPricing, turns: [] }).cost).toEqual({
      _tag: "Unknown",
      reason: "UsageUnavailable",
    });
  });

  it("some contributing turns lack usage -> Unknown('PartialUsage')", () => {
    const derived = deriveUsage({
      ...factsNoPricing,
      turns: [
        { providerTurnId: "ptn-1", usage: { inputTokens: 1, outputTokens: 1 } },
        { providerTurnId: "ptn-2" },
      ],
    });
    expect(derived.cost).toEqual({ _tag: "Unknown", reason: "PartialUsage" });
  });

  it("Known derives only from usage facts x a versioned price sheet", () => {
    const derived = deriveUsage({
      ...factsNoPricing,
      priceSheet: {
        version: "ps-2026-09",
        currency: "USD",
        unitPrices: { inputTokens: 2, outputTokens: 3 },
      },
    });
    expect(derived.cost).toEqual({
      _tag: "Known",
      amount: 100 * 2 + 50 * 3,
      currency: "USD",
      priceSheetVersion: "ps-2026-09",
    });
  });

  it("aggregates tokens / turns / attempts / computeMs from the declared canonical facts", () => {
    const derived = deriveUsage(factsNoPricing);
    expect(derived.tokens).toEqual({
      input: 100,
      output: 50,
      cacheRead: 10,
      cacheWrite: 5,
    });
    expect(derived.turns).toBe(1);
    expect(derived.attempts).toBe(1);
    expect(derived.computeMs).toBe(2000);
  });

  it("UsageService.derive is pure (R = never) and matches the free derive", async () => {
    const derived = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* UsageService;
        return service.derive(factsNoPricing);
      }).pipe(Effect.provide(UsageServiceLive)),
    );
    expect(derived).toEqual(deriveUsage(factsNoPricing));
  });
});

// --- P12 `04` §4: Health / readiness (E-17) -------------------------------

const makeStubProbe = (
  initial: ReadinessState,
): {
  readonly layer: Layer.Layer<PersistenceHealthProbe>;
  readonly set: (next: ReadinessState) => void;
} => {
  let state = initial;
  const service: PersistenceHealthProbeService = {
    probe: () => Effect.sync(() => state),
  };
  return {
    layer: Layer.succeed(PersistenceHealthProbe, service),
    set: (next) => {
      state = next;
    },
  };
};

const readReadiness = (
  probe: Layer.Layer<PersistenceHealthProbe>,
): Promise<ReadinessState> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const health = yield* HealthPort;
      return yield* health.readiness();
    }).pipe(Effect.provide(Layer.provideMerge(HealthPortLive, probe))),
  );

describe("P12-004 Health readiness (E-17)", () => {
  it("readiness = dbOpen AND migrationBaseline AND t1RecoveryComplete; true only after T1", async () => {
    const probe = makeStubProbe({
      dbOpen: false,
      migrationBaseline: false,
      t1RecoveryComplete: false,
    });

    expect(isReady(await readReadiness(probe.layer))).toBe(false);

    probe.set({
      dbOpen: true,
      migrationBaseline: false,
      t1RecoveryComplete: false,
    });
    expect(isReady(await readReadiness(probe.layer))).toBe(false);

    probe.set({
      dbOpen: true,
      migrationBaseline: true,
      t1RecoveryComplete: false,
    });
    expect(isReady(await readReadiness(probe.layer))).toBe(false);

    probe.set({
      dbOpen: true,
      migrationBaseline: true,
      t1RecoveryComplete: true,
    });
    expect(isReady(await readReadiness(probe.layer))).toBe(true);
    expect(await readReadiness(probe.layer)).toEqual({
      dbOpen: true,
      migrationBaseline: true,
      t1RecoveryComplete: true,
    });
  });

  it("liveness reports processAlive and readiness reads only PersistenceHealthProbe", async () => {
    const probe = makeStubProbe({
      dbOpen: true,
      migrationBaseline: true,
      t1RecoveryComplete: true,
    });
    const live = await Effect.runPromise(
      Effect.gen(function* () {
        const health = yield* HealthPort;
        return yield* health.liveness();
      }).pipe(Effect.provide(Layer.provideMerge(HealthPortLive, probe.layer))),
    );
    expect(live).toEqual({ processAlive: true });
  });

  it("migrationBaseline is PRAGMA user_version == max(P12_MIGRATIONS) == 13", async () => {
    expect(P12_MIGRATION_BASELINE).toBe(
      Math.max(...P12_MIGRATIONS.map((migration) => migration.id)),
    );
    expect(P12_MIGRATION_BASELINE).toBe(13);

    const base = layer({ filename: ":memory:" });
    const probe = Layer.provide(
      Layer.effect(
        PersistenceHealthProbe,
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          return {
            probe: () =>
              sql.unsafe<{ user_version: number }>("PRAGMA user_version").pipe(
                Effect.map((rows) => ({
                  dbOpen: true,
                  migrationBaseline:
                    Number(rows[0]?.user_version ?? 0) ===
                    P12_MIGRATION_BASELINE,
                  t1RecoveryComplete: true,
                })),
                Effect.orDie,
              ),
          } satisfies PersistenceHealthProbeService;
        }),
      ),
      base,
    );
    const app = Layer.mergeAll(
      base,
      probe,
      Layer.provide(HealthPortLive, probe),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            const health = yield* HealthPort;
            const before = yield* health.readiness();
            expect(before.migrationBaseline).toBe(false);
            expect(isReady(before)).toBe(false);

            yield* runMigrations(P12_MIGRATIONS);

            const after = yield* health.readiness();
            expect(after.migrationBaseline).toBe(true);
            expect(isReady(after)).toBe(true);
          }),
          app,
        ),
      ),
    );
  });
});
