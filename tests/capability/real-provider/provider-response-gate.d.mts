export interface ProviderResponseGateSelector {
  readonly requiredAdvertisedToolName?: string;
  readonly requiredMessageText?: string;
}

export declare const providerResponseMatchesSelector: (
  request: unknown,
  selector: ProviderResponseGateSelector | undefined,
) => boolean;
