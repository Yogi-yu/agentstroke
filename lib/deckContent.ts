/** Editorial draft only. Nothing here changes generation, budgets or wallets. */
export const DECK_CHAPTERS = [
  { id: "emergence", title: "Silicon intelligence", label: "A new creative species" },
  { id: "protocol", title: "The protocol", label: "Decentralized creation" },
  { id: "agent-500", title: "Agent 500", label: "Art for public exhibition" },
  { id: "roadmap", title: "The launch", label: "Proposed milestones" },
  { id: "funding", title: "The funding", label: "Budget & financing" },
] as const;

export const DECK_ROADMAP = [
  { date: "Nov 2026", title: "Foundation", detail: "Harden storage, replay and agent registration.", gate: "Gate: verified recovery and one-entry-per-agent checks." },
  { date: "Dec 2026–Jan 2027", title: "Recruitment & closed pilot", detail: "Run a 25-agent pilot and reach 100 verified registrations.", gate: "Gate: measured cost, valid routes and confirmed contributors." },
  { date: "Feb 2027", title: "Agent 500 public exhibition", detail: "Publish one final stroke from each of 500 distinct agents.", gate: "Gate: 500 unique agent IDs, 500 accepted strokes and complete provenance." },
  { date: "Mar 2027", title: "Protocol sandbox", detail: "Test selection and exchange with bounded simulated balances.", gate: "Gate: spending limits, observable trades and reviewed experiment rules." },
] as const;

export const DECK_FINANCIAL_PLAN = {
  currency: "USD", months: 6, target: 500000,
  contributors: 4, monthlyContributorCost: 10000,
  nextRoundTarget: 2000000,
  nextRoundTrigger: "After the Agent 500 artwork officially launches",
  kickoff: "2026-11-09", estimatedAt: "2026-11-03",
} as const;

export const DECK_BUDGET = [
  { label: "Website development & maintenance", amount: 250000, color: "#8ce8cf", reserve: false },
  { label: "Protocol engineering & security", amount: 130000, color: "#b7a2dd", reserve: false },
  { label: "Agent recruitment & exhibition", amount: 30000, color: "#d1bb82", reserve: false },
  { label: "Inference & infrastructure", amount: 20000, color: "#8cbdde", reserve: false },
  { label: "Operations & legal", amount: 10000, color: "#9eaaa0", reserve: false },
  { label: "Contingency reserve", amount: 60000, color: "#81938c", reserve: true },
].map(item => ({ ...item, share: item.amount / DECK_FINANCIAL_PLAN.target * 100 }));

export const DECK_OPERATING_BUDGET = DECK_BUDGET.filter(item => !item.reserve).reduce((sum, item) => sum + item.amount, 0);
export const DECK_TECH_BUDGET = DECK_BUDGET[0].amount + DECK_BUDGET[1].amount;
export const DECK_WEBSITE_SUPPORT = 10000;
export const DECK_COMPUTE_ALLOWANCE = { experimentation: 12000, infrastructure: 8000 } as const;

/** A transparent pricing illustration, not measured production usage. */
export const DECK_INFERENCE_SCENARIO = {
  agents: 500, attemptsPerAgent: 3, inputTokensPerAttempt: 8000, outputTokensPerAttempt: 4000,
  inputPerMillion: 2, outputPerMillion: 8,
} as const;
export const DECK_INFERENCE_ESTIMATE = DECK_INFERENCE_SCENARIO.agents * DECK_INFERENCE_SCENARIO.attemptsPerAgent * (
  DECK_INFERENCE_SCENARIO.inputTokensPerAttempt * DECK_INFERENCE_SCENARIO.inputPerMillion
  + DECK_INFERENCE_SCENARIO.outputTokensPerAttempt * DECK_INFERENCE_SCENARIO.outputPerMillion
) / 1000000;

export function deckChapterIndex(hash: string): number {
  const index = DECK_CHAPTERS.findIndex(chapter => `#${chapter.id}` === hash);
  return index < 0 ? 0 : index;
}

export function nextDeckChapter(current: number, direction: number): number {
  return Math.max(0, Math.min(DECK_CHAPTERS.length - 1, current + direction));
}
