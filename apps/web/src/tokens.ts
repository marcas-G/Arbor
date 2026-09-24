/**
 * TR-WPU-A product design tokens — single source of truth. `src/tokens.css`
 * mirrors the `:root` block from this module; the EC-10 test keeps both in
 * lockstep. Color and font-size literals may appear nowhere else under `src/`.
 */
export const TOKENS = {
  "--arbor-paper": "#f7f6f2",
  "--arbor-paper-2": "#ffffff",
  "--arbor-surface": "#ffffff",
  "--arbor-ink": "#1d2a23",
  "--arbor-ink-soft": "#5f6d64",
  "--arbor-line": "#d9dfda",
  "--arbor-leaf": "#216e4e",
  "--arbor-leaf-bright": "#2e8b64",
  "--arbor-leaf-pale": "#e6f2eb",
  "--arbor-branch": "#486a5a",
  "--arbor-attention": "#986314",
  "--arbor-danger": "#ad4d3d",
  "--arbor-muted": "#65736b",
  "--arbor-sky": "#5c7768",
  "--arbor-focus": "#2e8b64",
  "--arbor-font-sans":
    'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
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
  "--arbor-space-4": "18px",
  "--arbor-space-5": "28px",
  "--arbor-space-6": "40px",
  "--arbor-radius": "12px",
  "--arbor-radius-small": "8px",
  "--arbor-row-height": "40px",
  "--arbor-shadow": "0 6px 20px rgba(29, 42, 35, 0.08)",
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
