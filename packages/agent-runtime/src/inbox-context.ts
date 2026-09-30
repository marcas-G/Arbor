import type { InboxEntry } from "@arbor/domain";
import type { PortableMessage } from "@arbor/ports";

export const INBOX_CONTEXT_LIMIT = 32;

export const assembleInboxContext = (
  entries: ReadonlyArray<InboxEntry>,
): {
  readonly messages: ReadonlyArray<PortableMessage>;
  readonly contextRefs: ReadonlyArray<string>;
} => {
  const selected = entries.slice(-INBOX_CONTEXT_LIMIT);
  return {
    messages: selected.map((entry) => ({
      role: "user" as const,
      text: `[Inbox:${entry.kind}] ${entry.summary}`,
    })),
    contextRefs: selected.map((entry) => `inbox:${entry.entryKey}`),
  };
};
