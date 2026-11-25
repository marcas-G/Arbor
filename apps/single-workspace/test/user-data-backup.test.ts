import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  makeP7App,
  p7Project,
  p7RootSession,
  p7RootWorkspace,
  p7SeedProject,
} from "../../../tests/support/p7-app.js";
import { createCurrentSchemaTestDatabaseFactory } from "../../../tests/support/schema44-database.js";
import { buildSingleWorkspaceLayer } from "../src/composition.js";
import { makeHostProjectDirectories } from "../src/project-directories.js";
import {
  createUserDataBackup,
  restoreUserDataBackup,
  verifyUserDataBackup,
} from "../src/user-data-backup.js";
import { RESTORE_INCOMPLETE_MARKER } from "../src/user-data-restore-guard.js";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

describe.skipIf(process.platform !== "linux")(
  "user SQLite + content + project registry backup",
  () => {
    let factory: Awaited<
      ReturnType<typeof createCurrentSchemaTestDatabaseFactory>
    >;
    let fixture: ReturnType<typeof factory.create>;
    const legacyFiles: string[] = [];
    beforeAll(async () => {
      factory = await createCurrentSchemaTestDatabaseFactory({
        prefix: ".user-data-backup-",
      });
    }, 120_000);
    beforeEach(async () => {
      fixture = factory.create();
      await Effect.runPromise(
        Effect.scoped(
          Effect.provide(p7SeedProject, makeP7App(fixture.databaseFilename)),
        ),
      );
    });
    afterEach(() => {
      for (const path of legacyFiles.splice(0)) rmSync(path, { force: true });
      fixture?.cleanup();
    });
    afterAll(() => factory?.cleanup());
    const backupPath = () => join(fixture.directory, "backup");
    const restoredPath = () => join(fixture.directory, "restored");
    const sourceBlob = (bytes: string) => {
      mkdirSync(`${fixture.databaseFilename}.blobs`, {
        mode: 0o700,
        recursive: true,
      });
      const ref = digest(bytes);
      writeFileSync(join(`${fixture.databaseFilename}.blobs`, ref), bytes, {
        mode: 0o600,
      });
      return ref;
    };
    const sessionAttachment = (
      database: DatabaseSync,
      ref: string,
      sequence = 1,
    ) => {
      database
        .prepare(
          "INSERT INTO session_entries(session_id,sequence,entry_kind,item_type,schema_version,context_epoch,payload_json,created_at) VALUES (?,?,'ModelOutput','AttachmentRef',2,0,?,'t')",
        )
        .run(
          p7RootSession,
          sequence,
          JSON.stringify({
            _tag: "AttachmentRef",
            ref,
            mediaType: "application/vnd.arbor.provider-reasoning+json",
            trust: "DataOnly",
          }),
        );
    };

    it("captures committed WAL rows, real content bytes and directory selectors, then restores without changing the source", async () => {
      const database = new DatabaseSync(fixture.databaseFilename);
      try {
        database.exec(
          "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA foreign_keys=ON",
        );
        const ref = sourceBlob(
          "real content from a committed WAL-backed session",
        );
        sessionAttachment(database, ref);
        const selected = join(fixture.directory, "project");
        mkdirSync(selected);
        const registryDirectory = `${fixture.databaseFilename}.project-directories`;
        const directories = makeHostProjectDirectories({ registryDirectory });
        const selection = await directories.prepare(selected, false);
        const before = database
          .prepare("SELECT count(*) AS count FROM session_entries")
          .get()?.count;
        expect(
          statSync(`${fixture.databaseFilename}-wal`).size,
        ).toBeGreaterThan(0);
        const report = await createUserDataBackup(
          fixture.databaseFilename,
          backupPath(),
        );
        expect(
          report.files.some((file) => file.path === `arbor.db.blobs/${ref}`),
        ).toBe(true);
        expect(verifyUserDataBackup(backupPath())).toEqual(report);
        expect(verifyUserDataBackup(backupPath())).toEqual(report); // verification must not leave WAL/SHM.
        await restoreUserDataBackup(backupPath(), restoredPath());
        const restored = new DatabaseSync(join(restoredPath(), "arbor.db"), {
          readOnly: true,
        });
        try {
          expect(
            restored
              .prepare("SELECT count(*) AS count FROM session_entries")
              .get()?.count,
          ).toBe(before);
        } finally {
          restored.close();
        }
        expect(
          readFileSync(join(restoredPath(), "arbor.db.blobs", ref), "utf8"),
        ).toBe("real content from a committed WAL-backed session");
        const restoredRegistry = makeHostProjectDirectories({
          registryDirectory: join(
            restoredPath(),
            "arbor.db.project-directories",
          ),
        });
        expect(
          await Effect.runPromise(
            restoredRegistry.profiles.resolve(
              selection.selection.resourceProfileRef,
              "v1",
            ),
          ),
        ).toMatchObject({ value: { canonicalAddress: { path: selected } } });
        expect(
          database
            .prepare("SELECT count(*) AS count FROM session_entries")
            .get()?.count,
        ).toBe(before);
        expect(statSync(join(backupPath(), "arbor.db")).mode & 0o077).toBe(0);
      } finally {
        database.close();
      }
    });

    it("copies referenced legacy bytes without importing into the source or sweeping unrelated legacy content", async () => {
      const bytes = `legacy attachment ${randomUUID()}`;
      const ref = digest(bytes);
      const unrelated = digest(`unrelated ${randomUUID()}`);
      const legacyRoot = join(tmpdir(), "arbor-blobs");
      mkdirSync(legacyRoot, { mode: 0o700, recursive: true });
      for (const [name, value] of [
        [ref, bytes],
        [unrelated, "not this installation"],
      ]) {
        const path = join(legacyRoot, name as string);
        writeFileSync(path, value as string, { flag: "wx", mode: 0o600 });
        legacyFiles.push(path);
      }
      const database = new DatabaseSync(fixture.databaseFilename);
      try {
        sessionAttachment(database, ref);
      } finally {
        database.close();
      }
      const report = await createUserDataBackup(
        fixture.databaseFilename,
        backupPath(),
      );
      expect(
        report.files.filter((file) => file.path.startsWith("arbor.db.blobs/")),
      ).toHaveLength(1);
      expect(
        readFileSync(join(backupPath(), "arbor.db.blobs", ref), "utf8"),
      ).toBe(bytes);
      expect(existsSync(join(`${fixture.databaseFilename}.blobs`, ref))).toBe(
        false,
      );
    });

    it("includes historical verification receipts and Summary checkpoints but leaves provider continuation tokens opaque", async () => {
      const receiptRef = sourceBlob("retained verification conclusion");
      const summaryRef = sourceBlob("conversation summary");
      const database = new DatabaseSync(fixture.databaseFilename);
      try {
        database
          .prepare(
            "INSERT INTO commands(command_id,project_id,semantic_request_fingerprint,schema_version,fingerprint_algorithm_version,resolution,result_json,created_at,settled_at) VALUES ('receipt',?,'fingerprint','1',1,'Committed',?,'t','t')",
          )
          .run(
            p7Project,
            JSON.stringify({
              verificationId: "vrf_history",
              state: "Concluded",
              verdict: "Pass",
              summaryRef: receiptRef,
            }),
          );
        database
          .prepare(
            "INSERT INTO conversation_checkpoint_owners(root_workspace_id,context_epoch,checkpoint_kind,checkpoint_ref,updated_at) VALUES (?,0,'Summary',?,'t')",
          )
          .run(p7RootWorkspace, summaryRef);
        database
          .prepare(
            "INSERT INTO session_entries(session_id,sequence,entry_kind,item_type,schema_version,context_epoch,payload_json,created_at) VALUES (?,1,'Input','UserMessage',2,0,?,'t')",
          )
          .run(
            p7RootSession,
            JSON.stringify({ _tag: "UserMessage", text: "d".repeat(64) }),
          );
        // Legacy fallback is required here: remove the persistent copies.
        const legacyRoot = join(tmpdir(), "arbor-blobs");
        mkdirSync(legacyRoot, { recursive: true, mode: 0o700 });
        for (const [ref, bytes] of [
          [receiptRef, "retained verification conclusion"],
          [summaryRef, "conversation summary"],
        ]) {
          const file = join(legacyRoot, ref as string);
          if (!existsSync(file)) {
            writeFileSync(file, bytes as string, { mode: 0o600 });
            legacyFiles.push(file);
          }
          unlinkSync(join(`${fixture.databaseFilename}.blobs`, ref as string));
        }
        const report = await createUserDataBackup(
          fixture.databaseFilename,
          backupPath(),
        );
        expect(
          report.files.filter((file) =>
            file.path.startsWith("arbor.db.blobs/"),
          ),
        ).toHaveLength(2);
        database
          .prepare(
            "UPDATE conversation_checkpoint_owners SET checkpoint_kind='ProviderNative',checkpoint_ref=?,binding_fingerprint=?,source_manifest_json='{}' WHERE root_workspace_id=?",
          )
          .run("c".repeat(64), "binding", p7RootWorkspace);
        await expect(
          createUserDataBackup(
            fixture.databaseFilename,
            join(fixture.directory, "native-token-backup"),
          ),
        ).resolves.toBeDefined();
      } finally {
        database.close();
      }
    });

    it("keeps checksum-only delivery summaries inline and detects omitted referenced bytes independently of the inventory", async () => {
      const database = new DatabaseSync(fixture.databaseFilename);
      const ref = sourceBlob("must be present even if an inventory is edited");
      try {
        sessionAttachment(database, ref);
        database
          .prepare(
            "INSERT INTO messages(message_id,sender_workspace_id,recipient_workspace_id,kind,body_ref,sent_at) VALUES ('checksum-delivery',?,?,'Deliver',?,'t')",
          )
          .run(p7RootWorkspace, p7RootWorkspace, "e".repeat(64));
      } finally {
        database.close();
      }
      const report = await createUserDataBackup(
        fixture.databaseFilename,
        backupPath(),
      );
      expect(verifyUserDataBackup(backupPath())).toEqual(report);
      writeFileSync(
        join(backupPath(), "backup.json"),
        JSON.stringify({
          ...report,
          files: report.files.filter(
            (file) => file.path !== `arbor.db.blobs/${ref}`,
          ),
        }),
      );
      unlinkSync(join(backupPath(), "arbor.db.blobs", ref));
      expect(() => verifyUserDataBackup(backupPath())).toThrow(
        "backup-omits-referenced-content",
      );
    });

    it("fails on missing or corrupt referenced content and does not finalize a partial backup", async () => {
      const ref = digest(`missing ${randomUUID()}`);
      const database = new DatabaseSync(fixture.databaseFilename);
      try {
        sessionAttachment(database, ref);
      } finally {
        database.close();
      }
      await expect(
        createUserDataBackup(fixture.databaseFilename, backupPath()),
      ).rejects.toThrow();
      expect(existsSync(join(backupPath(), "backup.json"))).toBe(false);
      expect(() => verifyUserDataBackup(backupPath())).toThrow();
      mkdirSync(`${fixture.databaseFilename}.blobs`, {
        recursive: true,
        mode: 0o700,
      });
      writeFileSync(
        join(`${fixture.databaseFilename}.blobs`, ref),
        "wrong bytes",
        { mode: 0o600 },
      );
      await expect(
        createUserDataBackup(
          fixture.databaseFilename,
          join(fixture.directory, "corrupt"),
        ),
      ).rejects.toThrow("blob-content-hash-mismatch");
    });

    it("refuses overwrites, symlinks, altered files and path traversal in the inventory", async () => {
      const ref = sourceBlob("content that must remain intact");
      await createUserDataBackup(fixture.databaseFilename, backupPath());
      const manifestPath = join(backupPath(), "backup.json");
      const original = readFileSync(manifestPath, "utf8");
      await expect(
        createUserDataBackup(fixture.databaseFilename, backupPath()),
      ).rejects.toThrow();
      mkdirSync(restoredPath());
      writeFileSync(join(restoredPath(), "keep.txt"), "keep me");
      await expect(
        restoreUserDataBackup(backupPath(), restoredPath()),
      ).rejects.toThrow();
      expect(readFileSync(join(restoredPath(), "keep.txt"), "utf8")).toBe(
        "keep me",
      );
      const path = join(backupPath(), "arbor.db.blobs", ref);
      unlinkSync(path);
      symlinkSync(join(`${fixture.databaseFilename}.blobs`, ref), path);
      expect(() => verifyUserDataBackup(backupPath())).toThrow();
      unlinkSync(path);
      writeFileSync(path, "modified", { mode: 0o600 });
      expect(() => verifyUserDataBackup(backupPath())).toThrow(
        "backup-file-missing-or-corrupt",
      );
      writeFileSync(path, "content that must remain intact");
      const modified = JSON.parse(original);
      modified.files[0].path = "../arbor.db";
      writeFileSync(manifestPath, JSON.stringify(modified));
      expect(() => verifyUserDataBackup(backupPath())).toThrow(
        "invalid-backup-inventory",
      );
    });

    it("invalidates pre-restore worker identities and expires leases before allowing a normal startup", async () => {
      const database = new DatabaseSync(fixture.databaseFilename);
      try {
        database
          .prepare(
            "INSERT INTO executions(execution_id,project_id,binding_kind,workspace_id,episode_kind,episode_ref,episode_revision,session_id,admitted_at) VALUES ('exe_restore',?,'workspace',?,'ConversationResponseEpisode','message',0,?,'t')",
          )
          .run(p7Project, p7RootWorkspace, p7RootSession);
        database.exec(
          "INSERT INTO execution_leases(execution_id,worker_id,worker_incarnation_id,generation,expires_at,updated_at) VALUES ('exe_restore','old-worker','old-incarnation',7,'2999-01-01T00:00:00Z','t')",
        );
      } finally {
        database.close();
      }
      await createUserDataBackup(fixture.databaseFilename, backupPath());
      expect(await restoreUserDataBackup(backupPath(), restoredPath())).toEqual(
        { invalidatedLeases: 1 },
      );
      const restored = new DatabaseSync(join(restoredPath(), "arbor.db"), {
        readOnly: true,
      });
      try {
        expect(
          restored
            .prepare(
              "SELECT worker_incarnation_id,generation,expires_at FROM execution_leases",
            )
            .get(),
        ).toMatchObject({
          worker_incarnation_id: "",
          generation: 8,
          expires_at: "1970-01-01T00:00:00.000Z",
        });
      } finally {
        restored.close();
      }
      writeFileSync(
        join(restoredPath(), RESTORE_INCOMPLETE_MARKER),
        "interrupted",
      );
      expect(() =>
        buildSingleWorkspaceLayer({
          databaseFile: join(restoredPath(), "arbor.db"),
        }),
      ).toThrow("restore is incomplete");
    });

    it("uses the existing SQLite VFS permit to refuse a separate live runtime process", async () => {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import {p39WriterLockFilename,p39WriterLockLayer,acquireP39RuntimeWriterPermit,releaseP39WriterPermit} from '@arbor/persistence-sqlite';
      import {Effect} from 'effect';
      const lock = p39WriterLockFilename(process.argv[1]);
      await Effect.runPromise(Effect.scoped(Effect.provide(Effect.acquireUseRelease(
        acquireP39RuntimeWriterPermit(),
        () => Effect.promise(() => new Promise(resolve => {process.stdout.write('ready\\n'); process.stdin.once('data', resolve);})),
        releaseP39WriterPermit),p39WriterLockLayer(lock,1000))));
    `,
          fixture.databaseFilename,
        ],
        {
          cwd: resolve("apps/single-workspace"),
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      try {
        const ready = await Promise.race([
          once(child.stdout, "data").then(([value]) => String(value)),
          once(child, "exit").then(() => "exited"),
        ]);
        expect(ready).toBe("ready\n");
        await expect(
          createUserDataBackup(fixture.databaseFilename, backupPath()),
        ).rejects.toThrow("maintenance-failed");
        expect(existsSync(backupPath())).toBe(false);
      } finally {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
      await expect(
        createUserDataBackup(fixture.databaseFilename, backupPath()),
      ).resolves.toBeDefined();
    });
  },
);
