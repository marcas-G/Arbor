import assert from "node:assert/strict";
import test from "node:test";
import {
  classify,
  collectExactRefs,
  moduleOf,
  specifiers,
  summarize,
} from "./inventory-lib.mjs";

test("classification distinguishes authority, evidence and unreviewed planning", () => {
  assert.equal(classify("docs/design/x.md"), "normative-design");
  assert.equal(classify("planning/results/x.md"), "verification-evidence");
  assert.equal(classify("planning/tasks/x.md"), "planning-review-required");
  assert.equal(classify("packages/domain/test/x.ts"), "test");
});
test("module and inventory counts", () => {
  assert.equal(moduleOf("packages/domain/src/a.ts"), "packages/domain");
  const result = summarize([
    { path: "packages/domain/src/a.ts" },
    { path: "tests/a.ts" },
  ]);
  assert.equal(result.total, 2);
  assert.equal(result.byKind["production-source"], 1);
  assert.equal(result.byKind.test, 1);
});
test("only distinct exact repo-root inline-code references", () => {
  assert.deepEqual(collectExactRefs("`docs/a.md` `docs/a.md` `docs/**`"), [
    "docs/a.md",
  ]);
});
test("extract static, export, dynamic and type imports from AST", () => {
  const body = [
    {
      type: "ImportDeclaration",
      source: { type: "StringLiteral", value: "@arbor/domain" },
    },
    {
      type: "ExportAllDeclaration",
      source: { type: "StringLiteral", value: "@arbor/ports" },
    },
    {
      type: "ImportExpression",
      source: { type: "StringLiteral", value: "./x.js" },
    },
    {
      type: "TSImportType",
      argument: {
        type: "TSLiteralType",
        literal: { type: "StringLiteral", value: "./t.js" },
      },
    },
    {
      type: "ImportExpression",
      source: { type: "Identifier", name: "dynamic" },
    },
  ];
  assert.deepEqual(
    specifiers({ type: "File", program: { body } })
      .map((x) => x.specifier)
      .sort(),
    ["./t.js", "./x.js", "@arbor/domain", "@arbor/ports"].sort(),
  );
});
