import { Context, type Effect } from "effect";

declare const SecretRefBrand: unique symbol;

/** Opaque secret reference (P12 `03` §1; P3 `01` §9 / P3 `00` F1): the only
 * secret-related value allowed in Project Policy, Agent bindings, or
 * EnvironmentRef. It is a reference, never material. */
export type SecretRef = string & { readonly [SecretRefBrand]: "SecretRef" };

export const secretRef = (value: string): SecretRef => value as SecretRef;

/** Opaque resolved credential (P12 `03` §1): produced only at the execution
 * boundary and consumed immediately. It is not a string; the raw value is
 * reachable only through `reveal()` and is redacted by default under
 * `JSON.stringify` / `String()` so it can never leak through serialization. */
export class SecretMaterial {
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
  }

  static of(value: string): SecretMaterial {
    return new SecretMaterial(value);
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return "[REDACTED]";
  }

  toString(): string {
    return "[REDACTED]";
  }
}

/** Typed secret failures (P12 `03` §2): missing / inaccessible / expired must
 * never be silently substituted. */
export type SecretStoreError =
  | { readonly _tag: "SecretNotFound"; readonly secretRef: SecretRef }
  | {
      readonly _tag: "SecretInaccessible";
      readonly secretRef: SecretRef;
      readonly reason: string;
    }
  | { readonly _tag: "SecretExpired"; readonly secretRef: SecretRef };

export interface SecretStorePortService {
  readonly resolve: (
    secretRef: SecretRef,
  ) => Effect.Effect<SecretMaterial, SecretStoreError>;
}

export class SecretStorePort extends Context.Service<
  SecretStorePort,
  SecretStorePortService
>()("arbor/SecretStorePort") {}
