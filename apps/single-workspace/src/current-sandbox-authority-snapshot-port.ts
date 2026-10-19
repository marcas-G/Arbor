import { release } from "node:os";
import {
  Clock,
  CurrentSandboxAuthoritySnapshotPort,
  SANDBOX_ENV_ALLOWLIST,
  type TrustedHostConfigurationSourceService,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { loadSandboxAuthorityBundleSnapshotV2 } from "./sandbox-authority-bundle.js";

export const sandboxPolicyCurrentHostV1 = () => {
  const osFamily: "Linux" | "macOS" | "Windows" | undefined =
    process.platform === "linux"
      ? "Linux"
      : process.platform === "darwin"
        ? "macOS"
        : process.platform === "win32"
          ? "Windows"
          : undefined;
  const osBuild = release();
  return osFamily !== undefined &&
    osBuild.length > 0 &&
    osBuild.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(osBuild)
    ? { osFamily, osBuild }
    : undefined;
};

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
            const currentHost = sandboxPolicyCurrentHostV1();
            if (currentHost === undefined)
              return {
                _tag: "Unavailable" as const,
                failure: "CurrentHostIdentityUnavailable" as const,
              };
            const now = yield* clock.now();
            const loaded = yield* loadSandboxAuthorityBundleSnapshotV2(
              source,
              now,
              SANDBOX_ENV_ALLOWLIST,
            );
            return loaded._tag === "Available"
              ? { ...loaded, currentHost }
              : loaded;
          }),
      });
    }),
  );
