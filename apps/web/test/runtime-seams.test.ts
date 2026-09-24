/**
 * D2 product UI seam guards. These are intentionally structural: D0–D3 must
 * keep the proven Web transport/state boundaries rather than making a second
 * presentation-owned cache or authentication channel.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = (...path: ReadonlyArray<string>): string =>
  readFileSync(join(process.cwd(), "src", ...path), { encoding: "utf8" });

describe("D2 frozen Web runtime seams", () => {
  it("keeps server facts on the fetchView → TanStack Query path", () => {
    const query = src("api", "useViewQuery.ts");
    const transport = src("api", "transport.ts");
    expect(query).toContain("return useQuery({");
    expect(query).toContain('queryKey: ["view", view, request]');
    expect(query).toContain("fetchView(view, request");
    expect(query).not.toMatch(/\buseState\b|\bsetQuer(?:y|ies)Data\b/);
    expect(transport).toContain(["fetch(`/views/$", "{view}`"].join(""));
    expect(transport).toContain("await response.json()");
    expect(transport).not.toMatch(/\bWebSocket\b|\bReadableStream\b/);
  });

  it("keeps WS frames invalidation-only and never writes a view DTO to cache", () => {
    const provider = src("providers", "AppProviders.tsx");
    const invalidation = src("data", "invalidation.ts");
    expect(provider).toContain("client.invalidateQueries({");
    expect(provider).toContain('queryKey: ["view", view]');
    expect(provider).not.toMatch(/\bsetQuer(?:y|ies)Data\b/);
    expect(invalidation).toContain('kind: "invalidate"');
    expect(invalidation).toContain("JSON.parse(String(event.data))");
    expect(invalidation).not.toMatch(
      /\b(?:TranscriptRes|TranscriptEntry|setQuer(?:y|ies)Data)\b/,
    );
  });

  it("keeps session credentials memory-only and command retry identity form-owned", () => {
    const session = src("session", "SessionContext.tsx");
    const submission = src("commands", "useCommandSubmission.ts");
    expect(session).toMatch(/\buseState<string \| null>\(null\)/);
    expect(session).not.toMatch(
      /\b(?:localStorage|sessionStorage|document\.cookie)\b/,
    );
    expect(submission).toContain("pendingCommandIdRef");
    expect(submission).toContain(
      "pendingCommandIdRef.current ?? newCommandId()",
    );
    expect(submission).toContain("pendingCommandIdRef.current = null");
  });
});
