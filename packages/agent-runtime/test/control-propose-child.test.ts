import type { ToolInvocation } from "@arbor/model-context";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeControlToolRegistry } from "../src/control.js";

const invocation = (argumentsJson: string): ToolInvocation => ({
  providerTurnId: "ptn_test" as never,
  outputPosition: 0,
  callRef: "call_test",
  toolName: "arbor_propose_child_workspace",
  argumentsJson,
});

const stubHandler = {
  action: "ProposeChildWorkspace" as const,
  handle: () =>
    Effect.succeed({
      _tag: "Observation" as const,
      source: "Runtime" as const,
      observation: { text: "stub", truncated: false },
    }),
};

const fullProposal = {
  name: "data-pipeline",
  rationale: "independent long-lived responsibility",
  responsibilityDraft: {
    purpose: "own the nightly pipeline",
    ownedResponsibilities: ["pipeline"],
    obligations: [],
    includes: [],
    excludes: [],
    interfaces: [],
  },
  resourceBoundaryDraft: {
    addresses: [{ _tag: "FileTree", path: "services/pipeline" }],
  },
  initialWork: {
    objective: "stabilize the nightly run",
    why: "flaky builds",
    constraints: [],
    completionExpectation: "5 green nights",
    verificationMission: {
      goal: "verify five consecutive successful nightly runs",
      criteria: [
        {
          criterionId: "green-runs",
          requirement: "five consecutive nightly runs are green",
          required: true,
        },
      ],
      riskRequirements: ["inspect the real scheduled-run output"],
    },
  },
};

describe("arbor_propose_child_workspace codec", () => {
  it("decodes a full proposal", async () => {
    const registry = makeControlToolRegistry([stubHandler]);
    const decoded = await Effect.runPromise(
      registry.decode(invocation(JSON.stringify(fullProposal))),
    );
    expect(decoded.action._tag).toBe("ProposeChildWorkspace");
    if (decoded.action._tag !== "ProposeChildWorkspace") return;
    expect(decoded.action.proposal.name).toBe("data-pipeline");
    expect(decoded.action.proposal.initialWork?.objective).toBe(
      "stabilize the nightly run",
    );
    expect(decoded.action.proposal.initialWork?.verificationMission.goal).toBe(
      "verify five consecutive successful nightly runs",
    );
  });

  it("decodes a minimal proposal without initialWork", async () => {
    const registry = makeControlToolRegistry([stubHandler]);
    const { initialWork: _omitted, ...minimal } = fullProposal;
    const decoded = await Effect.runPromise(
      registry.decode(invocation(JSON.stringify(minimal))),
    );
    expect(decoded.action._tag).toBe("ProposeChildWorkspace");
  });

  it("rejects a missing rationale", async () => {
    const registry = makeControlToolRegistry([stubHandler]);
    const { rationale: _missing, ...rest } = fullProposal;
    const exit = await Effect.runPromise(
      Effect.exit(registry.decode(invocation(JSON.stringify(rest)))),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("rejects unknown top-level keys", async () => {
    const registry = makeControlToolRegistry([stubHandler]);
    const exit = await Effect.runPromise(
      Effect.exit(
        registry.decode(
          invocation(JSON.stringify({ ...fullProposal, extra: 1 })),
        ),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("rejects an invalid resource address tag", async () => {
    const registry = makeControlToolRegistry([stubHandler]);
    const exit = await Effect.runPromise(
      Effect.exit(
        registry.decode(
          invocation(
            JSON.stringify({
              ...fullProposal,
              resourceBoundaryDraft: {
                addresses: [{ _tag: "Database", path: "x" }],
              },
            }),
          ),
        ),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("rejects an initialWork without objective", async () => {
    const registry = makeControlToolRegistry([stubHandler]);
    const exit = await Effect.runPromise(
      Effect.exit(
        registry.decode(
          invocation(
            JSON.stringify({
              ...fullProposal,
              initialWork: {
                why: "x",
                constraints: [],
                completionExpectation: "y",
              },
            }),
          ),
        ),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("rejects initialWork without an explicit verificationMission", async () => {
    const registry = makeControlToolRegistry([stubHandler]);
    const { verificationMission: _missing, ...incompleteWork } =
      fullProposal.initialWork;
    const exit = await Effect.runPromise(
      Effect.exit(
        registry.decode(
          invocation(
            JSON.stringify({ ...fullProposal, initialWork: incompleteWork }),
          ),
        ),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("is not exposed without a registered handler", async () => {
    const registry = makeControlToolRegistry();
    expect(registry.classify("arbor_propose_child_workspace")).toBe(
      "NotControl",
    );
  });
});
