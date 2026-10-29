import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";
import { functionalId, makePublicClient } from "../support/public-client.js";

const fixtures: ProductionFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

describe("F21 trusted project resource admission", () => {
  it("rejects a v2 selector combined with a raw client-supplied path", async () => {
    const fixture = await startProductionFixture({
      isolatedPortHandshake: true,
      admitWorkspaceDirectory: true,
      reply: () => ({ _tag: "Text", text: "No model call expected" }),
    });
    fixtures.push(fixture);
    const unregisteredDirectory = join(fixture.directory, "unregistered");
    mkdirSync(unregisteredDirectory);
    writeFileSync(join(unregisteredDirectory, "proof.txt"), "UNREGISTERED");
    const client = makePublicClient(fixture.baseUrl);
    const catalog = await client.projectResources();
    const available = catalog.profiles.filter((profile) => profile.available);
    expect(available).toHaveLength(1);
    const profile = available[0];
    if (profile === undefined) throw new Error("host Profile was not listed");

    const projectId = functionalId("prj");
    const workspaceId = functionalId("ws");
    const response = await client.rawCommand(projectId, "CreateProject", {
      name: "F21 unregistered client path",
      revision: 0,
      projectPolicy: {},
      projectPolicyRevision: 0,
      defaultConfiguration: {},
      environmentRef: "local",
      rootWorkspaceId: workspaceId,
      primarySession: { sessionId: functionalId("ses"), contextEpoch: 0 },
      rootWorkspace: {
        name: "root",
        responsibilityDefinition: {
          purpose: "F21 unregistered client path",
          ownedResponsibilities: [],
          obligations: [],
          includes: [],
          excludes: [],
          interfaces: [],
        },
        responsibilityRevision: 0,
        resourceSelection: {
          _tag: "Profile",
          resourceProfileRef: profile.resourceProfileRef,
          version: profile.version,
        },
        // Deliberate forbidden legacy field: strict CreateProject v2 must not
        // accept or prefer a caller-supplied path alongside Profile selection.
        resourceBoundary: {
          basisResponsibilityRevision: 0,
          addresses: [{ _tag: "FileTree", path: unregisteredDirectory }],
        },
        resourceBoundaryRevision: 0,
        agentBinding: {
          _tag: "ResponsibilityBoundAgentBinding",
          workspaceId,
        },
        workspacePolicy: {},
        workspacePolicyRevision: 0,
        revision: 0,
      },
    });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.payload)).not.toContain(
      unregisteredDirectory,
    );
    expect(fixture.daemonErrors).toEqual([]);
    expect(fixture.providerCalls).toHaveLength(0);
  }, 45_000);
});
