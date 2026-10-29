import { buildFunctionalTestSingleWorkspaceLayer } from "../../../apps/single-workspace/dist/composition.js";
import { productionSingleWorkspaceConfig } from "../../../apps/single-workspace/dist/main.js";

/** Functional-test-only daemon composition. Production `main()` and its config
 * type cannot enable the TrustedLocal process adapter. */
export const functionalTestMain = (overrides = {}, options = {}) =>
  buildFunctionalTestSingleWorkspaceLayer(
    productionSingleWorkspaceConfig(overrides),
    options.allowTrustedLocalProcessExecution === true,
  );
