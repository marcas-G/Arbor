import { Schema } from "effect";

const nonNegativeInteger = Schema.Number.pipe(
  Schema.refine(
    (value): value is number => Number.isInteger(value) && value >= 0,
    { message: "expected a non-negative integer ordinal" },
  ),
);

const makeOrdinal = <B extends string>(brand: B) =>
  nonNegativeInteger.pipe(Schema.brand(brand));

export const ContextEpochNumber = makeOrdinal("ContextEpochNumber");
export const LeaseGeneration = makeOrdinal("LeaseGeneration");
export const ResponsibilityRevision = makeOrdinal("ResponsibilityRevision");
export const ResourceBoundaryRevision = makeOrdinal("ResourceBoundaryRevision");
export const ArtifactRevision = makeOrdinal("ArtifactRevision");
export const EventSequence = makeOrdinal("EventSequence");
export const WorkRevision = makeOrdinal("WorkRevision");
export const DependencyRevision = makeOrdinal("DependencyRevision");
export const Revision = makeOrdinal("Revision");

export const ORDINAL_SCHEMAS = {
  ContextEpochNumber,
  LeaseGeneration,
  ResponsibilityRevision,
  ResourceBoundaryRevision,
  ArtifactRevision,
  EventSequence,
  WorkRevision,
  DependencyRevision,
  Revision,
} as const;

export type ContextEpochNumber = Schema.Schema.Type<typeof ContextEpochNumber>;
export type LeaseGeneration = Schema.Schema.Type<typeof LeaseGeneration>;
export type ResponsibilityRevision = Schema.Schema.Type<
  typeof ResponsibilityRevision
>;
export type ResourceBoundaryRevision = Schema.Schema.Type<
  typeof ResourceBoundaryRevision
>;
export type ArtifactRevision = Schema.Schema.Type<typeof ArtifactRevision>;
export type EventSequence = Schema.Schema.Type<typeof EventSequence>;
export type WorkRevision = Schema.Schema.Type<typeof WorkRevision>;
export type DependencyRevision = Schema.Schema.Type<typeof DependencyRevision>;
export type Revision = Schema.Schema.Type<typeof Revision>;

export const compareOrdinal = (a: number, b: number): -1 | 0 | 1 => {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
};

export const incrementOrdinal = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
) => {
  const decode = Schema.decodeUnknownSync(schema);
  return (value: S["Type"]): S["Type"] => decode(Number(value) + 1);
};
