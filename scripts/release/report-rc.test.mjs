import test from "node:test";
import assert from "node:assert/strict";
import { loadContract, renderMarkdown, validateContract } from "./report-rc.mjs";

test("RC contract contains only conservative, explicit evidence statuses", async () => {
  const contract = await loadContract();
  assert.ok(contract.items.length >= 10);
  assert.ok(contract.items.some((item) => item.id === "scenario-s1"));
  assert.ok(contract.items.some((item) => item.id === "rai-terminal-provider-hold"));
  assert.ok(contract.items.some((item) => item.id === "native-os-sandbox"));
  assert.ok(contract.items.some((item) => item.id === "full-local-gates" && item.status === "PASS"));
  assert.ok(contract.items.filter((item) => item.status === "PASS").every((item) => item.exactSha));
  assert.ok(contract.items.filter((item) => item.status !== "PASS").some((item) => item.exactSha === null));
});

test("report describes evidence classes and preserves the contract status", async () => {
  const contract = await loadContract();
  const markdown = renderMarkdown(contract);
  assert.match(markdown, /真实 Provider/);
  assert.match(markdown, /BLOCKED/);
  assert.match(markdown, /不根据证据文件是否存在推断状态/);
  assert.equal(contract.items.find((item) => item.id === "scenario-s1").status, "OPEN");
  assert.match(renderMarkdown(contract), /S1：真实工作闭环与重启读取 \| Runtime \/ Release Qualification \| \*\*OPEN\*\*/);
});

test("contract validation rejects unbound PASS and unknown evidence classes", async () => {
  const contract = await loadContract();
  const unboundPass = structuredClone(contract);
  unboundPass.items[0].status = "PASS";
  unboundPass.items[0].exactSha = null;
  assert.throws(() => validateContract(unboundPass), /PASS requires exactSha/);

  const badClass = structuredClone(contract);
  badClass.items[0].evidenceClass = ["probably-passed"];
  assert.throws(() => validateContract(badClass), /Unknown evidenceClass/);
});
