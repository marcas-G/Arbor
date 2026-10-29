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

interface SafeHandshakeClassification {
  readonly summary: string;
  readonly specificity: number;
}

const classifyHandshakeMessage = (
  message: string,
): SafeHandshakeClassification | undefined => {
  const portMismatch = wrongPortHandshake.exec(message);
  if (
    portMismatch?.[1] !== undefined &&
    portMismatch[2] !== undefined &&
    isPortNumber(portMismatch[1]) &&
    isPortNumber(portMismatch[2])
  ) {
    return {
      summary: `functional daemon bound unexpected port: requested=${portMismatch[1]} reported=${portMismatch[2]}`,
      specificity: 100,
    };
  }
  const readinessTimeout = readinessTimeoutHandshake.exec(message);
  if (
    readinessTimeout?.[1] !== undefined &&
    isPositiveSafeInteger(readinessTimeout[1])
  ) {
    return {
      summary: `functional daemon HTTP readiness timed out after ${readinessTimeout[1]}ms`,
      specificity: 100,
    };
  }
  const prefix = safeHandshakePrefixes.find((candidate) =>
    message.startsWith(candidate),
  );
  if (prefix === undefined) return undefined;
  return {
    summary: prefix,
    specificity: prefix === "functional daemon startup failed" ? 1 : 50,
  };
};

const MAX_CAUSE_DEPTH = 16;

/** Retain only safe numeric fields from known handshake failures. */
export const safeHandshakeFailure = (error: unknown): string => {
  const seen = new Set<Error>();
  let current = error;
  let best: SafeHandshakeClassification | undefined;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error) || seen.has(current)) break;
    seen.add(current);
    const classification = classifyHandshakeMessage(current.message);
    if (
      classification !== undefined &&
      (best === undefined ||
        classification.specificity > best.specificity ||
        classification.specificity === best.specificity)
    ) {
      // For equally specific classifications, prefer the deeper causal source.
      best = classification;
    }
    current = current.cause;
  }
  return best?.summary ?? "functional daemon startup handshake failed";
};
