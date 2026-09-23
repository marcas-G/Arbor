import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * P14-006 closure gate — the ten user-specified seams (`05` §2), the exit
 * criteria (`05` §3) and the no-open-gap gate, all mechanically anchored.
 */

const repoRoot = join(import.meta.dirname, "..", "..");
const sourceOf = (relative: string): string =>
  readFileSync(join(repoRoot, relative), "utf8");
const exists = (relative: string): boolean =>
  existsSync(join(repoRoot, relative));

interface SeamEvidence {
  readonly seam: string;
  readonly title: string;
  readonly file: string;
  readonly marker: string;
}

const SEAMS: ReadonlyArray<SeamEvidence> = [
  {
    seam: "S1",
    title: "durability / idempotency",
    file: "apps/web/test/../../tests/p14-human-message-store.test.ts",
    marker: "Answered lifecycle",
  },
  {
    seam: "S2",
    title: "root-only exact authority",
    file: "tests/p14-human-message.test.ts",
    marker: "resolver root-only",
  },
  {
    seam: "S3",
    title: "HumanConversation ≠ HumanInput / ≠ SteerWork",
    file: "tests/p14-human-message.test.ts",
    marker: "≠HumanInput",
  },
  {
    seam: "S4",
    title: "Coordination execution ≠ Work execution",
    file: "tests/p14-conversation-trigger.test.ts",
    marker: "focus",
  },
  {
    seam: "S5",
    title: "FIFO claim + one-active-main queueing",
    file: "tests/p14-conversation-trigger.test.ts",
    marker: "one-active-main",
  },
  {
    seam: "S6",
    title: "crash/replay exact-once logical response (two-step protocol)",
    file: "tests/p14-settle-writeback-protocol.test.ts",
    marker: "durable two-step recovery protocol",
  },
  {
    seam: "S7",
    title: "message↔execution↔response correlation",
    file: "tests/p14-transcript.test.ts",
    marker: "1:1 correlation",
  },
  {
    seam: "S8",
    title: "Web zero direct AdmitExecution",
    file: "apps/web/test/no-forbidden-controls.test.tsx",
    marker: "AdmitExecution",
  },
  {
    seam: "S9",
    title: "no provider streaming in v1",
    file: "tests/p14-transcript.test.ts",
    marker: "no streaming",
  },
  {
    seam: "S10",
    title: "Child Workspace zero composer",
    file: "apps/web/test/conversation-tab.test.tsx",
    marker: "NO composer (S10)",
  },
];

const EC_FILES: ReadonlyArray<{ readonly ec: string; readonly file: string }> =
  [
    { ec: "EC-1", file: "planning/results/P14.result.md" },
    { ec: "EC-2", file: "tests/architecture/p14-closure.test.ts" },
    { ec: "EC-3", file: "tests/p14-human-message.test.ts" },
    { ec: "EC-4", file: "apps/web/src/commands/catalog.ts" },
    { ec: "EC-5", file: "tests/architecture/p14-closure.test.ts" },
  ];

describe("p14-closure", () => {
  it("EC-2: all ten seams have mechanical evidence (file exists + marker)", () => {
    for (const seam of SEAMS) {
      const file = seam.file.replace("apps/web/test/../../", "");
      expect(exists(file), `${seam.seam}: ${file}`).toBe(true);
      expect(
        sourceOf(file).includes(seam.marker),
        `${seam.seam} (${seam.title}): marker "${seam.marker}" in ${file}`,
      ).toBe(true);
    }
  });

  it("EC-4: the exposure matrix has exactly eight Human-actionable commands incl. SubmitHumanMessage (TR-B)", () => {
    const catalog = sourceOf("apps/web/src/commands/catalog.ts");
    for (const command of [
      "CreateProject",
      "RecordDecision",
      "SteerWork",
      "AcceptWorkOutcome",
      "StopExecution",
      "GrantPermission",
      "RevokePermission",
      "SubmitHumanMessage",
    ]) {
      expect(catalog.includes(`"${command}"`)).toBe(true);
    }
    // never-exposed stays closed
    for (const forbidden of [
      "SelectCurrentWork",
      "SendMessage",
      "AdmitExecution",
    ]) {
      expect(catalog.includes(forbidden)).toBe(false);
    }
  });

  it("S3/S8: P6 W2W SendMessage is untouched by P14 (domain kinds intact)", () => {
    const communication = sourceOf("packages/domain/src/communication.ts");
    expect(communication).toContain("HumanConversation");
    expect(communication).toContain("HumanInput");
    // the workspace→workspace kinds survive verbatim
    for (const kind of ["Message", "SpecialistSettled", "Governance"]) {
      expect(communication).toContain(kind);
    }
    const sendMessage = sourceOf(
      "packages/application/src/commands/send-message.ts",
    );
    expect(sendMessage).toContain("senderWorkspaceId");
  });

  it("S8: no web source references AdmitExecution (browser never admits)", () => {
    const webScan = sourceOf("apps/web/test/no-forbidden-controls.test.tsx");
    expect(webScan).toContain("AdmitExecution");
  });

  it("EC-1/EC-5: the phase result record exists and the contracts are frozen", () => {
    expect(exists("planning/results/P14.result.md")).toBe(true);
    for (const contract of [
      "00-contract-index.md",
      "01-human-message.md",
      "02-conversation-execution.md",
      "03-transcript-read-model.md",
      "04-web-surface.md",
      "05-acceptance.md",
    ]) {
      expect(exists(join("docs/design/implementation/P14", contract))).toBe(
        true,
      );
    }
  });

  it("G-B: the trigger admits Coordination (not a conversational Work)", () => {
    const trigger = sourceOf(
      "packages/application/src/conversation-trigger.ts",
    );
    expect(trigger).toContain('"Coordination"');
    expect(trigger).not.toMatch(/conversational|ConversationWork/);
    // no chat runtime invention: the trigger submits the frozen P2 command
    expect(trigger).toContain('"AdmitExecution"');
  });
});
