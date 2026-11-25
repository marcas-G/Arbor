import { Resolver } from "node:dns/promises";
import { request } from "node:https";
import { checkServerIdentity } from "node:tls";
import { decodeNetworkPolicyV1, type NetworkPolicyV1 } from "@arbor/domain";
import {
  authorizeEgressUrl,
  type EgressAddress,
  type Pref64Prefix,
  validateEgressAnswers,
} from "./network-egress.js";

// Internal T2 implementation, deliberately absent from the application's public
// entry point. A qualified discovery implementation and child transport are
// still required; constructing this client grants no sandbox capability.
export class BrokerFailure extends Error {
  constructor(
    readonly code:
      | "sandbox/network-denied"
      | "sandbox/pref64-unknown"
      | "sandbox/dns-unavailable"
      | "sandbox/network-unavailable"
      | "sandbox/redirect-denied"
      | "sandbox/download-limit"
      | "sandbox/download-aborted",
  ) {
    super(code);
    this.name = "BrokerFailure";
  }
}

export interface BrokerResponse {
  readonly status: number;
  readonly location: string | undefined;
  readonly body: AsyncIterable<Uint8Array>;
  readonly close: () => void;
}

export interface BrokerDependencies {
  // Must be supplied by the operator-qualified method for THIS operation.
  // [] is not a DNS negative response: it requires qualified NoDns64 proof.
  // The client never caches discovery or infers absence from DNS silence.
  readonly discoverPref64: (
    signal: AbortSignal,
  ) => Promise<ReadonlyArray<Pref64Prefix> | null>;
  readonly resolveAll?: (
    hostname: string,
    signal: AbortSignal,
  ) => Promise<ReadonlyArray<string>>;
  readonly connect?: (
    url: URL,
    pinned: EgressAddress,
    signal: AbortSignal,
  ) => Promise<BrokerResponse>;
}

const resolveAll = async (
  hostname: string,
  signal: AbortSignal,
): Promise<ReadonlyArray<string>> => {
  signal.throwIfAborted();
  const resolver = new Resolver();
  const cancel = () => resolver.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const results = await Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname),
    ]);
    signal.throwIfAborted();
    const addresses: string[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") addresses.push(...result.value);
      else {
        const code = (result.reason as NodeJS.ErrnoException | null)?.code;
        // An unavailable address family may be empty; a timeout/other failure
        // must never turn a partially examined answer set into authorization.
        if (code !== "ENODATA" && code !== "ENOTFOUND")
          throw new BrokerFailure("sandbox/dns-unavailable");
      }
    }
    return addresses;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
};

const connectPinned = (
  url: URL,
  pinned: EgressAddress,
  signal: AbortSignal,
): Promise<BrokerResponse> =>
  new Promise((resolve, reject) => {
    // Connect by validated numeric address: no second hostname lookup or
    // proxy environment lookup is possible. TLS identity remains the origin.
    const outgoing = request(
      {
        hostname: pinned.address,
        family: pinned.family,
        port: 443,
        servername: url.hostname,
        path: url.pathname + url.search,
        method: "GET",
        headers: {
          Host: url.hostname,
          Connection: "close",
          "Accept-Encoding": "identity",
        },
        agent: false,
        rejectUnauthorized: true,
        checkServerIdentity: (_hostname, certificate) =>
          checkServerIdentity(url.hostname, certificate),
        maxHeaderSize: 16 * 1024,
        signal,
      },
      (incoming) => {
        resolve({
          status: incoming.statusCode ?? 0,
          location: incoming.headers.location,
          body: incoming,
          close: () => {
            incoming.destroy();
            outgoing.destroy();
          },
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

/** Bounded HTTPS download, with fresh authorization on every redirect.
 * This is NOT yet the npm/git/curl proxy or a production spawn authority. */
export const downloadThroughBroker = async (
  input: {
    readonly policy: NetworkPolicyV1;
    readonly url: string;
    readonly maxBytes: number;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
  },
  dependencies: BrokerDependencies,
): Promise<{ readonly url: string; readonly bytes: Uint8Array }> => {
  if (
    !Number.isSafeInteger(input.maxBytes) ||
    input.maxBytes < 1 ||
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > 2_147_483_647
  )
    throw new BrokerFailure("sandbox/download-limit");
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), input.timeoutMs);
  const signal = AbortSignal.any([input.signal, timeout.signal]);
  const resolve = dependencies.resolveAll ?? resolveAll;
  const connect = dependencies.connect ?? connectPinned;
  const discover = async () => {
    try {
      const prefixes = await dependencies.discoverPref64(signal);
      signal.throwIfAborted();
      if (prefixes === null) throw new BrokerFailure("sandbox/pref64-unknown");
      return prefixes;
    } catch {
      throw new BrokerFailure("sandbox/pref64-unknown");
    }
  };
  // Snapshot the decoded policy before the first await: mutable caller data
  // cannot broaden a Restricted allowlist during DNS/TLS/redirect processing.
  const decoded = decodeNetworkPolicyV1(input.policy);
  const policy =
    decoded === undefined
      ? undefined
      : {
          ...decoded,
          destinations: [...decoded.destinations],
        };
  let target = input.url;
  try {
    if (policy === undefined) throw new BrokerFailure("sandbox/network-denied");
    for (let redirects = 0; ; redirects++) {
      signal.throwIfAborted();
      const url = authorizeEgressUrl(policy, target);
      if (url === null) throw new BrokerFailure("sandbox/network-denied");
      const resolutionPrefixes = await discover();
      const answers = await resolve(url.hostname, signal);
      signal.throwIfAborted();
      if (validateEgressAnswers(answers, resolutionPrefixes) === null)
        throw new BrokerFailure("sandbox/network-denied");
      // A discovery result from resolution cannot authorize a later connect.
      const connectionPrefixes = await discover();
      const pinned = validateEgressAnswers(answers, connectionPrefixes)?.[0];
      if (pinned === undefined)
        throw new BrokerFailure("sandbox/network-denied");
      const response = await connect(url, pinned, signal);
      try {
        signal.throwIfAborted();
        if (redirectStatuses.has(response.status)) {
          if (redirects === 5 || response.location === undefined)
            throw new BrokerFailure("sandbox/redirect-denied");
          const location = response.location;
          // Check the raw spelling before URL resolution can erase an
          // explicit :443, userinfo, whitespace or another parser bypass.
          if (
            location.includes("\\") ||
            Array.from(location).some((character) => {
              const code = character.charCodeAt(0);
              return code <= 32 || code === 127;
            })
          )
            throw new BrokerFailure("sandbox/redirect-denied");
          const absolute = /^[a-z][a-z0-9+.-]*:/iu.test(location)
            ? location
            : location.startsWith("//")
              ? `https:${location}`
              : new URL(location, url).href;
          if (authorizeEgressUrl(policy, absolute) === null)
            throw new BrokerFailure("sandbox/redirect-denied");
          target = absolute;
          continue;
        }
        if (response.status < 200 || response.status >= 300)
          throw new BrokerFailure("sandbox/network-unavailable");
        const chunks: Uint8Array[] = [];
        let length = 0;
        for await (const chunk of response.body) {
          signal.throwIfAborted();
          length += chunk.byteLength;
          if (length > input.maxBytes)
            throw new BrokerFailure("sandbox/download-limit");
          chunks.push(Uint8Array.from(chunk));
        }
        signal.throwIfAborted();
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return { url: url.href, bytes };
      } finally {
        response.close();
      }
    }
  } catch (error) {
    if (signal.aborted) throw new BrokerFailure("sandbox/download-aborted");
    if (error instanceof BrokerFailure) throw error;
    throw new BrokerFailure("sandbox/network-unavailable");
  } finally {
    clearTimeout(timer);
  }
};
