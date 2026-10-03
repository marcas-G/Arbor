/**
 * TR-WPU-A product design tokens — single source of truth. `src/tokens.css`
 * mirrors the `:root` block from this module; the EC-10 test keeps both in
 * lockstep. Color and font-size literals may appear nowhere else under `src/`.
 */
export const TOKENS = {
  "--arbor-paper": "#f4f6f5",
  "--arbor-paper-2": "#ffffff",
  "--arbor-surface": "#ffffff",
  "--arbor-surface-raised": "#ffffff",
  "--arbor-ink": "#17211c",
  "--arbor-ink-soft": "#526159",
  "--arbor-line": "#dfe5e1",
  "--arbor-line-strong": "#cbd5cf",
  "--arbor-leaf": "#177653",
  "--arbor-leaf-bright": "#1d9367",
  "--arbor-leaf-pale": "#e8f5ee",
  "--arbor-branch": "#46665a",
  "--arbor-attention": "#a46610",
  "--arbor-danger": "#b4463b",
  "--arbor-muted": "#718078",
  "--arbor-sky": "#44728c",
  "--arbor-focus": "#25936b",
  "--arbor-rail": "#13251e",
  "--arbor-rail-raised": "#1b3027",
  "--arbor-rail-line": "#2d4439",
  "--arbor-rail-ink": "#edf5f1",
  "--arbor-rail-muted": "#9eb2a8",
  "--arbor-font-sans":
    'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  "--arbor-font-serif":
    '"Palatino Linotype", "Iowan Old Style", Palatino, Georgia, serif',
  "--arbor-font-mono":
    'ui-monospace, "Cascadia Code", Menlo, Consolas, monospace',
  "--arbor-text-display": "30px",
  "--arbor-text-title": "19px",
  "--arbor-text-body": "15px",
  "--arbor-text-small": "13px",
  "--arbor-text-caption": "11px",
  "--arbor-space-1": "4px",
  "--arbor-space-2": "8px",
  "--arbor-space-3": "12px",
  "--arbor-space-4": "20px",
  "--arbor-space-5": "30px",
  "--arbor-space-6": "44px",
  "--arbor-radius": "14px",
  "--arbor-radius-small": "9px",
  "--arbor-radius-large": "20px",
  "--arbor-row-height": "42px",
  "--arbor-shadow":
    "0 1px 2px rgba(23, 33, 28, 0.04), 0 10px 28px rgba(23, 33, 28, 0.06)",
  "--arbor-shadow-float": "0 18px 48px rgba(13, 31, 23, 0.16)",
} as const;

export type TokenName = keyof typeof TOKENS;
export type TokenValue = (typeof TOKENS)[TokenName];
export type TokenMap = typeof TOKENS;

/** Badge-styling tones (map to `arbor-badge-*` classes). */
export type Tone = "leaf" | "attention" | "danger" | "muted" | "branch" | "sky";

/**
 * Frozen status→tone map (P13 `04` §3.2). Styling only: the label text is
 * always rendered verbatim; unmapped labels resolve to `muted`.
 */
const STATUS_TONES: Readonly<Record<string, Tone>> = {
  active: "leaf",
  ok: "leaf",
  pass: "leaf",
  passed: "leaf",
  accepted: "leaf",
  satisfied: "leaf",
  committed: "leaf",
  completed: "leaf",
  fresh: "leaf",
  healthy: "leaf",
  fail: "danger",
  failed: "danger",
  rejected: "danger",
  error: "danger",
  denied: "danger",
  unfulfillable: "danger",
  deadlock: "danger",
  actionrequired: "danger",
  danger: "danger",
  blocked: "danger",
  "waiting-blocked": "danger",
  pending: "attention",
  wait: "attention",
  waiting: "attention",
  "waiting-runnable": "attention",
  attention: "attention",
  "attention-flagged": "attention",
  stale: "attention",
  unknown: "attention",
  running: "attention",
  executing: "attention",
  idle: "attention",
  retired: "muted",
};

export function statusTone(label: string): Tone {
  return STATUS_TONES[label.trim().toLowerCase()] ?? "muted";
}
