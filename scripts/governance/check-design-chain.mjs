import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const designPaths = [
  "docs/design/00-problem-goals.md",
  "docs/design/01-scenarios.md",
  "docs/design/02-system-design.md",
  "docs/design/03-detailed-implementation-design.md",
];

const titles = [
  "Arbor Problem Definition & Goals",
  "Arbor Scenarios S1–S4",
  "Arbor System Design Specification",
];

export function checkDesignChain(read) {
  const errors = [];
  const versions = designPaths.map((path) => {
    let header;
    try {
      header = read(path).split(/\r?\n/).slice(0, 35);
    } catch (error) {
      errors.push(path + ": cannot read: " + String(error));
      return undefined;
    }
    const version = header
      .find((line) => line.startsWith("**Version:**"))
      ?.match(/^\*\*Version:\*\*\s*([0-9]+(?:\.[0-9]+)+)\s*\\?\s*$/)?.[1];
    if (!version) errors.push(path + ": missing/invalid version header");
    if (!header.some((line) => /^\*\*Status:\*\*/.test(line))) {
      errors.push(path + ": missing status header");
    }
    return { version, header };
  });
  for (const [index, required] of [
    [1, [0]],
    [2, [0, 1]],
    [3, [2]],
  ]) {
    const current = versions[index];
    if (!current) continue;
    const dependency =
      current.header.find((line) => line.startsWith("**Depends on:**")) ?? "";
    for (const owner of required) {
      const version = versions[owner]?.version;
      if (!version) continue;
      if (!dependency.includes(titles[owner] + " v" + version + "`")) {
        errors.push(
          designPaths[index] +
            ": expected dependency " +
            titles[owner] +
            " v" +
            version,
        );
      }
    }
  }
  return { errors, versions: versions.map((item) => item?.version ?? null) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const result = checkDesignChain((path) =>
    readFileSync(join(root, path), "utf8"),
  );
  console.log(JSON.stringify(result, null, 2));
  if (result.errors.length) process.exitCode = 1;
}
