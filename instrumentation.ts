/** Next calls this once per server process, not once per visitor or API request. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs"
    && process.env.NOEMA_AUTOPILOT_RUNTIME === "1"
    && process.env.NEXT_PHASE !== "phase-production-build") {
    const { startAutopilot } = await import("@/lib/autopilot");
    startAutopilot();
  }
}
