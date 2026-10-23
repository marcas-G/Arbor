import { describe, expect, it } from "vitest";
import { isChatCompletionsPath } from "../capability/real-provider/provider-capture-path.js";

describe("real-provider capture path matching", () => {
  it("matches a root-mounted Chat Completions endpoint", () => {
    expect(isChatCompletionsPath("/chat/completions")).toBe(true);
  });

  it("matches Chat Completions under the /v1 endpoint base path", () => {
    expect(isChatCompletionsPath("/v1/chat/completions")).toBe(true);
  });
});
