/**
 * One way to call a model, whichever provider it belongs to.
 *
 * The model id decides the provider: `claude-*` goes to Anthropic, `gpt-*`
 * and `o*` to OpenAI. Every feature has a primary model and an optional
 * fallback, both set in admin → Environment.
 *
 * On fallback: the honest trigger is FAILURE, not quality. A model that errors,
 * times out, gets truncated, or returns something the caller can't parse is
 * objectively unusable and worth retrying elsewhere. "Fall back if the answer
 * isn't good enough" sounds better but needs a judge model on every call, which
 * costs more than the cheap model saves — so the caller passes a `validate`
 * function (usually "did the JSON parse and contain what I need"), and that is
 * what decides.
 */
import Anthropic from '@anthropic-ai/sdk';
import { recordUsage, type UsageRecord } from './aiUsage';

export type Provider = 'anthropic' | 'openai';

export function providerFor(model: string): Provider {
  return /^(gpt-|o\d|chatgpt)/i.test(model) ? 'openai' : 'anthropic';
}

export interface LlmImage {
  mediaType: string; // image/jpeg | image/png | image/webp
  data: string; // base64, no data: prefix
}

export interface LlmRequest {
  feature: UsageRecord['feature'];
  model: string;
  fallbackModel?: string;
  prompt: string;
  maxTokens?: number;
  images?: LlmImage[];
  /** Web search (Anthropic only). Ignored by providers that don't have it. */
  webSearch?: boolean;
  /** Return false to treat the reply as unusable and try the fallback. */
  validate?: (text: string) => boolean;
  userId?: string | null;
  lakeId?: string | null;
}

export interface LlmResult {
  text: string;
  model: string;
  provider: Provider;
  usedFallback: boolean;
  webSearches: number;
}

class UnusableReply extends Error {}

async function callAnthropic(req: LlmRequest, model: string): Promise<{ text: string; usage: UsageRecord; searches: number }> {
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  if (!apiKey) throw new Error('no Anthropic API key');
  const client = new Anthropic({ apiKey, timeout: 45_000, maxRetries: 1 });

  const content: unknown[] = [];
  for (const img of req.images || []) {
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
  }
  content.push({ type: 'text', text: req.prompt });

  const stream = client.messages.stream({
    model,
    max_tokens: req.maxTokens || 2000,
    messages: [{ role: 'user', content }],
    ...(req.webSearch
      ? { tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }] as unknown as Anthropic.Tool[] }
      : {}),
  } as unknown as Anthropic.MessageCreateParamsStreaming);

  const msg = await stream.finalMessage();
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const u = msg.usage as {
    input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number;
    server_tool_use?: { web_search_requests?: number };
  };
  const searches = u?.server_tool_use?.web_search_requests ?? 0;
  if (msg.stop_reason === 'max_tokens') {
    // eslint-disable-next-line no-console
    console.error(`[llm] ${model} hit the token ceiling on ${req.feature}`);
  }
  return {
    text,
    searches,
    usage: {
      feature: req.feature, model,
      inputTokens: u?.input_tokens, outputTokens: u?.output_tokens,
      cacheReadTokens: u?.cache_read_input_tokens ?? 0,
      webSearches: searches,
      userId: req.userId ?? null, lakeId: req.lakeId ?? null,
    },
  };
}

async function callOpenAI(req: LlmRequest, model: string): Promise<{ text: string; usage: UsageRecord; searches: number }> {
  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey) throw new Error('no OpenAI API key');

  // Raw HTTP rather than another SDK dependency: one endpoint, one shape.
  const content: unknown[] = [{ type: 'text', text: req.prompt }];
  for (const img of req.images || []) {
    content.push({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.data}` } });
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      max_completion_tokens: req.maxTokens || 2000,
      messages: [{ role: 'user', content: req.images?.length ? content : req.prompt }],
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`OpenAI ${res.status}: ${detail}`);
  }
  const j = (await res.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  };
  const text = j.choices?.[0]?.message?.content || '';
  if (j.choices?.[0]?.finish_reason === 'length') {
    // eslint-disable-next-line no-console
    console.error(`[llm] ${model} hit the token ceiling on ${req.feature}`);
  }
  return {
    text,
    searches: 0,
    usage: {
      feature: req.feature, model,
      inputTokens: j.usage?.prompt_tokens, outputTokens: j.usage?.completion_tokens,
      cacheReadTokens: j.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      userId: req.userId ?? null, lakeId: req.lakeId ?? null,
    },
  };
}

async function once(req: LlmRequest, model: string): Promise<LlmResult> {
  const startedAt = Date.now();
  const provider = providerFor(model);
  try {
    const r = provider === 'openai' ? await callOpenAI(req, model) : await callAnthropic(req, model);
    await recordUsage({ ...r.usage, ms: Date.now() - startedAt });
    if (req.validate && !req.validate(r.text)) {
      throw new UnusableReply(`${model} returned something ${req.feature} could not use`);
    }
    return { text: r.text, model, provider, usedFallback: false, webSearches: r.searches };
  } catch (e) {
    if (!(e instanceof UnusableReply)) {
      // The call itself failed — still record it, so a failing model is visible
      // in the cost view rather than silently absent.
      await recordUsage({
        feature: req.feature, model, ok: false, ms: Date.now() - startedAt,
        userId: req.userId ?? null, lakeId: req.lakeId ?? null,
      });
    }
    throw e;
  }
}

/**
 * Run a request against the feature's model, falling back to the second model
 * when the first fails or returns something unusable.
 */
export async function complete(req: LlmRequest): Promise<LlmResult> {
  try {
    return await once(req, req.model);
  } catch (primaryErr) {
    const fb = (req.fallbackModel || '').trim();
    if (!fb || fb === req.model) throw primaryErr;
    // eslint-disable-next-line no-console
    console.error(`[llm] ${req.model} failed on ${req.feature} (${(primaryErr as Error).message}) — falling back to ${fb}`);
    const r = await once(req, fb);
    return { ...r, usedFallback: true };
  }
}
