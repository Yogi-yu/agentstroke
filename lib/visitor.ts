import { createHash, randomBytes } from "node:crypto";
import { isSameOriginRequest } from "@/lib/requestOrigin";

export const VISITOR_COOKIE = "noema_visitor";
export const VISITOR_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Opaque 256-bit bearer token. The database stores its hash, never the token. */
export function newVisitorToken(): string {
  return randomBytes(32).toString("hex");
}

export function visitorToken(request: Request): string | null {
  const matches = (request.headers.get("cookie") ?? "").split(";")
    .map(part => part.trim()).filter(part => part.startsWith(`${VISITOR_COOKIE}=`));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(VISITOR_COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}

export function visitorId(request: Request): string {
  const token = visitorToken(request);
  if (!token) throw new Error("NOEMA_SESSION_REQUIRED");
  return createHash("sha256").update(`noema:${token}`).digest("hex");
}

/** Never expose connection strings, provider errors or another visitor's ID. */
export async function withVisitor(request: Request, handler: (ownerId: string) => Promise<Response>): Promise<Response> {
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !isSameOriginRequest(request)) {
    return Response.json({ error: "This action must be requested from this site." }, { status: 403 });
  }
  if (!visitorToken(request)) {
    return Response.json({ code: "session_required", error: "Open or reload Noema to establish your private canvas session." }, { status: 409, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const response = await handler(visitorId(request));
    response.headers.set("Cache-Control", "private, no-store, no-transform");
    return response;
  } catch {
    return Response.json({ code: "storage_unavailable", error: "The artwork database is temporarily unavailable. No successful save is being reported. Please try again." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
