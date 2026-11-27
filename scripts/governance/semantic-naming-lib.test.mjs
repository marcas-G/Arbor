import assert from "node:assert/strict";
import test from "node:test";
import {
  isOutOfScope,
  isSourcePath,
  NUMBER_EXEMPT_PATTERN,
  OUT_OF_SCOPE_PREFIXES,
  PATH_PATTERN,
  pathViolation,
  symbolViolation,
  testNameViolation,
} from "./semantic-naming-lib.mjs";

test("path rule matches the historical p/ah planning-code shapes", () => {
  for (const path of [
    "tests/ah99-fake.test.ts",
    "tests/p3-driver.test.ts",
    "tests/scenario-10/actions.test.ts",
    "packages/agent-runtime/src/safety-identity.ts",
    "adapters/persistence-sqlite/src/maintenance.ts",
    "tests/functional/support/conversation-native-owner-fixture.ts",
  ])
    assert.equal(PATH_PATTERN.test(path), true, path);
  for (const path of [
    "packages/domain/src/workspace.ts",
    "packages/ports/src/recovery-binding.ts",
    "tests/functional/ui/app.spec.ts",
    "packages/ports/src/attention-projection.ts",
  ])
    assert.equal(PATH_PATTERN.test(path), false, path);
});

test("path rule only considers source files and in-scope trees", () => {
  assert.deepEqual(pathViolation("tests/ah99-fake.test.ts"), {
    path: "tests/ah99-fake.test.ts",
  });
  assert.equal(pathViolation("docs/engineering/p3-note.md"), null);
  assert.equal(pathViolation("planning/p1-governance-patch.md"), null);
  assert.equal(pathViolation("assets/p10-diagram.svg"), null);
});

test("symbol rule matches planning-coded declarations only", () => {
  // Example lines are assembled so this file itself is not a violation.
  const head = "export class ";
  const iface = "export interface ";
  const typeDecl = "export type ";
  const constDecl = "const ";
  const fnDecl = "function ";
  for (const [line, symbol] of [
    [`${head}WriterLockClient extends Context.Service<`, "WriterLockClient"],
    [`${iface}AH7RecoveryProbe {`, "AH7RecoveryProbe"],
    [
      `${typeDecl}SandboxUnavailableObservationV1 =`,
      "SandboxUnavailableObservationV1",
    ],
    [
      `${constDecl}P10AfterDeliverAttentionConsumerCommit = 1;`,
      "P10AfterDeliverAttentionConsumerCommit",
    ],
    [`${fnDecl}P11VerdictReader() {}`, "P11VerdictReader"],
  ])
    assert.deepEqual(symbolViolation(line)?.symbol, symbol);
  for (const line of [
    "const sha256 = createHash('sha256');",
    "export const schemaV57 = Schema.Struct({});",
    "function digest(input: string) { return sha256(input); }",
    "export class WriterLockClient {",
    "import type { WriterLockFailure } from './p39-writer-lock.js';",
    "  type MaintenanceFailure,",
  ])
    assert.equal(symbolViolation(line), null, line);
});

test("number exemption accepts protocol, algorithm and version numerals", () => {
  assert.equal(NUMBER_EXEMPT_PATTERN.test("sha256"), true);
  assert.equal(NUMBER_EXEMPT_PATTERN.test("sha1Hmac"), true);
  assert.equal(NUMBER_EXEMPT_PATTERN.test("xxHash64"), true);
  assert.equal(NUMBER_EXEMPT_PATTERN.test("md5"), true);
  assert.equal(NUMBER_EXEMPT_PATTERN.test("crc32c"), true);
  assert.equal(NUMBER_EXEMPT_PATTERN.test("base64Url"), true);
  assert.equal(NUMBER_EXEMPT_PATTERN.test("schemaV57"), true);
  assert.equal(NUMBER_EXEMPT_PATTERN.test("schema-v57"), true);
  assert.equal(NUMBER_EXEMPT_PATTERN.test("v12"), true);
  assert.equal(
    NUMBER_EXEMPT_PATTERN.test("ConversationCheckpointSourceManifestV1"),
    true,
  );
  assert.equal(NUMBER_EXEMPT_PATTERN.test("WriterLockClient"), false);
  assert.equal(NUMBER_EXEMPT_PATTERN.test("RecoveryProbe"), false);
  // The planning code wins over a trailing version suffix.
  const versioned = ["export type ", "SandboxUnavailableObservationV1 ="].join(
    "",
  );
  assert.equal(
    symbolViolation(versioned)?.symbol,
    "SandboxUnavailableObservationV1",
  );
});

test("test-name rule matches describe/it/test literals opening with a code", () => {
  const d = 'describe("';
  const i = "it('";
  const t = "test(`";
  for (const [line, name] of [
    [`${d}P3 DDL", () => {`, "P3"],
    [`${i}AH7 replays the ledger', async () => {`, "AH7"],
    [`${t}P12 transport compiles\`, () => {`, "P12"],
  ])
    assert.equal(testNameViolation(line)?.name, name);
  for (const line of [
    'describe("the DDL migration", () => {',
    'it("replays normally", async () => {',
    'test("passes", () => {',
    'describe("helpers stay clean", () => {',
  ])
    assert.equal(testNameViolation(line), null, line);
});

test("scope helpers exclude frozen inventory trees", () => {
  assert.deepEqual(OUT_OF_SCOPE_PREFIXES, ["docs/", "planning/"]);
  assert.equal(isOutOfScope("planning/history/p3-map.md"), true);
  assert.equal(isOutOfScope("packages/p3-helper/src/x.ts"), false);
  assert.equal(isSourcePath("a/x.test.ts"), true);
  assert.equal(isSourcePath("a/x.md"), false);
});
