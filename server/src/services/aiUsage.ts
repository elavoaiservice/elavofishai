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

export const RATES: Record<string, Rate> = {
  'claude-opus-5': { input: 15, output: 75, cacheRead: 1.5 },
  'claude-opus-4-8': { input: 15, output: 75, cacheRead: 1.5 },
  'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheRead: 0.1 },
  'claude-fable-5-1': { input: 3, output: 15, cacheRead: 0.3 },
};

export function rateFor(model: string): Rate | null {
  if (RATES[model]) return RATES[model];
  // Dated snapshots (claude-sonnet-5-20260101) share their family's price.
  const base = Object.keys(RATES).find((k) => model.startsWith(k));
  return base ? RATES[base] : null;
}

/** Cost in USD for one call. Unknown model → 0, never a guess. */
export function costOf(model: string, inputTokens: number, outputTokens: number, cacheReadTokens = 0): number {
  const r = rateFor(model);
  if (!r) return 0;
  const usd =
    (inputTokens / 1e6) * r.input +
    (outputTokens / 1e6) * r.output +
    (cacheReadTokens / 1e6) * r.cacheRead;
  return Math.round(usd * 1e6) / 1e6; // to the millionth of a dollar
}

export interface UsageRecord {
  feature: 'day_plan' | 'lake_profile' | 'identify_catch';
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
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
  try {
    await prisma.aiUsage.create({
      data: {
        feature: u.feature,
        model: u.model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        costUsd: costOf(u.model, inputTokens, outputTokens, cacheReadTokens),
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
