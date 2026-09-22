import type { ViewRequestMap } from "@arbor/api-contracts";
import type { ViewId } from "@arbor/domain";
import { Effect } from "effect";
import type { TransportCredential } from "./auth.js";
import type {
  ExternalCommandEnvelope,
  TransportResponse,
} from "./contracts.js";
import { isViewId, type TransportCore } from "./core.js";
import {
  failureResponse,
  invalidCommandProblem,
  unknownViewProblem,
} from "./errors.js";

/**
 * P12 `10` §2: the CLI admin/ops surface (health `04`, assessment `05`, worker
 * `06`). It renders the same `api-contracts` DTOs and forwards the same raw
 * commands as the other shells; no admin path constructs authority or writes
 * canonical state directly.
 */

export interface CliShell {
  readonly run: (
    argv: ReadonlyArray<string>,
  ) => Effect.Effect<TransportResponse<unknown>>;
}

const parseJson = (text: string): unknown | undefined => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const readFlag = (
  argv: ReadonlyArray<string>,
  flag: string,
): string | undefined => {
  const prefix = `${flag}=`;
  for (const arg of argv) {
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return undefined;
};

const positional = (argv: ReadonlyArray<string>): ReadonlyArray<string> =>
  argv.filter((arg) => !arg.startsWith("--"));

const credentialOf = (token: string | undefined): TransportCredential | null =>
  token === undefined ? null : { token };

export const makeCliShell = (core: TransportCore): CliShell => ({
  run: (argv) => {
    const [command, ...rest] = argv;
    if (command === "view") {
      const [view = "", requestJson] = positional(rest);
      if (!isViewId(view)) {
        return Effect.succeed(failureResponse(unknownViewProblem(view)));
      }
      if (requestJson === undefined) {
        return Effect.succeed(
          failureResponse(invalidCommandProblem("view request JSON required")),
        );
      }
      const request = parseJson(requestJson);
      if (request === undefined) {
        return Effect.succeed(
          failureResponse(invalidCommandProblem("view request JSON invalid")),
        );
      }
      return core.queryView(
        view,
        request as ViewRequestMap[ViewId],
      ) as Effect.Effect<TransportResponse<unknown>>;
    }
    if (command === "command") {
      const [envelopeJson] = positional(rest);
      if (envelopeJson === undefined) {
        return Effect.succeed(
          failureResponse(
            invalidCommandProblem("command envelope JSON required"),
          ),
        );
      }
      const envelope = parseJson(envelopeJson);
      if (
        envelope === undefined ||
        typeof envelope !== "object" ||
        envelope === null
      ) {
        return Effect.succeed(
          failureResponse(
            invalidCommandProblem("command envelope JSON invalid"),
          ),
        );
      }
      return core.submitCommand(
        credentialOf(readFlag(rest, "--token")),
        envelope as ExternalCommandEnvelope,
      );
    }
    return Effect.succeed(
      failureResponse(
        invalidCommandProblem(`unsupported cli command ${command ?? ""}`),
      ),
    );
  },
});
