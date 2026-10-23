export const providerResponseMatchesSelector = (request, selector) => {
  if (selector === undefined || selector === null) return true;
  const record = typeof request === "object" && request !== null ? request : {};
  const serialized = JSON.stringify(record);
  if (
    typeof selector.requiredMessageText === "string" &&
    !serialized.includes(selector.requiredMessageText)
  ) {
    return false;
  }
  if (typeof selector.requiredAdvertisedToolName === "string") {
    const tools = record.tools;
    const names = Array.isArray(tools)
      ? tools.flatMap((tool) =>
          typeof tool?.function?.name === "string" ? [tool.function.name] : [],
        )
      : [];
    if (!names.includes(selector.requiredAdvertisedToolName)) return false;
  }
  return true;
};
