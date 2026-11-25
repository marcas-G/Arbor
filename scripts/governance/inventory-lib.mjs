export function classify(path) {
  if (/^(packages|adapters|apps)\/[^/]+\/src\//.test(path)) return "production-source";
  if (/^(packages|adapters|apps)\/[^/]+\/(?:test|tests)\//.test(path)||path.startsWith("tests/")) return "test";
  if (path.startsWith("docs/design/")) return "normative-design";
  if (path.startsWith("docs/decisions/")) return "decision-record";
  if (path.startsWith("docs/proposals/")||path.startsWith("planning/proposals/")||path.startsWith("planning/gaps/")) return "proposal-or-gap";
  if (path.startsWith("docs/verification/")||path.startsWith("planning/results/")) return "verification-evidence";
  if (path.startsWith("planning/")||path.startsWith(".planning/")||/^(findings|progress|task_plan)\.md$/.test(path)) return "planning-review-required";
  if (/^docs\/(?:CURRENT_STATE|KNOWN_PROBLEMS|OPEN_QUESTIONS|RELEASE_PROGRESS)\.md$/.test(path)) return "current-status";
  if (/^(AGENTS|GOVERNANCE|CONTRIBUTING)\.md$/.test(path)||path.startsWith("docs/engineering/")||path==="docs/ENGINEERING_HEALTH.md") return "engineering-governance";
  if (path.startsWith("docs/")||/^(README|FIRST-RELEASE)\.md$/.test(path)) return "documentation";
  if (path.startsWith("scripts/")||path.startsWith(".github/")) return "engineering-tool";
  return "other";
}

export function moduleOf(path) {
  const match = path.match(/^(packages|adapters|apps)\/[^/]+(?=\/|$)/);
  return match ? match[0] : null;
}

export function collectExactRefs(markdown) {
  return [...new Set([...markdown.matchAll(/`((?:docs|planning|packages|adapters|apps|tests|scripts)\/[A-Za-z0-9_.\/-]+\.(?:md|ts|tsx|mjs|json|yaml|yml))`/g)].map(m=>m[1]))].sort();
}

export function summarize(entries) {
  const byKind = {};
  const byRoot = {};
  const modules = {};
  for (const {path} of entries) {
    const kind = classify(path);
    const root = path.split("/")[0];
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    byRoot[root] = (byRoot[root] ?? 0) + 1;
    const module = moduleOf(path);
    if (module) modules[module] = (modules[module] ?? 0) + 1;
  }
  return {total: entries.length, byKind, byRoot, modules};
}

export function specifiers(ast) {
  const found = [];
  const stack = [ast];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    let source;
    if (["ImportDeclaration","ExportNamedDeclaration","ExportAllDeclaration"].includes(node.type)) source = node.source;
    else if (node.type === "ImportExpression") source = node.source;
    else if (node.type === "TSImportType") source = node.argument ?? node.source;
    else if (node.type === "TSExternalModuleReference") source = node.expression;
    else if (node.type === "CallExpression" && (node.callee?.type === "Import" || (node.callee?.type === "Identifier" && node.callee.name === "require"))) source = node.arguments?.[0];
    if (source?.type === "TSLiteralType") source = source.literal;
    if (source?.type === "StringLiteral") found.push({specifier:source.value,line:node.loc?.start?.line ?? null});
    for (const [key,value] of Object.entries(node)) {
      if (["loc","start","end","extra","comments","tokens","leadingComments","trailingComments","innerComments"].includes(key)) continue;
      if (Array.isArray(value)) stack.push(...value);
      else if (value && typeof value === "object") stack.push(value);
    }
  }
  return found.sort((a,b)=>(a.line??0)-(b.line??0)||a.specifier.localeCompare(b.specifier));
}
