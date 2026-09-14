import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { openTranscriptWriter, readTranscript } from "../../src/infrastructure/transcript-store.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "arbor-tr-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe("transcript writer/reader (D-035 E1)", () => {
  it("appends with monotonic sequence and reads back in order", async () => {
    const file = join(tmp(), "agent-1", "transcript.jsonl");
    await Effect.runPromise(
      Effect.gen(function* () {
        const w = yield* openTranscriptWriter(file, "agent-1", 0);
        const e1 = yield* w.append("user_input", { text: "hi" });
        const e2 = yield* w.append("tool_result", {
          callId: "c1",
          ok: true,
          output: "done",
          state: "succeeded",
        });
        expect(e1.sequence).toBe(1);
        expect(e2.sequence).toBe(2);
        expect(w.lastSequence()).toBe(2);

        const events = yield* readTranscript(file);
        expect(events.length).toBe(2);
        expect(events[0]?.type).toBe("user_input");
        expect(events[1]?.sequence).toBe(2);
        expect(events[1]?.payload).toEqual({
          callId: "c1",
          ok: true,
          output: "done",
          state: "succeeded",
        });
      }),
    );
  });

  it("continues sequence from a given start (resume)", async () => {
    const file = join(tmp(), "a2", "transcript.jsonl");
    await Effect.runPromise(
      Effect.gen(function* () {
        const w1 = yield* openTranscriptWriter(file, "a", 0);
        yield* w1.append("user_input", { text: "x" });
        const w2 = yield* openTranscriptWriter(file, "a", w1.lastSequence());
        const e = yield* w2.append("pause_marker", {});
        expect(e.sequence).toBe(2);
      }),
    );
  });

  it("rejects unknown event types on read", async () => {
    const dir = join(tmp(), "a3");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "transcript.jsonl");
    writeFileSync(file, JSON.stringify({ type: "bogus_event", payload: {} }) + "\n");
    const exit = await Effect.runPromiseExit(readTranscript(file));
    expect(exit._tag).toBe("Failure");
  });

  it("reader tolerates empty transcript", async () => {
    const dir = join(tmp(), "a4");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "transcript.jsonl");
    writeFileSync(file, "");
    const events = await Effect.runPromise(readTranscript(file));
    expect(events).toEqual([]);
  });

  it("a torn final line (crash remnant) is ignored; a torn middle line is fatal", async () => {
    const dir = join(tmp(), "a5");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "transcript.jsonl");
    const good = JSON.stringify({
      schemaVersion: 1,
      eventId: "e1",
      agentId: "a",
      sequence: 1,
      timestamp: "2026-09-14T00:00:00Z",
      type: "user_input",
      payload: { text: "hi" },
    });
    writeFileSync(file, `${good}\n{"schemaVersion":1,"eventId":"e2","agentId`); // torn tail
    const events = await Effect.runPromise(readTranscript(file));
    expect(events.length).toBe(1);

    writeFileSync(file, `${good}\n{"broken\n${good}\n`);
    const exit = await Effect.runPromiseExit(readTranscript(file));
    expect(exit._tag).toBe("Failure");
  });
});
