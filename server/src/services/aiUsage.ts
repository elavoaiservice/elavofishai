/**
 * AI usage + cost accounting.
 *
 * Every model call records what it burned and what that cost, computed at call
 * time from the rate table below. Storing the dollar figure rather than
 * recomputing it later means a future price change can't silently rewrite last
 * month's numbers.
 *
 * Rates are USD per million tokens. Keep them in step with
 * https://docs.anthropic.com/en/docs/about-claude/pricing — an unknown model
 * costs 0 and is flagged in the admin view rather than guessed at.
 */
import { prisma } from '../db';

export interface Rate {
  input: number;
  output: number;
  cacheRead: number;
}

/** Server-side web search, billed per search on top of tokens. */
export const WEB_SEARCH_USD_PER_SEARCH = 10 / 1000;

export const RATES: Record<string, Rate> = {
  // Anthropic — USD per million tokens.
  // Fable 5.1 is the exception to the 0.1x cache-read rule: 0.025x.
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
  // OpenAI — USD per million tokens.
  'gpt-5-mini': { input: 0.25, output: 2, cacheRead: 0.025 },
  'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cacheRead: 0.075 },
  'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25 },
};

export function rateFor(model: string): Rate | null {
  if (RATES[model]) return RATES[model];
  // Dated snapshots (claude-sonnet-5-20260101) share their family's price.
  const base = Object.keys(RATES).find((k) => model.startsWith(k));
  return base ? RATES[base] : null;
}

/** Cost in USD for one call. Unknown model → 0, never a guess. */
export function costOf(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  webSearches = 0
): number {
  const r = rateFor(model);
  // Searches are billed even when the model itself isn't priced here.
  const search = webSearches * WEB_SEARCH_USD_PER_SEARCH;
  if (!r) return Math.round(search * 1e6) / 1e6;
  const usd =
    (inputTokens / 1e6) * r.input +
    (outputTokens / 1e6) * r.output +
    (cacheReadTokens / 1e6) * r.cacheRead +
    search;
  return Math.round(usd * 1e6) / 1e6; // to the millionth of a dollar
}

/**
 * Recompute stored costs from the rate table. Normally history is left alone —
 * a price change should not rewrite last month — but when the TABLE ITSELF was
 * wrong, the stored numbers are wrong too, and a wrong number that looks
 * authoritative is worse than no number. Returns how many rows changed.
 */
export async function recalculateCosts(): Promise<{ rows: number; changed: number; before: number; after: number }> {
  const rows = await prisma.aiUsage.findMany({
    select: { id: true, model: true, inputTokens: true, outputTokens: true, cacheReadTokens: true, webSearches: true, costUsd: true },
  });
  let changed = 0, before = 0, after = 0;
  for (const r of rows) {
    const fresh = costOf(r.model, r.inputTokens, r.outputTokens, r.cacheReadTokens, r.webSearches);
    before += r.costUsd;
    after += fresh;
    if (Math.abs(fresh - r.costUsd) > 1e-9) {
      await prisma.aiUsage.update({ where: { id: r.id }, data: { costUsd: fresh } });
      changed++;
    }
  }
  return { rows: rows.length, changed, before, after };
}

export interface UsageRecord {
  feature: 'day_plan' | 'lake_profile' | 'identify_catch';
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  webSearches?: number;
  userId?: string | null;
  lakeId?: string | null;
  ok?: boolean;
  ms?: number;
}

/** Record a call. Never throws — accounting must not break the feature. */
export async function recordUsage(u: UsageRecord): Promise<void> {
  const inputTokens = u.inputTokens || 0;
  const outputTokens = u.outputTokens || 0;
  const cacheReadTokens = u.cacheReadTokens || 0;
  const webSearches = u.webSearches || 0;
  try {
    await prisma.aiUsage.create({
      data: {
        feature: u.feature,
        model: u.model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        webSearches,
        costUsd: costOf(u.model, inputTokens, outputTokens, cacheReadTokens, webSearches),
        userId: u.userId ?? null,
        lakeId: u.lakeId ?? null,
        ok: u.ok !== false,
        ms: u.ms || 0,
      },
    });
  } catch {
    /* accounting is not worth failing a fishing plan over */
  }
}
