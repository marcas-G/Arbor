import { makeWorkspacePolicy } from "@arbor/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  AuthorityResolverPort,
  AuthorityResolverPortLive,
} from "../src/authority-resolver.js";

const input = (requestedCapabilities: ReadonlyArray<string>) => ({
  principal: "worker:test" as never,
  workspaceId: "ws_test" as never,
  executionId: "exe_test" as never,
  intent: {
    toolName: requestedCapabilities.includes("shell:exec") ? "shell" : "read",
    toolVersion: "1",
    argumentsJson: "{}",
    actionDigest: "digest",
    requestedCapabilities,
    resolvedRegions: ["filesystem"],
  },
  controlBasisDigest: "basis",
  grants: [],
  governance: { authenticatedHumans: [], directParentOf: [] },
  policy: makeWorkspacePolicy({
    delegationCeiling: 1,
    authorityTtlSeconds: 60,
  }),
  delegationDepth: 0,
  now: "2026-10-01T00:00:00.000Z",
});

describe("tool authority baseline", () => {
  it("allows boundary-limited read without a grant and denies shell without a grant", async () => {
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const resolver = yield* AuthorityResolverPort;
          const read = yield* resolver.resolveInvocation(input(["fs:read"]));
          const shell = yield* Effect.flip(
            resolver.resolveInvocation(input(["shell:exec"])),
          );
          return { read, shell };
        }),
        AuthorityResolverPortLive,
      ),
    );
    expect(result.read.allowedCapabilities).toEqual(["fs:read"]);
    expect(result.read.expiresAt).toBe("2026-10-01T00:01:00.000Z");
    expect(result.shell._tag).toBe("NoApplicableGrant");
  });
});
