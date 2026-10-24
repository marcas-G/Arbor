import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { newUuid7 } from "../../../packages/application/src/formation-plan.js";
import {
  makeP39PrivateTestDirectory,
  removeP39PrivateTestDirectory,
} from "../../support/p39-windows-deployment-test.js";
import {
  copySchema44RowsIntoP38Seed,
  createP32HistoricalTestImage,
  createP32MigrationBaseline,
  createSchema42TestDatabase,
  createSchema44TestDatabase,
  upgradeSchema44TestDatabase,
  upgradeSchema44ToCurrentTestDatabase,
} from "../../support/schema44-database.js";
import {
  expireExecutionLeaseAfterOwnerExitForQualification,
  type LiveOwnerLeasePauseEvidence,
  waitForLiveOwnerLeaseExpiryForQualification,
} from "../support/lease-qualification.js";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";
import {
  createFunctionalProject,
  type FunctionalProject,
  functionalId,
  makePublicClient,
  type PublicClient,
  proposeAndApproveChildWithInitialWork,
  proposeAndApproveChildWithoutWork,
  submitHumanMessage,
  waitForApproval,
  waitForPublic,
} from "../support/public-client.js";

interface Probe {
  readonly tag: "AH10_PROBE";
  readonly role: "old" | "new";
  readonly boundary: string;
  readonly executionId: string;
  readonly fencingGeneration?: number;
  readonly pauseRequested?: boolean;
  readonly workerId?: string;
  readonly workerIncarnationId?: string;
  readonly providerTurnId?: string;
  readonly logicalActionId?: string;
  readonly actionKind?: string;
  readonly callRef?: string;
  readonly actionIndex?: number;
  readonly commandId?: string;
  readonly committedCommandId?: string;
}

interface CommandRow {
  readonly command_id: string;
  readonly resolution: "Committed" | "TerminalRejected";
  readonly result_json: string | null;
  readonly terminal_error_json: string | null;
}

interface WorkRow {
  readonly work_id: string;
  readonly project_id: string;
  readonly workspace_id: string;
  readonly objective: string;
  readonly why: string;
  readonly constraints: string;
  readonly completion_expectation: string;
  readonly verification_mission: string;
  readonly provenance: string;
  readonly lifecycle: string;
  readonly revision: number;
}

interface WorkspaceLifecycleRow {
  readonly workspace_id: string;
  readonly lifecycle: string;
}

interface WorkAssignedEventRow {
  readonly event_id: string;
  readonly event_type: string;
  readonly aggregate_ref: string;
  readonly caused_by_command_id: string | null;
  readonly payload_json: string;
}

interface BindingRow {
  readonly command_id: string;
  readonly execution_id: string;
  readonly provider_turn_id: string;
  readonly logical_action_id: string;
  readonly call_ref: string;
  readonly parent_workspace_id: string;
  readonly parent_work_id: string;
  readonly target_workspace_ref: string;
  readonly target_workspace_id: string;
  readonly work_id: string;
  readonly authority_kind: string;
  readonly authority_evidence_json: string;
}

interface BindingAttentionRow {
  readonly attention_fact_id: string;
  readonly event_id: string;
  readonly execution_id: string;
  readonly target_workspace_id: string;
  readonly logical_action_id: string;
  readonly committed_command_id: string;
  readonly failure_code: string;
}

interface BindingAttentionEventRow {
  readonly event_id: string;
  readonly project_id: string;
  readonly aggregate_ref: string;
  readonly caused_by_command_id: string | null;
  readonly correlation_ref: string | null;
  readonly payload_json: string;
}

interface ControlResult {
  readonly _tag?: string;
  readonly actionKind?: string;
  readonly callRef?: string;
  readonly status?: string;
  readonly outputText?: string;
}

const fixtures: ProductionFixture[] = [];
const ah10Child = resolve("tests/functional/support/ah10-process-child.mjs");

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

const pushProbe = (events: Probe[], line: string) => {
  try {
    const event = JSON.parse(line) as Probe;
    if (event.tag === "AH10_PROBE") events.push(event);
  } catch {
    // Retain daemon output in the fixture for failure diagnostics.
  }
};

const approveWorkspaceFormation = async (
  client: PublicClient,
  project: FunctionalProject,
  parentWorkspaceId: string,
  marker: string,
  childName: string,
): Promise<{ readonly workspaceId: string; readonly name: string }> => {
  const inbox = await waitForPublic(
    () =>
      client.view<{
        unconsumed: Array<{ entryKey: string; kind: string; summary: string }>;
      }>("inbox-view", { workspaceId: parentWorkspaceId }),
    (value) =>
      value.unconsumed.some(
        (entry) =>
          entry.kind === "Governance" &&
          entry.summary.includes(marker) &&
          /^gov:fpr_[^:]+:\d+$/u.test(entry.entryKey),
      ),
  );
  const entry = inbox.unconsumed.find(
    (candidate) =>
      candidate.kind === "Governance" &&
      candidate.summary.includes(marker) &&
      /^gov:fpr_[^:]+:\d+$/u.test(candidate.entryKey),
  );
  const formation =
    entry === undefined
      ? null
      : /^gov:(fpr_[^:]+):(\d+)$/u.exec(entry.entryKey);
  if (formation === null) {
    throw new Error(
      `Parent Inbox exposed no exact FormationProposal for ${marker}`,
    );
  }
  const before = await client.view<{
    nodes: Array<{ parentWorkspaceId: string | null; name: string }>;
  }>("responsibility-tree", { projectId: project.projectId });
  expect(
    before.nodes.some(
      (node) =>
        node.parentWorkspaceId === parentWorkspaceId && node.name === childName,
    ),
  ).toBe(false);
  await client.command(project.projectId, "RecordDecision", {
    proposalId: formation[1],
    expectedProposalRevision: Number(formation[2]),
    outcome: { _tag: "Approve" },
  });
  const tree = await waitForPublic(
    () =>
      client.view<{
        nodes: Array<{
          workspaceId: string;
          parentWorkspaceId: string | null;
          name: string;
          currentWork?: { workId?: string };
        }>;
      }>("responsibility-tree", { projectId: project.projectId }),
    (value) =>
      value.nodes.some(
        (node) =>
          node.parentWorkspaceId === parentWorkspaceId &&
          node.name === childName &&
          node.currentWork === undefined,
      ),
  );
  const child = tree.nodes.find(
    (node) =>
      node.parentWorkspaceId === parentWorkspaceId && node.name === childName,
  );
  if (child === undefined || child.currentWork !== undefined) {
    throw new Error(
      `approved Formation unexpectedly lacks empty child ${childName}`,
    );
  }
  return { workspaceId: child.workspaceId, name: child.name };
};

const releaseGate = (
  fixture: ProductionFixture,
  role: "old" | "new",
  gate: string,
) => {
  writeFileSync(
    resolve(fixture.directory, "ah10-gates", `${role}-${gate}.release`),
    "release",
  );
};

const retargetBindingToSibling = (
  databaseFile: string,
  commandId: string,
  siblingWorkspaceId: string,
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    db.prepare(
      "UPDATE assign_work_target_bindings SET target_workspace_id = ? WHERE command_id = ?",
    ).run(siblingWorkspaceId, commandId);
  } finally {
    db.close();
  }
};

const removeBindingForLegacyFixture = (
  databaseFile: string,
  commandId: string,
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    db.prepare(
      "DELETE FROM assign_work_target_bindings WHERE command_id = ?",
    ).run(commandId);
  } finally {
    db.close();
  }
};

const retireTargetAfterCommit = (databaseFile: string, workspaceId: string) => {
  const db = new DatabaseSync(databaseFile);
  try {
    db.prepare(
      "UPDATE workspaces SET lifecycle = 'Retired', revision = revision + 1 WHERE workspace_id = ? AND lifecycle = 'Active'",
    ).run(workspaceId);
  } finally {
    db.close();
  }
};

const schemaSnapshot = (db: DatabaseSync) => {
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
 * Build a disposable frozen-v44 image from the real current-v51 fixture.
 * The destination's schema is produced only by the trusted migration chain;
 * its table/column contract drives this explicit projection. In particular,
 * this does not lower user_version or infer a column intersection. P45 inbox
 * rows are projected to the seven frozen v44 fields (P45 will rebuild them),
 * P46 verification snapshot columns are omitted (they do not exist in v44),
 * P49 grant-provenance columns are omitted while the pre-P49 grant values are
 * retained, and the P52 Work revision ledger is explicitly excluded because
 * it has no schema-44 representation.
 */
const projectSchema52IntoSchema44Image = (
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
    if (sourceVersion !== 52 || targetVersion !== 44) {
      throw new Error(
        `Legacy projection requires exact schema 52 -> 44; got ${sourceVersion} -> ${targetVersion}`,
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
        "P52 history must be present in the schema-52 source and absent from the schema-44 projection",
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

const makePreBindingP32Copy = async (
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
      projectSchema52IntoSchema44Image(
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

const readRows = (databaseFile: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return {
      schemaVersion: Number(
        (db.prepare("PRAGMA user_version").get() as { user_version: number })
          .user_version,
      ),
      leases: db
        .prepare(
          `SELECT execution_id, worker_id, worker_incarnation_id, generation,
                  expires_at FROM execution_leases`,
        )
        .all() as Array<{
        execution_id: string;
        worker_id: string;
        worker_incarnation_id: string;
        generation: number;
        expires_at: string;
      }>,
      commands: db
        .prepare(
          "SELECT command_id, resolution, result_json, terminal_error_json FROM commands",
        )
        .all() as unknown as CommandRow[],
      works: db
        .prepare(
          `SELECT work_id, project_id, workspace_id, objective, why,
                  constraints, completion_expectation, verification_mission,
                  provenance, lifecycle, revision
             FROM works ORDER BY created_at, work_id`,
        )
        .all() as unknown as WorkRow[],
      workspaceLifecycles: db
        .prepare(
          "SELECT workspace_id, lifecycle FROM workspaces ORDER BY workspace_id",
        )
        .all() as unknown as WorkspaceLifecycleRow[],
      workAssignedEvents: db
        .prepare(
          `SELECT event_id, event_type, aggregate_ref, caused_by_command_id,
                  payload_json
             FROM domain_events WHERE event_type = 'WorkAssigned'
            ORDER BY sequence`,
        )
        .all() as unknown as WorkAssignedEventRow[],
      assignWorkTargetBindings: db
        .prepare(
          `SELECT command_id, execution_id, provider_turn_id, logical_action_id,
                  call_ref, parent_workspace_id, parent_work_id,
                  target_workspace_ref, target_workspace_id, work_id,
                  authority_kind, authority_evidence_json
             FROM assign_work_target_bindings ORDER BY command_id`,
        )
        .all() as unknown as BindingRow[],
      bindingAttentionFacts: db
        .prepare(
          `SELECT attention_fact_id, event_id, execution_id, target_workspace_id,
                  logical_action_id, committed_command_id, failure_code
             FROM assign_work_binding_attention_facts ORDER BY attention_fact_id`,
        )
        .all() as unknown as BindingAttentionRow[],
      bindingAttentionEvents: db
        .prepare(
          `SELECT event_id, project_id, aggregate_ref, caused_by_command_id,
                  correlation_ref, payload_json
             FROM domain_events
            WHERE event_type = 'AssignWorkTargetBindingEscalated'
            ORDER BY sequence`,
        )
        .all() as unknown as BindingAttentionEventRow[],
      actions: db
        .prepare(
          `SELECT a.execution_id, s.provider_turn_id, a.logical_step_no,
                  a.repair_attempt, a.logical_action_id, a.action_index,
                  a.observation_source_ref, a.call_ref, a.action_kind, a.state
             FROM agent_loop_step_actions a
             JOIN agent_loop_steps s
               ON s.execution_id = a.execution_id
              AND s.logical_step_no = a.logical_step_no
              AND s.repair_attempt = a.repair_attempt
            ORDER BY a.action_index`,
        )
        .all() as Array<{
        execution_id: string;
        provider_turn_id: string;
        logical_step_no: number;
        repair_attempt: number;
        logical_action_id: string;
        action_index: number;
        observation_source_ref: string | null;
        call_ref: string;
        action_kind: string;
        state: string;
      }>,
      observations: db
        .prepare(
          `SELECT source_ref FROM session_entries
            WHERE source_kind = 'AgentLoopAction'
              AND entry_kind = 'Observation' ORDER BY sequence`,
        )
        .all() as Array<{ source_ref: string }>,
      controlResults: db
        .prepare(
          `SELECT source_ref, payload_json
             FROM session_entries WHERE item_type = 'ControlResult'
            ORDER BY sequence`,
        )
        .all() as Array<{ source_ref: string; payload_json: string }>,
      providerAttempts: db
        .prepare(
          `SELECT provider_turn_id, attempt_no, outcome, settled_at
             FROM provider_attempts ORDER BY provider_turn_id, attempt_no`,
        )
        .all() as Array<{
        provider_turn_id: string;
        attempt_no: number;
        outcome: string;
        settled_at: string | null;
      }>,
      permissionGrants: db
        .prepare(
          `SELECT permission_grant_id, subject_kind, subject_ref, capability,
                  target, state, expires_at
             FROM permission_grants ORDER BY permission_grant_id`,
        )
        .all() as Array<{
        permission_grant_id: string;
        subject_kind: string;
        subject_ref: string;
        capability: string;
        target: string | null;
        state: string;
        expires_at: string | null;
      }>,
      approvals: db
        .prepare(
          "SELECT approval_id, target_ref, state, revision, consumed_by, binding_proven FROM action_approvals ORDER BY approval_id",
        )
        .all() as Array<{
        approval_id: string;
        target_ref: string;
        state: string;
        revision: number;
        consumed_by: string | null;
        binding_proven: number;
      }>,
    };
  } finally {
    db.close();
  }
};

const fencedReceipts = (rows: ReturnType<typeof readRows>) =>
  rows.commands.filter(
    (command) =>
      command.resolution === "TerminalRejected" &&
      command.terminal_error_json?.includes("FencingRejected"),
  );

const targetWorks = (rows: ReturnType<typeof readRows>, objective: string) =>
  rows.works.filter((work) => work.objective === objective);

const parseWorkspacesResult = (row: { payload_json: string }) => {
  const result = JSON.parse(row.payload_json) as ControlResult;
  if (
    result._tag !== "ControlResult" ||
    result.actionKind !== "list_workspaces" ||
    result.status !== "Succeeded" ||
    typeof result.outputText !== "string"
  ) {
    throw new Error(
      `list_workspaces did not persist a successful ControlResult: ${row.payload_json}`,
    );
  }
  return JSON.parse(result.outputText) as {
    directChildren?: Array<{ ref: string; name: string }>;
  };
};

describe("AH10 direct-child AssignWork generation takeover", () => {
  it.each([
    "committed",
    "corrupt-sibling",
    "binding-before",
    "approval-committed",
    "approval-fencing-before",
    "legacy-p32-upgrade",
    "legacy-unbound",
    "retired-after-commit",
    "grant-revoked-after-commit",
    "non-root-parent",
    "attention-before",
    "attention-after",
    "corrupt-result-before",
    "corrupt-result-after",
    "wrong-shape-result",
  ] as const)(
    "takes over direct-child AssignWork after gen0 %s its command boundary",
    async (rawCrashSide) => {
      const crashSide = rawCrashSide as
        | "before"
        | "after"
        | "committed"
        | "corrupt-sibling"
        | "binding-before"
        | "approval-committed"
        | "approval-fencing-before"
        | "legacy-p32-upgrade"
        | "legacy-unbound"
        | "retired-after-commit"
        | "grant-revoked-after-commit"
        | "non-root-parent"
        | "attention-before"
        | "attention-after"
        | "corrupt-result-before"
        | "corrupt-result-after"
        | "wrong-shape-result";
      const marker = `AH10-direct-child-${crypto.randomUUID().slice(0, 8)}`;
      const childName = `child-${marker}`;
      const siblingName = `sibling-${crypto.randomUUID().slice(0, 8)}`;
      const nonRootParent = crashSide === "non-root-parent";
      const corruptResult =
        crashSide === "corrupt-result-before" ||
        crashSide === "corrupt-result-after" ||
        crashSide === "wrong-shape-result";
      const attentionBefore =
        crashSide === "attention-before" ||
        crashSide === "corrupt-result-before";
      const attentionAfter =
        crashSide === "attention-after" || crashSide === "corrupt-result-after";
      const parentName = `parent-${marker}`;
      const sourceObjective = `Assign a bounded outcome to ${childName}.`;
      const targetObjective = `Direct-child Work for ${marker}.`;
      const targetWhy = `The existing child owns the responsibility for ${marker}.`;
      const targetReason = `The Parent Work delegates this bounded outcome to ${childName}.`;
      const constraints = [
        "Do not modify files owned by the Parent Workspace.",
        "Preserve the stated scope and do not add external side effects.",
      ];
      const mission = {
        goal: `Verify the bounded child outcome for ${marker}.`,
        criteria: [
          {
            criterionId: "direct-child-result",
            requirement: `the child Work records the requested result for ${marker}`,
            required: true,
          },
        ],
        riskRequirements: ["do not weaken either Work constraint"],
      };
      const events: Probe[] = [];
      const listWorkspaceCalls: number[] = [];
      const assignWorkCalls: number[] = [];
      const providerTrace: Array<{ index: number; tail: string }> = [];
      let listRequested = false;
      let targetWorkspaceRef: string | undefined;
      let parentSeedWaitIssued = false;
      let targetProposalIssued = false;
      let targetProposalApproved = false;
      let siblingProposalIssued = false;
      let siblingProposalApproved = false;

      const fixture = await startProductionFixture({
        isolatedPortHandshake: true,
        admitWorkspaceDirectory: true,
        reply: (call, index) => {
          const context = JSON.stringify(call.messages);
          providerTrace.push({ index, tail: context.slice(-1_000) });
          if (!context.includes(marker)) {
            return { _tag: "HttpError", status: 422 };
          }
          const available = new Set(
            call.tools
              .map((tool) => tool.function?.name)
              .filter((name): name is string => name !== undefined),
          );
          const latestUserIndex = call.messages.findLastIndex(
            (message) => message.role === "user",
          );
          const latestUser =
            latestUserIndex < 0
              ? undefined
              : call.messages[latestUserIndex]?.content;
          const proposalRecordedForLatestUser =
            latestUserIndex >= 0 &&
            call.messages
              .slice(latestUserIndex + 1)
              .some(
                (message) =>
                  message.role === "tool" &&
                  message.content?.includes("ProposalRecorded(") === true,
              );
          const proposalFor = (
            name: string,
            purpose: string,
            initialWork?: Readonly<Record<string, unknown>>,
          ) => ({
            _tag: "ToolCall" as const,
            name: "propose_workspace",
            arguments: {
              name,
              rationale: `formation fixture for ${marker}`,
              responsibilityDraft: {
                purpose,
                ownedResponsibilities: [marker],
                obligations: ["accept precisely scoped Work from the Parent"],
                includes: ["the named child outcome"],
                excludes: ["Parent Workspace files and external side effects"],
                interfaces: [
                  "Parent assigns Work through a scoped direct-child ref",
                ],
              },
              resourceBoundaryDraft: {
                addresses: [
                  { _tag: "FileTree", path: fixture.workspaceDirectory },
                ],
              },
              ...(initialWork === undefined ? {} : { initialWork }),
            },
          });

          if (
            available.has("propose_workspace") &&
            !available.has("claim_completion") &&
            latestUser?.includes(`Propose ${childName} for ${marker}`) === true
          ) {
            return proposalRecordedForLatestUser
              ? { _tag: "Text", text: `Proposed ${childName}` }
              : proposalFor(
                  childName,
                  `own the bounded responsibility for ${marker}`,
                );
          }
          if (
            available.has("propose_workspace") &&
            !available.has("claim_completion") &&
            latestUser?.includes(`Propose ${siblingName} for ${marker}`) ===
              true
          ) {
            return proposalRecordedForLatestUser
              ? { _tag: "Text", text: `Proposed ${siblingName}` }
              : proposalFor(
                  siblingName,
                  `own a separate sibling responsibility for ${marker}`,
                );
          }
          if (
            available.has("propose_workspace") &&
            !available.has("claim_completion") &&
            latestUser?.includes(`Propose ${parentName} for ${marker}`) === true
          ) {
            return proposalRecordedForLatestUser
              ? { _tag: "Text", text: `Proposed ${parentName}` }
              : proposalFor(parentName, `parent responsibility for ${marker}`, {
                  objective: sourceObjective,
                  why: "host the Parent WorkEpisode for direct-child assignment qualification",
                  constraints: [
                    "the resulting Work must target the listed direct child",
                  ],
                  completionExpectation:
                    "one exact child Work is assigned under the Parent",
                  verificationMission: {
                    goal: `Verify assignment to the existing child ${marker}`,
                    criteria: [
                      {
                        criterionId: "parent-assigned-child",
                        requirement:
                          "the Work is assigned to the exact listed child Workspace",
                        required: true,
                      },
                    ],
                    riskRequirements: [],
                  },
                });
          }
          if (
            available.has("claim_completion") &&
            nonRootParent &&
            context.includes(sourceObjective)
          ) {
            if (!targetProposalApproved) {
              if (!targetProposalIssued) {
                targetProposalIssued = true;
                return proposalFor(
                  childName,
                  `own the bounded responsibility for ${marker}`,
                );
              }
              return {
                _tag: "ToolCall",
                name: "wait",
                arguments: {
                  reason: `await exact Parent approval for ${childName}`,
                  waitSpec: {
                    mode: "Any",
                    conditions: [{ _tag: "Manual" }],
                  },
                },
              };
            }
            if (!siblingProposalApproved) {
              if (!siblingProposalIssued) {
                siblingProposalIssued = true;
                return proposalFor(
                  siblingName,
                  `own a separate sibling responsibility for ${marker}`,
                );
              }
              return {
                _tag: "ToolCall",
                name: "wait",
                arguments: {
                  reason: `await exact Parent approval for ${siblingName}`,
                  waitSpec: {
                    mode: "Any",
                    conditions: [{ _tag: "Manual" }],
                  },
                },
              };
            }
          }
          if (
            available.has("claim_completion") &&
            context.includes(sourceObjective) &&
            !parentSeedWaitIssued
          ) {
            parentSeedWaitIssued = true;
            return {
              _tag: "ToolCall",
              name: "wait",
              arguments: {
                reason:
                  "hold the seeded Parent Work until AH10 probes are enabled",
                waitSpec: {
                  mode: "Any",
                  conditions: [{ _tag: "Manual" }],
                },
              },
            };
          }
          if (
            !available.has("claim_completion") &&
            !nonRootParent &&
            latestUser?.includes(`Create Parent Work ${sourceObjective}`) ===
              true
          ) {
            return context.includes("WorkAssigned(")
              ? { _tag: "Text", text: `Parent Work assigned for ${marker}` }
              : {
                  _tag: "ToolCall",
                  name: "assign_work",
                  arguments: {
                    objective: sourceObjective,
                    why: "host the Parent WorkEpisode for direct-child assignment qualification",
                    constraints: [
                      "the resulting Work must target the listed direct child",
                    ],
                    completionExpectation:
                      "one exact child Work is assigned under the Parent",
                    verificationMission: {
                      goal: `Verify assignment to the existing child ${marker}`,
                      criteria: [
                        {
                          criterionId: "parent-assigned-child",
                          requirement:
                            "the Work is assigned to the exact listed child Workspace",
                          required: true,
                        },
                      ],
                      riskRequirements: [],
                    },
                    reason: "AH10 process fixture",
                  },
                };
          }
          if (assignWorkCalls.length > 0 && context.includes("WorkAssigned(")) {
            return {
              _tag: "Text",
              text: `The child Work is assigned for ${marker}.`,
            };
          }
          if (!listRequested) {
            if (!available.has("list_workspaces")) {
              return { _tag: "HttpError", status: 422 };
            }
            listRequested = true;
            listWorkspaceCalls.push(index);
            return {
              _tag: "ToolCall",
              name: "list_workspaces",
              arguments: { query: marker },
            };
          }
          const ref = /wref_[a-f0-9]{64}/u.exec(context)?.[0];
          if (ref === undefined || !available.has("assign_work")) {
            return { _tag: "HttpError", status: 422 };
          }
          targetWorkspaceRef = ref;
          assignWorkCalls.push(index);
          return {
            _tag: "ToolCall",
            name: "assign_work",
            arguments: {
              targetWorkspaceRef: ref,
              objective: targetObjective,
              why: targetWhy,
              constraints,
              completionExpectation: `the direct child owns a verified outcome for ${marker}`,
              verificationMission: mission,
              reason: targetReason,
            },
          };
        },
        onDaemonStdout: (line) => pushProbe(events, line),
      });
      fixtures.push(fixture);
      let recoveryDatabaseFile = fixture.databaseFile;
      mkdirSync(resolve(fixture.directory, "ah10-gates"), { recursive: true });

      const client = makePublicClient(fixture.baseUrl);
      const project = await createFunctionalProject(
        client,
        fixture.workspaceDirectory,
        `AH10 direct-child AssignWork ${marker}`,
        {
          resourceSelection: "Profile",
          rootWorkspacePolicy: {
            controlApprovalPolicy: {
              "core.control.assign-work": "Ask",
            },
          },
        },
      );
      let assignmentParentWorkspaceId = project.rootWorkspaceId;
      let childWorkspaceId = "";
      let siblingWorkspaceId = "";
      let parentWorkId = "";
      const childDirectory = fixture.workspaceDirectory;
      if (nonRootParent) {
        const parent = await proposeAndApproveChildWithInitialWork(
          client,
          project,
          marker,
          `Propose ${parentName} for ${marker}`,
          {
            name: parentName,
            rationale:
              "form the Parent responsibility for nested direct-child qualification",
            responsibilityDraft: {
              purpose: `parent responsibility for ${marker}`,
              ownedResponsibilities: [`parent-${marker}`],
              obligations: ["assign bounded child Work"],
              includes: ["the direct child assignment fixture"],
              excludes: ["unrelated root responsibilities"],
              interfaces: [
                "one direct child is assigned through PlacementContext",
              ],
            },
            resourceBoundaryDraft: {
              addresses: [
                { _tag: "FileTree", path: fixture.workspaceDirectory },
              ],
            },
            initialWork: {
              objective: sourceObjective,
              why: "host the Parent WorkEpisode for direct-child assignment qualification",
              constraints: [
                "the resulting Work must target the listed direct child",
              ],
              completionExpectation:
                "one exact child Work is assigned under the Parent",
              verificationMission: {
                goal: `Verify assignment to the existing child ${marker}`,
                criteria: [
                  {
                    criterionId: "parent-assigned-child",
                    requirement:
                      "the Work is assigned to the exact listed child Workspace",
                    required: true,
                  },
                ],
                riskRequirements: [],
              },
            },
          },
        );
        assignmentParentWorkspaceId = parent.workspaceId;
        parentWorkId = parent.currentWork.workId;
        expect(parent.currentWork.objective).toBe(sourceObjective);
      } else {
        const child = await proposeAndApproveChildWithoutWork(
          client,
          project,
          marker,
          `Propose ${childName} for ${marker}`,
          {
            name: childName,
            rationale: "form the target responsibility for AH10 qualification",
            responsibilityDraft: {
              purpose: `own the bounded responsibility for ${marker}`,
              ownedResponsibilities: [marker],
              obligations: ["accept precisely scoped Work from the Parent"],
              includes: ["the named child outcome"],
              excludes: ["Parent Workspace files and external side effects"],
              interfaces: [
                "Parent assigns Work through a scoped direct-child ref",
              ],
            },
            resourceBoundaryDraft: {
              addresses: [{ _tag: "FileTree", path: childDirectory }],
            },
          },
        );
        childWorkspaceId = child.workspaceId;
        const sibling = await proposeAndApproveChildWithoutWork(
          client,
          project,
          siblingName,
          `Propose ${siblingName} for ${marker}`,
          {
            name: siblingName,
            rationale:
              "form a distinct sibling for target binding qualification",
            responsibilityDraft: {
              purpose: `own a separate sibling responsibility for ${marker}`,
              ownedResponsibilities: [`sibling-${marker}`],
              obligations: ["remain distinct from the assigned child"],
              includes: ["sibling-only scope"],
              excludes: ["the assigned child responsibility"],
              interfaces: ["Parent may assign Work independently"],
            },
            resourceBoundaryDraft: {
              addresses: [{ _tag: "FileTree", path: childDirectory }],
            },
          },
        );
        siblingWorkspaceId = sibling.workspaceId;
      }

      if (!nonRootParent) {
        await submitHumanMessage(
          client,
          project,
          `Create Parent Work ${sourceObjective}`,
        );
        const parentApproval = await waitForApproval(client, project, marker);
        await client.command(project.projectId, "ResolveControlApproval", {
          approvalId: parentApproval.approvalId,
          expectedRevision: parentApproval.revision,
          decision: "Approve",
          reason: "AH10 Root Parent Work seed approval",
        });
        const parentWork = await waitForPublic(
          () =>
            client.view<{
              workId?: string;
              objective?: string;
              revision: number;
            } | null>("current-work", {
              workspaceId: assignmentParentWorkspaceId,
            }),
          (work) =>
            work?.objective === sourceObjective && work.workId !== undefined,
        );
        const rootParentWorkId = parentWork?.workId;
        if (parentWork === null || rootParentWorkId === undefined) {
          throw new Error("Root assign_work did not expose the Parent WorkId");
        }
        parentWorkId = rootParentWorkId;
      }

      if (nonRootParent) {
        const target = await approveWorkspaceFormation(
          client,
          project,
          assignmentParentWorkspaceId,
          marker,
          childName,
        );
        childWorkspaceId = target.workspaceId;
        targetProposalApproved = true;
        const afterTargetProposal = await client.view<{
          workId?: string;
          revision: number;
          status: string;
        } | null>("current-work", {
          workspaceId: assignmentParentWorkspaceId,
        });
        expect(afterTargetProposal).toMatchObject({
          workId: parentWorkId,
          revision: 0,
          status: "Open",
        });
        await client.command(project.projectId, "SteerWork", {
          workId: parentWorkId,
          workspaceId: assignmentParentWorkspaceId,
          expectedWorkRevision: 0,
          steer: {
            severity: "Normal",
            guidance: `Continue Parent formation seed ${marker}.`,
          },
          provenance: { source: "HumanInput" },
        });
        const sibling = await approveWorkspaceFormation(
          client,
          project,
          assignmentParentWorkspaceId,
          siblingName,
          siblingName,
        );
        siblingWorkspaceId = sibling.workspaceId;
        siblingProposalApproved = true;
        const afterSiblingProposal = await client.view<{
          workId?: string;
          revision: number;
          status: string;
        } | null>("current-work", {
          workspaceId: assignmentParentWorkspaceId,
        });
        expect(afterSiblingProposal).toMatchObject({
          workId: parentWorkId,
          revision: 1,
          status: "Open",
        });
        await client.command(project.projectId, "SteerWork", {
          workId: parentWorkId,
          workspaceId: assignmentParentWorkspaceId,
          expectedWorkRevision: 1,
          steer: {
            severity: "Normal",
            guidance: `Continue Parent formation seed ${marker}.`,
          },
          provenance: { source: "HumanInput" },
        });
      }

      const seedParentWork = await waitForPublic(
        () =>
          client.view<{
            workId?: string;
            objective?: string;
            revision: number;
            status: string;
            activeExecution?: { executionId: string };
          } | null>("current-work", {
            workspaceId: assignmentParentWorkspaceId,
          }),
        (work) =>
          parentSeedWaitIssued &&
          work?.workId === parentWorkId &&
          work.objective === sourceObjective &&
          work.status === "Open" &&
          work.activeExecution === undefined,
      );
      if (seedParentWork === null || seedParentWork.workId !== parentWorkId) {
        throw new Error("Parent Work did not reach the expected seed wait");
      }
      const seededRevision = nonRootParent ? 2 : 0;
      expect(seedParentWork.revision).toBe(seededRevision);
      if (nonRootParent) {
        const childDetail = await client.view<{
          boundary?: {
            addresses?: ReadonlyArray<{ _tag: string; path?: string }>;
          };
        }>("workspace-detail", { workspaceId: childWorkspaceId });
        expect(childDetail.boundary?.addresses).toContainEqual({
          _tag: "FileTree",
          path: childDirectory,
        });
      }

      await fixture.crash();
      await fixture.restart({
        entry: ah10Child,
        daemonEnvironment: {
          ARBOR_AH10_ROLE: "old",
          ARBOR_AH10_GATE_ACTION_KIND: "assign_work",
          ARBOR_AH10_DELAY_LEASE_RENEWAL_PAUSE:
            crashSide === "approval-fencing-before" ? "1" : "0",
          ARBOR_AH10_PAUSE_BEFORE_FENCED_RECEIPT:
            crashSide === "before" ? "1" : "0",
          ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN:
            crashSide === "committed" ||
            crashSide === "corrupt-sibling" ||
            crashSide === "approval-committed" ||
            crashSide === "legacy-p32-upgrade" ||
            crashSide === "legacy-unbound" ||
            crashSide === "retired-after-commit" ||
            crashSide === "grant-revoked-after-commit" ||
            crashSide === "non-root-parent" ||
            crashSide === "attention-before" ||
            crashSide === "attention-after" ||
            corruptResult
              ? "1"
              : "0",
          ARBOR_AH10_PAUSE_AFTER_CONTROL_KIND: "assign_work",
          ARBOR_AH10_PAUSE_BEFORE_ASSIGN_WORK_BINDING_COMMIT:
            crashSide === "binding-before" ? "1" : "0",
          ARBOR_AH10_PAUSE_AFTER_ASSIGN_WORK_AUTHORIZED:
            crashSide === "approval-fencing-before" ? "1" : "0",
        },
      });
      await client.command(project.projectId, "SteerWork", {
        workId: parentWorkId,
        workspaceId: assignmentParentWorkspaceId,
        expectedWorkRevision: seedParentWork.revision,
        steer: {
          severity: "Normal",
          guidance: `Resume AH10 direct-child assignment qualification ${marker}.`,
        },
        provenance: { source: "HumanInput" },
      });
      const resumedParentWork = await waitForPublic(
        () =>
          client.view<{
            workId?: string;
            objective?: string;
            revision: number;
            status: string;
          } | null>("current-work", {
            workspaceId: assignmentParentWorkspaceId,
          }),
        (work) =>
          work?.workId === parentWorkId &&
          work.revision === seedParentWork.revision + 1,
      );
      expect(resumedParentWork).toMatchObject({
        workId: parentWorkId,
        objective: sourceObjective,
        revision: seedParentWork.revision + 1,
        status: "Open",
      });

      const oldAction = await waitForPublic(
        async () =>
          events.find(
            (event) =>
              event.role === "old" &&
              event.boundary === "AH7AfterActionIntentCommit" &&
              event.actionKind === "assign_work" &&
              event.actionIndex === 0,
          ),
        (event) => event !== undefined,
        45_000,
      ).catch((error: unknown) => {
        throw new Error(
          `Direct-child AssignWork ActionIntent absent: ${error instanceof Error ? error.message : String(error)}; listWorkspaceCalls=${JSON.stringify(listWorkspaceCalls)}; assignWorkCalls=${JSON.stringify(assignWorkCalls)}; targetRef=${targetWorkspaceRef}; provider=${JSON.stringify(providerTrace)}; events=${JSON.stringify(events)}; rows=${JSON.stringify(readRows(recoveryDatabaseFile))}; daemon=${fixture.daemonErrors.join(" | ")}`,
        );
      });
      if (oldAction === undefined || targetWorkspaceRef === undefined) {
        throw new Error("the model did not reach direct-child AssignWork");
      }
      const providerTurnId = oldAction.providerTurnId;
      const logicalActionId = oldAction.logicalActionId;
      const callRef = oldAction.callRef;
      if (
        providerTurnId === undefined ||
        logicalActionId === undefined ||
        callRef === undefined
      ) {
        throw new Error("Direct-child AssignWork omitted pinned identity");
      }
      expect(listWorkspaceCalls).toHaveLength(1);
      expect(assignWorkCalls).toHaveLength(1);
      expect(targetWorkspaceRef).toMatch(/^wref_[a-f0-9]{64}$/u);
      expect(targetWorkspaceRef).not.toContain(childWorkspaceId);

      const listControlRows = readRows(
        recoveryDatabaseFile,
      ).controlResults.filter(
        (row) =>
          (JSON.parse(row.payload_json) as ControlResult).actionKind ===
          "list_workspaces",
      );
      expect(listControlRows).toHaveLength(1);
      const listControlRow = listControlRows[0];
      if (listControlRow === undefined) {
        throw new Error("list_workspaces ControlResult row is absent");
      }
      const listControlResult = JSON.parse(
        listControlRow.payload_json,
      ) as ControlResult;
      if (listControlResult?.callRef === undefined) {
        throw new Error("list_workspaces ControlResult omitted its callRef");
      }
      expect(listControlResult.callRef).toMatch(/^call_/u);
      const persistedListResult = parseWorkspacesResult(
        listControlRow,
      ).directChildren?.find((child) => child.name === childName);
      expect(persistedListResult).toEqual({
        ref: targetWorkspaceRef,
        name: childName,
        responsibilitySummary: `own the bounded responsibility for ${marker}`,
        currentWorkSummary: null,
        openWorkCount: 0,
        readyResults: [],
        revision: 0,
      });

      let liveOwnerPauseEvidence: LiveOwnerLeasePauseEvidence | undefined;
      let oldLeaseOwner: Probe | undefined;
      let oldLeaseOwnerWorkerId: string | undefined;
      let oldLeaseOwnerIncarnationId: string | undefined;
      let assignWorkAuthorizedPause: Probe | undefined;

      // The old daemon is held at the exact Agent ActionIntent boundary. The
      // target is the wref recovered from its persisted successful
      // list_workspaces ControlResult, not a fabricated or derived ref.
      let assignmentGrantId: string | undefined;
      if (
        crashSide !== "approval-committed" &&
        crashSide !== "approval-fencing-before"
      ) {
        assignmentGrantId = functionalId("pgr");
        await client.command(project.projectId, "GrantPermission", {
          permissionGrantId: assignmentGrantId,
          issuer: "user:local",
          subject: {
            _tag: "WorkspaceAgent",
            workspaceId: assignmentParentWorkspaceId,
          },
          capability: "core.control.assign-work",
          target: targetWorkspaceRef,
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        });
      }
      const grantRows = readRows(recoveryDatabaseFile).permissionGrants.filter(
        (grant) =>
          grant.subject_kind === "WorkspaceAgent" &&
          grant.subject_ref === assignmentParentWorkspaceId &&
          grant.capability === "core.control.assign-work" &&
          grant.target === targetWorkspaceRef &&
          grant.state === "Active",
      );
      expect(grantRows).toHaveLength(
        crashSide === "approval-committed" ||
          crashSide === "approval-fencing-before"
          ? 0
          : 1,
      );
      expect(
        targetWorks(readRows(recoveryDatabaseFile), targetObjective),
      ).toHaveLength(0);

      let priorCommittedCommandId: string | undefined;
      let corruptedResultJson: string | undefined;
      if (
        crashSide === "committed" ||
        crashSide === "corrupt-sibling" ||
        crashSide === "approval-committed" ||
        crashSide === "legacy-unbound" ||
        crashSide === "legacy-p32-upgrade" ||
        crashSide === "retired-after-commit" ||
        crashSide === "grant-revoked-after-commit" ||
        crashSide === "non-root-parent" ||
        crashSide === "attention-before" ||
        crashSide === "attention-after" ||
        corruptResult
      ) {
        releaseGate(fixture, "old", "action-intent");
        if (crashSide === "approval-committed") {
          const approval = await waitForApproval(client, project, marker);
          await client.command(project.projectId, "ResolveControlApproval", {
            approvalId: approval.approvalId,
            expectedRevision: approval.revision,
            decision: "Approve",
            reason: "AH10 exact target binding qualification",
          });
        }
        const controlReturned = await waitForPublic(
          async () =>
            events.find(
              (event) =>
                event.role === "old" &&
                event.boundary ===
                  "AH10AfterControlHandlerReturnBeforeObservationCommit" &&
                event.executionId === oldAction.executionId &&
                event.logicalActionId === logicalActionId &&
                event.callRef === callRef,
            ),
          (event) => event !== undefined,
          15_000,
        ).catch((error: unknown) => {
          throw new Error(
            `Direct-child AssignWork post-handler probe absent: ${error instanceof Error ? error.message : String(error)}; events=${JSON.stringify(events.filter((event) => event.executionId === oldAction.executionId))}; results=${JSON.stringify(
              readRows(recoveryDatabaseFile)
                .controlResults.map((row) => JSON.parse(row.payload_json))
                .filter((result) => result.actionKind === "assign_work"),
            )}; works=${JSON.stringify(targetWorks(readRows(recoveryDatabaseFile), targetObjective))}; commands=${JSON.stringify(readRows(recoveryDatabaseFile).commands.filter((row) => row.resolution === "Committed"))}; bindings=${JSON.stringify(readRows(recoveryDatabaseFile).assignWorkTargetBindings)}; actions=${JSON.stringify(readRows(recoveryDatabaseFile).actions.filter((row) => row.execution_id === oldAction.executionId))}; daemon=${fixture.daemonErrors.join(" | ")}`,
          );
        });
        if (controlReturned === undefined) {
          throw new Error("Direct-child AssignWork post-handler probe absent");
        }
        const beforeCrash = readRows(recoveryDatabaseFile);
        const assigned = targetWorks(beforeCrash, targetObjective);
        expect(assigned).toHaveLength(1);
        const priorReceipt = beforeCrash.commands.filter((command) => {
          if (
            command.resolution !== "Committed" ||
            command.result_json === null
          )
            return false;
          try {
            const result = JSON.parse(command.result_json) as {
              workId?: string;
              workspaceId?: string;
              lifecycle?: string;
              revision?: number;
            };
            return (
              result.workId === assigned[0]?.work_id &&
              result.workspaceId === childWorkspaceId &&
              result.lifecycle === "Open" &&
              result.revision === 0
            );
          } catch {
            return false;
          }
        });
        expect(priorReceipt).toHaveLength(1);
        priorCommittedCommandId = priorReceipt[0]?.command_id;
        expect(priorCommittedCommandId).toMatch(/^cmd_/u);
        const bindings = beforeCrash.assignWorkTargetBindings;
        expect(bindings).toHaveLength(1);
        expect(bindings[0]).toMatchObject({
          command_id: priorCommittedCommandId,
          execution_id: oldAction.executionId,
          provider_turn_id: providerTurnId,
          logical_action_id: logicalActionId,
          call_ref: callRef,
          parent_workspace_id: assignmentParentWorkspaceId,
          parent_work_id: parentWorkId,
          target_workspace_ref: targetWorkspaceRef,
          target_workspace_id: childWorkspaceId,
          work_id: assigned[0]?.work_id,
          authority_kind:
            crashSide === "approval-committed"
              ? "ActionApproval"
              : "PermissionGrant",
        });
        const savedAuthority = JSON.parse(
          bindings[0]?.authority_evidence_json ?? "null",
        ) as {
          _tag?: string;
          targetRef?: string;
          approvalId?: string;
          approvalRevision?: number;
        };
        expect(savedAuthority).toMatchObject({
          targetRef: targetWorkspaceRef,
          _tag:
            crashSide === "approval-committed"
              ? "ActionApproval"
              : "PermissionGrant",
        });
        if (crashSide === "approval-committed") {
          const consumed = beforeCrash.approvals.find(
            (approval) => approval.approval_id === savedAuthority.approvalId,
          );
          expect(consumed).toMatchObject({
            target_ref: targetWorkspaceRef,
            state: "Consumed",
            revision: (savedAuthority.approvalRevision ?? -1) + 1,
            consumed_by: priorCommittedCommandId,
            binding_proven: 1,
          });
        }
        expect(
          beforeCrash.workAssignedEvents.filter((event) => {
            try {
              return (
                (JSON.parse(event.payload_json) as { workId?: string })
                  .workId === assigned[0]?.work_id
              );
            } catch {
              return false;
            }
          }),
        ).toHaveLength(1);
        expect(beforeCrash.actions).toContainEqual(
          expect.objectContaining({
            execution_id: oldAction.executionId,
            provider_turn_id: providerTurnId,
            logical_action_id: logicalActionId,
            call_ref: callRef,
            action_kind: "assign_work",
            state: "Pending",
            observation_source_ref: null,
          }),
        );
        expect(
          beforeCrash.observations.filter((observation) =>
            observation.source_ref.startsWith(
              `observation_${oldAction.executionId}_`,
            ),
          ),
        ).toHaveLength(1);
        expect(
          beforeCrash.providerAttempts.filter(
            (row) => row.provider_turn_id === providerTurnId,
          ),
        ).toEqual([
          expect.objectContaining({ attempt_no: 0, outcome: "Success" }),
        ]);
        expect(assignWorkCalls).toHaveLength(1);
        if (
          crashSide === "corrupt-sibling" ||
          crashSide === "attention-before" ||
          crashSide === "attention-after"
        ) {
          retargetBindingToSibling(
            recoveryDatabaseFile,
            priorCommittedCommandId ?? "",
            siblingWorkspaceId,
          );
          expect(
            readRows(recoveryDatabaseFile).assignWorkTargetBindings[0]
              ?.target_workspace_id,
          ).toBe(siblingWorkspaceId);
        } else if (corruptResult) {
          const commandId = priorCommittedCommandId;
          if (commandId === undefined) {
            throw new Error("Committed AssignWork receipt has no CommandId");
          }
          const rawCorruptResult =
            crashSide === "wrong-shape-result"
              ? JSON.stringify({ private_marker: marker })
              : `{"private_marker_${marker}":`;
          corruptedResultJson = rawCorruptResult;
          const corruptDb = new DatabaseSync(recoveryDatabaseFile);
          try {
            const changed = corruptDb
              .prepare(
                "UPDATE commands SET result_json = ? WHERE command_id = ? AND resolution = 'Committed'",
              )
              .run(rawCorruptResult, commandId);
            expect(Number(changed.changes)).toBe(1);
            expect(
              (
                corruptDb
                  .prepare(
                    "SELECT result_json FROM commands WHERE command_id = ?",
                  )
                  .get(commandId) as { result_json: string }
              ).result_json,
            ).toBe(rawCorruptResult);
          } finally {
            corruptDb.close();
          }
        } else if (crashSide === "legacy-unbound") {
          removeBindingForLegacyFixture(
            recoveryDatabaseFile,
            priorCommittedCommandId ?? "",
          );
          expect(
            readRows(recoveryDatabaseFile).assignWorkTargetBindings,
          ).toHaveLength(0);
        } else if (crashSide === "retired-after-commit") {
          retireTargetAfterCommit(recoveryDatabaseFile, childWorkspaceId);
          expect(
            readRows(recoveryDatabaseFile).workspaceLifecycles.find(
              (workspace) => workspace.workspace_id === childWorkspaceId,
            )?.lifecycle,
          ).toBe("Retired");
        } else if (crashSide === "grant-revoked-after-commit") {
          if (assignmentGrantId === undefined) {
            throw new Error("Grant-authorized case has no PermissionGrantId");
          }
          await client.command(project.projectId, "RevokePermission", {
            permissionGrantId: assignmentGrantId,
          });
          expect(
            readRows(recoveryDatabaseFile).permissionGrants.find(
              (grant) => grant.permission_grant_id === assignmentGrantId,
            )?.state,
          ).toBe("Revoked");
        }
        await fixture.crash();
      } else if (crashSide === "binding-before") {
        releaseGate(fixture, "old", "action-intent");
        const beforeBindingCommit = await waitForPublic(
          async () =>
            events.find(
              (event) =>
                event.role === "old" &&
                event.boundary === "AH10BeforeAssignWorkBindingCommit" &&
                event.executionId === oldAction.executionId,
            ),
          (event) => event !== undefined,
          15_000,
        ).catch((error: unknown) => {
          const snapshot = readRows(recoveryDatabaseFile);
          throw new Error(
            `AssignWork transaction precommit probe absent: ${error instanceof Error ? error.message : String(error)}; executionEvents=${JSON.stringify(events.filter((event) => event.executionId === oldAction.executionId))}; assigns=${JSON.stringify(snapshot.controlResults.map((row) => JSON.parse(row.payload_json)).filter((result) => result.actionKind === "assign_work"))}; targetWorks=${JSON.stringify(targetWorks(snapshot, targetObjective))}; bindings=${JSON.stringify(snapshot.assignWorkTargetBindings)}; grants=${JSON.stringify(snapshot.permissionGrants)}; daemon=${fixture.daemonErrors.join(" | ")}`,
          );
        });
        if (beforeBindingCommit?.commandId === undefined) {
          throw new Error("Direct-child binding-before-commit probe absent");
        }
        priorCommittedCommandId = beforeBindingCommit.commandId;
        expect(priorCommittedCommandId).toMatch(/^cmd_/u);
        const uncommitted = readRows(recoveryDatabaseFile);
        expect(targetWorks(uncommitted, targetObjective)).toHaveLength(0);
        expect(uncommitted.assignWorkTargetBindings).toHaveLength(0);
        expect(
          uncommitted.workAssignedEvents.filter(
            (event) => event.caused_by_command_id === priorCommittedCommandId,
          ),
        ).toHaveLength(0);
        expect(
          uncommitted.commands.some(
            (command) => command.command_id === priorCommittedCommandId,
          ),
        ).toBe(false);
        expect(uncommitted.permissionGrants).toEqual(grantRows);
        await fixture.crash();
        const afterKill = readRows(recoveryDatabaseFile);
        expect(targetWorks(afterKill, targetObjective)).toHaveLength(0);
        expect(afterKill.assignWorkTargetBindings).toHaveLength(0);
        expect(
          afterKill.commands.some(
            (command) => command.command_id === priorCommittedCommandId,
          ),
        ).toBe(false);
      } else if (crashSide === "approval-fencing-before") {
        releaseGate(fixture, "old", "action-intent");
        const approval = await waitForApproval(client, project, marker);
        await client.command(project.projectId, "ResolveControlApproval", {
          approvalId: approval.approvalId,
          expectedRevision: approval.revision,
          decision: "Approve",
          reason: "qualify fenced CAPA non-consumption",
        });
        assignWorkAuthorizedPause = await waitForPublic(
          async () =>
            events.find(
              (event) =>
                event.role === "old" &&
                event.boundary ===
                  "AH10AfterAssignWorkAuthorizedBeforeCommandSubmission" &&
                event.pauseRequested === true &&
                event.executionId === oldAction.executionId &&
                event.logicalActionId === logicalActionId &&
                event.callRef === callRef,
            ),
          (event) => event !== undefined,
          20_000,
        ).catch((error: unknown) => {
          const snapshot = readRows(recoveryDatabaseFile);
          throw new Error(
            `AssignWork authorization pre-command probe absent: ${error instanceof Error ? error.message : String(error)}; events=${JSON.stringify(events.filter((event) => event.executionId === oldAction.executionId))}; approvals=${JSON.stringify(snapshot.approvals)}; controls=${JSON.stringify(snapshot.controlResults.map((row) => JSON.parse(row.payload_json)))}; actions=${JSON.stringify(snapshot.actions.filter((entry) => entry.execution_id === oldAction.executionId))}; provider=${JSON.stringify(providerTrace)}; daemon=${fixture.daemonErrors.join(" | ")}`,
          );
        });
        if (assignWorkAuthorizedPause === undefined) {
          throw new Error(
            "AssignWork authorization pre-command pause was absent",
          );
        }

        writeFileSync(
          resolve(fixture.directory, "ah10-gates", "old-lease-renewal.pause"),
          "pause old owner renewal after AssignWork authorization",
        );
        const renewal = await waitForPublic(
          async () =>
            events.find(
              (event) =>
                event.role === "old" &&
                event.boundary === "AH10BeforeLeaseRenewal" &&
                event.executionId === oldAction.executionId &&
                event.fencingGeneration === 1 &&
                event.pauseRequested === true,
            ),
          (event) => event !== undefined,
          20_000,
        );
        expect(renewal?.fencingGeneration).toBe(1);
        if (renewal === undefined) {
          throw new Error(
            "AssignWork live-owner renewal pause evidence absent",
          );
        }
        oldLeaseOwner = events.find(
          (event) =>
            event.role === "old" &&
            event.boundary === "AH10AfterLeaseAcquired" &&
            event.executionId === oldAction.executionId &&
            event.fencingGeneration === 1,
        );
        oldLeaseOwnerWorkerId = oldLeaseOwner?.workerId;
        oldLeaseOwnerIncarnationId = oldLeaseOwner?.workerIncarnationId;
        if (
          oldLeaseOwnerWorkerId === undefined ||
          oldLeaseOwnerIncarnationId === undefined
        ) {
          throw new Error(
            "AssignWork live-owner lease identity probe was absent",
          );
        }
        liveOwnerPauseEvidence = {
          boundary: "AH10BeforeLeaseRenewal",
          pauseRequested: renewal.pauseRequested === true,
          executionId: renewal.executionId,
          fencingGeneration: renewal.fencingGeneration ?? -1,
        };
      } else {
        const oldLeasePause = await waitForPublic(
          async () =>
            events.find(
              (event) =>
                event.role === "old" &&
                event.boundary === "AH10BeforeLeaseRenewal" &&
                event.executionId === oldAction.executionId,
            ),
          (event) => event !== undefined,
          20_000,
        );
        if (oldLeasePause === undefined) {
          throw new Error("Direct-child AssignWork old lease probe was absent");
        }
        expect(oldLeasePause.fencingGeneration).toBe(0);
        liveOwnerPauseEvidence = {
          boundary: "AH10BeforeLeaseRenewal",
          pauseRequested: oldLeasePause.pauseRequested === true,
          executionId: oldLeasePause.executionId,
          fencingGeneration: oldLeasePause.fencingGeneration ?? -1,
        };
      }
      if (crashSide === "approval-fencing-before") {
        if (liveOwnerPauseEvidence === undefined) {
          throw new Error(
            `live-owner branch ${crashSide} omitted pause evidence`,
          );
        }
        if (
          oldLeaseOwnerWorkerId === undefined ||
          oldLeaseOwnerIncarnationId === undefined
        ) {
          throw new Error(
            `live-owner branch ${crashSide} omitted exact lease identity`,
          );
        }
        const exactOldLeaseOwner = {
          workerId: oldLeaseOwnerWorkerId,
          workerIncarnationId: oldLeaseOwnerIncarnationId,
        };
        const assertApprovalFencingBeforeCommandBlocked = () => {
          const currentRows = readRows(recoveryDatabaseFile);
          const liveLease = currentRows.leases.find(
            (lease) => lease.execution_id === oldAction.executionId,
          );
          expect(liveLease).toMatchObject({
            execution_id: oldAction.executionId,
            worker_id: exactOldLeaseOwner.workerId,
            worker_incarnation_id: exactOldLeaseOwner.workerIncarnationId,
            generation: 1,
          });
          expect(
            existsSync(
              resolve(
                fixture.directory,
                "ah10-gates",
                "old-assign-work-authorized.release",
              ),
            ),
          ).toBe(false);
          expect(
            existsSync(
              resolve(
                fixture.directory,
                "ah10-gates",
                "old-lease-renewal.release",
              ),
            ),
          ).toBe(false);
          expect(
            events.filter(
              (event) =>
                event.role === "old" &&
                event.boundary ===
                  "AH10AfterAssignWorkAuthorizedBeforeCommandSubmission" &&
                event.executionId === oldAction.executionId &&
                event.logicalActionId === logicalActionId &&
                event.callRef === callRef,
            ),
          ).toEqual([assignWorkAuthorizedPause]);
          expect(
            events.some(
              (event) =>
                event.role === "old" &&
                (event.boundary === "AH10BeforeFencedReceiptCommit" ||
                  event.boundary ===
                    "AH10AfterControlHandlerReturnBeforeObservationCommit") &&
                event.executionId === oldAction.executionId &&
                event.logicalActionId === logicalActionId &&
                event.callRef === callRef,
            ),
          ).toBe(false);
          expect(
            currentRows.assignWorkTargetBindings.filter(
              (binding) =>
                binding.execution_id === oldAction.executionId &&
                binding.logical_action_id === logicalActionId &&
                binding.call_ref === callRef,
            ),
          ).toEqual([]);
          expect(
            currentRows.controlResults.filter((result) => {
              try {
                const payload = JSON.parse(result.payload_json) as {
                  callRef?: string;
                  actionKind?: string;
                };
                return (
                  payload.callRef === callRef &&
                  payload.actionKind === "assign_work"
                );
              } catch {
                return false;
              }
            }),
          ).toEqual([]);
          expect(targetWorks(currentRows, targetObjective)).toHaveLength(0);
        };
        assertApprovalFencingBeforeCommandBlocked();
        const liveLeaseBeforeQualification = readRows(
          recoveryDatabaseFile,
        ).leases.find((lease) => lease.execution_id === oldAction.executionId);
        if (liveLeaseBeforeQualification === undefined) {
          throw new Error(
            "AssignWork live lease tuple absent before qualification",
          );
        }
        await waitForLiveOwnerLeaseExpiryForQualification({
          databaseFile: recoveryDatabaseFile,
          executionId: oldAction.executionId,
          pauseEvidence: liveOwnerPauseEvidence,
          expected: {
            workerId: exactOldLeaseOwner.workerId,
            workerIncarnationId: exactOldLeaseOwner.workerIncarnationId,
            generation: 1,
            expiresAt: liveLeaseBeforeQualification.expires_at,
          },
          daemon: { snapshot: fixture.daemonProcessSnapshot },
        });
        expect(
          readRows(recoveryDatabaseFile).leases.find(
            (lease) => lease.execution_id === oldAction.executionId,
          ),
        ).toEqual(liveLeaseBeforeQualification);
        assertApprovalFencingBeforeCommandBlocked();
      } else {
        await expireExecutionLeaseAfterOwnerExitForQualification({
          databaseFile: recoveryDatabaseFile,
          executionId: oldAction.executionId,
          daemon: {
            crash: fixture.crash,
            snapshot: fixture.daemonProcessSnapshot,
          },
        });
      }

      if (crashSide === "legacy-p32-upgrade") {
        recoveryDatabaseFile = await makePreBindingP32Copy(
          fixture.databaseFile,
          resolve(fixture.directory, "p32-pre-binding.db"),
          priorCommittedCommandId ?? "",
        );
        const baselineFile = resolve(fixture.directory, "p32-baseline.db");
        await createP32MigrationBaseline(baselineFile);
        const baseline = new DatabaseSync(recoveryDatabaseFile, {
          readOnly: true,
        });
        const pristineP32 = new DatabaseSync(baselineFile, {
          readOnly: true,
        });
        try {
          expect(
            Number(
              (
                baseline.prepare("PRAGMA user_version").get() as {
                  user_version: number;
                }
              ).user_version,
            ),
          ).toBe(32);
          expect(
            baseline
              .prepare("SELECT resolution FROM commands WHERE command_id = ?")
              .get(priorCommittedCommandId ?? "")?.resolution,
          ).toBe("Committed");
          expect(
            baseline
              .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'assign_work_target_bindings'",
              )
              .all(),
          ).toHaveLength(0);
          expect(schemaSnapshot(baseline)).toEqual(schemaSnapshot(pristineP32));
        } finally {
          baseline.close();
          pristineP32.close();
        }
        await upgradeSchema44TestDatabase({
          databaseFilename: recoveryDatabaseFile,
          p39ReportFilename: resolve(
            fixture.directory,
            "p32-upgrade-p39-report.db",
          ),
        });
        const schema44 = new DatabaseSync(recoveryDatabaseFile, {
          readOnly: true,
        });
        let v44ReceiptJson: string | null = null;
        try {
          expect(
            Number(
              (
                schema44.prepare("PRAGMA user_version").get() as {
                  user_version: number;
                }
              ).user_version,
            ),
          ).toBe(44);
          const receipt = schema44
            .prepare(
              "SELECT resolution, result_json FROM commands WHERE command_id = ?",
            )
            .get(priorCommittedCommandId ?? "") as
            | { resolution: string; result_json: string | null }
            | undefined;
          expect(receipt?.resolution).toBe("Committed");
          expect(receipt?.result_json).not.toBeNull();
          v44ReceiptJson = receipt?.result_json ?? null;
          expect(
            schema44
              .prepare(
                "SELECT command_id FROM assign_work_target_bindings WHERE command_id = ?",
              )
              .all(priorCommittedCommandId ?? ""),
          ).toHaveLength(0);
          const inboxColumns = (
            schema44
              .prepare("PRAGMA table_info(inbox_entries)")
              .all() as Array<{
              name: string;
            }>
          ).map(({ name }) => name);
          expect(inboxColumns).toEqual([
            "workspace_id",
            "entry_key",
            "kind",
            "summary",
            "correlation_id",
            "admitted_at",
            "consumed_at",
          ]);
          const verificationColumns = (
            schema44
              .prepare("PRAGMA table_info(verifications)")
              .all() as Array<{
              name: string;
            }>
          ).map(({ name }) => name);
          expect(verificationColumns).not.toContain("criteria_results");
          expect(verificationColumns).not.toContain("snapshot_status");
          expect(
            schema44
              .prepare(
                `SELECT name, sql FROM sqlite_master WHERE type = 'trigger'
                   AND name IN ('tool_invocations_observation_insert_guard',
                                'tool_invocations_observation_update_guard')
                   ORDER BY name`,
              )
              .all(),
          ).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                name: "tool_invocations_observation_insert_guard",
                sql: expect.stringContaining("ApprovalRejected"),
              }),
              expect.objectContaining({
                name: "tool_invocations_observation_update_guard",
                sql: expect.stringContaining("ApprovalRejected"),
              }),
            ]),
          );
        } finally {
          schema44.close();
        }
        await upgradeSchema44ToCurrentTestDatabase({
          databaseFilename: recoveryDatabaseFile,
        });
        const schema52 = new DatabaseSync(recoveryDatabaseFile, {
          readOnly: true,
        });
        try {
          expect(
            Number(
              (
                schema52.prepare("PRAGMA user_version").get() as {
                  user_version: number;
                }
              ).user_version,
            ),
          ).toBe(52);
          expect(
            schema52
              .prepare(
                "SELECT resolution, result_json FROM commands WHERE command_id = ?",
              )
              .get(priorCommittedCommandId ?? ""),
          ).toEqual({ resolution: "Committed", result_json: v44ReceiptJson });
          expect(
            schema52
              .prepare(
                "SELECT command_id FROM assign_work_target_bindings WHERE command_id = ?",
              )
              .all(priorCommittedCommandId ?? ""),
          ).toHaveLength(0);
        } finally {
          schema52.close();
        }
      }

      const newDaemon = await fixture.startAdditionalDaemon({
        entry: ah10Child,
        daemonEnvironment: {
          ARBOR_DB: recoveryDatabaseFile,
          ARBOR_AH10_ROLE: "new",
          ARBOR_AH10_GATE_ACTION_KIND: "assign_work",
          ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "0",
          ARBOR_AH10_PAUSE_AFTER_ASSIGN_WORK_AUTHORIZED: "0",
          ...(attentionBefore || attentionAfter
            ? {
                ARBOR_AH10_BINDING_ATTENTION_BOUNDARY: attentionBefore
                  ? "before"
                  : "after",
              }
            : {}),
        },
        onStdout: (line) => pushProbe(events, line),
      });
      const newLease = await waitForPublic(
        async () =>
          events.find(
            (event) =>
              event.role === "new" &&
              event.boundary === "AH10AfterLeaseAcquired" &&
              event.executionId === oldAction.executionId,
          ),
        (event) => event !== undefined,
        45_000,
      ).catch((error: unknown) => {
        throw new Error(
          `Direct-child AssignWork gen1 lease absent: ${error instanceof Error ? error.message : String(error)}; events=${JSON.stringify(events)}; rows=${JSON.stringify(readRows(recoveryDatabaseFile))}; daemon=${newDaemon.daemonErrors.join(" | ")}`,
        );
      });
      if (newLease === undefined) {
        throw new Error("Direct-child AssignWork gen1 did not acquire lease");
      }
      if (crashSide === "legacy-p32-upgrade") {
        const upgraded = readRows(recoveryDatabaseFile);
        expect(upgraded.schemaVersion).toBe(52);
        expect(upgraded.assignWorkTargetBindings).toHaveLength(0);
        expect(
          upgraded.commands.find(
            (command) => command.command_id === priorCommittedCommandId,
          )?.resolution,
        ).toBe("Committed");
        const upgradedDb = new DatabaseSync(recoveryDatabaseFile, {
          readOnly: true,
        });
        try {
          const p35Tables = upgradedDb
            .prepare(
              `SELECT name FROM sqlite_master
                WHERE type = 'table'
                  AND name IN (
                    'workspace_resource_activation_intents',
                    'workspace_resource_activation_attention_rows'
                  )
                ORDER BY name`,
            )
            .all() as Array<{ name: string }>;
          expect(p35Tables.map((row) => row.name)).toEqual([
            "workspace_resource_activation_attention_rows",
            "workspace_resource_activation_intents",
          ]);
          expect(
            (
              upgradedDb
                .prepare(
                  "SELECT COUNT(*) AS count FROM workspace_resource_activation_intents",
                )
                .get() as { count: number }
            ).count,
          ).toBe(0);
          expect(
            (
              upgradedDb
                .prepare(
                  "SELECT COUNT(*) AS count FROM workspace_resource_activation_attention_rows",
                )
                .get() as { count: number }
            ).count,
          ).toBe(0);
        } finally {
          upgradedDb.close();
        }
      }
      expect(newLease.fencingGeneration).toBe(
        crashSide === "approval-committed" ||
          crashSide === "approval-fencing-before"
          ? 2
          : 1,
      );
      const newAction = await waitForPublic(
        async () =>
          events.find(
            (event) =>
              event.role === "new" &&
              event.boundary === "AH7AfterActionIntentCommit" &&
              event.actionKind === "assign_work" &&
              event.executionId === oldAction.executionId &&
              event.actionIndex === 0,
          ),
        (event) => event !== undefined,
        30_000,
      );
      if (newAction === undefined) {
        throw new Error("Direct-child AssignWork gen1 ActionIntent absent");
      }
      expect(newAction.providerTurnId).toBe(providerTurnId);
      expect(newAction.logicalActionId).toBe(logicalActionId);
      expect(newAction.callRef).toBe(callRef);
      expect(assignWorkCalls).toHaveLength(1);

      let resultDaemon = newDaemon;
      if (attentionBefore || attentionAfter) {
        releaseGate(fixture, "new", "action-intent");
        const expectedBoundary = attentionBefore
          ? "AH10BeforeAssignWorkBindingAttentionCommit"
          : "AH10AfterAssignWorkBindingAttentionCommit";
        const attentionBoundary = await waitForPublic(
          async () =>
            events.find(
              (event) =>
                event.role === "new" &&
                event.boundary === expectedBoundary &&
                event.executionId === oldAction.executionId &&
                event.logicalActionId === logicalActionId &&
                event.committedCommandId === priorCommittedCommandId,
            ),
          (event) => event !== undefined,
          20_000,
        );
        if (attentionBoundary === undefined) {
          throw new Error(`missing ${expectedBoundary} probe`);
        }
        const atBoundary = readRows(recoveryDatabaseFile);
        const expectedFactCount = attentionAfter ? 1 : 0;
        expect(atBoundary.bindingAttentionFacts).toHaveLength(
          expectedFactCount,
        );
        expect(atBoundary.bindingAttentionEvents).toHaveLength(
          expectedFactCount,
        );
        await newDaemon.crash();
        const afterAttentionKill = readRows(recoveryDatabaseFile);
        expect(afterAttentionKill.bindingAttentionFacts).toHaveLength(
          expectedFactCount,
        );
        expect(afterAttentionKill.bindingAttentionEvents).toHaveLength(
          expectedFactCount,
        );
        await expireExecutionLeaseAfterOwnerExitForQualification({
          databaseFile: recoveryDatabaseFile,
          executionId: oldAction.executionId,
          daemon: {
            crash: newDaemon.crash,
            snapshot: newDaemon.daemonProcessSnapshot,
          },
        });
        const restartedDaemon = await fixture.startAdditionalDaemon({
          entry: ah10Child,
          daemonEnvironment: {
            ARBOR_AH10_ROLE: "new",
            ARBOR_AH10_GATE_ACTION_KIND: "assign_work",
            ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "0",
            ARBOR_AH10_PAUSE_AFTER_ASSIGN_WORK_AUTHORIZED: "0",
          },
          onStdout: (line) => pushProbe(events, line),
        });
        resultDaemon = restartedDaemon;
        const restartedLease = await waitForPublic(
          async () =>
            events.find(
              (event) =>
                event.role === "new" &&
                event.boundary === "AH10AfterLeaseAcquired" &&
                event.executionId === oldAction.executionId &&
                event.fencingGeneration === 2,
            ),
          (event) => event !== undefined,
          45_000,
        );
        expect(restartedLease?.fencingGeneration).toBe(2);
      }

      let oldRejectedCommandId = "";
      if (crashSide === "approval-fencing-before") {
        releaseGate(fixture, "old", "assign-work-authorized");
        const rejected = await waitForPublic(
          async () => fencedReceipts(readRows(recoveryDatabaseFile)),
          (rows) => rows.length === 1,
          20_000,
        );
        oldRejectedCommandId = rejected[0]?.command_id ?? "";
        expect(oldRejectedCommandId).toMatch(/^cmd_/u);
        const beforeRetry = readRows(recoveryDatabaseFile);
        expect(targetWorks(beforeRetry, targetObjective)).toHaveLength(0);
        expect(beforeRetry.assignWorkTargetBindings).toHaveLength(0);
        expect(
          beforeRetry.workAssignedEvents.filter((event) => {
            try {
              return (
                (JSON.parse(event.payload_json) as { objective?: string })
                  .objective === targetObjective
              );
            } catch {
              return false;
            }
          }),
        ).toHaveLength(0);
        const targetApprovals = beforeRetry.approvals.filter(
          (approval) => approval.target_ref === targetWorkspaceRef,
        );
        expect(targetApprovals).toHaveLength(1);
        expect(targetApprovals[0]).toMatchObject({
          target_ref: targetWorkspaceRef,
          state: "Approved",
          revision: 1,
          consumed_by: null,
          binding_proven: 1,
        });
        await fixture.crash();
      } else if (
        crashSide === "committed" ||
        crashSide === "corrupt-sibling" ||
        crashSide === "approval-committed"
      ) {
        oldRejectedCommandId = "";
      } else {
        releaseGate(fixture, "old", "action-intent");
      }
      if (crashSide === "before") {
        const beforeCommit = await waitForPublic(
          async () =>
            events.find(
              (event) =>
                event.role === "old" &&
                event.boundary === "AH10BeforeFencedReceiptCommit" &&
                event.executionId === oldAction.executionId,
            ),
          (event) => event !== undefined,
          15_000,
        );
        if (beforeCommit?.commandId === undefined) {
          throw new Error(
            "Direct-child FencingRejected precommit probe absent",
          );
        }
        oldRejectedCommandId = beforeCommit.commandId;
        expect(oldRejectedCommandId).toMatch(/^cmd_/u);
        expect(fencedReceipts(readRows(recoveryDatabaseFile))).toHaveLength(0);
        expect(
          targetWorks(readRows(recoveryDatabaseFile), targetObjective),
        ).toHaveLength(0);
      } else if (crashSide === "after") {
        const rejected = await waitForPublic(
          async () => fencedReceipts(readRows(recoveryDatabaseFile)),
          (rows) => rows.length === 1,
          15_000,
        );
        oldRejectedCommandId = rejected[0]?.command_id ?? "";
        expect(oldRejectedCommandId).toMatch(/^cmd_/u);
        expect(
          targetWorks(readRows(recoveryDatabaseFile), targetObjective),
        ).toHaveLength(0);
      }

      if (
        crashSide !== "committed" &&
        crashSide !== "corrupt-sibling" &&
        crashSide !== "approval-committed" &&
        crashSide !== "approval-fencing-before" &&
        crashSide !== "legacy-unbound" &&
        crashSide !== "legacy-p32-upgrade" &&
        crashSide !== "retired-after-commit" &&
        crashSide !== "grant-revoked-after-commit" &&
        crashSide !== "non-root-parent" &&
        crashSide !== "attention-before" &&
        crashSide !== "attention-after" &&
        !corruptResult &&
        crashSide !== "binding-before"
      ) {
        await fixture.crash();
      }
      if (crashSide === "before") {
        const afterKill = readRows(recoveryDatabaseFile);
        expect(fencedReceipts(afterKill)).toHaveLength(0);
        expect(
          afterKill.commands.some(
            (command) => command.command_id === oldRejectedCommandId,
          ),
        ).toBe(false);
      }
      releaseGate(fixture, "new", "action-intent");

      const completed = await waitForPublic(
        async () => readRows(recoveryDatabaseFile),
        (rows) => {
          if (
            crashSide === "corrupt-sibling" ||
            crashSide === "legacy-unbound" ||
            crashSide === "legacy-p32-upgrade" ||
            crashSide === "attention-before" ||
            crashSide === "attention-after" ||
            corruptResult
          ) {
            return (
              rows.bindingAttentionFacts.length === 1 &&
              rows.actions.some(
                (action) =>
                  action.execution_id === oldAction.executionId &&
                  action.logical_action_id === logicalActionId &&
                  action.state === "Pending" &&
                  action.observation_source_ref === null,
              )
            );
          }
          return (
            targetWorks(rows, targetObjective).length === 1 &&
            rows.actions.some(
              (action) =>
                action.execution_id === oldAction.executionId &&
                action.logical_action_id === logicalActionId &&
                action.state === "Applied",
            ) &&
            rows.controlResults.some((row) => {
              const result = JSON.parse(row.payload_json) as ControlResult;
              return (
                result.actionKind === "assign_work" &&
                result.callRef === callRef
              );
            })
          );
        },
        30_000,
      ).catch((error: unknown) => {
        const snapshot = readRows(recoveryDatabaseFile);
        throw new Error(
          `direct-child recovery did not converge: ${error instanceof Error ? error.message : String(error)}; events=${JSON.stringify(events.filter((event) => event.executionId === oldAction.executionId))}; actions=${JSON.stringify(snapshot.actions.filter((entry) => entry.execution_id === oldAction.executionId))}; commands=${JSON.stringify(snapshot.commands.filter((entry) => entry.command_id === oldRejectedCommandId || entry.result_json?.includes(targetObjective) || entry.terminal_error_json?.includes("FencingRejected")))}; approvals=${JSON.stringify(snapshot.approvals)}; assignments=${JSON.stringify(targetWorks(snapshot, targetObjective))}; daemonErrors=${fixture.daemonErrors.join(" | ")}; newDaemonErrors=${newDaemon.daemonErrors.join(" | ")}`,
        );
      });

      const assignedWorks = targetWorks(completed, targetObjective);
      expect(assignedWorks).toHaveLength(1);
      const assigned = assignedWorks[0];
      if (assigned === undefined) {
        throw new Error("Direct-child AssignWork did not persist its Work row");
      }
      expect(assigned).toMatchObject({
        project_id: project.projectId,
        workspace_id: childWorkspaceId,
        objective: targetObjective,
        why: targetWhy,
        constraints: JSON.stringify(constraints),
        completion_expectation: `the direct child owns a verified outcome for ${marker}`,
        verification_mission: JSON.stringify(mission),
        lifecycle: "Open",
        revision: 0,
      });
      expect(JSON.parse(assigned.provenance)).toEqual({
        predecessorWorkId: parentWorkId,
        reason: targetReason,
      });

      const assignedEvents = completed.workAssignedEvents.filter((event) => {
        try {
          const payload = JSON.parse(event.payload_json) as {
            workId?: string;
            workspaceId?: string;
          };
          return payload.workId === assigned.work_id;
        } catch {
          return false;
        }
      });
      expect(assignedEvents).toHaveLength(1);
      expect(assignedEvents[0]?.aggregate_ref).toBe(childWorkspaceId);

      const committed = completed.commands.filter((command) => {
        if (
          command.resolution !== "Committed" ||
          command.result_json === null
        ) {
          return false;
        }
        try {
          const result = JSON.parse(command.result_json) as {
            workId?: string;
            workspaceId?: string;
            lifecycle?: string;
            revision?: number;
          };
          return (
            result.workId === assigned.work_id &&
            result.workspaceId === childWorkspaceId &&
            result.lifecycle === "Open" &&
            result.revision === 0
          );
        } catch {
          return false;
        }
      });
      expect(committed, JSON.stringify(committed)).toHaveLength(
        corruptResult ? 0 : 1,
      );
      const highestObservedGeneration = Math.max(
        newLease.fencingGeneration ?? 0,
        ...completed.leases
          .filter((lease) => lease.execution_id === oldAction.executionId)
          .map((lease) => lease.generation),
      );
      const occurrence = `${providerTurnId}:0`;
      // Command receipts do not store source-action columns. Enumerate the
      // deterministic command ID for every generation that could have
      // submitted this exact ProviderTurn/outputPosition action.
      const actionReceiptIds = new Set(
        Array.from(
          { length: highestObservedGeneration + 1 },
          (_, generation) => {
            const seed =
              generation === 0
                ? occurrence
                : `${occurrence}:generation:${generation}`;
            return `cmd_${newUuid7("assign-work-command", seed)}`;
          },
        ),
      );
      const actionReceipts = completed.commands.filter((command) =>
        actionReceiptIds.has(command.command_id),
      );
      expect(
        new Set(actionReceipts.map((command) => command.command_id)).size,
      ).toBe(actionReceipts.length);
      expect(
        actionReceipts.filter((command) => command.resolution === "Committed"),
      ).toHaveLength(1);
      if (corruptResult) {
        expect(actionReceipts).toHaveLength(1);
        expect(actionReceipts[0]).toMatchObject({
          command_id: priorCommittedCommandId,
          resolution: "Committed",
          result_json: corruptedResultJson,
        });
        expect(JSON.stringify(completed.bindingAttentionFacts)).not.toContain(
          marker,
        );
        expect(JSON.stringify(completed.bindingAttentionEvents)).not.toContain(
          marker,
        );
      } else {
        expect(actionReceipts).toContainEqual(committed[0]);
      }
      if (oldRejectedCommandId.length > 0) {
        expect(actionReceiptIds.has(oldRejectedCommandId)).toBe(true);
        const rejectedReceipt = actionReceipts.find(
          (command) => command.command_id === oldRejectedCommandId,
        );
        if (crashSide === "before") {
          expect(rejectedReceipt).toBeUndefined();
        } else {
          expect(rejectedReceipt?.resolution).toBe("TerminalRejected");
        }
      }
      if (
        crashSide === "committed" ||
        crashSide === "corrupt-sibling" ||
        crashSide === "approval-committed" ||
        crashSide === "legacy-unbound" ||
        crashSide === "legacy-p32-upgrade" ||
        crashSide === "retired-after-commit" ||
        crashSide === "grant-revoked-after-commit" ||
        crashSide === "non-root-parent"
      ) {
        expect(committed[0]?.command_id).toBe(priorCommittedCommandId);
      } else if (corruptResult) {
        expect(actionReceipts[0]?.command_id).toBe(priorCommittedCommandId);
      } else if (crashSide === "binding-before") {
        expect(committed[0]?.command_id).not.toBe(priorCommittedCommandId);
      } else {
        expect(committed[0]?.command_id).not.toBe(oldRejectedCommandId);
      }
      expect(assignedEvents[0]?.caused_by_command_id).toBe(
        corruptResult ? priorCommittedCommandId : committed[0]?.command_id,
      );
      expect(fencedReceipts(completed)).toHaveLength(
        crashSide === "before"
          ? 0
          : crashSide === "after" || crashSide === "approval-fencing-before"
            ? 1
            : 0,
      );

      const actionRows = completed.actions.filter(
        (action) => action.execution_id === oldAction.executionId,
      );
      expect(actionRows).toHaveLength(2);
      expect(
        actionRows.filter(
          (action) =>
            action.action_kind === "assign_work" && action.call_ref === callRef,
        ),
      ).toEqual([
        expect.objectContaining({
          provider_turn_id: providerTurnId,
          logical_action_id: logicalActionId,
          action_index: 0,
          call_ref: callRef,
          action_kind: "assign_work",
          state:
            crashSide === "corrupt-sibling" ||
            crashSide === "legacy-unbound" ||
            crashSide === "legacy-p32-upgrade" ||
            crashSide === "attention-before" ||
            crashSide === "attention-after" ||
            corruptResult
              ? "Pending"
              : "Applied",
          observation_source_ref:
            crashSide === "corrupt-sibling" ||
            crashSide === "legacy-unbound" ||
            crashSide === "legacy-p32-upgrade" ||
            crashSide === "attention-before" ||
            crashSide === "attention-after" ||
            corruptResult
              ? null
              : expect.any(String),
        }),
      ]);
      expect(
        actionRows.filter((action) => action.action_kind === "list_workspaces"),
      ).toHaveLength(1);
      const listAction = actionRows.find(
        (action) => action.action_kind === "list_workspaces",
      );
      const assignmentAction = actionRows.find(
        (action) => action.action_kind === "assign_work",
      );
      expect(listAction).toMatchObject({
        provider_turn_id: expect.stringMatching(/^ptn_/u),
        logical_step_no: 0,
        repair_attempt: 0,
        action_index: 0,
        call_ref: listControlResult.callRef,
        state: "Applied",
        observation_source_ref: expect.any(String),
      });
      expect(listAction?.observation_source_ref).toBe(
        listControlRow.source_ref,
      );
      const finalListControlResults = completed.controlResults.filter((row) => {
        const result = JSON.parse(row.payload_json) as ControlResult;
        return (
          result.actionKind === "list_workspaces" &&
          result.callRef === listControlResult.callRef
        );
      });
      expect(finalListControlResults).toHaveLength(1);
      expect(finalListControlResults[0]?.source_ref).toBe(
        listAction?.observation_source_ref,
      );
      expect(assignmentAction?.provider_turn_id).toBe(providerTurnId);
      expect(assignmentAction?.logical_step_no).toBe(1);
      expect(assignmentAction?.repair_attempt).toBe(0);
      expect(listAction?.logical_action_id).not.toBe(logicalActionId);
      expect(listAction?.call_ref).not.toBe(callRef);
      const observation = completed.controlResults
        .map((row) => JSON.parse(row.payload_json) as ControlResult)
        .filter(
          (result) =>
            result.actionKind === "assign_work" && result.callRef === callRef,
        );
      if (
        crashSide === "corrupt-sibling" ||
        crashSide === "legacy-unbound" ||
        crashSide === "legacy-p32-upgrade" ||
        crashSide === "attention-before" ||
        crashSide === "attention-after" ||
        corruptResult
      ) {
        expect(observation).toHaveLength(0);
        expect(completed.bindingAttentionFacts).toHaveLength(1);
        expect(completed.bindingAttentionFacts[0]).toMatchObject({
          execution_id: oldAction.executionId,
          target_workspace_id: assignmentParentWorkspaceId,
          logical_action_id: logicalActionId,
          committed_command_id: priorCommittedCommandId,
          failure_code:
            crashSide === "legacy-unbound" || crashSide === "legacy-p32-upgrade"
              ? "LegacyUnbound"
              : "ReceiptMismatch",
        });
        const attentionEvents = completed.bindingAttentionEvents;
        expect(attentionEvents).toHaveLength(1);
        expect(attentionEvents[0]?.event_id).toBe(
          completed.bindingAttentionFacts[0]?.event_id,
        );
        expect(attentionEvents[0]).toMatchObject({
          project_id: project.projectId,
          aggregate_ref: assignmentParentWorkspaceId,
          caused_by_command_id: priorCommittedCommandId,
          correlation_ref: logicalActionId,
        });
        expect(
          JSON.parse(attentionEvents[0]?.payload_json ?? "null"),
        ).toMatchObject({
          attentionFactId:
            completed.bindingAttentionFacts[0]?.attention_fact_id,
          executionId: oldAction.executionId,
          targetWorkspaceId: assignmentParentWorkspaceId,
          logicalActionId,
          committedCommandId: priorCommittedCommandId,
          failureCode:
            crashSide === "legacy-unbound" || crashSide === "legacy-p32-upgrade"
              ? "LegacyUnbound"
              : "ReceiptMismatch",
        });
        const publicClient = makePublicClient(resultDaemon.baseUrl);
        const attention = await waitForPublic(
          () =>
            publicClient.view<{
              rows: ReadonlyArray<{
                source: string;
                severity: string;
                targetWorkspaceId: string;
                dedupKey: string;
                summaryRef: string;
              }>;
            }>("attention", { projectId: project.projectId }),
          (view) =>
            view.rows.some(
              (row) =>
                row.dedupKey ===
                completed.bindingAttentionFacts[0]?.attention_fact_id,
            ),
        );
        expect(
          attention.rows.filter(
            (row) =>
              row.dedupKey ===
              completed.bindingAttentionFacts[0]?.attention_fact_id,
          ),
        ).toEqual([
          expect.objectContaining({
            source: "AssignWorkTargetBindingFailure",
            severity: "ActionRequired",
            targetWorkspaceId: assignmentParentWorkspaceId,
            // The public summary is intentionally safe/generic; the durable
            // fact/event assertions above retain the exact typed failure code.
            summaryRef: expect.any(String),
          }),
        ]);
        const tree = await waitForPublic(
          () =>
            publicClient.view<{
              nodes: ReadonlyArray<{
                workspaceId: string;
                parentWorkspaceId: string | null;
                subtreeAttention: {
                  attention: number;
                  actionRequired: number;
                };
              }>;
            }>("responsibility-tree", { projectId: project.projectId }),
          (view) =>
            (view.nodes.find(
              (node) => node.workspaceId === assignmentParentWorkspaceId,
            )?.subtreeAttention.actionRequired ?? 0) >= 1,
        );
        expect(
          tree.nodes.find(
            (node) => node.workspaceId === assignmentParentWorkspaceId,
          )?.subtreeAttention,
        ).toMatchObject({ attention: 0, actionRequired: 1 });
        expect(
          tree.nodes.find(
            (node) => node.workspaceId === project.rootWorkspaceId,
          )?.subtreeAttention.actionRequired,
        ).toBe(1);
      } else {
        expect(observation).toHaveLength(1);
        expect(observation[0]?.status, JSON.stringify(observation[0])).toBe(
          "Succeeded",
        );
        expect(completed.bindingAttentionFacts).toHaveLength(0);
        expect(completed.bindingAttentionEvents).toHaveLength(0);
      }
      if (
        crashSide === "legacy-unbound" ||
        crashSide === "legacy-p32-upgrade"
      ) {
        expect(completed.assignWorkTargetBindings).toHaveLength(0);
      } else {
        expect(completed.assignWorkTargetBindings).toHaveLength(1);
      }
      if (
        crashSide === "corrupt-sibling" ||
        crashSide === "attention-before" ||
        crashSide === "attention-after"
      ) {
        expect(completed.assignWorkTargetBindings[0]?.target_workspace_id).toBe(
          siblingWorkspaceId,
        );
      }
      if (crashSide === "retired-after-commit") {
        expect(
          completed.workspaceLifecycles.find(
            (workspace) => workspace.workspace_id === childWorkspaceId,
          )?.lifecycle,
        ).toBe("Retired");
        expect(observation).toHaveLength(1);
      }
      if (crashSide === "grant-revoked-after-commit") {
        expect(
          completed.permissionGrants.find(
            (grant) => grant.permission_grant_id === assignmentGrantId,
          )?.state,
        ).toBe("Revoked");
        expect(observation).toHaveLength(1);
      }
      expect(
        completed.providerAttempts.filter(
          (attempt) => attempt.provider_turn_id === providerTurnId,
        ),
      ).toEqual([
        expect.objectContaining({ outcome: "Success", attempt_no: 0 }),
      ]);
      expect(listWorkspaceCalls).toHaveLength(1);
      expect(assignWorkCalls).toHaveLength(1);
      const exactApprovals = completed.approvals.filter(
        (approval) => approval.target_ref === targetWorkspaceRef,
      );
      if (
        crashSide === "approval-committed" ||
        crashSide === "approval-fencing-before"
      ) {
        expect(exactApprovals).toHaveLength(1);
        expect(exactApprovals[0]).toMatchObject({
          state: "Consumed",
          consumed_by: committed[0]?.command_id,
        });
      } else {
        expect(exactApprovals).toHaveLength(0);
      }
      expect(fixture.daemonErrors).toEqual([]);
      expect(newDaemon.daemonErrors).toEqual([]);
      expect(resultDaemon.daemonErrors).toEqual([]);
      releaseGate(fixture, "new", "action-result");
      await resultDaemon.crash();
    },
    180_000,
  );
});
