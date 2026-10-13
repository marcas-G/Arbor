import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  P39_MAINTENANCE_MIGRATION_MANIFEST,
  P39_REPORT_APPLICATION_ID,
  P39_REPORT_USER_VERSION,
  validateP39ProtectedDirectory,
  validateP39ProtectedFile,
} from "@arbor/persistence-sqlite";

export type SchemaUpgradeMode = "fresh" | "copy" | "resume-copy";

export interface SchemaUpgradeFileIdentity {
  readonly device: string;
  readonly fileId: string;
}

export interface SchemaUpgradePathIdentity {
  readonly canonicalPath: string;
  readonly file: SchemaUpgradeFileIdentity;
}

export interface SchemaUpgradeManifestHeader {
  readonly kind: "Created";
  readonly schema: "arbor-schema-upgrade-manifest/v1";
  readonly nonce: string;
  readonly mode: "fresh" | "copy";
  readonly target: SchemaUpgradePathIdentity;
  readonly source: SchemaUpgradePathIdentity | null;
  readonly sourceUserVersion: number | null;
  readonly sourceDigest: string | null;
  readonly backupCompleted: boolean;
  readonly initialUserVersion: number;
  readonly initialPrefixSignature: string;
  readonly initialTargetDigest: string;
  readonly report: SchemaUpgradePathIdentity;
  readonly manifest: SchemaUpgradePathIdentity;
  readonly createdAt: string;
}

export interface SchemaUpgradeManifestEnvelope {
  readonly sequence: number;
  readonly previousHash: string | null;
  readonly record: Readonly<Record<string, unknown>>;
  readonly hash: string;
}

export interface SchemaUpgradeManifest {
  readonly filename: string;
  readonly identity: SchemaUpgradePathIdentity;
  readonly nonce: string;
  readonly header: SchemaUpgradeManifestHeader;
  readonly records: ReadonlyArray<SchemaUpgradeManifestEnvelope>;
}

export class SchemaUpgradeRefusal extends Error {
  readonly _tag = "SchemaUpgradeRefusal";
}

const refuse = (message: string): never => {
  throw new SchemaUpgradeRefusal(message);
};

const digestBytes = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

const normalizePath = (path: string): string => {
  const normalized = path.replace(/^\\\\\?\\/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

const rejectReparseComponents = (path: string): void => {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const parts = absolute.slice(root.length).split(/[\\/]/u).filter(Boolean);
  let current = root;
  if (!existsSync(current)) refuse(`path root is unavailable: ${path}`);
  for (const part of parts) {
    current = join(current, part);
    if (!existsSync(current)) continue;
    let stat: ReturnType<typeof lstatSync> | undefined;
    try {
      stat = lstatSync(current);
    } catch {
      refuse(`could not inspect path component: ${current}`);
    }
    const componentStat =
      stat ?? refuse(`could not inspect path component: ${current}`);
    if (componentStat.isSymbolicLink())
      refuse(`reparse path component is refused: ${current}`);
  }
};

export const canonicalExistingPath = (input: string): string => {
  if (!isAbsolute(input) || input.startsWith("file:")) {
    refuse("database and evidence paths must be absolute filesystem paths");
  }
  rejectReparseComponents(input);
  const canonical = realpathSync.native(input);
  if (normalizePath(resolve(input)) !== normalizePath(canonical)) {
    refuse(`non-canonical path is refused: ${input}`);
  }
  return canonical;
};

export const canonicalNewPath = (input: string): string => {
  if (!isAbsolute(input) || input.startsWith("file:")) {
    refuse("new artifact paths must be absolute filesystem paths");
  }
  const resolved = resolve(input);
  rejectReparseComponents(dirname(resolved));
  if (existsSync(resolved)) refuse(`new artifact already exists: ${input}`);
  const parent = realpathSync.native(dirname(resolved));
  if (normalizePath(parent) !== normalizePath(dirname(resolved))) {
    refuse(`new artifact parent is not canonical: ${input}`);
  }
  if (!validateP39ProtectedDirectory(parent)) {
    refuse(
      `new artifact parent does not meet the P39 owner/ACL profile: ${parent}`,
    );
  }
  return join(parent, basename(resolved));
};

export const reserveNewFile = (filename: string): SchemaUpgradePathIdentity => {
  try {
    const descriptor = openSync(filename, "wx", 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
  } catch (cause) {
    refuse(`exclusive artifact creation failed: ${String(cause)}`);
  }
  return existingPathIdentity(filename);
};

export const existingPathIdentity = (
  input: string,
): SchemaUpgradePathIdentity => {
  const canonicalPath = canonicalExistingPath(input);
  const stat = statSync(canonicalPath, { bigint: true });
  if (
    !stat.isFile() ||
    stat.dev === 0n ||
    stat.ino === 0n ||
    stat.nlink !== 1n ||
    !validateP39ProtectedDirectory(dirname(canonicalPath)) ||
    !validateP39ProtectedFile(canonicalPath)
  ) {
    refuse(`file identity/owner/ACL validation failed: ${input}`);
  }
  return {
    canonicalPath,
    file: { device: stat.dev.toString(), fileId: stat.ino.toString() },
  };
};

export const assertDistinctPaths = (
  values: ReadonlyArray<readonly [string, SchemaUpgradePathIdentity | null]>,
): void => {
  for (let left = 0; left < values.length; left += 1) {
    const [leftName, leftIdentity] = values[left] ?? ["", null];
    if (leftIdentity === null) continue;
    for (let right = left + 1; right < values.length; right += 1) {
      const [rightName, rightIdentity] = values[right] ?? ["", null];
      if (rightIdentity === null) continue;
      if (
        normalizePath(leftIdentity.canonicalPath) ===
          normalizePath(rightIdentity.canonicalPath) ||
        (leftIdentity.file.device === rightIdentity.file.device &&
          leftIdentity.file.fileId === rightIdentity.file.fileId)
      ) {
        refuse(`${leftName} and ${rightName} resolve to the same file`);
      }
    }
  }
};

const utf8 = (value: string): Uint8Array => Buffer.from(value, "utf8");
const u64 = (length: number): Uint8Array => {
  if (!Number.isSafeInteger(length) || length < 0)
    refuse("invalid digest frame length");
  const result = Buffer.alloc(8);
  result.writeBigUInt64BE(BigInt(length));
  return result;
};
const frame = (tag: string, payload: Uint8Array): Uint8Array =>
  Buffer.concat([
    u64(Buffer.byteLength(tag)),
    utf8(tag),
    u64(payload.byteLength),
    payload,
  ]);
const textFrame = (tag: string, value: string | null): Uint8Array =>
  value === null
    ? frame(`${tag}:null`, Buffer.alloc(0))
    : frame(tag, utf8(value));

type SqliteValue = null | number | bigint | string | Uint8Array;

const encodeValue = (value: SqliteValue): Uint8Array => {
  if (value === null) return frame("null", Buffer.alloc(0));
  if (typeof value === "bigint") {
    const bytes = Buffer.alloc(8);
    bytes.writeBigInt64BE(value);
    return frame("integer", bytes);
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) {
      refuse("SQLite REAL NaN has no stable binding representation");
    }
    if (!Number.isFinite(value)) {
      const bytes = Buffer.alloc(8);
      bytes.writeDoubleBE(value);
      return frame("real", bytes);
    }
    const bytes = Buffer.alloc(8);
    bytes.writeDoubleBE(value);
    return frame("real", bytes);
  }
  if (typeof value === "string") return frame("text", utf8(value));
  if (value instanceof Uint8Array) return frame("blob", value);
  return refuse("unsupported SQLite storage class in logical digest");
};

const quoteIdentifier = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;

const canonicalRows = (
  db: DatabaseSync,
  table: string,
): ReadonlyArray<Uint8Array> => {
  const tableInfo = db
    .prepare(`PRAGMA table_xinfo(${quoteIdentifier(table)})`)
    .all() as Array<{
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
    hidden: number;
  }>;
  if (tableInfo.some((column) => column.hidden !== 0)) {
    refuse(
      `generated/hidden columns are not supported by the logical digest: ${table}`,
    );
  }
  const columns = tableInfo.sort((a, b) => a.cid - b.cid);
  const primaryKey = columns
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk);
  const tableList = db.prepare("PRAGMA table_list").all() as Array<{
    name: string;
    wr: number;
    type: string;
  }>;
  const tableKind = tableList.find((entry) => entry.name === table);
  const canonicalTableKind =
    tableKind ??
    refuse(`table kind cannot be canonically identified: ${table}`);
  if (canonicalTableKind.type !== "table")
    refuse(`table kind cannot be canonically identified: ${table}`);
  const withoutRowid = canonicalTableKind.wr === 1;
  const reservedNames = new Set(columns.map(({ name }) => name.toLowerCase()));
  const makeAlias = (prefix: string): string => {
    let candidate = prefix;
    let suffix = 0;
    while (reservedNames.has(candidate.toLowerCase())) {
      suffix += 1;
      candidate = `${prefix}_${suffix}`;
    }
    reservedNames.add(candidate.toLowerCase());
    return candidate;
  };
  const textAliases = columns.map((column, index) => ({
    name: column.name,
    typeAlias: makeAlias(`__arbor_type_${index}__`),
    bytesAlias: makeAlias(`__arbor_text_bytes_${index}__`),
  }));
  let rowKey = "";
  let rowIdOutput = "__arbor_logical_rowid__";
  if (withoutRowid) {
    if (primaryKey.length === 0)
      refuse(`WITHOUT ROWID table has no primary key: ${table}`);
    rowKey = "without-rowid";
  } else {
    const names = new Set(columns.map(({ name }) => name.toLowerCase()));
    const rowidAlias =
      ["_rowid_", "rowid", "oid"].find((name) => !names.has(name)) ??
      refuse(`rowid cannot be read without column shadowing: ${table}`);
    rowKey = rowidAlias;
    rowIdOutput = makeAlias("__arbor_logical_rowid__");
  }
  const order = withoutRowid
    ? ` ORDER BY ${primaryKey.map(({ name }) => `${quoteIdentifier(name)} ASC`).join(",")}`
    : ` ORDER BY ${quoteIdentifier(rowKey)}`;
  const selectedValues = columns.flatMap((column, index) => {
    const aliases =
      textAliases[index] ??
      refuse(`column digest alias was not constructed: ${column.name}`);
    const quoted = quoteIdentifier(column.name);
    return [
      quoted,
      `typeof(${quoted}) AS ${quoteIdentifier(aliases.typeAlias)}`,
      `CASE WHEN typeof(${quoted}) = 'text' THEN hex(CAST(${quoted} AS BLOB)) END AS ${quoteIdentifier(aliases.bytesAlias)}`,
    ];
  });
  const select = withoutRowid
    ? selectedValues.join(",")
    : `${quoteIdentifier(rowKey)} AS ${quoteIdentifier(rowIdOutput)}${selectedValues.length === 0 ? "" : `,${selectedValues.join(",")}`}`;
  const statement = db.prepare(
    `SELECT ${select} FROM ${quoteIdentifier(table)}${order}`,
  );
  statement.setReadBigInts(true);
  const rows = statement.all() as Array<Record<string, SqliteValue>>;
  return rows.map((row) => {
    const encoded: Uint8Array[] = [frame(rowKey, Buffer.alloc(0))];
    if (!withoutRowid) {
      encoded.push(encodeValue(row[rowIdOutput] ?? null));
    }
    for (const column of columns) {
      const aliases =
        textAliases.find((entry) => entry.name === column.name) ??
        refuse(`column digest alias is missing: ${column.name}`);
      const storageClass = row[aliases.typeAlias];
      const value = row[column.name] ?? null;
      if (storageClass === "text") {
        const hexadecimal = row[aliases.bytesAlias];
        if (
          typeof value !== "string" ||
          typeof hexadecimal !== "string" ||
          hexadecimal.length % 2 !== 0
        ) {
          refuse(
            `SQLite TEXT bytes could not be read canonically: ${table}.${column.name}`,
          );
        }
        const bytes = Buffer.from(hexadecimal as string, "hex");
        if (bytes.toString("utf8") !== value)
          refuse(`SQLite TEXT is not canonical UTF-8: ${table}.${column.name}`);
        encoded.push(frame("text", bytes));
      } else {
        const expectedClass = storageClass;
        if (
          (expectedClass === "null" && value !== null) ||
          (expectedClass === "integer" && typeof value !== "bigint") ||
          (expectedClass === "real" && typeof value !== "number") ||
          (expectedClass === "blob" && !(value instanceof Uint8Array))
        )
          refuse(
            `SQLite storage class could not be distinguished canonically: ${table}.${column.name}`,
          );
        encoded.push(encodeValue(value));
      }
    }
    return Buffer.concat(encoded);
  });
};

/** Deterministic logical-state digest. It intentionally excludes page layout,
 * journal/WAL bytes and query-planner statistics while retaining SQLite value
 * types, row multiplicity, rowid order and AUTOINCREMENT sequence state. */
export const logicalSqliteDigest = (filename: string): string => {
  const db = new DatabaseSync(filename, {
    readOnly: true,
    enableForeignKeyConstraints: false,
  });
  try {
    db.exec("PRAGMA query_only = ON");
    const hash = createHash("sha256");
    const applicationId = db.prepare("PRAGMA application_id").get() as {
      application_id: number;
    };
    const userVersion = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    hash.update(encodeValue(BigInt(applicationId.application_id)));
    hash.update(encodeValue(BigInt(userVersion.user_version)));
    const schema = db
      .prepare(
        `SELECT type, name, tbl_name, sql FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_stat%' ORDER BY type COLLATE BINARY,
          name COLLATE BINARY, tbl_name COLLATE BINARY`,
      )
      .all() as Array<{
      type: string;
      name: string;
      tbl_name: string;
      sql: string | null;
    }>;
    for (const object of schema) {
      if (object.name === "sqlite_sequence") continue;
      if (
        object.name.startsWith("sqlite_") &&
        !object.name.startsWith("sqlite_autoindex_")
      ) {
        refuse(`unsupported SQLite internal schema object: ${object.name}`);
      }
      if (
        object.type === "table" &&
        /^\s*CREATE\s+VIRTUAL\s+TABLE\b/iu.test(object.sql ?? "")
      ) {
        refuse(`virtual table digest is unsupported: ${object.name}`);
      }
      hash.update(textFrame("schema-type", object.type));
      hash.update(textFrame("schema-name", object.name));
      hash.update(textFrame("schema-table", object.tbl_name));
      hash.update(textFrame("schema-sql", object.sql));
    }
    const tables = schema
      .filter(
        ({ type, name }) =>
          type === "table" &&
          name !== "sqlite_sequence" &&
          !name.startsWith("sqlite_stat"),
      )
      .map(({ name }) => name)
      .sort();
    for (const table of tables) {
      hash.update(textFrame("table", table));
      const columns = db
        .prepare(`PRAGMA table_xinfo(${quoteIdentifier(table)})`)
        .all() as Array<{
        cid: number;
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
        hidden: number;
      }>;
      for (const column of columns.sort((a, b) => a.cid - b.cid)) {
        hash.update(encodeValue(BigInt(column.cid)));
        hash.update(textFrame("column-name", column.name));
        hash.update(textFrame("column-type", column.type));
        hash.update(encodeValue(BigInt(column.notnull)));
        hash.update(textFrame("column-default", column.dflt_value));
        hash.update(encodeValue(BigInt(column.pk)));
      }
      for (const row of canonicalRows(db, table)) {
        hash.update(frame("row", row));
      }
    }
    const sequence = schema.some(
      ({ name, type }) => name === "sqlite_sequence" && type === "table",
    );
    if (sequence) {
      const sequenceStatement = db.prepare(
        "SELECT name, seq FROM sqlite_sequence ORDER BY name COLLATE BINARY",
      );
      sequenceStatement.setReadBigInts(true);
      const rows = sequenceStatement.all() as Array<{
        name: string;
        seq: bigint;
      }>;
      for (const row of rows) {
        hash.update(textFrame("sequence-name", row.name));
        hash.update(encodeValue(row.seq));
      }
    }
    return hash.digest("hex");
  } finally {
    db.close();
  }
};

export const readUserVersion = (filename: string): number => {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    return Number(
      (db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    );
  } finally {
    db.close();
  }
};

/** Exact schema-only signature for validating the versioned P36/P37/P38
 * source prefix against a disposable database bootstrapped from its trusted
 * descriptors. Planner statistics and physical page state are excluded. */
export const sqliteSchemaSignature = (filename: string): string => {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const applicationId = db.prepare("PRAGMA application_id").get() as {
      application_id: number;
    };
    const userVersion = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    const objects = db
      .prepare(
        `SELECT type,name,tbl_name,sql FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_stat%' ORDER BY type COLLATE BINARY,name COLLATE BINARY,tbl_name COLLATE BINARY`,
      )
      .all() as Array<{
      type: string;
      name: string;
      tbl_name: string;
      sql: string | null;
    }>;
    const tables = objects
      .filter(
        ({ type, name }) =>
          type === "table" &&
          name !== "sqlite_sequence" &&
          !name.startsWith("sqlite_stat"),
      )
      .map(({ name }) => name)
      .sort();
    const columnShape = tables.map((table) => ({
      table,
      columns: (
        db
          .prepare(`PRAGMA table_xinfo(${quoteIdentifier(table)})`)
          .all() as Array<{
          cid: number;
          name: string;
          type: string;
          notnull: number;
          dflt_value: string | null;
          pk: number;
          hidden: number;
        }>
      )
        .sort((left, right) => left.cid - right.cid)
        .map(({ cid, name, type, notnull, dflt_value, pk, hidden }) => ({
          cid,
          name,
          type,
          notnull,
          dflt_value,
          pk,
          hidden,
        })),
    }));
    return digestBytes(
      JSON.stringify({
        applicationId: Number(applicationId.application_id),
        userVersion: Number(userVersion.user_version),
        objects,
        columnShape,
      }),
    );
  } finally {
    db.close();
  }
};

export const prefixSignature = (
  filename: string,
  version: number,
  descriptorHashes: ReadonlyArray<string>,
): string =>
  prefixSignatureForDigest(
    version,
    descriptorHashes,
    logicalSqliteDigest(filename),
  );

export const prefixSignatureForDigest = (
  version: number,
  descriptorHashes: ReadonlyArray<string>,
  logicalDigest: string,
): string =>
  digestBytes(
    Buffer.concat([
      frame("version", encodeValue(version)),
      ...descriptorHashes.map((hash) => frame("descriptor-sha256", utf8(hash))),
      frame("logical-sqlite-digest", utf8(logicalDigest)),
    ]),
  );

const canonicalJson = (value: unknown): string => {
  if (value === undefined)
    refuse("undefined cannot be written to the provenance manifest");
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
};

const recordHash = (
  sequence: number,
  previousHash: string | null,
  record: Readonly<Record<string, unknown>>,
): string => digestBytes(canonicalJson({ sequence, previousHash, record }));

export const createSchemaUpgradeManifest = (
  filename: string,
  record: Omit<
    SchemaUpgradeManifestHeader,
    "manifest" | "nonce" | "kind" | "schema" | "createdAt"
  >,
): SchemaUpgradeManifest => {
  const identity = reserveNewFile(filename);
  const nonce = randomBytes(32).toString("hex");
  const header: SchemaUpgradeManifestHeader = {
    ...record,
    kind: "Created",
    schema: "arbor-schema-upgrade-manifest/v1",
    nonce,
    manifest: identity,
    createdAt: new Date().toISOString(),
  };
  const recordEntry = header as unknown as Readonly<Record<string, unknown>>;
  const body = { sequence: 0, previousHash: null, record: recordEntry };
  const envelope: SchemaUpgradeManifestEnvelope = {
    ...body,
    hash: recordHash(body.sequence, body.previousHash, recordEntry),
  };
  appendEnvelope(filename, identity, envelope);
  return {
    filename: identity.canonicalPath,
    identity,
    nonce,
    header,
    records: [envelope],
  };
};

export const readSchemaUpgradeManifest = (
  filename: string,
): SchemaUpgradeManifest => {
  const identity = existingPathIdentity(filename);
  const content = requireTextFile(identity.canonicalPath);
  const lines = content.split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length === 0) refuse("copy manifest is empty");
  const records: SchemaUpgradeManifestEnvelope[] = [];
  let previousHash: string | null = null;
  let nonce: string | undefined;
  for (const [sequence, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      refuse("copy manifest contains invalid JSON");
    }
    if (typeof parsed !== "object" || parsed === null)
      refuse("copy manifest record is invalid");
    const envelope = parsed as SchemaUpgradeManifestEnvelope;
    if (
      canonicalJson(envelope) !== line ||
      envelope.sequence !== sequence ||
      envelope.previousHash !== previousHash ||
      typeof envelope.record !== "object" ||
      envelope.record === null ||
      typeof envelope.hash !== "string" ||
      envelope.hash !== recordHash(sequence, previousHash, envelope.record)
    )
      refuse("copy manifest hash chain is invalid");
    if (sequence === 0) {
      const header = envelope.record as unknown as SchemaUpgradeManifestHeader;
      if (
        header.kind !== "Created" ||
        header.schema !== "arbor-schema-upgrade-manifest/v1" ||
        typeof header.nonce !== "string" ||
        !/^[0-9a-f]{64}$/u.test(header.nonce)
      )
        refuse("copy manifest header is invalid");
      nonce = header.nonce;
    } else if (envelope.record.nonce !== nonce) {
      refuse("copy manifest record nonce mismatch");
    }
    records.push(envelope);
    previousHash = envelope.hash;
  }
  const header = records[0]?.record as unknown as SchemaUpgradeManifestHeader;
  if (
    header === undefined ||
    header.kind !== "Created" ||
    header.schema !== "arbor-schema-upgrade-manifest/v1" ||
    (header.mode !== "copy" && header.mode !== "fresh") ||
    !/^[0-9a-f]{64}$/u.test(header.initialTargetDigest) ||
    !/^[0-9a-f]{64}$/u.test(header.initialPrefixSignature) ||
    header.target === undefined ||
    header.report === undefined ||
    header.manifest === undefined ||
    header.manifest.canonicalPath !== identity.canonicalPath ||
    header.manifest.file.device !== identity.file.device ||
    header.manifest.file.fileId !== identity.file.fileId
  )
    refuse("copy manifest file identity changed");
  return {
    filename: identity.canonicalPath,
    identity,
    nonce: nonce ?? "",
    header,
    records,
  };
};

export const appendSchemaUpgradeRecord = (
  manifest: SchemaUpgradeManifest,
  record: Readonly<Record<string, unknown>>,
): SchemaUpgradeManifest => {
  const identity = existingPathIdentity(manifest.filename);
  if (!sameIdentity(identity, manifest.identity))
    refuse("copy manifest identity changed before append");
  if (record.kind === "Created" || record.nonce !== undefined)
    refuse("reserved manifest record fields");
  const persisted = readSchemaUpgradeManifest(manifest.filename);
  if (
    persisted.records.length !== manifest.records.length ||
    persisted.records.at(-1)?.hash !== manifest.records.at(-1)?.hash
  )
    refuse("copy manifest head changed before append");
  const previous = manifest.records.at(-1);
  const sequence = manifest.records.length;
  const body = { ...record, nonce: manifest.nonce };
  const envelope: SchemaUpgradeManifestEnvelope = {
    sequence,
    previousHash: previous?.hash ?? null,
    record: body,
    hash: recordHash(sequence, previous?.hash ?? null, body),
  };
  appendEnvelope(manifest.filename, manifest.identity, envelope);
  return { ...manifest, records: [...manifest.records, envelope] };
};

const appendEnvelope = (
  filename: string,
  identity: SchemaUpgradePathIdentity,
  envelope: SchemaUpgradeManifestEnvelope,
): void => {
  const current = existingPathIdentity(filename);
  if (!sameIdentity(current, identity))
    refuse("manifest identity changed during append");
  const descriptor = openSync(filename, "a");
  try {
    writeSync(descriptor, `${canonicalJson(envelope)}\n`, undefined, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

const requireTextFile = (filename: string): string => {
  try {
    return readFileSync(filename, "utf8");
  } catch (cause) {
    return refuse(`could not read manifest: ${String(cause)}`);
  }
};

export const verifyP39ReportEvidence = (
  filename: string,
  expectedIdentity: SchemaUpgradePathIdentity,
): ReadonlyArray<{
  reportKey: string;
  contentHash: string;
  reportJson: string;
}> => {
  const identity = existingPathIdentity(filename);
  if (!sameIdentity(identity, expectedIdentity))
    refuse("P39 report file identity changed");
  const db = new DatabaseSync(identity.canonicalPath, { readOnly: true });
  try {
    const appId = Number(
      (db.prepare("PRAGMA application_id").get() as { application_id: number })
        .application_id,
    );
    const version = Number(
      (db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    );
    const journal = (
      db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }
    ).journal_mode.toLowerCase();
    if (
      appId !== P39_REPORT_APPLICATION_ID ||
      version !== P39_REPORT_USER_VERSION ||
      journal !== "wal"
    ) {
      refuse("P39 report database schema/durability identity is invalid");
    }
    const objects = db
      .prepare(
        "SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
      )
      .all() as Array<{ type: string; name: string; sql: string | null }>;
    const expectedNames = [
      "p39_migration_block_reports",
      "p39_report_no_delete",
      "p39_report_no_update",
    ].sort();
    if (
      objects.length !== expectedNames.length ||
      objects.some((object, index) => object.name !== expectedNames[index])
    ) {
      refuse("P39 report database object set is invalid");
    }
    const rows = db
      .prepare(
        "SELECT report_key,content_hash,report_json FROM p39_migration_block_reports ORDER BY report_key",
      )
      .all() as Array<{
      report_key: string;
      content_hash: string;
      report_json: string;
    }>;
    for (const row of rows) {
      if (digestBytes(row.report_json) !== row.content_hash)
        refuse("P39 report content hash mismatch");
      let body: unknown;
      try {
        body = JSON.parse(row.report_json);
      } catch {
        refuse("P39 report JSON is invalid");
      }
      if (typeof body !== "object" || body === null)
        refuse("P39 report body is invalid");
      const canonical = JSON.stringify(body);
      if (canonical !== row.report_json)
        refuse("P39 report JSON is not canonical");
      const report = body as Record<string, unknown>;
      if (
        report.schema !== "p39-migration-block-report/v1" ||
        report.targetUserVersion !== 39 ||
        report.kind !== "LegacyActiveNotAdmitted" ||
        ![36, 37, 38].includes(Number(report.observedUserVersion)) ||
        typeof report.databaseFingerprint !== "string" ||
        !/^[0-9a-f]{64}$/u.test(report.databaseFingerprint) ||
        typeof report.blockerStateFingerprint !== "string" ||
        !/^[0-9a-f]{64}$/u.test(report.blockerStateFingerprint) ||
        !Array.isArray(report.blockedInvocationIds) ||
        report.blockedInvocationIds.length === 0
      )
        refuse("P39 report body does not match the frozen report contract");
      const blockerIds = report.blockedInvocationIds as unknown[];
      const blockerStrings = blockerIds.filter(
        (id): id is string => typeof id === "string",
      );
      if (
        blockerStrings.length !== blockerIds.length ||
        blockerStrings.some((id) => id.trim().length === 0) ||
        blockerStrings.some(
          (id, index) => index > 0 && (blockerStrings[index - 1] ?? "") >= id,
        )
      )
        refuse("P39 report blocker identity order is invalid");
      const expectedKey = digestBytes(
        JSON.stringify({
          schema: "p39-migration-block-report/v1",
          targetUserVersion: 39,
          databaseFingerprint: report.databaseFingerprint,
        }),
      );
      if (expectedKey !== row.report_key) refuse("P39 report key mismatch");
    }
    return rows.map(({ report_key, content_hash, report_json }) => ({
      reportKey: report_key,
      contentHash: content_hash,
      reportJson: report_json,
    }));
  } finally {
    db.close();
  }
};

export const sameIdentity = (
  left: SchemaUpgradePathIdentity,
  right: SchemaUpgradePathIdentity,
): boolean =>
  normalizePath(left.canonicalPath) === normalizePath(right.canonicalPath) &&
  left.file.device === right.file.device &&
  left.file.fileId === right.file.fileId;

export const descriptorHashesThrough = (
  version: number,
): ReadonlyArray<string> => {
  const hashes: string[] = [];
  const pinned: Readonly<Record<number, string>> = {
    37: "0d23988891b3a19a36b6a836a9697d674667681dde2123be4dcae6659e39e737",
    38: "fa109e056d88c49dada808a7b0bcc9edce4595d1812990c0fa4facd0b248110d",
    39: "6e791168987f23f5c282ce7d6bd2c5b5ad8361942dab968adbcca64aab753aec",
    40: "3b06ee795277152a3e09a97679c4017b5c7ad3d1009f8cd14b04329a2be002aa",
    41: "d3ad9133ea28150a271c9867ae390c1f6ba0692f9e6b449817b8aeae2aa1dfed",
    42: "a0294a5db440e402a6c32b5a2b596502e059642431157eadcb6be7212224e5aa",
  };
  for (const id of [37, 38, 39, 40, 41, 42]) {
    if (id <= version) {
      const expected = pinned[id] ?? refuse(`descriptor ${id} is not pinned`);
      if (
        id <= 39 &&
        P39_MAINTENANCE_MIGRATION_MANIFEST[id]?.sha256 !== expected
      ) {
        refuse(`P39 descriptor ${id} differs from its pinned hash`);
      }
      hashes.push(expected);
    }
  }
  return hashes;
};

export const newNonce = (): string => randomBytes(32).toString("hex");
