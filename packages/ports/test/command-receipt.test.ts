import type { CommandReceipt } from "@arbor/domain";
import { describe, expect, it } from "vitest";

type PortsReceipt = CommandReceipt<unknown, unknown>;

describe("ports can consume the domain CommandReceipt", () => {
  it("instantiates the domain generic with unknown parameters", () => {
    const receipt: PortsReceipt | null = null;
    expect(receipt).toBeNull();
  });
});
