// URL validation. Everything here is conservative: when in doubt, reject.

export class UrlError extends Error {}

/** Parse an http(s) URL and return its origin, e.g. "http://127.0.0.1:5174". */
export function originOf(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new UrlError(`Not a valid URL: ${input}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UrlError('Only http and https URLs are supported.');
  if (url.username || url.password) throw new UrlError('URLs with embedded credentials are not allowed.');
  return url.origin;
}

export function isAllowedOrigin(origin: string, allowed: string[]): boolean {
  return allowed.includes(origin);
}

export function sameOrigin(a: string, origin: string): boolean {
  try {
    return new URL(a).origin === origin;
  } catch {
    return false;
  }
}

const APP_START_PATTERN = /^\/(?!\/)[A-Za-z0-9\-._~/]*$/;

/**
 * Combine the configured application origin with a tutorial's `app_start`.
 * `app_start` comes from untrusted documentation, so it must be a plain
 * root-relative path: no scheme, no "//", no backslashes, no percent-encoding,
 * no query or fragment, and no "." or ".." segments. The result must stay on
 * exactly the configured origin.
 */
export function resolveAppStart(appOrigin: string, appStart: string | null | undefined): string {
  const start = appStart && appStart.length > 0 ? appStart : '/';
  if (start.length > 200) throw new UrlError('app_start is too long.');
  if (!APP_START_PATTERN.test(start)) throw new UrlError(`app_start must be a plain root-relative path, got "${start}".`);
  if (start.split('/').some((seg) => seg === '.' || seg === '..')) throw new UrlError('app_start must not contain "." or ".." segments.');
  const resolved = new URL(start, appOrigin + '/');
  if (resolved.origin !== appOrigin) throw new UrlError('app_start resolves outside the application origin.');
  return resolved.href;
}

const URL_IN_TEXT = /\b(?:https?:\/\/|www\.)[^\s'"<>)]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|dev|app|co|ai|xyz|info|biz|me|ly|sh)\b(?:\/[^\s'"<>)]*)?/gi;

/** URLs or bare domains mentioned in untrusted step text that are not on the app origin. */
export function foreignUrlsInText(text: string, appOrigin: string): string[] {
  const found = text.match(URL_IN_TEXT) ?? [];
  const appHost = new URL(appOrigin).host.toLowerCase();
  return found.filter((raw) => {
    if (/^example\.(com|net|org)$/i.test(raw) || /@example\.(com|net|org)$/i.test(raw)) return false;
    const candidate = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
    try {
      return new URL(candidate).host.toLowerCase() !== appHost;
    } catch {
      return true;
    }
  });
}
