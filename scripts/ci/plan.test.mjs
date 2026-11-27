import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { collectFunctionalShardFiles } from "../testing/functional-shard.mjs";
import {
  buildCiPlan,
  checkSummaryMarkdown,
  FUNCTIONAL_SHARD_TOTAL,
  POLICY,
  planSummaryMarkdown,
  policyDigest,
  shardSummaryMarkdown,
} from "./plan.mjs";

const manifest = JSON.parse(
  readFileSync(new URL("../../tests/manifest.json", import.meta.url), "utf8"),
);
const smokeAndSentinels = [
  ...new Set([...manifest.groups.smoke, ...manifest.groups.crashSentinels]),
].sort();
const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const inventory = collectFunctionalShardFiles().map((path) =>
  path.slice(root.length + 1),
);
const smokeAndSentinelsInWalk = smokeAndSentinels.filter((path) =>
  inventory.includes(path),
);

test("policy digest binds the policy version via sha256", () => {
  const digest = policyDigest();
  assert.match(digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(policyDigest(), digest);
  const mutated = structuredClone(POLICY);
  mutated.buckets[1].all.push("examples/**");
  assert.notEqual(policyDigest(mutated), digest);
});

test("pure documentation diff plans the static lane only", () => {
  const plan = buildCiPlan([
    "docs/engineering/ci-architecture.md",
    "README.md",
  ]);
  assert.equal(plan.status, "ok");
  assert.equal(plan.classification, "docs-only");
  assert.deepEqual(plan.riskTags, ["docs-only"]);
  assert.equal(plan.selection.core.scope, "none");
  assert.equal(plan.selection.functional.scope, "none");
  assert.equal(plan.selection.functionalUi.scope, "none");
  assert.deepEqual(plan.selection.functional.files, []);
  assert.equal(plan.requiredChecks.static.required, true);
  assert.equal(plan.requiredChecks.unit.required, false);
  assert.equal(plan.requiredChecks.web.required, false);
  assert.equal(plan.requiredChecks.functional.required, false);
  assert.deepEqual(plan.requiredChecks.functional.shards, []);
  assert.equal(plan.requiredChecks["functional-ui"].required, false);
  assert.equal(plan.requiredChecks.health.required, true);
  assert.deepEqual(plan.shadow.wouldSkipChecks.sort(), [
    "functional",
    "functional-ui",
    "unit",
    "web",
  ]);
  assert.deepEqual(plan.shadow.wouldSkipFunctionalFiles, [...inventory].sort());
  assert.equal(plan.mode, "shadow");
});

test("agent-runtime change plans core full plus the crash-sentinel family", () => {
  const plan = buildCiPlan(["packages/agent-runtime/src/agent-loop-driver.ts"]);
  assert.equal(plan.classification, "runtime");
  assert.ok(plan.riskTags.includes("shared-runtime"));
  assert.equal(plan.selection.core.scope, "full");
  assert.equal(plan.selection.functional.scope, "smoke+risk-selected");
  assert.deepEqual(plan.selection.functional.suites, [
    "smoke",
    "crashSentinels",
  ]);
  assert.deepEqual(plan.selection.functional.files, smokeAndSentinels);
  assert.equal(plan.selection.functionalUi.scope, "none");
  assert.equal(plan.requiredChecks.unit.required, true);
  assert.equal(plan.requiredChecks.functional.required, true);
  assert.equal(plan.requiredChecks["functional-ui"].required, false);
  assert.deepEqual(
    plan.shadow.wouldSkipFunctionalFiles,
    inventory.filter((path) => !smokeAndSentinels.includes(path)).sort(),
  );
});

test("execution-runtime change and documentation riders stay in the runtime bucket", () => {
  const executionOnly = buildCiPlan([
    "packages/execution-runtime/src/commands/registry.ts",
  ]);
  assert.equal(executionOnly.classification, "runtime");
  assert.equal(executionOnly.selection.functional.scope, "smoke+risk-selected");

  const withDocs = buildCiPlan([
    "docs/engineering/test-effectiveness.md",
    "./packages/execution-runtime/src/admission.ts",
  ]);
  assert.equal(withDocs.classification, "runtime");
  assert.deepEqual(withDocs.changedPaths, [
    "docs/engineering/test-effectiveness.md",
    "packages/execution-runtime/src/admission.ts",
  ]);
});

test("web change plans the web build and the browser lane, not core", () => {
  const plan = buildCiPlan(["apps/web/src/pages/work.tsx"]);
  assert.equal(plan.classification, "web");
  assert.equal(plan.selection.core.scope, "none");
  assert.equal(plan.selection.functional.scope, "none");
  assert.equal(plan.selection.functionalUi.scope, "full");
  assert.equal(plan.requiredChecks.web.required, true);
  assert.equal(plan.requiredChecks["functional-ui"].required, true);
  assert.equal(plan.requiredChecks.unit.required, false);
});

test("lockfile change plans the complete conservative full selection", () => {
  const plan = buildCiPlan(["docs/notes.md", "pnpm-lock.yaml"]);
  assert.equal(plan.classification, "lockfile");
  assert.equal(plan.selection.core.scope, "full");
  assert.equal(plan.selection.functional.scope, "full");
  assert.equal(plan.selection.functionalUi.scope, "full");
  assert.equal(plan.requiredChecks.web.required, true);
  assert.deepEqual(plan.shadow.wouldSkipFunctionalFiles, []);
  assert.deepEqual(plan.shadow.wouldSkipChecks, []);
  assert.equal(
    plan.selection.functional.files.length,
    Object.values(plan.selection.functional.shards).reduce(
      (sum, shard) => sum + shard.total,
      0,
    ),
  );
});

test("unclassifiable diffs fall back to conservative full selection", () => {
  for (const paths of [
    ["packages/domain/src/work.ts"],
    ["packages/agent-runtime/src/a.ts", "apps/single-workspace/src/b.ts"],
    ["vendor/generated/opaque-output.bin"],
    [],
  ]) {
    const plan = buildCiPlan(paths);
    assert.equal(plan.classification, "unclassified", JSON.stringify(paths));
    assert.equal(plan.selection.core.scope, "full");
    assert.equal(plan.selection.functional.scope, "full");
    assert.equal(plan.selection.functionalUi.scope, "full");
    assert.deepEqual(plan.shadow.wouldSkipFunctionalFiles, []);
  }

  const unknown = buildCiPlan(["vendor/generated/opaque-output.bin"]);
  assert.deepEqual(unknown.unknownPaths, [
    "vendor/generated/opaque-output.bin",
  ]);
});

test("impact-map risk tags escalate within the bucket, never below it", () => {
  const schema = buildCiPlan([
    "packages/execution-runtime/src/migrations/0052.ts",
  ]);
  assert.equal(schema.classification, "runtime");
  assert.ok(schema.riskTags.includes("schema"));
  assert.equal(schema.selection.functional.scope, "full");
  assert.equal(schema.selection.functionalUi.scope, "full");

  const permissions = buildCiPlan([
    "packages/agent-runtime/src/permission-policy.ts",
  ]);
  assert.ok(permissions.riskTags.includes("permissions"));
  assert.equal(permissions.selection.core.scope, "full");
  assert.equal(permissions.selection.functionalUi.scope, "full");

  const plain = buildCiPlan(["packages/agent-runtime/src/model-decision.ts"]);
  assert.equal(plain.selection.functionalUi.scope, "none");
});

test("shard accounting keeps selection and inventory consistent", () => {
  const plan = buildCiPlan(["packages/agent-runtime/src/agent-loop-driver.ts"]);
  const shards = plan.selection.functional.shards;
  assert.deepEqual(
    Object.keys(shards),
    Array.from({ length: FUNCTIONAL_SHARD_TOTAL }, (_, i) => String(i + 1)),
  );
  assert.equal(plan.selection.functional.shardTotal, FUNCTIONAL_SHARD_TOTAL);
  const selectedInWalk = Object.values(shards).reduce(
    (sum, shard) => sum + shard.selected,
    0,
  );
  const totalInWalk = Object.values(shards).reduce(
    (sum, shard) => sum + shard.total,
    0,
  );
  // The smoke group's s1-s4 capability file runs in the lane include set
  // but is not part of the shard walk, so it has no shard assignment.
  assert.equal(selectedInWalk, smokeAndSentinelsInWalk.length);
  assert.equal(
    totalInWalk,
    selectedInWalk + plan.shadow.wouldSkipFunctionalFiles.length,
  );
  assert.equal(
    plan.requiredChecks.functional.shards.length,
    FUNCTIONAL_SHARD_TOTAL,
  );
  assert.deepEqual(plan.selection.functional.notInShardWalk, [
    "tests/capability/black-box/s1-s4-public-api.test.ts",
  ]);
});

test("shadow summaries report without changing behavior", () => {
  const plan = buildCiPlan(
    ["packages/agent-runtime/src/agent-loop-driver.ts"],
    {
      sourceSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      baseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
  );
  const overall = planSummaryMarkdown(plan);
  assert.match(overall, /## Arbor CI plan \(shadow mode\)/);
  assert.match(overall, /smoke\+risk-selected/);
  assert.match(overall, /policy digest/i);

  const shard = shardSummaryMarkdown(plan, 3, FUNCTIONAL_SHARD_TOTAL);
  assert.match(
    shard,
    new RegExp(`functional shard 3/${FUNCTIONAL_SHARD_TOTAL}`),
  );
  assert.match(
    shard,
    /this job ran the \*\*full\*\* shard; no test was skipped/i,
  );
  assert.match(shard, /would run \*\*\d+\*\* of \*\*\d+\*\* files/);

  const ui = checkSummaryMarkdown(plan, "functional-ui");
  assert.match(ui, /functional-ui/);
  assert.match(ui, /required by selection if active: \*\*no\*\*/i);

  const docsPlan = buildCiPlan(["docs/engineering/README.md"]);
  const docsShard = shardSummaryMarkdown(docsPlan, 1, FUNCTIONAL_SHARD_TOTAL);
  assert.match(docsShard, /selection would not require any functional file/i);
});
