import type { ToolInvocation } from "@arbor/model-context";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { decodeControlInvocation } from "../src/control-decoder.js";
import { fixtureProviderTurnId } from "./fixtures/provider-turn.js";

const invocation = (condition: unknown): ToolInvocation => ({
  providerTurnId: fixtureProviderTurnId(),
  outputPosition: 0,
  callRef: "wait-call",
  toolName: "wait",
  argumentsJson: JSON.stringify({
    disposition: "Yielded",
    reason: "await exact state change",
    waitSpec: { mode: "Any", conditions: [condition] },
  }),
});

describe("wait control revision decoding", () => {
  it.each([
    {
      _tag: "DependencyChanged",
      dependencyId: "dep_11111111-1111-7111-8111-111111111111",
      observedRevision: 0,
    },
    {
      _tag: "DecisionChanged",
      decisionId: "dec_11111111-1111-7111-8111-111111111111",
      observedRevision: 2,
    },
    {
      _tag: "VerificationChanged",
      workId: "wrk_11111111-1111-7111-8111-111111111111",
      targetWorkRevision: 0,
    },
  ])("accepts numeric revisions in $._tag", async (condition) => {
    const decoded = await Effect.runPromise(
      decodeControlInvocation(invocation(condition)),
    );
    expect(decoded.action).toMatchObject({
      _tag: "Wait",
      waitSpec: { conditions: [condition] },
    });
  });

  it("rejects a string where the contract requires a numeric revision", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        decodeControlInvocation(
          invocation({
            _tag: "DependencyChanged",
            dependencyId: "dep_11111111-1111-7111-8111-111111111111",
            observedRevision: "0",
          }),
        ),
      ),
    );
    expect(failure).toMatchObject({ _tag: "InvalidControlArguments" });
  });

  it("decodes an explicit Blocked disposition without model-authored wake conditions", async () => {
    const decoded = await Effect.runPromise(
      decodeControlInvocation({
        ...invocation(null),
        argumentsJson: JSON.stringify({
          disposition: "Blocked",
          request: "Please approve access to the required resource.",
        }),
      }),
    );
    expect(decoded.action).toEqual({
      _tag: "Wait",
      disposition: "Blocked",
      request: "Please approve access to the required resource.",
    });
  });

  it("rejects Blocked with empty, overlong, or model-authored waitSpec", async () => {
    for (const args of [
      { disposition: "Blocked", request: " " },
      { disposition: "Blocked", request: "x".repeat(2001) },
      {
        disposition: "Blocked",
        request: "need help",
        waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
      },
    ]) {
      const failure = await Effect.runPromise(
        Effect.flip(
          decodeControlInvocation({
            ...invocation(null),
            argumentsJson: JSON.stringify(args),
          }),
        ),
      );
      expect(failure).toMatchObject({ _tag: "InvalidControlArguments" });
    }
  });

  it("decodes only bounded exact refs for resolve_work_blocker", async () => {
    const decoded = await Effect.runPromise(
      decodeControlInvocation({
        providerTurnId: fixtureProviderTurnId(),
        outputPosition: 0,
        callRef: "resolve-call",
        toolName: "resolve_work_blocker",
        argumentsJson: JSON.stringify({
          resolutions: [
            {
              blockerId: "a".repeat(64),
              successfulActionRefs: ["lac_exact_success"],
            },
          ],
        }),
      }),
    );
    expect(decoded.action).toMatchObject({
      _tag: "ResolveWorkBlocker",
      resolutions: [
        {
          blockerId: "a".repeat(64),
          successfulActionRefs: ["lac_exact_success"],
        },
      ],
    });

    const invalid = await Effect.runPromise(
      Effect.flip(
        decodeControlInvocation({
          providerTurnId: fixtureProviderTurnId(),
          outputPosition: 0,
          callRef: "resolve-call-invalid",
          toolName: "resolve_work_blocker",
          argumentsJson: JSON.stringify({
            resolutions: [{ blockerId: "bad", successfulActionRefs: [] }],
          }),
        }),
      ),
    );
    expect(invalid).toMatchObject({ _tag: "InvalidControlArguments" });
  });
});
