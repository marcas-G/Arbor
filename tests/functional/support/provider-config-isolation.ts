import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const writeFunctionalProviderConfig = (
  directory: string,
  environment: Readonly<Record<string, string | undefined>>,
): string => {
  const path = join(directory, "functional-provider-config.json");
  writeFileSync(
    path,
    JSON.stringify({
      provider: {
        deploymentId: "dep-functional",
        modelRef: "model-openai",
        endpoint: environment.ARBOR_MODEL_BASE_URL,
        wireModelName: environment.ARBOR_MODEL_NAME,
        secret: {
          kind: "env",
          ref: environment.ARBOR_MODEL_API_KEY_VAR,
        },
        executionPolicyOverrides: JSON.parse(
          environment.ARBOR_MODEL_POLICY_JSON ?? "{}",
        ),
      },
    }),
    { mode: 0o600 },
  );
  return path;
};
