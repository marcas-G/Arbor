import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  access,
  constants,
  mkdir,
  opendir,
  realpath,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ProjectResourceProfilePortService } from "@arbor/ports";
import { Effect, Option } from "effect";
import {
  type HostProjectResourceProfileConfig,
  makeProjectResourceProfilePort,
} from "./project-resource-profiles.js";

export class ProjectDirectoryError extends Error {
  constructor(
    readonly code:
      | "invalid-path"
      | "not-found"
      | "not-directory"
      | "permission-denied"
      | "parent-not-found"
      | "registry-unavailable",
  ) {
    super(code);
  }
}

export interface HostProjectDirectories {
  readonly profiles: ProjectResourceProfilePortService;
  readonly defaultPath: string;
  readonly browse: (path?: string) => Promise<{
    readonly path: string;
    readonly parent: string;
    readonly entries: ReadonlyArray<{
      readonly name: string;
      readonly path: string;
    }>;
    readonly truncated: boolean;
  }>;
  readonly prepare: (
    path: string,
    create: boolean,
  ) => Promise<{
    readonly path: string;
    readonly name: string;
    readonly selection: {
      readonly _tag: "Profile";
      readonly resourceProfileRef: string;
      readonly version: string;
    };
  }>;
}

const directoryPath = (input: string): string => {
  const expanded =
    input === "~"
      ? homedir()
      : input.startsWith("~/") || input.startsWith("~\\")
        ? join(homedir(), input.slice(2))
        : input;
  if (
    expanded.length === 0 ||
    expanded.length > 4096 ||
    /\p{Cc}/u.test(expanded) ||
    !isAbsolute(expanded)
  ) {
    throw new ProjectDirectoryError("invalid-path");
  }
  return resolve(expanded);
};

const fileSystemFailure = (error: unknown): never => {
  if (error instanceof ProjectDirectoryError) throw error;
  const code = (error as NodeJS.ErrnoException).code;
  throw new ProjectDirectoryError(
    code === "ENOENT"
      ? "not-found"
      : code === "ENOTDIR"
        ? "not-directory"
        : "permission-denied",
  );
};

const canonicalDirectory = async (path: string): Promise<string> => {
  try {
    const canonical = await realpath(directoryPath(path));
    if (!(await stat(canonical)).isDirectory()) {
      throw new ProjectDirectoryError("not-directory");
    }
    await access(canonical, constants.R_OK | constants.X_OK);
    return canonical;
  } catch (error) {
    return fileSystemFailure(error);
  }
};

const selectionFor = (path: string) => {
  const digest = createHash("sha256")
    .update(`user:local\0${path}`)
    .digest("hex");
  return {
    _tag: "Profile" as const,
    resourceProfileRef: `directory-${digest}`,
    version: "v1",
  };
};

export const makeHostProjectDirectories = (options: {
  readonly registryDirectory: string;
  readonly startupProfiles?: ReadonlyArray<HostProjectResourceProfileConfig>;
}): HostProjectDirectories => {
  const startup = makeProjectResourceProfilePort(options.startupProfiles ?? []);
  const admitted = new Map<string, string>();
  const register = (path: string): void => {
    const selection = selectionFor(path);
    admitted.set(selection.resourceProfileRef, path);
  };
  if (existsSync(options.registryDirectory)) {
    for (const file of readdirSync(options.registryDirectory)) {
      if (!/^directory-[a-f0-9]{64}\.json$/u.test(file)) continue;
      const value: unknown = JSON.parse(
        readFileSync(join(options.registryDirectory, file), "utf8"),
      );
      if (
        typeof value !== "object" ||
        value === null ||
        !("path" in value) ||
        !("principal" in value) ||
        value.principal !== "user:local" ||
        typeof value.path !== "string" ||
        directoryPath(value.path) !== value.path ||
        `${selectionFor(value.path).resourceProfileRef}.json` !== file
      ) {
        throw new Error("invalid project directory registry");
      }
      register(value.path);
    }
  }
  const persist = (path: string): void => {
    const selection = selectionFor(path);
    const target = join(
      options.registryDirectory,
      `${selection.resourceProfileRef}.json`,
    );
    let temporary: string | undefined;
    try {
      mkdirSync(options.registryDirectory, { recursive: true, mode: 0o700 });
      if (!existsSync(target)) {
        temporary = join(options.registryDirectory, `.pending-${randomUUID()}`);
        const descriptor = openSync(temporary, "wx", 0o600);
        try {
          writeFileSync(
            descriptor,
            `${JSON.stringify({ principal: "user:local", path })}\n`,
          );
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
        try {
          linkSync(temporary, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      if (process.platform !== "win32") {
        const descriptor = openSync(options.registryDirectory, "r");
        try {
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
      }
      register(path);
    } catch {
      throw new ProjectDirectoryError("registry-unavailable");
    } finally {
      if (temporary !== undefined && existsSync(temporary))
        unlinkSync(temporary);
    }
  };
  return {
    profiles: {
      list: startup.list,
      resolve: (ref, version) => {
        const path = admitted.get(ref);
        if (path === undefined || version !== "v1") {
          return startup.resolve(ref, version);
        }
        return Effect.succeed(
          Option.some({
            resourceProfileRef: ref,
            version,
            displayName: "Selected folder",
            available: true as const,
            canonicalAddress: { _tag: "FileTree" as const, path },
          }),
        );
      },
    },
    defaultPath: homedir(),
    browse: async (input) => {
      const path = await canonicalDirectory(input ?? homedir());
      const entries: Array<{ name: string; path: string }> = [];
      let scanned = 0;
      let truncated = false;
      try {
        const stream = await opendir(path);
        for await (const entry of stream) {
          scanned += 1;
          if (scanned > 5000 || entries.length >= 500) {
            truncated = true;
            break;
          }
          if (entry.isDirectory()) {
            entries.push({ name: entry.name, path: join(path, entry.name) });
          } else if (entry.isSymbolicLink()) {
            const target = await stat(join(path, entry.name)).catch(() => null);
            if (target?.isDirectory()) {
              entries.push({ name: entry.name, path: join(path, entry.name) });
            }
          }
        }
      } catch (error) {
        return fileSystemFailure(error);
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      return { path, parent: dirname(path), entries, truncated };
    },
    prepare: async (input, create) => {
      const requested = directoryPath(input);
      if (create) {
        let parent: string;
        try {
          parent = await canonicalDirectory(dirname(requested));
        } catch (error) {
          if (
            error instanceof ProjectDirectoryError &&
            error.code === "not-found"
          ) {
            throw new ProjectDirectoryError("parent-not-found");
          }
          throw error;
        }
        try {
          await mkdir(join(parent, basename(requested)), { mode: 0o755 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            return fileSystemFailure(error);
          }
        }
      }
      const path = await canonicalDirectory(requested);
      persist(path);
      return {
        path,
        name: basename(path) || path,
        selection: selectionFor(path),
      };
    },
  };
};
