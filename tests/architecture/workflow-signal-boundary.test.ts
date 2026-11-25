import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const source = (path: string) => readFileSync(join(root, path), "utf8");

describe("workflow signal boundary", () => {
  it("has one typed application consumer and one offset-driven production daemon", () => {
    const consumerPath = "packages/application/src/workflow-signal-consumer.ts";
    expect(existsSync(join(root, consumerPath))).toBe(true);
    const consumer = source(consumerPath);
    const daemons = source("apps/single-workspace/src/transport/daemons.ts");
    const production = source("apps/single-workspace/src/production.ts");

    expect(consumer).toContain("deliverWakeSignal");
    expect(consumer).toContain("deliverVerificationWake");
    expect(consumer).toContain("admitSpecialistSettlement");
    expect(daemons).toContain("workflowSignalConsumerLoop");
    expect(daemons).toContain("pollOnce");
    expect(production).toContain("workflowSignalConsumerDaemon");
    expect(production).toContain('consumerId: "workflow-signals"');
    expect(production).toContain("consumer: workflowSignals");
    expect(production).not.toContain(
      "dependencies: {\n                tx,\n                waits,",
    );
  });

  it("keeps verification wake delivery out of the synchronous control handler", () => {
    const controls = [
      "apps/single-workspace/src/control-actions.ts",
      ...[
        "command-receipts",
        "assign-work",
        "workspace",
        "work-lifecycle",
        "send-message",
        "dependency-deliverable",
        "delivery",
        "verification",
      ].map((name) => `apps/single-workspace/src/control-actions/${name}.ts`),
    ];
    for (const path of controls) {
      const handler = source(path);
      expect(handler).not.toContain("channel1Release");
      expect(handler).not.toContain("consumeConclusionSignals");
      expect(handler).not.toContain("deliverVerificationWake");
    }
  });
});
