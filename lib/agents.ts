// ============================================================================
// Agent Roster — REAL ECONOMIC FUNCTION AGENTS.
// ----------------------------------------------------------------------------
// Agents are economic production units in a simulated AI economy. Each maps to a
// real-world economic function across six categories. A category also defines a
// characteristic STROKE behaviour (deterministic / volatile / oscillatory / …)
// so a stroke reflects its agent's economic-function context.
// ============================================================================

import type { AgentCategory, AgentProfile, AgentStyle, MotionType } from "@/lib/types";
import { OPENROUTER_MODELS } from "@/lib/types";
import { familyOf } from "@/lib/openrouter/models";
import { hashStr } from "@/simulation/rng";

interface RosterEntry {
  name: string;
  category: AgentCategory;
  economic_function: string;
  real_world_mapping: string;
  task_domain: string;
  revenue_impact: string;
}

// ---- the workforce (23 agents across 6 economic categories) ----------------

const ROSTER: RosterEntry[] = [
  // 1. CODING / ENGINEERING → generate code, fix systems, deploy services
  { name: "CodeDev Agent", category: "coding", economic_function: "Generate production code from specs", real_world_mapping: "software engineer", task_domain: "feature & service development", revenue_impact: "Productivity / cost reduction" },
  { name: "BugFix Agent", category: "coding", economic_function: "Diagnose and repair broken systems", real_world_mapping: "SRE / maintenance engineer", task_domain: "defect resolution", revenue_impact: "Downtime cost avoidance" },
  { name: "DevOps Automation Agent", category: "coding", economic_function: "Automate build, test and deployment", real_world_mapping: "DevOps engineer", task_domain: "CI/CD & infrastructure", revenue_impact: "Operational efficiency" },
  { name: "API Integration Agent", category: "coding", economic_function: "Wire external services together", real_world_mapping: "integration engineer", task_domain: "third-party APIs & webhooks", revenue_impact: "Time-to-market acceleration" },
  { name: "System Optimization Agent", category: "coding", economic_function: "Tune systems for performance & cost", real_world_mapping: "performance engineer", task_domain: "latency, throughput, cloud spend", revenue_impact: "Infrastructure cost reduction" },

  // 2. TRADING / ARBITRAGE → detect inefficiencies and execute trades
  { name: "Crypto Arbitrage Agent", category: "trading", economic_function: "Detect and execute cross-venue arbitrage", real_world_mapping: "arbitrage trading desk", task_domain: "crypto spot markets", revenue_impact: "Direct profit" },
  { name: "Market Signal Agent", category: "trading", economic_function: "Generate tradable entry/exit signals", real_world_mapping: "quant signal researcher", task_domain: "multi-asset price feeds", revenue_impact: "Alpha generation" },
  { name: "Liquidity Sniper Agent", category: "trading", economic_function: "Snipe liquidity and new listings", real_world_mapping: "MEV / DEX trader", task_domain: "on-chain liquidity pools", revenue_impact: "Direct profit" },
  { name: "Perpetual Futures Agent", category: "trading", economic_function: "Run leveraged perp strategies", real_world_mapping: "derivatives trader", task_domain: "perpetual futures markets", revenue_impact: "Leveraged returns" },

  // 3. NEGOTIATION / PRICING → optimize costs and maximize margins
  { name: "Supplier Negotiation Agent", category: "negotiation", economic_function: "Negotiate supplier terms downward", real_world_mapping: "procurement officer", task_domain: "vendor contracts & RFQs", revenue_impact: "Margin optimization" },
  { name: "SaaS Pricing Optimizer Agent", category: "negotiation", economic_function: "Optimize SaaS price/packaging", real_world_mapping: "pricing strategist", task_domain: "tiers, discounts, willingness-to-pay", revenue_impact: "Revenue per customer" },
  { name: "Ad Bid Strategy Agent", category: "negotiation", economic_function: "Optimize auction bids for ROI", real_world_mapping: "performance media buyer", task_domain: "real-time ad auctions", revenue_impact: "Cost-per-acquisition reduction" },

  // 4. E-COMMERCE / CROSS-BORDER → generate revenue via commerce systems
  { name: "Product Listing Agent", category: "ecommerce", economic_function: "Generate optimized product listings", real_world_mapping: "marketplace merchandiser", task_domain: "catalog & SEO copy", revenue_impact: "Revenue generation" },
  { name: "Shopify Store Agent", category: "ecommerce", economic_function: "Operate and tune a storefront", real_world_mapping: "store operator", task_domain: "Shopify catalog & funnel", revenue_impact: "Conversion uplift" },
  { name: "Dropshipping Optimization Agent", category: "ecommerce", economic_function: "Source winners and cut dead SKUs", real_world_mapping: "dropshipping operator", task_domain: "product sourcing & margins", revenue_impact: "Margin & throughput" },
  { name: "Supply Chain Agent", category: "ecommerce", economic_function: "Optimize cross-border fulfillment", real_world_mapping: "logistics planner", task_domain: "inventory, routing, customs", revenue_impact: "Fulfillment cost reduction" },

  // 5. GROWTH / MARKETING → acquire users and optimize growth
  { name: "SEO Agent", category: "growth", economic_function: "Grow organic search acquisition", real_world_mapping: "SEO specialist", task_domain: "content, keywords, backlinks", revenue_impact: "Organic user acquisition" },
  { name: "Ads Optimization Agent", category: "growth", economic_function: "Optimize paid acquisition spend", real_world_mapping: "growth marketer", task_domain: "paid campaigns & creatives", revenue_impact: "Paid user acquisition" },
  { name: "Influencer Outreach Agent", category: "growth", economic_function: "Source and close influencer deals", real_world_mapping: "partnerships manager", task_domain: "creator outreach & deals", revenue_impact: "Reach & brand lift" },
  { name: "Content Virality Agent", category: "growth", economic_function: "Engineer shareable viral content", real_world_mapping: "social content strategist", task_domain: "short-form & viral loops", revenue_impact: "Viral user acquisition" },

  // 6. INTELLIGENCE / ANALYTICS → extract actionable insights from data
  { name: "Market Intelligence Agent", category: "intelligence", economic_function: "Synthesize market intelligence", real_world_mapping: "market analyst", task_domain: "industry & demand data", revenue_impact: "Strategic insight" },
  { name: "Competitor Tracking Agent", category: "intelligence", economic_function: "Track competitor moves and pricing", real_world_mapping: "competitive analyst", task_domain: "competitor signals", revenue_impact: "Defensive positioning" },
  { name: "Trend Detection Agent", category: "intelligence", economic_function: "Detect emerging trends early", real_world_mapping: "trend forecaster", task_domain: "social & search trend data", revenue_impact: "First-mover advantage" },
];

const MODELS = [...OPENROUTER_MODELS];

// Personal names — every agent has its own identity; its occupation (the
// "...Agent" title) becomes its description. Indexed 1:1 with the roster.
const AGENT_NAMES = [
  "Ada", "Linus", "Grace", "Hiro", "Nikola", "Satoshi", "Mina", "Dmitri",
  "Yusuf", "Sofia", "Marco", "Priya", "Elena", "Kenji", "Amara", "Lucas",
  "Noor", "Ivan", "Clara", "Diego", "Aisha", "Tomas", "Freya",
];

/** Build the economic agent roster (models distributed across the roster). */
export function makeAgents(): AgentProfile[] {
  return ROSTER.map((r, i) => {
    const model = MODELS[i % MODELS.length];
    return {
      id: `agent-${String(i).padStart(3, "0")}`,
      name: AGENT_NAMES[i] ?? `Agent ${i}`,
      occupation: r.name,
      category: r.category,
      economic_function: r.economic_function,
      real_world_mapping: r.real_world_mapping,
      task_domain: r.task_domain,
      revenue_impact: r.revenue_impact,
      model,
      model_type: familyOf(model),
    };
  });
}

// ----------------------------------------------------------------------------
// Category presentation
// ----------------------------------------------------------------------------

const CATEGORY_LABELS: Record<AgentCategory, string> = {
  coding: "Coding / Engineering",
  trading: "Trading / Arbitrage",
  negotiation: "Negotiation / Pricing",
  ecommerce: "E-commerce / Cross-border",
  growth: "Growth / Marketing",
  intelligence: "Intelligence / Analytics",
};

export function categoryLabel(category: AgentCategory): string {
  return CATEGORY_LABELS[category];
}

/** Signature hue per economic category — colour-codes the canvas by function. */
const CATEGORY_HUE: Record<AgentCategory, number> = {
  coding: 210, // blue
  trading: 0, // red
  negotiation: 45, // amber
  ecommerce: 145, // green
  growth: 300, // magenta
  intelligence: 190, // cyan
};

export function categoryHue(category: AgentCategory): number {
  return CATEGORY_HUE[category];
}

// ----------------------------------------------------------------------------
// Category → stroke behaviour. A stroke must reflect economic-function context:
//   coding      → structured deterministic strokes
//   trading     → high-volatility strokes
//   negotiation → oscillatory convergence strokes
//   ecommerce   → branching/expansive strokes
//   growth      → viral, heavily-branching strokes
//   intelligence→ analytical convergence strokes
// ----------------------------------------------------------------------------

export interface CategoryStrokeProfile {
  /** Motion archetype that expresses the economic function. */
  motion: MotionType;
  /** Geometry genome (hue filled in per agent). */
  style: AgentStyle;
  /** Multiplier on per-step entropy (volatility of the function). */
  entropyScale: number;
  /** Multiplier on branch probability (how much the function fans out). */
  branchScale: number;
  /** Per-step random jitter amplitude (raw volatility). */
  volatility: number;
  /** 0..1 — how strongly the stroke converges (entropy damped, confidence rises). */
  converge: number;
  /** 0..1 — damped oscillation added to entropy (negotiation back-and-forth). */
  oscillate: number;
}

const CATEGORY_STROKE: Record<AgentCategory, Omit<CategoryStrokeProfile, "style"> & { style: Omit<AgentStyle, "hue"> }> = {
  // structured, deterministic, low-noise
  coding: {
    motion: "direct",
    style: { strokeDensity: 0.5, entropyBias: 0.12, movementSmoothness: 0.95, branchingTendency: 0.08, speedFactor: 0.85 },
    entropyScale: 0.5, branchScale: 0.2, volatility: 0.0, converge: 0.35, oscillate: 0,
  },
  // jumpy, high-variance, volatile
  trading: {
    motion: "drift",
    style: { strokeDensity: 0.8, entropyBias: 0.85, movementSmoothness: 0.3, branchingTendency: 0.5, speedFactor: 0.7 },
    entropyScale: 1.5, branchScale: 0.9, volatility: 0.35, converge: 0, oscillate: 0,
  },
  // oscillatory convergence (back-and-forth that settles)
  negotiation: {
    motion: "orbital",
    style: { strokeDensity: 0.6, entropyBias: 0.45, movementSmoothness: 0.9, branchingTendency: 0.25, speedFactor: 0.55 },
    entropyScale: 0.9, branchScale: 0.4, volatility: 0.08, converge: 0.7, oscillate: 0.7,
  },
  // branching / expansive (many product paths)
  ecommerce: {
    motion: "fractal",
    style: { strokeDensity: 0.85, entropyBias: 0.5, movementSmoothness: 0.5, branchingTendency: 0.85, speedFactor: 0.6 },
    entropyScale: 1.0, branchScale: 1.4, volatility: 0.1, converge: 0.2, oscillate: 0,
  },
  // viral, heavily branching
  growth: {
    motion: "fractal",
    style: { strokeDensity: 0.9, entropyBias: 0.6, movementSmoothness: 0.4, branchingTendency: 0.95, speedFactor: 0.7 },
    entropyScale: 1.15, branchScale: 1.7, volatility: 0.15, converge: 0, oscillate: 0,
  },
  // analytical convergence (pulled toward an insight)
  intelligence: {
    motion: "attractor",
    style: { strokeDensity: 0.7, entropyBias: 0.45, movementSmoothness: 0.7, branchingTendency: 0.3, speedFactor: 0.5 },
    entropyScale: 0.7, branchScale: 0.5, volatility: 0.05, converge: 0.8, oscillate: 0,
  },
};

export function categoryStrokeProfile(category: AgentCategory): CategoryStrokeProfile {
  const c = CATEGORY_STROKE[category];
  return { ...c, style: { ...c.style, hue: categoryHue(category) } };
}

/** Render style for an agent — colour + geometry genome from its category. */
export function agentRenderStyle(category: AgentCategory): AgentStyle {
  return categoryStrokeProfile(category).style;
}

/** Deterministic latent-region offset for an agent id (canvas placement). */
export function agentRegion(id: string): number {
  return (hashStr(id) % 1000) / 1000;
}
