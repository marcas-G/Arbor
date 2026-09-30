import { Context, Layer, Option } from "effect";
import type { CommandHandler } from "./gateway-contracts.js";

export interface CommandHandlerRegistryService {
  readonly lookup: (
    commandType: string,
  ) => Option.Option<CommandHandler<unknown, unknown>>;
}

export class CommandHandlerRegistry extends Context.Service<
  CommandHandlerRegistry,
  CommandHandlerRegistryService
>()("arbor/CommandHandlerRegistry") {}

export const CommandHandlerRegistryLive = (
  handlers: ReadonlyArray<CommandHandler<unknown, unknown>>,
): Layer.Layer<CommandHandlerRegistry> =>
  Layer.succeed(CommandHandlerRegistry, {
    lookup: (commandType) => {
      const handler = handlers.find(
        (candidate) => candidate.commandType === commandType,
      );
      return handler === undefined ? Option.none() : Option.some(handler);
    },
  });
