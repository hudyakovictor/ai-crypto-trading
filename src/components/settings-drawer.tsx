"use client";

import React, { useEffect, useState } from "react";
import { Bot, Brain, ChevronDown, ChevronUp, Eraser, KeyRound, Loader2, RotateCcw, Save, Settings2, Sparkles, Trash2, X } from "lucide-react";
import { postJson, toast } from "./data";
import type {
  AiProviderPublic,
  AiSettingsResponse,
  AutopilotInfo,
  FiltersResponse,
  FiltersState,
  PlannerAuthority,
  PolicyResponse,
} from "@/lib/ui-types";
import { CATEGORY_RU } from "@/lib/format";
import { Pill } from "./ui";

function Chip({
  active,
  children,
  onClick,
  danger = false,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`hoverable pressable whitespace-nowrap rounded-md border px-2.5 py-1.5 text-[13px] font-medium ${
        active
          ? danger
            ? "border-[rgba(245,101,101,0.45)] bg-bear-dim text-bear"
            : "border-[rgba(91,141,238,0.45)] bg-accent-dim text-accent"
          : "border-border bg-surface2 text-text-3 hover:text-text-1"
      }`}
    >
      {children}
    </button>
  );
}

export function SettingsDrawer({
  open,
  onClose,
  onDataChanged,
}: {
  open: boolean;
  onClose: () => void;
  onDataChanged: () => Promise<void> | void;
}) {
  const [filters, setFilters] = useState<FiltersState | null>(null);
  const [options, setOptions] = useState<FiltersResponse["options"] | null>(null);
  const [ap, setAp] = useState<AutopilotInfo | null>(null);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [aiProviders, setAiProviders] = useState<AiProviderPublic[] | null>(null);
  const [aiSaving, setAiSaving] = useState(false);
  const [aiKeys, setAiKeys] = useState<Record<string, string>>({});
  // Политика отбора: кому принадлежит решение «сколько и каких гипотез» + потолок-страховка.
  const [policy, setPolicy] = useState<PolicyResponse["policy"] | null>(null);
  const [ceilingLimits, setCeilingLimits] = useState({ ceilingMin: 1, ceilingMax: 30 });
  const [policySaving, setPolicySaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setConfirmReset(false);
    (async () => {
      try {
        const [f, a, ai, pol] = await Promise.all([
          fetch("/api/research/filters", { cache: "no-store" }).then((r) => r.json()) as Promise<FiltersResponse>,
          fetch("/api/research/autopilot", { cache: "no-store" }).then((r) => r.json()),
          fetch("/api/research/ai-settings", { cache: "no-store" }).then((r) => r.json()) as Promise<AiSettingsResponse>,
          fetch("/api/research/policy", { cache: "no-store" }).then((r) => r.json()) as Promise<PolicyResponse>,
        ]);
        setFilters(f.filters);
        setOptions(f.options);
        setAp(a.autopilot);
        if (ai.success) setAiProviders(ai.providers);
        if (pol.success) {
          setPolicy(pol.policy);
          if (pol.limits) setCeilingLimits(pol.limits);
        }
        setLoaded(true);
      } catch (e) {
        toast("err", "Не удалось загрузить настройки", e instanceof Error ? e.message : "");
      }
    })();
  }, [open]);

  const patchPolicy = async (patch: { authority?: PlannerAuthority; ceiling?: number }) => {
    if (!policy) return;
    setPolicySaving(true);
    try {
      const r = await fetch("/api/research/policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...policy, ...patch }),
      }).then((res) => res.json()) as PolicyResponse;
      if (!r.success) throw new Error(r.error || "не сохранено");
      setPolicy(r.policy);
      toast("ok", "Политика отбора сохранена", r.message ?? "");
      await onDataChanged();
    } catch (e) {
      toast("err", "Ошибка сохранения политики", e instanceof Error ? e.message : "");
    } finally {
      setPolicySaving(false);
    }
  };

  const save = async () => {
    if (!filters) return;
    setSaving(true);
    try {
      const r = await fetch("/api/research/filters", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(filters),
      }).then((r) => r.json());
      toast("ok", "Фильтры сохранены", `EVS ≥ ${r.filters.minEvs} · мин. категорий ${r.filters.minCategories}`);
      await onDataChanged();
    } catch (e) {
      toast("err", "Ошибка сохранения", e instanceof Error ? e.message : "");
    } finally {
      setSaving(false);
    }
  };

  const saveAi = async () => {
    if (!aiProviders) return;
    setAiSaving(true);
    try {
      const configs: Record<string, { baseUrl: string; model: string; apiKey?: string }> = {};
      for (const p of aiProviders) {
        configs[p.id] = { baseUrl: p.baseUrl, model: p.model };
        const k = (aiKeys[p.id] ?? "").trim();
        if (k) configs[p.id].apiKey = k;
      }
      const r = await fetch("/api/research/ai-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          order: aiProviders.map((p) => p.id),
          enabled: aiProviders.filter((p) => p.enabled).map((p) => p.id),
          configs,
        }),
      }).then((r) => r.json()) as AiSettingsResponse & { message?: string };
      if (!r.success) throw new Error(r.error || "save failed");
      setAiProviders(r.providers);
      setAiKeys({});
      const chain = r.providers.filter((p) => p.enabled).map((p) => p.id).join(" → ");
      toast("ok", "Настройки ИИ сохранены", `Цепочка: ${chain || "—"}`);
      await onDataChanged();
    } catch (e) {
      toast("err", "Ошибка сохранения ИИ", e instanceof Error ? e.message : "");
    } finally {
      setAiSaving(false);
    }
  };

  const moveAi = (id: string, dir: -1 | 1) => {
    setAiProviders((prev) => {
      if (!prev) return prev;
      const i = prev.findIndex((p) => p.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  const toggleAiProvider = (id: string) => {
    setAiProviders((prev) => {
      if (!prev) return prev;
      const p = prev.find((x) => x.id === id);
      if (p?.enabled && prev.filter((x) => x.enabled).length <= 1) {
        toast("err", "Нельзя выключить всех", "Оставьте хотя бы один ИИ-провайдер включённым");
        return prev;
      }
      return prev.map((x) => (x.id === id ? { ...x, enabled: !x.enabled } : x));
    });
  };

  const clearAiKey = async (id: string) => {
    try {
      const r = await fetch("/api/research/ai-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ configs: { [id]: { apiKey: "" } } }),
      }).then((r) => r.json()) as AiSettingsResponse;
      if (!r.success) throw new Error(r.error || "save failed");
      setAiProviders(r.providers);
      toast("ok", "Ключ удалён", "Теперь используется ключ из env (если задан)");
    } catch (e) {
      toast("err", "Ошибка", e instanceof Error ? e.message : "");
    }
  };

  const toggleAutopilot = async () => {
    if (!ap) return;
    try {
      const r = await postJson<{ autopilot: AutopilotInfo; message: string }>("/api/research/autopilot", {
        enabled: !ap.enabled,
      });
      setAp(r.autopilot);
      toast("ok", r.autopilot.enabled ? "Автопилот включён" : "Автопилот выключен", r.message);
      await onDataChanged();
    } catch (e) {
      toast("err", "Ошибка автопилота", e instanceof Error ? e.message : "");
    }
  };

  const doReset = async () => {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    setResetting(true);
    try {
      const r = await postJson<{ message: string }>("/api/research/reset", { confirm: true });
      toast("ok", "История очищена", r.message);
      setConfirmReset(false);
      onClose();
      await onDataChanged();
    } catch (e) {
      toast("err", "Ошибка очистки", e instanceof Error ? e.message : "");
    } finally {
      setResetting(false);
    }
  };

  const toggleInArr = (arr: string[], v: string) =>
    arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[92]">
      <div className="absolute inset-0 bg-[rgba(3,5,9,0.6)] backdrop-blur-[2px]" onClick={onClose} />
      <aside className="anim-fade-up absolute inset-y-0 right-0 flex w-[400px] max-w-[92vw] flex-col border-l border-border-strong bg-surface shadow-[-16px_0_48px_rgba(0,0,0,0.5)]">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
          <div className="flex items-center gap-2.5">
            <Settings2 className="size-4.5 text-accent" strokeWidth={1.9} />
            <h2 className="text-[15px] font-bold text-text-1">Настройки лаборатории</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Закрыть"
            className="hoverable pressable flex size-8 items-center justify-center rounded-md border border-border text-text-3 hover:text-text-1"
          >
            <X className="size-4" strokeWidth={2} />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {!loaded || !filters || !options ? (
            <div className="flex items-center gap-2 py-8 text-[14px] text-text-3">
              <Loader2 className="size-4 animate-spin" /> Загрузка настроек…
            </div>
          ) : (
            <>
              {/* ── Фильтры сигналов ── */}
              <section className="rounded-[10px] border border-border bg-surface2 p-4">
                <h3 className="text-[14px] font-bold text-text-1">Фильтры потенциальных сигналов</h3>
                <p className="mt-1 text-[13px] leading-snug text-text-3">
                  Комбинации, не проходящие фильтр, помечаются серым и не оформляются в гипотезы новыми циклами.
                </p>

                <div className="mt-4">
                  <div className="mb-1.5 flex items-baseline justify-between">
                    <label className="text-[13.5px] font-semibold text-text-2">Минимальный EVS</label>
                    <span className="num text-[16px] font-bold" style={{ color: "var(--accent)" }}>
                      ≥ {filters.minEvs}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={40}
                    max={95}
                    step={5}
                    value={filters.minEvs}
                    onChange={(e) => setFilters({ ...filters, minEvs: Number(e.target.value) })}
                    className="w-full accent-[#5b8dee]"
                  />
                  <div className="num mt-0.5 flex justify-between text-[12px] text-text-3">
                    <span>40 · больше сигналов, больше шума</span>
                    <span>95 · почти нет сигналов</span>
                  </div>
                </div>

                <div className="mt-4">
                  <label className="mb-1.5 block text-[13.5px] font-semibold text-text-2">Минимум категорий в связке</label>
                  <div className="flex gap-1.5">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <Chip key={n} active={filters.minCategories === n} onClick={() => setFilters({ ...filters, minCategories: n })}>
                        {n}
                      </Chip>
                    ))}
                  </div>
                </div>

                <div className="mt-4">
                  <label className="mb-1.5 block text-[13.5px] font-semibold text-text-2">Разрешённые операторы</label>
                  <div className="flex flex-wrap gap-1.5">
                    {options.operators.map((op) => (
                      <Chip
                        key={op}
                        active={filters.operators.includes(op)}
                        onClick={() =>
                          filters.operators.length > 1 || !filters.operators.includes(op)
                            ? setFilters({ ...filters, operators: toggleInArr(filters.operators, op) })
                            : undefined
                        }
                      >
                        {op}
                      </Chip>
                    ))}
                  </div>
                </div>

                <div className="mt-4">
                  <label className="mb-1.5 block text-[13.5px] font-semibold text-text-2">Разрешённые направления</label>
                  <div className="flex flex-wrap gap-1.5">
                    {options.directions.map((dir) => (
                      <Chip
                        key={dir}
                        active={filters.directions.includes(dir)}
                        onClick={() =>
                          filters.directions.length > 1 || !filters.directions.includes(dir)
                            ? setFilters({ ...filters, directions: toggleInArr(filters.directions, dir) })
                            : undefined
                        }
                      >
                        {dir}
                      </Chip>
                    ))}
                  </div>
                </div>

                <div className="mt-4">
                  <label className="mb-1.5 block text-[13.5px] font-semibold text-text-2">Режимный замок (торговать только в режиме)</label>
                  <select
                    value={filters.regimeLock}
                    onChange={(e) => setFilters({ ...filters, regimeLock: e.target.value })}
                    className="w-full rounded-md border border-border bg-surface px-3 py-2 text-[13.5px] text-text-1 outline-none focus:border-accent"
                  >
                    <option value="ANY">Любой режим (по умолчанию)</option>
                    <option value="TRENDING_BULL">Восходящий тренд</option>
                    <option value="TRENDING_BEAR">Нисходящий тренд</option>
                    <option value="HIGH_VOLATILITY_CHOP">Волатильная пила</option>
                    <option value="LOW_VOLATILITY_SQUEEZE">Сжатие волатильности</option>
                    <option value="LIQUIDITY_CRUNCH">Дефицит ликвидности</option>
                    <option value="NEUTRAL_CONSOLIDATION">Консолидация</option>
                  </select>
                </div>

                <div className="mt-4">
                  <label className="mb-1.5 block text-[13.5px] font-semibold text-text-2">
                    Исключить категории <span className="text-text-3">(красные — не попадут в связки)</span>
                  </label>
                  <div className="flex max-h-[150px] flex-wrap gap-1.5 overflow-y-auto pr-1">
                    {Object.entries(CATEGORY_RU).map(([key, ru]) => {
                      const excl = filters.excludedCategories.includes(key);
                      return (
                        <Chip
                          key={key}
                          danger
                          active={excl}
                          onClick={() =>
                            setFilters({ ...filters, excludedCategories: toggleInArr(filters.excludedCategories, key) })
                          }
                        >
                          {ru}
                        </Chip>
                      );
                    })}
                  </div>
                </div>

                <button
                  onClick={() => void save()}
                  disabled={saving}
                  className="hoverable pressable mt-5 flex w-full items-center justify-center gap-2 rounded-md border border-[rgba(91,141,238,0.5)] bg-accent px-4 py-2.5 text-[14px] font-bold text-white hover:bg-[#6d9bf3] disabled:opacity-60"
                >
                  {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" strokeWidth={2} />}
                  Сохранить фильтры
                </button>
              </section>

              {/* ── Автопилот ── */}
              <section className="rounded-[10px] border border-border bg-surface2 p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <Bot className="size-4.5" style={{ color: ap?.enabled ? "var(--green)" : "var(--text-3)" }} strokeWidth={1.9} />
                    <div>
                      <h3 className="text-[14px] font-bold text-text-1">Автопилот исследований</h3>
                      <p className="text-[13px] text-text-3">переобучение после каждого цикла, цикл ~раз в 15 минут</p>
                    </div>
                  </div>
                  <button
                    onClick={() => void toggleAutopilot()}
                    aria-label="Переключить автопилот"
                    className={`relative h-6 w-11 rounded-full transition-colors duration-150 ${ap?.enabled ? "bg-[rgba(34,211,160,0.85)]" : "bg-surface3"}`}
                  >
                    <span
                      className="absolute top-[3px] size-[18px] rounded-full bg-white transition-[left] duration-150"
                      style={{ left: ap?.enabled ? "23px" : "3px" }}
                    />
                  </button>
                </div>
                {ap && (
                  <div className="num mt-3 grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-md border border-border bg-surface px-2 py-1.5">
                      <div className="text-[12px] text-text-3">циклов</div>
                      <div className="text-[15px] font-bold text-text-1">{ap.cyclesCompleted}</div>
                    </div>
                    <div className="rounded-md border border-border bg-surface px-2 py-1.5">
                      <div className="text-[12px] text-text-3">переобучений</div>
                      <div className="text-[15px] font-bold text-text-1">{ap.retrainsCompleted}</div>
                    </div>
                    <div className="rounded-md border border-border bg-surface px-2 py-1.5">
                      <div className="text-[12px] text-text-3">статус</div>
                      <div className="text-[13px] font-bold" style={{ color: ap.enabled ? "var(--green)" : "var(--amber)" }}>
                        {ap.enabled ? "РАБОТАЕТ" : "ПАУЗА"}
                      </div>
                    </div>
                  </div>
                )}
              </section>

              {/* ── Кто оформляет гипотезы ── */}
              <section className="rounded-[10px] border border-border bg-surface2 p-4">
                <div className="flex items-center gap-2.5">
                  <Brain className="size-4.5 text-accent" strokeWidth={1.9} />
                  <div>
                    <h3 className="text-[14px] font-bold text-text-1">Кто решает, сколько гипотез оформлять</h3>
                    <p className="text-[13px] leading-snug text-text-3">
                      Ставки бумажные, поэтому объём ничего не даёт: шумная связка стоит калибровки весов. Решение
                      «сколько и каких» у планировщика цикла, фильтры выше — только вето.
                    </p>
                  </div>
                </div>

                {!policy ? (
                  <div className="flex items-center gap-2 py-4 text-[13px] text-text-3">
                    <Loader2 className="size-4 animate-spin" /> Загрузка политики отбора…
                  </div>
                ) : (
                  <>
                    <div className="mt-3 flex gap-1.5">
                      <Chip active={policy.authority === "ai"} onClick={() => void patchPolicy({ authority: "ai" })}>
                        решает ИИ
                      </Chip>
                      <Chip
                        active={policy.authority === "rule"}
                        onClick={() => void patchPolicy({ authority: "rule" })}
                      >
                        правило EVS
                      </Chip>
                    </div>

                    <div className="mt-4">
                      <div className="mb-1.5 flex items-baseline justify-between">
                        <label className="text-[13.5px] font-semibold text-text-2">Страховочный потолок за цикл</label>
                        <span className="num text-[16px] font-bold" style={{ color: "var(--accent)" }}>
                          {policy.ceiling}
                        </span>
                      </div>
                      <input
                        type="range"
                        min={ceilingLimits.ceilingMin}
                        max={ceilingLimits.ceilingMax}
                        step={1}
                        value={policy.ceiling}
                        disabled={policySaving}
                        onChange={(e) => setPolicy({ ...policy, ceiling: Number(e.target.value) })}
                        onPointerUp={() => void patchPolicy({})}
                        onKeyUp={() => void patchPolicy({})}
                        className="w-full accent-[#5b8dee]"
                      />
                      <div className="mt-0.5 text-[12px] leading-snug text-text-3">
                        Защита от потока записей, а не план: взять 2 из 20 или 0 — корректный ответ. Если модель
                        молчит, отбор уходит на запасное правило (и это видно в полосе «Решение цикла»).
                      </div>
                    </div>
                  </>
                )}
              </section>

              {/* ── ИИ-провайдеры ── */}
              <section className="rounded-[10px] border border-border bg-surface2 p-4">
                <div className="flex items-center gap-2.5">
                  <Sparkles className="size-4.5 text-accent" strokeWidth={1.9} />
                  <div>
                    <h3 className="text-[14px] font-bold text-text-1">ИИ-провайдеры</h3>
                    <p className="text-[13px] leading-snug text-text-3">
                      Порядок опроса сверху вниз. Первый ответивший даёт разбор; если все упали — локальный glassbox.
                    </p>
                  </div>
                </div>

                {!aiProviders ? (
                  <div className="flex items-center gap-2 py-4 text-[13px] text-text-3">
                    <Loader2 className="size-4 animate-spin" /> Загрузка провайдеров…
                  </div>
                ) : (
                  <div className="mt-3 space-y-2">
                    {aiProviders.map((p, idx) => (
                      <div
                        key={p.id}
                        className={`rounded-md border bg-surface p-3 ${p.enabled ? "border-border" : "border-border opacity-60"}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="num text-[12px] font-bold text-text-3">{idx + 1}</span>
                            <div className="min-w-0">
                              <div className="truncate text-[13.5px] font-bold text-text-1">{p.titleRu}</div>
                              <div className="flex flex-wrap items-center gap-1 text-[12px]">
                                <span style={{ color: p.enabled ? "var(--green)" : "var(--text-3)" }}>
                                  {p.enabled ? "ВКЛ" : "ВЫКЛ"}
                                </span>
                                {p.needsKey && (
                                  <span className="text-text-3">
                                    · ключ: {p.keySource === "env" ? "env" : p.keySource === "settings" ? "настройки" : "НЕТ"}
                                  </span>
                                )}
                                {!p.needsKey && <span className="text-text-3">· без ключа</span>}
                              </div>
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <button
                              onClick={() => moveAi(p.id, -1)}
                              disabled={idx === 0}
                              aria-label="Выше"
                              className="hoverable flex size-7 items-center justify-center rounded-md border border-border text-text-3 hover:text-text-1 disabled:opacity-30"
                            >
                              <ChevronUp className="size-3.5" />
                            </button>
                            <button
                              onClick={() => moveAi(p.id, 1)}
                              disabled={idx === aiProviders.length - 1}
                              aria-label="Ниже"
                              className="hoverable flex size-7 items-center justify-center rounded-md border border-border text-text-3 hover:text-text-1 disabled:opacity-30"
                            >
                              <ChevronDown className="size-3.5" />
                            </button>
                            <button
                              onClick={() => toggleAiProvider(p.id)}
                              aria-label="Вкл/выкл"
                              className={`relative h-6 w-11 rounded-full transition-colors duration-150 ${p.enabled ? "bg-[rgba(91,141,238,0.85)]" : "bg-surface3"}`}
                            >
                              <span
                                className="absolute top-[3px] size-[18px] rounded-full bg-white transition-[left] duration-150"
                                style={{ left: p.enabled ? "23px" : "3px" }}
                              />
                            </button>
                          </div>
                        </div>

                        <p className="mt-1.5 text-[12.5px] leading-snug text-text-3">{p.hintRu}</p>

                        <div className="mt-2 grid grid-cols-1 gap-2">
                          <label className="block">
                            <span className="mb-1 block text-[12px] font-semibold text-text-3">Base URL</span>
                            <input
                              value={p.baseUrl}
                              onChange={(e) =>
                                setAiProviders((prev) => prev?.map((x) => (x.id === p.id ? { ...x, baseUrl: e.target.value } : x)) ?? null)
                              }
                              spellCheck={false}
                              className="w-full rounded-md border border-border bg-surface2 px-2.5 py-1.5 text-[13px] text-text-1 outline-none focus:border-accent"
                            />
                          </label>
                          <label className="block">
                            <span className="mb-1 block text-[12px] font-semibold text-text-3">Модель</span>
                            <input
                              value={p.model}
                              onChange={(e) =>
                                setAiProviders((prev) => prev?.map((x) => (x.id === p.id ? { ...x, model: e.target.value } : x)) ?? null)
                              }
                              spellCheck={false}
                              className="w-full rounded-md border border-border bg-surface2 px-2.5 py-1.5 text-[13px] text-text-1 outline-none focus:border-accent"
                            />
                          </label>
                          {p.needsKey && (
                            <div>
                              <span className="mb-1 flex items-center gap-1 text-[12px] font-semibold text-text-3">
                                <KeyRound className="size-3" /> API-ключ
                              </span>
                              <div className="flex gap-1.5">
                                <input
                                  type="password"
                                  value={aiKeys[p.id] ?? ""}
                                  onChange={(e) => setAiKeys((prev) => ({ ...prev, [p.id]: e.target.value }))}
                                  placeholder={
                                    p.keySource === "env"
                                      ? "Ключ из env (скрыт) — введите, чтобы переопределить"
                                      : p.keySource === "settings"
                                        ? "Ключ сохранён — введите новый для замены"
                                        : "Ключ отсутствует — введите"
                                  }
                                  autoComplete="off"
                                  spellCheck={false}
                                  className="min-w-0 flex-1 rounded-md border border-border bg-surface2 px-2.5 py-1.5 text-[13px] text-text-1 outline-none focus:border-accent"
                                />
                                {p.keySource === "settings" && (
                                  <button
                                    onClick={() => void clearAiKey(p.id)}
                                    className="hoverable shrink-0 rounded-md border border-border px-2 text-[12.5px] text-text-3 hover:text-bear"
                                  >
                                    Сброс
                                  </button>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}

                    <button
                      onClick={() => void saveAi()}
                      disabled={aiSaving}
                      className="hoverable pressable mt-1 flex w-full items-center justify-center gap-2 rounded-md border border-[rgba(91,141,238,0.5)] bg-accent px-4 py-2.5 text-[14px] font-bold text-white hover:bg-[#6d9bf3] disabled:opacity-60"
                    >
                      {aiSaving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" strokeWidth={2} />}
                      Сохранить ИИ
                    </button>
                    <p className="text-[12.5px] leading-snug text-text-3">
                      Ключи хранятся только в локальной БД и никогда не показываются обратно.
                    </p>
                  </div>
                )}
              </section>

              {/* ── Опасная зона ── */}
              <section className="rounded-[10px] border border-[rgba(245,101,101,0.25)] bg-surface2 p-4">
                <div className="flex items-center gap-2.5">
                  <Eraser className="size-4.5 text-bear" strokeWidth={1.9} />
                  <div>
                    <h3 className="text-[14px] font-bold text-text-1">Очистка истории</h3>
                    <p className="text-[13px] leading-snug text-text-3">
                      Удаляет прогнозы, гипотезы, комбинации и AI-разборы; сбрасывает веса обучения к 1.00.
                      Фильтры и настройки сохраняются.
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => void doReset()}
                  disabled={resetting}
                  className={`hoverable pressable mt-3 flex w-full items-center justify-center gap-2 rounded-md border px-4 py-2.5 text-[14px] font-bold ${
                    confirmReset
                      ? "border-[rgba(245,101,101,0.6)] bg-bear text-white"
                      : "border-[rgba(245,101,101,0.35)] bg-bear-dim text-bear hover:bg-bear hover:text-white"
                  } disabled:opacity-60`}
                >
                  {resetting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : confirmReset ? (
                    <Trash2 className="size-4" strokeWidth={2} />
                  ) : (
                    <RotateCcw className="size-4" strokeWidth={2} />
                  )}
                  {resetting ? "Очищаю…" : confirmReset ? "Точно очистить? Нажмите ещё раз" : "Очистить историю"}
                </button>
                {confirmReset && (
                  <p className="anim-shake mt-2 text-center text-[13px] font-medium text-bear">
                    Действие необратимо — статистика 74+ сделок будет удалена
                  </p>
                )}
              </section>
            </>
          )}
        </div>

        <footer className="shrink-0 border-t border-border px-4 py-2.5">
          <div className="flex items-center gap-2">
            <Pill tone="neutral">фильтры v1</Pill>
            <span className="text-[13px] text-text-3">Изменения применяются к следующему циклу и списку комбинаций</span>
          </div>
        </footer>
      </aside>
    </div>
  );
}
