import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Effect } from "effect";
import {
  bounded,
  type ToolExecutionResult,
  type ToolExecutor,
} from "../runtime.js";
import { resolveSandboxTarget } from "../sandbox-target.js";
import { executeFilesystemTool } from "./filesystem-result.js";

const sameLines = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length &&
  left.every((line, index) => line === right[index]);

interface PatchApplication {
  readonly ok: true;
  readonly content: string;
  readonly hunks: number;
  readonly changed: boolean;
}

interface PatchFailure {
  readonly ok: false;
  readonly reason: string;
}

type ParsedPatchApplication = PatchApplication | PatchFailure;

const equalAt = (
  lines: ReadonlyArray<string>,
  start: number,
  expected: ReadonlyArray<string>,
): boolean =>
  start >= 0 &&
  start + expected.length <= lines.length &&
  sameLines(lines.slice(start, start + expected.length), expected);

const findLines = (
  lines: ReadonlyArray<string>,
  expected: ReadonlyArray<string>,
  from: number,
): number | undefined => {
  if (expected.length === 0) return Math.max(0, Math.min(from, lines.length));
  for (let start = Math.max(0, from); start <= lines.length; start += 1) {
    if (equalAt(lines, start, expected)) return start;
  }
  return undefined;
};

/**
 * Many coding models call the common `apply_patch` notation a patch even
 * when a tool advertises a `unifiedDiff` field. Accept its single-file Add /
 * Update form as a compatibility input, while keeping the target path and
 * sandbox validation in the caller. This is an input-format extension only;
 * the tool remains one-file, relative-target, idempotent patching.
 */
const applyBeginEndPatch = (
  content: string,
  patch: string,
  targetPath?: string,
): ParsedPatchApplication | undefined => {
  const lines = patch.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== "*** Begin Patch") return undefined;
  const endIndex = lines.indexOf("*** End Patch", 1);
  if (endIndex < 0 || lines.slice(endIndex + 1).some((line) => line !== "")) {
    return { ok: false, reason: "invalid Begin/End patch envelope" };
  }
  const body = lines.slice(1, endIndex);
  const header = body[0];
  const match =
    header === undefined
      ? null
      : /^\*\*\* (Add|Update|Delete) File: (.+)$/u.exec(header);
  if (match === null) {
    return { ok: false, reason: "patch must contain one file operation" };
  }
  const operation = match[1];
  const declaredPath = match[2]?.trim();
  if (
    declaredPath === undefined ||
    declaredPath.length === 0 ||
    (targetPath !== undefined && declaredPath !== targetPath)
  ) {
    return { ok: false, reason: "patch file does not match the target" };
  }
  const operationBody = body
    .slice(1)
    .filter((line) => line !== "*** End of File");
  if (operation === "Delete") {
    return { ok: false, reason: "delete patches are not supported" };
  }
  if (operation === "Add") {
    if (operationBody.some((line) => !line.startsWith("+"))) {
      return { ok: false, reason: "Add File lines must start with '+'" };
    }
    const nextContent = operationBody.map((line) => line.slice(1)).join("\n");
    return {
      ok: true,
      content: nextContent,
      hunks: 1,
      changed: nextContent !== content,
    };
  }

  const nextLines = content === "" ? [] : content.split("\n");
  const hunks: Array<{
    readonly oldLines: string[];
    readonly newLines: string[];
    readonly lineHint?: number;
  }> = [];
  let current:
    | {
        oldLines: string[];
        newLines: string[];
        lineHint?: number;
      }
    | undefined;
  const flush = (): void => {
    if (current !== undefined) hunks.push(current);
    current = undefined;
  };
  for (const line of operationBody) {
    if (line.startsWith("@@")) {
      flush();
      const range = /^@@(?: -(\d+)(?:,\d+)? \+\d+(?:,\d+)?|) @@/u.exec(line);
      current = {
        oldLines: [],
        newLines: [],
        ...(range?.[1] === undefined
          ? {}
          : { lineHint: Math.max(0, Number(range[1]) - 1) }),
      };
      continue;
    }
    if (current === undefined) {
      return { ok: false, reason: "Update File content is missing a hunk" };
    }
    if (line.startsWith(" ")) {
      const value = line.slice(1);
      current.oldLines.push(value);
      current.newLines.push(value);
    } else if (line.startsWith("-")) {
      current.oldLines.push(line.slice(1));
    } else if (line.startsWith("+")) {
      current.newLines.push(line.slice(1));
    } else if (line !== "\\ No newline at end of file") {
      return { ok: false, reason: `invalid Update File line: ${line}` };
    }
  }
  flush();
  if (hunks.length === 0) {
    return { ok: false, reason: "Update File contains no hunks" };
  }

  let delta = 0;
  let cursor = 0;
  let changed = false;
  for (const hunk of hunks) {
    const hintedStart =
      hunk.lineHint === undefined ? cursor : hunk.lineHint + delta;
    const start = findLines(nextLines, hunk.oldLines, hintedStart);
    if (start === undefined) {
      return { ok: false, reason: "Update File hunk context did not match" };
    }
    const alreadyApplied = equalAt(nextLines, start, hunk.newLines);
    if (!alreadyApplied) {
      nextLines.splice(start, hunk.oldLines.length, ...hunk.newLines);
      changed = true;
    }
    delta += hunk.newLines.length - hunk.oldLines.length;
    cursor = start + hunk.newLines.length;
  }
  const nextContent = nextLines.join("\n");
  return { ok: true, content: nextContent, hunks: hunks.length, changed };
};

const applyDiff = (
  content: string,
  diff: string,
  targetPath?: string,
): ParsedPatchApplication => {
  const beginEnd = applyBeginEndPatch(content, diff, targetPath);
  if (beginEnd !== undefined) return beginEnd;
  const lines = content === "" ? [] : content.split("\n");
  const diffLines = diff.split("\n");
  let index = 0;
  let hunks = 0;
  let delta = 0;
  let changed = false;
  while (index < diffLines.length) {
    const header = diffLines[index] ?? "";
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
    if (match === null) {
      index += 1;
      continue;
    }
    const oldStart = Number(match[1]);
    const oldCount = Number(match[2] ?? "1");
    const newCount = Number(match[4] ?? "1");
    const start = (oldStart === 0 ? 0 : oldStart - 1) + delta;
    index += 1;
    const oldLines: string[] = [];
    const newLines: string[] = [];
    while (
      index < diffLines.length &&
      !(diffLines[index] ?? "").startsWith("@@")
    ) {
      const line = diffLines[index] ?? "";
      if (line.startsWith("-")) {
        oldLines.push(line.slice(1));
      } else if (line.startsWith("+")) {
        newLines.push(line.slice(1));
      } else if (line.startsWith(" ")) {
        oldLines.push(line.slice(1));
        newLines.push(line.slice(1));
      } else if (
        line !== "\\ No newline at end of file" &&
        !(line === "" && index === diffLines.length - 1)
      ) {
        return { ok: false, reason: `invalid hunk line: ${line}` };
      }
      index += 1;
    }
    if (oldLines.length !== oldCount || newLines.length !== newCount) {
      return { ok: false, reason: "hunk line counts do not match header" };
    }
    const currentOld = lines.slice(start, start + oldLines.length);
    const currentNew = lines.slice(start, start + newLines.length);
    if (oldLines.length === 0 && sameLines(currentNew, newLines)) {
      // A pure insertion has no old context to distinguish first application
      // from replay. Exact target content at the insertion point means the
      // hunk is already applied.
    } else if (sameLines(currentOld, oldLines)) {
      lines.splice(start, oldLines.length, ...newLines);
      changed ||= !sameLines(oldLines, newLines);
    } else if (!sameLines(currentNew, newLines)) {
      return {
        ok: false,
        reason: `hunk context mismatch at old line ${oldStart}`,
      };
    }
    delta += newLines.length - oldLines.length;
    hunks += 1;
  }
  return { ok: true, content: lines.join("\n"), hunks, changed };
};

/** P4 `08` §3. Idempotent: same invocation key replay yields the same file. */
export const patchExecutor: ToolExecutor = {
  name: "patch",
  write: true,
  requiresApproval: () => false,
  execute: ({ intent, sandbox }) =>
    Effect.sync(
      (): ToolExecutionResult =>
        executeFilesystemTool(() => {
          const args = JSON.parse(intent.argumentsJson) as {
            target: { mount: string; path: string };
            unifiedDiff: string;
          };
          const target = resolveSandboxTarget(sandbox, args.target, {
            access: "ReadWrite",
            allowMissing: true,
          });
          const existed = existsSync(target);
          const content = existed ? readFileSync(target, "utf8") : "";
          const applied = applyDiff(
            content,
            args.unifiedDiff,
            args.target.path,
          );
          if (!applied.ok) {
            return {
              settlement: { _tag: "ExpectedFailure" },
              observation: bounded(applied.reason),
              resultRef: null,
            };
          }
          if (applied.hunks === 0) {
            return {
              settlement: { _tag: "ExpectedFailure" },
              observation: bounded("diff contained no applicable hunk"),
              resultRef: null,
            };
          }
          if (applied.changed) {
            writeFileSync(target, applied.content);
          }
          return {
            settlement: { _tag: "Success" },
            observation: bounded(
              JSON.stringify({
                applied: applied.changed,
                hunks: applied.hunks,
                created: !existed,
              }),
            ),
            resultRef: null,
          };
        }),
    ),
};
