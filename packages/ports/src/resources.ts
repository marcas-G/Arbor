import type { RegionComparator } from "@arbor/domain";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const keyOf = (value: unknown): string | null => {
  if (!isRecord(value)) {
    return null;
  }
  const candidate = value.path ?? value.namespace ?? value.address;
  return typeof candidate === "string" ? candidate : null;
};

// Filesystem regions originate from native path APIs. Compare their segment
// form rather than the host separator so a canonical region works on every
// checkout platform.
const normalizedPathKey = (key: string): string =>
  key.replaceAll("\\", "/").replace(/\/+$/, "");

const containsRegion = (a: unknown, b: unknown): boolean => {
  const rawKeyA = keyOf(a);
  const rawKeyB = keyOf(b);
  const keyA = rawKeyA === null ? null : normalizedPathKey(rawKeyA);
  const keyB = rawKeyB === null ? null : normalizedPathKey(rawKeyB);
  if (keyA === null || keyB === null) {
    return false;
  }
  if (
    isRecord(a) &&
    (a.kind === "ExternalResource" ||
      (isRecord(b) && b.kind === "ExternalResource"))
  ) {
    return keyA === keyB;
  }
  return keyB === keyA || keyB.startsWith(`${keyA}/`);
};

/**
 * Deterministic comparator for the frozen `normalizedRegion` encoding
 * (`04-sqlite-schema.md` §3.3): segment-prefix containment for
 * FileTree/GitWorktree/DatabaseNamespace, exact equality for ExternalResource.
 */
export const resourceRegionComparator: RegionComparator<unknown> = {
  contains: containsRegion,
  overlaps: (a, b) => containsRegion(a, b) || containsRegion(b, a),
};
