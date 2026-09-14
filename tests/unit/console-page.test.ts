import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PAGE } from "../../src/entrypoints/server.js";

/**
 * Console-page static verification — the guard for exactly the class of bugs
 * that shipped before (broken template escaping, undefined click handlers,
 * dangling element ids). These tests parse the served page the way a browser
 * would have to: script syntax, handler existence, element existence.
 */

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "arbor-page-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
});

const script = (() => {
  const m = /<script>([\s\S]*)<\/script>/.exec(PAGE);
  return m?.[1] ?? "";
})();

describe("console page (D-045 guard)", () => {
  it("script is syntactically valid JavaScript", () => {
    const file = join(tmp(), "page.js");
    writeFileSync(file, script, "utf8");
    expect(() => execFileSync(process.execPath, ["--check", file])).not.toThrow();
  });

  it("every onclick/onkeydown handler referenced in HTML exists in the script", () => {
    const handlerNames = new Set<string>();
    for (const m of PAGE.matchAll(/on(?:click|keydown|change)="([a-zA-Z_]\w*)\(/g)) {
      handlerNames.add(m[1] as string);
    }
    expect(handlerNames.size).toBeGreaterThan(4); // the page is interactive at all
    for (const name of handlerNames) {
      const defined = new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(`).test(script);
      expect(defined, `handler "${name}" is referenced in HTML but not defined`).toBe(true);
    }
  });

  it("every $()-referenced element id exists in the markup", () => {
    const referenced = new Set<string>();
    for (const m of script.matchAll(/\$\('([\w-]+)'\)/g)) {
      referenced.add(m[1] as string);
    }
    expect(referenced.size).toBeGreaterThan(8);
    for (const id of referenced) {
      const present = new RegExp(`id="${id}"`).test(PAGE);
      expect(present, `script references #${id} but no such element exists`).toBe(true);
    }
  });

  it("no raw single-quote escaping leaks from the template literal (the \\ shipped bug)", () => {
    // a template literal containing \\' renders \' correctly; a bare \' inside a
    // JS string literal inside the template breaks the whole script in the browser
    expect(script).not.toMatch(/onclick="enterProject\(''\+/);
    // and the critical interaction handlers are all present
    for (const fn of ["openPicker", "createProject", "enterProject", "send", "pick", "decide", "loadAll"]) {
      expect(script).toMatch(new RegExp(`function ${fn}\\(|async function ${fn}\\(`));
    }
  });

  it("all fetch calls are relative (same-origin via the console proxy) — no cross-port leaks", () => {
    for (const m of script.matchAll(/fetch\(([^)]{0,80})\)/g)) {
      const arg = m[1] as string;
      expect(arg.startsWith("'http://"), `non-relative fetch: ${arg}`).toBe(false);
    }
  });
});
