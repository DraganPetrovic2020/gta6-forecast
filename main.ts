// Launch-day Twitch viewer forecaster for make.fun's gta6-twitch-ccu-forecast-01 (Node 22, standard library only).
//
// Idea: an analog ensemble. Every comparable launch in the case carries its own release-day curve (SullyGnome's
// hourly averages). Expressed as log ratios to its own hour 1 (00:00-01:00 UTC of its release day), each curve is
// one plausible path for the target's hours 2..24. Comparables are weighted by how much they resemble the target:
//   - size of hour 1 (a launch already drawing 500k at hour 1 grows far less than one drawing 5k),
//   - how the game unlocked (rolling midnight-local console launches vs one global unlock),
//   - data quality (early-access-contaminated or weak analogues count less).
// The forecast for hour h is a mixture of normals centred on the weighted analogs' log ratios, with a kernel width
// that grows with the horizon; its 5/25/50/75/95% quantiles, times hour 1's print, are written out.
//
// Input: every <id>.in in $MAKEFUN_INPUT_DIR (else /input); output: <id>.out in $MAKEFUN_OUTPUT_DIR (else /output).

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const HOUR_MS = 3_600_000;
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];

interface Point { from: string; viewers: number; channels: number | null }
interface Comparable { name: string; day_start: string; unlock?: string; platforms?: string; hourly: Point[] }
interface Case {
  id: string;
  game: { name: string; platforms?: string };
  day_start: string;
  levels: number[];
  known: Array<{ hour: number; viewers: number }>;
  forecast: Array<{ hour: number }>;
  comparables: Comparable[] | null;
  history_hourly?: Array<{ from: string; viewers: number }> | null;
  notes?: string;
}

export interface Params {
  sizeBandwidth: number; // kernel width on ln(hour-1 viewers)
  sizeFloor: number; // the size kernel's least weight, so far-off analogs still count a little
  momentumBandwidth: number; // kernel width on ln(hour 1 / hour 0)
  platformMismatchWeight: number; // weight of an analog whose PC-or-not launch differs from the target's
  kernelBase: number; // smoothing sd (log units) at hour 2
  kernelSlope: number; // added smoothing sd per sqrt(hour - 1)
  shrink: number; // multiplies every analog log ratio (1 = none)
  unlockWeight: Record<UnlockKind, number>;
  tierWeight: Record<Tier, number>;
}

type UnlockKind = 'rolling' | 'mixed' | 'global' | 'unknown';
type Tier = 'comparable' | 'contaminated' | 'weak' | 'other';

export const DEFAULTS: Params = {
  // Tuned by leave-one-out over the comparables (each launch forecast from the others), favouring the rolling
  // midnight-local launches that resemble Grand Theft Auto VI's; kept off the exact optimum, which 11 such launches
  // cannot pin down.
  sizeBandwidth: 1.0,
  sizeFloor: 0,
  momentumBandwidth: 0.4,
  platformMismatchWeight: 0.4,
  kernelBase: 0.12,
  kernelSlope: 0.03,
  shrink: 0.9,
  unlockWeight: { rolling: 1, mixed: 0.6, unknown: 0.5, global: 0.15 },
  tierWeight: { comparable: 1, contaminated: 0.5, weak: 0.3, other: 0.5 },
};

/** How a comparable's game unlocked, read from its free-text unlock note. */
export function unlockKind(text: string | undefined): UnlockKind {
  const t = (text ?? '').toLowerCase();
  const global = /simultaneous|single (simultaneous )?global|global unlock/.test(t);
  const rolling = /midnight local|rolling/.test(t);
  if (rolling && global) return 'mixed';
  if (rolling) return 'rolling';
  if (global) return 'global';
  return 'unknown';
}

export function tierOf(text: string | undefined): Tier {
  const m = /tier:\s*([a-z-]+)/i.exec(text ?? '');
  if (!m) return 'other';
  const t = m[1].toLowerCase();
  if (t === 'comparable') return 'comparable';
  if (t.startsWith('early-access')) return 'contaminated';
  if (t === 'weak') return 'weak';
  return 'other';
}

interface Analog { name: string; v1: number; weight: number; logRatio: Map<number, number> }

/** Whether a launch's platform list includes PC on day one. */
export function launchedOnPC(platforms: string | undefined): boolean {
  return /\bPC\b/.test(platforms ?? '');
}

/** A comparable's viewers in the hour before its release day (hour 0), or null when it has no point there. */
function byHourBefore(k: Comparable, d0: number): number | null {
  for (const pt of k.hourly) if (Math.round((Date.parse(pt.from) - d0) / HOUR_MS) === -1 && pt.viewers > 0) return pt.viewers;
  return null;
}

/** The target's momentum ln(hour 1 / hour 0) from its hourly history, or null when hour 0 is missing. */
export function momentumOf(c: Case, p1: number): number | null {
  const d0 = Date.parse(c.day_start);
  for (const row of c.history_hourly ?? []) {
    if (Math.round((Date.parse(row.from) - d0) / HOUR_MS) === -1 && row.viewers > 0) return Math.log(p1 / row.viewers);
  }
  return null;
}

/** Each comparable's release-day curve as log ratios to its own hour 1, keyed by hour (2..24). */
export function analogsOf(c: Case, p: Params): Analog[] {
  const p1 = Math.max(1, c.known.find((k) => k.hour === 1)?.viewers ?? 1);
  const targetMomentum = momentumOf(c, p1);
  // The case schema names no platforms: Grand Theft Auto VI and the practice launches are all console-only.
  const targetOnPC = c.game.platforms !== undefined && launchedOnPC(c.game.platforms);
  const out: Analog[] = [];
  for (const k of c.comparables ?? []) {
    if (k.name === c.game.name) continue;
    const d0 = Date.parse(k.day_start);
    const byHour = new Map<number, number>();
    for (const pt of k.hourly) {
      const h = Math.round((Date.parse(pt.from) - d0) / HOUR_MS) + 1;
      if (h >= 1 && h <= 24 && pt.viewers > 0) byHour.set(h, pt.viewers);
    }
    const v1 = byHour.get(1);
    if (v1 === undefined) continue;
    const logRatio = new Map<number, number>();
    for (const [h, v] of byHour) if (h >= 2) logRatio.set(h, Math.log(v / v1));
    const sizeGap = (Math.log(v1) - Math.log(p1)) / p.sizeBandwidth;
    // A floor keeps every analog in play: a target bigger than any comparable (Grand Theft Auto VI may well be) must
    // not hang its whole forecast on the one or two largest launches.
    const sizeKernel = p.sizeFloor + (1 - p.sizeFloor) * Math.exp(-0.5 * sizeGap * sizeGap);
    // Momentum into hour 1 (ln of hour 1 over hour 0, the hour before the day starts): a category still climbing at
    // the checkpoint behaves differently from one already fading.
    const v0 = byHourBefore(k, d0);
    const mGap = targetMomentum !== null && v0 !== null ? (Math.log(v1 / v0) - targetMomentum) / p.momentumBandwidth : 0;
    // A PC launch lets players everywhere in at once and keeps them on through the day; a console-only target
    // (Grand Theft Auto VI, and every practice launch) follows the console analogs' clock more closely.
    const platformMatch = launchedOnPC(k.platforms) === targetOnPC ? 1 : p.platformMismatchWeight;
    const weight =
      platformMatch *
      p.unlockWeight[unlockKind(k.unlock)] *
      p.tierWeight[tierOf(k.unlock)] *
      sizeKernel *
      Math.exp(-0.5 * mGap * mGap);
    if (weight > 1e-9) out.push({ name: k.name, v1, weight, logRatio });
  }
  return out;
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 erf, |error| < 1.5e-7). */
function phi(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** Quantile at level tau of a weighted mixture of normals N(centres[i], sd^2), by bisection. */
function mixtureQuantile(centres: number[], weights: number[], sd: number, tau: number): number {
  const total = weights.reduce((a, b) => a + b, 0);
  const cdf = (x: number) => centres.reduce((s, m, i) => s + weights[i] * phi((x - m) / sd), 0) / total;
  let lo = Math.min(...centres) - 8 * sd;
  let hi = Math.max(...centres) + 8 * sd;
  for (let it = 0; it < 80; it++) {
    const mid = 0.5 * (lo + hi);
    if (cdf(mid) < tau) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** The forecast rows {hour, q} for one case. */
export function forecastCase(c: Case, p: Params = DEFAULTS): Array<{ hour: number; q: number[] }> {
  const p1 = Math.max(1, c.known.find((k) => k.hour === 1)?.viewers ?? 1);
  const analogs = analogsOf(c, p);
  return c.forecast.map(({ hour }) => {
    const centres: number[] = [];
    const weights: number[] = [];
    for (const a of analogs) {
      const lr = a.logRatio.get(hour);
      if (lr === undefined) continue;
      centres.push(p.shrink * lr);
      weights.push(a.weight);
    }
    const sd = p.kernelBase + p.kernelSlope * Math.sqrt(hour - 1);
    let logQ: number[];
    if (centres.length === 0) logQ = [-1.645, -0.674, 0, 0.674, 1.645].map((z) => z * 0.15 * Math.sqrt(hour - 1));
    else logQ = LEVELS.map((tau) => mixtureQuantile(centres, weights, sd, tau));
    const q = logQ.map((l) => Math.min(1e9, Math.max(0.01, Math.round(p1 * Math.exp(l) * 100) / 100)));
    for (let j = 1; j < q.length; j++) if (q[j] < q[j - 1]) q[j] = q[j - 1];
    return { hour, q };
  });
}

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  mkdirSync(outputDir, { recursive: true });
  for (const file of readdirSync(inputDir).filter((f) => f.endsWith('.in')).sort()) {
    const c = JSON.parse(readFileSync(join(inputDir, file), 'utf8')) as Case;
    const hours = forecastCase(c);
    writeFileSync(join(outputDir, `${file.slice(0, -3)}.out`), `${JSON.stringify({ hours })}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
