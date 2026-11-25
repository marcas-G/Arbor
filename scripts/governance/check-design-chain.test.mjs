import assert from "node:assert/strict";
import test from "node:test";
import { checkDesignChain, designPaths } from "./check-design-chain.mjs";

const fixture = [
  "**Version:** 1.4\n**Status:** FROZEN",
  "**Version:** 1.12\n**Status:** FROZEN\n**Depends on:** `Arbor Problem Definition & Goals v1.4`",
  "**Version:** 1.27\n**Status:** FROZEN\n**Depends on:** `Arbor Problem Definition & Goals v1.4` + `Arbor Scenarios S1–S4 v1.12`",
  "**Version:** 1.68\\\n**Status:** TOP-LEVEL FROZEN\\\n**Depends on:** `Arbor System Design Specification v1.27`",
];

test("valid design metadata and dependency chain", () => {
  const result = checkDesignChain((path) => fixture[designPaths.indexOf(path)]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.versions, ["1.4", "1.12", "1.27", "1.68"]);
});

test("reject stale dependency header", () => {
  const result = checkDesignChain((path) =>
    path === designPaths[3]
      ? fixture[3].replace("v1.27", "v1.26")
      : fixture[designPaths.indexOf(path)],
  );
  assert.ok(
    result.errors.some((message) => message.includes("expected dependency")),
  );
});

test("report missing source rather than silently passing", () => {
  const result = checkDesignChain((path) => {
    if (path === designPaths[0]) throw new Error("missing file");
    return fixture[designPaths.indexOf(path)];
  });
  assert.ok(result.errors.some((message) => message.includes("cannot read")));
});

test("reject missing version", () => {
  const result = checkDesignChain((path) =>
    path === designPaths[0]
      ? "**Status:** FROZEN"
      : fixture[designPaths.indexOf(path)],
  );
  assert.ok(
    result.errors.some((message) => message.includes("invalid version")),
  );
});
