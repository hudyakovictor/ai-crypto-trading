"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Bot, Check, Loader2, Play, RefreshCcw, Send, Sparkles, Wifi, WifiOff, X, Zap } from "lucide-react";
import { postJson, toast } from "./data";
import { CATEGORY_RU } from "@/lib/format";
import { isOnlineProvider } from "@/lib/ui-types";
import { Pill } from "./ui";

/* ================= Типы ================= */

export interface AiRecommended {
  minEvs: number;
  minCategories: number;
  maxHypothesesPerCycle: number;
  operators: string[];
  directions: string[];
  regimeLock: string;
  excludedCategories: string[];
  rationale?: string[];
}

interface AiRunResult {
  analysis: { id: number; kind: string; title: string; content: string; provider: string; model: string | null; createdAt: string };
  provider: { id: string; model: string | null; live: boolean; chain: string[] };
  llmError: string | null;
  contextChars: number;
  stats: { resolved: number; hitRate: number; brier: number; pnl: number; goalPct: number };
  current: AiRecommended;
  recommended: AiRecommended;
  rationale: string[];
}

interface Msg {
  role: "ai" | "me";
  text: string;
  meta?: string;
  /** Кто ответил на это сообщение: внешняя LLM (true) или локальный движок (false). */
  live?: boolean;
  providerLabel?: string;
}

interface DockApi {
  open: (scope: string, title: string) => void;
}

const DockCtx = createContext<DockApi>({ open: () => {} });
export const useAiDock = () => useContext(DockCtx);

/* ================= Кнопка «Спросить ИИ» на панели ================= */

export function AiButton({
  scope,
  title,
  label = "Спросить ИИ",
  compact = false,
}: {
  scope: string;
  title: string;
  label?: string;
  compact?: boolean;
}) {
  const dock = useAiDock();
  return (
    <button
      onClick={() => dock.open(scope, title)}
      title={`ИИ разберёт данные этой панели: ${title}`}
      className={`hoverable pressable flex items-center gap-1.5 rounded-md border border-[rgba(91,141,238,0.45)] bg-accent-dim font-semibold text-accent hover:bg-accent hover:text-white ${
        compact ? "size-8 justify-center" : "px-2.5 py-1.5 text-[12.5px]"
      }`}
    >
      <Sparkles className="size-3.5 shrink-0" strokeWidth={2} />
      {!compact && label}
    </button>
  );
}

/* ================= Провайдер + сам док ================= */

export function AiDockProvider({
  children,
  onApplied,
}: {
  children: React.ReactNode;
  onApplied: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState("signal_today");
  const [scopeTitle, setScopeTitle] = useState("Главный сигнал");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [rec, setRec] = useState<AiRecommended | null>(null);
  const [draft, setDraft] = useState<AiRecommended | null>(null);
  const [applying, setApplying] = useState(false);
  const [provider, setProvider] = useState<{ id: string; live: boolean; model: string | null; chain: string[] } | null>(null);

  const run = useCallback(
    async (s: string, userNote?: string) => {
      setBusy(true);
      if (userNote) setMsgs((m) => [...m, { role: "me", text: userNote }]);
      try {
        const r = await postJson<AiRunResult>("/api/research/ai", { scope: s, note: userNote });
        setProvider(r.provider);
        setRec(r.recommended);
        setDraft(r.recommended);
        const live = isOnlineProvider(r.provider.id);
        const reason = !live && r.llmError ? ` · причина: ${r.llmError.slice(0, 160)}` : "";
        setMsgs((m) => [
          ...m,
          {
            role: "ai",
            text: r.analysis.content,
            live,
            providerLabel: live ? `${r.provider.id} · ${r.provider.model}` : "локальный движок glassbox",
            meta: `контекст ${r.contextChars} симв. · ${r.stats.resolved} исходов, HR ${r.stats.hitRate}%${reason}`,
          },
        ]);
        if (r.llmError) toast("info", "Внешняя модель недоступна", "Ответ собран детерминированным движком на реальных числах базы");
      } catch (e) {
        toast("err", "Ошибка анализа", e instanceof Error ? e.message : "неизвестно");
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const api = useMemo<DockApi>(
    () => ({
      open: (s: string, title: string) => {
        setScope(s);
        setScopeTitle(title);
        setMsgs([]);
        setRec(null);
        setDraft(null);
        setNote("");
        setOpen(true);
        void run(s);
      },
    }),
    [run]
  );

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open]);

  const applyAndRun = async (alsoRunCycle: boolean) => {
    if (!draft) return;
    setApplying(true);
    try {
      // Количество гипотез — не фильтр: планировщик цикла сам решает, сколько
      // оформлять. Человек оставляет только вето (что вообще допустимо).
      const veto = {
        minEvs: draft.minEvs,
        minCategories: draft.minCategories,
        operators: draft.operators,
        directions: draft.directions,
        regimeLock: draft.regimeLock,
        excludedCategories: draft.excludedCategories,
      };
      await fetch("/api/research/filters", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(veto),
      });
      toast("ok", "Вето применено", `EVS ≥ ${draft.minEvs} · категорий ${draft.minCategories} · дальше решает планировщик`);
      if (alsoRunCycle) {
        const r = await postJson<{ result: { combinationsGenerated: number; hypothesesCreated: number; marketRegime: string } }>(
          "/api/research/cycle",
          { isManual: true }
        );
        toast("ok", "Цикл выполнен на новых параметрах", `${r.result.combinationsGenerated} связок в поиске · планировщик оформил ${r.result.hypothesesCreated} гипотез`);
        setMsgs((m) => [
          ...m,
          { role: "me", text: `Применил: EVS=${draft.minEvs}, категорий=${draft.minCategories} и запустил цикл` },
        ]);
      }
      await onApplied();
    } catch (e) {
      toast("err", "Не удалось применить", e instanceof Error ? e.message : "");
    } finally {
      setApplying(false);
    }
  };

  const changed =
    !!rec &&
    !!draft &&
    (rec.minEvs !== draft.minEvs ||
      rec.minCategories !== draft.minCategories ||
      rec.excludedCategories.length !== draft.excludedCategories.length);

  return (
    <DockCtx.Provider value={api}>
      {children}

      {/* Плавающая кнопка вызова */}
      <button
        onClick={() => api.open("signal_today", "Главный сигнал сейчас")}
        className="hoverable pressable fixed bottom-5 right-5 z-[88] flex items-center gap-2 rounded-full border border-[rgba(91,141,238,0.5)] bg-accent px-4 py-3 text-[13px] font-bold text-white shadow-[0_10px_30px_rgba(0,0,0,0.45)] hover:bg-[#6d9bf3]"
      >
        <Bot className="size-4.5" strokeWidth={2} />
        Спросить ИИ
      </button>

      {open && (
        <div className="fixed inset-0 z-[96]">
          <div className="absolute inset-0 bg-[rgba(4,8,14,0.55)] backdrop-blur-[2px]" onClick={() => setOpen(false)} />
          <aside className="anim-fade-up absolute inset-y-0 right-0 flex w-[560px] max-w-[96vw] flex-col border-l border-border-strong bg-surface shadow-[-18px_0_50px_rgba(0,0,0,0.55)]">
            {/* header */}
            <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
              <div className="flex min-w-0 items-center gap-2.5">
                <Sparkles className="size-4.5 shrink-0 text-accent" strokeWidth={2} />
                <div className="min-w-0">
                  <h2 className="truncate text-[14px] font-bold text-text-1">{scopeTitle}</h2>
                  <p className="truncate text-[12px] text-text-3">изолированный контекст этой панели</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void run(scope)}
                  disabled={busy}
                  title="Пересобрать ответ на свежих данных"
                  className="hoverable pressable flex size-8 items-center justify-center rounded-md border border-border text-text-3 hover:text-text-1 disabled:opacity-50"
                >
                  <RefreshCcw className={`size-4 ${busy ? "animate-spin" : ""}`} strokeWidth={2} />
                </button>
                <button
                  onClick={() => setOpen(false)}
                  className="hoverable pressable flex size-8 items-center justify-center rounded-md border border-border text-text-3 hover:text-text-1"
                >
                  <X className="size-4" strokeWidth={2} />
                </button>
              </div>
            </header>

            {/* provider strip: явно онлайн или офлайн */}
            <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface2 px-4 py-2">
              {provider == null ? (
                <span className="text-[12px] text-text-3">подключение…</span>
              ) : provider.live ? (
                <>
                  <Wifi className="size-3.5 shrink-0" style={{ color: "var(--green)" }} strokeWidth={2} />
                  <span className="truncate text-[12px] text-text-2">
                    <b style={{ color: "var(--green)" }}>ОНЛАЙН</b>
                    <span className="text-text-3"> · {provider.id} · {provider.model}</span>
                  </span>
                </>
              ) : (
                <>
                  <WifiOff className="size-3.5 shrink-0 text-text-3" strokeWidth={2} />
                  <span className="truncate text-[12px] text-text-2">
                    <b className="text-text-1">ОФЛАЙН</b>
                    <span className="text-text-3"> · локальный движок, внешняя LLM недоступна</span>
                  </span>
                </>
              )}
              <Pill tone={provider?.live ? "bull" : "neutral"} dot className="ml-auto shrink-0">
                {provider == null ? "…" : provider.live ? "ОНЛАЙН" : "ОФЛАЙН"}
              </Pill>
            </div>
            {provider && provider.chain.length > 0 && (
              <div className="num shrink-0 truncate border-b border-border bg-surface px-4 py-1.5 text-[11.5px] text-text-3">
                цепочка: {provider.chain.join(" → ")}
              </div>
            )}

            {/* chat */}
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              {msgs.length === 0 && busy && (
                <div className="flex items-center gap-2 text-[13px] text-text-3">
                  <Loader2 className="size-4 animate-spin" /> Собираю контекст панели и анализирую…
                </div>
              )}
              {msgs.map((m, i) =>
                m.role === "ai" ? (
                  <article key={i} className="panel-lift rounded-[10px] border border-border bg-surface2 p-3.5">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <Bot className="size-4 text-accent" strokeWidth={2} />
                      <span className="text-[12.5px] font-bold text-text-1">Ответ аналитика</span>
                      {m.live != null &&
                        (m.live ? (
                          <span title={m.providerLabel ?? "внешняя LLM"}>
                            <Pill tone="bull" dot>
                              ОНЛАЙН · {m.providerLabel ?? "LLM"}
                            </Pill>
                          </span>
                        ) : (
                          <span title="локальный детерминированный движок, интернет не использовался">
                            <Pill tone="neutral" dot>
                              ОФЛАЙН · локально
                            </Pill>
                          </span>
                        ))}
                    </div>
                    <div className="space-y-1.5">
                      {m.text.split("\n").filter(Boolean).map((line, j) => (
                        <p key={j} className={`text-[13px] leading-relaxed ${/^\s*ПАРАМЕТРЫ/i.test(line) || /ПАРАМЕТРЫ:/.test(line) ? "font-bold text-accent" : "text-text-2"}`}>
                          {line}
                        </p>
                      ))}
                    </div>
                    {m.meta && <p className="mt-2 border-t border-border pt-2 text-[12px] text-text-3">{m.meta}</p>}
                  </article>
                ) : (
                  <div key={i} className="ml-8 rounded-[10px] border border-[rgba(91,141,238,0.35)] bg-accent-dim px-3.5 py-2.5">
                    <p className="text-[13px] leading-relaxed text-text-1">{m.text}</p>
                  </div>
                )
              )}
              {busy && msgs.length > 0 && (
                <div className="flex items-center gap-2 text-[12.5px] text-text-3">
                  <Loader2 className="size-3.5 animate-spin" /> думаю…
                </div>
              )}
            </div>

            {/* recommended params — редактируемые */}
            {draft && (
              <div className="shrink-0 border-t border-border bg-surface2 p-4">
                <div className="mb-2.5 flex items-center gap-2">
                  <Zap className="size-4 text-warn" strokeWidth={2} />
                  <span className="text-[13px] font-bold text-text-1">Рекомендованные параметры</span>
                  <span className="text-[12px] text-text-3">— правьте и применяйте</span>
                  {changed && <Pill tone="warn" className="ml-auto">изменено вами</Pill>}
                </div>

                <div className="space-y-2.5">
                  <div>
                    <div className="mb-1 flex items-baseline justify-between">
                      <label className="text-[12.5px] font-semibold text-text-2">Порог EVS (ниже = больше сигналов в тест)</label>
                      <span className="num text-[16px] font-bold text-accent">≥ {draft.minEvs}</span>
                    </div>
                    <input
                      type="range"
                      min={10}
                      max={95}
                      step={5}
                      value={draft.minEvs}
                      onChange={(e) => setDraft({ ...draft, minEvs: Number(e.target.value) })}
                      className="w-full accent-[#5b8dee]"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label className="mb-1 block text-[12.5px] font-semibold text-text-2">Мин. категорий</label>
                      <div className="flex gap-1">
                        {[1, 2, 3, 4].map((v) => (
                          <button
                            key={v}
                            onClick={() => setDraft({ ...draft, minCategories: v })}
                            className={`hoverable pressable flex-1 rounded-md border py-1.5 text-[12.5px] font-bold ${
                              draft.minCategories === v
                                ? "border-[rgba(91,141,238,0.5)] bg-accent-dim text-accent"
                                : "border-border bg-surface text-text-3 hover:text-text-1"
                            }`}
                          >
                            {v}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="rounded-md border border-border bg-surface2 px-2.5 py-2">
                      <label className="mb-0.5 block text-[12.5px] font-semibold text-text-2">Сколько оформлять</label>
                      <p className="text-[12px] leading-snug text-text-3">
                        решает планировщик цикла, не ползунок. Потолок {draft.maxHypothesesPerCycle} — страховка от
                        потока записей; изменить — в настройках.
                      </p>
                    </div>
                  </div>

                  {draft.excludedCategories.length > 0 && (
                    <div>
                      <label className="mb-1 block text-[12.5px] font-semibold text-text-2">
                        ИИ предлагает исключить ({draft.excludedCategories.length}) — клик снимает
                      </label>
                      <div className="flex flex-wrap gap-1.5">
                        {draft.excludedCategories.map((c) => (
                          <button
                            key={c}
                            onClick={() => setDraft({ ...draft, excludedCategories: draft.excludedCategories.filter((x) => x !== c) })}
                            className="hoverable pressable rounded-md border border-[rgba(245,101,101,0.4)] bg-bear-dim px-2 py-1 text-[12px] font-medium text-bear"
                          >
                            {CATEGORY_RU[c] ?? c} ✕
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => void applyAndRun(true)}
                    disabled={applying}
                    className="hoverable pressable flex flex-1 items-center justify-center gap-2 rounded-md border border-[rgba(91,141,238,0.5)] bg-accent px-3 py-2.5 text-[13px] font-bold text-white hover:bg-[#6d9bf3] disabled:opacity-60"
                  >
                    {applying ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" fill="currentColor" strokeWidth={0} />}
                    Применить и запустить цикл
                  </button>
                  <button
                    onClick={() => void applyAndRun(false)}
                    disabled={applying}
                    className="hoverable pressable flex items-center justify-center gap-1.5 rounded-md border border-border-strong bg-surface px-3 py-2.5 text-[13px] font-semibold text-text-2 hover:text-text-1 disabled:opacity-60"
                  >
                    <Check className="size-4" strokeWidth={2} />
                    Только сохранить
                  </button>
                </div>
              </div>
            )}

            {/* follow-up */}
            <footer className="shrink-0 border-t border-border p-3">
              <div className="flex gap-2">
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && note.trim() && !busy) {
                      const q = note.trim();
                      setNote("");
                      void run(scope, q);
                    }
                  }}
                  placeholder="Уточните запрос: «а если торговать только UP?»"
                  className="flex-1 rounded-md border border-border bg-surface2 px-3 py-2.5 text-[13px] text-text-1 placeholder:text-text-3 outline-none focus:border-accent"
                />
                <button
                  onClick={() => {
                    if (!note.trim() || busy) return;
                    const q = note.trim();
                    setNote("");
                    void run(scope, q);
                  }}
                  disabled={busy || !note.trim()}
                  className="hoverable pressable flex size-10 items-center justify-center rounded-md border border-[rgba(91,141,238,0.45)] bg-accent-dim text-accent hover:bg-accent hover:text-white disabled:opacity-40"
                >
                  <Send className="size-4" strokeWidth={2} />
                </button>
              </div>
              <p className="mt-1.5 text-[12px] text-text-3">
                Цикл работы: спросили → получили рекомендацию → поправили ползунки → применили и запустили → данные обновились → спросили снова.
              </p>
            </footer>
          </aside>
        </div>
      )}
    </DockCtx.Provider>
  );
}
