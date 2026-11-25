import { Layer } from "effect";
import {
  AgentLoopActionProgressionServiceLive,
  type AgentLoopActionProgressionServiceOptions,
} from "./agent-loop-action-progression-service.js";
import { AgentLoopDriverLive } from "./agent-loop-driver.js";

export type AgentLoopRuntimeOptions = AgentLoopActionProgressionServiceOptions;

export const AgentLoopRuntimeLive = (options: AgentLoopRuntimeOptions) =>
  Layer.provide(
    AgentLoopDriverLive({
      ...(options.qualificationProbe === undefined
        ? {}
        : { qualificationProbe: options.qualificationProbe }),
    }),
    AgentLoopActionProgressionServiceLive(options),
  );
