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
    for (const line of text.split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      const parsed = yield* Effect.try({
        try: () => JSON.parse(line) as TranscriptEnvelope,
        catch: (e) => new TranscriptError({ message: `bad json line: ${String(e)}` }),
      });
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
