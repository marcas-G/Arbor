import {
  Clock,
  CurrentSandboxAuthoritySnapshotPort,
  SANDBOX_ENV_ALLOWLIST,
  type TrustedHostConfigurationSourceService,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { loadSandboxAuthorityBundleSnapshotV2 } from "./sandbox-authority-bundle.js";

/** P5 adapter for consumers that must observe bundle drift at read time.
 * Unlike the startup V1 issuer snapshot, every method call re-loads and
 * verifies the protected V2 source/high-water pair. */
export const CurrentSandboxAuthoritySnapshotPortLive = (
  source: TrustedHostConfigurationSourceService | undefined,
) =>
  Layer.effect(
    CurrentSandboxAuthoritySnapshotPort,
    Effect.gen(function* () {
      const clock = yield* Clock;
      return CurrentSandboxAuthoritySnapshotPort.of({
        loadCurrentVerifiedV2: () =>
          Effect.gen(function* () {
            const now = yield* clock.now();
            return yield* loadSandboxAuthorityBundleSnapshotV2(
              source,
              now,
              SANDBOX_ENV_ALLOWLIST,
            );
          }),
      });
    }),
  );
