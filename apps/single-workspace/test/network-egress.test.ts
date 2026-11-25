import { describe, expect, it } from "vitest";
import {
  authorizeEgressConnectV2,
  authorizeEgressUrl,
  validateEgressAnswers,
  validateEgressAnswersV2,
} from "../src/transport/network-egress.js";

const enabled = { version: 1, mode: "Enabled", destinations: [] } as const;
const restricted = {
  version: 1,
  mode: "Restricted",
  destinations: ["https://registry.npmjs.org"],
} as const;

describe("Native broker origin authorization", () => {
  it("allows an authorized HTTPS package URL without widening its origin", () => {
    const target = "https://registry.npmjs.org/effect/-/effect-4.0.0.tgz";
    expect(authorizeEgressUrl(restricted, target)?.href).toBe(target);
    expect(
      authorizeEgressUrl(restricted, "https://github.com/source"),
    ).toBeNull();
    expect(
      authorizeEgressUrl(enabled, "https://github.com/source")?.origin,
    ).toBe("https://github.com");
    expect(
      authorizeEgressUrl({ ...enabled, mode: "Disabled" }, target),
    ).toBeNull();
  });

  it.each([
    "http://registry.npmjs.org/pkg",
    "https://127.0.0.1/pkg",
    "https://[::1]/pkg",
    "https://2130706433/pkg",
    "https://0x7f000001/pkg",
    "https://registry.npmjs.org:443/pkg",
    "https://registry.npmjs.org:8080/pkg",
    "https://user@registry.npmjs.org/pkg",
    "https://registry.npmjs.org.evil.test/pkg",
    "https://registry.npmjs.org./pkg",
    "https://REGISTRY.npmjs.org/pkg",
    "https://registry%2enpmjs.org/pkg",
    "https://registry.npmjs.org\\@evil.test/pkg",
    "https://registry.npmjs.org/pkg#fragment",
    "https://registry.npmjs.org/\nmalformed",
  ])("rejects an origin, protocol or parser bypass: %s", (url) => {
    expect(authorizeEgressUrl(restricted, url)).toBeNull();
  });
});

describe("Native broker address filtering", () => {
  it("uses canonical DNS CONNECT targets and only returns public IPv4", () => {
    expect(authorizeEgressConnectV2(enabled, "github.com")).toBe(true);
    expect(authorizeEgressConnectV2(restricted, "github.com")).toBe(false);
    expect(authorizeEgressConnectV2(enabled, "127.0.0.1")).toBe(false);
    expect(authorizeEgressConnectV2(enabled, "GitHub.com")).toBe(false);
    expect(
      validateEgressAnswersV2(["2606:4700:4700::1111", "8.8.8.8"]),
    ).toEqual([{ address: "8.8.8.8", family: 4 }]);
    expect(validateEgressAnswersV2(["2606:4700:4700::1111"])).toBeNull();
    expect(validateEgressAnswersV2(["8.8.8.8", "127.0.0.1"])).toBeNull();
  });

  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.0.9",
    "192.0.2.1",
    "192.31.196.1",
    "192.52.193.1",
    "192.88.99.1",
    "192.168.1.1",
    "192.175.48.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "64:ff9b::808:808",
    "64:ff9b:1::1",
    "100::1",
    "100:0:0:1::1",
    "2001::1",
    "2001:db8::1",
    "2002::1",
    "2620:4f:8000::1",
    "3fff::1",
    "5f00::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "fec0::1",
    "::8.8.8.8",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "fe80::1%eth0",
    "not-an-ip",
  ])("rejects the entire DNS set when one answer is denied: %s", (address) => {
    expect(validateEgressAnswers(["8.8.8.8", address], [])).toBeNull();
  });

  it("normalizes public IPv4-mapped addresses before pinning", () => {
    expect(
      validateEgressAnswers(["::ffff:808:808", "2606:4700:4700::1111"], []),
    ).toEqual([
      { address: "8.8.8.8", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
  });

  it("rejects unknown discovery and every synthesized address in fresh Pref64", () => {
    expect(validateEgressAnswers(["8.8.8.8"], null)).toBeNull();
    expect(validateEgressAnswers([], [])).toBeNull();
    expect(
      validateEgressAnswers(
        ["2606:4700:1234::808:808"],
        [{ address: "2606:4700:1234::", length: 96 }],
      ),
    ).toBeNull();
    expect(
      validateEgressAnswers(
        ["::ffff:808:808"],
        [{ address: "::ffff:0:0", length: 96 }],
      ),
    ).toBeNull();
    expect(
      validateEgressAnswers(
        ["8.8.8.8"],
        [{ address: "2606:4700:1234::1", length: 96 }],
      ),
    ).toBeNull();
  });
});
