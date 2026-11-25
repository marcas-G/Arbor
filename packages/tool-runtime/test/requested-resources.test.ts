import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  legacyResourceArguments,
  primaryFilesystemAddress,
  requestedFilesystemTarget,
  requestedMountRefs,
} from "../src/requested-resources.js";

const root = { _tag: "FileTree", path: resolve("arbor-project") } as const;

describe("requested resource arguments before canonical admission", () => {
  it("extracts mount references and tolerates malformed argument JSON", () => {
    expect(
      requestedMountRefs(
        JSON.stringify({
          target: { mount: "workspace" },
          cwd: { mount: "other" },
        }),
      ),
    ).toEqual(["workspace", "other"]);
    expect(requestedMountRefs("{")).toEqual([]);
    expect(legacyResourceArguments("{")).toEqual([]);
  });

  it("keeps missing, invalid and lexically contained targets distinct", () => {
    expect(requestedFilesystemTarget("{}", root)).toEqual({ _tag: "Absent" });
    expect(
      requestedFilesystemTarget(
        JSON.stringify({ target: { mount: "workspace", path: "src/a.ts" } }),
        root,
      ),
    ).toEqual({
      _tag: "Address",
      address: { _tag: "FileTree", path: resolve(root.path, "src/a.ts") },
    });
    for (const target of [
      { mount: "other", path: "a.ts" },
      { mount: "workspace", path: "" },
      { mount: "workspace", path: root.path },
      { mount: "workspace", path: "../outside.ts" },
    ]) {
      expect(
        requestedFilesystemTarget(JSON.stringify({ target }), root),
      ).toEqual({ _tag: "Invalid" });
    }
  });

  it("does not select a filesystem root when the candidates disagree", () => {
    expect(primaryFilesystemAddress([root])).toEqual(root);
    expect(primaryFilesystemAddress([])).toBeUndefined();
    expect(
      primaryFilesystemAddress([
        root,
        { _tag: "FileTree", path: resolve("another-project") },
      ]),
    ).toBeUndefined();
  });
});
