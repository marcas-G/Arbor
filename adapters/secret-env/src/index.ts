import {
  SecretMaterial,
  type SecretRef,
  type SecretStoreError,
  SecretStorePort,
} from "@arbor/ports";
import { Effect, Layer } from "effect";

/** P12 `03` §3: the default, env-var backed secret adapter. A `SecretRef`'s
 * value names the environment variable; resolution reads the ambient process
 * environment. Missing variables are a typed `SecretNotFound` — never a silent
 * fallback. */
export interface SecretEnvOptions {
  /** Ambient environment (defaults to `process.env`). */
  readonly ambient?: NodeJS.ProcessEnv;
  /** Clock used for expiry evaluation (defaults to the wall clock). */
  readonly now?: () => Date;
  /** Optional per-ref ISO-8601 expiry instants (ref name -> instant). */
  readonly expiries?: Readonly<Record<string, string>>;
}

export const SecretEnvLive = (
  options: SecretEnvOptions = {},
): Layer.Layer<SecretStorePort> =>
  Layer.succeed(SecretStorePort, {
    resolve: (
      ref: SecretRef,
    ): Effect.Effect<SecretMaterial, SecretStoreError> =>
      Effect.suspend(() => {
        const ambient = options.ambient ?? process.env;
        const value = ambient[ref];
        if (value === undefined) {
          return Effect.fail<SecretStoreError>({
            _tag: "SecretNotFound",
            secretRef: ref,
          });
        }
        const expiry = options.expiries?.[ref];
        if (expiry !== undefined) {
          const now = (options.now ?? (() => new Date()))().getTime();
          const expiresAt = Date.parse(expiry);
          if (!Number.isNaN(expiresAt) && now >= expiresAt) {
            return Effect.fail<SecretStoreError>({
              _tag: "SecretExpired",
              secretRef: ref,
            });
          }
        }
        return Effect.succeed(SecretMaterial.of(value));
      }),
  });
