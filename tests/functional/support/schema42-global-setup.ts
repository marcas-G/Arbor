import { createFunctionalSchema42Template } from "./schema42-bootstrap.js";

export default async function functionalSchema42GlobalSetup() {
  const teardown = await createFunctionalSchema42Template();
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
