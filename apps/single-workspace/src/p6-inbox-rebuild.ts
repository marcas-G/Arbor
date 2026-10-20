import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CURRENT_MIGRATIONS,
  makeTransactionPortLive,
  P38_MIGRATIONS,
  P39_MAINTENANCE_MIGRATIONS,
  type P39MaintenanceFailure,
  type P39MaintenanceSqlClient,
  p39WriterLockFilename,
  RetryVerificationOriginRepositoryLive,
  runMigrations,
  runP39SqliteMaintenanceWithPermit,
  splitStatements,
  layer as sqliteLayer,
} from "@arbor/persistence-sqlite";
import {
  RETRY_VERIFICATION_UNBOUND_LEGACY_SUMMARY,
  RetryVerificationOriginRepository,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  protectedApplicationDatabases,
  rejectSqliteArtifactAliases,
} from "./schema-upgrade.js";
import {
  assertDistinctPaths,
  canonicalExistingPath,
  canonicalNewPath,
  descriptorHashesThrough,
  existingPathIdentity,
  sameIdentity,
} from "./schema-upgrade-manifest.js";

export interface P6InboxRebuildArguments {
  readonly database: string;
  readonly p39Sidecar: string;
  readonly manifest: string;
  readonly resume: boolean;
}

/** Explicit process-boundary dependencies. Production callers use the
 * fail-closed P39 implementations below; process qualification may substitute
 * an already-qualified SQLite permit harness so crash/replay cases do not
 * repeatedly re-qualify the unrelated Windows ACL boundary. */
export interface P6InboxRebuildDependencies {
  readonly writerLockFilename: typeof p39WriterLockFilename;
  readonly runMaintenanceWithPermit: typeof runP39SqliteMaintenanceWithPermit;
}

const productionP6InboxRebuildDependencies: P6InboxRebuildDependencies = {
  writerLockFilename: p39WriterLockFilename,
  runMaintenanceWithPermit: runP39SqliteMaintenanceWithPermit,
};

export class P6InboxRebuildRefusal extends Error {
  readonly _tag = "P6InboxRebuildRefusal";
  readonly code = "P6_REBUILD_REFUSED";
}

const refuse = (message: string): never => {
  throw new P6InboxRebuildRefusal(message);
};
const safeCauseCode = (cause: unknown): string => {
  if (cause instanceof P6InboxRebuildRefusal) return "P6_REBUILD_REFUSED";
  if (typeof cause === "object" && cause !== null && "_tag" in cause) {
    const tag = String((cause as { _tag?: unknown })._tag);
    if (tag === "TransactionOperationalFailure") return "P6_TRANSACTION_FAILED";
    if (tag.startsWith("RetryVerificationOriginRepository"))
      return "P6_REPOSITORY_FAILED";
    if (tag === "SqlError") return "P6_SQL_FAILED";
  }
  return "P6_OPERATION_FAILED";
};

const findSafeFailureCode = (cause: unknown, depth = 0): string => {
  if (depth > 8 || typeof cause !== "object" || cause === null)
    return "P6_REBUILD_FAILED";
  if ("code" in cause) {
    const code = String((cause as { code?: unknown }).code);
    if (/^P39_[A-Z0-9_]+$/u.test(code)) return code;
  }
  if ("_tag" in cause) {
    const tag = String((cause as { _tag?: unknown })._tag);
    if (tag === "SqlError") return "P6_SQL_FAILED";
    if (tag === "TransactionOperationalFailure") return "P6_TRANSACTION_FAILED";
  }
  for (const value of Object.values(cause)) {
    const nested = findSafeFailureCode(value, depth + 1);
    if (nested !== "P6_REBUILD_FAILED") return nested;
  }
  return "P6_REBUILD_FAILED";
};

const waitAtTestBoundary = (
  boundary: "before-p39" | "created" | "prepared" | "database-committed",
) => {
  if (
    process.env.NODE_ENV !== "test" ||
    process.env.ARBOR_P6_TEST_HOLD_BOUNDARY !== boundary
  )
    return Promise.resolve();
  process.stdout.write(`P6_REBUILD_TEST_BOUNDARY:${boundary}\n`);
  return new Promise<void>((resolveBoundary) =>
    process.stdin.once("data", () => resolveBoundary()),
  );
};

export const p6InboxRebuildUsage = (): string =>
  "Usage: pnpm --filter @arbor/single-workspace p6:inbox-rebuild --database <absolute-path> --p39-sidecar <absolute-new-or-existing-path> --manifest <absolute-path> [--resume]";

export const parseP6InboxRebuildArguments = (
  argv: ReadonlyArray<string>,
): P6InboxRebuildArguments => {
  const values = new Map<string, string>();
  let resume = false;
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--resume") {
      if (resume) refuse("--resume may be specified only once");
      resume = true;
      continue;
    }
    if (
      (key !== "--database" &&
        key !== "--p39-sidecar" &&
        key !== "--manifest") ||
      values.has(key)
    ) {
      refuse("unsupported or duplicate P6 rebuild argument");
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--"))
      return refuse("P6 rebuild argument is missing its path");
    values.set(key as string, value);
    index += 1;
  }
  const database = values.get("--database");
  const p39Sidecar = values.get("--p39-sidecar");
  const manifest = values.get("--manifest");
  if (
    database === undefined ||
    p39Sidecar === undefined ||
    manifest === undefined
  )
    return refuse("--database, --p39-sidecar and --manifest are required");
  const required = { database, p39Sidecar, manifest };
  for (const path of [
    required.database,
    required.p39Sidecar,
    required.manifest,
  ]) {
    if (!isAbsolute(path) || path.startsWith("file:"))
      refuse("P6 rebuild paths must be absolute filesystem paths");
  }
  const canonicalDatabase = resolve(required.database);
  if (
    new Set([
      canonicalDatabase.toLowerCase(),
      resolve(required.p39Sidecar).toLowerCase(),
      resolve(required.manifest).toLowerCase(),
    ]).size !== 3
  )
    refuse("database, P39 sidecar and JSONL manifest paths must be distinct");
  return {
    database: canonicalDatabase,
    p39Sidecar: resolve(required.p39Sidecar),
    manifest: resolve(required.manifest),
    resume,
  };
};

interface Envelope {
  readonly sequence: number;
  readonly previousHash: string | null;
  readonly record: Readonly<Record<string, unknown>>;
  readonly hash: string;
}

export const canonicalP6InboxJson = (value: unknown): string => {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value))
    return `[${value.map(canonicalP6InboxJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(
      ([key, entry]) => `${JSON.stringify(key)}:${canonicalP6InboxJson(entry)}`,
    )
    .join(",")}}`;
};
const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
export const p6InboxManifestEnvelope = (
  sequence: number,
  previousHash: string | null,
  record: Readonly<Record<string, unknown>>,
): Envelope => ({
  sequence,
  previousHash,
  record,
  hash: sha256(canonicalP6InboxJson({ sequence, previousHash, record })),
});

export const validateP6InboxManifestText = (text: string): Envelope[] => {
  if (text.length === 0) return [];
  if (!text.endsWith("\n")) refuse("manifest has a torn final record");
  const records: Envelope[] = [];
  let previous: string | null = null;
  for (const [sequence, line] of text.slice(0, -1).split("\n").entries()) {
    let parsed: Envelope;
    try {
      parsed = JSON.parse(line) as Envelope;
    } catch {
      return refuse("manifest JSON is invalid");
    }
    if (
      canonicalP6InboxJson(parsed) !== line ||
      parsed.sequence !== sequence ||
      parsed.previousHash !== previous ||
      parsed.hash !==
        p6InboxManifestEnvelope(sequence, previous, parsed.record).hash
    )
      refuse("manifest hash chain is invalid");
    records.push(parsed);
    previous = parsed.hash;
  }
  if (records[0]?.record.kind !== "Created")
    refuse("manifest Created header is missing");
  const kinds = records.map(({ record }) => record.kind);
  if (
    records.length > 3 ||
    (records.length >= 2 && kinds[1] !== "Prepared") ||
    (records.length === 3 && kinds[2] !== "Committed")
  )
    refuse("manifest operation record order is invalid");
  if (
    records[0]?.record.schema !==
      "arbor-p6-unbound-legacy-inbox-rebuild-manifest/v1" ||
    records[0]?.record.operation !==
      "rebuild-unbound-legacy-inbox-projections" ||
    records[0]?.record.schemaVersion !== 48 ||
    typeof records[0]?.record.schemaSignature !== "string" ||
    !/^[0-9a-f]{64}$/u.test(String(records[0]?.record.schemaSignature)) ||
    !/^[0-9a-f]{64}$/u.test(String(records[0]?.record.initialDatabaseDigest))
  )
    refuse("manifest schema is unsupported");
  const expectedDescriptors = descriptorHashesThrough(48);
  if (
    !Array.isArray(records[0]?.record.descriptors) ||
    canonicalP6InboxJson(records[0]?.record.descriptors) !==
      canonicalP6InboxJson(expectedDescriptors)
  )
    refuse("manifest schema descriptor prefix is invalid");
  if (records.length >= 2) {
    const prepared = records[1]?.record;
    if (
      prepared?.schemaVersion !== 48 ||
      typeof prepared.preWriteDatabaseDigest !== "string" ||
      !/^[0-9a-f]{64}$/u.test(prepared.preWriteDatabaseDigest) ||
      typeof prepared.canonicalInputDigest !== "string" ||
      !/^[0-9a-f]{64}$/u.test(prepared.canonicalInputDigest) ||
      typeof prepared.projectionBeforeDigest !== "string" ||
      !/^[0-9a-f]{64}$/u.test(prepared.projectionBeforeDigest) ||
      !Array.isArray(prepared.projectionBefore) ||
      typeof prepared.operationId !== "string" ||
      !/^[0-9a-f]{64}$/u.test(prepared.operationId) ||
      prepared.schemaSignature !== records[0]?.record.schemaSignature
    )
      refuse("manifest Prepared record is invalid");
  }
  if (records.length === 3) {
    const prepared = records[1]?.record;
    const committed = records[2]?.record;
    if (
      committed?.schemaVersion !== 48 ||
      committed.canonicalInputDigest !== prepared?.canonicalInputDigest ||
      committed.preWriteDatabaseDigest !== prepared?.preWriteDatabaseDigest ||
      typeof committed.finalDatabaseDigest !== "string" ||
      !/^[0-9a-f]{64}$/u.test(committed.finalDatabaseDigest) ||
      typeof committed.projectionDigest !== "string" ||
      !/^[0-9a-f]{64}$/u.test(committed.projectionDigest) ||
      !Number.isInteger(committed.inserted) ||
      !Number.isInteger(committed.moved) ||
      !Number.isInteger(committed.noOp)
    )
      refuse("manifest Committed record is invalid");
  }
  const nonce = records[0]?.record.nonce;
  if (
    typeof nonce !== "string" ||
    !/^[0-9a-f]{64}$/u.test(nonce) ||
    records.some(({ record }) => record.nonce !== nonce)
  )
    refuse("manifest nonce binding is invalid");
  return records;
};

const manifestRecords = (filename: string): Envelope[] => {
  if (!existsSync(filename)) return [];
  return validateP6InboxManifestText(readFileSync(filename, "utf8"));
};

const appendRecord = (
  filename: string,
  records: ReadonlyArray<Envelope>,
  record: Readonly<Record<string, unknown>>,
): Envelope => {
  const current = manifestRecords(filename);
  if (
    current.length !== records.length ||
    current.at(-1)?.hash !== records.at(-1)?.hash
  )
    refuse("manifest head changed before append");
  const identity = existingPathIdentity(filename);
  const entry = p6InboxManifestEnvelope(
    records.length,
    records.at(-1)?.hash ?? null,
    record,
  );
  const descriptor = openSync(
    filename,
    existsSync(filename) ? "a" : "wx",
    0o600,
  );
  try {
    const stat = fstatSync(descriptor, { bigint: true });
    if (
      !stat.isFile() ||
      stat.dev.toString() !== identity.file.device ||
      stat.ino.toString() !== identity.file.fileId ||
      stat.nlink !== 1n
    )
      refuse("manifest append descriptor identity changed");
    const bytes = Buffer.from(`${canonicalP6InboxJson(entry)}\n`, "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
      );
      if (written <= 0) refuse("manifest append made no forward progress");
      offset += written;
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return entry;
};

const sqlLayerFor = (primary: P39MaintenanceSqlClient) =>
  Layer.succeed(SqlClient, primary as never);

interface SchemaObject {
  readonly type: string;
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string | null;
}
interface SchemaColumn {
  readonly cid: number;
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: string | null;
  readonly pk: number;
  readonly hidden: number;
}

const schemaSignature = (
  primary: P39MaintenanceSqlClient,
): Effect.Effect<string, unknown> =>
  Effect.gen(function* () {
    const app = yield* primary.unsafe<{ application_id: number }>(
      "PRAGMA application_id",
    );
    const version = yield* primary.unsafe<{ user_version: number }>(
      "PRAGMA user_version",
    );
    const objects =
      yield* primary.unsafe<SchemaObject>(`SELECT type,name,tbl_name,sql FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_stat%' ORDER BY type COLLATE BINARY,name COLLATE BINARY,tbl_name COLLATE BINARY`);
    const tables = objects
      .filter(
        ({ type, name }) =>
          type === "table" &&
          name !== "sqlite_sequence" &&
          !name.startsWith("sqlite_stat"),
      )
      .map(({ name }) => name)
      .sort();
    const columnShape: Array<{ table: string; columns: Array<SchemaColumn> }> =
      [];
    for (const table of tables) {
      const escaped = table.replaceAll('"', '""');
      const columns = yield* primary.unsafe<SchemaColumn>(
        `PRAGMA table_xinfo("${escaped}")`,
      );
      columnShape.push({
        table,
        columns: [...columns].sort((a, b) => a.cid - b.cid),
      });
    }
    return sha256(
      JSON.stringify({
        applicationId: Number(app[0]?.application_id ?? 0),
        userVersion: Number(version[0]?.user_version ?? 0),
        objects,
        columnShape,
      }),
    );
  });

const digestValue = (value: unknown): unknown => {
  if (typeof value === "bigint") return { integer: value.toString() };
  if (value instanceof Uint8Array)
    return { blob: Buffer.from(value).toString("hex") };
  if (Array.isArray(value)) return value.map(digestValue);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, digestValue(entry)]),
    );
  return value;
};

const logicalDigest = (
  primary: P39MaintenanceSqlClient,
  onlyTables?: ReadonlyArray<string>,
): Effect.Effect<string, unknown> =>
  Effect.gen(function* () {
    const version = yield* primary.unsafe<{ application_id: number }>(
      "PRAGMA application_id",
    );
    const userVersion = yield* primary.unsafe<{ user_version: number }>(
      "PRAGMA user_version",
    );
    const schema =
      yield* primary.unsafe<SchemaObject>(`SELECT type,name,tbl_name,sql FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_stat%' ORDER BY type COLLATE BINARY,name COLLATE BINARY,tbl_name COLLATE BINARY`);
    const hash = createHash("sha256");
    hash.update(
      canonicalP6InboxJson({
        applicationId: version[0]?.application_id ?? 0,
        userVersion: userVersion[0]?.user_version ?? 0,
        schema,
      }),
    );
    const tables = schema
      .filter(
        ({ type, name }) =>
          type === "table" &&
          name !== "sqlite_sequence" &&
          !name.startsWith("sqlite_stat") &&
          (onlyTables === undefined || onlyTables.includes(name)),
      )
      .map(({ name }) => name)
      .sort();
    for (const table of tables) {
      const quotedTable = `"${table.replaceAll('"', '""')}"`;
      const columns = yield* primary.unsafe<SchemaColumn>(
        `PRAGMA table_xinfo(${quotedTable})`,
      );
      const ordinary = columns
        .filter(({ hidden }) => hidden === 0)
        .sort((a, b) => a.cid - b.cid);
      const selected = ordinary.flatMap(({ name }, index) => {
        const column = `"${name.replaceAll('"', '""')}"`;
        return [
          `typeof(${column}) AS type_${index}`,
          `${column} AS value_${index}`,
        ];
      });
      const ordering = ordinary
        .map(({ name }) => `"${name.replaceAll('"', '""')}"`)
        .join(",");
      const rows = yield* primary.unsafe<Record<string, unknown>>(
        `SELECT ${selected.join(",")} FROM ${quotedTable}${ordering.length === 0 ? "" : ` ORDER BY ${ordering}`}`,
      );
      hash.update(canonicalP6InboxJson({ table, columns: ordinary }));
      for (const row of rows)
        hash.update(canonicalP6InboxJson(digestValue(row)));
    }
    if (
      onlyTables === undefined &&
      schema.some(({ name }) => name === "sqlite_sequence")
    ) {
      const sequence = yield* primary.unsafe(
        "SELECT name,seq FROM sqlite_sequence ORDER BY name COLLATE BINARY",
      );
      hash.update(canonicalP6InboxJson(digestValue(sequence)));
    }
    return hash.digest("hex");
  });

const CANONICAL_INPUT_TABLES = [
  "projects",
  "workspaces",
  "works",
  "verifications",
  "commands",
  "domain_events",
  "retry_verification_origins",
  "retry_verification_legacy_dispositions",
] as const;

interface InboxProjectionRow {
  readonly workspace_id: string;
  readonly kind: string;
  readonly summary: string;
  readonly correlation_id: string | null;
  readonly admitted_at: string;
  readonly consumed_at: string | null;
  readonly revision: number;
  readonly updated_at: string;
}

interface InboxProjectionSnapshotEntry {
  readonly entryKey: string;
  readonly row: InboxProjectionRow;
}

const decodeProjectionBefore = (
  raw: unknown,
): ReadonlyMap<string, InboxProjectionRow> => {
  if (!Array.isArray(raw)) refuse("Prepared projection snapshot is malformed");
  const snapshot = new Map<string, InboxProjectionRow>();
  for (const item of raw as Array<InboxProjectionSnapshotEntry>) {
    if (
      typeof item?.entryKey !== "string" ||
      typeof item.row?.workspace_id !== "string" ||
      typeof item.row?.admitted_at !== "string" ||
      typeof item.row?.updated_at !== "string" ||
      !Number.isInteger(item.row?.revision) ||
      snapshot.has(item.entryKey)
    )
      refuse("Prepared projection snapshot is malformed");
    snapshot.set(item.entryKey, item.row);
  }
  return snapshot;
};
const inboxProjectionSnapshot = (
  primary: P39MaintenanceSqlClient,
  requireComplete = false,
): Effect.Effect<ReadonlyMap<string, InboxProjectionRow>, unknown> =>
  Effect.gen(function* () {
    const dispositions = yield* primary.unsafe<{ command_id: string }>(
      "SELECT command_id FROM retry_verification_legacy_dispositions ORDER BY command_id",
    );
    const rows = new Map<string, InboxProjectionRow>();
    for (const { command_id } of dispositions) {
      const key = `retry-verification-unbound:${command_id}`;
      const found = yield* primary.unsafe<InboxProjectionRow>(
        "SELECT workspace_id, kind, summary, correlation_id, admitted_at, consumed_at, revision, updated_at FROM inbox_entries WHERE entry_key = ?",
        [key],
      );
      if (found.length > 1 || (requireComplete && found.length !== 1))
        return yield* Effect.fail(
          new P6InboxRebuildRefusal(
            "disposition does not have exactly one stable-key Inbox projection",
          ),
        );
      if (found[0] !== undefined) rows.set(key, found[0]);
    }
    return rows;
  });

const projectionSnapshotEntries = (
  snapshot: ReadonlyMap<string, InboxProjectionRow>,
): InboxProjectionSnapshotEntry[] =>
  [...snapshot]
    .map(([entryKey, row]) => ({ entryKey, row }))
    .sort((left, right) =>
      left.entryKey < right.entryKey
        ? -1
        : left.entryKey > right.entryKey
          ? 1
          : 0,
    );

interface InboxProjectionOutcome {
  readonly inserted: number;
  readonly moved: number;
  readonly noOp: number;
  readonly finalDatabaseDigest: string;
  readonly projectionDigest: string;
}

const verifyRebuiltProjection = (
  primary: P39MaintenanceSqlClient,
  projectionBefore: ReadonlyMap<string, InboxProjectionRow>,
  canonicalInputDigest: string,
): Effect.Effect<InboxProjectionOutcome, unknown> =>
  Effect.gen(function* () {
    const postFk = yield* primary.unsafe("PRAGMA foreign_key_check");
    if (postFk.length > 0)
      return yield* Effect.fail(
        new P6InboxRebuildRefusal("post-rebuild foreign_key_check failed"),
      );
    const inboxAfter = yield* inboxProjectionSnapshot(primary, true);
    let inserted = 0;
    let moved = 0;
    let noOp = 0;
    for (const [key, after] of inboxAfter) {
      const commandId = key.slice("retry-verification-unbound:".length);
      const dispositionRows = yield* primary.unsafe<{ created_at: string }>(
        "SELECT created_at FROM retry_verification_legacy_dispositions WHERE command_id = ?",
        [commandId],
      );
      if (
        after.kind !== "Governance" ||
        after.summary !== RETRY_VERIFICATION_UNBOUND_LEGACY_SUMMARY ||
        after.correlation_id !== commandId ||
        after.consumed_at !== null ||
        after.admitted_at !== dispositionRows[0]?.created_at
      )
        return yield* Effect.fail(
          new P6InboxRebuildRefusal(
            "Inbox projection does not match its immutable disposition",
          ),
        );
      const before = projectionBefore.get(key);
      if (before === undefined) {
        inserted += 1;
        if (Number(after.revision) !== 1)
          return yield* Effect.fail(
            new P6InboxRebuildRefusal(
              "inserted Inbox projection has an invalid initial revision",
            ),
          );
      } else if (before.workspace_id !== after.workspace_id) {
        moved += 1;
        if (
          before.admitted_at !== after.admitted_at ||
          Number(after.revision) !== Number(before.revision) + 1
        )
          return yield* Effect.fail(
            new P6InboxRebuildRefusal(
              "moved Inbox projection did not preserve admission and increment once",
            ),
          );
      } else {
        noOp += 1;
        if (
          before.admitted_at !== after.admitted_at ||
          Number(after.revision) !== Number(before.revision)
        )
          return yield* Effect.fail(
            new P6InboxRebuildRefusal("exact Inbox projection was not a no-op"),
          );
      }
    }
    if (inboxAfter.size !== projectionBefore.size + inserted)
      return yield* Effect.fail(
        new P6InboxRebuildRefusal(
          "projection key cardinality changed unexpectedly",
        ),
      );
    const canonicalAfter = yield* logicalDigest(
      primary,
      CANONICAL_INPUT_TABLES,
    );
    if (canonicalAfter !== canonicalInputDigest)
      return yield* Effect.fail(
        new P6InboxRebuildRefusal(
          "canonical F23 facts changed during projection rebuild",
        ),
      );
    return {
      inserted,
      moved,
      noOp,
      finalDatabaseDigest: yield* logicalDigest(primary),
      projectionDigest: yield* logicalDigest(primary, ["inbox_entries"]),
    };
  });

let trustedSchema48Signature: Promise<string> | undefined;
export const deriveTrustedSchema48Signature = (): Promise<string> => {
  trustedSchema48Signature ??= Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        Effect.gen(function* () {
          const client = yield* SqlClient;
          yield* runMigrations(P38_MIGRATIONS, { allowOfflineOnly: true });
          const p39 = P39_MAINTENANCE_MIGRATIONS.find(({ id }) => id === 39);
          if (p39 === undefined)
            throw new Error("trusted P39 schema descriptor is unavailable");
          yield* client.unsafe("PRAGMA foreign_keys = OFF");
          yield* client.unsafe("PRAGMA legacy_alter_table = ON");
          yield* client.unsafe("BEGIN IMMEDIATE");
          for (const statement of splitStatements(p39.sql))
            yield* client.unsafe(statement);
          yield* client.unsafe("PRAGMA user_version = 39");
          yield* client.unsafe("COMMIT");
          yield* client.unsafe("PRAGMA legacy_alter_table = OFF");
          yield* client.unsafe("PRAGMA foreign_keys = ON");
          // P6 is an exact historical schema-48 maintenance operation.  The
          // production migration catalog continues to grow, so applying the
          // whole current catalog here silently changes the supposedly pinned
          // signature whenever a later migration is registered.  Rebuild the
          // same prefix accepted by the operator instead.
          yield* runMigrations(
            CURRENT_MIGRATIONS.filter(({ id }) => id <= 48),
            { allowOfflineOnly: true },
          );
          const primary = {
            unsafe: client.unsafe,
            withTransaction: client.withTransaction,
          } as P39MaintenanceSqlClient;
          return yield* schemaSignature(primary);
        }),
        sqliteLayer({ filename: ":memory:" }),
      ),
    ),
  );
  return trustedSchema48Signature;
};

export const runP6InboxRebuild = async (
  args: P6InboxRebuildArguments,
  dependencies: P6InboxRebuildDependencies = productionP6InboxRebuildDependencies,
): Promise<void> => {
  if (
    !existsSync(args.database) ||
    realpathSync.native(args.database) !== args.database
  )
    refuse("database must exist at its canonical path");
  const manifestExistedAtStart = existsSync(args.manifest);
  if (args.resume && !manifestExistedAtStart)
    refuse("resume requires the existing operation manifest");
  const manifestPath = manifestExistedAtStart
    ? canonicalExistingPath(args.manifest)
    : canonicalNewPath(args.manifest);
  const targetIdentity = existingPathIdentity(args.database);
  const protectedApplications = protectedApplicationDatabases().filter(
    (path) => !sameIdentity(targetIdentity, existingPathIdentity(path)),
  );
  const lockFilename = dependencies.writerLockFilename(args.database);
  const lockPath =
    typeof lockFilename === "string"
      ? lockFilename
      : refuse("P39 primary writer-lock path is invalid");
  const protectedDatabases = [
    args.database,
    ...protectedApplications,
    lockPath,
  ];
  const evidencePaths = [args.p39Sidecar, manifestPath];
  const protectedArtifactDatabases = [...protectedDatabases, args.p39Sidecar];
  rejectSqliteArtifactAliases(protectedDatabases, evidencePaths);
  rejectSqliteArtifactAliases(protectedArtifactDatabases, [manifestPath]);
  const protectedArtifactPaths = protectedArtifactDatabases.flatMap((path) =>
    existsSync(path)
      ? [
          path,
          ...["-wal", "-shm", "-journal"]
            .map((suffix) => `${path}${suffix}`)
            .filter((sidecar) => existsSync(sidecar)),
        ]
      : [
          ...["-wal", "-shm", "-journal"]
            .map((suffix) => `${path}${suffix}`)
            .filter((sidecar) => existsSync(sidecar)),
        ],
  );
  const protectedIdentities = protectedArtifactPaths.map((path) =>
    existingPathIdentity(path),
  );
  const manifestIdentity = existsSync(manifestPath)
    ? existingPathIdentity(manifestPath)
    : null;
  assertDistinctPaths([
    ...protectedIdentities.map(
      (identity, index) =>
        [`protected database artifact ${index}`, identity] as const,
    ),
    ["manifest", manifestIdentity],
  ]);
  let activeRecords = manifestRecords(manifestPath);
  if ((activeRecords.length > 0 || manifestExistedAtStart) && !args.resume)
    refuse("existing manifest requires --resume");
  if (
    activeRecords.some(({ record }) => record.kind === "Committed") &&
    !args.resume
  )
    refuse("manifest is already committed");
  const startedAt = new Date().toISOString();
  await waitAtTestBoundary("before-p39");
  let canonicalInputDigest = "";
  let preparedDatabaseDigest = "";
  let preparedProjectionBefore: ReadonlyMap<string, InboxProjectionRow> =
    new Map();
  let currentPhase = "P39 path and sidecar validation";
  try {
    await Effect.runPromise(
      dependencies.runMaintenanceWithPermit(
        {
          primaryFilename: args.database,
          sidecarFilename: args.p39Sidecar,
          protectedStoreFilenames: [...protectedApplications, lockPath].filter(
            (path) => path !== args.database,
          ),
        },
        (primary) =>
          Effect.gen(function* () {
            if (activeRecords.at(-1)?.record.kind === "Committed") {
              const committed = activeRecords.at(-1)?.record;
              const currentInputDigest = yield* logicalDigest(
                primary,
                CANONICAL_INPUT_TABLES,
              );
              const currentProjectionDigest = yield* logicalDigest(primary, [
                "inbox_entries",
              ]);
              const currentDatabaseDigest = yield* logicalDigest(primary);
              if (
                committed?.canonicalInputDigest !== currentInputDigest ||
                committed?.projectionDigest !== currentProjectionDigest ||
                committed?.finalDatabaseDigest !== currentDatabaseDigest
              )
                return yield* Effect.fail(
                  new P6InboxRebuildRefusal(
                    "committed manifest is superseded by current database state",
                  ),
                );
              return;
            }
            if (activeRecords.length === 0)
              return yield* Effect.fail(
                new P6InboxRebuildRefusal(
                  "Prepared manifest was not durably created under permit",
                ),
              );
            const primaryLayer = sqlLayerFor(primary);
            const services = Layer.mergeAll(
              Layer.provide(makeTransactionPortLive(), primaryLayer),
              Layer.provide(
                RetryVerificationOriginRepositoryLive,
                primaryLayer,
              ),
            );
            const outcome = yield* Effect.scoped(
              Effect.provide(
                Effect.gen(function* () {
                  const tx = yield* TransactionPort;
                  const repository = yield* RetryVerificationOriginRepository;
                  return yield* tx.transact(
                    Effect.gen(function* () {
                      yield* repository.rebuildUnboundLegacyInboxProjections(
                        startedAt,
                      );
                      return yield* verifyRebuiltProjection(
                        primary,
                        preparedProjectionBefore,
                        canonicalInputDigest,
                      );
                    }),
                  );
                }),
                services,
              ),
            );
            const committedDigest = yield* logicalDigest(primary);
            const committedProjectionDigest = yield* logicalDigest(primary, [
              "inbox_entries",
            ]);
            if (
              committedDigest !== outcome.finalDatabaseDigest ||
              committedProjectionDigest !== outcome.projectionDigest
            )
              return yield* Effect.fail(
                new P6InboxRebuildRefusal(
                  "SQLite COMMIT did not preserve the observed projection state",
                ),
              );
            process.stdout.write("P6_REBUILD_DATABASE_COMMITTED\n");
            yield* Effect.promise(() =>
              waitAtTestBoundary("database-committed"),
            );
            appendRecord(manifestPath, activeRecords, {
              kind: "Committed",
              nonce: activeRecords[0]?.record.nonce,
              binding: activeRecords[0]?.record.binding,
              schemaVersion: 48,
              preWriteDatabaseDigest: preparedDatabaseDigest,
              finalDatabaseDigest: outcome.finalDatabaseDigest,
              canonicalInputDigest,
              projectionDigest: outcome.projectionDigest,
              inserted: outcome.inserted,
              moved: outcome.moved,
              noOp: outcome.noOp,
              committedAt: new Date().toISOString(),
            });
          }).pipe(
            Effect.mapError(
              (cause) =>
                ({
                  _tag: "P39MaintenanceFailure",
                  code: "P39_MIGRATION_PREFIX_INVALID",
                  cause: {
                    _tag: "P6OperatorDiagnostic",
                    code: safeCauseCode(cause),
                  },
                }) as P39MaintenanceFailure,
            ),
          ),
        {
          onPhase: (phase) => {
            currentPhase = phase;
            if (
              process.env.NODE_ENV === "test" &&
              process.env.ARBOR_P6_TEST_CRASH_P39_PHASE === phase
            ) {
              process.stdout.write(`P6_P39_TEST_CRASH_PHASE:${phase}\n`);
              process.kill(process.pid, "SIGTERM");
            }
          },
          beforeMaintenance: (primary) =>
            Effect.gen(function* () {
              const versionRows = yield* primary.unsafe<{
                user_version: number;
              }>("PRAGMA user_version");
              if (Number(versionRows[0]?.user_version) !== 48)
                return yield* Effect.fail({
                  _tag: "P39MaintenanceFailure",
                  code: "P39_MIGRATION_PREFIX_INVALID",
                } as P39MaintenanceFailure);
              const fk = yield* primary.unsafe("PRAGMA foreign_key_check");
              if (fk.length > 0)
                return yield* Effect.fail({
                  _tag: "P39MaintenanceFailure",
                  code: "P39_MIGRATION_PREFIX_INVALID",
                } as P39MaintenanceFailure);
              const required = yield* primary.unsafe<{ name: string }>(
                "SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('retry_verification_legacy_dispositions','retry_verification_origins','inbox_entries','works','verifications','projects','workspaces') ORDER BY name",
              );
              if (required.length !== 7)
                return yield* Effect.fail({
                  _tag: "P39MaintenanceFailure",
                  code: "P39_MIGRATION_PREFIX_INVALID",
                } as P39MaintenanceFailure);
              const actualSignature = yield* schemaSignature(primary);
              const expectedSignature = yield* Effect.promise(
                deriveTrustedSchema48Signature,
              );
              if (actualSignature !== expectedSignature)
                return yield* Effect.fail({
                  _tag: "P39MaintenanceFailure",
                  code: "P39_MIGRATION_PREFIX_INVALID",
                } as P39MaintenanceFailure);
              const currentDatabaseDigest = yield* logicalDigest(primary);
              canonicalInputDigest = yield* logicalDigest(
                primary,
                CANONICAL_INPUT_TABLES,
              );
              const latestRecords = manifestRecords(manifestPath);
              if (activeRecords.length === 0 && latestRecords.length > 0) {
                if (!args.resume)
                  return yield* Effect.fail({
                    _tag: "P39MaintenanceFailure",
                    code: "P39_MIGRATION_PREFIX_INVALID",
                  } as P39MaintenanceFailure);
                activeRecords = latestRecords;
              }
              if (activeRecords.length === 0) {
                if (!existsSync(manifestPath)) {
                  const descriptor = openSync(manifestPath, "wx", 0o600);
                  try {
                    fsyncSync(descriptor);
                  } finally {
                    closeSync(descriptor);
                  }
                }
                const binding = {
                  target: existingPathIdentity(args.database),
                  sidecar: existingPathIdentity(args.p39Sidecar),
                  manifest: existingPathIdentity(manifestPath),
                };
                const header = appendRecord(manifestPath, activeRecords, {
                  kind: "Created",
                  schema: "arbor-p6-unbound-legacy-inbox-rebuild-manifest/v1",
                  nonce: randomBytes(32).toString("hex"),
                  operation: "rebuild-unbound-legacy-inbox-projections",
                  binding,
                  schemaVersion: 48,
                  schemaSignature: actualSignature,
                  descriptors: descriptorHashesThrough(48),
                  initialDatabaseDigest: currentDatabaseDigest,
                  createdAt: startedAt,
                });
                activeRecords = [header];
                yield* Effect.promise(() => waitAtTestBoundary("created"));
              } else {
                const expectedBinding = activeRecords[0]?.record.binding as
                  | Record<string, unknown>
                  | undefined;
                const currentBinding = {
                  target: existingPathIdentity(args.database),
                  sidecar: existingPathIdentity(args.p39Sidecar),
                  manifest: existingPathIdentity(manifestPath),
                };
                if (
                  expectedBinding === undefined ||
                  canonicalP6InboxJson(currentBinding) !==
                    canonicalP6InboxJson(expectedBinding)
                )
                  return yield* Effect.fail({
                    _tag: "P39MaintenanceFailure",
                    code: "P39_MIGRATION_PREFIX_INVALID",
                  } as P39MaintenanceFailure);
              }
              if (
                activeRecords.length === 1 &&
                activeRecords[0]?.record.initialDatabaseDigest !==
                  currentDatabaseDigest
              )
                return yield* Effect.fail({
                  _tag: "P39MaintenanceFailure",
                  code: "P39_MIGRATION_PREFIX_INVALID",
                } as P39MaintenanceFailure);
              if (activeRecords.at(-1)?.record.kind === "Committed")
                return true;
              if (activeRecords.at(-1)?.record.kind !== "Prepared") {
                const snapshotRows = yield* inboxProjectionSnapshot(primary);
                const projectionBefore =
                  projectionSnapshotEntries(snapshotRows);
                const prepared = appendRecord(manifestPath, activeRecords, {
                  kind: "Prepared",
                  nonce: activeRecords[0]?.record.nonce,
                  binding: activeRecords[0]?.record.binding,
                  schemaVersion: 48,
                  schemaSignature: actualSignature,
                  preWriteDatabaseDigest: currentDatabaseDigest,
                  canonicalInputDigest,
                  projectionBefore,
                  projectionBeforeDigest: sha256(
                    canonicalP6InboxJson(projectionBefore),
                  ),
                  operationId: sha256(`${activeRecords[0]?.hash}:${startedAt}`),
                  preparedAt: startedAt,
                });
                activeRecords = [...activeRecords, prepared];
                preparedDatabaseDigest = currentDatabaseDigest;
                preparedProjectionBefore = snapshotRows;
                process.stdout.write("P6_REBUILD_PREPARED\n");
                yield* Effect.promise(() => waitAtTestBoundary("prepared"));
              } else {
                const prepared = activeRecords.at(-1)?.record;
                if (
                  prepared?.canonicalInputDigest !== canonicalInputDigest ||
                  prepared?.schemaSignature !== actualSignature
                )
                  return yield* Effect.fail({
                    _tag: "P39MaintenanceFailure",
                    code: "P39_MIGRATION_PREFIX_INVALID",
                  } as P39MaintenanceFailure);
                preparedDatabaseDigest = String(
                  prepared.preWriteDatabaseDigest,
                );
                const projectionBefore = decodeProjectionBefore(
                  prepared.projectionBefore,
                );
                if (
                  prepared.projectionBeforeDigest !==
                  sha256(
                    canonicalP6InboxJson(
                      projectionSnapshotEntries(projectionBefore),
                    ),
                  )
                )
                  return yield* Effect.fail({
                    _tag: "P39MaintenanceFailure",
                    code: "P39_MIGRATION_PREFIX_INVALID",
                  } as P39MaintenanceFailure);
                preparedProjectionBefore =
                  yield* inboxProjectionSnapshot(primary);
              }
              return true;
            }).pipe(
              Effect.mapError(
                (cause) =>
                  ({
                    _tag: "P39MaintenanceFailure",
                    code: "P39_MIGRATION_PREFIX_INVALID",
                    cause: {
                      _tag: "P6OperatorDiagnostic",
                      code: safeCauseCode(cause),
                    },
                  }) as P39MaintenanceFailure,
              ),
            ),
        },
      ),
    );
  } catch (cause) {
    if (cause instanceof P6InboxRebuildRefusal) throw cause;
    throw new P6InboxRebuildRefusal(
      `P6 rebuild failed at ${currentPhase} (${findSafeFailureCode(cause)})`,
    );
  }
};

const main = async (): Promise<void> => {
  if (process.argv.slice(2).some((arg) => arg === "--help" || arg === "-h")) {
    process.stdout.write(`${p6InboxRebuildUsage()}\n`);
    return;
  }
  try {
    await runP6InboxRebuild(
      parseP6InboxRebuildArguments(process.argv.slice(2)),
    );
    process.stdout.write("P6 Inbox projection rebuild committed.\n");
  } catch (cause) {
    if (cause instanceof P6InboxRebuildRefusal) {
      process.stderr.write(`${cause.message}\n`);
      process.exitCode = 1;
      return;
    }
    const outerCode =
      typeof cause === "object" && cause !== null && "code" in cause
        ? String((cause as { code?: unknown }).code)
        : "P6_REBUILD_FAILED";
    const nestedCause =
      typeof cause === "object" && cause !== null && "cause" in cause
        ? (cause as { cause?: unknown }).cause
        : undefined;
    const diagnosticCode =
      typeof nestedCause === "object" &&
      nestedCause !== null &&
      "code" in nestedCause
        ? String((nestedCause as { code?: unknown }).code)
        : "P6_REBUILD_FAILED";
    const reasonCode =
      typeof nestedCause === "object" &&
      nestedCause !== null &&
      "reasonCode" in nestedCause
        ? String((nestedCause as { reasonCode?: unknown }).reasonCode)
        : "unspecified";
    process.stderr.write(
      `P6 Inbox rebuild refused or failed (${outerCode}/${diagnosticCode}/${reasonCode}).\n`,
    );
    process.exitCode = 1;
  }
};

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
)
  void main();
