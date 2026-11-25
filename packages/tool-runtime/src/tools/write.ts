import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { bounded, type ToolExecutor } from "../runtime.js";
import { executeFilesystemTool } from "./filesystem-result.js";
import { readRegularText, withSandboxParent } from "./filesystem-walk.js";

const MAX_WRITE_BYTES = 5_000_000;

export const writeExecutor: ToolExecutor = {
  name: "write",
  write: true,
  requiresApproval: () => false,
  execute: ({ intent, sandbox }) =>
    Effect.sync(() => {
      let effectPossible = false;
      return executeFilesystemTool(
        () => {
          const args = JSON.parse(intent.argumentsJson) as {
            target: { mount: string; path: string };
            content: string;
          };
          if (typeof args.content !== "string")
            throw new Error("content must be text");
          const byteSize = Buffer.byteLength(args.content);
          if (byteSize > MAX_WRITE_BYTES)
            throw new Error("content exceeds write limit");
          return withSandboxParent(
            sandbox,
            args.target,
            "ReadWrite",
            true,
            (parent, name) => {
              const target = join(parent, name);
              let mode = 0o600;
              let existed = false;
              try {
                const info = lstatSync(target);
                if (!info.isFile() || info.isSymbolicLink())
                  throw new Error("target must be an ordinary file");
                existed = true;
                mode = info.mode & 0o777;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                  throw error;
              }
              let written = false;
              if (
                !existed ||
                readRegularText(target, MAX_WRITE_BYTES) !== args.content
              ) {
                const temporary = join(parent, `.arbor-write-${randomUUID()}`);
                let fd: number | undefined;
                let cleanupError: unknown;
                try {
                  fd = openSync(
                    temporary,
                    constants.O_WRONLY |
                      constants.O_CREAT |
                      constants.O_EXCL |
                      constants.O_NOFOLLOW,
                    mode,
                  );
                  writeFileSync(fd, args.content, "utf8");
                  // open's mode is filtered by umask; preserve an existing script's
                  // ordinary permission bits without restoring setuid/setgid.
                  if (existed) fchmodSync(fd, mode);
                  fsyncSync(fd);
                  closeSync(fd);
                  fd = undefined;
                  renameSync(temporary, target);
                  effectPossible = true;
                  const directoryFd = openSync(
                    parent,
                    constants.O_RDONLY | constants.O_DIRECTORY,
                  );
                  try {
                    if (!fstatSync(directoryFd).isDirectory())
                      throw new Error("parent changed");
                    fsyncSync(directoryFd);
                  } finally {
                    closeSync(directoryFd);
                  }
                  written = true;
                } finally {
                  if (fd !== undefined) {
                    try {
                      closeSync(fd);
                    } catch (error) {
                      cleanupError = error;
                      effectPossible = true;
                    }
                  }
                  try {
                    unlinkSync(temporary);
                  } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                      effectPossible = true;
                      cleanupError = error;
                    }
                  }
                }
                if (cleanupError !== undefined) throw cleanupError;
              }
              return {
                settlement: { _tag: "Success" as const },
                observation: bounded(
                  JSON.stringify({ written, created: !existed, byteSize }),
                ),
                resultRef: null,
              };
            },
            () => {
              effectPossible = true;
            },
          );
        },
        () =>
          effectPossible
            ? {
                settlement: {
                  _tag: "OutcomeUnknown",
                  reconciliationRefs: [String(intent.invocationId)],
                },
                observation: bounded(
                  "file or parent directories may have changed; inspect the result before issuing another write",
                ),
                resultRef: null,
              }
            : undefined,
      );
    }),
};
