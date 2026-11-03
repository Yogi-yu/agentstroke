import { NextResponse, type NextRequest } from "next/server";
import { newVisitorToken, visitorToken, VISITOR_COOKIE, VISITOR_COOKIE_MAX_AGE } from "@/lib/visitor";

/** Issue identity on the document BEFORE parallel client bootstrap requests. */
export function proxy(request: NextRequest) {
  const existing = visitorToken(request);
  const token = existing ?? newVisitorToken();
  const headers = new Headers(request.headers);
  if (!existing) {
    const otherCookies = (headers.get("cookie") ?? "").split(";")
      .map(part => part.trim()).filter(part => part && !part.startsWith(`${VISITOR_COOKIE}=`));
    headers.set("cookie", [...otherCookies, `${VISITOR_COOKIE}=${token}`].join("; "));
  }
  const response = NextResponse.next({ request: { headers } });
  response.cookies.set(VISITOR_COOKIE, token, {
    httpOnly: true, sameSite: "lax", path: "/",
    secure: request.nextUrl.protocol === "https:" || process.env.RENDER === "true",
    maxAge: VISITOR_COOKIE_MAX_AGE,
  });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  matcher: ["/", "/studio/:path*", "/sky/:path*", "/archive/:path*", "/agent/:path*", "/stroke/:path*", "/protocol/:path*", "/deck/:path*"],
};
