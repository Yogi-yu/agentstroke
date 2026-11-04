import { NextResponse } from "next/server";

/** A shared public canvas needs no identity cookie or login handshake. */
export function proxy() {
  const response = NextResponse.next();
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  matcher: ["/", "/studio/:path*", "/sky/:path*", "/archive/:path*", "/agent/:path*", "/stroke/:path*", "/protocol/:path*", "/deck/:path*"],
};
