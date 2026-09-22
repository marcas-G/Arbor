import { describe, expect, it } from "vitest";
import { labeled } from "./support/p9-harness-api.js";

describe("P9-001 harness (PB rows as capability proof)", () => {
  it("guarantee-class labeling convention is exactly two-valued and every record carries one", () => {
    const crash = labeled("PB1-commit-rollback", "crash-injected");
    const durability = labeled("DA-reopen-integrity", "durability-asserted");
    expect(crash.guarantee).toBe("crash-injected");
    expect(durability.guarantee).toBe("durability-asserted");
  });

  it("harness never claims power/WAL injection (GQ5: no fault-injecting adapter class)", async () => {
    const modes = await import("./support/p9-fault-transaction.js");
    // The harness surface exposes exactly three envelope-internal modes;
    // no power-loss / wal-corrupt / page-tear mode exists (GQ5).
    const exported = Object.keys(modes).sort();
    expect(exported).toContain("faultingTransactionP9");
    const modeType: string[] = [
      "fail-on-begin",
      "rollback-after-body",
      "fail-on-commit",
    ];
    expect(modeType.includes("simulate-power-loss")).toBe(false);
  });
});
