import { describe, it } from "vitest";
import { ah10GenRecoverCommittedAcceptResultReceipt } from "./phases-accept-recovery.js";
import { ah10GenTakeoverAcceptResult } from "./phases-accept-takeover.js";
import { ah10GenRecoverCommittedDeliverableReceipt } from "./phases-deliverable-recovery.js";
import { ah10GenRecoverCommittedDeclareDependencyReceipt } from "./phases-dependency-recovery.js";
import { ah10GenTakeoverDeclareDependency } from "./phases-dependency-takeover.js";
import { ah10GenTakeoverFenceReceipt } from "./phases-fence-receipt.js";

describe("AH10 real daemon generation takeover", () => {
  it.each(["before", "after"] as const)(
    "crashes the old owner %s its fence receipt commit, then lets the new owner commit once",
    async (crashSide) => {
      await ah10GenTakeoverFenceReceipt(crashSide);
    },
    120_000,
  );

  it("recovers a committed Deliverable receipt when its Action is still Pending", async () => {
    await ah10GenRecoverCommittedDeliverableReceipt();
  }, 180_000);

  it("recovers a committed DeclareDependency receipt while its Action is Pending", async () => {
    await ah10GenRecoverCommittedDeclareDependencyReceipt();
  }, 150_000);

  it.each(["before", "after"] as const)(
    "takes over DeclareDependency after killing the old owner %s its FencingRejected receipt commits",
    async (crashSide) => {
      await ah10GenTakeoverDeclareDependency(crashSide);
    },
    120_000,
  );

  it.each(["before", "after"] as const)(
    "takes over AcceptResult when the old FencingRejected receipt is interrupted %s commit",
    async (crashSide) => {
      await ah10GenTakeoverAcceptResult(crashSide);
    },
    120_000,
  );

  it("recovers a committed AcceptResult receipt while its Action is Pending", async () => {
    await ah10GenRecoverCommittedAcceptResultReceipt();
  }, 180_000);
});
