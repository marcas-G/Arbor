import { describe, expect, it, vi } from "vitest";
import {
  type BrokerDependencies,
  type BrokerResponse,
  downloadThroughBroker,
} from "../src/transport/network-broker.js";

const enabled = { version: 1, mode: "Enabled", destinations: [] } as const;
const restricted = {
  version: 1,
  mode: "Restricted",
  destinations: ["https://registry.npmjs.org"],
} as const;
const input = () => ({
  policy: enabled,
  url: "https://registry.npmjs.org/pkg",
  maxBytes: 1024,
  timeoutMs: 1000,
  signal: new AbortController().signal,
});
const response = (status = 200, location?: string) => ({
  status,
  location,
  body: (async function* () {
    yield new TextEncoder().encode("package bytes");
  })(),
  close: vi.fn(),
});
const harness = () => {
  const reply = response();
  return {
    reply,
    discoverPref64: vi.fn<BrokerDependencies["discoverPref64"]>(async () => []),
    resolveAll: vi.fn(async () => ["8.8.8.8", "2606:4700::1111"]),
    connect: vi.fn<NonNullable<BrokerDependencies["connect"]>>(
      async () => reply,
    ),
  };
};

describe("T2 HTTPS broker orchestration (injected transport, not T3 qualification)", () => {
  it("pins an authorized address with fresh per-resolution and per-connection discovery", async () => {
    const deps = harness();
    const result = await downloadThroughBroker(input(), deps);
    expect(new TextDecoder().decode(result.bytes)).toBe("package bytes");
    expect(deps.discoverPref64).toHaveBeenCalledTimes(2);
    expect(deps.connect.mock.calls[0]?.slice(0, 2)).toEqual([
      new URL(input().url),
      { address: "8.8.8.8", family: 4 },
    ]);
    expect(deps.reply.close).toHaveBeenCalledOnce();
  });

  it("does not discover, resolve or connect for Disabled or unlisted destinations", async () => {
    const deps = harness();
    for (const policy of [
      { ...enabled, mode: "Disabled" as const },
      restricted,
    ]) {
      await expect(
        downloadThroughBroker(
          { ...input(), policy, url: "https://github.com/pkg" },
          deps,
        ),
      ).rejects.toMatchObject({ code: "sandbox/network-denied" });
    }
    expect(deps.discoverPref64).not.toHaveBeenCalled();
    expect(deps.resolveAll).not.toHaveBeenCalled();
    expect(deps.connect).not.toHaveBeenCalled();
  });

  it("fails unknown discovery before DNS, without guessing NoDns64", async () => {
    const deps = harness();
    deps.discoverPref64.mockResolvedValue(null);
    await expect(downloadThroughBroker(input(), deps)).rejects.toMatchObject({
      code: "sandbox/pref64-unknown",
    });
    expect(deps.resolveAll).not.toHaveBeenCalled();
    expect(deps.connect).not.toHaveBeenCalled();
  });

  it("classifies discovery failure as unknown without falling back to no synthesis", async () => {
    const deps = harness();
    deps.discoverPref64.mockRejectedValue(new Error("resolver unavailable"));
    await expect(downloadThroughBroker(input(), deps)).rejects.toMatchObject({
      code: "sandbox/pref64-unknown",
    });
    expect(deps.resolveAll).not.toHaveBeenCalled();
    expect(deps.connect).not.toHaveBeenCalled();
  });

  it("does not permit caller mutation to widen an in-flight Restricted policy", async () => {
    const deps = harness();
    const policy = {
      ...restricted,
      destinations: [...restricted.destinations] as string[],
    };
    deps.discoverPref64.mockImplementation(async () => {
      policy.destinations.push("https://github.com");
      return [];
    });
    deps.connect.mockResolvedValueOnce(response(302, "https://github.com/pkg"));
    await expect(
      downloadThroughBroker({ ...input(), policy }, deps),
    ).rejects.toMatchObject({ code: "sandbox/redirect-denied" });
    expect(deps.connect).toHaveBeenCalledOnce();
  });

  it("rechecks discovery before connecting even when resolution was public", async () => {
    const deps = harness();
    deps.discoverPref64.mockResolvedValueOnce([]).mockResolvedValueOnce(null);
    await expect(downloadThroughBroker(input(), deps)).rejects.toMatchObject({
      code: "sandbox/pref64-unknown",
    });
    expect(deps.connect).not.toHaveBeenCalled();
  });

  it("rejects a newly discovered synthesis prefix instead of using an older result", async () => {
    const deps = harness();
    deps.discoverPref64
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ address: "2606:4700::", length: 96 }]);
    await expect(downloadThroughBroker(input(), deps)).rejects.toMatchObject({
      code: "sandbox/network-denied",
    });
    expect(deps.connect).not.toHaveBeenCalled();
  });

  it("rejects a mixed answer set instead of selecting the public answer", async () => {
    const deps = harness();
    deps.resolveAll.mockResolvedValue(["8.8.8.8", "127.0.0.1"]);
    await expect(downloadThroughBroker(input(), deps)).rejects.toMatchObject({
      code: "sandbox/network-denied",
    });
    expect(deps.connect).not.toHaveBeenCalled();
  });

  it("does not reuse DNS, discovery or connections across downloads", async () => {
    const deps = harness();
    await downloadThroughBroker(input(), deps);
    deps.resolveAll.mockResolvedValue(["127.0.0.1"]);
    await expect(downloadThroughBroker(input(), deps)).rejects.toMatchObject({
      code: "sandbox/network-denied",
    });
    expect(deps.connect).toHaveBeenCalledOnce();
    expect(deps.resolveAll).toHaveBeenCalledTimes(2);
  });

  it("rechecks every redirect and closes every response", async () => {
    const deps = harness();
    const redirect = response(302, "https://github.com/pkg");
    deps.connect.mockResolvedValueOnce(redirect);
    const result = await downloadThroughBroker(input(), deps);
    expect(result.url).toBe("https://github.com/pkg");
    expect(deps.discoverPref64).toHaveBeenCalledTimes(4);
    expect(deps.resolveAll.mock.calls).toEqual([
      ["registry.npmjs.org", expect.any(AbortSignal)],
      ["github.com", expect.any(AbortSignal)],
    ]);
    expect(redirect.close).toHaveBeenCalledOnce();
    expect(deps.reply.close).toHaveBeenCalledOnce();
  });

  it.each([
    "http://registry.npmjs.org/pkg",
    "https://127.0.0.1/pkg",
    "https://github.com/pkg",
    "https://registry.npmjs.org:443/pkg",
    "//registry.npmjs.org:443/pkg",
    "https://user@registry.npmjs.org/pkg",
    "https://REGISTRY.npmjs.org/pkg",
    " https://registry.npmjs.org/pkg",
    "/\\evil.test/pkg",
  ])(
    "rejects unauthorized or repaired redirect %s before another connection",
    async (location) => {
      const deps = harness();
      const redirect = response(302, location);
      deps.connect.mockResolvedValueOnce(redirect);
      await expect(
        downloadThroughBroker({ ...input(), policy: restricted }, deps),
      ).rejects.toMatchObject({ code: "sandbox/redirect-denied" });
      expect(deps.connect).toHaveBeenCalledOnce();
      expect(redirect.close).toHaveBeenCalledOnce();
    },
  );

  it("rejects private DNS on an otherwise authorized redirect", async () => {
    const deps = harness();
    deps.connect.mockResolvedValueOnce(response(302, "/second"));
    deps.resolveAll
      .mockResolvedValueOnce(["8.8.8.8"])
      .mockResolvedValueOnce(["127.0.0.1"]);
    await expect(downloadThroughBroker(input(), deps)).rejects.toMatchObject({
      code: "sandbox/network-denied",
    });
    expect(deps.connect).toHaveBeenCalledOnce();
  });

  it("permits five redirects and rejects a sixth without following it", async () => {
    const deps = harness();
    const redirects = Array.from({ length: 6 }, (_, i) =>
      response(302, `/hop-${i}`),
    );
    for (const redirect of redirects.slice(0, 5))
      deps.connect.mockResolvedValueOnce(redirect);
    await expect(downloadThroughBroker(input(), deps)).resolves.toMatchObject({
      url: "https://registry.npmjs.org/hop-4",
    });
    deps.connect.mockClear();
    for (const redirect of redirects)
      deps.connect.mockResolvedValueOnce(redirect);
    await expect(downloadThroughBroker(input(), deps)).rejects.toMatchObject({
      code: "sandbox/redirect-denied",
    });
    expect(deps.connect).toHaveBeenCalledTimes(6);
    expect(redirects[5]?.close).toHaveBeenCalledOnce();
  });

  it("enforces the byte limit and closes the response on overflow", async () => {
    const deps = harness();
    await expect(
      downloadThroughBroker({ ...input(), maxBytes: 2 }, deps),
    ).rejects.toMatchObject({ code: "sandbox/download-limit" });
    expect(deps.reply.close).toHaveBeenCalledOnce();
  });

  it("propagates cancellation to a live transfer and closes the response", async () => {
    const deps = harness();
    const controller = new AbortController();
    const reply: BrokerResponse = {
      ...response(),
      body: (async function* () {
        controller.abort();
        yield new Uint8Array([1]);
      })(),
    };
    deps.connect.mockResolvedValue(reply);
    await expect(
      downloadThroughBroker({ ...input(), signal: controller.signal }, deps),
    ).rejects.toMatchObject({ code: "sandbox/download-aborted" });
    expect(deps.connect.mock.calls[0]?.[2].aborted).toBe(true);
    expect(reply.close).toHaveBeenCalledOnce();
  });

  it("does not retry a failed TLS connection against an unvalidated address", async () => {
    const deps = harness();
    deps.connect.mockRejectedValue(new Error("certificate mismatch"));
    await expect(downloadThroughBroker(input(), deps)).rejects.toMatchObject({
      code: "sandbox/network-unavailable",
    });
    expect(deps.connect).toHaveBeenCalledOnce();
  });

  it("aborts a pending DNS operation at the total deadline", async () => {
    const deps = harness();
    const resolveAll = vi.fn<NonNullable<BrokerDependencies["resolveAll"]>>(
      async (_hostname, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    await expect(
      downloadThroughBroker(
        { ...input(), timeoutMs: 10 },
        { ...deps, resolveAll },
      ),
    ).rejects.toMatchObject({ code: "sandbox/download-aborted" });
    expect(resolveAll.mock.calls[0]?.[1].aborted).toBe(true);
    expect(deps.connect).not.toHaveBeenCalled();
  });

  it("closes an interrupted response and does not return its partial bytes", async () => {
    const deps = harness();
    deps.connect.mockResolvedValue({
      ...deps.reply,
      body: (async function* () {
        yield new Uint8Array([1, 2]);
        throw new Error("connection interrupted");
      })(),
    });
    await expect(downloadThroughBroker(input(), deps)).rejects.toMatchObject({
      code: "sandbox/network-unavailable",
    });
    expect(deps.reply.close).toHaveBeenCalledOnce();
  });
});
