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

/** Local single-user form (product decision 2026-09-29): when no
 * authenticator is configured the daemon is a localhost desktop process.
 * Every request — with or without a bearer token — authenticates as the
 * local principal; there is no login. Configured static-map / IdP
 * authenticators keep full 401 semantics for multi-user deployments. */
export const LOCAL_PRINCIPAL = "user:local";
export const makeLocalAuthenticator = (): AuthenticatorService => ({
  authenticate: () => Effect.succeed(LOCAL_PRINCIPAL as Principal),
});

/** OpenCode-style optional Basic gate (product decision 2026-09-29): a
 * lightweight HTTP access gate for remote exposure — set
 * ARBOR_SERVER_PASSWORD (non-empty) to enable. Direct string comparison,
 * no JWT/session/cookie; NOT an identity system — an authorized request
 * authenticates as the configured single principal. Loopback + no
 * password = the local single-user form; the OS user + loopback isolation
 * is the security boundary there (same model as `opencode`). */
export const makeBasicAuthenticator = (options: {
  readonly username: string;
  readonly password: string;
  readonly principal?: Principal;
}): AuthenticatorService => ({
  authenticate: (credential) => {
    const token = credential?.token ?? "";
    const match = /^Basic\s+(.+)$/.exec(token);
    if (match === null) {
      return Effect.fail({
        _tag: "AuthenticationRejected",
        reason: "missing-token",
      });
    }
    let decoded = "";
    try {
      decoded = Buffer.from(match[1] ?? "", "base64").toString("utf8");
    } catch {
      return Effect.fail({
        _tag: "AuthenticationRejected",
        reason: "unknown-token",
      });
    }
    const separator = decoded.indexOf(":");
    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    if (username === options.username && password === options.password) {
      return Effect.succeed(
        options.principal ?? (LOCAL_PRINCIPAL as Principal),
      );
    }
    return Effect.fail({
      _tag: "AuthenticationRejected",
      reason: "unknown-token",
    });
  },
});
