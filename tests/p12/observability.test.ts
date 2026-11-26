import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  layer,
  P12_MIGRATIONS,
  runMigrations,
} from "../../adapters/persistence-sqlite/src/index.js";
import {
  HealthPort,
  P12_MIGRATION_BASELINE,
  PersistenceHealthProbe,
  type PersistenceHealthProbeService,
  type ReadinessState,
} from "../../packages/ports/src/index.js";
import {
  deriveUsage,
  HealthPortLive,
  isReady,
  type UsageFacts,
  UsageService,
  UsageServiceLive,
} from "../../packages/projection-runtime/src/index.js";
import { ensureLegacyProjectResourceSourceFixture } from "../support/legacy-project-resource-source.js";

// ---------------------------------------------------------------------------
// story 5 (`04`): observable usage derived from real facts; unknown cost ≠ 0
// ---------------------------------------------------------------------------

describe("p12-acceptance story 5 — observability / health / usage plane", () => {
  it("story 5: usage is derived-only (unknown cost = Unknown) and readiness tracks the migration baseline", async () => {
    const facts: UsageFacts = {
      turns: [
        {
          providerTurnId: "ptn-1",
          usage: { inputTokens: 100, outputTokens: 50 },
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

    const serviceDerived = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const service = yield* UsageService;
          return service.derive(facts);
        }),
        UsageServiceLive,
      ),
    );
    expect(serviceDerived.cost).toEqual({
      _tag: "Unknown",
      reason: "PricingUnavailable",
    });
    expect(serviceDerived).toEqual(deriveUsage(facts));

    const known = deriveUsage({
      ...facts,
      priceSheet: {
        version: "ps-2026-09",
        currency: "USD",
        unitPrices: { inputTokens: 2, outputTokens: 3 },
      },
    });
    expect(known.cost._tag).toBe("Known");
    if (known.cost._tag === "Known") {
      expect(known.cost.amount).toBe(100 * 2 + 50 * 3);
      expect(known.cost.priceSheetVersion).toBe("ps-2026-09");
    }

    expect(P12_MIGRATION_BASELINE).toBe(
      Math.max(...P12_MIGRATIONS.map((migration) => migration.id)),
    );
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
    const healthApp = Layer.mergeAll(
      base,
      probe,
      Layer.provide(HealthPortLive, probe),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            const health = yield* HealthPort;
            const before: ReadinessState = yield* health.readiness();
            expect(isReady(before)).toBe(false);
            yield* runMigrations(P12_MIGRATIONS);
            yield* ensureLegacyProjectResourceSourceFixture();
            const after: ReadinessState = yield* health.readiness();
            expect(isReady(after)).toBe(true);
          }),
          healthApp,
        ),
      ),
    );
  });
});
