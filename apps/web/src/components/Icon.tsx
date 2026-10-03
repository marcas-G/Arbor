import type { ReactElement, SVGProps } from "react";

export type IconName =
  | "activity"
  | "attention"
  | "chevron"
  | "conversation"
  | "disconnect"
  | "leaf"
  | "queue"
  | "settings"
  | "spark"
  | "tree"
  | "usage"
  | "workbench";

const paths: Readonly<Record<IconName, ReactElement>> = {
  activity: <path d="M4 12h3l2-6 4 12 2-6h5" />,
  attention: (
    <>
      <path d="M12 3 2.8 19h18.4L12 3Z" />
      <path d="M12 9v4" />
      <path d="M12 16h.01" />
    </>
  ),
  chevron: <path d="m9 18 6-6-6-6" />,
  conversation: (
    <>
      <path d="M5 18.5 3 21v-5a8 8 0 1 1 3 3.5" />
      <path d="M8 10h8M8 14h5" />
    </>
  ),
  disconnect: (
    <>
      <path d="M10 5H5v14h5" />
      <path d="m14 8 4 4-4 4M8 12h10" />
    </>
  ),
  leaf: (
    <>
      <path d="M19 4C11 4 5 8 5 14c0 3 2 5 5 5 6 0 9-7 9-15Z" />
      <path d="M5 20c2-5 6-9 12-12" />
    </>
  ),
  queue: (
    <>
      <path d="M5 6h14M5 12h14M5 18h9" />
      <path d="M2 6h.01M2 12h.01M2 18h.01" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
    </>
  ),
  spark: (
    <path d="m12 3 1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4L12 3ZM18 15l.7 2.3L21 18l-2.3.7L18 21l-.7-2.3L15 18l2.3-.7L18 15Z" />
  ),
  tree: (
    <>
      <rect x="9" y="3" width="6" height="5" rx="1" />
      <rect x="3" y="16" width="6" height="5" rx="1" />
      <rect x="15" y="16" width="6" height="5" rx="1" />
      <path d="M12 8v4M6 16v-4h12v4" />
    </>
  ),
  usage: (
    <>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </>
  ),
  workbench: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
};

export function Icon({
  name,
  size = 18,
  ...props
}: { readonly name: IconName; readonly size?: number } & Omit<
  SVGProps<SVGSVGElement>,
  "children"
>) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
