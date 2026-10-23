const safeHandshakePrefixes = [
  "functional daemon startup handshake timed out",
  "functional daemon exited before listening report",
  "duplicate functional daemon start marker",
  "invalid functional daemon start identity",
  "duplicate functional daemon listening marker",
  "functional daemon listening identity mismatch",
  "functional daemon bound unexpected port",
  "functional daemon exited before HTTP readiness",
  "functional daemon HTTP readiness timed out",
  "functional daemon startup failed",
] as const;

const wrongPortHandshake =
  /^functional daemon bound unexpected port: requested=(\d{1,5}) reported=(\d{1,5})(?:; observed=[\s\S]*)?$/u;
const readinessTimeoutHandshake =
  /^functional daemon HTTP readiness timed out after (\d{1,10})ms(?:; last=[\s\S]*)?$/u;

const isPortNumber = (value: string): boolean => {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535;
};

const isPositiveSafeInteger = (value: string): boolean => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0;
};

/** Retain only safe numeric fields from known handshake failures. */
export const safeHandshakeFailure = (error: unknown): string => {
  const message = error instanceof Error ? error.message : "";
  const portMismatch = wrongPortHandshake.exec(message);
  if (
    portMismatch?.[1] !== undefined &&
    portMismatch[2] !== undefined &&
    isPortNumber(portMismatch[1]) &&
    isPortNumber(portMismatch[2])
  ) {
    return `functional daemon bound unexpected port: requested=${portMismatch[1]} reported=${portMismatch[2]}`;
  }
  const readinessTimeout = readinessTimeoutHandshake.exec(message);
  if (
    readinessTimeout?.[1] !== undefined &&
    isPositiveSafeInteger(readinessTimeout[1])
  ) {
    return `functional daemon HTTP readiness timed out after ${readinessTimeout[1]}ms`;
  }
  return (
    safeHandshakePrefixes.find((prefix) => message.startsWith(prefix)) ??
    "functional daemon startup handshake failed"
  );
};
