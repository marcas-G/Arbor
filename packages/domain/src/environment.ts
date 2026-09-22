import { Schema } from "effect";

/**
 * P11 `01` (GQ3'): the two environment identities, fully separated.
 *
 * EnvironmentRevision  — per-project monotonic counter (string-encoded
 *                       decimal). The ONLY ordering/wake currency.
 * EnvironmentFingerprint — content identity (content-addressed digest).
 *                       The ONLY equality currency. Ordering comparisons on
 *                       fingerprints are FORBIDDEN (type-level ban below;
 *                       CI-1 audit hook in `03`).
 */

const counterPattern = /^[1-9][0-9]*$/;

const isCounter = (value: string): boolean =>
  counterPattern.test(value) && value === String(Number(value));

/** Monotonic counter. Constructed only via the helpers below — there is no
 * public "make an arbitrary revision" path (advancement authority stays
 * with the store + RecordEnvironmentChange in P11-002). */
export class EnvironmentRevision {
  public readonly _tag = "EnvironmentRevision" as const;
  private constructor(public readonly value: string) {}

  /** Initial anchor (counter starts at "1" — P1-DG-08 lazy-init semantics). */
  static initial(): EnvironmentRevision {
    return new EnvironmentRevision("1");
  }

  /** The single successor function: n -> n+1. No jumps, no arbitrary steps. */
  next(): EnvironmentRevision {
    return new EnvironmentRevision(String(Number(this.value) + 1));
  }

  /** Numeric comparison — the ONLY ordering operation in the algebra. */
  static compare(a: EnvironmentRevision, b: EnvironmentRevision): -1 | 0 | 1 {
    return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  }

  static equal(a: EnvironmentRevision, b: EnvironmentRevision): boolean {
    return a.value === b.value;
  }

  /** Parse from persistence (validated decimal counter). */
  static parse(raw: string): EnvironmentRevision | null {
    return isCounter(raw) ? new EnvironmentRevision(raw) : null;
  }

  /** Trust boundary for the lazy-init write (P11-002 wires the call site). */
  static unsafeInitialFromStorage(raw: string | null): EnvironmentRevision {
    return raw === null
      ? EnvironmentRevision.initial()
      : (EnvironmentRevision.parse(raw) ?? EnvironmentRevision.initial());
  }
}

/**
 * Content identity. Opaque: constructed from a digest; exposes ONLY
 * equality. There is deliberately NO compare/order function on this type
 * and no numeric view — the type system prevents coupling it back to
 * ordering.
 */
export class EnvironmentFingerprint {
  public readonly _tag = "EnvironmentFingerprint" as const;
  private constructor(public readonly digest: string) {}

  static of(digest: string): EnvironmentFingerprint {
    return new EnvironmentFingerprint(digest);
  }

  equals(other: EnvironmentFingerprint): boolean {
    return this.digest === other.digest;
  }
}

// -- P11 `02` snapshot shape (domain vocabulary only; blob persistence
//    rides the P4 blob store and is wired in later tasks) --

export const FileTreeProbe = Schema.Struct({
  kind: Schema.Literals(["FileTree"]),
  exists: Schema.Boolean,
  mtime: Schema.String,
});

export const GitWorktreeProbe = Schema.Struct({
  kind: Schema.Literals(["GitWorktree"]),
  exists: Schema.Boolean,
  head: Schema.String,
  dirty: Schema.Boolean,
});

export const EnvironmentProbe = Schema.Union([FileTreeProbe, GitWorktreeProbe]);

export const EnvironmentSnapshotRegion = Schema.Struct({
  address: Schema.Unknown,
  resolved: Schema.Unknown,
  probe: EnvironmentProbe,
});

export const EnvironmentSnapshot = Schema.Struct({
  projectId: Schema.String,
  revision: Schema.String,
  fingerprint: Schema.String,
  regions: Schema.Array(EnvironmentSnapshotRegion),
  capturedAt: Schema.String,
});
