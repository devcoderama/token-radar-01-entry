// The token radar's model: one snapshot of the protocol universe in, one ranked board out.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) and adds the
// pre-token protocols below that floor: the early rows the radar exists to find. A protocol is
// pre-token when its snapshot entry records no token (no market cap, no CoinGecko id, no symbol).
//
// Implied value follows only from the snapshot's own figures. No protocol name is ever special-cased:
// one function scores every row.
//
//   fee_pool  = tvl_usd x REFERENCE_YIELD_BPS / 10000
//   run_rate  = REFERENCE_YIELD_BPS x efficiency / 10000, where efficiency is the protocol's own
//               revenue yield relative to the reference: a protocol in a category whose fees run
//               hotter keeps more of its TVL each year, one whose record shows contraction keeps less
//   growth    = clamp(change_7d, GROWTH_FLOOR, GROWTH_CAP) in per cent
//   growth_mult = 1 + growth/100 x GROWTH_WEIGHT
//   persistence = PERSISTENCE_FLOOR + min(age_days, PERSISTENCE_DAYS)/PERSISTENCE_DAYS x PERSISTENCE_RANGE
//   scale     = 1 + min(chains, SCALE_MAX_CHAINS)/SCALE_MAX_CHAINS x SCALE_WEIGHT
//   revenue   = fee_pool x efficiency x growth_mult x persistence x scale
//   implied   = max(1, round(revenue x REVENUE_MULTIPLE))
//
// Efficiency is the protocol's own position, not a name in a list: a category whose business is fees
// on volume (a dex, a derivatives market) converts TVL into revenue at a different rate from one whose
// TVL is a store of collateral (a liquid staking token, a wrapped asset). The category field is the
// snapshot's own, and every protocol in one category is scored alike.

import type { FarmStep, Snapshot, SnapshotProtocol } from './types.ts';

/** The model's constants, as the dashboard states them. */
export interface ModelConstants {
  revenue_multiple: number;
  reference_yield_bps: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  persistence_floor: number;
  persistence_range: number;
  persistence_days: number;
  unknown_age_days: number;
  scale_weight: number;
  scale_max_chains: number;
  efficiency_default: number;
}

export const MODEL: ModelConstants = {
  revenue_multiple: 11,
  reference_yield_bps: 220,
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  persistence_floor: 0.6,
  persistence_range: 0.4,
  persistence_days: 1095,
  unknown_age_days: 365,
  scale_weight: 0.15,
  scale_max_chains: 8,
  efficiency_default: 1,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-2-revenue';

/** The board's fixed size: the watchlist plus the early radar, one row per protocol. */
export const BOARD_ROWS = 240;

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/**
 * A category's revenue efficiency: how much of a dollar locked becomes fees in a year, relative to
 * the reference yield. The category is the snapshot's own field; the words are matched on its lower
 * case, and a category no entry here names takes EFFICIENCY_DEFAULT. A protocol's name never enters.
 */
const CATEGORY_EFFICIENCY: ReadonlyArray<readonly [RegExp, number]> = [
  [/\bperp|derivative|options|prediction|basis trading/i, 1.8],
  [/\bdex|exchange|swap|liquidity|market maker|aggregator|yield|farm/i, 1.6],
  [/\bliquid staking|liquid restaking|staking pool|restaking/i, 0.7],
  [/\bbridge|canonical bridge/i, 1.2],
  [/\blend|cdp|collateral|collateral market|uncollateralized/i, 1.1],
  [/\brwa|treasury|real world/i, 0.9],
  [/\brisk curator|capital allocator|vault|curator/i, 0.85],
  [/\bstablecoin|wrapper|cdp/i, 0.6],
  [/\binsurance|cover/i, 0.8],
  [/\bgovernance|incentive/i, 0.75],
  [/\bchain|network|layer/i, 1.0],
  [/\bpayment|lightning/i, 0.5],
];

/** The efficiency a protocol's category carries, or the default. */
export function efficiencyOf(p: SnapshotProtocol, model: ModelConstants = MODEL): number {
  const category = p.category ?? '';
  if (category !== '') {
    for (const [pattern, value] of CATEGORY_EFFICIENCY) {
      if (pattern.test(category)) return value;
    }
  }
  return model.efficiency_default;
}

/** The category's short label for the dashboard, the snapshot's own words trimmed. */
export function categoryLabel(p: SnapshotProtocol): string {
  return (p.category ?? '').trim() || 'Other';
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The six factors and the implied value one protocol gets under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants = MODEL,
) {
  const age = ageDays(asOf, protocol.listed_at);
  const tvl = Math.max(0, protocol.tvl_usd);
  const efficiency = efficiencyOf(protocol, model);
  const feePool = (tvl * model.reference_yield_bps) / 10_000;
  const runRateBps = model.reference_yield_bps * efficiency;
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = clamp(rawGrowth, model.growth_floor, model.growth_cap);
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const persistenceMult =
    model.persistence_floor +
    (clamp(ageForModel, 0, model.persistence_days) / model.persistence_days) * model.persistence_range;
  const chainCount = Math.max(0, protocol.chains.length);
  const scaleMult = 1 + (Math.min(chainCount, model.scale_max_chains) / model.scale_max_chains) * model.scale_weight;
  const revenue = feePool * efficiency * growthMult * persistenceMult * scaleMult;
  const implied = Math.max(1, Math.round(revenue * model.revenue_multiple));
  return {
    implied,
    revenue: Math.round(revenue),
    feePool: Math.round(feePool),
    efficiency,
    runRateBps: Math.round(runRateBps),
    growthPct,
    growthMult,
    persistenceMult,
    scaleMult,
    age,
  };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL) {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries (it cannot, but
  // the board's coverage is the gate's row and is never gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: pre-token protocols below the watchlist floor, by TVL, capped. Never a
  // replacement for a watchlist row: a chosen protocol stays chosen.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, Math.max(0, BOARD_ROWS - chosen.size));
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => ({ p, ...impliedValue(p, snapshot.as_of, model) }));
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored;
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is derived from
 * the protocol's own record (category, chains, TVL, age), never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** One board.json row: the ranked board's row. */
export function boardRow(rank: number, p: SnapshotProtocol, v: ReturnType<typeof impliedValue>) {
  return {
    rank,
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    mcap_usd: p.mcap_usd,
    listed_at: p.listed_at,
    gecko_id: p.gecko_id,
    symbol: p.symbol,
    token_status: 'pre-token' as const,
    age_days: v.age,
    implied_value_usd: v.implied,
    revenue_usd: v.revenue,
    fee_pool_usd: v.feePool,
    efficiency: v.efficiency,
    run_rate_bps: v.runRateBps,
    model: {
      revenue_multiple: MODEL.revenue_multiple,
      reference_yield_bps: MODEL.reference_yield_bps,
      efficiency: v.efficiency,
      run_rate_bps: v.runRateBps,
      growth_pct: v.growthPct,
      growth_multiplier: round4(v.growthMult),
      persistence_multiplier: round4(v.persistenceMult),
      scale_multiplier: round4(v.scaleMult),
      age_days: v.age,
    },
    farm_steps: farmSteps(p, v.age).map(stepText),
  };
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot) {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js. */
export function radarRow(row: ReturnType<typeof boardRow>) {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    revenue_usd: row.revenue_usd,
    fee_pool_usd: row.fee_pool_usd,
    efficiency: row.efficiency,
    run_rate_bps: row.run_rate_bps,
    growth_multiplier: row.model.growth_multiplier,
    persistence_multiplier: row.model.persistence_multiplier,
    scale_multiplier: row.model.scale_multiplier,
  };
}

/** The categories the filter offers, the most common first, plus the count each holds. */
export function categoryList(rows: ReturnType<typeof radarRow>[]) {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = r.category ?? 'Other';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL) {
  const scored = buildBoard(snapshot, model);
  const board = scored.map((s, i) => boardRow(i + 1, s.p, s));
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    categories: categoryList(board.map(radarRow)),
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null. */
export function boardIssue(board: ReturnType<typeof boardRow>[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: unknown): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
