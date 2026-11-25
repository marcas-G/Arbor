import {
  type DomainEventJournal,
  type IdGenerator,
  RecoveryAttentionFactStore,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { makeAssignWorkFacts } from "./recovery-attention-fact-store/assign-work.js";
import { makeFactContext } from "./recovery-attention-fact-store/context.js";
import { makeDeliverReplayFacts } from "./recovery-attention-fact-store/deliver-replay.js";
import { makeLegacyAdoptionFacts } from "./recovery-attention-fact-store/legacy-adoption.js";
import type { RecoveryAttentionFactQualificationProbe } from "./recovery-attention-fact-store/row-codecs.js";
import { makeSubmittedDecisionFacts } from "./recovery-attention-fact-store/submitted-decision.js";

export type {
  RecoveryAttentionFactQualificationEvent,
  RecoveryAttentionFactQualificationProbe,
} from "./recovery-attention-fact-store/row-codecs.js";

export const makeRecoveryAttentionFactStoreLive = (
  qualificationProbe?: RecoveryAttentionFactQualificationProbe,
): Layer.Layer<
  RecoveryAttentionFactStore,
  never,
  SqlClient | DomainEventJournal | IdGenerator
> =>
  Layer.effect(
    RecoveryAttentionFactStore,
    Effect.gen(function* () {
      const context = yield* makeFactContext(qualificationProbe);
      return RecoveryAttentionFactStore.of({
        ...makeLegacyAdoptionFacts(context),
        ...makeSubmittedDecisionFacts(context),
        ...makeAssignWorkFacts(context),
        ...makeDeliverReplayFacts(context),
      });
    }),
  );

export const RecoveryAttentionFactStoreLive =
  makeRecoveryAttentionFactStoreLive();
