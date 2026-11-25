import { describe, expect, it, vi } from "vitest";
import { validateEgressAnswers } from "../src/transport/network-egress.js";
import {
  decodeRfc7050Answers,
  discoverRfc7050Prefixes,
} from "../src/transport/pref64-discovery.js";

// Fixed RFC6052-format byte vectors, independent of the production encoder.
const vectors = [
  [32, "2001:db8::", "2001:db8:c000:aa::", "2001:db8:c000:ab::"],
  [40, "2001:db8:100::", "2001:db8:1c0:0:aa::", "2001:db8:1c0:0:ab::"],
  [
    48,
    "2001:db8:122::",
    "2001:db8:122:c000:0:aa00::",
    "2001:db8:122:c000:0:ab00::",
  ],
  [
    56,
    "2001:db8:122:300::",
    "2001:db8:122:3c0:0:aa::",
    "2001:db8:122:3c0:0:ab::",
  ],
  [
    64,
    "2001:db8:122:344::",
    "2001:db8:122:344:c0:0:aa00:0",
    "2001:db8:122:344:c0:0:ab00:0",
  ],
  [96, "64:ff9b::", "64:ff9b::c000:aa", "64:ff9b::c000:ab"],
] as const;

describe("RFC7050 positive discovery decoder (not a NoDns64 proof)", () => {
  it.each(vectors)(
    "recognizes /%s including both fixed markers",
    (length, prefix, a, b) => {
      const result = decodeRfc7050Answers([a, b]);
      expect(result).toHaveLength(1);
      expect(result?.[0]?.length).toBe(length);
      // The discovered prefix excludes the complete range, not just markers.
      expect(validateEgressAnswers([prefix], result)).toBeNull();
      expect(validateEgressAnswers(["8.8.8.8"], result)).toEqual([
        { address: "8.8.8.8", family: 4 },
      ]);
    },
  );

  it("allows multiple complete prefixes without reusing a previous discovery", () => {
    const first = vectors[0];
    const last = vectors[5];
    expect(
      decodeRfc7050Answers([first[2], first[3], last[2], last[3]]),
    ).toHaveLength(2);
    expect(decodeRfc7050Answers([first[2], first[3]])).toHaveLength(1);
  });

  it.each(
    [
      [],
      ["64:ff9b::c000:aa"],
      ["64:ff9b::c000:aa", "64:ff9b::c000:aa"],
      ["64:ff9b::c000:aa", "0064:ff9b:0:0:0:0:c000:00aa"],
      ["64:ff9b::c000:aa", "64:ff9b::c000:ac"],
      ["64:ff9b::c000:aa", "2001:db8:c000:ab::"],
      ["64:ff9b::c000:aa", "64:ff9b::c000:ab%eth0"],
      ["64:ff9b::c000:aa", "127.0.0.1"],
      ["64:ff9b::c000:aa", "not-an-ip"],
      // Nonzero reserved u octet and suffix are not a valid /32 mapping.
      ["2001:db8:c000:aa:100::", "2001:db8:c000:ab:100::"],
      ["2001:db8:c000:aa::1", "2001:db8:c000:ab::1"],
    ].map((answers) => ({ answers })),
  )(
    "keeps malformed, incomplete or empty discovery unknown: %j",
    ({ answers }) => {
      expect(decodeRfc7050Answers(answers)).toBeNull();
    },
  );
});

describe("current-network RFC7050 positive probe", () => {
  const makeResolver = () => ({
    resolve4: vi.fn(async () => ["192.0.0.170", "192.0.0.171"]),
    resolve6: vi.fn(async () => ["64:ff9b::c000:aa", "64:ff9b::c000:ab"]),
    cancel: vi.fn(),
  });

  it("performs new known-answer queries for every discovery", async () => {
    const resolvers = [makeResolver(), makeResolver()];
    const factory = vi.fn(
      () => resolvers.shift() as ReturnType<typeof makeResolver>,
    );
    const signal = new AbortController().signal;
    expect(await discoverRfc7050Prefixes(signal, factory)).toHaveLength(1);
    expect(await discoverRfc7050Prefixes(signal, factory)).toHaveLength(1);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("does not infer NoDns64 from an explicit negative AAAA response", async () => {
    const resolver = makeResolver();
    resolver.resolve6.mockRejectedValue(
      Object.assign(new Error(), { code: "ENODATA" }),
    );
    expect(
      await discoverRfc7050Prefixes(
        new AbortController().signal,
        () => resolver,
      ),
    ).toBeNull();
  });

  it("rejects empty and corrupted known-answer responses", async () => {
    const resolver = makeResolver();
    resolver.resolve6.mockResolvedValue([]);
    expect(
      await discoverRfc7050Prefixes(
        new AbortController().signal,
        () => resolver,
      ),
    ).toBeNull();
    resolver.resolve6.mockResolvedValue([
      "64:ff9b::c000:aa",
      "64:ff9b::c000:ab",
    ]);
    resolver.resolve4.mockResolvedValue(["192.0.0.170", "127.0.0.1"]);
    expect(
      await discoverRfc7050Prefixes(
        new AbortController().signal,
        () => resolver,
      ),
    ).toBeNull();
  });

  it("cancels a live resolution and never returns its interrupted result", async () => {
    const resolver = makeResolver();
    const controller = new AbortController();
    resolver.resolve4.mockImplementation(async () => {
      controller.abort();
      return ["192.0.0.170", "192.0.0.171"];
    });
    expect(
      await discoverRfc7050Prefixes(controller.signal, () => resolver),
    ).toBeNull();
    expect(resolver.cancel).toHaveBeenCalledOnce();
  });

  it("starts no queries when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const factory = vi.fn(makeResolver);
    expect(
      await discoverRfc7050Prefixes(controller.signal, factory),
    ).toBeNull();
    expect(factory).not.toHaveBeenCalled();
  });
});
