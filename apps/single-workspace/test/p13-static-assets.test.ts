import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveStatic } from "../src/transport/static-assets.js";

describe("P13 TR-W2 static asset face", () => {
  let dist: string;

  beforeAll(() => {
    dist = mkdtempSync(join(tmpdir(), "arbor-web-dist-"));
    mkdirSync(join(dist, "assets"));
    writeFileSync(
      join(dist, "index.html"),
      "<!doctype html><title>arbor</title>",
    );
    writeFileSync(join(dist, "assets", "app-abc123.js"), "console.log(1)");
  });

  afterAll(() => {
    rmSync(dist, { recursive: true, force: true });
  });

  it("serves index.html at / (SPA entry)", () => {
    const result = resolveStatic(dist, "/");
    expect(result.kind).toBe("file");
    if (result.kind === "file") {
      expect(result.contentType).toBe("text/html; charset=utf-8");
      expect(result.cacheControl).toBe("no-cache");
      expect(result.bytes.toString("utf8")).toContain("arbor");
    }
  });

  it("serves unknown client routes via SPA fallback (no server route semantics)", () => {
    const result = resolveStatic(dist, "/workspace-detail/ws_1");
    expect(result.kind).toBe("file");
    if (result.kind === "file") {
      expect(result.contentType).toBe("text/html; charset=utf-8");
    }
  });

  it("serves /assets/* with immutable cache headers", () => {
    const result = resolveStatic(dist, "/assets/app-abc123.js");
    expect(result.kind).toBe("file");
    if (result.kind === "file") {
      expect(result.contentType).toBe("text/javascript; charset=utf-8");
      expect(result.cacheControl).toContain("immutable");
      expect(result.cacheControl).toContain("max-age=31536000");
    }
  });

  it("rejects traversal attempts", () => {
    expect(resolveStatic(dist, "/../etc/passwd").kind).toBe("rejected");
    expect(resolveStatic(dist, "/assets/../../secret").kind).toBe("rejected");
  });

  it("reports not-configured when dist is absent", () => {
    expect(resolveStatic(undefined, "/").kind).toBe("not-configured");
  });
});
