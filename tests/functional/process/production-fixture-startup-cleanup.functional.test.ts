import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type ProductionFixtureSetupProbeEvent,
  startProductionFixture,
} from "../support/production-fixture.js";

describe("production fixture early startup cleanup", () => {
  it.each(["after-clone", "provider-started"] as const)(
    "removes the private clone and closes an opened provider when setup fails at %s",
    async (failureStage) => {
      let fixtureDirectory: string | undefined;
      let providerPort: number | undefined;
      const setupProbe = (event: ProductionFixtureSetupProbeEvent) => {
        if (event.stage !== failureStage) return;
        fixtureDirectory = event.directory;
        providerPort = event.providerPort;
        throw new Error(`injected setup failure at ${failureStage}`);
      };

      await expect(
        startProductionFixture({
          reply: () => ({ _tag: "HttpError", status: 422 }),
          setupProbe,
        }),
      ).rejects.toThrow(`injected setup failure at ${failureStage}`);

      expect(fixtureDirectory).toBeDefined();
      expect(existsSync(fixtureDirectory ?? "")).toBe(false);
      if (failureStage === "provider-started") {
        expect(providerPort).toBeDefined();
        await expect(
          fetch(`http://127.0.0.1:${providerPort}/models`),
        ).rejects.toThrow();
      } else {
        expect(providerPort).toBeUndefined();
      }
    },
    120_000,
  );
});
