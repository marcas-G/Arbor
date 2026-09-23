/**
 * P13 `04` design tokens — single source of truth. `src/tokens.css` mirrors
 * the `:root` block from this module; the EC-10 test keeps both in lockstep.
 * Color and font-size literals may appear nowhere else under `src/`.
 */
export const TOKENS = {
  "--arbor-paper": "#f4efe6",
  "--arbor-paper-2": "#ece5d8",
  "--arbor-ink": "#26332b",
  "--arbor-ink-soft": "#5a6a5f",
  "--arbor-line": "#c9c0ae",
  "--arbor-leaf": "#2d5a3d",
  "--arbor-leaf-bright": "#3f7d54",
  "--arbor-leaf-pale": "#dfe9e0",
  "--arbor-branch": "#3d5a72",
  "--arbor-attention": "#a06a1f",
  "--arbor-danger": "#9a4a2f",
  "--arbor-muted": "#5a6a5f",
  "--arbor-sky": "#3d5a72",
  "--arbor-font-serif":
    '"Palatino Linotype", "Iowan Old Style", Palatino, Georgia, serif',
  "--arbor-font-mono":
    'ui-monospace, "Cascadia Code", Menlo, Consolas, monospace',
  "--arbor-text-display": "28px",
  "--arbor-text-title": "20px",
  "--arbor-text-body": "15px",
  "--arbor-text-small": "13px",
  "--arbor-text-caption": "11px",
  "--arbor-space-1": "4px",
  "--arbor-space-2": "8px",
  "--arbor-space-3": "12px",
  "--arbor-space-4": "16px",
  "--arbor-space-5": "24px",
  "--arbor-space-6": "32px",
  "--arbor-radius": "3px",
  "--arbor-radius-small": "2px",
  "--arbor-shadow": "0 1px 3px rgba(38, 51, 43, 0.12)",
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
