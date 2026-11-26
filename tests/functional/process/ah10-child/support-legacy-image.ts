import { createHash } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  makeP39PrivateTestDirectory,
  removeP39PrivateTestDirectory,
} from "../../../support/p39-windows-deployment-test.js";
import {
  copySchema44RowsIntoP38Seed,
  createP32HistoricalTestImage,
  createSchema42TestDatabase,
  createSchema44TestDatabase,
} from "../../../support/schema44-database.js";

export const schemaSnapshot = (db: DatabaseSync) => {
  const objects = db
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%'
          AND name <> 'projection_state'
        ORDER BY type, name`,
    )
    .all();
  const tableNames = (objects as Array<{ type: string; name: string }>)
    .filter((object) => object.type === "table")
    .map((object) => object.name);
  return {
    objects,
    tableInfo: tableNames.map((tableName) => ({
      tableName,
      columns: db.prepare(`PRAGMA table_info("${tableName}")`).all(),
    })),
    indexes: tableNames.map((tableName) => ({
      tableName,
      indexes: db.prepare(`PRAGMA index_list("${tableName}")`).all(),
    })),
    foreignKeys: tableNames.map((tableName) => ({
      tableName,
      foreignKeys: db.prepare(`PRAGMA foreign_key_list("${tableName}")`).all(),
    })),
  };
};

/**
 * Build a disposable frozen-v44 image from the real current-v57 fixture.
 * The destination's schema is produced only by the trusted migration chain;
 * its table/column contract drives this explicit projection. In particular,
 * this does not lower user_version or infer a column intersection. P45 inbox
 * rows are projected to the seven frozen v44 fields (P45 will rebuild them),
 * P46 verification snapshot columns are omitted (they do not exist in v44),
 * P49 grant-provenance columns are omitted while the pre-P49 grant values are
 * retained, and the P52 Work revision ledger is explicitly excluded because
 * it has no schema-44 representation.
 */
const projectCurrentSchemaIntoSchema44Image = (
  sourceFilename: string,
  targetFilename: string,
  committedCommandId: string,
): void => {
  const source = new DatabaseSync(sourceFilename, { readOnly: true });
  const target = new DatabaseSync(targetFilename);
  try {
    const sourceVersion = Number(
      (source.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    );
    const targetVersion = Number(
      (target.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    );
    if (sourceVersion !== 57 || targetVersion !== 44) {
      throw new Error(
        `Legacy projection requires exact schema 57 -> 44; got ${sourceVersion} -> ${targetVersion}`,
      );
    }

    const sourceP52Ledger = source
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='work_contract_revisions'",
      )
      .get();
    const targetP52Ledger = target
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='work_contract_revisions'",
      )
      .get();
    if (sourceP52Ledger === undefined || targetP52Ledger !== undefined) {
      throw new Error(
        "P52 history must be present in the current schema source and absent from the schema-44 projection",
      );
    }

    target.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
    try {
      const tables = target
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
        )
        .all() as Array<{ name: string }>;
      const sourceTables = new Set(
        (
          source
            .prepare(
              `SELECT name FROM sqlite_master
               WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
            )
            .all() as Array<{ name: string }>
        ).map(({ name }) => name),
      );
      for (const { name } of tables) {
        if (!sourceTables.has(name)) continue;
        const columns = target
          .prepare(`PRAGMA table_info("${name.replaceAll('"', '""')}")`)
          .all() as Array<{ name: string }>;
        if (columns.length === 0) continue;
        // This exact v44 destination column list intentionally acts as the
        // audited projection; selecting a generic source/target intersection
        // would silently reinterpret migration-added fields.
        const names = columns.map(({ name: column }) => column);
        const quotedColumns = names
          .map((column) => `"${column.replaceAll('"', '""')}"`)
          .join(", ");
        const quotedTable = `"${name.replaceAll('"', '""')}"`;
        const rows = source
          .prepare(`SELECT ${quotedColumns} FROM ${quotedTable}`)
          .all() as Array<Record<string, unknown>>;
        if (rows.length === 0) continue;
        if (name === "p10_attention_dispatch_state") {
          const existing = target
            .prepare("SELECT singleton FROM p10_attention_dispatch_state")
            .all() as Array<{ singleton: number }>;
          if (
            names.length < 2 ||
            existing.length !== 1 ||
            rows.length !== 1 ||
            existing[0]?.singleton !== 1 ||
            rows[0]?.singleton !== 1
          ) {
            throw new Error("v44 P10 singleton projection was not exact");
          }
          const mutable = names.filter((column) => column !== "singleton");
          const update = target.prepare(
            `UPDATE ${quotedTable} SET ${mutable
              .map((column) => `"${column}" = ?`)
              .join(", ")} WHERE singleton = 1`,
          );
          if (
            Number(
              update.run(
                ...(mutable.map((column) => rows[0]?.[column]) as Parameters<
                  typeof update.run
                >),
              ).changes,
            ) !== 1
          ) {
            throw new Error("v44 P10 singleton projection updated no row");
          }
          continue;
        }
        const placeholders = names.map(() => "?").join(", ");
        const insert = target.prepare(
          `INSERT INTO ${quotedTable} (${quotedColumns}) VALUES (${placeholders})`,
        );
        for (const row of rows) {
          insert.run(
            ...(names.map((column) => row[column]) as Parameters<
              typeof insert.run
            >),
          );
        }
      }
      const committed = target
        .prepare(
          `SELECT resolution, result_json FROM commands WHERE command_id = ?`,
        )
        .get(committedCommandId) as
        | { resolution: string; result_json: string | null }
        | undefined;
      if (
        committed?.resolution !== "Committed" ||
        committed.result_json === null
      ) {
        throw new Error("v44 projection omitted the exact committed receipt");
      }
      const bindingCount = Number(
        (
          target
            .prepare(
              "SELECT COUNT(*) AS count FROM assign_work_target_bindings WHERE command_id = ?",
            )
            .get(committedCommandId) as { count: number }
        ).count,
      );
      if (bindingCount !== 1) {
        throw new Error("v44 projection omitted the exact binding row");
      }
      const violations = target
        .prepare("PRAGMA foreign_key_check")
        .all() as Array<Record<string, unknown>>;
      if (violations.length !== 0) {
        throw new Error(
          `v44 projection has foreign-key violations: ${JSON.stringify(violations.slice(0, 8))}`,
        );
      }
      target.exec("COMMIT");
    } catch (error) {
      if (target.isTransaction) target.exec("ROLLBACK");
      throw error;
    }
    const integrity = target.prepare("PRAGMA integrity_check").all() as Array<{
      integrity_check: string;
    }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new Error(
        `v44 projection integrity check failed: ${JSON.stringify(integrity)}`,
      );
    }
  } finally {
    target.close();
    source.close();
  }
};

const qualifyLegacyP39ShortPaths = (input: {
  readonly root: string;
  readonly databaseFilename: string;
  readonly p39ReportFilename: string;
}) => {
  const root = resolve(input.root);
  const cwd = resolve(process.cwd());
  const systemTemp = resolve(tmpdir());
  const rootInfo = lstatSync(root);
  const rootReal = realpathSync.native(root);
  const cwdReal = realpathSync.native(cwd);
  const normalize = (value: string) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  const relativeToCwd = relative(cwd, root);
  const relativeToSystemTemp = relative(systemTemp, root);
  const directCwdChild =
    relativeToCwd !== "" &&
    relativeToCwd !== ".." &&
    !relativeToCwd.startsWith("..\\") &&
    !relativeToCwd.startsWith("../") &&
    !relativeToCwd.includes("\\") &&
    !relativeToCwd.includes("/");
  const outsideSystemTemp =
    relativeToSystemTemp === ".." ||
    relativeToSystemTemp.startsWith("..\\") ||
    relativeToSystemTemp.startsWith("../") ||
    /^[a-z]:/iu.test(relativeToSystemTemp) ||
    relativeToSystemTemp.startsWith("\\\\");
  const underRoot = (filename: string) => {
    const rel = relative(root, resolve(filename));
    return (
      rel !== "" &&
      rel !== ".." &&
      !rel.startsWith(`..\\`) &&
      !rel.startsWith(`../`)
    );
  };
  if (
    rootInfo.isSymbolicLink() ||
    !rootInfo.isDirectory() ||
    !directCwdChild ||
    !outsideSystemTemp ||
    normalize(cwdReal) !== normalize(cwd) ||
    normalize(rootReal) !== normalize(root) ||
    !underRoot(input.databaseFilename) ||
    !underRoot(input.p39ReportFilename)
  ) {
    throw new Error(
      `P39 short-path root must be a private non-reparse direct repository child outside system temp: ${JSON.stringify({ root, cwd, cwdReal, systemTemp, rootReal, databaseFilename: input.databaseFilename, p39ReportFilename: input.p39ReportFilename })}`,
    );
  }
  const databaseInfo = statSync(input.databaseFilename, { bigint: true });
  const lockIdentity = createHash("sha256")
    .update(`${databaseInfo.dev}:${databaseInfo.ino}`)
    .digest("hex");
  const lockFilename = join(
    dirname(input.databaseFilename),
    `.arbor-p39-writer-${lockIdentity}.sqlite`,
  );
  if (lstatSync(input.databaseFilename).isSymbolicLink()) {
    throw new Error(
      `P39 primary database is a reparse point: ${input.databaseFilename}`,
    );
  }
  const paths = {
    primary: resolve(input.databaseFilename),
    primaryJournal: `${resolve(input.databaseFilename)}-journal`,
    p39Report: resolve(input.p39ReportFilename),
    p39Lock: resolve(lockFilename),
    p39LockJournal: `${resolve(lockFilename)}-journal`,
  };
  const pathLengths = Object.fromEntries(
    Object.entries(paths).map(([name, filename]) => [name, filename.length]),
  );
  console.info(
    `[AH10 legacy P39 path qualification] ${JSON.stringify({ root, rootReal, directCwdChild: relativeToCwd, outsideSystemTemp, pathLengths, paths })}`,
  );
  if (paths.primary === paths.p39Report || paths.primary === paths.p39Lock) {
    throw new Error(
      `P39 primary/report/lock paths alias: ${JSON.stringify({ root, rootReal, pathLengths, paths })}`,
    );
  }
  for (const filename of Object.values(paths)) {
    if (!underRoot(filename) || filename.length > 240) {
      throw new Error(
        `P39 legacy path is outside its short private root or exceeds the 240-character budget: ${JSON.stringify({ root, rootReal, pathLengths, paths })}`,
      );
    }
  }
};

export const makePreBindingP32Copy = async (
  currentSource: string,
  target: string,
  priorCommittedCommandId: string,
): Promise<string> => {
  const shortTempRoot = makeP39PrivateTestDirectory(process.cwd(), ".arb-p39-");
  try {
    const schema44 = await createSchema44TestDatabase({
      parentDirectory: shortTempRoot,
      prefix: "v44-",
      beforeP39Maintenance: (paths) =>
        qualifyLegacyP39ShortPaths({ root: shortTempRoot, ...paths }),
    });
    try {
      projectCurrentSchemaIntoSchema44Image(
        currentSource,
        schema44.databaseFilename,
        priorCommittedCommandId,
      );
      const schema42 = await createSchema42TestDatabase({
        parentDirectory: shortTempRoot,
        prefix: "v42-",
        beforeP39Maintenance: (paths) =>
          qualifyLegacyP39ShortPaths({ root: shortTempRoot, ...paths }),
        seedP38: (p38Filename) =>
          copySchema44RowsIntoP38Seed(schema44.databaseFilename, p38Filename),
      });
      try {
        const schema42Db = new DatabaseSync(schema42.databaseFilename, {
          readOnly: true,
        });
        try {
          const version = Number(
            (
              schema42Db.prepare("PRAGMA user_version").get() as {
                user_version: number;
              }
            ).user_version,
          );
          if (version !== 42) {
            throw new Error(
              `P32 historical source must be a real schema-42 fixture; got ${version}`,
            );
          }
          const committed = schema42Db
            .prepare("SELECT resolution FROM commands WHERE command_id = ?")
            .get(priorCommittedCommandId) as { resolution: string } | undefined;
          if (committed?.resolution !== "Committed") {
            throw new Error(
              "schema-42 source omitted the exact committed AssignWork receipt",
            );
          }
          const bindings = schema42Db
            .prepare(
              "SELECT command_id FROM assign_work_target_bindings WHERE command_id = ?",
            )
            .all(priorCommittedCommandId);
          if (bindings.length !== 1) {
            throw new Error(
              "schema-42 source omitted the exact AssignWork binding row",
            );
          }
        } finally {
          schema42Db.close();
        }
        await createP32HistoricalTestImage({
          sourceFilename: schema42.databaseFilename,
          targetFilename: target,
        });
      } finally {
        schema42.cleanup();
      }
    } finally {
      schema44.cleanup();
    }
  } finally {
    removeP39PrivateTestDirectory(shortTempRoot);
  }

  const p32Db = new DatabaseSync(target, { readOnly: true });
  try {
    const version = Number(
      (p32Db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    );
    if (version !== 32) {
      throw new Error(`P32 historical copy ended at user_version ${version}`);
    }
    const committed = p32Db
      .prepare("SELECT resolution FROM commands WHERE command_id = ?")
      .get(priorCommittedCommandId) as { resolution: string } | undefined;
    if (committed?.resolution !== "Committed") {
      throw new Error(
        "P32 copy omitted the exact committed AssignWork receipt",
      );
    }
    const bindingTable = p32Db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'assign_work_target_bindings'",
      )
      .all();
    if (bindingTable.length !== 0) {
      throw new Error(
        "P32 pre-binding copy unexpectedly contains binding table",
      );
    }
  } finally {
    p32Db.close();
  }
  return target;
};
