const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const decodeProviderToolCalls = (responseBodyBase64) => {
  if (
    typeof responseBodyBase64 !== "string" ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(responseBodyBase64)
  ) {
    throw new Error("captured Provider response is not valid base64");
  }
  const responseText = Buffer.from(responseBodyBase64, "base64").toString(
    "utf8",
  );
  const fragments = new Map();
  const absorb = (value) => {
    if (!isRecord(value) || !Array.isArray(value.choices)) return;
    value.choices.forEach((choice, choiceOffset) => {
      if (!isRecord(choice)) return;
      const choiceIndex = Number.isInteger(choice.index)
        ? choice.index
        : choiceOffset;
      const calls = choice.delta?.tool_calls ?? choice.message?.tool_calls;
      if (!Array.isArray(calls)) return;
      calls.forEach((call, callOffset) => {
        if (!isRecord(call)) return;
        const callIndex = Number.isInteger(call.index)
          ? call.index
          : callOffset;
        const key = `${choiceIndex}:${callIndex}`;
        const fragment = fragments.get(key) ?? { name: "", argumentsText: "" };
        if (typeof call.function?.name === "string") {
          fragment.name += call.function.name;
        }
        if (typeof call.function?.arguments === "string") {
          fragment.argumentsText += call.function.arguments;
        } else if (call.function?.arguments !== undefined) {
          fragment.argumentsText += JSON.stringify(call.function.arguments);
        }
        fragments.set(key, fragment);
      });
    });
  };

  const dataLines = responseText
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data: "));
  if (dataLines.length === 0 && responseText.trim().length > 0) {
    try {
      absorb(JSON.parse(responseText));
    } catch {
      throw new Error("captured Provider response has invalid JSON");
    }
  } else {
    for (const line of dataLines) {
      const data = line.slice(6);
      if (data === "[DONE]") continue;
      try {
        absorb(JSON.parse(data));
      } catch {
        throw new Error("captured Provider SSE contains invalid JSON data");
      }
    }
  }

  return [...fragments.entries()]
    .map(([key, fragment]) => {
      if (fragment.name.length === 0 || fragment.argumentsText.length === 0) {
        throw new Error("captured Provider tool call is incomplete");
      }
      let args;
      try {
        args = JSON.parse(fragment.argumentsText);
      } catch {
        throw new Error("captured Provider tool-call arguments are invalid");
      }
      if (!isRecord(args)) {
        throw new Error(
          "captured Provider tool-call arguments are not an object",
        );
      }
      return { key, name: fragment.name, arguments: args };
    })
    .sort((left, right) => {
      const [leftChoice, leftCall] = left.key.split(":").map(Number);
      const [rightChoice, rightCall] = right.key.split(":").map(Number);
      return leftChoice - rightChoice || leftCall - rightCall;
    })
    .map(({ name, arguments: args }) => ({ name, arguments: args }));
};

export const providerRequestMatchesSelector = (request, selector) => {
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

const sameJsonValue = (left, right) => {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJsonValue(value, right[index]))
    );
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      sameJsonValue(leftKeys, rightKeys) &&
      leftKeys.every((key) => sameJsonValue(left[key], right[key]))
    );
  }
  return false;
};

export const providerResponseMatchesSelector = (
  request,
  selector,
  responseBodyBase64,
) => {
  if (!providerRequestMatchesSelector(request, selector)) return false;
  const expectedCall = selector?.requiredResponseToolCall;
  if (expectedCall === undefined) return true;
  if (responseBodyBase64 === undefined) return false;

  let calls;
  try {
    calls = decodeProviderToolCalls(responseBodyBase64);
  } catch {
    return false;
  }
  if (calls.length !== 1 || calls[0]?.name !== expectedCall.name) return false;
  const actualArguments = calls[0]?.arguments;
  if (!isRecord(actualArguments)) return false;
  const requiredArguments = expectedCall.requiredArguments ?? {};
  if (
    Object.entries(requiredArguments).some(
      ([key, value]) => !sameJsonValue(actualArguments[key], value),
    )
  ) {
    return false;
  }
  const allowedArguments = new Set([
    ...Object.keys(requiredArguments),
    ...(expectedCall.allowedAdditionalArguments ?? []),
  ]);
  if (Object.keys(actualArguments).some((key) => !allowedArguments.has(key))) {
    return false;
  }
  return Object.entries(expectedCall.numericArgumentMaximums ?? {}).every(
    ([key, maximum]) =>
      actualArguments[key] === undefined ||
      (typeof actualArguments[key] === "number" &&
        Number.isFinite(actualArguments[key]) &&
        actualArguments[key] >= 1 &&
        actualArguments[key] <= maximum),
  );
};
