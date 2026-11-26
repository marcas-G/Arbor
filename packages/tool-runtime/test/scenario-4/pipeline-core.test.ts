import { canonicalRegionString } from "@arbor/domain";
import { targetResourceIdentityDigestV1 } from "@arbor/ports";
import { describe, expect, it } from "vitest";
import {
  reconciliationRetryDenialReasonCode,
  type ToolExecutor,
} from "../../src/index.js";
import { createShellExecutor } from "../../src/tools/shell.js";
import { okExecutor } from "./support.js";
import { app, run, runShell } from "./support-app.js";
import type { PipelineTrace } from "./support-harness.js";

describe("tool runtime pipeline", () => {
  it("distinguishes post-I/O authority denial from executable approval denial", () => {
    expect(
      reconciliationRetryDenialReasonCode("InvocationAuthorityDenied"),
    ).toBe("AuthoritySnapshotChanged");
    expect(
      reconciliationRetryDenialReasonCode("ApprovalNoLongerAuthorized"),
    ).toBe("ApprovalNoLongerAuthorized");
    expect(reconciliationRetryDenialReasonCode("ApprovalExpired")).toBe(
      "ApprovalNoLongerAuthorized",
    );
  });

  it("uses fixed target-region digest vectors preserving emitted order and multiplicity", () => {
    const fileRegion = {
      resourceSpaceId: "filesystem",
      normalizedRegion: { kind: "FileTree", path: "/repo/a" },
    } as const;
    const databaseRegion = {
      resourceSpaceId: "database",
      normalizedRegion: { kind: "DatabaseNamespace", namespace: "arbor" },
    } as const;
    const gitAliasRegion = {
      resourceSpaceId: "filesystem",
      normalizedRegion: { kind: "GitWorktree", path: "/repo/a" },
    } as const;

    expect(canonicalRegionString(fileRegion)).toBe(
      '{"resourceSpaceId":"filesystem","kind":"FileTree","path":"/repo/a"}',
    );
    expect(canonicalRegionString(gitAliasRegion)).toBe(
      canonicalRegionString(fileRegion),
    );
    expect(canonicalRegionString(databaseRegion)).toBe(
      '{"resourceSpaceId":"database","kind":"DatabaseNamespace","namespace":"arbor"}',
    );
    expect(targetResourceIdentityDigestV1([])).toBe(
      "bbe6728ecb80f47e10b2735f040f13488a6b26fe040fcebced094c8449d5597b",
    );
    expect(targetResourceIdentityDigestV1([fileRegion])).toBe(
      "c8f8f405369396168ddc9f96bd592547d3d322c495942fd19e9bc04f95fa7763",
    );
    expect(targetResourceIdentityDigestV1([fileRegion, databaseRegion])).toBe(
      "e6f887f5c6144044926c6a0e3c13bdbd69a7bd830c1aabe3b761f69c6d6dbc31",
    );
    expect(targetResourceIdentityDigestV1([databaseRegion, fileRegion])).toBe(
      "2f23f23627a4891e053c2722f7e312927180c0bc87f7f6010fff8acfb0fd4e76",
    );
    expect(targetResourceIdentityDigestV1([fileRegion, fileRegion])).toBe(
      "f4d6c05c3cf0f50bd7a364cb7e462acc48f3b4a0fa245173d0e1ee13e54b0097",
    );
  });

  it("keeps unknown and compound shell commands in the nonterminal approval handoff", async () => {
    for (const command of [
      "python -c 'print(1)'",
      "ls -la; rm file.txt",
      "s'u'do rm -rf /",
      "r'm' -rf /",
      "& 'sudo' rm -rf /",
    ]) {
      const trace: PipelineTrace = {
        noEffectDenials: [],
        events: [],
        approvalConsumer: null,
        intentWrites: 0,
        effectAdmissions: 0,
        approvalConsumes: 0,
      };
      const shell = createShellExecutor();
      const result = await runShell(app(false, shell, {}, trace), command);

      expect(result._tag, command).toBe("ApprovalRequired");
      expect(trace).toMatchObject({
        noEffectDenials: [],
        intentWrites: 0,
        effectAdmissions: 0,
        approvalConsumes: 0,
      });
    }
  });

  it("projects a typed authority policy rejection as Denied without execution", async () => {
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
    };
    let executorCalls = 0;
    const executor: ToolExecutor = {
      ...okExecutor,
      execute: (input) => {
        executorCalls += 1;
        return okExecutor.execute(input);
      },
    };
    const result = await run(
      app(false, executor, {}, trace, undefined, true),
      '{"target":{"mount":"workspace","path":"."}}',
    );

    expect(result).toMatchObject({
      _tag: "Denied",
      reasonCode: "InvocationAuthorityDenied",
    });
    expect(trace.noEffectDenials).toEqual(["InvocationAuthorityDenied"]);
    expect(trace.intentWrites).toBe(0);
    expect(trace.effectAdmissions).toBe(0);
    expect(executorCalls).toBe(0);
  });
});
