import assert from "node:assert/strict";
import test from "node:test";
import {
  BATCH_SIZE_ENV,
  DEFAULT_BATCH_SIZE,
  parseBatchSize,
  runCoreTests,
  sortAndBatchFiles,
} from "./run-core-tests.mjs";

test("root-suite files are sorted deterministically and divided into bounded batches", () => {
  assert.deepEqual(
    sortAndBatchFiles(["z.test.ts", "a.test.ts", "m.test.ts", "b.test.ts"], 2),
    [
      ["a.test.ts", "b.test.ts"],
      ["m.test.ts", "z.test.ts"],
    ],
  );
  assert.equal(DEFAULT_BATCH_SIZE, 20);
});

test("batch size accepts a positive environment override and rejects invalid values", () => {
  assert.equal(parseBatchSize(undefined), 20);
  assert.equal(parseBatchSize(" 7 "), 7);
  for (const value of ["0", "-2", "1.5", "abc", "9007199254740992"]) {
    assert.throws(() => parseBatchSize(value), new RegExp(BATCH_SIZE_ENV));
  }
});

test("runner invokes listed root files sequentially with one worker and no retries", () => {
  const calls = [];
  const messages = [];
  const status = runCoreTests({
    cwd: "C:/fixture",
    cliPath: "C:/fixture/node_modules/vitest/vitest.mjs",
    env: { [BATCH_SIZE_ENV]: "2" },
    run: (executable, args, options) => {
      calls.push({ executable, args, options });
      return calls.length === 1
        ? { status: 0, stdout: "z.test.ts\na.test.ts\nm.test.ts\n" }
        : { status: 0 };
    },
    log: (message) => messages.push(message),
    error: (message) => messages.push(message),
  });

  assert.equal(status, 0);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1].args.slice(1), [
    "run",
    "a.test.ts",
    "m.test.ts",
    "--maxWorkers=1",
    "--no-file-parallelism",
    "--retry=0",
  ]);
  assert.deepEqual(calls[2].args.slice(1, 3), ["run", "z.test.ts"]);
  assert.equal(calls[1].options.stdio, "inherit");
  assert.match(messages[0], /3 files in 2 sequential batches/);
  assert.match(messages.at(-1), /all 3 files passed/);
});

test("runner stops on the first failed batch and propagates its status", () => {
  const calls = [];
  const errors = [];
  const status = runCoreTests({
    env: { [BATCH_SIZE_ENV]: "1" },
    run: (_executable, args) => {
      calls.push(args);
      return calls.length === 1
        ? { status: 0, stdout: "a.test.ts\nb.test.ts\n" }
        : { status: 17 };
    },
    log: () => {},
    error: (message) => errors.push(message),
  });
  assert.equal(status, 17);
  assert.equal(calls.length, 2);
  assert.match(errors[0], /batch 1\/2 failed/);
});

test("runner maps child SIGINT and SIGTERM to conventional exit codes", () => {
  for (const [signal, expectedStatus] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    let calls = 0;
    const status = runCoreTests({
      env: { [BATCH_SIZE_ENV]: "1" },
      run: () => {
        calls += 1;
        return calls === 1
          ? { status: 0, stdout: "a.test.ts\n" }
          : { status: null, signal };
      },
      log: () => {},
      error: () => {},
    });
    assert.equal(status, expectedStatus, signal);
    assert.equal(calls, 2, signal);
  }
});

test("runner rejects an invalid batch size before starting Vitest", () => {
  let called = false;
  const errors = [];
  const status = runCoreTests({
    env: { [BATCH_SIZE_ENV]: "0" },
    run: () => {
      called = true;
      return { status: 0 };
    },
    log: () => {},
    error: (message) => errors.push(message),
  });
  assert.equal(status, 2);
  assert.equal(called, false);
  assert.match(errors[0], new RegExp(BATCH_SIZE_ENV));
});
