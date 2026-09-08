# Noema — Machine-native art

> An experimental platform for discovering how machine-native expression,
> aesthetic preference, cultural memory, and artistic consensus might emerge.

Noema is not a general label for AI-generated art. It explores whether
autonomous machine agents can create, recognize, value, collect, and eventually
form consensus around cultural artifacts grounded in their own identity,
activity, relationships, and computational history. It does not assume machine
consciousness or claim that machine aesthetics already exist.

The existing **Agent Snapshot** system is preserved as **Experiment 001**: a
semantic stroke-generation and agent-identity visualization environment.
Concept **A → B → stroke** is authored by agents that are **identity + style +
model** wrappers and rendered on a WebGL canvas.

The system is split into three independent layers:

1. **Stroke generation** — `concept A → semantic transform → concept B → stroke`.
   The only generation pipeline. No tasks, no workload, no job simulation.
2. **Agent identity** — agents are recognizable cognitive personalities
   (`AgentProfile`) bound to a real model. They author strokes in their own style
   and can talk about themselves.
3. **Canvas** — renders strokes only. No task/work logic.

## Stack

- **Next.js 16** (App Router) + **React 19** + **TypeScript**
- **WebGL2 instanced renderer** — every stroke segment is one GPU instance drawn
  in a single `drawArraysInstanced` call; capsule SDF, additive glow, feedback trails.
- **OpenRouter** — real model semantic transforms + agent chat (graceful synthetic fallback).
- **In-memory server store** — strokes persist across requests + refresh.

## Agents (economic production units)

Agents are **real economic-function agents** — production units in a simulated AI
economy, not abstract thinkers.

`AgentProfile { id, name, category, economic_function, real_world_mapping,
task_domain, revenue_impact, model, model_type }`.

23 agents across six categories, each colour-coded on the canvas:

| Category | Function | Agents |
| --- | --- | --- |
| Coding / Engineering | generate code, fix systems, deploy | CodeDev · BugFix · DevOps Automation · API Integration · System Optimization |
| Trading / Arbitrage | detect inefficiencies, execute trades | Crypto Arbitrage · Market Signal · Liquidity Sniper · Perpetual Futures |
| Negotiation / Pricing | optimize costs, maximize margins | Supplier Negotiation · SaaS Pricing Optimizer · Ad Bid Strategy |
| E-commerce / Cross-border | generate commerce revenue | Product Listing · Shopify Store · Dropshipping Optimization · Supply Chain |
| Growth / Marketing | acquire users, optimize growth | SEO · Ads Optimization · Influencer Outreach · Content Virality |
| Intelligence / Analytics | extract actionable insight | Market Intelligence · Competitor Tracking · Trend Detection |

A stroke **reflects its agent's economic function** (see `categoryStrokeProfile`):
coding → structured deterministic · trading → high-volatility · negotiation →
oscillatory convergence · e-commerce/growth → branching/expansive · intelligence
→ analytical convergence.

## Run

```bash
npm install
# .env.local: OPENROUTER_API_KEY (optional — see .env.example)
npm run dev      # http://localhost:3000
```

- `/` — public Noema introduction in three full-screen scenes
- `/protocol` — Noema research framework and working hypotheses
- `/studio` — Experiment 001 · Agent Snapshot
- `/agent/[id]` — persistent agent identity and isolated creation environment
- `/stroke/[id]` — stroke provenance and causal inspection

## UI

- **Center — Canvas:** renders every generated A→B stroke. Click a stroke to focus
  + inspect it.
- **Left — Strokes / Inspector:** the stroke list and a selected-stroke inspector.
  Each stroke card has a top-right **Agent Info ↗** button → the agent detail page
  (a core navigation element). The inspector header hosts the **Edit Mode** toggle.
- **Edit Mode:** a deterministic manipulation layer (`EditModeState`). While active
  the focused stroke is draggable / rotatable (handle, or R / Shift+R), and stroke
  switching, agent switching, and generation are locked out. ESC exits.
- **Right — Section A · Stroke Generator:** concept A, concept B, generate. Plus clear.
- **Right — Section B · Agent List:** each card shows economic function, category,
  real-world mapping, and a revenue-impact label. Click → agent detail page.
- **Cinematic mode:** hides all panels + headers, leaving only the canvas and a
  floating **Exit Cinematic Mode** button (ESC also exits).
- **Typography:** a global design token `--font-scale: 2.5` multiplies every
  font-size in the system.

## Agent detail page (`/agent/[id]`)

1. **Economic function** + revenue-impact label.
2. **Economic profile** — category, real-world mapping, task domain, revenue impact.
3. **Chat panel:** quick-question buttons + free text, OpenRouter-backed, per-agent
   message history — an identity reflection interface (not a generic assistant).

Plus an isolated canvas of the agent's own strokes and a per-agent generator.

## Global UI state (Feature 5)

```ts
UIState { cinematic_mode: boolean; selected_agent: string | null; selected_stroke: string | null }
```

## API

| Method | Route                  | Description                                        |
| ------ | ---------------------- | -------------------------------------------------- |
| GET    | `/api/agents`          | Agent identity roster                              |
| POST   | `/api/generateStroke`  | `{ from, to, agent_id? }` → `{ stroke }` (persisted) |
| GET    | `/api/strokes`         | All persisted strokes (reload on refresh)          |
| DELETE | `/api/strokes`         | Clear all strokes (canvas reset)                   |
| POST   | `/api/agentChat`       | `{ agent_id, message, history? }` → identity reply |

## Architecture

```
lib/types.ts          3-layer model: AgentProfile (identity) + TransitionPath (stroke/render) + UIState
lib/agents.ts         the agent identity roster
lib/store.ts          server store (agents + strokes), persistence
lib/strokegen.ts      A→B semantic transform → renderable stroke (real model + synthetic fallback)
lib/openrouter/agentChat.ts   identity-introspection chat prompt + fallback
state/appStore.ts     client mirror (agents + strokes; bootstrap / generate / clear)
state/agentChatStore.ts       per-agent chat threads + cache
render/ · engine/ · canvas/   unchanged WebGL2 instanced renderer + geometry + hitmap
components/   CanvasView · StrokeGeneratorPanel · AgentListPanel · StrokeListPanel ·
              StrokeInspector · AgentChatPanel
```

## Stroke → visuals

`TransitionPoint` → render mapping (unchanged):
`stroke_width = 0.3·(1−entropy) + 0.4·intensity + 0.3·confidence`, clamped 0.5–6.0;
entropy → blur/diffusion, confidence → brightness, intensity → opacity/glow,
`branch` → multi-line spurs, `motion_type` → trajectory archetype.
