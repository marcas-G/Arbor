export interface CapturedProviderToolCall {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface RequiredProviderResponseToolCall {
  readonly name: string;
  readonly requiredArguments?: Readonly<Record<string, unknown>>;
  readonly allowedAdditionalArguments?: ReadonlyArray<string>;
  readonly numericArgumentMaximums?: Readonly<Record<string, number>>;
}

export interface ProviderResponseGateSelector {
  readonly requiredAdvertisedToolName?: string;
  readonly requiredMessageText?: string;
  readonly requiredResponseToolCall?: RequiredProviderResponseToolCall;
}

export declare const decodeProviderToolCalls: (
  responseBodyBase64: string,
) => ReadonlyArray<CapturedProviderToolCall>;

export declare const providerRequestMatchesSelector: (
  request: unknown,
  selector: ProviderResponseGateSelector | undefined,
) => boolean;

export declare const providerResponseMatchesSelector: (
  request: unknown,
  selector: ProviderResponseGateSelector | undefined,
  responseBodyBase64?: string,
) => boolean;
