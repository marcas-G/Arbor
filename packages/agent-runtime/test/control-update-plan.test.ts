import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { decodeControlInvocation } from "../src/control-decoder.js";

describe("DID v1.28 update_plan control decoding", () => {
  it("decodes a non-empty typed plan and rejects unknown fields", async () => {
    const decoded = await Effect.runPromise(
      decodeControlInvocation({
        providerTurnId: "ptn_018f2b3c-4d5e-7abc-8def-0123456789ab" as never,
        outputPosition: 0,
        callRef: "call-plan",
        toolName: "update_plan",
        argumentsJson: JSON.stringify({
          items: [
            { itemId: "inspect", text: "检查现状", status: "Completed" },
            { itemId: "fix", text: "修复边界", status: "InProgress" },
          ],
        }),
      }),
    );
    expect(decoded.action._tag).toBe("UpdatePlan");
    if (decoded.action._tag === "UpdatePlan") {
      expect(decoded.action.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ itemId: "inspect", status: "Completed" }),
        ]),
      );
    }

    const rejected = await Effect.runPromise(
      Effect.exit(
        decodeControlInvocation({
          providerTurnId: "ptn_018f2b3c-4d5e-7abc-8def-0123456789ab" as never,
          outputPosition: 0,
          callRef: "call-bad-plan",
          toolName: "update_plan",
          argumentsJson: JSON.stringify({ items: [], completesWork: true }),
        }),
      ),
    );
    expect(rejected._tag).toBe("Failure");
  });

  it("decodes exact candidate selection as a tool action", async () => {
    const decoded = await Effect.runPromise(
      decodeControlInvocation({
        providerTurnId: "ptn_018f2b3c-4d5e-7abc-8def-0123456789ab" as never,
        outputPosition: 0,
        callRef: "call-select",
        toolName: "select_current_work",
        argumentsJson: JSON.stringify({
          workId: "wrk_018f2b3c-4d5e-7abc-8def-0123456789ab",
        }),
      }),
    );
    expect(decoded.action).toMatchObject({
      _tag: "SelectCurrentWork",
      workId: "wrk_018f2b3c-4d5e-7abc-8def-0123456789ab",
    });
  });
});
