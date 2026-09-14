import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/entrypoints/cli.js";

describe("parseArgs", () => {
  it("project init with repo and home", () => {
    expect(parseArgs(["project", "init", "--repo", "/r", "--home", "/h"])).toEqual({
      kind: "ok",
      cmd: "project-init",
      repo: "/r",
      home: "/h",
      project: undefined,
    });
  });

  it("project show with project id", () => {
    expect(parseArgs(["project", "show", "--project", "uuid-1", "--home", "/h"])).toEqual({
      kind: "ok",
      cmd: "project-show",
      repo: undefined,
      home: "/h",
      project: "uuid-1",
    });
  });

  it("home defaults to undefined (resolver handles precedence)", () => {
    expect(parseArgs(["project", "init", "--repo", "/r"])).toMatchObject({ home: undefined });
  });

  it("agent run with project and task", () => {
    expect(parseArgs(["agent", "run", "--project", "uuid-1", "--task", "do x"])).toEqual({
      kind: "ok",
      cmd: "agent-run",
      repo: undefined,
      home: undefined,
      project: "uuid-1",
      task: "do x",
    });
  });

  it("agent run without --project → err", () => {
    expect(parseArgs(["agent", "run"])).toMatchObject({ kind: "err" });
  });

  it("unknown command → err", () => {
    expect(parseArgs(["nope"])).toMatchObject({ kind: "err" });
  });

  it("project init without --repo → err", () => {
    expect(parseArgs(["project", "init"])).toMatchObject({ kind: "err" });
  });

  it("project show without --project → err", () => {
    expect(parseArgs(["project", "show"])).toMatchObject({ kind: "err" });
  });
});
