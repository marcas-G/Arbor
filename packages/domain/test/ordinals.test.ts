import { describe, expect, it } from "vitest";
import {
  Actor,
  ArtifactRevision,
  type ContextEpochNumber,
  compareOrdinal,
  type DependencyRevision,
  type EventId,
  EventSequence,
  encode,
  incrementOrdinal,
  LeaseGeneration,
  ORDINAL_SCHEMAS,
  Principal,
  parse,
  ResourceBoundaryRevision,
  ResponsibilityRevision,
  Revision,
  WorkRevision,
} from "../src/index.js";

const EXPECTED_ORDINALS = [
  "ContextEpochNumber",
  "LeaseGeneration",
  "ResponsibilityRevision",
  "ResourceBoundaryRevision",
  "ArtifactRevision",
  "EventSequence",
  "WorkRevision",
  "DependencyRevision",
  "Revision",
].sort();

describe("scoped ordinals", () => {
  it("exposes the frozen ordinal set", () => {
    expect(Object.keys(ORDINAL_SCHEMAS).sort()).toEqual(EXPECTED_ORDINALS);
  });

  it("round-trips a valid ordinal", () => {
    const value = parse(WorkRevision)(3);
    expect(value).toBe(3);
    expect(encode(WorkRevision)(value)).toBe(3);
  });

  it("rejects negative, fractional, NaN, Infinity, and non-number", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3"]) {
      expect(() => parse(WorkRevision)(bad)).toThrow();
    }
  });

  it("does not assert a starting value (DID leaves it unspecified)", () => {
    expect(parse(WorkRevision)(0)).toBe(0);
    expect(parse(WorkRevision)(1)).toBe(1);
  });

  it("compares ordinals totally", () => {
    expect(compareOrdinal(1, 2)).toBe(-1);
    expect(compareOrdinal(2, 2)).toBe(0);
    expect(compareOrdinal(3, 2)).toBe(1);
  });

  it("increments by one and re-validates", () => {
    const next = incrementOrdinal(WorkRevision);
    expect(next(parse(WorkRevision)(4))).toBe(5);
  });

  it("type-level: ordinals are not interchangeable", () => {
    const work = parse(WorkRevision)(1);
    // @ts-expect-error WorkRevision is not DependencyRevision
    const wrongDependency: DependencyRevision = work;
    void wrongDependency;

    const lease = parse(LeaseGeneration)(1);
    // @ts-expect-error LeaseGeneration is not ContextEpochNumber
    const wrongEpoch: ContextEpochNumber = lease;
    void wrongEpoch;
  });

  it("type-level: EventSequence is not EventId", () => {
    const sequence = parse(EventSequence)(1);
    // @ts-expect-error EventSequence is not EventId
    const wrongEvent: EventId = sequence;
    void wrongEvent;
  });

  it("keeps the frozen ordinals as value objects (no id encoding)", () => {
    expect(
      typeof encode(ResponsibilityRevision)(parse(ResponsibilityRevision)(2)),
    ).toBe("number");
    expect(ArtifactRevision).toBeDefined();
    expect(ResourceBoundaryRevision).toBeDefined();
    expect(Revision).toBeDefined();
  });
});

describe("actor / principal value primitives", () => {
  it("round-trips Actor and Principal", () => {
    const actor = parse(Actor)("user:gaolei");
    expect(encode(Actor)(actor)).toBe("user:gaolei");
    const principal = parse(Principal)("principal:system");
    expect(encode(Principal)(principal)).toBe("principal:system");
  });

  it("rejects an empty actor / principal", () => {
    expect(() => parse(Actor)("")).toThrow();
    expect(() => parse(Principal)("")).toThrow();
  });

  it("type-level: Actor and Principal are not interchangeable", () => {
    const actor = parse(Actor)("user:gaolei");
    // @ts-expect-error Actor is not Principal
    const wrong: Principal = actor;
    void wrong;
  });
});
