// prepare-release.mjs replaces this profile for production artifacts.
export const BUILD_PROFILE = 'test';
export const BUILD_NUMBER = 16;

export function isDiagnosticsOrigin(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return true;
    return url.protocol === 'https:' && url.hostname === 'alfred-oc-agent.github.io'
      && url.port === '' && url.pathname.startsWith('/yams-familial-test/');
  } catch { return false; }
}

// Fail closed, even if a test source file is accidentally copied to production.
export const DIAGNOSTICS_ENABLED = BUILD_PROFILE === 'test'
  && isDiagnosticsOrigin(globalThis.location?.href);
