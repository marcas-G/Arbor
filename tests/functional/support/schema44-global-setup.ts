import { createFunctionalSchema44Template } from "./schema44-bootstrap.js";

export default async function functionalSchema44GlobalSetup() {
  const teardown = await createFunctionalSchema44Template();
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    teardown();
  };
  const onSignal = () => cleanup();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return cleanup;
}
