#!/usr/bin/env node
// Deterministic functional-lane sharding for CI (plan PR 3).
// Round-robin over the sorted file list: alphabetical family clusters
// (ah7/ah10/...) interleave across shards, balancing the heavy
// multi-restart files. Each matrix shard is an isolated GitHub runner,
// so the local shared-CPU contention that produced false positives in
// the 8-way local sweep does not apply; shards stay serial internally.
// Usage: node scripts/testing/functional-shard.mjs <index> <total>
import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function collectFunctionalShardFiles(base = root) {
  const walk = (dir) => {
    const out = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (entry.endsWith(".functional.test.ts")) out.push(full);
    }
    return out;
  };
  return walk(join(base, "tests/functional")).sort();
}

export function shardFiles(files, index, total) {
  return files.filter((_, fileIndex) => fileIndex % total === index - 1);
}

function parseShardArgs(args) {
  const index = Number(args[0]);
  const total = Number(args[1]);
  if (
    !Number.isInteger(index) ||
    !Number.isInteger(total) ||
    index < 1 ||
    total < 1 ||
    index > total
  ) {
    return null;
  }
  return { index, total };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const shard = parseShardArgs(process.argv.slice(2));
  if (!shard) {
    console.error("usage: functional-shard.mjs <index 1..total> <total>");
    process.exit(2);
  }
  const all = collectFunctionalShardFiles();
  const mine = shardFiles(all, shard.index, shard.total);
  console.log(mine.join("\n"));
  console.error(
    `shard ${shard.index}/${shard.total}: ${mine.length} of ${all.length} files`,
  );
}
