import { expect, test } from "@playwright/test";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";
import {
  createFunctionalProject,
  makePublicClient,
} from "../support/public-client.js";

interface SocketObservation {
  readonly url: string;
  readonly firstViewProjectIds: string[];
  readonly sentFrames: string[];
  closed: boolean;
}

let fixture: ProductionFixture;
let firstProjectId: string;
let secondProjectId: string;
let secondRootWorkspaceId: string;
const observations: SocketObservation[] = [];

const hasProjectProof = (
  observation: SocketObservation,
  projectId: string,
): boolean => observation.firstViewProjectIds.includes(projectId);

const waitForProjectProof = async (
  page: import("@playwright/test").Page,
  projectId: string,
  afterIndex: number,
): Promise<SocketObservation> => {
  let match: SocketObservation | undefined;
  try {
    await expect
      .poll(
        () => {
          match = observations
            .slice(afterIndex)
            .find((observation) => hasProjectProof(observation, projectId));
          return match !== undefined;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; url=${page.url()}; sockets=${JSON.stringify(observations.slice(afterIndex))}`,
    );
  }
  if (match === undefined) {
    throw new Error(`no first WebSocket view proof for ${projectId}`);
  }
  await expect(page).toHaveURL(new RegExp(`/p/${projectId}(?:/|$)`, "u"));
  return match;
};

test.beforeAll(async () => {
  fixture = await startProductionFixture({ reply: () => "unused" });
  const client = makePublicClient(fixture.baseUrl);
  const first = await createFunctionalProject(
    client,
    fixture.workspaceDirectory,
    "Route session alpha",
  );
  const second = await createFunctionalProject(
    client,
    fixture.workspaceDirectory,
    "Route session beta",
  );
  firstProjectId = first.projectId;
  secondProjectId = second.projectId;
  secondRootWorkspaceId = second.rootWorkspaceId;
});

test.afterAll(async () => {
  await fixture?.stop();
});

test("a foreign workspace route is rejected before its workspace DTO is requested", async ({
  page,
}) => {
  const viewRequests: Array<{
    readonly view: string;
    readonly request: unknown;
  }> = [];
  await page.route(`${fixture.baseUrl}/views/**`, async (route) => {
    const url = new URL(route.request().url());
    viewRequests.push({
      view: url.pathname.split("/").at(-1) ?? "",
      request: route.request().postDataJSON(),
    });
    await route.continue();
  });

  await page.goto(
    `${fixture.baseUrl}/p/${firstProjectId}/workspace/${secondRootWorkspaceId}/overview`,
  );
  await expect(page.getByText("对象不存在")).toBeVisible({ timeout: 15_000 });
  expect(viewRequests.length).toBeGreaterThan(0);
  expect(
    viewRequests.every(
      ({ view, request }) =>
        view === "responsibility-tree" &&
        JSON.stringify(request) ===
          JSON.stringify({ projectId: firstProjectId }),
    ),
  ).toBe(true);
  expect(viewRequests.some(({ view }) => view === "workspace-detail")).toBe(
    false,
  );
  await expect(
    page.getByText("Route session beta", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText(secondRootWorkspaceId, { exact: true }),
  ).toHaveCount(0);
  expect(fixture.daemonErrors).toEqual([]);
});

test("direct load, refresh, project picker and history keep WS scoped to the URL project", async ({
  page,
}) => {
  observations.length = 0;
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname !== "/ws") return;
    const observation: SocketObservation = {
      url: socket.url(),
      firstViewProjectIds: [],
      sentFrames: [],
      closed: false,
    };
    observations.push(observation);
    socket.on("framesent", ({ payload }) => {
      const frameText =
        typeof payload === "string" ? payload : payload.toString("utf8");
      observation.sentFrames.push(frameText);
      try {
        const value = JSON.parse(frameText) as {
          readonly kind?: string;
          readonly request?: { readonly projectId?: string };
        };
        if (
          value.kind === "view" &&
          typeof value.request?.projectId === "string"
        ) {
          observation.firstViewProjectIds.push(value.request.projectId);
        }
      } catch {
        // Ignore non-JSON frames; only the frozen first-view proof is relevant.
      }
    });
    socket.on("close", () => {
      observation.closed = true;
    });
  });

  await page.goto(`${fixture.baseUrl}/p/${firstProjectId}`);
  const initialFirst = await waitForProjectProof(page, firstProjectId, 0);
  expect(initialFirst.firstViewProjectIds[0]).toBe(firstProjectId);

  const beforeReload = observations.length;
  await page.reload();
  const refreshedFirst = await waitForProjectProof(
    page,
    firstProjectId,
    beforeReload,
  );
  expect(refreshedFirst.firstViewProjectIds[0]).toBe(firstProjectId);

  await page.getByRole("button", { name: "打开项目中心" }).click();
  await page
    .getByLabel("项目列表")
    .getByRole("button", { name: "Route session beta" })
    .click();
  const switched = await waitForProjectProof(
    page,
    secondProjectId,
    beforeReload + 1,
  );
  await expect.poll(() => refreshedFirst.closed).toBe(true);
  expect(switched.firstViewProjectIds[0]).toBe(secondProjectId);

  const beforeBack = observations.length;
  await page.goBack();
  const returned = await waitForProjectProof(page, firstProjectId, beforeBack);
  await expect.poll(() => switched.closed).toBe(true);
  expect(returned.firstViewProjectIds[0]).toBe(firstProjectId);

  const beforeForward = observations.length;
  await page.goForward();
  const forwarded = await waitForProjectProof(
    page,
    secondProjectId,
    beforeForward,
  );
  await expect.poll(() => returned.closed).toBe(true);
  expect(forwarded.firstViewProjectIds[0]).toBe(secondProjectId);
  expect(fixture.daemonErrors).toEqual([]);
});
