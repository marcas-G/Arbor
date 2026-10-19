import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadSandboxPolicyGrantIssuerConfigSnapshot } from "../src/sandbox-policy-issuer-config.js";

describe("P5 trusted sandbox policy issuer configuration", () => {
  it("loads one immutable exact snapshot and hashes its JCS bytes", () => {
    const raw = {
      version: 1,
      revision: 7,
      operators: ["user:operator-a", "user:operator-b"],
    };
    const snapshot = loadSandboxPolicyGrantIssuerConfigSnapshot({
      readVerified: (key) => {
        expect(key).toBe("sandboxPolicyGrantIssuerConfigV1");
        return raw;
      },
    });
    const canonical =
      '{"operators":["user:operator-a","user:operator-b"],"revision":7,"version":1}';
    expect(snapshot).toEqual({
      config: raw,
      configDigest: createHash("sha256")
        .update(canonical, "utf8")
        .digest("hex"),
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot?.config)).toBe(true);
    expect(Object.isFrozen(snapshot?.config.operators)).toBe(true);
  });

  it.each([
    undefined,
    { version: 1, revision: 0, operators: ["user:operator"] },
    { version: 1, revision: 1, operators: ["runtime:system"] },
  ])(
    "disables the authority snapshot for missing or invalid trusted config",
    (value) => {
      expect(
        loadSandboxPolicyGrantIssuerConfigSnapshot({
          readVerified: () => value,
        }),
      ).toBeUndefined();
    },
  );

  it("fails closed when the trusted source cannot verify its snapshot", () => {
    expect(
      loadSandboxPolicyGrantIssuerConfigSnapshot({
        readVerified: () => {
          throw new Error("do not disclose source details");
        },
      }),
    ).toBeUndefined();
  });
});
