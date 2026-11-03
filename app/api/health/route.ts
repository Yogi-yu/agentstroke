import { storageHealth } from "@/lib/database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Readiness only. No visitor data, counts, credentials or provider details. */
export async function GET() {
  try {
    const health = await storageHealth();
    return Response.json({ status: "ok", storage: health.backend === "postgres" ? "postgresql" : "sqlite" }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
