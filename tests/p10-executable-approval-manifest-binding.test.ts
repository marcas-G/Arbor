import { describe, expect, it } from "vitest";
import { approvedToolHashFromManifest } from "../apps/single-workspace/src/projection-query.js";

const binding = {
  providerTurnId: "ptr_7",
  executionId: "exe_7",
  logicalStepNo: 12,
  repairAttempt: 1,
  toolName: "shell",
  toolVersion: "2",
} as const;

const manifestJson = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    providerTurnId: binding.providerTurnId,
    executionId: binding.executionId,
    logicalStepNo: binding.logicalStepNo,
    repairAttempt: binding.repairAttempt,
    toolRoutes: [
      {
        name: binding.toolName,
        route: "Executable",
        version: binding.toolVersion,
        hash: "hash-A",
      },
    ],
    toolRefs: ["Executable:shell@2#hash-A"],
    ...overrides,
  });

describe("P10 Executable approval manifest tool identity", () => {
  it("reads the exact original name/version/hash from the bound Executable manifest route", () => {
    expect(
      approvedToolHashFromManifest({
        ...binding,
        manifestJson: manifestJson(),
      }),
    ).toBe("hash-A");
  });

  it.each([
    ["missing route", { toolRoutes: [] }],
    [
      "duplicate route",
      {
        toolRoutes: [
          {
            name: binding.toolName,
            route: "Executable",
            version: binding.toolVersion,
            hash: "hash-A",
          },
          {
            name: binding.toolName,
            route: "Executable",
            version: binding.toolVersion,
            hash: "hash-A",
          },
        ],
      },
    ],
    ["missing exact tool ref", { toolRefs: [] }],
    [
      "duplicate exact tool ref",
      {
        toolRefs: ["Executable:shell@2#hash-A", "Executable:shell@2#hash-A"],
      },
    ],
  ] as const)("fails closed for a %s", (_name, overrides) => {
    expect(
      approvedToolHashFromManifest({
        ...binding,
        manifestJson: manifestJson(overrides),
      }),
    ).toBeNull();
  });

  it("fails closed when the durable manifest belongs to another step or ProviderTurn", () => {
    const mismatches: ReadonlyArray<Record<string, unknown>> = [
      { providerTurnId: "ptr_foreign" },
      { executionId: "exe_foreign" },
      { logicalStepNo: binding.logicalStepNo + 1 },
      { repairAttempt: binding.repairAttempt + 1 },
    ];
    for (const mismatch of mismatches) {
      expect(
        approvedToolHashFromManifest({
          ...binding,
          manifestJson: manifestJson(mismatch),
        }),
      ).toBeNull();
    }
  });
});
