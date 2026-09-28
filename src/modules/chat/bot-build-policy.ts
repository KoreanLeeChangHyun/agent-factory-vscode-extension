// Set by the VSCE prepublish build. Local build/watch retain the experimental character.
declare const __AF_RELEASE__: boolean;
export const localCompanionAvailable = typeof __AF_RELEASE__ === "undefined" || !__AF_RELEASE__;
