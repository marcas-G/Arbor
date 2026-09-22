import type { Principal } from "@arbor/domain";
import { Effect } from "effect";

/**
 * P12 `10` §3: authentication happens at the transport boundary. The
 * transport proves a principal; it never asserts authority. The authenticated
 * principal + raw submission context feed the composition-root Authority
 * Resolver (`02`), which produces the trusted authority fact.
 */

export interface TransportCredential {
  readonly token: string;
}

export type AuthenticationRejected = {
  readonly _tag: "AuthenticationRejected";
  readonly reason: "missing-token" | "unknown-token";
};

export interface AuthenticatorService {
  readonly authenticate: (
    credential: TransportCredential | null,
  ) => Effect.Effect<Principal, AuthenticationRejected>;
}

/** A static token -> principal map. This is the transport-boundary proof
 * mechanism; production may replace it with an external IdP adapter without
 * changing the boundary contract. */
export const makeStaticAuthenticator = (
  principalsByToken: Readonly<Record<string, Principal>>,
): AuthenticatorService => ({
  authenticate: (credential) => {
    if (credential === null || credential.token.length === 0) {
      return Effect.fail({
        _tag: "AuthenticationRejected",
        reason: "missing-token",
      } as const);
    }
    const principal = principalsByToken[credential.token];
    return principal === undefined
      ? Effect.fail({
          _tag: "AuthenticationRejected",
          reason: "unknown-token",
        } as const)
      : Effect.succeed(principal);
  },
});

/** The raw submission context the transport hands to the composition root.
 * External human/parent requests are the only origin a shell produces; it
 * carries the authenticated principal, never a model-supplied one. */
export const externalContext = (principal: Principal) => ({
  _tag: "External" as const,
  principal,
});
