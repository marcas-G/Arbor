import { afterEach, describe, expect, it } from "vitest";
import {
  type NativeOwnerReportRequest,
  responseJobForLatestMessage,
  restartNativeConversationDaemon,
  startNativeConversationOwnerScenario,
} from "../support/ah19-conversation-native-owner-fixture.js";
import { submitHumanMessage, waitForPublic } from "../support/public-client.js";

const scenarios: Awaited<
  ReturnType<typeof startNativeConversationOwnerScenario>
>[] = [];

afterEach(async () => {
  for (const scenario of scenarios.splice(0)) {
    await scenario.fixture.stop();
    await scenario.report.close();
  }
}, 120_000);

describe("AH19 Conversation ProviderNative binding mismatch", () => {
  it("rebases to portable Summary on a changed binding and never sends the old opaque ref", async () => {
    const scenario = await startNativeConversationOwnerScenario();
    scenarios.push(scenario);
    await scenario.fixture.crash();
    await restartNativeConversationDaemon(
      scenario.fixture,
      scenario.report.url,
      "B",
    );

    const before = scenario.report.requests.length;
    await submitHumanMessage(
      scenario.client,
      scenario.project,
      `AH19_NATIVE_MISMATCH_${Date.now()}`,
    );
    const requests = await waitForPublic(
      async () => scenario.report.requests.slice(before),
      (values) =>
        values.some(
          (request) =>
            request.operationKind === "CompactionSummary" &&
            request.bindingVariant === "B",
        ),
      30_000,
    ).catch((error: unknown) => {
      throw new Error(
        `native owner mismatch did not reach provider: ${error instanceof Error ? error.message : String(error)}; requests=${JSON.stringify(scenario.report.requests)}; daemon=${JSON.stringify(scenario.fixture.daemonErrors)}; child=${JSON.stringify(scenario.childOutput.filter((line) => line.includes("AH19_CHILD_ERROR") || line.includes("AH19_CHILD_EXIT")))}; process=${JSON.stringify(scenario.fixture.daemonProcessSnapshot?.())}; job=${JSON.stringify(responseJobForLatestMessage(scenario.fixture, scenario.project.rootWorkspaceId))}`,
      );
    });
    const portableSummary = requests.find(
      (request) =>
        request.operationKind === "CompactionSummary" &&
        request.bindingVariant === "B",
    );
    expect(portableSummary).toBeDefined();
    expect(
      portableSummary?.items.some(
        (item) => item.opaqueItemRef === scenario.nativeOpaqueRef,
      ),
    ).toBe(false);
    expect(
      requests.every((request: NativeOwnerReportRequest) =>
        request.items.every(
          (item) => item.opaqueItemRef !== scenario.nativeOpaqueRef,
        ),
      ),
    ).toBe(true);

    await waitForPublic(
      async () =>
        responseJobForLatestMessage(
          scenario.fixture,
          scenario.project.rootWorkspaceId,
        ),
      (job) => job?.state === "Answered",
      90_000,
    );
    expect(scenario.fixture.daemonErrors).toEqual([]);
  }, 180_000);
});
