export type PathRejected = "empty" | "absolute" | "parent-segment";

export interface ProjectPath {
  readonly value: string;
}

export type NormalizedPath =
  | { readonly kind: "ok"; readonly value: string }
  | { readonly kind: "err"; readonly reason: PathRejected };

export function normalizeProjectPath(input: string): NormalizedPath {
  if (input.trim() === "") {
    return { kind: "err", reason: "empty" };
  }
  const unified = input.replace(/\\/g, "/");
  if (unified.startsWith("/") || /^[a-zA-Z]:/.test(unified)) {
    return { kind: "err", reason: "absolute" };
  }
  const segments: string[] = [];
  for (const seg of unified.split("/")) {
    if (seg === "" || seg === ".") {
      continue;
    }
    if (seg === "..") {
      return { kind: "err", reason: "parent-segment" };
    }
    segments.push(seg);
  }
  return { kind: "ok", value: segments.length === 0 ? "." : segments.join("/") };
}

export function isPathWithinPrefix(prefix: ProjectPath, path: ProjectPath): boolean {
  const p = prefix.value === "." ? [] : prefix.value.split("/");
  const t = path.value === "." ? [] : path.value.split("/");
  if (p.length === 0) {
    return true;
  }
  if (t.length < p.length) {
    return false;
  }
  return p.every((seg, i) => seg === t[i]);
}
