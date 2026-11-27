#!/usr/bin/env node
// Deterministic functional-lane sharding for CI (plan PR 3).
// Round-robin over the sorted file list: alphabetical family clusters
// (ah7/ah10/...) interleave across shards, balancing the heavy
// multi-restart files. Each matrix shard is an isolated GitHub runner,
// so the local shared-CPU contention that produced false positives in
// the 8-way local sweep does not apply; shards stay serial internally.
// Usage: node scripts/testing/functional-shard.mjs <index> <total>
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../..", import.meta.url).pathname;
const index = Number(process.argv[2]);
const total = Number(process.argv[3]);
if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || total < 1 || index > total) {
  console.error("usage: functional-shard.mjs <index 1..total> <total>");
  process.exit(2);
}

const walk = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".functional.test.ts")) out.push(full);
  }
  return out;
};

const all = walk(join(root, "tests/functional")).sort();
const mine = all.filter((_, i) => i % total === index - 1);
console.log(mine.join("\n"));
console.error(`shard ${index}/${total}: ${mine.length} of ${all.length} files`);
