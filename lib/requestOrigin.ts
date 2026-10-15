/**
 * Check the browser-facing origin, not the server's listening address.
 * Next can build Request.url from 0.0.0.0 while the browser uses localhost.
 * Host is browser-controlled request authority (including its port); do not
 * treat arbitrary forwarded-host headers or other loopback names as aliases.
 */
export function isSameOriginRequest(request: Request): boolean {
  if (request.headers.get("sec-fetch-site")?.toLowerCase() === "cross-site") return false;
  const originHeader = request.headers.get("origin");
  // Keep existing non-browser clients compatible when no Origin is supplied.
  if (originHeader === null) return true;
  // An Origin is a serialized scheme + authority, never a URL with a path,
  // credentials, a list of origins, or an opaque/sandboxed "null" origin.
  if (!/^https?:\/\/[^/?#@\\\s,]+$/i.test(originHeader)) return false;
  try {
    const origin = new URL(originHeader);
    const target = new URL(request.url);
    if (target.protocol !== "http:" && target.protocol !== "https:") return false;
    const host = request.headers.get("host");
    if (host === null) return origin.origin === target.origin;
    if (!host || /[/\\?#@,\s]/.test(host)) return false;
    const publicTarget = new URL(`${target.protocol}//${host}`);
    // URL normalization preserves exact origin semantics (including ports),
    // while accepting hostname case and implicit HTTP/HTTPS default ports.
    return origin.origin === publicTarget.origin;
  } catch {
    return false;
  }
}
