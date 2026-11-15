// Token Radar model v2: comparables-based implied value, radar score and farm plans.
//
// Idea: a pre-token protocol has no market price, but tokenized protocols in the
// same category do. Their market-cap / TVL ratios are the market's own pricing
// for that kind of protocol. We take the snapshot's tokenized protocols, group
// them by category, and read the p25 / p50 / p75 of mcap/TVL in each group.
// A pre-token protocol's implied value is its TVL priced at its own category's
// multiples, then tilted by three facts the snapshot carries about it alone:
//
//   growth   = clamp(change_7d, -60, 120); growthMult = 1 + growth/100 * 0.5
//   maturity = 0.6 + min(age_days, 1095)/1095 * 0.4   (unknown age: 365 days)
//   breadth  = 1 + min(chains - 1, 7) * 0.03          (more chains, wider reach)
//
//   implied_low  = TVL * p25 * growthMult * maturity * breadth
//   implied      = TVL * p50 * growthMult * maturity * breadth
//   implied_high = TVL * p75 * growthMult * maturity * breadth
//
// Categories with fewer than 4 tokenized comparables fall back to the global
// distribution (128 tokenized protocols with a positive market cap): a
// 3-point percentile is a coin flip, not a pricing signal. No name is special-
// cased: the same functions score every row, and every factor is stored on
// the row so the dashboard can show the full breakdown for any protocol.
//
// Radar score (0-100) blends: 40% log implied value, 20% 7d growth,
// 15% age, 15% TVL stability (100 - |change_7d| * 1.2), 10% chain breadth.
// Board rank itself is by implied value, as the gate requires; the score is
// the at-a-glance signal the dashboard sorts and colours by as well.
//
// The board covers every watchlist slug plus EARLY_ROWS pre-token protocols
// below the floor by TVL. Live-token protocols are set aside, never ranked.

export interface SnapshotProtocol {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
}
export interface Snapshot {
  as_of: string; source: string; floor_usd: number;
  protocols: SnapshotProtocol[]; watchlist: string[];
}
export interface ModelConstants {
  growth_weight: number; growth_floor: number; growth_cap: number;
  maturity_floor: number; maturity_range: number; maturity_days: number;
  unknown_age_days: number; chain_step: number; chain_max_extra: number;
  min_comps: number;
}
export const MODEL: ModelConstants = {
  growth_weight: 0.5, growth_floor: -60, growth_cap: 120,
  maturity_floor: 0.6, maturity_range: 0.4, maturity_days: 1095,
  unknown_age_days: 365, chain_step: 0.03, chain_max_extra: 7, min_comps: 4,
};
export const MODEL_VERSION = 'radar-2';
export const EARLY_ROWS = 160;
export const LIVE_ROWS = 24;

export interface FarmStep { text: string; cost: string; time: string; }

export interface BoardRow {
  rank: number; slug: string; name: string; category: string | null;
  chains: string[]; tvl_usd: number; change_7d: number | null;
  mcap_usd: number | null; listed_at: string | null;
  gecko_id: string | null; symbol: string | null;
  token_status: 'pre-token'; age_days: number | null;
  implied_value_usd: number; implied_low_usd: number; implied_high_usd: number;
  radar_score: number;
  model: {
    multiple_p25: number; multiple_p50: number; multiple_p75: number;
    comps_count: number; comps_source: string;
    growth_pct: number; growth_multiplier: number;
    maturity_multiplier: number; chain_count: number; chain_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}
export interface RadarRow {
  rank: number; slug: string; name: string; category: string | null;
  chains: string[]; tvl_usd: number; change_7d: number | null;
  mcap_usd: number | null; listed_at: string | null; age_days: number | null;
  implied_value_usd: number; implied_low_usd: number; implied_high_usd: number;
  radar_score: number; multiple_p25: number; multiple_p50: number;
  multiple_p75: number; comps_count: number; comps_source: string;
  growth_multiplier: number; maturity_multiplier: number; chain_multiplier: number;
}
export interface LiveRow {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; mcap_usd: number | null; change_7d: number | null;
}
export interface RadarData {
  as_of: string; source: string; floor_usd: number; model: ModelConstants;
  model_version: string; watchlist_size: number; board_size: number;
  early_size: number; live_size: number; rows: RadarRow[]; live: LiveRow[];
  global_multiples: { p25: number; p50: number; p75: number; count: number };
}
export class SnapshotError extends Error {
  constructor(message: string) { super(message); this.name = 'SnapshotError'; }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}
function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
}
export function comparables(snapshot: Snapshot, model: ModelConstants = MODEL) {
  const byCat = new Map<string, number[]>();
  const global: number[] = [];
  for (const p of snapshot.protocols) {
    // A recorded market cap of zero carries no pricing signal (it is missing
    // data wearing a number), so comparables require a positive market cap.
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    global.push(ratio);
    const key = p.category ?? 'Other';
    const arr = byCat.get(key) ?? []; arr.push(ratio); byCat.set(key, arr);
  }
  global.sort((a, b) => a - b);
  for (const arr of byCat.values()) arr.sort((a, b) => a - b);
  const g = { p25: percentile(global, 0.25), p50: percentile(global, 0.5), p75: percentile(global, 0.75), count: global.length };
  function forCategory(category: string | null) {
    const arr = byCat.get(category ?? 'Other');
    if (arr !== undefined && arr.length >= model.min_comps) {
      return { p25: percentile(arr, 0.25), p50: percentile(arr, 0.5), p75: percentile(arr, 0.75), count: arr.length, source: 'category' };
    }
    return { p25: g.p25, p50: g.p50, p75: g.p75, count: g.count, source: 'global' };
  }
  return { forCategory, global: g };
}
export function impliedValue(p: SnapshotProtocol, asOf: string, mult: { p25: number; p50: number; p75: number }, model: ModelConstants = MODEL) {
  const age = ageDays(asOf, p.listed_at);
  const growthPct = clamp(finite(p.change_7d, 0), model.growth_floor, model.growth_cap);
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageFor = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor + (clamp(ageFor, 0, model.maturity_days) / model.maturity_days) * model.maturity_range;
  const chainMult = 1 + Math.min(Math.max(p.chains.length - 1, 0), model.chain_max_extra) * model.chain_step;
  const f = growthMult * maturityMult * chainMult;
  return {
    implied: Math.max(1, Math.round(p.tvl_usd * mult.p50 * f)),
    low: Math.max(1, Math.round(p.tvl_usd * mult.p25 * f)),
    high: Math.max(1, Math.round(p.tvl_usd * mult.p75 * f)),
    growthPct, growthMult, maturityMult, chainMult, age,
  };
}
export function radarScore(implied: number, growthPct: number, age: number | null, change7d: number | null, chainCount: number, model: ModelConstants = MODEL): number {
  const logPart = clamp((Math.log10(Math.max(implied, 1)) - 6) / 3.5, 0, 1) * 100;
  const growthPart = clamp(50 + growthPct * 0.4, 0, 100);
  const agePart = clamp((age ?? model.unknown_age_days) / model.maturity_days, 0, 1) * 100;
  const stabilityPart = change7d === null ? 60 : clamp(100 - Math.abs(change7d) * 1.2, 0, 100);
  const chainPart = clamp(chainCount / 8, 0, 1) * 100;
  return Math.round(0.4 * logPart + 0.2 * growthPart + 0.15 * agePart + 0.15 * stabilityPart + 0.1 * chainPart);
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const comps = comparables(snapshot, model);
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug); if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);
  const scored = [...chosen.values()].map((p) => {
    const mult = comps.forCategory(p.category);
    const v = impliedValue(p, snapshot.as_of, mult, model);
    const score = radarScore(v.implied, v.growthPct, v.age, p.change_7d, p.chains.length, model);
    return { p, mult, v, score };
  });
  scored.sort((a, b) => b.v.implied - a.v.implied || (a.p.slug < b.p.slug ? -1 : 1));
  return scored.map((s, i) => ({
    rank: i + 1, slug: s.p.slug, name: s.p.name, category: s.p.category,
    chains: s.p.chains, tvl_usd: s.p.tvl_usd, change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd, listed_at: s.p.listed_at, gecko_id: s.p.gecko_id,
    symbol: s.p.symbol, token_status: 'pre-token' as const, age_days: s.v.age,
    implied_value_usd: s.v.implied, implied_low_usd: s.v.low, implied_high_usd: s.v.high,
    radar_score: s.score,
    model: {
      // Multiples keep full precision: the dashboard recomputes implied value
      // from them and must land on the exact dollar board.json carries.
      multiple_p25: s.mult.p25, multiple_p50: s.mult.p50, multiple_p75: s.mult.p75,
      comps_count: s.mult.count, comps_source: s.mult.source,
      growth_pct: s.v.growthPct, growth_multiplier: round4(s.v.growthMult),
      maturity_multiplier: round4(s.v.maturityMult),
      chain_count: s.p.chains.length, chain_multiplier: round4(s.v.chainMult), age_days: s.v.age,
    },
    farm_steps: farmSteps(s.p, s.v.age).map(stepText),
  }));
}
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}
function chainOf(p: SnapshotProtocol): string { return p.chains.length > 0 ? p.chains[0]! : 'its main chain'; }
function secondChain(p: SnapshotProtocol): string { return p.chains.length > 1 ? p.chains[1]! : chainOf(p); }
export function gasFor(chain: string): number {
  if (chain === 'Ethereum') return 12;
  if (chain === 'Solana' || chain === 'Bitcoin') return 2;
  return 3;
}
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}
function holdDaysFor(age: number | null): number {
  if (age === null) return 30; if (age < 180) return 60; if (age < 365) return 45; return 30;
}
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase(); const n = p.name;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a top ${n} curated vault on ${chain}, picking the vault whose curator publishes its allocation rules, and keep the vault shares in the farm wallet.`;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral') || c.includes('uncollateralized')) return `Supply $${capital} of USDC as collateral to ${n} on ${chain}, then borrow at most 30% against it so the health factor stays comfortably above liquidation.`;
  if (c.includes('restak')) return `Restake $${capital} worth of the liquid staking token ${n} accepts on ${chain} and keep the restaking receipt; do not loop it into a second restaking layer.`;
  if (c.includes('liquid staking') || c.includes('staking pool') || c.includes('staking')) return `Stake $${capital} worth of the native asset through ${n} on ${chain} and hold the liquid receipt token in the farm wallet.`;
  if (c.includes('bridge') || c.includes('canonical')) return `Bridge $${capital} of USDC from Ethereum to ${chain} through ${n}, then make one real use of the bridged funds (a swap or a deposit) on the destination chain.`;
  if (c.includes('dex')) return `Add $${capital} as two-sided liquidity to ${n}'s highest-volume stable or major pair on ${chain}, then make one swap through the same pool so both sides of the venue see the wallet.`;
  if (c.includes('derivative') || c.includes('perpetual') || c.includes('interest rate')) return `Deposit $${capital} of USDC as margin on ${n} (${chain}), open one small hedged position (long and short legs of equal size) and close it after a day, keeping total fees under $5.`;
  if (c.includes('basis')) return `Open ${n}'s basis position with $${capital} on ${chain}: hold the spot leg and the offsetting short leg together, and check the funding rate before entering.`;
  if (c.includes('yield') || c.includes('farm') || c.includes('liquidity manager')) return `Deposit $${capital} into ${n}'s main vault on ${chain} and leave auto-compounding on; note the vault's lock or cooldown period in the farm log before depositing.`;
  if (c.includes('rwa')) return `Complete ${n}'s onboarding on ${chain} if it asks for it, then mint $${capital} of its yield-bearing asset and hold it; keep the mint receipt and terms in the farm log.`;
  if (c.includes('insurance')) return `Split the position: buy $${Math.max(25, Math.floor(capital / 2))} of cover from ${n} on ${chain} for a position you actually hold, and keep the policy NFT or receipt until it expires.`;
  if (c.includes('prediction')) return `Fund $${capital} on ${n} and place two small positions on liquid markets you can price yourself; avoid illiquid markets where the spread eats the position.`;
  if (c.includes('stable') || c.includes('cedefi')) return `Mint or deposit $${capital} of the stable asset through ${n} on ${chain}, then provide half of it as liquidity against USDC so the wallet both mints and trades it.`;
  if (c.includes('chain')) return `Bridge $${capital} to ${n}'s chain, make three ordinary transactions there (a transfer, a swap, a contract call) on different days, and keep a small native balance for gas.`;
  if (c.includes('privacy')) return `Deposit $${capital} through ${n} on ${chain} using its standard denomination, wait at least a day, then withdraw to a fresh address from the same wallet set.`;
  if (c.includes('index')) return `Buy $${capital} of ${n}'s index basket on ${chain} and hold it; rebalance only when the protocol itself rebalances the basket.`;
  return `Deposit $${capital} of USDC into ${n} on ${chain} through its main app flow and keep the position open; if the app offers a points or rewards page, opt in there first.`;
}
function weeklyFor(p: SnapshotProtocol, chain: string): string {
  const c = (p.category ?? '').toLowerCase(); const n = p.name;
  if (c.includes('lend') || c.includes('cdp')) return `Once a week on ${chain}, adjust the ${n} position once: repay a slice and re-borrow, or top collateral up by $10, so the wallet shows recurring lending activity, not a single deposit.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('farm') || c.includes('liquidity')) return `Once a week, make one swap of $20-30 through ${n} on ${chain} and harvest or restake any rewards the position earned, keeping gas below the reward value.`;
  if (c.includes('derivative') || c.includes('perpetual') || c.includes('basis')) return `Once a week, open and close one small hedged trade on ${n} so volume accrues steadily; stop for the week if cumulative fees pass $10.`;
  if (c.includes('bridge') || c.includes('canonical') || c.includes('chain')) return `Once a week, bridge a small amount ($20-30) in the other direction through ${n} or make one transaction on ${chain}, varying the day and amount so the pattern reads as real use.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('staking') || c.includes('restak')) return `Once a week, check the ${n} vault or staking position on ${chain}, claim any rewards it issued, and restake or compound them in the same wallet.`;
  return `Once a week, make one qualifying action in ${n} on ${chain} (a deposit, a swap, a vote or a claim, whichever its app counts) and record it in the farm log with the transaction hash.`;
}
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p); const chain2 = secondChain(p);
  const capital = capitalFor(p); const hold = holdDaysFor(age); const gas = gasFor(chain);
  return [
    { text: `Use a fresh wallet that holds only the funds you plan to farm with ${p.name}, fund it on ${chain}, and keep its seed phrase offline.`, cost: `about $${gas} of gas to fund and approve`, time: '5 minutes' },
    { text: actionFor(p, capital, chain), cost: `$${capital} of capital plus about $${gas} of gas`, time: '15 minutes to set up' },
    { text: weeklyFor(p, chain2), cost: 'about $2 of gas a week', time: '10 minutes a week' },
    { text: `Hold the ${p.name} position for at least ${hold} days, checking once a week that TVL and the app are unchanged; if the protocol announces a snapshot or points season, hold until it closes.`, cost: `the $${capital} stays in the position for ${hold} days`, time: `${hold} days` },
    { text: `Before withdrawing, open ${p.name}'s own points or rewards page and claim only from the link it publishes; log the wallet, dates, chains (${p.chains.slice(0, 3).join(', ') || chain}) and every transaction hash so the position can be repeated or unwound.`, cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
  ];
}
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, change_7d: p.change_7d }));
}
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank, slug: row.slug, name: row.name, category: row.category, chains: row.chains,
    tvl_usd: row.tvl_usd, change_7d: row.change_7d, mcap_usd: row.mcap_usd, listed_at: row.listed_at,
    age_days: row.age_days, implied_value_usd: row.implied_value_usd,
    implied_low_usd: row.implied_low_usd, implied_high_usd: row.implied_high_usd, radar_score: row.radar_score,
    multiple_p25: row.model.multiple_p25, multiple_p50: row.model.multiple_p50, multiple_p75: row.model.multiple_p75,
    comps_count: row.model.comps_count, comps_source: row.model.comps_source,
    growth_multiplier: row.model.growth_multiplier, maturity_multiplier: row.model.maturity_multiplier,
    chain_multiplier: row.model.chain_multiplier,
  };
}
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const comps = comparables(snapshot, model);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of, source: snapshot.source, floor_usd: snapshot.floor_usd,
    model, model_version: MODEL_VERSION, watchlist_size: snapshot.watchlist.length,
    board_size: board.length, early_size: early, live_size: live.length,
    rows: board.map(radarRow), live,
    global_multiples: { p25: round4(comps.global.p25), p50: round4(comps.global.p50), p75: round4(comps.global.p75), count: comps.global.count },
  };
  return { board, radar };
}
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new SnapshotError('snapshot.json is not JSON'); }
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
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    return {
      slug: p.slug, name: p.name, category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100) return `the board holds ${board.length} rows, under the 100-row minimum`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) return `all rows share the same implied value`;
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.radar_score < 0 || r.radar_score > 100) return `${r.slug} has radar score ${r.radar_score}`;
  }
  return null;
}
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
