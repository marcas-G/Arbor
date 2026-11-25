import { isAbsolute, relative, resolve } from "node:path";
import type { ResourceAddress } from "@arbor/domain";

export const requestedMountRefs = (argumentsJson: string): ReadonlyArray<string> => {
  try {
    const parsed = JSON.parse(argumentsJson) as {
      target?: { readonly mount?: unknown };
      cwd?: { readonly mount?: unknown };
    };
    return [parsed.target?.mount, parsed.cwd?.mount].filter(
      (value): value is string => typeof value === "string",
    );
  } catch {
    return [];
  }
};

export const legacyResourceArguments = (
  argumentsJson: string,
): ReadonlyArray<ResourceAddress> => {
  try {
    const parsed = JSON.parse(argumentsJson) as {
      path?: ResourceAddress;
      cwd?: ResourceAddress;
    };
    return [parsed.path, parsed.cwd].filter(
      (value): value is ResourceAddress => value !== undefined,
    );
  } catch {
    return [];
  }
};

export type FilesystemAddress = Extract<
  ResourceAddress,
  { readonly _tag: "FileTree" | "GitWorktree" }
>;

export const requestedFilesystemTarget = (
  argumentsJson: string,
  root: FilesystemAddress,
):
  | { readonly _tag: "Absent" }
  | { readonly _tag: "Invalid" }
  | {
      readonly _tag: "Address";
      readonly address: Extract<ResourceAddress, { readonly _tag: "FileTree" }>;
    } => {
  try {
    const parsed = JSON.parse(argumentsJson) as {
      target?: { readonly mount?: unknown; readonly path?: unknown };
    };
    if (parsed.target === undefined) return { _tag: "Absent" };
    if (
      parsed.target.mount !== "workspace" ||
      typeof parsed.target.path !== "string" ||
      parsed.target.path.length === 0 ||
      isAbsolute(parsed.target.path)
    ) {
      return { _tag: "Invalid" };
    }
    const rootPath = resolve(root.path);
    const targetPath = resolve(rootPath, parsed.target.path);
    const within = relative(rootPath, targetPath);
    if (
      within === ".." ||
      within.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(within)
    ) {
      return { _tag: "Invalid" };
    }
    return {
      _tag: "Address",
      address: { _tag: "FileTree", path: targetPath },
    };
  } catch {
    return { _tag: "Invalid" };
  }
};

export const primaryFilesystemAddress = (
  addresses: ReadonlyArray<ResourceAddress>,
): FilesystemAddress | undefined => {
  const candidates = addresses.filter(
    (address): address is FilesystemAddress =>
      address._tag === "GitWorktree" || address._tag === "FileTree",
  );
  const paths = new Set(
    candidates.map((address) =>
      address.path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase(),
    ),
  );
  if (paths.size !== 1) return undefined;
  return (
    candidates.find((address) => address._tag === "GitWorktree") ??
    candidates[0]
  );
};
