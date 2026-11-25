import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import { ipv6Value, type Pref64Prefix } from "./network-egress.js";

const lengths = [32, 40, 48, 56, 64, 96] as const;
const markers = [0xc00000aa, 0xc00000ab] as const;

const render = (value: bigint): string =>
  Array.from({ length: 8 }, (_, i) =>
    ((value >> BigInt((7 - i) * 16)) & 0xffffn).toString(16),
  ).join(":");

// RFC6052 network-specific address format: an all-zero reserved u octet
// splits the IPv4 address for /40,/48,/56; the suffix is also all zero.
const synthesizeKnownAnswer = (
  prefix: bigint,
  length: Pref64Prefix["length"],
  marker: number,
): bigint => {
  if (length === 96) return prefix | BigInt(marker);
  const positions = Array.from({ length: 4 }, (_, i) => {
    const offset = length / 8 + i;
    return offset < 8 ? offset : offset + 1;
  });
  let value = prefix;
  for (let index = 0; index < 4; index++) {
    const octet = (marker >>> ((3 - index) * 8)) & 255;
    value |= BigInt(octet) << BigInt((15 - (positions[index] as number)) * 8);
  }
  return value;
};

/** Strict positive RFC7050 known-answer decoding. Does not perform DNS or
 * qualify a resolver, nor derive NoDns64 from an empty/negative response.
 * Requires both .170/.171 vectors for every returned prefix; duplicate,
 * ambiguous, incomplete, scoped or malformed answer sets remain unknown. */
export const decodeRfc7050Answers = (
  answers: ReadonlyArray<string>,
): ReadonlyArray<Pref64Prefix> | null => {
  if (answers.length === 0) return null;
  const seen = new Set<bigint>();
  const groups = new Map<
    string,
    { readonly prefix: Pref64Prefix; readonly markers: Set<number> }
  >();
  for (const answer of answers) {
    if (isIP(answer) !== 6 || answer.includes("%")) return null;
    const value = ipv6Value(answer);
    if (seen.has(value)) return null;
    seen.add(value);
    const candidates: Array<{
      readonly prefix: Pref64Prefix;
      readonly marker: number;
    }> = [];
    for (const length of lengths) {
      const shift = BigInt(128 - length);
      const prefix = (value >> shift) << shift;
      for (const marker of markers) {
        if (synthesizeKnownAnswer(prefix, length, marker) === value)
          candidates.push({
            prefix: { address: render(prefix), length },
            marker,
          });
      }
    }
    if (candidates.length !== 1) return null;
    const candidate = candidates[0];
    if (candidate === undefined) return null;
    const key = `${candidate.prefix.address}/${candidate.prefix.length}`;
    const group = groups.get(key) ?? {
      prefix: candidate.prefix,
      markers: new Set<number>(),
    };
    group.markers.add(candidate.marker);
    groups.set(key, group);
  }
  if ([...groups.values()].some((group) => group.markers.size !== 2))
    return null;
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([, group]) => group.prefix);
};

interface DiscoveryResolver {
  readonly resolve4: (hostname: string) => Promise<ReadonlyArray<string>>;
  readonly resolve6: (hostname: string) => Promise<ReadonlyArray<string>>;
  readonly cancel: () => void;
}

/** Positive-only current-network probe. An explicit ENODATA is still NOT a
 * qualified NoDns64 proof, and never authorizes an empty prefix set. Fresh
 * resolver per call, no cross-connection state. This method itself remains
 * a qualification candidate until its method/version is operator-qualified. */
export const discoverRfc7050Prefixes = async (
  signal: AbortSignal,
  makeResolver: () => DiscoveryResolver = () =>
    new Resolver({ timeout: 3000, tries: 1 }),
): Promise<ReadonlyArray<Pref64Prefix> | null> => {
  if (signal.aborted) return null;
  const resolver = makeResolver();
  const cancel = () => resolver.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const [v4, v6] = await Promise.allSettled([
      resolver.resolve4("ipv4only.arpa"),
      resolver.resolve6("ipv4only.arpa"),
    ]);
    if (
      signal.aborted ||
      v4.status !== "fulfilled" ||
      v6.status !== "fulfilled"
    )
      return null;
    if (
      v4.value.length !== 2 ||
      !v4.value.includes("192.0.0.170") ||
      !v4.value.includes("192.0.0.171")
    )
      return null;
    return decodeRfc7050Answers(v6.value);
  } catch {
    return null;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
};
