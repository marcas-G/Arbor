import type { ToolInvocation } from "@arbor/model-context";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { decodeControlInvocation } from "../src/control-decoder.js";

const invocation = (
  toolName: string,
  argumentsJson: string,
): ToolInvocation => ({
  providerTurnId: "ptn_deliverable" as never,
  outputPosition: 0,
  callRef: `${toolName}-call`,
  toolName,
  argumentsJson,
});

describe("MAC-P3 deliverable controls", () => {
  it("decodes formal production and delivery without exposing satisfy", async () => {
    const produced = await Effect.runPromise(
      decodeControlInvocation(
        invocation(
          "produce_deliverable",
          JSON.stringify({
            kind: "research-report",
            artifacts: [
              {
                role: "report",
                artifactId: "art_018f2b3c-4d5e-7abc-8def-012345678a31",
              },
            ],
          }),
        ),
      ),
    );
    expect(produced.action).toMatchObject({
      _tag: "ProduceDeliverable",
      kind: "research-report",
      artifacts: [{ role: "report" }],
    });
    const delivered = await Effect.runPromise(
      decodeControlInvocation(
        invocation(
          "deliver",
          JSON.stringify({
            deliverableId: "del_018f2b3c-4d5e-7abc-8def-012345678a31",
            summary: "bounded result",
          }),
        ),
      ),
    );
    expect(delivered.action).toMatchObject({
      _tag: "Deliver",
      summary: "bounded result",
    });
    const unknown = await Effect.runPromise(
      Effect.flip(
        decodeControlInvocation(
          invocation(
            "satisfy_dependency",
            JSON.stringify({ dependencyId: "dep_x", deliverableId: "del_x" }),
          ),
        ),
      ),
    );
    expect(unknown).toMatchObject({ _tag: "UnknownControlTool" });
  });
});
