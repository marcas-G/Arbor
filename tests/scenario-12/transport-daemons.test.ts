import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  makeConsumerLoopDaemon,
  makeDriftWatcherTrigger,
  makeProductionDaemon,
  makeRecoveryDaemon,
  recoveryDaemonFromPrincipal,
} from "../../apps/single-workspace/src/transport/index.js";
import type { DriftReport } from "../../packages/application/src/index.js";
import {
  emptyConsumerResult,
  HUMAN,
  PROJECT,
  readTransport,
} from "./transport-support.js";

describe("deployment daemons are wired (EC-11)", () => {
  it("production daemon sequences migrate -> startup recovery -> sweeps -> offset polls", async () => {
    const order: string[] = [];
    const recovery = makeRecoveryDaemon({
      startupRecovery: Effect.sync(() => {
        order.push("startup");
      }),
      sweepRecovery: Effect.sync(() => {
        order.push("sweep");
      }),
    });
    const consumers = [
      makeConsumerLoopDaemon({
        consumerId: "verification",
        projectId: PROJECT,
        batchSize: 10,
        poll: Effect.sync(() => {
          order.push("poll:verification");
          return emptyConsumerResult;
        }),
      }),
      makeConsumerLoopDaemon({
        consumerId: "completion",
        projectId: PROJECT,
        batchSize: 10,
        poll: Effect.sync(() => {
          order.push("poll:completion");
          return emptyConsumerResult;
        }),
      }),
    ];
    const daemon = makeProductionDaemon({
      migrate: Effect.sync(() => {
        order.push("migrate");
      }),
      recovery,
      consumers,
    });

    await Effect.runPromise(daemon.start);
    expect(order).toEqual(["migrate", "startup"]);

    order.length = 0;
    await Effect.runPromise(daemon.recoveryTick);
    expect(order).toEqual(["sweep"]);

    order.length = 0;
    const results = await Effect.runPromise(daemon.pollConsumers);
    expect(order).toEqual(["poll:verification", "poll:completion"]);
    expect(results).toHaveLength(2);
  });

  it("drift watcher triggers a probe and is never a truth source", async () => {
    const seen: Array<string> = [];
    const watcher = makeDriftWatcherTrigger({
      probe: (projectId) =>
        Effect.sync(() => {
          seen.push(projectId);
          return { _tag: "NoDrift", atRevision: "3" } as DriftReport;
        }),
    });
    const report = await Effect.runPromise(watcher.trigger(PROJECT, []));
    expect(report._tag).toBe("NoDrift");
    expect(seen).toEqual([PROJECT]);
  });

  it("daemons bind the real recovery / consumer / drift functions", () => {
    const source = readTransport("daemons.ts");
    for (const wired of [
      "startupRecovery",
      "sweepRecovery",
      "pollOnce",
      "verificationConsumerLoop",
      "completionConsumerLoop",
      "probeDrift",
    ]) {
      expect(source.includes(wired), `daemons.ts: ${wired}`).toBe(true);
    }
    for (const forbidden of [
      "RecordEnvironmentChange",
      ".record(",
      "advanceAnchor",
    ]) {
      expect(source.includes(forbidden), `daemons.ts: ${forbidden}`).toBe(
        false,
      );
    }
    const recovery = recoveryDaemonFromPrincipal(HUMAN);
    expect(recovery.startup).toBeDefined();
    expect(recovery.sweep).toBeDefined();
  });
});
