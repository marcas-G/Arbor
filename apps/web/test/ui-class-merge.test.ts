import { describe, expect, it } from "vitest";
import { cn } from "../src/lib/utils.js";

describe("Arbor design tokens in utility composition", () => {
  it("preserves typography when a control also sets its text color", () => {
    expect(cn("text-small text-foreground")).toBe("text-small text-foreground");
    expect(cn("text-caption", "text-destructive")).toBe(
      "text-caption text-destructive",
    );
    expect(cn("text-title text-foreground", "text-small")).toBe(
      "text-foreground text-small",
    );
  });

  it("resolves overrides using the custom spacing and shadow scales", () => {
    expect(cn("gap-ui-3 shadow-card", "gap-ui-2 shadow-float")).toBe(
      "gap-ui-2 shadow-float",
    );
  });
});
