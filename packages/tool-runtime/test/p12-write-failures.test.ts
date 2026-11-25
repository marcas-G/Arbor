import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionContext } from "@arbor/ports";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeExecutor } from "../src/tools/write.js";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync: vi.fn(actual.fsyncSync),
    renameSync: vi.fn(actual.renameSync),
  };
});

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "p12-write-failure-"));
});
afterEach(() => {
  vi.mocked(fs.fsyncSync).mockReset();
  vi.mocked(fs.renameSync).mockReset();
  vi.mocked(fs.fsyncSync).mockImplementation(actualFsync);
  vi.mocked(fs.renameSync).mockImplementation(actualRename);
  fs.rmSync(root, { recursive: true, force: true });
});
const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
const actualFsync = actual.fsyncSync;
const actualRename = actual.renameSync;
const write = (path: string, content = "new text") =>
  Effect.runPromise(
    writeExecutor.execute({
      intent: {
        invocationId: "tin_failure" as never,
        toolName: "write",
        toolVersion: "1",
        callRef: "call",
        argumentsJson: JSON.stringify({
          target: { mount: "workspace", path },
          content,
        }),
        approvalId: null,
      },
      definition: {} as never,
      context: {} as ToolExecutionContext,
      sandbox: {
        handleId: "s",
        rootPath: root,
        writableRegions: [],
        mounts: [
          {
            ref: "workspace",
            rootPath: root,
            region: { resourceSpaceId: "filesystem", normalizedRegion: {} },
            access: "ReadWrite",
          },
        ],
      },
      regions: [],
    }),
  );

describe.runIf(process.platform === "linux")(
  "write distinguishes failure before and after a possible effect",
  () => {
    it("keeps the old file and cleans its temporary when the file flush fails", async () => {
      fs.writeFileSync(join(root, "value.txt"), "old text");
      vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {
        throw new Error("injected file flush failure");
      });
      const result = await write("value.txt");
      expect(result.settlement._tag).toBe("ExpectedFailure");
      expect(fs.readFileSync(join(root, "value.txt"), "utf8")).toBe("old text");
      expect(fs.readdirSync(root)).toEqual(["value.txt"]);
    });

    it("reports OutcomeUnknown after rename if directory flush fails", async () => {
      fs.writeFileSync(join(root, "value.txt"), "old text");
      vi.mocked(fs.fsyncSync).mockImplementation((fd) => {
        if (fs.fstatSync(fd).isDirectory())
          throw new Error("injected directory flush failure");
        actualFsync(fd);
      });
      const result = await write("value.txt");
      expect(result.settlement).toEqual({
        _tag: "OutcomeUnknown",
        reconciliationRefs: ["tin_failure"],
      });
      expect(fs.readFileSync(join(root, "value.txt"), "utf8")).toBe("new text");
      expect(fs.readdirSync(root)).toEqual(["value.txt"]);
    });

    it("reports parent creation as a possible effect if its flush fails", async () => {
      vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {
        throw new Error("injected parent flush failure");
      });
      const result = await write("nested/value.txt");
      expect(result.settlement._tag).toBe("OutcomeUnknown");
      expect(fs.existsSync(join(root, "nested"))).toBe(true);
      expect(fs.existsSync(join(root, "nested/value.txt"))).toBe(false);
    });
  },
);
