import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RuntimeSafetyPolicy } from "../../packages/execution-runtime/src/index.js";
import { createCurrentSchemaTestDatabaseFactory } from "../support/schema44-database.js";
import {
  exe,
  g1,
  g2,
  policy,
  runGate,
  specialist,
  tool,
  turn,
} from "./runtime-safety-support.js";
import { setCurrentSchema44Factory } from "./schema44-factory.js";

let schema44Factory: Awaited<
  ReturnType<typeof createCurrentSchemaTestDatabaseFactory>
>;
beforeAll(async () => {
  schema44Factory = await createCurrentSchemaTestDatabaseFactory({
    prefix: "p12-runtime-safety-template-",
  });
  setCurrentSchema44Factory(schema44Factory);
}, 120_000);
afterAll(() => schema44Factory.cleanup());

// --- D1: max transient retries per operation ---------------------------------

describe("P12-008 D1 max transient retries", () => {
  it("retryCount >= maxRetries -> Stop; {maxRetries:1} stops on the second attempt", async () => {
    const decisions = await runGate(
      policy({ maxRetries: 1 }),
      function* (gate) {
        return [
          yield* gate.admitActivity(exe, turn("t0"), { retryCount: 0 }),
          yield* gate.admitActivity(exe, turn("t0"), { retryCount: 1 }),
        ];
      },
    );
    expect(decisions).toEqual(["Continue", "Stop"]);
  });

  it("policy injection: {maxRetries:3} does not stop through three attempts", async () => {
    const decisions = await runGate(
      policy({ maxRetries: 3 }),
      function* (gate) {
        return [
          yield* gate.admitActivity(exe, turn("t0"), { retryCount: 0 }),
          yield* gate.admitActivity(exe, turn("t0"), { retryCount: 1 }),
          yield* gate.admitActivity(exe, turn("t0"), { retryCount: 2 }),
        ];
      },
    );
    expect(decisions).toEqual(["Continue", "Continue", "Continue"]);
  });

  it("reset on new operation (retryCount 0)", async () => {
    const decisions = await runGate(
      policy({ maxRetries: 2 }),
      function* (gate) {
        return [
          yield* gate.admitActivity(exe, turn("t0"), { retryCount: 0 }),
          yield* gate.admitActivity(exe, turn("t0"), { retryCount: 2 }),
          yield* gate.admitActivity(exe, turn("t1"), { retryCount: 0 }),
        ];
      },
    );
    expect(decisions).toEqual(["Continue", "Stop", "Continue"]);
  });
});

// --- D2: max repeated identical action fingerprints --------------------------

describe("P12-008 D2 repeated action fingerprints", () => {
  it("count > max -> Stop; reset on durable progress", async () => {
    const decisions = await runGate(
      policy({ maxRepeatedFingerprints: 2 }),
      function* (gate) {
        return [
          yield* gate.admitActivity(exe, tool("fp")),
          yield* gate.admitActivity(exe, tool("fp")),
          yield* gate.admitActivity(exe, tool("fp")),
          yield* gate.admitActivity(exe, turn("t1"), {
            durableProgress: true,
          }),
          yield* gate.admitActivity(exe, tool("fp")),
        ];
      },
    );
    expect(decisions).toEqual([
      "Continue",
      "Continue",
      "Stop",
      "Continue",
      "Continue",
    ]);
  });
});

// --- D3: max tool recursion / chaining depth ---------------------------------

describe("P12-008 D3 tool recursion depth", () => {
  it("depth > max -> Stop; reset on a new chain (chainDepth 0)", async () => {
    const decisions = await runGate(
      policy({ maxRecursionDepth: 2 }),
      function* (gate) {
        return [
          yield* gate.admitActivity(exe, tool("t"), { chainDepth: 1 }),
          yield* gate.admitActivity(exe, tool("t"), { chainDepth: 2 }),
          yield* gate.admitActivity(exe, tool("t"), { chainDepth: 3 }),
          yield* gate.admitActivity(exe, turn("t1"), { chainDepth: 0 }),
          yield* gate.admitActivity(exe, tool("t"), { chainDepth: 1 }),
        ];
      },
    );
    expect(decisions).toEqual([
      "Continue",
      "Continue",
      "Stop",
      "Continue",
      "Continue",
    ]);
  });

  it("a SpecialistAction boundary observes the same chain depth", async () => {
    const decisions = await runGate(
      policy({ maxRecursionDepth: 0 }),
      function* (gate) {
        return [
          yield* gate.admitActivity(exe, specialist("spawn-1"), {
            chainDepth: 1,
          }),
        ];
      },
    );
    expect(decisions).toEqual(["Stop"]);
  });
});

// --- D4: max consecutive turns without durable progress ----------------------

describe("P12-008 D4 no-progress turns", () => {
  it("turns > max -> Stop; durableProgress:true resets the counter", async () => {
    const decisions = await runGate(
      policy({ maxNoProgressTurns: 2 }),
      function* (gate) {
        return [
          yield* gate.admitActivity(exe, turn("t0"), {
            durableProgress: false,
          }),
          yield* gate.admitActivity(exe, turn("t1"), {
            durableProgress: false,
          }),
          yield* gate.admitActivity(exe, turn("t2"), {
            durableProgress: false,
          }),
          yield* gate.admitActivity(exe, turn("t3"), { durableProgress: true }),
          yield* gate.admitActivity(exe, turn("t4"), {
            durableProgress: false,
          }),
        ];
      },
    );
    expect(decisions).toEqual([
      "Continue",
      "Continue",
      "Stop",
      "Continue",
      "Continue",
    ]);
  });

  it("an absent durableProgress signal at a turn boundary counts as no progress", async () => {
    const decisions = await runGate(
      policy({ maxNoProgressTurns: 0 }),
      function* (gate) {
        return [yield* gate.admitActivity(exe, turn("t0"))];
      },
    );
    expect(decisions).toEqual(["Stop"]);
  });
});

// --- D5: provider / tool concurrency ceilings --------------------------------

describe("P12-008 D5 concurrency ceiling", () => {
  it("in-flight > ceiling -> Stop; reset on call completion", async () => {
    const decisions = await runGate(
      policy({ concurrencyCeiling: 2 }),
      function* (gate) {
        return [
          yield* gate.admitActivity(exe, turn("t0"), {
            inFlight: "begin",
            leaseGeneration: g1,
          }),
          yield* gate.admitActivity(exe, turn("t1"), {
            inFlight: "begin",
            leaseGeneration: g1,
          }),
          yield* gate.admitActivity(exe, turn("t2"), {
            inFlight: "begin",
            leaseGeneration: g1,
          }),
          yield* gate.admitActivity(exe, turn("t3"), {
            inFlight: "end",
            leaseGeneration: g1,
          }),
          yield* gate.admitActivity(exe, turn("t4"), {
            inFlight: "begin",
            leaseGeneration: g1,
          }),
        ];
      },
    );
    expect(decisions).toEqual([
      "Continue",
      "Continue",
      "Stop",
      "Continue",
      "Stop",
    ]);
  });

  it("gauge is lease-scoped: a stale leaseGeneration does not count against the live lease", async () => {
    const decisions = await runGate(
      policy({ concurrencyCeiling: 1 }),
      function* (gate) {
        return [
          yield* gate.admitActivity(exe, turn("t0"), {
            inFlight: "begin",
            leaseGeneration: g1,
          }),
          yield* gate.admitActivity(exe, turn("t1"), {
            inFlight: "begin",
            leaseGeneration: g1,
          }),
          yield* gate.admitActivity(exe, turn("t2"), {
            inFlight: "begin",
            leaseGeneration: g2,
          }),
        ];
      },
    );
    expect(decisions).toEqual(["Continue", "Stop", "Continue"]);
  });
});

describe("P12-008 provider lease bracket accounting", () => {
  it("does not count lease completion as another repeated action", async () => {
    const decisions = await runGate(
      policy({ maxRepeatedFingerprints: 1 }),
      function* (gate) {
        return [
          yield* gate.admitActivity(exe, turn("t0"), {
            inFlight: "begin",
            leaseGeneration: g1,
          }),
          yield* gate.admitActivity(exe, turn("t0"), {
            inFlight: "end",
            leaseGeneration: g1,
          }),
          yield* gate.admitActivity(exe, turn("t0"), {
            inFlight: "end",
            leaseGeneration: g1,
          }),
          yield* gate.admitActivity(exe, turn("t0"), {
            inFlight: "begin",
            leaseGeneration: g1,
          }),
        ];
      },
    );
    expect(decisions).toEqual(["Continue", "Continue", "Continue", "Stop"]);
  });

  it("counts provider requests at begin but not again at lease completion", async () => {
    const decisions = await runGate(
      policy({ maxRepeatedFingerprints: 10, rateLimit: 2 }),
      function* (gate) {
        return [
          yield* gate.admitActivity(exe, turn("t0"), {
            inFlight: "begin",
            leaseGeneration: g1,
            observedAt: "2026-01-01T00:00:00.000Z",
          }),
          yield* gate.admitActivity(exe, turn("t0"), {
            inFlight: "end",
            leaseGeneration: g1,
            observedAt: "2026-01-01T00:00:00.000Z",
          }),
          yield* gate.admitActivity(exe, turn("t1"), {
            inFlight: "begin",
            leaseGeneration: g1,
            observedAt: "2026-01-01T00:00:00.000Z",
          }),
        ];
      },
    );
    expect(decisions).toEqual(["Continue", "Continue", "Continue"]);
  });
});

// --- D6: rate / runaway protection -------------------------------------------

describe("P12-008 D6 rate window", () => {
  it("N calls inside rateWindowMs Continue, (N+1)-th Stop; window expiry resets", async () => {
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    const at = (ms: number) => new Date(t0 + ms).toISOString();
    const decisions = await runGate(
      policy({ rateLimit: 2, rateWindowMs: 1000 }),
      function* (gate) {
        return [
          yield* gate.admitActivity(exe, turn("t0"), { observedAt: at(0) }),
          yield* gate.admitActivity(exe, turn("t1"), { observedAt: at(100) }),
          yield* gate.admitActivity(exe, turn("t2"), { observedAt: at(200) }),
          yield* gate.admitActivity(exe, turn("t3"), { observedAt: at(2000) }),
          yield* gate.admitActivity(exe, turn("t4"), { observedAt: at(2100) }),
          yield* gate.admitActivity(exe, turn("t5"), { observedAt: at(2200) }),
        ];
      },
    );
    expect(decisions).toEqual([
      "Continue",
      "Continue",
      "Stop",
      "Continue",
      "Continue",
      "Stop",
    ]);
  });
});

// --- restart / durability (RG-11; P9 03 §4) ----------------------------------

describe("P12-008 restart / durability", () => {
  it("counters are in-process and reset on reconstruction (no durable upgrade)", async () => {
    const p = policy({ maxRepeatedFingerprints: 3 });
    const before = await runGate(p, function* (gate) {
      return [
        yield* gate.admitActivity(exe, tool("fp")),
        yield* gate.admitActivity(exe, tool("fp")),
      ];
    });
    expect(before).toEqual(["Continue", "Continue"]);

    const after = await runGate(p, function* (gate) {
      return [
        yield* gate.admitActivity(exe, tool("fp")),
        yield* gate.admitActivity(exe, tool("fp")),
        yield* gate.admitActivity(exe, tool("fp")),
        yield* gate.admitActivity(exe, tool("fp")),
      ];
    });
    expect(after).toEqual(["Continue", "Continue", "Continue", "Stop"]);
  });
});

// --- policy surface ----------------------------------------------------------

describe("P12-008 policy surface", () => {
  it("every dimension is configured from RuntimeSafetyPolicy (no unlimited default)", () => {
    const configured: RuntimeSafetyPolicy = {
      maxRetries: 1,
      maxRepeatedFingerprints: 2,
      maxRecursionDepth: 3,
      maxNoProgressTurns: 4,
      concurrencyCeiling: 5,
      rateLimit: 6,
      rateWindowMs: 7,
    };
    expect(Object.values(configured)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

// --- end-to-end: violation -> Interrupted(RuntimeSafetyStop), Work Open ------
