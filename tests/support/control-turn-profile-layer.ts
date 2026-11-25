import { Effect, Layer } from "effect";
import type { ControlToolRegistryService } from "../../packages/agent-runtime/src/index.js";
import {
  makeTurnProfileResolver,
  TurnProfileResolver,
} from "../../packages/model-context/src/index.js";

export const makeControlTurnProfileLayer = (
  controlCatalog: ControlToolRegistryService,
) =>
  Layer.succeed(
    TurnProfileResolver,
    makeTurnProfileResolver({
      toolCatalog: {
        visibleRefs: () => Effect.succeed([]),
        resolveForModel: (ref) =>
          Effect.fail({ _tag: "ToolNotRegistered", ref }),
      },
      controlCatalog,
    }),
  );
