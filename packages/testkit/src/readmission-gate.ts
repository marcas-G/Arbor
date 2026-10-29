import {
  WorkReadmissionGateStore,
  type WorkReadmissionGateStoreService,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";

/**
 * Explicit no-hold test double for fixtures whose assertions do not exercise
 * readmission sources. Gate-specific tests must provide a held or SQLite
 * implementation instead of this fixture.
 */
export const NoHoldWorkReadmissionGateStoreService: WorkReadmissionGateStoreService =
  {
    hasBlockingSource: () => Effect.succeed(Option.none()),
  } as const;

/** Test-only layer. Production missing-service behavior remains fail-closed. */
export const NoHoldWorkReadmissionGateStoreLive = Layer.succeed(
  WorkReadmissionGateStore,
  NoHoldWorkReadmissionGateStoreService,
);
