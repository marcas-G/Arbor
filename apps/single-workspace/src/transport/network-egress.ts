import { BlockList, isIP } from "node:net";
import { domainToASCII } from "node:url";
import { decodeNetworkPolicyV1, type NetworkPolicyV1 } from "@arbor/domain";

// Exact conservative P12/13 address snapshot. Do not substitute the host's
// mutable notion of routability, including exceptions within these ranges.
const deniedV4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.31.196.0/24",
  "192.52.193.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "192.175.48.0/24",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "255.255.255.255/32",
] as const;
const deniedV6 = [
  "::/128",
  "::1/128",
  "64:ff9b::/96",
  "64:ff9b:1::/48",
  "100::/64",
  "100:0:0:1::/64",
  "2001::/23",
  "2001:db8::/32",
  "2002::/16",
  "2620:4f:8000::/48",
  "3fff::/20",
  "5f00::/16",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8",
] as const;
const denied = new BlockList();
for (const [cidrs, family] of [
  [deniedV4, "ipv4"],
  [deniedV6, "ipv6"],
] as const) {
  for (const cidr of cidrs) {
    const [address, length] = cidr.split("/");
    denied.addSubnet(address as string, Number(length), family);
  }
}

export const ipv6Value = (address: string): bigint => {
  const dotted = address.lastIndexOf(":");
  const tail = address.slice(dotted + 1);
  const text = tail.includes(".")
    ? address.slice(0, dotted + 1) +
      tail
        .split(".")
        .reduce((n, octet) => n * 256 + Number(octet), 0)
        .toString(16)
        .padStart(8, "0")
        .replace(/^(.{4})(.{4})$/, "$1:$2")
    : address;
  const [head = "", end] = text.split("::");
  const left = head.length === 0 ? [] : head.split(":");
  const right = end === undefined || end.length === 0 ? [] : end.split(":");
  const words =
    end === undefined
      ? left
      : [
          ...left,
          ...Array<string>(8 - left.length - right.length).fill("0"),
          ...right,
        ];
  return words.reduce(
    (value, word) => (value << 16n) | BigInt(`0x${word}`),
    0n,
  );
};

export interface EgressAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

const normalizeAddress = (address: string): EgressAddress | null => {
  if (address.includes("%")) return null;
  const family = isIP(address);
  if (family === 4) return { address, family };
  if (family !== 6) return null;
  const value = ipv6Value(address);
  if (value >> 32n === 0xffffn) {
    const v4 = [24n, 16n, 8n, 0n]
      .map((bits) => Number((value >> bits) & 255n))
      .join(".");
    return { address: v4, family: 4 };
  }
  return { address, family };
};

/** An origin check is not permission to connect: the broker must also obtain
 * fresh qualified Pref64 discovery, filter ALL answers and pin the socket. */
export const authorizeEgressUrl = (
  policy: NetworkPolicyV1,
  input: string,
): URL | null => {
  const decoded = decodeNetworkPolicyV1(policy);
  if (decoded === undefined || decoded.mode === "Disabled") return null;
  // Reject spellings URL would silently repair (backslashes, explicit ports,
  // userinfo, encoded hosts, raw addresses and noncanonical DNS names).
  const authority = /^https:\/\/([^/?#]+)(?:[/?#]|$)/u.exec(input)?.[1];
  if (authority === undefined || !/^[a-z0-9.-]+$/u.test(authority)) return null;
  const origin = `https://${authority}`;
  if (
    decodeNetworkPolicyV1({
      version: 1,
      mode: "Restricted",
      destinations: [origin],
    }) === undefined
  )
    return null;
  if (
    input.includes("\\") ||
    Array.from(input).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 32 || code === 127;
    })
  )
    return null;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.origin !== origin || url.hash !== "") return null;
  return decoded.mode === "Enabled" || decoded.destinations.includes(origin)
    ? url
    : null;
};

export interface Pref64Prefix {
  readonly address: string;
  readonly length: 32 | 40 | 48 | 56 | 64 | 96;
}

/** Called only with the result of the current qualified discovery. null means
 * unknown and fails closed; [] requires the caller's qualified NoDns64 proof.
 * This helper never discovers a prefix or publishes a Supported capability. */
export const validateEgressAnswers = (
  answers: ReadonlyArray<string>,
  currentPref64: ReadonlyArray<Pref64Prefix> | null,
): ReadonlyArray<EgressAddress> | null => {
  if (answers.length === 0 || currentPref64 === null) return null;
  const pref64 = new BlockList();
  for (const prefix of currentPref64) {
    if (
      isIP(prefix.address) !== 6 ||
      prefix.address.includes("%") ||
      ![32, 40, 48, 56, 64, 96].includes(prefix.length)
    )
      return null;
    const mask = (1n << BigInt(128 - prefix.length)) - 1n;
    if ((ipv6Value(prefix.address) & mask) !== 0n) return null;
    pref64.addSubnet(prefix.address, prefix.length, "ipv6");
  }
  const normalized: EgressAddress[] = [];
  for (const answer of answers) {
    if (isIP(answer) === 6 && pref64.check(answer, "ipv6")) return null;
    const address = normalizeAddress(answer);
    if (address === null) return null;
    const family = address.family === 4 ? "ipv4" : "ipv6";
    if (
      denied.check(address.address, family) ||
      (address.family === 6 && ipv6Value(address.address) >> 125n !== 1n)
    )
      return null;
    normalized.push(address);
  }
  return normalized;
};

const canonicalDnsName = (hostname: string): boolean => {
  if (
    hostname.length === 0 ||
    hostname.length > 253 ||
    hostname !== hostname.toLowerCase() ||
    domainToASCII(hostname) !== hostname ||
    isIP(hostname) !== 0
  )
    return false;
  const labels = hostname.split(".");
  return labels.every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
  );
};

/** V2 CONNECT authorization. V2 keeps the network policy as the user-facing
 * origin allowlist, while the transport contract is deliberately narrower:
 * canonical DNS name, HTTPS port 443, and no raw IP spelling. */
export const authorizeEgressConnectV2 = (
  policy: NetworkPolicyV1,
  hostname: string,
): boolean =>
  canonicalDnsName(hostname) &&
  authorizeEgressUrl(policy, `https://${hostname}/`) !== null;

/** V2 checks every DNS answer but only returns public IPv4 candidates. A
 * public AAAA is harmlessly ignored; a special-use or mapped answer rejects
 * the whole resolution so the broker never hides a mixed unsafe response. */
export const validateEgressAnswersV2 = (
  answers: ReadonlyArray<string>,
): ReadonlyArray<EgressAddress> | null => {
  if (answers.length === 0) return null;
  const normalized: EgressAddress[] = [];
  for (const answer of answers) {
    const address = normalizeAddress(answer);
    if (address === null) return null;
    const family = address.family === 4 ? "ipv4" : "ipv6";
    if (denied.check(address.address, family)) return null;
    if (address.family === 4) normalized.push(address);
  }
  return normalized.length === 0 ? null : normalized;
};
