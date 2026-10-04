import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";
import {
  createFunctionalProject,
  makePublicClient,
} from "../support/public-client.js";

const fixtures: ProductionFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

describe("F21 trusted project resource admission", () => {
  it("rejects a raw client-supplied path outside the host-registered directory", async () => {
    const fixture = await startProductionFixture({
      admitWorkspaceDirectory: true,
      reply: () => ({ _tag: "Text", text: "No model call expected" }),
    });
    fixtures.push(fixture);
    const unregisteredDirectory = join(fixture.directory, "unregistered");
    mkdirSync(unregisteredDirectory);
    writeFileSync(join(unregisteredDirectory, "proof.txt"), "UNREGISTERED");

    await expect(
      createFunctionalProject(
        makePublicClient(fixture.baseUrl),
        unregisteredDirectory,
        "F21 unregistered client path",
      ),
    ).rejects.toThrow();
    expect(fixture.daemonErrors).toEqual([]);
  }, 45_000);
});
