import { expect, test } from "vitest";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";
import { functionalId, makePublicClient } from "../support/public-client.js";

let fixture: ProductionFixture;

test.beforeAll(async () => {
  fixture = await startProductionFixture({
    admitWorkspaceDirectory: true,
    reply: () => ({ _tag: "Text", text: "No model call expected" }),
  });
});

test.afterAll(async () => {
  await fixture.stop();
});

test("public CreateProject Profile receipt survives daemon restart without exposing or changing the host path", async () => {
  const client = makePublicClient(fixture.baseUrl);
  const catalog = await client.projectResources();
  const available = catalog.profiles.filter((profile) => profile.available);
  expect(available).toHaveLength(1);
  const profile = available[0];
  if (profile === undefined) throw new Error("host Profile was not listed");
  expect(JSON.stringify(catalog)).not.toContain(fixture.workspaceDirectory);

  const projectId = functionalId("prj");
  const workspaceId = functionalId("ws");
  const commandId = functionalId("cmd");
  const envelope = {
    commandType: "CreateProject",
    commandId,
    projectId,
    actor: "user:local",
    issuedAt: "2026-10-10T00:00:00.000Z",
    payload: {
      name: "F21 public Profile restart",
      revision: 0,
      projectPolicy: { delegationCeiling: 1 },
      projectPolicyRevision: 0,
      defaultConfiguration: {},
      environmentRef: "local",
      rootWorkspaceId: workspaceId,
      primarySession: {
        sessionId: functionalId("ses"),
        contextEpoch: 0,
      },
      rootWorkspace: {
        name: "root",
        responsibilityDefinition: {
          purpose: "F21 public Profile restart",
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
        agentBinding: {
          _tag: "ResponsibilityBoundAgentBinding",
          workspaceId,
        },
        workspacePolicy: { delegationCeiling: 1 },
        workspacePolicyRevision: 0,
        revision: 0,
      },
    },
  };
  const send = async () => {
    const response = await fetch(`${fixture.baseUrl}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    return { status: response.status, body: await response.json() };
  };

  const first = await send();
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({
    ok: true,
    body: { commandId, resolution: "Committed" },
  });
  expect(JSON.stringify(first.body)).not.toContain(fixture.workspaceDirectory);

  await fixture.restart();
  const afterRestartCatalog = await client.projectResources();
  expect(afterRestartCatalog).toEqual(catalog);
  const replay = await send();
  expect(replay.status).toBe(200);
  expect(replay.body).toMatchObject({
    ok: true,
    body: { commandId, resolution: "Committed" },
  });
  expect(JSON.stringify(replay.body)).not.toContain(fixture.workspaceDirectory);
  expect(fixture.daemonErrors).toEqual([]);
  expect(fixture.providerCalls).toHaveLength(0);
});
