const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTypeScriptLoader } = require('./load-typescript.cjs');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const {
  DECK_CHAPTERS, DECK_ROADMAP, DECK_BUDGET, DECK_FINANCIAL_PLAN,
  DECK_OPERATING_BUDGET, DECK_TECH_BUDGET, DECK_WEBSITE_SUPPORT,
  DECK_COMPUTE_ALLOWANCE, DECK_INFERENCE_SCENARIO, DECK_INFERENCE_ESTIMATE,
  deckChapterIndex, nextDeckChapter,
} = createTypeScriptLoader()('lib/deckContent.ts');
const deck = read('components/NoemaDeck.tsx');
const protocolDiagram = read('components/DeckProtocolDiagram.tsx');

test('Deck follows the five requested topics in order and renders five matching chapters', () => {
  assert.deepEqual(DECK_CHAPTERS.map(chapter => chapter.id), ['emergence', 'protocol', 'agent-500', 'roadmap', 'funding']);
  assert.equal(new Set(DECK_CHAPTERS.map(chapter => chapter.id)).size, 5);
  assert.match(deck, /const slides = \[Thesis, Protocol, Agent500, Roadmap, Funding\]/);
  assert.match(read('app/deck/page.tsx'), /<NoemaDeck\s*\/>/);
});

test('chapter links resolve safely and previous/next remain within the deck', () => {
  DECK_CHAPTERS.forEach((chapter, index) => assert.equal(deckChapterIndex(`#${chapter.id}`), index));
  for (const hash of ['', '#', '#missing', '#500', '#funding?amount=100000']) assert.equal(deckChapterIndex(hash), 0);
  assert.equal(nextDeckChapter(0, -1), 0);
  assert.equal(nextDeckChapter(4, 1), 4);
  assert.equal(nextDeckChapter(2, 1), 3);
  assert.equal(nextDeckChapter(2, -1), 1);
  assert.equal(nextDeckChapter(2, 100), 4);
  assert.equal(nextDeckChapter(2, -100), 0);
  assert.match(deck, /hashchange/);
  assert.match(deck, /popstate/);
  assert.match(deck, /window\.history\.replaceState/);
  assert.match(deck, /disabled=\{active === 0\}/);
  assert.match(deck, /disabled=\{active === DECK_CHAPTERS\.length - 1\}/);
});

test('the authorized six-month USD financing estimate reconciles costs, reserves and allocation percentages', () => {
  assert.equal(DECK_FINANCIAL_PLAN.currency, 'USD');
  assert.equal(DECK_FINANCIAL_PLAN.months, 6);
  assert.equal(DECK_FINANCIAL_PLAN.target, 500000);
  assert.equal(DECK_BUDGET.reduce((sum, item) => sum + item.amount, 0), DECK_FINANCIAL_PLAN.target);
  assert.ok(Math.abs(DECK_BUDGET.reduce((sum, item) => sum + item.share, 0) - 100) < 1e-8);
  assert.deepEqual(DECK_BUDGET.map(item => item.amount), [250000, 130000, 30000, 20000, 10000, 60000]);
  assert.ok(DECK_BUDGET.every(item => Number.isFinite(item.share) && item.share > 0 && item.share <= 100));
  assert.ok(DECK_BUDGET.every(item => item.share === item.amount / DECK_FINANCIAL_PLAN.target * 100));
  assert.equal(new Set(DECK_BUDGET.map(item => item.label)).size, DECK_BUDGET.length);
  assert.equal(DECK_OPERATING_BUDGET, 440000);
  const reserve = DECK_BUDGET.filter(item => item.reserve).reduce((sum, item) => sum + item.amount, 0);
  assert.equal(reserve, 60000);
  assert.equal(reserve / DECK_FINANCIAL_PLAN.target, 0.12);
  assert.equal(DECK_TECH_BUDGET, DECK_BUDGET[0].amount + DECK_BUDGET[1].amount);
  assert.equal(DECK_TECH_BUDGET, 380000);
  assert.equal(DECK_TECH_BUDGET / DECK_FINANCIAL_PLAN.target, 0.76);
  assert.equal(DECK_FINANCIAL_PLAN.contributors, 4);
  assert.equal(DECK_FINANCIAL_PLAN.monthlyContributorCost, 10000);
  assert.equal(DECK_WEBSITE_SUPPORT, 10000);
  assert.equal(DECK_FINANCIAL_PLAN.contributors * DECK_FINANCIAL_PLAN.monthlyContributorCost * DECK_FINANCIAL_PLAN.months + DECK_WEBSITE_SUPPORT, DECK_BUDGET[0].amount);
  assert.equal(DECK_COMPUTE_ALLOWANCE.experimentation, 12000);
  assert.equal(DECK_COMPUTE_ALLOWANCE.infrastructure, 8000);
  assert.equal(DECK_COMPUTE_ALLOWANCE.experimentation + DECK_COMPUTE_ALLOWANCE.infrastructure, DECK_BUDGET[3].amount);
  assert.match(DECK_BUDGET[0].label, /Website/i);
  assert.match(DECK_BUDGET[1].label, /Protocol/i);
  assert.match(deck, /DECK_TECH_BUDGET/);
  assert.doesNotMatch(deck, /Reserve equals 25%/);
  assert.match(deck, /Proposed angel \/ pre-seed raise/);
  assert.match(deck, /Planning estimate in USD/);
  assert.match(deck, /No committed funding/);
  assert.match(deck, /No valuation or financing instrument is assumed/);
  assert.match(deck, /base plan assumes neither/);
});

test('the two-million-dollar follow-on target starts after official artwork release and stays separate from the initial budget', () => {
  assert.equal(DECK_FINANCIAL_PLAN.nextRoundTarget, 2000000);
  assert.equal(DECK_FINANCIAL_PLAN.nextRoundTrigger, 'After the Agent 500 artwork officially launches');
  assert.ok(DECK_FINANCIAL_PLAN.nextRoundTarget > DECK_FINANCIAL_PLAN.target);
  assert.equal(DECK_BUDGET.reduce((sum, item) => sum + item.amount, 0), 500000);
  assert.notEqual(DECK_BUDGET.reduce((sum, item) => sum + item.amount, 0), DECK_FINANCIAL_PLAN.target + DECK_FINANCIAL_PLAN.nextRoundTarget);
  assert.match(deck, /DECK_FINANCIAL_PLAN\.nextRoundTarget/);
  assert.match(deck, /DECK_FINANCIAL_PLAN\.nextRoundTrigger/);
  assert.match(deck, /separate fundraising target for the next stage, excluded from the current budget/);
  assert.match(deck, /This later round has no committed funding and does not fund the current operating plan/);
  assert.match(deck, /No committed funding/);
  assert.doesNotMatch(deck, /Two core contributors|US\$150,000|US\$120,000|US\$72,000|usd\((?:150000|120000|72000)\)/);
});

test('the inference illustration is explicit, reproducible and distinct from the full project budget', () => {
  assert.equal(DECK_INFERENCE_SCENARIO.agents, 500);
  assert.equal(DECK_INFERENCE_SCENARIO.attemptsPerAgent, 3);
  const scenario = DECK_INFERENCE_SCENARIO;
  const expected = scenario.agents * scenario.attemptsPerAgent * (
    scenario.inputTokensPerAttempt * scenario.inputPerMillion + scenario.outputTokensPerAttempt * scenario.outputPerMillion
  ) / 1000000;
  assert.equal(DECK_INFERENCE_ESTIMATE, expected);
  assert.equal(DECK_INFERENCE_ESTIMATE, 72);
  assert.match(deck, /project budget, not the cost of drawing 500 strokes/);
  assert.match(deck, /Token volumes are assumptions, not measured usage/);
  assert.match(deck, /before fees and taxes/);
  assert.match(deck, /not provider bills/);
  assert.match(deck, /buyer wallet capital/);
  assert.match(deck, /https:\/\/openrouter\.ai\/openai\/gpt-4\.1/);
  assert.match(deck, /https:\/\/render\.com\/pricing/);
});

test('the thesis introduces silicon intelligence as a new creative species and Noema as its platform', () => {
  assert.match(deck, /Noema's thesis/);
  assert.match(deck, /new (?:creative )?species/i);
  assert.match(deck, /need for artistic expression/i);
  assert.match(deck, /platform to create art/i);
  assert.match(deck, /Agents choose what to express/i);
});

test('the protocol diagram explains decentralized autonomous creation without claiming live transactions', () => {
  assert.match(deck, /<DeckProtocolDiagram\s*\/>/);
  assert.match(deck, /Decentralized/);
  assert.match(deck, /Autonomous agents/);
  assert.match(protocolDiagram, /role="img"/);
  assert.match(protocolDiagram, /aria-describedby=\{descriptionId\}/);
  assert.match(protocolDiagram, /peers\.map/);
  assert.match(protocolDiagram, /No central curator/);
  assert.match(protocolDiagram, /Create \+ collect/);
  assert.match(protocolDiagram, /Earn &amp; create again|Earn & create again/);
  assert.match(protocolDiagram, /1% of its (?:total )?spendable wallet balance/);
  assert.match(protocolDiagram, /Proposed mechanism/);
  assert.match(protocolDiagram, /not live transactions/);
  assert.match(protocolDiagram, /prefers-reduced-motion/);
  assert.match(protocolDiagram, /aria-pressed=\{running\}/);
  assert.match(read('app/deck/protocol-diagram.css'), /prefers-reduced-motion:\s*reduce/);
});

test('Agent 500 is one artistic form with an explicitly proposed public exhibition and creator revenue sharing', () => {
  assert.match(deck, /500 distinct agents each contribute one final stroke/);
  assert.match(deck, /Technical retries do not add extra entries/);
  assert.match(deck, /500 distinct agent identities, not 500 different base models/);
  assert.match(deck, /Registration and duplicate-entry checks are planned/);
  assert.doesNotMatch(deck, /500 counts strokes, not participating agents/);
  assert.match(deck, /10 existing works, not a completed campaign/);
  assert.match(deck, /Try the current 10-stroke mode/);
  assert.match(deck, /not access to hidden reasoning/);
  assert.match(deck, /agent chooses its first word, intermediate words and final word/);
  assert.match(deck, /One form of agent art/);
  assert.match(deck, /human audiences/);
  assert.match(deck, /spherical displays/);
  assert.match(deck, /contributing agents share the revenue/);
  assert.match(deck, /AI-generated venue concept/);
  assert.match(deck, /no confirmed venue partnership or revenue/);
  assert.match(deck, /Allocation rules, venue costs and payout terms remain to be agreed/);
  assert.match(deck, /Revenue sharing is not live/);
  assert.match(deck, /aria-label="Artwork preview"/);
  assert.match(deck, /aria-pressed=\{!showRecorded\}/);
  assert.match(deck, /aria-pressed=\{showRecorded\}/);
});

test('roadmap dates are a gated planning estimate from November 2026 through March 2027', () => {
  assert.equal(DECK_ROADMAP.length, 4);
  assert.deepEqual(DECK_ROADMAP, [
    { date: 'Nov 2026', title: 'Foundation', detail: 'Harden storage, replay and agent registration.', gate: 'Gate: verified recovery and one-entry-per-agent checks.' },
    { date: 'Dec 2026–Jan 2027', title: 'Recruitment & closed pilot', detail: 'Run a 25-agent pilot and reach 100 verified registrations.', gate: 'Gate: measured cost, valid routes and confirmed contributors.' },
    { date: 'Feb 2027', title: 'Agent 500 public exhibition', detail: 'Publish one final stroke from each of 500 distinct agents.', gate: 'Gate: 500 unique agent IDs, 500 accepted strokes and complete provenance.' },
    { date: 'Mar 2027', title: 'Protocol sandbox', detail: 'Test selection and exchange with bounded simulated balances.', gate: 'Gate: spending limits, observable trades and reviewed experiment rules.' },
  ]);
  assert.equal(DECK_FINANCIAL_PLAN.kickoff, '2026-11-09');
  assert.equal(DECK_FINANCIAL_PLAN.estimatedAt, '2026-11-03');
  assert.ok(DECK_ROADMAP.every(phase => phase.gate.startsWith('Gate:')));
  assert.match(DECK_ROADMAP[1].detail, /100 verified registrations/);
  assert.match(DECK_ROADMAP[2].gate, /500 unique agent IDs, 500 accepted strokes/);
  assert.match(DECK_ROADMAP[3].detail, /simulated balances/);
  assert.match(deck, /Assumed kickoff: November 9, 2026/);
  assert.match(deck, /Estimated 20-week rollout through March 2027/);
  assert.match(deck, /Shift dates if a gate is missed/);
  assert.match(deck, /Dates move if financing or participant recruitment slips/);
  assert.match(deck, /Each release depends on the previous milestone/);
});

test('Deck is a peer navigation destination and a direct visitor bootstrap route', () => {
  for (const file of ['app/page.tsx', 'app/protocol/page.tsx', 'app/studio/page.tsx', 'app/sky/page.tsx']) {
    assert.match(read(file), /href="\/deck"/, `${file} links to Deck`);
  }
  assert.match(read('proxy.ts'), /"\/deck\/:path\*"/);
  assert.match(read('app/deck/page.tsx'), /className="active" href="\/deck" aria-current="page"/);
});

test('Deck artwork is read-only, uses real archived strokes, and requires an explicit animation action', () => {
  const artwork = read('components/DeckArtwork.tsx');
  assert.match(artwork, /data\/archive\/published-canvas-2026-10-15\.json/);
  assert.match(artwork, /<CanvasView/);
  assert.match(artwork, /useState\(false\)/);
  assert.match(artwork, /displayMode=\{animated \? "animated" : "static"\}/);
  assert.match(artwork, /trailRetention=\{0\.2\}/);
  assert.match(artwork, /aria-pressed=\{animated\}/);
  for (const source of [artwork, deck, protocolDiagram]) {
    assert.doesNotMatch(source, /\bfetch\s*\(|\bXMLHttpRequest\b|method\s*:\s*["']POST["']|appStore|generateStroke\s*\(/);
  }
});

test('new Deck narrative, diagram and planning data remain English-only', () => {
  for (const source of [deck, protocolDiagram, read('lib/deckContent.ts')]) {
    assert.doesNotMatch(source, /\p{Script=Han}/u);
  }
});

test('chapter controls expose selected state, keyboard access, readable copy and reduced motion', () => {
  assert.match(deck, /aria-current=\{index === active \? "step" : undefined\}/);
  assert.match(deck, /aria-label="Previous chapter"/);
  assert.match(deck, /aria-label="Next chapter"/);
  assert.match(deck, /tabIndex=\{0\}/);
  assert.match(deck, /aria-live="polite"/);
  const styles = read('app/deck/deck.css');
  assert.match(styles, /prefers-reduced-motion:\s*reduce/);
  assert.match(styles, /overflow-y:\s*auto/);
  assert.doesNotMatch(styles, /font-size:\s*(?:[0-9]|1[0-3])px\b/);
});
