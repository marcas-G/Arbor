import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Data, Effect, Schema } from "effect";
import {
  TRANSCRIPT_SCHEMA_VERSION,
  type TranscriptEnvelope,
  transcriptEventSchema,
} from "../domain/transcript-events.js";

export class TranscriptError extends Data.TaggedError("TranscriptError")<{
  message: string;
}> {}

class SkipLine extends Data.TaggedError("SkipLine")<{}> {}

/** Append-only JSONL transcript. The writer owns sequence monotonicity. */
export interface TranscriptWriter {
  readonly append: (
    type: string,
    payload: unknown,
  ) => Effect.Effect<TranscriptEnvelope, TranscriptError>;
  readonly lastSequence: () => number;
}

export function openTranscriptWriter(
  file: string,
  agentId: string,
  startSequence: number,
): Effect.Effect<TranscriptWriter, TranscriptError> {
  let seq = startSequence;
  return Effect.succeed({
    lastSequence: () => seq,
    append: (type, payload) =>
      Effect.gen(function* () {
        seq += 1;
        const env: TranscriptEnvelope = {
          schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
          eventId: crypto.randomUUID(),
          agentId,
          sequence: seq,
          timestamp: new Date().toISOString(),
          type,
          payload,
        };
        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(dirname(file), { recursive: true });
            await appendFile(file, `${JSON.stringify(env)}\n`, "utf8");
          },
          catch: (e) => new TranscriptError({ message: `append: ${String(e)}` }),
        });
        return env;
      }),
  });
}

/** Read all events in sequence order; corrupt lines are a typed error. */
export function readTranscript(file: string): Effect.Effect<TranscriptEnvelope[], TranscriptError> {
  return Effect.gen(function* () {
    const text = yield* Effect.tryPromise({
      try: () => readFile(file, "utf8"),
      catch: (e) => new TranscriptError({ message: `read: ${String(e)}` }),
    });
    const events: TranscriptEnvelope[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] as string;
      const isLast = i === lines.length - 1 || lines.slice(i + 1).every((l) => l.trim() === "");
      if (line.trim() === "") {
        continue;
      }
      const parsed = yield* Effect.try({
        try: () => JSON.parse(line) as TranscriptEnvelope,
        // a torn FINAL line is a crash remnant of an interrupted append —
        // ignore it (append-only: the writer resumes after the last whole line)
        catch: (e) =>
          isLast
            ? new SkipLine()
            : new TranscriptError({ message: `bad json line ${i + 1}: ${String(e)}` }),
      }).pipe(
        Effect.catchTag("SkipLine", () => Effect.succeed(undefined as unknown as TranscriptEnvelope)),
      );
      if (parsed === undefined) {
        continue;
      }
      yield* Effect.try({
        try: () =>
          void Schema.decodeUnknownSync(transcriptEventSchema)({
            type: parsed.type,
            payload: parsed.payload,
          }),
        catch: () => new TranscriptError({ message: `unknown event type: ${parsed.type}` }),
      });
      events.push(parsed);
    }
    return events;
  });
}
