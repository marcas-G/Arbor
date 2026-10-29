import { Principal, parse } from "@arbor/domain";
import { describe, expect, it } from "vitest";
import { resolveCompositionGovernance } from "../src/composition.js";
import { makeStaticAuthenticator } from "../src/transport/auth.js";

describe("local executable-approval governance bootstrap", () => {
  it("recognizes only the implicit loopback principal as a human by default", () => {
    expect(resolveCompositionGovernance({})).toEqual({
      authenticatedHumans: [parse(Principal)("user:local")],
      directParentOf: [],
    });
  });

  it("does not infer human authority from a configured authenticator", () => {
    const governance = resolveCompositionGovernance({
      authenticator: makeStaticAuthenticator({
        token: parse(Principal)("user:outsider"),
      }),
    });

    expect(governance).toEqual({
      authenticatedHumans: [],
      directParentOf: [],
    });
  });

  it("keeps explicit governance authoritative without adding the local principal", () => {
    const governance = {
      authenticatedHumans: [parse(Principal)("user:governor")],
      directParentOf: [],
    } as const;

    expect(resolveCompositionGovernance({ governance })).toBe(governance);
  });

  it("keeps an explicitly empty governance list fail-closed", () => {
    const governance = {
      authenticatedHumans: [],
      directParentOf: [],
    } as const;

    expect(resolveCompositionGovernance({ governance })).toBe(governance);
  });
});
