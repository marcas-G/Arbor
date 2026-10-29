import type { ProjectId, ProviderTurnId } from "@arbor/domain";
import {
  type ProviderFailure,
  ProviderTurnStore,
  type ProviderTurnStoreService,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { makeProviderAttemptStore } from "./provider-attempt-store.js";
import { makeProviderTurnIntentStore } from "./provider-turn-intent-store.js";
import { makeProviderTurnProjectStore } from "./provider-turn-project-store.js";
import { makeProviderTurnSettlementStore } from "./provider-turn-settlement-store.js";

export const ProviderTurnStoreLive: Layer.Layer<
  ProviderTurnStore,
  never,
  SqlClient
> = Layer.effect(
  ProviderTurnStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const failure = (cause: unknown): ProviderFailure => ({
      _tag: "ProviderFailure",
      kind: "ProviderUnavailable",
      safeDiagnostic:
        typeof cause === "object" &&
        cause !== null &&
        "_tag" in cause &&
        typeof (cause as { readonly _tag: unknown })._tag === "string"
          ? `sqlite-${String((cause as { readonly _tag: string })._tag)}`
          : "sqlite-provider-turn-store",
    });
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
    const dependencies = { sql, run };
    const store = {
      ...makeProviderTurnIntentStore(dependencies),
      ...makeProviderAttemptStore(dependencies),
      ...makeProviderTurnSettlementStore(dependencies),
      ...makeProviderTurnProjectStore(dependencies),
    } satisfies ProviderTurnStoreService;
    return ProviderTurnStore.of(store);
  }),
);

export type { ProjectId, ProviderTurnId };
