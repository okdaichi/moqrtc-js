// https://issues.chromium.org/issues/40504498
export const isChrome: boolean = navigator.userAgent.toLowerCase().includes("chrome");

// https://bugzilla.mozilla.org/show_bug.cgi?id=1967793
export const isFirefox: boolean = navigator.userAgent.toLowerCase().includes("firefox");
