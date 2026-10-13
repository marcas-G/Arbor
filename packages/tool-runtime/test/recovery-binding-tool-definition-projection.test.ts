import { toolDefinitionIdentityDigestV1 } from "@arbor/ports";
import { describe, expect, it } from "vitest";
import { SHELL_DEFINITION } from "../src/catalog.js";
import { recoveryBindingToolDefinitionHashV1 } from "../src/runtime.js";

describe("P39 ToolDefinition hash projection", () => {
  it("stores a SHA-256 of the stable definition token in RecoveryBindingV1", () => {
    const hash = recoveryBindingToolDefinitionHashV1(SHELL_DEFINITION);

    expect(hash).toBe(toolDefinitionIdentityDigestV1(SHELL_DEFINITION.hash));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(SHELL_DEFINITION.hash);
  });
});
