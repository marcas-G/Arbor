#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const contractPath = fileURLToPath(
  new URL("../../planning/release/rc-contract.json", import.meta.url),
);

const allowedStatuses = new Set(["OPEN", "PASS", "BLOCKED"]);
const allowedEvidenceClasses = new Set([
  "deterministic",
  "process",
  "real-provider",
  "native",
  "browser",
  "package",
]);

export function validateContract(contract) {
  if (contract.contractVersion !== 1 || !Array.isArray(contract.items)) {
    throw new Error("RC contract version/items invalid");
  }
  if (!contract.auditedCandidateSha || typeof contract.auditedCandidateSha !== "string") {
    throw new Error("RC contract must name the audited candidate SHA");
  }

  const ids = new Set();
  for (const item of contract.items) {
    for (const field of ["id", "name", "owner", "status", "evidenceClass", "exactSha", "evidence", "closureCondition"]) {
      if (!(field in item)) throw new Error(`RC item missing ${field}`);
    }
    if (ids.has(item.id)) throw new Error(`Duplicate RC item id: ${item.id}`);
    ids.add(item.id);
    if (!allowedStatuses.has(item.status)) throw new Error(`Invalid status for ${item.id}`);
    if (!Array.isArray(item.evidenceClass) || item.evidenceClass.length === 0) {
      throw new Error(`RC item must declare evidenceClass: ${item.id}`);
    }
    if (item.evidenceClass.some((kind) => !allowedEvidenceClasses.has(kind))) {
      throw new Error(`Unknown evidenceClass for ${item.id}`);
    }
    if (item.exactSha !== null && !/^[0-9a-f]{40}$/i.test(item.exactSha)) {
      throw new Error(`exactSha must be a full commit SHA or null: ${item.id}`);
    }
    if (!Array.isArray(item.evidence) || item.evidence.length === 0) {
      throw new Error(`RC item must include evidence path(s): ${item.id}`);
    }
    if (item.status === "PASS" && item.exactSha === null) {
      throw new Error(`PASS requires exactSha: ${item.id}`);
    }
  }
  return contract;
}

const labels = {
  deterministic: "确定性",
  process: "真实进程",
  "real-provider": "真实 Provider",
  native: "Native 隔离",
  browser: "浏览器",
  package: "发布包",
};

function mdEscape(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function renderMarkdown(contract) {
  const counts = Object.fromEntries(["PASS", "OPEN", "BLOCKED"].map((status) => [
    status,
    contract.items.filter((item) => item.status === status).length,
  ]));
  const lines = [
    `# ${contract.title}`,
    "",
    `审计候选：\`${contract.auditedCandidateSha}\`。状态由审阅记录维护；报告器不根据证据文件是否存在推断状态。`,
    `证据层级：${Object.entries(labels).map(([key, label]) => `${label}（${key}）`).join("、")}。`,
    `汇总：PASS ${counts.PASS} · OPEN ${counts.OPEN} · BLOCKED ${counts.BLOCKED}`,
    "",
    "| 门槛 | Owner | 状态 | 证据层级 | Exact SHA | 证据路径 | 关闭条件 |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const item of contract.items) {
    lines.push(`| ${mdEscape(item.name)} | ${mdEscape(item.owner)} | **${item.status}** | ${item.evidenceClass.map((kind) => labels[kind]).join("、")} | ${item.exactSha ? `\`${item.exactSha}\`` : "—"} | ${item.evidence.map((entry) => `\`${mdEscape(entry)}\``).join("<br>")} | ${mdEscape(item.closureCondition)} |`);
  }
  lines.push("", `状态说明：OPEN 表示资格未闭合；BLOCKED 表示存在待治理/平台前置项；PASS 仅代表该行所列范围和 SHA。`, "");
  return lines.join("\n");
}

export async function loadContract(pathname = contractPath) {
  const source = await readFile(pathname, "utf8");
  return validateContract(JSON.parse(source));
}

export async function main(args = process.argv.slice(2)) {
  const formatArg = args.find((arg) => arg.startsWith("--format="));
  const format = formatArg?.slice("--format=".length) ?? "md";
  if (args.some((arg) => arg !== formatArg) || !["md", "json"].includes(format)) {
    throw new Error("用法：node scripts/release/report-rc.mjs [--format=md|json]");
  }
  const contract = await loadContract();
  process.stdout.write(format === "json" ? `${JSON.stringify(contract, null, 2)}\n` : `${renderMarkdown(contract)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
