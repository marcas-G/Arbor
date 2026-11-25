import assert from "node:assert/strict";
import test from "node:test";
import { inspectFile, isSource, lineCount } from "./source-lines-lib.mjs";

test("physical lines count comments and blank lines without a phantom trailing line", () => {
  for (const [input, count] of [
    ["", 0],
    ["a\n", 1],
    ["a\r\nb\r\n", 2],
    ["a\n\n", 2],
    ["a\r", 1],
    ["a", 1],
    ["// comment\n\nconst x = 1;\n", 3],
  ])
    assert.equal(lineCount(input), count);
});

test("includes implementation, tests and scripts; excludes non-source assets", () => {
  for (const path of [
    "packages/a/src/x.ts",
    "tests/x.test.ts",
    "scripts/x.mjs",
    "a.py",
    "a.sql",
  ]) {
    assert.equal(isSource(path), true);
  }
  for (const path of [
    "pnpm-lock.yaml",
    "docs/x.md",
    "a/dist/x.js",
    "node_modules/x/index.js",
  ]) {
    assert.equal(isSource(path), false);
  }
});

test("strict 800-line cap and transition ratchet", () => {
  const source = (n) => "x\n".repeat(n);
  assert.equal(inspectFile("a.ts", source(800)), null);
  assert.equal(inspectFile("a.ts", source(801)).legacy, false);
  assert.equal(inspectFile("a.ts", source(900), 900).legacy, true);
  assert.equal(inspectFile("a.ts", source(901), 900).legacy, false);
  assert.equal(inspectFile("a.ts", source(801), 800).legacy, false);
});
