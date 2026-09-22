import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";

/** P6 `05` §1 (D4). The four Prompt Program families P6 owns, plus the two
 * P8 families (P9 Verification `02` §4, P14 Query/Inspection `05` §2).
 * Unlike the P3 slot-contract programs (model-context `prompt.ts`), these
 * are versioned text artifacts with a dual version header: contractRevision
 * pins the mandatory-clause contract; textVersion + textHash pin the text. */

export type P6ProgramFamilyId =
  | "p6-formation"
  | "p6-communication"
  | "p6-bootstrap"
  | "p6-human-steer";

/** P8-010: the two Program families P8 owns (P8 `02` §4 / `05` §2). */
export type P8ProgramFamilyId = "p8-verification" | "p8-query-inspection";

/** Every family id served by the shared program infrastructure. */
export type ProgramFamilyId = P6ProgramFamilyId | P8ProgramFamilyId;

export interface ProgramRegistryEntry {
  readonly familyId: ProgramFamilyId;
  readonly contractRevision: string;
  readonly textVersion: number;
  readonly textFile: string;
  readonly mandatoryClauses: ReadonlyArray<string>;
  readonly forbiddenPhrases: ReadonlyArray<string>;
}

export interface ProgramHeader {
  readonly familyId: string;
  readonly contractRevision: string;
  readonly textVersion: number;
  readonly textHash: string;
  readonly changelog: string;
}

export interface LoadedProgram {
  readonly text: string;
  readonly meta: ProgramHeader;
}

export type ProgramError =
  | {
      readonly _tag: "UnknownProgramFamily";
      readonly familyId: string;
    }
  | {
      readonly _tag: "ProgramFileNotFound";
      readonly familyId: ProgramFamilyId;
      readonly path: string;
    }
  | {
      readonly _tag: "ProgramHeaderInvalid";
      readonly familyId: ProgramFamilyId;
      readonly reason: string;
    }
  | {
      readonly _tag: "ProgramHashMismatch";
      readonly familyId: ProgramFamilyId;
      readonly expected: string;
      readonly actual: string;
    };

const CONTRACT_REVISION = "P6-05@1";

/** Mandatory clauses are the `05` §2 text-block lines per family, stated as
 * key assertion fragments; forbidden phrases carry the `05` §2 prohibition
 * lines (formation: no first-layer self-execution; communication: no
 * invented "Deliver" kind, no text-layer preemption). Bootstrap and
 * human-steer have no dedicated prohibition line in `05` §2. */
export const PROGRAM_REGISTRY: ReadonlyArray<ProgramRegistryEntry> = [
  {
    familyId: "p6-formation",
    contractRevision: CONTRACT_REVISION,
    textVersion: 1,
    textFile: "formation/v1.md",
    mandatoryClauses: [
      "Independence",
      "Parallel value",
      "Context isolability",
      "Working-style difference",
      "Single-agent cost",
      "ChildWorkspaceProposal",
      "responsibilityDraft",
      "resourceBoundaryDraft",
      "initialWork",
      "First-layer proposals must anticipate the human gate",
      "do the work itself, delegate serially, or delegate in parallel",
      "must not substitute formation for Dependency",
    ],
    forbiddenPhrases: ["self-execute first layer"],
  },
  {
    familyId: "p6-communication",
    contractRevision: CONTRACT_REVISION,
    textVersion: 1,
    textFile: "communication/v1.md",
    mandatoryClauses: [
      "asks for an observation",
      "exposes a finding upward",
      "asks for a ruling",
      "answers a prior message",
      "must carry the correlationId",
      "Sending a message is not confirmation",
      "bodyRef plus a bounded summary",
      "carries urgency Normal",
      "must not invent escalation, interruption, or priority semantics",
      "A Report is not a delivery",
      "dependency satisfaction is forbidden",
    ],
    forbiddenPhrases: ["Deliver", "preempt"],
  },
  {
    familyId: "p6-bootstrap",
    contractRevision: CONTRACT_REVISION,
    textVersion: 1,
    textFile: "bootstrap/v1.md",
    mandatoryClauses: [
      "five permitted sources",
      "Responsibility (including revision)",
      "ResourceBoundary",
      "completionExpectation",
      "proposal.rationale",
      "Project-level scoped instructions",
      "CanonicalInstruction",
      "DataOnly",
      "no parent memory inheritance",
      "does not replicate the parent Session",
      "restates its Responsibility boundary",
      "initialWork goal",
    ],
    forbiddenPhrases: [],
  },
  {
    familyId: "p6-human-steer",
    contractRevision: CONTRACT_REVISION,
    textVersion: 1,
    textFile: "human-steer/v1.md",
    mandatoryClauses: [
      "merge the guidance into the existing line of work",
      "restore autonomy",
      "Do not wait for step-by-step human confirmation",
      "send one DecisionRequest",
      "repeated Reports",
      "Normal does not change execution pace",
      "After a Critical steer",
      "first action is to re-read the Canonical Control surface",
    ],
    forbiddenPhrases: [],
  },
  {
    // P8 `02` §4 (P9 family): the six mandatory clause lines plus the
    // evidence-binding duty; forbidden phrases are the auto-PASS family
    // ("no problem found" must never be worded as an automatic pass).
    familyId: "p8-verification",
    contractRevision: "P8-02@1",
    textVersion: 1,
    textFile: "verification/v1.md",
    mandatoryClauses: [
      "draft an investigation plan",
      "Direct tool observation outranks any document",
      "a document outranks a hypothesis",
      "exactly one verdict of Pass, Fail, or Unknown",
      "Finding no problem is not Pass",
      "at least one boundary case or counterexample",
      "insufficient evidence",
      "no self-instruction that modifies Producer results",
      "The Verifier judges; the Producer fixes; the Parent accepts",
      "evidence reference",
    ],
    forbiddenPhrases: ["auto-pass", "silently pass"],
  },
  {
    // P8 `05` §2 (P14 family): read-only discipline, scope declaration,
    // source citation, results as Messages/observations — never canonical
    // mutations. Forbidden phrases are write-instruction verbs.
    familyId: "p8-query-inspection",
    contractRevision: "P8-05@1",
    textVersion: 1,
    textFile: "query-inspection/v1.md",
    mandatoryClauses: [
      "This execution is read-only",
      "no instruction that changes canonical state",
      "declaring scope",
      "cites its source",
      "delivered as a Message (Report or Reply) or as an observation",
      "never as a change to canonical state",
    ],
    forbiddenPhrases: ["mutate", "insert", "upsert", "delete"],
  },
];

const PROGRAMS_DIR = fileURLToPath(
  new URL("../promptPrograms", import.meta.url),
);

export const programFilePath = (entry: ProgramRegistryEntry): string =>
  join(PROGRAMS_DIR, entry.textFile);

const HEADER_KEYS = [
  "familyId",
  "contractRevision",
  "textVersion",
  "textHash",
  "changelog",
] as const;

export const sha256Hex = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

export type ProgramDocumentParseResult =
  | { readonly ok: true; readonly header: ProgramHeader; readonly body: string }
  | { readonly ok: false; readonly reason: string };

/** The body runs from the first section heading to end of file; the dual
 * version header is everything before it (P6 `05` §4 rule 1). */
export const parseProgramDocument = (
  content: string,
): ProgramDocumentParseResult => {
  const heading = content.match(/^#[^\n]*$/m);
  if (heading === null || heading.index === undefined) {
    return { ok: false, reason: "no section heading found" };
  }
  const fields = new Map<string, string>();
  for (const line of content.slice(0, heading.index).split("\n")) {
    const field = /^([a-zA-Z]+):\s*(.*)$/.exec(line);
    if (field !== null) {
      fields.set(field[1] ?? "", (field[2] ?? "").trim());
    }
  }
  const missing = HEADER_KEYS.filter((key) => !fields.has(key));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `missing header fields: ${missing.join(", ")}`,
    };
  }
  const textVersion = Number(fields.get("textVersion"));
  if (!Number.isInteger(textVersion) || textVersion < 1) {
    return {
      ok: false,
      reason: `invalid textVersion: ${fields.get("textVersion")}`,
    };
  }
  return {
    ok: true,
    header: {
      familyId: fields.get("familyId") ?? "",
      contractRevision: fields.get("contractRevision") ?? "",
      textVersion,
      textHash: fields.get("textHash") ?? "",
      changelog: fields.get("changelog") ?? "",
    },
    body: content.slice(heading.index),
  };
};

const registryEntry = (
  familyId: ProgramFamilyId,
): ProgramRegistryEntry | undefined =>
  PROGRAM_REGISTRY.find((entry) => entry.familyId === familyId);

/** Loads and verifies a program from in-memory content: header must be
 * complete, name the right family, and carry the sha256 of its body. */
export const loadProgramContent = (
  familyId: ProgramFamilyId,
  content: string,
): Effect.Effect<LoadedProgram, ProgramError> =>
  Effect.suspend(() => {
    const entry = registryEntry(familyId);
    if (entry === undefined) {
      return Effect.fail<ProgramError>({
        _tag: "UnknownProgramFamily",
        familyId,
      });
    }
    const parsed = parseProgramDocument(content);
    if (!parsed.ok) {
      return Effect.fail<ProgramError>({
        _tag: "ProgramHeaderInvalid",
        familyId,
        reason: parsed.reason,
      });
    }
    if (parsed.header.familyId !== familyId) {
      return Effect.fail<ProgramError>({
        _tag: "ProgramHeaderInvalid",
        familyId,
        reason: `header familyId mismatch: ${parsed.header.familyId}`,
      });
    }
    const actual = sha256Hex(parsed.body);
    if (actual !== parsed.header.textHash) {
      return Effect.fail<ProgramError>({
        _tag: "ProgramHashMismatch",
        familyId,
        expected: parsed.header.textHash,
        actual,
      });
    }
    return Effect.succeed<LoadedProgram>({
      text: parsed.body,
      meta: parsed.header,
    });
  });

/** P6 `05` §4 rule 5. Runtime load path: read the versioned file and verify
 * its textHash before use. */
export const loadProgram = (
  familyId: ProgramFamilyId,
): Effect.Effect<LoadedProgram, ProgramError> =>
  Effect.suspend(() => {
    const entry = registryEntry(familyId);
    if (entry === undefined) {
      return Effect.fail<ProgramError>({
        _tag: "UnknownProgramFamily",
        familyId,
      });
    }
    const path = programFilePath(entry);
    try {
      return loadProgramContent(familyId, readFileSync(path, "utf8"));
    } catch {
      return Effect.fail<ProgramError>({
        _tag: "ProgramFileNotFound",
        familyId,
        path,
      });
    }
  });

export interface FamilyEvalResult {
  readonly familyId: ProgramFamilyId;
  readonly headerComplete: boolean;
  readonly versionGate: boolean;
  readonly hashMatches: boolean;
  readonly missingClauses: ReadonlyArray<string>;
  readonly presentForbidden: ReadonlyArray<string>;
  readonly passed: boolean;
}

const normalize = (text: string): string => text.replace(/\s+/g, " ");

const clausePresent = (body: string, clause: string): boolean =>
  normalize(body).includes(normalize(clause));

const forbiddenPresent = (body: string, phrase: string): boolean =>
  body.includes(phrase);

const failedEval = (
  familyId: ProgramFamilyId,
  reason: string,
): FamilyEvalResult => ({
  familyId,
  headerComplete: false,
  versionGate: false,
  hashMatches: false,
  missingClauses: [reason],
  presentForbidden: [],
  passed: false,
});

/** E1–E3 static face (P6 `05` §3): header completeness, hash match, every
 * mandatory clause of `05` §2 present in the body, and no forbidden phrase
 * from the `05` §2 prohibition lines. Pure; accepts synthetic entries for
 * negative tests. */
export const evaluateProgramContent = (
  entry: ProgramRegistryEntry,
  content: string,
): FamilyEvalResult => {
  const parsed = parseProgramDocument(content);
  if (!parsed.ok) {
    return failedEval(entry.familyId, `header invalid: ${parsed.reason}`);
  }
  const headerComplete =
    parsed.header.familyId.length > 0 &&
    parsed.header.contractRevision.length > 0 &&
    parsed.header.textHash.length > 0 &&
    parsed.header.changelog.length > 0;
  const versionGate =
    parsed.header.familyId === entry.familyId &&
    parsed.header.contractRevision === entry.contractRevision &&
    parsed.header.textVersion === entry.textVersion;
  const hashMatches = sha256Hex(parsed.body) === parsed.header.textHash;
  const missingClauses = entry.mandatoryClauses.filter(
    (clause) => !clausePresent(parsed.body, clause),
  );
  const presentForbidden = entry.forbiddenPhrases.filter((phrase) =>
    forbiddenPresent(parsed.body, phrase),
  );
  return {
    familyId: entry.familyId,
    headerComplete,
    versionGate,
    hashMatches,
    missingClauses,
    presentForbidden,
    passed:
      headerComplete &&
      versionGate &&
      hashMatches &&
      missingClauses.length === 0 &&
      presentForbidden.length === 0,
  };
};

/** Runs the E1–E4 static gate for every registered family; load failures
 * surface as failed per-family results, never as a crashed eval. */
export const evalAllPrograms = (): Effect.Effect<
  ReadonlyArray<FamilyEvalResult>,
  never
> =>
  Effect.sync(() =>
    PROGRAM_REGISTRY.map((entry) => {
      try {
        return evaluateProgramContent(
          entry,
          readFileSync(programFilePath(entry), "utf8"),
        );
      } catch {
        return failedEval(entry.familyId, "program file unreadable");
      }
    }),
  );

/** E4 version gate (P6 `05` §4 rule 2): the registry textVersion, the file
 * header textVersion, and the expected version must agree before the text
 * is considered eval-passed. */
export const verifyEvalGate = (
  familyId: ProgramFamilyId,
  textVersion: number,
): Effect.Effect<boolean, ProgramError> =>
  Effect.suspend(() => {
    const entry = registryEntry(familyId);
    if (entry === undefined) {
      return Effect.fail<ProgramError>({
        _tag: "UnknownProgramFamily",
        familyId,
      });
    }
    return Effect.map(
      loadProgram(familyId),
      (program) =>
        program.meta.textVersion === textVersion &&
        entry.textVersion === textVersion,
    );
  });

export interface ProgramGateReport {
  readonly results: ReadonlyArray<FamilyEvalResult>;
  readonly passed: boolean;
}

export type ProgramGateError = {
  readonly _tag: "ProgramGateError";
  readonly failures: ReadonlyArray<FamilyEvalResult>;
};

/** CI gate for the `pnpm check` chain: every family must pass E1–E4 or the
 * gate fails loudly with the failing family results. */
export const assertProgramGate = (): Effect.Effect<
  ProgramGateReport,
  ProgramGateError
> =>
  Effect.flatMap(evalAllPrograms(), (results) => {
    const failures = results.filter((result) => !result.passed);
    return failures.length === 0
      ? Effect.succeed({ results, passed: true })
      : Effect.fail({ _tag: "ProgramGateError", failures });
  });
