import { afterEach, describe, expect, it } from "vitest";
import {
  type NativeOwnerReportRequest,
  responseJobForLatestMessage,
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

const isNativeRef = (
  request: NativeOwnerReportRequest,
  opaqueRef: string,
  bindingFingerprint: string,
): boolean =>
  request.operationKind === "Inference" &&
  request.bindingVariant === "A" &&
  request.items.some(
    (item) =>
      item._tag === "CompactionCheckpoint" &&
      item.implementation === "ProviderNative" &&
      item.opaqueItemRef === opaqueRef &&
      item.bindingFingerprint === bindingFingerprint,
  );

describe("AH19 Conversation ProviderNative owner binding", () => {
  it("reuses an opaque continuation only when the owner binding exactly matches", async () => {
    const scenario = await startNativeConversationOwnerScenario();
    scenarios.push(scenario);
    const before = scenario.report.requests.length;
    const message = `AH19_NATIVE_MATCH_${Date.now()}`;
    await submitHumanMessage(scenario.client, scenario.project, message);
    const matched = await waitForPublic(
      async () => scenario.report.requests.slice(before),
      (requests) =>
        requests.some((request) =>
          isNativeRef(
            request,
            scenario.nativeOpaqueRef,
            scenario.nativeOwner.binding_fingerprint ?? "",
          ),
        ),
      60_000,
    );
    const request = matched.find((candidate) =>
      isNativeRef(
        candidate,
        scenario.nativeOpaqueRef,
        scenario.nativeOwner.binding_fingerprint ?? "",
      ),
    );
    expect(request).toBeDefined();
    await waitForPublic(
      async () =>
        responseJobForLatestMessage(
          scenario.fixture,
          scenario.project.rootWorkspaceId,
        ),
      (job) => job?.state === "Answered",
      60_000,
    );
    expect(scenario.fixture.daemonErrors).toEqual([]);
  }, 180_000);
});
