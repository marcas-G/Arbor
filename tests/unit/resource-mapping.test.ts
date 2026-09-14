import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ResourceMappingSchema } from "../../src/domain/resource-mapping.js";

const dec = (v: unknown) => Schema.decodeUnknownSync(ResourceMappingSchema)(v);

describe("ResourceMapping", () => {
  it("accepts root prefix and normalized dir prefixes", () => {
    expect(dec({ writable: ["."] })).toEqual({ writable: ["."] });
    expect(dec({ writable: ["src", "src/runtime"] })).toEqual({ writable: ["src", "src/runtime"] });
  });

  it.each([
    ["/abs"],
    ["C:\\x"],
    ["a/../b"],
    ["src/*"],
    ["src/**"],
    ["a?b"],
    ["x[1]"],
    ["src\\runtime"],
    ["src//x"],
    ["./src"],
  ])("rejects %s", (p) => {
    expect(() => dec({ writable: [p] })).toThrow();
  });

  it("rejects empty mapping", () => {
    expect(() => dec({ writable: [] })).toThrow();
  });
});
