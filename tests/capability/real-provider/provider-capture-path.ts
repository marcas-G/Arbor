/**
 * The capture hook already limits records to the configured provider origin
 * and endpoint base path. Chat Completions may be mounted at the origin root
 * or under a conventional base path such as `/v1`.
 */
export const isChatCompletionsPath = (pathname: string): boolean =>
  pathname.endsWith("/chat/completions");
