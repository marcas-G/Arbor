import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  type ProductionFixtureSetupProbeEvent,
  startProductionFixture,
} from "../support/production-fixture.js";
import {
  createFunctionalProject,
  makePublicClient,
  submitHumanMessage,
  waitForPublic,
} from "../support/public-client.js";

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

describe("production fixture provider isolation", () => {
  it("uses the scripted provider instead of a HOME config before and after restart", async () => {
    const daemonEnvironment: Record<string, string> = {};
    const fixture = await startProductionFixture({
      daemonEnvironment,
      setupProbe: ({ stage, directory }) => {
        if (stage !== "after-clone") return;
        const home = join(directory, "shadow-home");
        const configDirectory = join(home, ".config", "arbor");
        mkdirSync(configDirectory, { recursive: true });
        writeFileSync(
          join(configDirectory, "arbor.config.json"),
          JSON.stringify({
            provider: {
              deploymentId: "dep-unwanted-home-provider",
              modelRef: "model-openai",
              endpoint: "http://127.0.0.1:1/v1",
              wireModelName: "unwanted-home-model",
            },
          }),
          { mode: 0o600 },
        );
        daemonEnvironment.HOME = home;
      },
      reply: () => "ISOLATED_FIXTURE_REPLY",
    });
    try {
      const client = makePublicClient(fixture.baseUrl);
      const project = await createFunctionalProject(
        client,
        fixture.workspaceDirectory,
        "provider config isolation",
      );
      for (const message of ["before restart", "after restart"]) {
        if (message === "after restart") await fixture.restart();
        const callsBefore = fixture.providerCalls.length;
        await submitHumanMessage(client, project, message);
        const transcript = await waitForPublic(
          () =>
            client.view<{
              entries: ReadonlyArray<{ kind: string; body?: string }>;
            }>("transcript", {
              workspaceId: project.rootWorkspaceId,
              conversationOnly: true,
              limit: 20,
            }),
          (page) =>
            fixture.providerCalls.length > callsBefore &&
            page.entries.filter(
              (entry) =>
                entry.kind === "AssistantConversationTurn" &&
                entry.body === "ISOLATED_FIXTURE_REPLY",
            ).length === (message === "before restart" ? 1 : 2),
        );
        expect(transcript.entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ body: "ISOLATED_FIXTURE_REPLY" }),
          ]),
        );
      }
      expect(fixture.daemonErrors).toEqual([]);
    } finally {
      await fixture.stop();
    }
  });
});

describe("public fixture client transport recovery", () => {
  it("retries a reset connection once with the identical command envelope", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(
        new TypeError("fetch failed", {
          cause: Object.assign(new Error("connection reset"), {
            code: "ECONNRESET",
          }),
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          body: { resolution: "Committed" },
        }),
      );
    try {
      await makePublicClient("http://127.0.0.1:1").command(
        "prj_transport",
        "SubmitHumanMessage",
        { bodyRef: "transport recovery" },
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1]).toEqual(fetchMock.mock.calls[0]);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("does not retry an expired request deadline", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    try {
      await expect(
        makePublicClient("http://127.0.0.1:1", {
          deadlineAt: Date.now() - 1,
        }).view("inbox-view", {}),
      ).rejects.toThrow("overall request deadline exceeded");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("stops after the second reset instead of hiding a persistent failure", async () => {
    const reset = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connection reset"), {
        code: "ECONNRESET",
      }),
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(reset);
    try {
      await expect(
        makePublicClient("http://127.0.0.1:1").view("inbox-view", {}),
      ).rejects.toBe(reset);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      fetchMock.mockRestore();
    }
  });
});
