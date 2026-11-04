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

1. **Stroke generation** — `agent-selected origin → free conceptual wandering → agent-selected ending → stroke`.
   The only generation pipeline. No tasks, no workload, no job simulation.
2. **Agent identity** — agents are recognizable cognitive personalities
   (`AgentProfile`) bound to a real model. They author strokes in their own style
   and can talk about themselves.
3. **Canvas** — renders strokes only. No task/work logic.

## Stack

- **Next.js 16** (App Router) + **React 19** + **TypeScript**
- **WebGL2 instanced renderer** — every stroke segment is one GPU instance drawn
  in a single `drawArraysInstanced` call; capsule SDF, additive glow, feedback trails.
- **OpenRouter** — real model-authored semantic artwork + agent chat. Failed stroke requests never become synthetic artwork.
- **Durable database storage** — PostgreSQL in production, SQLite for local development. Artworks survive process restarts and deploys.

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
- `/archive` — saved artworks, including those removed from the current canvas

## Published canvas and hosting

`data/published-canvas.json` starts with 23 available agent profiles and exactly
one labelled **wu → you** example. Only that example has fixed endpoints; its
intermediate route and number of steps are authored by the real model. The ten
previous artworks and their completed Sky remain byte-for-byte preserved in
`data/archive/published-canvas-2026-10-15.json`, but are not loaded into the default
canvas. Neither file contains provider credentials or chat history. The default
animated trail retention remains 20%.

All ordinary and Sky generation is **autonomous**. The agent chooses its first
concept, every intermediate concept, its final concept, and when to stop. The
server validates complete JSON containing 2–64 steps (a resource-safety bound,
not a target count). Every anchor must be one English word: 1–48 letters with
no spaces, punctuation, digits or hyphens. Phrases trigger a bounded model
repair; the server never splits or concatenates words to fake a valid node.
It does not resample the sequence, add detours, normalize
the endpoint words or force different semantic depths. Repeated concepts stay
in their original order. The model's entropy and confidence values are preserved.
These are publicly authored conceptual artworks, not access to hidden reasoning.

Length follows the actual agent-authored anchor count using an increasing
contrast curve. Counts 2 / 4 / 6 / 8 / 12 / 16 / 24 / 64 target respectively
0.014 / 0.03 / 0.07 / 0.18 / 0.62 / 0.90 / 1.02 / 1.12 square-canvas units,
linearly interpolated before boundary fitting. This makes a 16-word journey
18 times the target distance of a 5-word journey, without padding or cutting
either route. The short/medium/long labels are descriptive, not generation
quotas. Shared Sky uses a common scale; Studio's gentle square-root readability
gain retains contrast instead of enlarging compact marks toward one size.
Isolated playback deliberately zooms in for inspection. Pre-autonomy archived
artwork keeps its legacy length calculation; old phrase-based paths are not
silently rewritten and remain labelled historical concept format.

### Calligraphy and the material mix

`brush_treatment` is a persisted presentation choice, not an invented agent
attribute. Four slots in each ten-stroke Sky batch use a **calligraphy brush**;
the remaining six retain the original intensity-selected hard, soft, watercolor
or texture material. Individual creations use balanced five-slot groups with
two calligraphy slots. Allocation is stable across reloads, filtering, retries,
the shared canvas and isolated playback. Historical untagged works retain their
original material until an explicit migration assigns this metadata.

The calligraphy renderer sweeps a matte, asymmetric loaded belly, a pointed
lift-off and coherent bristle bundles with real unpainted longitudinal channels
(dry-brush / flying-white texture). It uses no scattered dots, brush stamps,
extra branches, bright bevel or watercolor halo. A fine continuous pigment
spine preserves the single-stroke route. Pressure controls the press/lift
silhouette; entropy and confidence shape dryness; intensity controls pigment
loading. Body width remains capped at 12 CSS pixels, with tighter limits on
compact marks. Colors, authored words, movement, length and playback timing
are unchanged. Material texture follows travelled distance deterministically,
so seeking to the same time produces the same frame.

### Durable storage and canvas ownership

Artworks, canvas visibility and transforms, available agents, and Sky batches
are saved in a database. Production uses `DATABASE_URL` for PostgreSQL. Render
fails closed if this variable is missing or storage is unavailable: it does not
silently fall back to an empty process-local canvas. Local development defaults
to `.noema/noema.sqlite`; `NOEMA_SQLITE_PATH` overrides that path. SQLite requires
Node.js 22.13 or newer and must live on persistent local storage. Do not deploy
that file to Render's ephemeral filesystem. Database credentials and local
database files must never be committed.

The bundled `wu → you` example initializes a brand-new shared canvas once.
Historical bundled artwork is imported into the Archive, not forced onto every
canvas. The shared canvas is not reseeded on refresh, process restart, or
deployment. Each new Sky asks for ten independent agent-authored strokes
(twenty in Sphere Sky), displaying and saving completed results one by one.

There is **no artwork TTL, scheduled clearing, or maximum-history eviction**.
“Remove from canvas” and “Clear canvas” change the shared visible membership
for everyone (including the active Sky view). They do not delete artwork records.
Use `/archive` to browse saved originals and restore them. Removing an agent
from the available pool never deletes that agent's artwork or provenance.
Failures to save or remove something are surfaced in the UI; failed edits roll
back to the last confirmed transform instead of claiming success.

**One public canvas, no login.** All site APIs resolve to one server-defined
shared canvas, regardless of cookies, device, or client-supplied owner headers.
The shared archive includes previously browser-scoped artworks and their original
agent authorship. The first shared access atomically merges visible legacy canvas
memberships and saved Sky jobs once; original owner records and canonical artwork
payloads are preserved. Hidden/archive-only artworks are not automatically placed
back on the canvas. An unexpired legacy generation lease blocks this migration
until the old worker finishes, rather than losing later results.

Studio polls visible shared state every three seconds and refreshes on focus.
Sky loads the latest public batch, even in a new tab or on a different device;
viewing never triggers a paid generation. Generate/retry still requires an explicit
action, and only one shared Sky batch can run at a time. All visitors can edit,
hide, clear, restore, and change the shared agent pool; confirmation dialogs state
the global impact. Same-origin checks still protect mutation APIs. This is an
open collaborative exhibition, not a private multi-tenant workspace. Keep database
backups as an additional safeguard; application retention is not a substitute for
backups. Local SQLite and production PostgreSQL remain separate databases; use the
same deployed website URL on every device to share production artwork.

Configure `OPENROUTER_API_KEY` through the hosting provider's secret environment
settings, never in Git. Existing artwork is viewable without it; model-backed
generation and chat require the configured provider. The snapshot does not
replace another application's tables. Use a dedicated logical database for
Noema when sharing an existing PostgreSQL instance.

## UI

- **Center — Canvas:** renders every generated A→B stroke. Click a stroke to focus
  + inspect it.
- **Left — Strokes / Inspector:** the stroke list and a selected-stroke inspector.
  Each stroke card has a top-right **Agent Info ↗** button → the agent detail page
  (a core navigation element). The inspector header hosts the **Edit Mode** toggle.
- **Edit Mode:** a deterministic manipulation layer (`EditModeState`). While active
  the focused stroke is draggable / rotatable (handle, or R / Shift+R), and stroke
  switching, agent switching, and generation are locked out. ESC exits.
- **Stroke creation:** choose an agent and ask it to create. No endpoint or length controls are supplied by the website.
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
| POST   | `/api/generateStroke`  | `{ agent_id?, mode?: "autonomous", canvasRevision? }` → `{ stroke }` |
| GET    | `/api/strokes`         | Shared visible strokes, no login required         |
| DELETE | `/api/strokes`         | Hide visible strokes; retain every archived original |
| DELETE | `/api/strokes?id=…`    | Hide one stroke from the shared canvas for everyone |
| GET    | `/api/archive?offset=0&limit=30` | Paginated own and public saved artworks      |
| POST   | `/api/archive`         | `{ id }` → restore an original to the shared canvas |
| POST   | `/api/agentChat`       | `{ agent_id, message, history? }` → identity reply |

Legacy `from`/`to` request fields cannot constrain autonomous generation. Only
explicit `mode: "example"` uses `wu → you`; it reuses the existing example and
deduplicates concurrent requests. Sky always uses autonomous mode, including
retries. Provider errors are safe, visible failures; no fabricated fallback is
saved. Bounded retries, cancellation, canvas-reset guards and batch idempotency
remain in effect.

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
