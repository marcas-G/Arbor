import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import {
  SecretMaterial,
  type SecretRef,
  type SecretStoreError,
  SecretStorePort,
} from "@arbor/ports";
import { Effect, Layer } from "effect";

/** P12 `03` §3: the restricted-path secret adapter. A `SecretRef`'s value
 * names a file inside a configured root; path escapes are `SecretInaccessible`
 * (never read). A file may hold the raw credential, or a JSON envelope
 * `{ "value": string, "expiresAt"?: string }` whose expiry yields
 * `SecretExpired`. */
export interface SecretFileOptions {
  /** Restricted root; every ref resolves inside it. */
  readonly root: string;
  /** Clock used for expiry evaluation (defaults to the wall clock). */
  readonly now?: () => Date;
}

interface SecretFileEnvelope {
  readonly value: string;
  readonly expiresAt?: string;
}

const parseEnvelope = (raw: string): SecretFileEnvelope | undefined => {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { readonly value?: unknown }).value !== "string"
  ) {
    return undefined;
  }
  const expiresAt = (parsed as { readonly expiresAt?: unknown }).expiresAt;
  return {
    value: (parsed as { readonly value: string }).value,
    ...(typeof expiresAt === "string" ? { expiresAt } : {}),
  };
};

const ioReason = (cause: unknown): string => {
  if (typeof cause === "object" && cause !== null) {
    const code = (cause as { readonly code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
  }
  return String(cause);
};

export const SecretFileLive = (
  options: SecretFileOptions,
): Layer.Layer<SecretStorePort> => {
  const root = resolvePath(options.root);
  return Layer.succeed(SecretStorePort, {
    resolve: (
      ref: SecretRef,
    ): Effect.Effect<SecretMaterial, SecretStoreError> =>
      Effect.suspend(() => {
        const candidate = resolvePath(root, ref);
        const rel = relative(root, candidate);
        if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) {
          return Effect.fail<SecretStoreError>({
            _tag: "SecretInaccessible",
            secretRef: ref,
            reason: "path escapes restricted root",
          });
        }
        let raw: string;
        try {
          raw = readFileSync(candidate, "utf8");
        } catch (cause) {
          if (
            typeof cause === "object" &&
            cause !== null &&
            (cause as { readonly code?: unknown }).code === "ENOENT"
          ) {
            return Effect.fail<SecretStoreError>({
              _tag: "SecretNotFound",
              secretRef: ref,
            });
          }
          return Effect.fail<SecretStoreError>({
            _tag: "SecretInaccessible",
            secretRef: ref,
            reason: ioReason(cause),
          });
        }
        const envelope = parseEnvelope(raw);
        if (envelope === undefined) {
          return Effect.succeed(SecretMaterial.of(raw.trim()));
        }
        if (envelope.expiresAt !== undefined) {
          const now = (options.now ?? (() => new Date()))().getTime();
          const expiresAt = Date.parse(envelope.expiresAt);
          if (!Number.isNaN(expiresAt) && now >= expiresAt) {
            return Effect.fail<SecretStoreError>({
              _tag: "SecretExpired",
              secretRef: ref,
            });
          }
        }
        return Effect.succeed(SecretMaterial.of(envelope.value));
      }),
  });
};
