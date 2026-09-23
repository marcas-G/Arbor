import type { MessageId, WorkspaceId } from "./ids.js";

/** P6 `02` §1 (D2). The four model-visible message kinds. Report is
 * cognitive upward exposure — NOT a Deliverable and cannot satisfy any
 * Dependency (P7 owns satisfaction). */
export const MESSAGE_KINDS = [
  "Query",
  "Reply",
  "Report",
  "DecisionRequest",
  /** P7 `02` §2 (v1.10 G2): Deliver hands over an existing Deliverable
   * (child → parent); it is never itself a satisfaction. */
  "Deliver",
] as const;

export type MessageKind = (typeof MESSAGE_KINDS)[number];

/** P6 `02` §2. Message urgency is fixed to Normal; Critical belongs to the
 * governance channel (P6 `04`), never to message text. */
export type MessageUrgency = "Normal";

export interface OutboundMessage {
  readonly kind: MessageKind;
  readonly recipientWorkspaceId: WorkspaceId;
  readonly bodyRef: string;
  readonly correlationId?: string | undefined;
  readonly causationId?: string | undefined;
  readonly urgency: MessageUrgency;
}

export const outboundMessage = (message: OutboundMessage): OutboundMessage =>
  message;

/** P6 `02` §4. Inbox entries are a projection of unconsumed important input
 * (SD §7.4); admission is upsert-by-entryKey (D3 rule generalized). */
export interface InboxEntry {
  readonly recipientWorkspaceId: WorkspaceId;
  readonly entryKey: string;
  readonly kind:
    | "Message"
    | "SpecialistSettled"
    | "HumanInput"
    | "Governance"
    | "HumanConversation";
  readonly summary: string;
  readonly correlationId?: string | undefined;
  readonly admittedAt: string;
}

export const messageEntryKey = (messageId: MessageId): string =>
  `msg:${messageId}`;

/** P6 `02` §4. What the deterministic promotion step may do per arrival.
 * Receive != Promote != Consume (SD §7.5); promotion never calls a model. */
export interface PromotionEffect {
  readonly closesCorrelation: string | null;
  readonly triggersReevaluation: boolean;
}

export interface InboxArrival {
  readonly recipientWorkspaceId: WorkspaceId;
  readonly kind:
    | MessageKind
    | "HumanInput"
    | "SpecialistSettled"
    | "HumanConversation";
  readonly correlationId?: string | undefined;
}

/** P6 `02` §4 (D2). Reply closes its correlation; DecisionRequest triggers
 * parent reevaluation only; Report and Query have zero canonical effects. */
export const promoteInboxArrival = (arrival: InboxArrival): PromotionEffect => {
  switch (arrival.kind) {
    case "Reply":
      return {
        closesCorrelation: arrival.correlationId ?? null,
        triggersReevaluation: false,
      };
    case "DecisionRequest":
      return { closesCorrelation: null, triggersReevaluation: true };
    case "Query":
    case "Report":
    case "HumanInput":
    case "SpecialistSettled":
    case "HumanConversation": // P14 `01` §5: chat turn promotion is empty — the conversation trigger is the P14 consumer, not inbox promotion
    case "Deliver": // P7 `02` §5: Deliver's promotion is empty — delivery is not satisfaction
      return { closesCorrelation: null, triggersReevaluation: false };
  }
};

/** P7 `02` §8: Deliver directive payload. Recipient is derived (the direct
 * parent of the executing Workspace), never model-chosen. */
export interface DeliverDirectiveSpec {
  readonly deliverableId: import("./ids.js").DeliverableId;
  readonly bodyRef: string;
  readonly correlationId?: string | undefined;
  readonly causationId?: string | undefined;
}
