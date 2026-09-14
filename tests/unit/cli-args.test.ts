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
