import { describe, it } from "vitest";
import {
  acceptConvergesPriorCommittedAcceptance,
  acceptDoesNotRetryOlderRejection,
  acceptFailsClosedWithoutCanonicalRow,
  acceptUsesNewCommandIdAfterFencingRejected,
} from "./phases-accept-result.js";
import {
  convergesPriorCommittedReceipt,
  failsClosedOnForeignWorkspaceReceipt,
  ignoresOlderDomainRejection,
  rejectsModelAuthoredChildWorkspaceId,
  usesNewCommandIdAfterFencingRejected,
} from "./phases-assign-work.js";
import { strictTrustedDecodingForPriorReceipts } from "./phases-corruption-boundaries.js";
import {
  dependencyConvergesPriorCommittedRow,
  dependencyDoesNotRetryOlderRejection,
  dependencyFailsClosedWithoutCanonicalRow,
  dependencyRejectsAnyProducerWithoutEvidence,
  dependencyReplaysExactCurrentReceipt,
  dependencyUsesNewCommandIdAfterFencingRejected,
} from "./phases-declare-dependency.js";
import {
  produceConvergesOlderCommittedReceipt,
  produceNewCommandIdAfterFenceRejection,
} from "./phases-produce-deliverable.js";
import {
  selectConvergesAfterDecisionSubmit,
  selectConvergesBeforeDecisionSubmit,
  selectDoesNotResendOlderRejection,
  selectUsesNewCommandIdRetainingLegacyId,
} from "./phases-select-current-work.js";
import {
  sendConvergesCommittedMessage,
  sendConvergesReplyAfterClosedCorrelation,
  sendDoesNotResendOlderRejection,
  sendFailsClosedWithoutCanonicalRow,
  sendUsesNewCommandIdKeepingMessageIds,
} from "./phases-send-message.js";

describe("receipt-first generation takeover for a pinned AssignWork", () => {
  it("rejects a model-authored raw direct-child WorkspaceId instead of committing without a binding", async () => {
    await rejectsModelAuthoredChildWorkspaceId();
  });

  it("uses a new CommandId after gen0 FencingRejected so gen1 can commit the same LogicalAction", async () => {
    await usesNewCommandIdAfterFencingRejected();
  });

  it("converges a prior Committed receipt before issuing a new-generation Command", async () => {
    await convergesPriorCommittedReceipt();
  });

  it("fails closed when a prior Committed receipt points to another Workspace", async () => {
    await failsClosedOnForeignWorkspaceReceipt();
  });

  it("does not treat an older domain rejection as takeover eligibility", async () => {
    await ignoresOlderDomainRejection();
  });
});

describe("takeover for another canonical control action", () => {
  it("uses a new generation CommandId after a prior ProduceDeliverable fence rejection", async () => {
    await produceNewCommandIdAfterFenceRejection();
  });

  it("converges an older committed ProduceDeliverable receipt without another command", async () => {
    await produceConvergesOlderCommittedReceipt();
  });
});

describe("receipt-first DeclareDependency takeover", () => {
  it("rejects a new AnyProducer action without evidence before Command submission", async () => {
    await dependencyRejectsAnyProducerWithoutEvidence();
  });

  it("replays an exact current receipt before consulting changed producer evidence", async () => {
    await dependencyReplaysExactCurrentReceipt();
  });

  it("uses a new CommandId after gen0 FencingRejected", async () => {
    await dependencyUsesNewCommandIdAfterFencingRejected();
  });

  it("converges a prior Committed dependency row without sending another command", async () => {
    await dependencyConvergesPriorCommittedRow();
  });

  it("fails closed when a Committed receipt has no canonical Dependency row", async () => {
    await dependencyFailsClosedWithoutCanonicalRow();
  });

  it("does not retry an older non-fencing terminal rejection", async () => {
    await dependencyDoesNotRetryOlderRejection();
  });
});

describe("receipt-first AcceptResult takeover", () => {
  it("uses a new CommandId after gen0 FencingRejected", async () => {
    await acceptUsesNewCommandIdAfterFencingRejected();
  });

  it("converges a prior Committed acceptance after the result ref is no longer ready", async () => {
    await acceptConvergesPriorCommittedAcceptance();
  });

  it("fails closed when a Committed receipt has no canonical Acceptance row", async () => {
    await acceptFailsClosedWithoutCanonicalRow();
  });

  it("does not retry an older non-fencing terminal rejection", async () => {
    await acceptDoesNotRetryOlderRejection();
  });
});

describe("receipt-first SendMessage takeover", () => {
  it("uses a new CommandId after gen0 FencingRejected while keeping message and correlation ids", async () => {
    await sendUsesNewCommandIdKeepingMessageIds();
  });

  it("converges a prior Committed message using the canonical MessageStore row", async () => {
    await sendConvergesCommittedMessage();
  });

  it("converges a prior Committed Reply after its Query correlation is closed", async () => {
    await sendConvergesReplyAfterClosedCorrelation();
  });

  it("fails closed when a Committed receipt has no canonical MessageStore row", async () => {
    await sendFailsClosedWithoutCanonicalRow();
  });

  it("does not resend an older non-fencing terminal rejection", async () => {
    await sendDoesNotResendOlderRejection();
  });
});

describe("receipt-first SelectCurrentWork takeover", () => {
  it("uses a new generation CommandId after gen0 FencingRejected and retains the legacy gen0 ID", async () => {
    await selectUsesNewCommandIdRetainingLegacyId();
  });

  it("converges a Committed receipt before DecisionRequest.submit without resending the command", async () => {
    await selectConvergesBeforeDecisionSubmit();
  });

  it("converges after DecisionRequest.submit without repeating either effect", async () => {
    await selectConvergesAfterDecisionSubmit();
  });

  it("does not resend an older non-fencing terminal rejection", async () => {
    await selectDoesNotResendOlderRejection();
  });
});

describe("prior-consumer corruption boundaries", () => {
  it.each([
    "AssignWork",
    "AcceptResult",
    "SendMessage",
    "SelectCurrentWork",
    "DeclareDependency",
    "ProduceDeliverable",
  ] as const)(
    "uses strict trusted decoding for %s prior receipts",
    async (route) => {
      await strictTrustedDecodingForPriorReceipts(route);
    },
  );
});
