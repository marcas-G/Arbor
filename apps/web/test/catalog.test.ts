/**
 * P13 `02` §8 / `06` EC-6 (upgraded by P14 TR-B): the UI command catalog is
 * exactly the frozen eight-item Human-actionable set — mechanically verified,
 * order-independent; no System-internal / Agent-originated commandType may
 * appear. Also pins the `cmd_<uuid-v7>` generator shape (RFC 9562 §4: the
 * canonical 8-4-4-4-12 layout — the leading 48-bit unix-ms timestamp spans
 * groups 1–2, hence the interior dash between them that a naive 12-hex-char
 * count overlooks).
 */
import { describe, expect, it } from "vitest";
import {
  HUMAN_ACTIONABLE_COMMANDS,
  isHumanActionableCommand,
} from "../src/commands/catalog.js";
import { uuidv7 } from "../src/commands/uuid7.js";

const EXPECTED_EIGHT = [
  "CreateProject",
  "RecordDecision",
  "SteerWork",
  "AcceptWorkOutcome",
  "StopExecution",
  "GrantPermission",
  "RevokePermission",
  "SubmitHumanMessage",
];

const NEVER_EXPOSED = [
  "SelectCurrentWork",
  "SendMessage",
  "AssignWork",
  "AdmitExecution",
  "SettleExecution",
  "CompleteWork",
];

const UUIDV7_SHAPE =
  /^(0|1)[0-9a-f]{7}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("EC-6 human-actionable catalog", () => {
  it("is exactly the frozen eight-item set (order-independent)", () => {
    expect([...HUMAN_ACTIONABLE_COMMANDS].sort()).toEqual(
      [...EXPECTED_EIGHT].sort(),
    );
    expect(HUMAN_ACTIONABLE_COMMANDS.length).toBe(8);
  });

  it("contains no system-internal / agent-originated commandType", () => {
    for (const commandType of NEVER_EXPOSED) {
      expect(HUMAN_ACTIONABLE_COMMANDS).not.toContain(commandType);
      expect(isHumanActionableCommand(commandType)).toBe(false);
    }
    for (const commandType of EXPECTED_EIGHT) {
      expect(isHumanActionableCommand(commandType)).toBe(true);
    }
  });
});

describe("uuidv7 shape (cmd_<uuid-v7> generator)", () => {
  it("matches the canonical RFC 9562 v7 layout with unix-ms prefix", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(UUIDV7_SHAPE.test(uuidv7())).toBe(true);
    }
  });

  it("produces unique ids with non-decreasing timestamp prefixes", () => {
    const samples = Array.from({ length: 100 }, () => uuidv7());
    expect(new Set(samples).size).toBe(100);
    const prefixes = samples.map((id) => id.slice(0, 13).replace("-", ""));
    for (let i = 1; i < prefixes.length; i += 1) {
      expect(
        Number.parseInt(prefixes[i] ?? "0", 16) >=
          Number.parseInt(prefixes[i - 1] ?? "f", 16),
      ).toBe(true);
    }
  });
});
