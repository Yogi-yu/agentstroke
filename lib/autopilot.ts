import { generateStroke } from "@/lib/strokegen";
import { listStrokes } from "@/lib/store";
import { SHARED_CANVAS_OWNER } from "@/lib/sharedCanvas";
import { classifySemanticGenerationError } from "@/lib/semanticPath";
import { AUTOPILOT_TICK_MS } from "@/lib/autopilotPolicy";
import {
  autopilotEnabled, claimAutopilotTick, heartbeatAutopilotClaim,
  finishAutopilotClaim, failAutopilotClaim,
} from "@/lib/autopilotStore";

interface RuntimeLoop {
  timer: ReturnType<typeof setInterval>;
  busy: boolean;
  stopped: boolean;
  abort: AbortController | null;
}
const runtime = globalThis as typeof globalThis & { __noemaAutopilot?: RuntimeLoop };

/** No public trigger endpoint and no browser timer: one server loop + a DB lease. */
export function startAutopilot(): void {
  if (!autopilotEnabled() || runtime.__noemaAutopilot) return;
  const loop: RuntimeLoop = {
    timer: setInterval(() => { void tick(); }, AUTOPILOT_TICK_MS),
    busy: false, stopped: false, abort: null,
  };
  runtime.__noemaAutopilot = loop;
  loop.timer.unref?.();

  async function tick(): Promise<void> {
    if (loop.busy || loop.stopped) return;
    loop.busy = true;
    let claim: Awaited<ReturnType<typeof claimAutopilotTick>> = null;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let phase: "maintenance" | "generation" | "storage" = "maintenance";
    try {
      claim = await claimAutopilotTick();
      if (!claim || loop.stopped) return;
      const controller = new AbortController();
      loop.abort = controller;
      deadline = setTimeout(() => controller.abort(), 70_000);
      deadline.unref?.();
      let heartbeatBusy = false;
      const active = claim;
      heartbeat = setInterval(() => {
        if (heartbeatBusy) return;
        heartbeatBusy = true;
        void heartbeatAutopilotClaim(active.runId).then(valid => {
          if (!valid) controller.abort();
        }).catch(() => {
          // An uncertain lease must not launch another model call. The bounded
          // current call can finish and the transaction will recheck ownership.
          console.warn("[Noema autopilot] Creation lease heartbeat could not be confirmed.");
        }).finally(() => { heartbeatBusy = false; });
      }, 20_000);
      heartbeat.unref?.();
      const previous = (await listStrokes(SHARED_CANVAS_OWNER)).at(-1);
      phase = "generation";
      const stroke = await generateStroke(active.agent, "", "", active.startedAt, previous, {
        mode: "autonomous", requireModel: true, signal: controller.signal,
      });
      phase = "storage";
      // Retry only the same already-created work on a transient storage error;
      // stable run IDs make an uncertain commit idempotent, with no new model call.
      let saved = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await finishAutopilotClaim(active, stroke);
          saved = true;
          break;
        } catch (error) {
          if (attempt === 2) throw error;
          await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        }
      }
      if (saved) console.info(`[Noema autopilot] Archived stroke-auto-${active.runId}.`);
    } catch (error) {
      const message = phase === "generation" ? classifySemanticGenerationError(error).message
        : phase === "storage" ? "The completed artwork could not be saved. Storage will be checked at the next scheduled creation."
        : "Automatic studio maintenance could not reach storage. It will retry shortly.";
      console.warn(`[Noema autopilot] ${message}`);
      if (claim) await failAutopilotClaim(claim.runId, message).catch(() => {
        console.warn("[Noema autopilot] Could not save the creation status.");
      });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (deadline) clearTimeout(deadline);
      loop.abort = null;
      loop.busy = false;
    }
  }

  const stop = () => {
    loop.stopped = true;
    clearInterval(loop.timer);
    loop.abort?.abort();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  // Do not block HTTP readiness on database maintenance or paid model requests.
  void tick();
}
