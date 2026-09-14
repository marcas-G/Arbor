import { Schema } from "effect";
import { normalizeProjectPath } from "./project-path.js";

const GLOB_CHARS = /[*?[\]]/;

/** A writable prefix must already be in canonical form: `/`-separated, no glob,
 * no absolute/drive/`..`/`.`/duplicate segments (§11 + "no glob in P1"). */
const isCanonicalPrefix = (s: string): s is string => {
  if (GLOB_CHARS.test(s)) {
    return false;
  }
  const n = normalizeProjectPath(s);
  return n.kind === "ok" && n.value === s;
};

export const ResourceMappingSchema = Schema.Struct({
  writable: Schema.Array(Schema.String).pipe(
    Schema.refine((arr): arr is Array<string> => arr.length >= 1 && arr.every(isCanonicalPrefix), {
      identifier: "canonicalWritablePrefixes",
    }),
  ),
});

export interface ResourceMapping extends Schema.Schema.Type<typeof ResourceMappingSchema> {}
