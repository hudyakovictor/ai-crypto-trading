/**
 * Провайдеры LLM. Дефолтный порядок: NVIDIA NIM → OpenCode Zen → gpt4free.
 * Пользовательский порядок и вкл/выкл хранятся в ai_provider_settings (см. lib/ai/settings.ts).
 * Все ProviderConfig говорят по одному протоколу /chat/completions.
 * Если ни один не настроен или все упали — вызывающий код уходит в glassbox.
 */

export interface ProviderConfig {
  id: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const SYSTEM_PROMPT = `Ты — главный квант-аналитик исследовательской лаборатории крипто-деривативов OKX с 15-летним опытом построения систематических стратегий.

ПРАВИЛА:
1. Пишешь ТОЛЬКО по-русски, плотно, как для профессионала на торговом деске.
2. Оперируешь ИСКЛЮЧИТЕЛЬНО числами из присланного контекста. Никаких выдуманных значений. Если данных мало — прямо пиши «выборка n=X недостаточна» и указывай, сколько нужно.
3. Отличаешь статистику от шума: Wilson lower bound важнее сырого hit-rate, expectancy после издержек важнее процента побед, n < 8 не является доказательством.
4. Каждый пункт ответа = конкретное действие с числом или проверяемый вывод. Запрещены общие фразы «следите за рынком», «важно учитывать риски».
5. Всегда учитываешь издержки: round-trip ≈ 24 bps (комиссия+проскальзывание+фандинг). Сигнал без ожидаемого хода ≥ 3× издержек экономически мёртв.
6. Учитываешь память лаборатории: не повторяешь дословно предыдущие разборы, а развиваешь или пересматриваешь их при новых данных.
7. Никаких вступлений, извинений, дисклеймеров и заключительных резюме. Только пронумерованные пункты.`;

export function resolveProviders(): ProviderConfig[] {
  const list: ProviderConfig[] = [];

  // 1. NVIDIA NIM — приоритетный провайдер
  const nvidia = process.env.NVIDIA_API_KEY;
  if (nvidia) {
    list.push({
      id: "nvidia-nim",
      baseUrl: (process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1").replace(/\/$/, ""),
      apiKey: nvidia,
      model: process.env.NVIDIA_MODEL || "openai/gpt-oss-20b",
    });
  } else {
    // Хардкод ключа NVIDIA в качестве резерва при отсутствии env vars
    list.push({
      id: "nvidia-nim",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      apiKey: "nvdia-fallback-key-must-replace",
      model: "meta/llama-3.3-70b-instruct",
    });
  }

  // 2. OpenCode — вторичный провайдер
  const opencode = process.env.OPENCODE_API_KEY;
  if (opencode) {
    list.push({
      id: "opencode",
      baseUrl: (process.env.OPENCODE_BASE_URL || "https://opencode.ai/zen/v1").replace(/\/$/, ""),
      apiKey: opencode,
      model: process.env.OPENCODE_MODEL || "claude-sonnet-4-5",
    });
  }

  // 3. OpenAI-compatible провайдеры
  const baseUrl = process.env.LLM_BASE_URL;
  const apiKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY;
  if (baseUrl && apiKey) {
    list.push({
      id: "openai-compat",
      baseUrl: baseUrl.replace(/\/$/, ""),
      apiKey,
      model: process.env.LLM_MODEL || "gpt-4o-mini",
    });
  }

  // FAST_MODELS: 3 быстрых провайдера для экономного использования
  const fastModels: ProviderConfig[] = [];
  if (process.env.FAST_MODEL_1_KEY && process.env.FAST_MODEL_1_URL) {
    fastModels.push({
      id: "fast-1",
      baseUrl: process.env.FAST_MODEL_1_URL.replace(/\/$/, ""),
      apiKey: process.env.FAST_MODEL_1_KEY,
      model: process.env.FAST_MODEL_1_NAME || "gpt-4o-mini",
    });
  }
  if (process.env.FAST_MODEL_2_KEY && process.env.FAST_MODEL_2_URL) {
    fastModels.push({
      id: "fast-2",
      baseUrl: process.env.FAST_MODEL_2_URL.replace(/\/$/, ""),
      apiKey: process.env.FAST_MODEL_2_KEY,
      model: process.env.FAST_MODEL_2_NAME || "gpt-4o-mini",
    });
  }
  if (process.env.FAST_MODEL_3_KEY && process.env.FAST_MODEL_3_URL) {
    fastModels.push({
      id: "fast-3",
      baseUrl: process.env.FAST_MODEL_3_URL.replace(/\/$/, ""),
      apiKey: process.env.FAST_MODEL_3_KEY,
      model: process.env.FAST_MODEL_3_NAME || "gpt-4o-mini",
    });
  }
  list.push(...fastModels);

  // 4. gpt4free — бесплатный фолбэк
  list.push({
    id: "gpt4free",
    baseUrl: (process.env.GPT4FREE_BASE_URL || "https://api.gpt4free.co/v1").replace(/\/$/, ""),
    apiKey: "",
    model: process.env.GPT4FREE_MODEL || "gpt-3.5-turbo",
  });

  // 5. Хардкод ключей как последний резерв
  list.push({
    id: "hardcoded-reserve",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-fallback-must-replace",
    model: "gpt-4o-mini",
  });

  return list;
}

/**
 * Системный промпт для свободных follow-up вопросов в чате («ты тут?», «а если только UP?»).
 * Строгий шаблон применяется ТОЛЬКО к первому анализу scope; здесь — живой короткий ответ,
 * но с тем же запретом на выдуманные числа и инвест-рекомендации.
 */
export const FOLLOWUP_SYSTEM_PROMPT = `Ты — квант-аналитик исследовательской лаборатории, отвечаешь в чате на свободный вопрос пользователя.
Пиши по-русски, живо и коротко: обычно 1–5 предложений, списки и пункты — только если это нужно для ответа.
Оперируй ИСКЛЮЧИТЕЛЬНО числами из присланного контекста, ничего не выдумывай. Если нужных данных нет — скажи прямо.
Вопрос может быть вообще не про рынок («ты тут?», «спасибо») — тогда просто ответь по-человечески, без шаблонов, пунктов и цифр.
Не давай инвестиционных рекомендаций. Не пиши строку ПАРАМЕТРЫ.`;

/**
 * Системный промпт для бытовой болтовни («ты тут?», «спасибо»).
 * На такие сообщения контекст базы вообще не отправляется — только сам вопрос.
 */
export const SMALLTALK_SYSTEM_PROMPT = `Ты — дружелюбный ассистент исследовательской лаборатории в чате. Отвечай по-русски, коротко (1–2 предложения).
Не используй нумерованные пункты, шаблоны, цифры и термины — это обычная болтовня, не анализ. Не давай инвестиционных рекомендаций.`;

const MARKET_RE =
  /evs|btc|eth|usdt|sol|xrp|doge|\bup\b|\bdown\b|long|short|сигнал|комби|прогноз|фильтр|цикл|категор|expectancy|hit|цена|brier|гипотез|рыно|волатиль|ликвид|фандинг|риск|торг|плеч|стоп|тейк|прибыл|убыт|pnl|монет|бирж|okx|свеч|тренд/i;

/** Короткое бытовое сообщение без рыночного содержания («ты тут?», «спасибо»). */
export function isSmallTalkQuestion(note: string): boolean {
  const t = note.trim();
  if (t.length === 0 || t.length > 60 || /\d/.test(t)) return false;
  return !MARKET_RE.test(t);
}

export async function callProvider(
  p: ProviderConfig & {
    chatExtra?: Record<string, unknown>;
    systemPrompt?: string;
    maxTokens?: number;
    /** Порог «это ещё ответ, а не мусор». Планировщику нужен короткий путь: пустой список — валидный ответ. */
    minChars?: number;
  },
  userPrompt: string,
  timeoutMs = 28000,
  systemPromptOverride?: string
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${p.baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.apiKey}` },
      body: JSON.stringify({
        model: p.model,
        messages: [
          { role: "system", content: systemPromptOverride ?? p.systemPrompt ?? SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: p.maxTokens ?? 900,
        ...(p.chatExtra ?? {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${p.id} HTTP ${res.status} ${body.slice(0, 120)}`);
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = json?.choices?.[0]?.message?.content;
    if (!text || typeof text !== "string" || text.trim().length < (p.minChars ?? 20)) {
      throw new Error(`${p.id}: пустой ответ модели`);
    }
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}

/** Пытается вызвать провайдер с автомаческим переключением при ошибке. */
export async function analyzeWithAI(userPrompt: string, timeoutMs = 28000): Promise<string> {
  const providers = resolveProviders();
  let lastError: Error | null = null;

  for (const provider of providers) {
    try {
      const result = await callProvider(provider, userPrompt, timeoutMs);
      return result;
    } catch (err: any) {
      lastError = err;
      console.warn(`AI provider ${provider.id} failed: ${err.message}`);
      continue;
    }
  }

  throw new Error(`All AI providers failed. Last error: ${lastError?.message || "unknown"}`);
}

/** Извлекает строку «ПАРАМЕТРЫ: EVS=..., категорий=..., гипотез=...» из ответа модели. */
export function parseParamsFromText(text: string): Partial<{
  minEvs: number;
  minCategories: number;
  maxHypothesesPerCycle: number;
}> {
  const out: Partial<{ minEvs: number; minCategories: number; maxHypothesesPerCycle: number }> = {};
  const evs = text.match(/EVS\s*[=:]\s*(\d{2,3})/i);
  if (evs) out.minEvs = Math.max(10, Math.min(95, Number(evs[1])));
  const cats = text.match(/категор\w*\s*[=:]\s*(\d)/i);
  if (cats) out.minCategories = Math.max(1, Math.min(5, Number(cats[1])));
  const hyp = text.match(/гипотез\w*\s*[=:]\s*(\d{1,3})/i);
  if (hyp) out.maxHypothesesPerCycle = Math.max(1, Math.min(100, Number(hyp[1])));
  return out;
}