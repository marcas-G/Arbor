import { Schema } from "effect";

/**
 * P12 `01` §2/§4 (G1): plugin identity + the frozen compatibility mechanism.
 *
 * `PluginId` (the `plg_` identity) lives with the other domain ids; this
 * module owns the two semver identity brands and the compatibility policy.
 *
 * The SPI a plugin binds to follows semver (P12 `01` §4):
 *   MAJOR  — breaking change to any frozen SPI surface;
 *   MINOR  — additive, backward-compatible SPI surface;
 *   PATCH  — no SPI surface change.
 * A plugin whose declared `PluginSdkApiVersion` MAJOR differs from the
 * runtime SPI MAJOR is rejected at registration with a typed
 * `PluginCompatibilityError`.
 */

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

const isSemver = (value: string): boolean => SEMVER_RE.test(value);

const makeSemverSchema = <B extends string>(brand: B) =>
  Schema.String.pipe(
    Schema.refine((value): value is string => isSemver(value), {
      message: "expected a semver string (MAJOR.MINOR.PATCH)",
    }),
    Schema.brand(brand),
  );

export const PluginVersion = makeSemverSchema("PluginVersion");
export const PluginSdkApiVersion = makeSemverSchema("PluginSdkApiVersion");

export type PluginVersion = Schema.Schema.Type<typeof PluginVersion>;
export type PluginSdkApiVersion = Schema.Schema.Type<
  typeof PluginSdkApiVersion
>;

/** The SPI version the running build implements. Only the MAJOR is
 * compatibility-significant; the numeric default is non-contract
 * (DID §0.1 freeze/closure rules). */
export const RUNTIME_PLUGIN_SDK_API_VERSION: PluginSdkApiVersion =
  Schema.decodeUnknownSync(PluginSdkApiVersion)("1.0.0");

export const majorOfSemver = (value: string): number =>
  Number(value.split(".")[0] ?? "0");

export type PluginCompatibilityError = {
  readonly _tag: "PluginCompatibilityError";
  readonly declared: PluginSdkApiVersion;
  readonly runtime: PluginSdkApiVersion;
  readonly reason: "MajorMismatch";
};

export type PluginCompatibilityResult =
  | { readonly ok: true; readonly value: PluginSdkApiVersion }
  | { readonly ok: false; readonly error: PluginCompatibilityError };

/** The compatibility policy as a pure decision. Equal MAJOR -> accepted;
 * a different MAJOR -> typed `PluginCompatibilityError` (never a throw). */
export const checkPluginSdkCompatibility = (
  declared: PluginSdkApiVersion,
  runtime: PluginSdkApiVersion = RUNTIME_PLUGIN_SDK_API_VERSION,
): PluginCompatibilityResult =>
  majorOfSemver(declared) === majorOfSemver(runtime)
    ? { ok: true, value: declared }
    : {
        ok: false,
        error: {
          _tag: "PluginCompatibilityError",
          declared,
          runtime,
          reason: "MajorMismatch",
        },
      };
