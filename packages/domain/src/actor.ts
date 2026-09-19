import { Schema } from "effect";

const nonEmptyString = Schema.String.pipe(
  Schema.refine((value): value is string => value.length > 0, {
    message: "expected a non-empty string",
  }),
);

export const Actor = nonEmptyString.pipe(Schema.brand("Actor"));
export const Principal = nonEmptyString.pipe(Schema.brand("Principal"));

export type Actor = Schema.Schema.Type<typeof Actor>;
export type Principal = Schema.Schema.Type<typeof Principal>;
