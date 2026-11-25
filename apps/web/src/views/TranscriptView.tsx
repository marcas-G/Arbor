/**
 * transcript view: cursor-paginated read-only entry list rendering the frozen
 * P14 `03` union — HumanConversationTurn / AssistantConversationTurn carry
 * bounded bodies; the legacy arm keeps `kind + summaryRef + at`. "更早" only
 * forwards `onLoadMore(nextCursor)`; no input box (the composer is P14 `04`).
 */
import type { TranscriptRes } from "@arbor/api-contracts";
import { Button } from "../components/Button.js";
import { Empty } from "../components/Empty.js";
import { cn } from "../lib/utils.js";
import { EnumBadge, TimeText } from "./shared.js";

function eventKindLabel(kind: string): string {
  return (
    {
      Message: "消息",
      HumanInput: "人工调整",
      SpecialistSettled: "协作结果已确认",
      ToolCall: "工具调用",
      ToolResult: "工具结果",
      ControlResult: "控制动作",
      Observation: "运行观察",
    }[kind] ?? kind
  );
}

function summaryLabel(summary: string): string {
  return summary.startsWith("session-entry:") ? "历史会话记录" : summary;
}

export function TranscriptView({
  res,
  onLoadMore,
}: {
  readonly res: TranscriptRes;
  readonly onLoadMore?: ((cursor: string) => void) | undefined;
}) {
  const nextCursor = res.nextCursor;
  const visibleEntries = res.entries.filter(
    (entry) => entry.kind !== "ModelOutput",
  );
  return (
    <div className={cn("arbor-view-stack", "flex flex-col gap-ui-3")}>
      {visibleEntries.length === 0 ? (
        <Empty>无会话记录</Empty>
      ) : (
        <ul
          className={cn(
            "arbor-conversation-list",
            "flex flex-col gap-ui-4 m-0 p-0 list-none",
          )}
        >
          {visibleEntries.map((entry, index) => {
            // The legacy arm's `kind: string` overlaps the turn literals, so
            // narrow by property presence (the frozen arms are distinguished
            // by their payload fields, not by the tag alone).
            if ("messageId" in entry) {
              return (
                <li
                  key={`human:${entry.messageId}`}
                  className={cn(
                    "arbor-conversation-turn arbor-conversation-human",
                    "flex max-w-[min(84%,_48rem)] flex-col gap-ui-1 p-[var(--arbor-space-3)_var(--arbor-space-4)] border border-solid border-border rounded-lg text-foreground [&_.arbor-time]:text-subtle [&_.arbor-time]:text-caption max-[47.99rem]:max-w-[100%] self-end rounded-br-[var(--arbor-space-1)] border-[color-mix(in_srgb,_var(--arbor-leaf)_18%,_var(--arbor-line))] bg-accent",
                  )}
                  data-conversation-turn-key={`human:${entry.messageId}`}
                >
                  <span
                    className={cn(
                      "arbor-conversation-author",
                      "text-primary text-caption font-bold tracking-[0.02em]",
                    )}
                  >
                    你
                  </span>
                  <span
                    className={cn(
                      "arbor-conversation-body",
                      "wrap-anywhere whitespace-pre-wrap leading-[1.65]",
                    )}
                  >
                    {entry.body}
                  </span>
                  <TimeText at={entry.occurredAt} />
                </li>
              );
            }
            if ("executionId" in entry) {
              return (
                <li
                  key={`assistant:${entry.executionId}:${entry.occurredAt}`}
                  className={cn(
                    "arbor-conversation-turn arbor-conversation-assistant",
                    "flex max-w-[min(84%,_48rem)] flex-col gap-ui-1 p-[var(--arbor-space-3)_var(--arbor-space-4)] border border-solid border-border rounded-lg text-foreground [&_.arbor-time]:text-subtle [&_.arbor-time]:text-caption max-[47.99rem]:max-w-[100%] self-start rounded-bl-[var(--arbor-space-1)] bg-card [box-shadow:0_3px_12px_color-mix(in_srgb,_var(--arbor-ink)_5%,_transparent)]",
                  )}
                  data-conversation-turn-key={`assistant:${entry.executionId}:${entry.occurredAt}`}
                >
                  <span
                    className={cn(
                      "arbor-conversation-author",
                      "text-primary text-caption font-bold tracking-[0.02em]",
                    )}
                  >
                    Arbor
                  </span>
                  <span
                    className={cn(
                      "arbor-conversation-body",
                      "wrap-anywhere whitespace-pre-wrap leading-[1.65]",
                    )}
                  >
                    {entry.body}
                  </span>
                  <TimeText at={entry.occurredAt} />
                </li>
              );
            }
            return (
              <li
                key={`${entry.at}:${String(index)}`}
                className={cn(
                  "arbor-conversation-turn arbor-conversation-event",
                  "flex max-w-[min(84%,_48rem)] flex-col gap-ui-1 p-[var(--arbor-space-3)_var(--arbor-space-4)] border border-solid border-border rounded-lg text-foreground [&_.arbor-time]:text-subtle [&_.arbor-time]:text-caption max-[47.99rem]:max-w-[100%] self-start rounded-bl-[var(--arbor-space-1)] bg-card [box-shadow:0_3px_12px_color-mix(in_srgb,_var(--arbor-ink)_5%,_transparent)]",
                )}
              >
                <EnumBadge label={eventKindLabel(entry.kind)} />
                <span>{summaryLabel(entry.summaryRef)}</span>
                <TimeText at={entry.at} />
              </li>
            );
          })}
        </ul>
      )}
      {nextCursor == null || onLoadMore === undefined ? null : (
        <Button variant="quiet" onClick={() => onLoadMore?.(nextCursor)}>
          加载更多记录
        </Button>
      )}
    </div>
  );
}
