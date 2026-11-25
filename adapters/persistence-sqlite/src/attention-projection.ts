import { AttentionProjectionStore } from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { AttentionProjectionQualificationProbe } from "./attention-projection/row-codecs.js";
import { makeProjectionContext } from "./attention-projection/context.js";
import { makeBindingRows } from "./attention-projection/binding-rows.js";
import { makeLegacyAdoptionRows } from "./attention-projection/legacy-adoption-rows.js";
import { makeObservationActivationRows } from "./attention-projection/observation-activation-rows.js";
import { makeSandboxUnavailableQueries } from "./attention-projection/sandbox-unavailable-queries.js";
import { makeSandboxRecoveryQueries } from "./attention-projection/sandbox-recovery-queries.js";
import { makeResetProject } from "./attention-projection/reset-project.js";

export type { AttentionProjectionQualificationEvent, AttentionProjectionQualificationProbe } from "./attention-projection/row-codecs.js";
export { makeProjectAttentionProjectionStore } from "./attention-projection/project-consumer.js";

export const makeAttentionProjectionStoreLive = (
  qualificationProbe?: AttentionProjectionQualificationProbe,
): Layer.Layer<AttentionProjectionStore, never, SqlClient> =>
  Layer.effect(
    AttentionProjectionStore,
    Effect.gen(function* () {
      const context = yield* makeProjectionContext(qualificationProbe);
      return AttentionProjectionStore.of({
        ...makeBindingRows(context),
        ...makeLegacyAdoptionRows(context),
        ...makeObservationActivationRows(context),
        ...makeSandboxUnavailableQueries(context),
        ...makeSandboxRecoveryQueries(context),
        ...makeResetProject(context),
      });
    }),
  );

export const AttentionProjectionStoreLive = makeAttentionProjectionStoreLive();
