/**
 * Phase 5 (ADR-0105) — learned weights.
 *
 * The score is a linear model (`scoreWithWeights`). Its weights were hand-set
 * on day one. *Learning What to Remember* (2026) measured hand-set 66 % vs
 * learned 77 % retention of what later mattered — the largest single gain in
 * the design. The training signal here is the ledger's own outcomes: a
 * finding that became a confirmed rule or a confirmed fix was worth acting on
 * (1); one that regressed was half right (0.5); one the user dismissed was
 * not (0). Everything else is unlabelled and only shapes the ranking objective.
 *
 * Gradient-free: coordinate descent over a grid on five positive weights,
 * renormalised to sum 1, decay held at the configured value, maximising
 * Spearman rank correlation between value and label. Below eight labelled
 * samples the labels are too few to fit, so the same search runs against
 * each finding's normalised cost share instead — "rank by what cost the
 * most", which is what the ADR's backtest step meant by tuning.
 *
 * Nothing is applied here. `applyFittedWeights` writes only when the user
 * says so in the pane.
 */

import {
  type LedgerFinding,
  type PracticeConfig,
  type PracticeWeights,
  listLedgerProjectIds,
  readLedger,
  readPracticeConfig,
  type ScoreFactors,
  scoreFactors,
  scoreWithWeights,
  writePracticeConfig,
} from "./practice";
import { POLARITY } from "./practice-extractors";

export interface FitSample {
  projectId: string;
  findingId: string;
  factors: ScoreFactors;
  /** 1 confirmed/fixed, 0.5 regressed, 0 dismissed; null = unlabelled. */
  label: number | null;
  costShare: number;
}

export interface FitResult {
  weights: PracticeWeights;
  method: "spearman-labels" | "rank-cost-share";
  samples: number;
  labelled: number;
  rhoBefore: number;
  rhoAfter: number;
  current: PracticeWeights;
}

export const MIN_LABELLED_FOR_FIT = 8;

function labelOf(f: LedgerFinding): number | null {
  switch (f.state) {
    case "confirmed":
    case "fixed":
      return 1;
    case "regressed":
      return 0.5;
    case "dismissed":
      return 0;
    default:
      return null;
  }
}

/** One sample per failure finding across the given (or all) ledgers. */
export function collectFitSamples(projectIds?: string[], config: PracticeConfig = readPracticeConfig()): FitSample[] {
  const ids = projectIds && projectIds.length > 0 ? projectIds : listLedgerProjectIds();
  const raw: Array<Omit<FitSample, "costShare"> & { costNorm: number }> = [];
  for (const projectId of ids) {
    const ledger = readLedger(projectId);
    for (const f of Object.values(ledger.findings)) {
      if (POLARITY[f.kind] !== "failure") continue;
      const factors = scoreFactors(
        {
          kind: f.kind,
          distinctSessions: f.distinctSessions,
          costTotal: f.costTotal,
          rate: f.rate,
          sessionsSinceLastSeen: f.sessionsSinceLastSeen ?? 0,
        },
        config,
      );
      const scale = config.costScale[f.kind] ?? 1;
      raw.push({ projectId, findingId: f.id, factors, label: labelOf(f), costNorm: f.costTotal / scale });
    }
  }
  const total = raw.reduce((a, r) => a + r.costNorm, 0) || 1;
  return raw.map(({ costNorm, ...r }) => ({ ...r, costShare: costNorm / total }));
}

function ranks(xs: number[]): number[] {
  const order = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(xs.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[order[k]![1]] = r;
    i = j + 1;
  }
  return out;
}

/** Spearman rank correlation; 0 when degenerate. */
export function spearman(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length < 3) return 0;
  const ra = ranks(a);
  const rb = ranks(b);
  const n = a.length;
  const ma = ra.reduce((x, y) => x + y, 0) / n;
  const mb = rb.reduce((x, y) => x + y, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const xa = ra[i]! - ma;
    const xb = rb[i]! - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  const den = Math.sqrt(da * db);
  return den === 0 ? 0 : num / den;
}

const POSITIVE: Array<keyof Omit<PracticeWeights, "decay">> = ["recurrence", "cost", "rate", "reliability", "actionability"];

function normalise(w: PracticeWeights): PracticeWeights {
  const sum = POSITIVE.reduce((a, k) => a + w[k], 0) || 1;
  const out = { ...w };
  for (const k of POSITIVE) out[k] = Math.round((w[k] / sum) * 1000) / 1000;
  return out;
}

/** Fit the five positive weights. Pure given its samples. */
export function fitWeights(samples: FitSample[], current: PracticeWeights): FitResult {
  const labelled = samples.filter((s) => s.label !== null);
  const useLabels = labelled.length >= MIN_LABELLED_FOR_FIT;
  const pool = useLabels ? labelled : samples;
  const target = pool.map((s) => (useLabels ? (s.label as number) : s.costShare));
  const objective = (w: PracticeWeights): number =>
    spearman(
      pool.map((s) => scoreWithWeights(s.factors, w)),
      target,
    );
  const rhoBefore = objective(current);
  let best = normalise({ ...current });
  let bestRho = objective(best);
  const grid = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6];
  for (let sweep = 0; sweep < 3; sweep++) {
    for (const k of POSITIVE) {
      for (const v of grid) {
        const candidate = normalise({ ...best, [k]: v });
        const rho = objective(candidate);
        if (rho > bestRho + 1e-9) {
          bestRho = rho;
          best = candidate;
        }
      }
    }
  }
  return {
    weights: best,
    method: useLabels ? "spearman-labels" : "rank-cost-share",
    samples: samples.length,
    labelled: labelled.length,
    rhoBefore: Math.round(rhoBefore * 1000) / 1000,
    rhoAfter: Math.round(bestRho * 1000) / 1000,
    current,
  };
}

export function fitPracticeWeights(projectIds?: string[]): FitResult {
  const config = readPracticeConfig();
  return fitWeights(collectFitSamples(projectIds, config), config.weights);
}

/** Write the fitted weights — only on the user's explicit apply. */
export function applyFittedWeights(fit: FitResult): PracticeConfig {
  return writePracticeConfig({
    weights: fit.weights,
    fit: { at: new Date().toISOString(), samples: fit.samples, labelled: fit.labelled, method: fit.method, rho: fit.rhoAfter },
  });
}
