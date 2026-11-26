import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION } from "../../../../adapters/persistence-sqlite/src/index.js";
import { shellPolicy } from "../../../../packages/tool-runtime/src/tools/shell.js";
import {
  windowsAclQualificationAvailable,
  windowsTestEnvironment,
} from "../../../support/windows-deployment-qualification.js";
import { createCurrentSchemaTestDatabase } from "../../../support/schema44-database.js";
import {
  archiveProductionFixtureFailure,
  writeProductionFixtureArchiveSkipped,
} from "../../support/fixture-failure-evidence.js";
import type { ProductionFixture } from "../../support/production-fixture.js";
import {
  freshWorkspacePurpose,
  safeInitialShellCommand,
  shellCommandForWorkspacePurpose,
} from "./support.js";

interface FixtureArchiveAclSnapshot {
  readonly protected: boolean;
  readonly currentSid: string;
  readonly rules: ReadonlyArray<{
    readonly sid: string;
    readonly rights: string;
    readonly type: string;
    readonly inherited: boolean;
  }>;
}

const fixtureArchiveAclSnapshot = (path: string): FixtureArchiveAclSnapshot => {
  const encodedPath = Buffer.from(path, "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))`,
    "$item=Get-Item -LiteralPath $p -Force",
    "$acl=$item.GetAccessControl()",
    "$current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$rules=@($acl.Access | ForEach-Object { [pscustomobject]@{ sid=$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value; rights=$_.FileSystemRights.ToString(); type=$_.AccessControlType.ToString(); inherited=$_.IsInherited } })",
    "[pscustomobject]@{ protected=$acl.AreAccessRulesProtected; currentSid=$current; rules=$rules } | ConvertTo-Json -Depth 4 -Compress",
  ].join(";");
  return JSON.parse(
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        windowsHide: true,
        env: windowsTestEnvironment(),
      },
    ),
  ) as FixtureArchiveAclSnapshot;
};

const staticPreparedSqlFrom = (filename: string): ReadonlyArray<string> => {
  const source = readFileSync(filename, "utf8");
  const preparedCalls = source.match(/\.prepare\(/gu) ?? [];
  const schemaLoopCalls = source.match(/\.prepare\(\s*statement\s*\)/gu) ?? [];
  const sql: string[] = [];
  const matcher = /\.prepare\(\s*(?:`([\s\S]*?)`|"([^"]*)")/gu;
  for (const match of source.matchAll(matcher)) {
    const statement = match[1] ?? match[2];
    if (statement === undefined || statement.includes("${")) {
      throw new Error(`non-static diagnostic SQL in ${filename}`);
    }
    sql.push(statement);
  }
  const expectedSchemaLoopCalls = source.includes("const staticPreparedSqlFrom")
    ? 1
    : 0;
  if (
    schemaLoopCalls.length !== expectedSchemaLoopCalls ||
    sql.length + schemaLoopCalls.length !== preparedCalls.length
  ) {
    throw new Error(`uncollected diagnostic SQL in ${filename}`);
  }
  return sql;
};

describe("V6 fresh Work uses the accepted pre-intent approval source", () => {
  it("routes fresh Get-Date through EAP while preserving the safe terminal command", () => {
    const initialCommand = shellCommandForWorkspacePurpose({
      context: "V6 E registry drift",
      safeCommand: safeInitialShellCommand,
    });
    const freshCommand = shellCommandForWorkspacePurpose({
      context: `workspace purpose: ${freshWorkspacePurpose}`,
      safeCommand: safeInitialShellCommand,
    });
    expect(initialCommand).toBe("git status --short");
    expect(shellPolicy(initialCommand)).toBe("Allow");
    expect(freshCommand).toBe("Get-Date");
    expect(shellPolicy(freshCommand)).toBe("RequireApproval");
  });
});

describe("V6 diagnostic SQL follows current persistence schema", () => {
  it("creates a missing safe result directory before archiving a fixture", () => {
    const schemaRoot = mkdtempSync(
      resolve(`.arbor-functional-schema44-v6-archive-${randomUUID()}-`),
    );
    const fixtureDirectory = join(schemaRoot, `fixture-${randomUUID()}`);
    const resultDirectory = resolve(
      ".test-results",
      `v6-archive-helper-${randomUUID()}`,
    );
    mkdirSync(fixtureDirectory);
    const databaseFile = join(fixtureDirectory, "arbor-functional.db");
    writeFileSync(databaseFile, "fixture archive regression");
    const fixture = {
      directory: fixtureDirectory,
      databaseFile,
      daemonsExited: () => true,
    } as unknown as ProductionFixture;
    try {
      expect(existsSync(resultDirectory)).toBe(false);
      const archivedDirectory = archiveProductionFixtureFailure({
        fixture,
        resultDirectory,
        artifactPrefix: "v6-archive-helper",
        evidence: { testName: "missing-result-directory" },
      });
      expect(existsSync(resultDirectory)).toBe(true);
      expect(existsSync(join(archivedDirectory, "failure-evidence.json"))).toBe(
        true,
      );
      expect(existsSync(join(archivedDirectory, "arbor-functional.db"))).toBe(
        true,
      );
      const archiveSkippedPath = writeProductionFixtureArchiveSkipped({
        fixture,
        resultDirectory,
        evidence: { testName: "private-result-directory" },
      });
      if (process.platform === "win32") {
        expect(windowsAclQualificationAvailable()).toBe(true);
        const directoryAcl = fixtureArchiveAclSnapshot(resultDirectory);
        const expectedSids = [
          directoryAcl.currentSid,
          "S-1-5-18",
          "S-1-5-32-544",
        ].sort();
        expect(directoryAcl.protected).toBe(true);
        expect(directoryAcl.rules.map((rule) => rule.sid).sort()).toEqual(
          expectedSids,
        );
        expect(
          directoryAcl.rules.every(
            (rule) =>
              rule.rights === "FullControl" &&
              rule.type === "Allow" &&
              !rule.inherited,
          ),
        ).toBe(true);
        const fileAcl = fixtureArchiveAclSnapshot(archiveSkippedPath);
        expect(fileAcl.rules.map((rule) => rule.sid).sort()).toEqual(
          expectedSids,
        );
        expect(
          fileAcl.rules.every(
            (rule) =>
              rule.rights === "FullControl" &&
              rule.type === "Allow" &&
              rule.inherited,
          ),
        ).toBe(true);
      } else {
        expect(statSync(resultDirectory).mode & 0o777).toBe(0o700);
        expect(statSync(archiveSkippedPath).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(schemaRoot, { recursive: true, force: true });
      if (existsSync(resultDirectory))
        rmSync(resultDirectory, { recursive: true, force: true });
    }
  });

  it("prepares every static test/support query against the current schema", async () => {
    const fixture = await createCurrentSchemaTestDatabase({
      prefix: "v6-diagnostic-schema-",
    });
    try {
      const db = new DatabaseSync(fixture.databaseFilename, { readOnly: true });
      try {
        const schemaVersion = Number(
          (
            db.prepare("PRAGMA user_version").get() as {
              user_version: number;
            }
          ).user_version,
        );
        expect(schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
        const suiteDirectory = dirname(import.meta.filename);
        const diagnosticSql = [
          ...readdirSync(suiteDirectory)
            .filter((filename) => filename.endsWith(".ts"))
            .sort()
            .flatMap((filename) =>
              staticPreparedSqlFrom(join(suiteDirectory, filename)),
            ),
          ...staticPreparedSqlFrom(
            resolve("tests/functional/support/ah-durable-snapshot.ts"),
          ),
        ];
        expect(diagnosticSql.length).toBeGreaterThan(40);
        for (const statement of diagnosticSql) db.prepare(statement);
      } finally {
        db.close();
      }
    } finally {
      fixture.cleanup();
    }
  });
});
