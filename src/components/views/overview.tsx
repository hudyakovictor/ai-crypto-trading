"use client";

import React, { useMemo, useState } from "react";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Brain,
  Check,
  Clock3,
  FlaskConical,
  Globe,
  History,
  Inbox,
  Minus,
  TrendingDown,
  TrendingUp,
  X,
} from "lucide-react";
import type { ApiState } from "../data";
import { AiButton } from "../ai-dock";
import type {
  CombinationsResponse,
  ForecastRow,
  HeatmapResponse,
  LedgerResponse,
  LearningResponse,
  PlannerDecisionRow,
  PlannerMode,
  StatusResponse,
  UniverseMemberRow,
  UniverseSource,
  WalkForwardResponse,
} from "@/lib/ui-types";
import {
  CATEGORY_RU,
  CATEGORY_SHORT,
  fmtClock,
  fmtCompact,
  fmtPct,
  fmtPrice,
  fmtSigned,
  timeAgo,
} from "@/lib/format";
import {
  Delta,
  EmptyState,
  ErrorState,
  evsTone,
  heatColor,
  MeterBar,
  Panel,
  Pill,
  SkeletonRows,
  Tip,
  TipRow,
  ViewGuide,
} from "../ui";
import { Sparkline } from "../charts";
import type { ViewKey } from "../sidebar";

/* ============================= Asset hero card ============================= */

function AssetCard({
  symbol,
  heatmap,
  strongest,
}: {
  symbol: string;
  heatmap: ApiState<HeatmapResponse>;
  strongest: boolean;
}) {
  const asset = heatmap.data?.assets.find((a) => a.symbol === symbol);
  const cats = heatmap.data?.categories ?? Object.keys(asset?.signals ?? {});

  if (heatmap.loading && !asset) {
    return (
      <div className="flex flex-col gap-2 panel-lift rounded-[10px] border border-border bg-surface p-3">
        <div className="skeleton h-4 w-28" />
        <div className="skeleton h-7 w-36" />
        <div className="skeleton h-11 w-full" />
        <div className="skeleton h-2.5 w-full" />
      </div>
    );
  }

  if (!asset) {
    return (
      <div className="panel-lift rounded-[10px] border border-border bg-surface p-3">
        <ErrorState message={heatmap.error ?? "Нет данных по активу"} onRetry={() => void heatmap.refresh()} />
      </div>
    );
  }

  const up = asset.change24h > 0;
  const down = asset.change24h < 0;
  const dirTone = asset.topDirection === "UP" ? "bull" : asset.topDirection === "DOWN" ? "bear" : "info";
  const DirIcon = asset.topDirection === "UP" ? TrendingUp : asset.topDirection === "DOWN" ? TrendingDown : Minus;

  return (
    <article
      className={`hoverable relative flex flex-col rounded-[10px] border bg-surface p-3 ${
        strongest ? "border-[rgba(91,141,238,0.45)] shadow-[0_0_32px_rgba(91,141,238,0.07)]" : "border-border hover:border-border-strong"
      }`}
    >
      {strongest && (
        <span className="absolute -top-px right-3 rounded-b-[5px] bg-accent px-1.5 py-[2px] text-[13px] font-bold tracking-[0.12em] text-white">
          СИЛЬНЕЙШИЙ СИГНАЛ
        </span>
      )}
      {/* Row 1 — identity */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="num text-[15px] font-bold tracking-tight text-text-1">{symbol.replace("-USDT", "")}</span>
          <span className="num text-[13px] text-text-3">/ USDT</span>
          {asset.role === "explore" && (
            <span className="num rounded-[4px] border border-dashed border-border-strong px-1 text-[13px] text-text-3">
              разведка
            </span>
          )}
          {asset.dataLive === false && (
            <span className="num text-[13px]" style={{ color: "var(--amber)" }}>
              синтетика
            </span>
          )}
        </div>
        <Tip
          align="end"
          label={
            <div>
              <TipRow k="Направление топ-комбо" v={asset.topDirection} tone={dirTone} />
              <TipRow k="EVS топ-комбинации" v={asset.topEvs.toFixed(0) + " / 100"} />
              <TipRow k="Режим" v={asset.regime.replace(/_/g, " ")} />
            </div>
          }
        >
          <span className="flex items-center gap-1" style={{ color: dirTone === "bull" ? "var(--green)" : dirTone === "bear" ? "var(--red)" : "var(--blue)" }}>
            <DirIcon className="size-3.5" strokeWidth={2} />
            <span className="num text-[13px] font-semibold">{asset.topDirection}</span>
          </span>
        </Tip>
      </div>

      {/* Row 2 — price */}
      <div className="mt-1 flex items-end justify-between gap-2">
        <span className="num text-[30px] font-bold leading-none tracking-tight text-text-1">
          ${fmtPrice(asset.lastPrice)}
        </span>
        <span
          className="num mb-[1px] inline-flex items-center gap-0.5 text-[14px] font-medium"
          style={{ color: up ? "var(--green)" : down ? "var(--red)" : "var(--blue)" }}
        >
          {up ? <ArrowUpRight className="size-3" /> : down ? <ArrowDownRight className="size-3" /> : null}
          {fmtPct(asset.change24h, 2)} · 24h
        </span>
      </div>

      {/* Sparkline */}
      <div className="mt-2">
        <Sparkline data={asset.closes24} height={44} />
      </div>

      {/* Cat dots — 15 категорий */}
      <div className="mt-2 flex items-center">
        <div className="flex items-center gap-[3px]">
          {cats.slice(0, 15).map((c) => {
            const sig = asset.signals?.[c];
            const score = sig?.normalizedScore ?? 0;
            return (
              <Tip
                key={c}
                label={
                  <div>
                    <div className="mb-1 text-[13px] font-semibold text-text-1">{CATEGORY_RU[c] ?? c}</div>
                    <TipRow k="Score" v={fmtSigned(score)} tone={score > 0.04 ? "bull" : score < -0.04 ? "bear" : "info"} />
                    <TipRow k="Примитив" v={sig?.primitiveName ?? "—"} />
                    <TipRow k="Уверенность" v={`${Math.round((sig?.confidence ?? 0) * 100)}%`} />
                  </div>
                }
              >
                <span
                  className="hoverable block size-[8px] cursor-help rounded-[2.5px] border border-[rgba(255,255,255,0.08)] hover:scale-125"
                  style={{ background: heatColor(score) }}
                  aria-label={`${CATEGORY_RU[c] ?? c}: ${fmtSigned(score)}`}
                />
              </Tip>
            );
          })}
        </div>
      </div>

      {/* EVS footer */}
      <Tip
        align="start"
        label={
          <div className="max-w-[230px]">
            <div className="mb-1 text-[13px] font-semibold text-text-1">Early Value Score · 0–100</div>
            <div className="text-[13px] leading-snug text-text-2">
              Ранняя ценность сильнейшей комбинации актива: новизна, кросс-согласие категорий, историческая
              поддержка, стабильность эффекта, ликвидность, качество данных, тестируемость. От 60 — кандидат в
              гипотезы, от 75 — высокоприоритетный сигнал.
            </div>
          </div>
        }
      >
        <div className="mt-2 flex cursor-help items-center gap-2 border-t border-border pt-2">
          <span className="text-[13px] uppercase tracking-[0.12em] text-text-3">EVS</span>
          <MeterBar value={asset.topEvs} tone={evsTone(asset.topEvs)} height={4} className="flex-1" />
          <span className="num text-[15px] font-semibold" style={{ color: asset.topEvs >= 75 ? "var(--green)" : asset.topEvs >= 60 ? "var(--accent)" : "var(--text-2)" }}>
            {asset.topEvs.toFixed(0)}
          </span>
        </div>
      </Tip>
    </article>
  );
}

/* ============================= Universe strip ============================= */

const UNIVERSE_SOURCE_RU: Record<UniverseSource, string> = {
  memory: "текущий цикл",
  persisted: "последний цикл",
  "live-scan": "живой скан",
  none: "нет данных",
};

/**
 * Полоса вселенной: состав пар, который система собрала сама.
 * Клик по чипу разворачивает числовое обоснование отбора и переводит панель
 * «Топ комбинации» на этот актив. Тултипы здесь не помогут — прозрачность
 * должна быть видна, а не спрятана под курсор.
 */
function UniverseStrip({
  universe,
  source,
  listedCount,
  floorCount,
  selected,
  onSelectAsset,
}: {
  universe: UniverseMemberRow[];
  source: UniverseSource;
  listedCount?: number | null;
  floorCount?: number | null;
  selected: string;
  onSelectAsset: (symbol: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  if (universe.length === 0) return null;

  const detail = universe.find((m) => m.symbol === open) ?? null;
  const exploreCount = universe.filter((m) => m.role === "explore").length;
  const staleCount = universe.filter((m) => !m.dataLive).length;

  return (
    <section className="anim-fade-up rounded-[10px] border border-border bg-surface">
      <div className="flex items-center gap-3 px-3 py-2">
        <div className="flex shrink-0 items-center gap-1.5">
          <Globe className="size-3.5 text-accent" strokeWidth={2} />
          <span className="text-[13px] font-semibold uppercase tracking-[0.14em] text-text-3">
            Вселенная
          </span>
        </div>

        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {universe.map((m) => {
            const isOpen = open === m.symbol;
            const isActive = selected === m.symbol;
            return (
              <button
                key={m.symbol}
                type="button"
                onClick={() => {
                  setOpen(isOpen ? null : m.symbol);
                  onSelectAsset(m.symbol);
                }}
                title={m.reason}
                className={`hoverable pressable inline-flex items-center gap-1.5 rounded-[5px] border bg-surface2 px-1.5 py-[3px] text-[13px] font-medium transition-colors ${
                  isActive ? "text-accent" : "text-text-1 hover:text-accent"
                } ${isOpen || isActive ? "border-[rgba(91,141,238,0.55)]" : "border-border-strong"}`}
                style={m.role === "explore" ? { borderStyle: "dashed" } : undefined}
              >
                <span className="num">{m.symbol.replace("-USDT", "")}</span>
                <span className="num text-text-3">{m.score}</span>
                {!m.dataLive && (
                  <span
                    className="size-[5px] rounded-full"
                    style={{ background: "var(--amber)" }}
                    aria-label="нет живых данных"
                  />
                )}
              </button>
            );
          })}
        </div>

        <span className="num shrink-0 text-[13px] text-text-3">
          {universe.length} из {floorCount ?? "—"} исполнимых
          {listedCount ? ` · ${listedCount} листингов` : ""} · {UNIVERSE_SOURCE_RU[source]}
        </span>
      </div>

      {detail ? (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border px-3 py-2">
          <span className="num text-[13px] font-semibold text-text-1">
            {detail.symbol.replace("-USDT", "")} · {detail.role === "core" ? "ядро" : "разведка"}
          </span>
          <span className="text-[13px] text-text-3">{detail.reason}</span>
          <div className="flex items-center gap-3">
            {([
              ["ликвидность", detail.components.liquidity, "var(--accent)"],
              ["волатильность", detail.components.volatility, "var(--green)"],
              ["RS к BTC", detail.components.relativeStrength, "var(--amber)"],
              ["turnover", detail.components.turnover, "var(--blue)"],
            ] as const).map(([label, value, color]) => (
              <span key={label} className="flex items-center gap-1.5">
                <span className="text-[13px] text-text-3">{label}</span>
                <span className="h-[3px] w-10 overflow-hidden rounded-full bg-[rgba(255,255,255,0.07)]">
                  <span
                    className="block h-full rounded-full"
                    style={{ width: `${Math.round(value * 100)}%`, background: color }}
                  />
                </span>
                <span className="num text-[13px] text-text-2">{Math.round(value * 100)}</span>
              </span>
            ))}
          </div>
          <span className="num text-[13px] text-text-3">
            объём {fmtCompact(detail.volumeUsd)} · спред {detail.spreadBps.toFixed(1)} bps
          </span>
        </div>
      ) : (
        <div className="border-t border-border px-3 py-1.5 text-[13px] text-text-3">
          Пары отобраны самим циклом: пол ликвидности → мерит-скор → слот разведки. Клик по паре —
          пересчитать панель «Топ комбинации» на этом активе
          {exploreCount > 0 ? `, пунктиром — ${exploreCount} слот(а) разведки` : ""}
          {staleCount > 0 ? `, янтарь — ${staleCount} без живых данных (гипотез по ним нет)` : ""}.
        </div>
      )}
    </section>
  );
}

/* ============================= Planner decision strip ============================= */

const PLANNER_MODE_META: Record<PlannerMode, { label: string; tone: "accent" | "neutral" | "warn" }> = {
  ai: { label: "решил ИИ", tone: "accent" },
  rule: { label: "решило правило", tone: "neutral" },
  fallback: { label: "запасное правило", tone: "warn" },
};

/**
 * Полоса решения цикла. Главное, что здесь должно быть видно: сколько гипотез
 * оформлять и какие — решает модель, а не ползунок. Потолок записей — страховка
 * от потока, и «взято 2 из 16» при потолке 12 является полноценным решением.
 */
function PlannerStrip({ decision }: { decision: PlannerDecisionRow | null }) {
  const [open, setOpen] = useState(false);
  if (!decision) return null;

  const meta = PLANNER_MODE_META[decision.mode];
  const picked = decision.picks.length;
  const who = decision.model ?? decision.provider ?? "без провайдера";

  return (
    <section className="anim-fade-up rounded-[10px] border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
        <div className="flex shrink-0 items-center gap-1.5">
          <Brain className="size-3.5 text-accent" strokeWidth={2} />
          <span className="text-[13px] font-semibold uppercase tracking-[0.14em] text-text-3">
            Решение цикла
          </span>
        </div>
        <Pill tone={meta.tone} dot={decision.mode === "ai"}>
          {meta.label}
        </Pill>
        <span className="num text-[13px] text-text-2">
          {picked} из {decision.offered} кандидатов · потолок {decision.ceiling} (страховка, не план)
        </span>
        <span className="num text-[13px] text-text-3">
          {(decision.latencyMs / 1000).toFixed(1)} с · {who}
        </span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="hoverable ml-auto text-[13px] text-text-3 hover:text-accent"
        >
          {open ? "свернуть" : picked > 0 ? "что взято" : "почему ничего"}
        </button>
      </div>

      <div className="border-t border-border px-3 py-1.5 text-[13px] leading-relaxed text-text-1">
        {decision.narrative || "решение не записано"}
        {decision.error ? (
          <span className="text-text-3"> · сбой: {decision.error.slice(0, 120)}</span>
        ) : null}
      </div>

      {open ? (
        <div className="border-t border-border px-3 py-2">
          {picked === 0 ? (
            <p className="text-[13px] text-text-3">
              Ноль гипотез — это не пустой цикл, а отказ ставить на шум: на бумажном исполнении
              объём ставок ничего не приносит, а сомнительная гипотеза стоит калибровке весов.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {decision.picks.map((p) => (
                <li key={p.code} className="flex items-start gap-2.5">
                  <span className="num w-[104px] shrink-0 text-[13px] font-semibold text-text-1">
                    {p.asset.replace("-USDT", "")}
                    <span className="ml-1 font-normal" style={{ color: p.direction === "UP" ? "var(--green)" : "var(--red)" }}>
                      {p.direction === "UP" ? "▲" : "▼"}
                    </span>
                  </span>
                  <span className="w-[52px] shrink-0">
                    <span className="num text-[13px] text-text-2">{(p.conviction * 100).toFixed(0)}%</span>
                    <MeterBar value={p.conviction * 100} tone={p.conviction >= 0.7 ? "bull" : "info"} height={3} />
                  </span>
                  <span className="min-w-0 flex-1 text-[13px] text-text-2">
                    <span className="num text-text-3">{p.code}</span> · EVS {p.evs ?? "—"} · {p.why}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {decision.dropped.length > 0 ? (
            <p className="mt-2 text-[13px] text-text-3">
              Отброшено при валидации: {decision.dropped.map((d) => `${d.code} — ${d.reason}`).join("; ")}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/* ============================= Stats strip ============================= */
function StatCell({
  label,
  value,
  tone,
  children,
  tip,
}: {
  label: string;
  value: React.ReactNode;
  tone?: string;
  children?: React.ReactNode;
  tip?: React.ReactNode;
}) {
  const inner = (
    <div className="flex h-full flex-col justify-center gap-1 px-4">
      <span className="text-[13px] font-semibold uppercase tracking-[0.14em] text-text-3">{label}</span>
      <div className="flex items-center gap-2">
        <span className="num text-[30px] font-bold leading-none tracking-tight" style={{ color: tone ?? "var(--text-1)" }}>
          {value}
        </span>
        {children}
      </div>
    </div>
  );
  return tip ? <Tip label={tip} className="h-full cursor-help">{inner}</Tip> : inner;
}

/* ============================= Compact heatmap ============================= */

function HeatmapCompact({ heatmap }: { heatmap: ApiState<HeatmapResponse> }) {
  if (heatmap.loading && !heatmap.data) return <SkeletonRows rows={4} height={44} />;
  if (heatmap.error && !heatmap.data)
    return <ErrorState message={heatmap.error} onRetry={() => void heatmap.refresh()} />;
  if (!heatmap.data) return null;

  const { categories, assets } = heatmap.data;

  return (
    <div className="flex h-full flex-col">
      <div className="grid flex-1 content-start gap-y-1.5" style={{ gridTemplateColumns: "86px repeat(15, 1fr)" }}>
        <span />
        {categories.map((c) => (
          <Tip key={c} label={<span className="text-[13px]">{CATEGORY_RU[c] ?? c}</span>}>
            <span className="num cursor-help text-center text-[13px] font-semibold tracking-wide text-text-3">
              {CATEGORY_SHORT[c] ?? c.slice(0, 3).toUpperCase()}
            </span>
          </Tip>
        ))}
        {assets.map((a) => (
          <React.Fragment key={a.symbol}>
            <div className="flex flex-col justify-center pr-2">
              <span className="num text-[13px] font-semibold text-text-1">{a.symbol.replace("-USDT", "")}</span>
              <span
                className="num text-[13px]"
                style={{ color: a.change24h > 0 ? "var(--green)" : a.change24h < 0 ? "var(--red)" : "var(--text-3)" }}
              >
                {fmtPct(a.change24h, 1)}
              </span>
            </div>
            {categories.map((c) => {
              const sig = a.signals?.[c];
              const score = sig?.normalizedScore ?? 0;
              return (
                <Tip
                  key={c}
                  label={
                    <div>
                      <div className="mb-1 text-[13px] font-semibold text-text-1">
                        {a.symbol.replace("-USDT", "")} · {CATEGORY_RU[c] ?? c}
                      </div>
                      <TipRow k="Score" v={fmtSigned(score)} tone={score > 0.04 ? "bull" : score < -0.04 ? "bear" : "info"} />
                      <TipRow k="Примитив" v={sig?.primitiveName ?? "—"} />
                      <TipRow k="Raw" v={(sig?.rawValue ?? 0).toFixed(4)} />
                      <TipRow k="Conf / Miss" v={`${Math.round((sig?.confidence ?? 0) * 100)}% / ${Math.round((sig?.missingness ?? 0) * 100)}%`} />
                    </div>
                  }
                >
                  <div
                    className="hm-cell flex h-[44px] cursor-help items-center justify-center rounded-[5px] border border-[rgba(255,255,255,0.05)]"
                    style={{ background: heatColor(score) }}
                  >
                    <span
                      className="num text-[13px] font-medium"
                      style={{ color: Math.abs(score) > 0.25 ? "var(--text-1)" : "var(--text-3)" }}
                    >
                      {Math.abs(score) >= 0.05 ? score.toFixed(1).replace("-0", "−").replace("0", "") : "·"}
                    </span>
                  </div>
                </Tip>
              );
            })}
          </React.Fragment>
        ))}
      </div>
      {/* legend */}
      <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
        <div className="flex items-center gap-1.5 text-[13px] text-text-3">
          <span>−1.0</span>
          <div className="h-1.5 w-24 rounded-full" style={{ background: "linear-gradient(90deg, rgba(245,101,101,0.9), rgba(245,101,101,0.15), rgba(96,165,250,0.1), rgba(34,211,160,0.15), rgba(34,211,160,0.9))" }} />
          <span>+1.0</span>
        </div>
        <span className="num text-[13px] text-text-3">обновлено {fmtClock(heatmap.data.updatedAt)}</span>
      </div>
    </div>
  );
}

/* ============================= Top combinations ============================= */

function dirArrow(dir: string, size = "size-3.5") {
  if (dir === "UP") return <TrendingUp className={size} style={{ color: "var(--green)" }} strokeWidth={2.2} />;
  if (dir === "DOWN") return <TrendingDown className={size} style={{ color: "var(--red)" }} strokeWidth={2.2} />;
  return <Minus className={size} style={{ color: "var(--blue)" }} strokeWidth={2.2} />;
}

const STATUS_PILL: Record<string, { tone: "bull" | "accent" | "info" | "neutral"; label: string }> = {
  validated: { tone: "bull", label: "VALIDATED" },
  promising: { tone: "accent", label: "PROMISING" },
  candidate: { tone: "info", label: "CANDIDATE" },
  rejected: { tone: "neutral", label: "REJECTED" },
};

function TopCombos({ combos, onOpenView }: { combos: ApiState<CombinationsResponse>; onOpenView: (v: ViewKey) => void }) {
  if (combos.loading && !combos.data) return <SkeletonRows rows={8} height={34} />;
  if (combos.error && !combos.data)
    return <ErrorState message={combos.error} onRetry={() => void combos.refresh()} />;
  if (!combos.data || combos.data.combinations.length === 0)
    return (
      <EmptyState
        icon={<Inbox className="size-4.5" strokeWidth={1.6} />}
        title="Комбинации ещё не сгенерированы"
        text="Запустите исследовательский цикл — движок соберёт вселенную и связки по 15 категориям, а планировщик решит, какие из них стоят гипотезы."
      />
    );

  const top = combos.data.combinations.slice(0, 8);
  const s = combos.data.stats;

  return (
    <div className="flex h-full flex-col">
      <div className="stagger flex-1">
        {top.map((c, i) => {
          const st = STATUS_PILL[c.status] ?? STATUS_PILL.candidate;
          const evs = c.earlyValueScore;
          return (
            <Tip
              key={c.code}
              align="start"
              label={
                <div className="min-w-[220px]">
                  <div className="num mb-1 text-[13px] font-semibold text-text-1">{c.code}</div>
                  <div className="mb-1 text-[13px] leading-snug text-text-2">{c.expression}</div>
                  <TipRow k="Novelty" v={`${c.breakdown.novelty}/20`} />
                  <TipRow k="Agreement" v={`${c.breakdown.crossAgreement}/20`} />
                  <TipRow k="History" v={`${c.breakdown.historicalSupport}/20`} />
                  <TipRow k="Stability" v={`${c.breakdown.effectStability}/15`} />
                  <TipRow k="Liquidity" v={`${c.breakdown.coverageLiquidity}/10`} />
                  <TipRow k="Data quality" v={`${c.breakdown.dataQuality}/10`} />
                  <TipRow k="Testable" v={`${c.breakdown.testability}/5`} />
                </div>
              }
            >
              <div
                className={`hoverable flex h-[48px] cursor-default items-center gap-2.5 rounded-md border border-transparent px-2 hover:border-border hover:bg-surface2 ${
                  i === 0 ? "bg-[rgba(91,141,238,0.06)]" : ""
                } ${c.passes === false ? "opacity-45" : ""}`}
              >
                <span className={`num w-4 text-[14px] font-semibold ${i === 0 ? "text-accent" : "text-text-3"}`}>
                  {i + 1}
                </span>
                {dirArrow(c.targetDirection)}
                <span className="num w-[126px] truncate text-[14px] font-medium text-text-1">{c.code}</span>
                <span className="num w-[16px] text-center text-[13px] text-text-3">{c.operator}</span>
                <span className="hidden min-w-0 flex-1 items-center gap-1 2xl:flex">
                  {c.categories.slice(0, 4).map((cat) => (
                    <span key={cat} className="num rounded bg-[rgba(255,255,255,0.045)] px-1 py-px text-[13px] text-text-3">
                      {CATEGORY_SHORT[cat] ?? cat.slice(0, 3).toUpperCase()}
                    </span>
                  ))}
                </span>
                <div className="flex w-[112px] items-center gap-2">
                  <MeterBar value={evs} tone={evsTone(evs)} height={4} className="flex-1" />
                  <span className="num w-6 text-right text-[15px] font-semibold text-text-1">{evs.toFixed(0)}</span>
                </div>
                <Pill tone={st.tone} className="w-[82px] justify-center">{st.label}</Pill>
              </div>
            </Tip>
          );
        })}
      </div>
      <div className="mt-1 flex items-center justify-between border-t border-border px-1 pt-2">
        <span className="num text-[13px] text-text-3">
          {combos.data.totalCount} связок в пуле · <span style={{ color: "var(--accent)" }}>{s.promisingCount} promising</span> · {s.candidatesCount} candidates · avg {s.avgScore}
        </span>
        <button
          onClick={() => onOpenView("combinations")}
          className="hoverable pressable text-[13px] font-medium text-accent hover:text-text-1"
        >
          Весь пул →
        </button>
      </div>
    </div>
  );
}

/* ============================= Timeline ledger ============================= */

function LedgerTimeline({ ledger }: { ledger: ApiState<LedgerResponse> }) {
  if (ledger.loading && !ledger.data) return <SkeletonRows rows={6} height={30} />;
  if (ledger.error && !ledger.data)
    return <ErrorState message={ledger.error} onRetry={() => void ledger.refresh()} />;

  const items = (ledger.data?.forecasts ?? []).slice(0, 9);
  if (items.length === 0)
    return (
      <EmptyState
        icon={<History className="size-4.5" strokeWidth={1.6} />}
        title="Журнал пуст"
        text="Первые прогнозы появятся после запуска цикла — каждый фиксирует цену входа, цель и инвалидацию."
      />
    );

  return (
    <div className="stagger relative max-h-full overflow-y-auto pr-1 pl-3">
      <div className="absolute bottom-2 left-[20px] top-2 w-px bg-border" />
      {items.map((f: ForecastRow) => {
        const pending = f.status === "pending";
        const o = pending ? "pending" : f.outcome ?? "ambiguous";
        const color =
          o === "hit" ? "var(--green)" : o === "miss" ? "var(--red)" : o === "pending" ? "var(--blue)" : "var(--amber)";
        const Icon = o === "hit" ? Check : o === "miss" ? X : o === "pending" ? Clock3 : Minus;
        return (
          <Tip
            key={f.id}
            align="start"
            label={
              <div>
                <div className="num mb-1 text-[13px] font-semibold text-text-1">FCT-{f.id} · {f.asset}</div>
                <TipRow k="Вход" v={`$${fmtPrice(f.entryPrice)}`} />
                {f.resolvedPrice != null && <TipRow k="Разрешение" v={`$${fmtPrice(f.resolvedPrice)}`} />}
                {f.mfe != null && <TipRow k="MFE / MAE" v={`${f.mfe.toFixed(2)}% / ${(f.mae ?? 0).toFixed(2)}%`} />}
                {f.errorType && f.errorType !== "none" && <TipRow k="Тип ошибки" v={f.errorType} tone="warn" />}
                <TipRow k="Горизонт" v={`${f.horizonMinutes} мин`} />
              </div>
            }
          >
            <div className="hoverable relative flex min-h-[44px] cursor-default items-center gap-2.5 rounded-md px-1 py-[7px] hover:bg-surface2">
              <span
                className={`relative z-[1] flex size-[17px] shrink-0 items-center justify-center rounded-full border ${o === "pending" ? "pulse-dot" : ""}`}
                style={{ borderColor: color, background: "var(--surface)", color }}
              >
                <Icon className="size-[9px]" strokeWidth={3} />
              </span>
              <span className="num w-[52px] shrink-0 text-[13px] text-text-3">{fmtClock(f.createdAt)}</span>
              <span className="num w-[42px] shrink-0 text-[13px] font-semibold text-text-1">
                {f.asset.replace("-USDT", "")}
              </span>
              {dirArrow(f.direction, "size-3")}
              <span className="min-w-0 flex-1" />
              <span className="num text-[14px] font-medium" style={{ color }}>
                {pending ? fmtCountdownSafe(f.resolveAt) : f.realizedReturnNet != null ? fmtPct(f.realizedReturnNet, 2) : "—"}
              </span>
            </div>
          </Tip>
        );
      })}
    </div>
  );
}

function fmtCountdownSafe(resolveAt: string): string {
  const diff = new Date(resolveAt).getTime() - Date.now();
  if (diff <= 0) return "решается";
  const m = Math.floor(diff / 60000);
  return `${m}м`;
}

/* ============================= Learning weights ============================= */

function WeightsPanel({ learning }: { learning: ApiState<LearningResponse> }) {
  if (learning.loading && !learning.data) return <SkeletonRows rows={7} height={22} />;
  if (learning.error && !learning.data)
    return <ErrorState message={learning.error} onRetry={() => void learning.refresh()} />;
  const rows = [...(learning.data?.weights ?? [])].sort((a, b) => b.currentWeight - a.currentWeight).slice(0, 7);
  if (rows.length === 0)
    return (
      <EmptyState
        icon={<Activity className="size-4.5" strokeWidth={1.6} />}
        title="Веса не инициализированы"
        text="Bayesian-цикл обучения создаст веса по 15 категориям после первых разрешённых прогнозов."
      />
    );

  return (
    <div className="stagger flex h-full flex-col justify-between gap-[2px]">
      {rows.map((w) => {
        const delta = w.currentWeight - w.priorWeight;
        const hot = w.currentWeight >= 1.3;
        const cold = w.currentWeight <= 0.7;
        return (
          <Tip
            key={w.categoryName}
            align="start"
            label={
              <div>
                <div className="mb-1 text-[13px] font-semibold text-text-1">{w.labelRu ?? w.categoryName}</div>
                <TipRow k="Вес" v={w.currentWeight.toFixed(3)} />
                <TipRow k="Winrate (сглаж.)" v={fmtPct(w.empiricalWinrate * 100, 1, false)} />
                <TipRow k="Выборка" v={`${w.totalSamples} (H${w.totalHits}/M${w.totalMisses})`} />
                <TipRow k="Brier" v={w.brierScore.toFixed(4)} />
              </div>
            }
          >
            <div className="hoverable flex cursor-default items-center gap-2 rounded px-1 py-[8px] hover:bg-surface2">
              <span className="w-[132px] truncate text-[13px] text-text-2">{w.labelRu ?? w.categoryName}</span>
              <div className="relative h-[5px] flex-1 overflow-hidden rounded-full bg-[rgba(255,255,255,0.05)]">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.min(100, (w.currentWeight / 2.5) * 100)}%`,
                    background: hot ? "var(--green)" : cold ? "var(--red)" : "var(--blue)",
                    opacity: 0.85,
                  }}
                />
                <span className="absolute top-0 h-full w-px bg-[rgba(255,255,255,0.25)]" style={{ left: "40%" }} />
              </div>
              <span className="num w-10 text-right text-[14px] font-medium text-text-1">{w.currentWeight.toFixed(2)}</span>
              <Delta value={delta} digits={2} className="w-[58px] justify-end" />
              <span className="num hidden w-11 text-right text-[13px] text-text-3 2xl:inline">
                {fmtPct(w.empiricalWinrate * 100, 0, false)}
              </span>
            </div>
          </Tip>
        );
      })}
    </div>
  );
}

/* ============================= Walk-Forward compact ============================= */

function WalkForwardCompact({ wf }: { wf: ApiState<WalkForwardResponse> }) {
  if (wf.loading && !wf.data) return <SkeletonRows rows={5} height={24} />;
  const d = wf.data;
  if (!d || !d.windows)
    return (
      <EmptyState
        icon={<FlaskConical className="size-4.5" strokeWidth={1.6} />}
        title="Недостаточно выборки"
        text={d?.message ?? "Для честного теста нужно минимум 6 разрешённых прогнозов. Запустите несколько циклов."}
      />
    );

  const rows = [
    { label: "In-Sample", m: d.windows.inSampleTrain, tone: "var(--blue)" },
    { label: "Out-of-Sample", m: d.windows.outOfSampleValidation, tone: "var(--accent)" },
    { label: "Holdout", m: d.windows.strictlyHoldout, tone: d.verdict?.isHoldoutRobust ? "var(--green)" : "var(--amber)" },
  ];

  return (
    <div className="stagger flex h-full flex-col gap-2">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2 px-1">
          <span className="w-[92px] text-[13px] text-text-3">{r.label}</span>
          <div className="h-[5px] flex-1 overflow-hidden rounded-full bg-[rgba(255,255,255,0.05)]">
            <div className="h-full rounded-full" style={{ width: `${Math.min(100, r.m.hitRate)}%`, background: r.tone }} />
          </div>
          <span className="num w-12 text-right text-[14px] font-semibold text-text-1">{r.m.hitRate.toFixed(1)}%</span>
          <span className="num w-14 text-right text-[13px] text-text-3">n={r.m.sampleSize}</span>
        </div>
      ))}
      <div className="mt-auto space-y-1.5 border-t border-border pt-2">
        <div className="flex items-center justify-between px-1 text-[13px]">
          <span className="text-text-3">Альфа над momentum</span>
          <span className="num font-semibold" style={{ color: (d.verdict?.alphaOverMomentumBps ?? 0) > 0 ? "var(--green)" : "var(--red)" }}>
            {(d.verdict?.alphaOverMomentumBps ?? 0) > 0 ? "+" : ""}
            {(d.verdict?.alphaOverMomentumBps ?? 0).toFixed(1)} bps
          </span>
        </div>
        <div className="flex items-center justify-between px-1 text-[13px]">
          <span className="text-text-3">Стабильность модели</span>
          <span className="num text-text-1">{d.verdict?.stabilityScore.toFixed(0)}%</span>
        </div>
        <div className="flex items-center justify-between px-1 text-[13px]">
          <span className="text-text-3">Leakage-аудит</span>
          <span className="num" style={{ color: "var(--green)" }}>PASSED</span>
        </div>
      </div>
    </div>
  );
}

/* ============================= Overview root ============================= */

/**
 * Порог выборки, ниже которого hit rate — шум, а не оценка преимущества.
 * Используется, чтобы честно подписывать «мало данных» вместо выводов.
 */
const MIN_SAMPLES_FOR_INFERENCE = 30;

export function OverviewView({
  status,
  heatmap,
  combos,
  ledger,
  learning,
  walkforward,
  asset,
  onSelectAsset,
  onOpenView,
}: {
  status: ApiState<StatusResponse>;
  heatmap: ApiState<HeatmapResponse>;
  combos: ApiState<CombinationsResponse>;
  ledger: ApiState<LedgerResponse>;
  learning: ApiState<LearningResponse>;
  walkforward: ApiState<WalkForwardResponse>;
  asset: string;
  onSelectAsset: (symbol: string) => void;
  onOpenView: (v: ViewKey) => void;
}) {
  const stats = status.data?.stats;
  // Герой-карточки — три сильнейших актива вселенной по EVS, а не фиксированный
  // список: если лучший сигнал сейчас на SOL-подобной паре, он должен быть на виду.
  const heroSymbols = useMemo(
    () =>
      heatmap.data?.assets
        ? [...heatmap.data.assets]
            .sort((a, b) => b.topEvs - a.topEvs)
            .slice(0, 3)
            .map((a) => a.symbol)
        : [],
    [heatmap.data]
  );
  const topAssetSymbol = heroSymbols[0] ?? null;
  const universe = status.data?.universe ?? [];
  // null = данных нет. Раньше вместо null подставлялись 0 и 0.25, и экран
  // уверенно показывал «hit rate 0%» и «Brier как у монетки» на пустой базе.
  const hitRate = stats?.empiricalHitRate ?? null;
  const decided = (stats?.hits ?? 0) + (stats?.misses ?? 0);
  const hitTone =
    hitRate === null ? "var(--text-3)" : hitRate >= 55 ? "var(--green)" : hitRate >= 48 ? "var(--amber)" : "var(--red)";
  const brier = stats?.averageBrierScore ?? null;
  const lastRun = status.data?.scheduler.lastRunTime ?? null;

  return (
    <div className="mx-auto grid max-w-[1920px] gap-4 p-5">
      <ViewGuide
        right={<AiButton scope="signal_today" title="Главный сигнал сейчас" label="Что торговать сейчас?" />}
        note="Кнопка справа спросит ИИ по данным этого экрана и предложит параметры отбора, которые можно сразу применить."
        accent="Обзор · главные 3 секунды"
        steps={[
          { t: "Ищите бейдж «СИЛЬНЕЙШИЙ СИГНАЛ»", d: "актив с максимальным EVS — главный кандидат в сделку прямо сейчас" },
          { t: "Проверьте Hit Rate и Brier", d: "hit rate ≥ 55% и Brier ≤ 0.20 — модель в форме; хуже — снизьте риск" },
          { t: "Состав пар выбирает сам цикл", d: "полоса «Вселенная» — активы, прошедшие пол ликвидности и мерит-скор; клик по чипу раскрывает цифры отбора" },
          { t: "Сколько гипотез — решает модель", d: "в полосе «Решение цикла» видно взято N из M; потолок — страховка от потока, а не план, и 0 — полноценный ответ" },
        ]}
      />

      {/* ——— Вселенная: какие пары система выбрала сама и почему ——— */}
      <UniverseStrip
        universe={universe}
        source={status.data?.universeSource ?? "none"}
        listedCount={status.data?.universeListedCount}
        floorCount={status.data?.universeFloorCount}
        selected={asset}
        onSelectAsset={onSelectAsset}
      />

      {/* ——— Кто решил этот цикл и сколько гипотез он счёл нужным оформить ——— */}
      <PlannerStrip decision={status.data?.planner ?? null} />

      {/* ——— Command center: asset cards ——— */}
      <div className="grid gap-3 md:grid-cols-3 anim-fade-up">
        {heroSymbols.length > 0 ? (
          heroSymbols.map((sym) => (
            <AssetCard key={sym} symbol={sym} heatmap={heatmap} strongest={sym === topAssetSymbol} />
          ))
        ) : (
          ["BTC-USDT", "ETH-USDT", "SOL-USDT"].map((sym) => (
            <AssetCard key={sym} symbol={sym} heatmap={heatmap} strongest={false} />
          ))
        )}
      </div>

      {/* ——— Stats strip ——— */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[10px] border border-border bg-border lg:grid-cols-4 anim-fade-up [&>*]:bg-surface" style={{ animationDelay: "40ms" }}>
        <StatCell
          label="Hit Rate · эмпирический"
          value={hitRate === null ? "нет данных" : `${hitRate.toFixed(1)}%`}
          tone={hitRate === null ? undefined : hitTone}
          tip={
            <div>
              <TipRow k="Hits / Misses" v={`${stats?.hits ?? 0} / ${stats?.misses ?? 0}`} />
              <TipRow k="Ambiguous" v={String(stats?.ambiguous ?? 0)} />
              <TipRow k="Всего разрешено" v={String(stats?.totalResolved ?? 0)} />
              {/* Хитрейт по hit/(hit+miss): ambiguous — пропуск данных, не исход */}
              <TipRow k="Знаменатель" v={`${decided} решённых`} />
              {decided > 0 && decided < MIN_SAMPLES_FOR_INFERENCE && (
                <TipRow k="Осторожно" v={`мало данных (< ${MIN_SAMPLES_FOR_INFERENCE})`} />
              )}
            </div>
          }
        >
          <span className="text-[13px] text-text-3">{stats ? `${stats.hits}/${stats.misses}` : ""}</span>
        </StatCell>
        <StatCell
          label="Brier Score · калибровка"
          value={brier === null ? "нет данных" : brier.toFixed(4)}
          tone={brier === null ? undefined : brier <= 0.2 ? "var(--green)" : brier <= 0.26 ? "var(--amber)" : "var(--red)"}
          tip={
            <div>
              <TipRow k="Идеал" v="0.0000" />
              <TipRow k="Случайный уровень" v="0.2500" />
              <TipRow
                k="Оценка"
                v={
                  brier === null
                    ? "ещё нет разрешённых исходов"
                    : brier <= 0.2
                      ? "калибровка хорошая"
                      : brier <= 0.26
                        ? "приемлемо"
                        : "нужно дообучение"
                }
              />
            </div>
          }
        >
          <span className="text-[13px] text-text-3">{brier === null ? "нет исходов" : brier <= 0.2 ? "точно" : "обучается"}</span>
        </StatCell>
        <StatCell
          label="Активные гипотезы"
          value={stats ? String(stats.activeHypothesesCount) : "—"}
          tip={
            <div>
              <TipRow k="Новейшая" v={status.data?.activeHypotheses[0]?.code ?? "—"} />
              <TipRow k="Отслеживается активов" v={String(stats?.totalAssetsTracked ?? 0)} />
              <TipRow k="В выборке цикла" v={String(status.data?.universeSize ?? 0)} />
            </div>
          }
        />
        <StatCell
          label="Последний цикл"
          value={lastRun ? timeAgo(lastRun) : "—"}
          tone="var(--text-2)"
          tip={
            <div>
              <TipRow k="Время запуска" v={lastRun ? fmtClock(lastRun) : "—"} />
              <TipRow k="Режим рынка" v={status.data?.latestRegime?.replace(/_/g, " ") ?? "—"} />
            </div>
          }
        >
          <span className="text-[13px] text-text-3">{status.data?.latestRegime ? REGIME_RU_SHORT(status.data.latestRegime) : ""}</span>
        </StatCell>
      </div>

      {/* ——— Main grid: heatmap + combos ——— */}
      <div className="grid gap-3 xl:grid-cols-12 anim-fade-up" style={{ animationDelay: "80ms" }}>
        <Panel
          title="Хитмап сигналов"
          sub={`${heatmap.data?.assets.length ?? 0} активов вселенной × 15 категорий · цвет = направление, интенсивность = сила |score|`}
          className="xl:col-span-7"
          actions={
            <button onClick={() => onOpenView("heatmap")} className="hoverable pressable text-[13px] font-medium text-accent hover:text-text-1">
              Развернуть →
            </button>
          }
        >
          <HeatmapCompact heatmap={heatmap} />
        </Panel>
        <Panel
          title="Топ комбинации"
          sub={
            combos.data
              ? `${combos.data.symbol.replace("-USDT", "")} · ${combos.data.regime.replace(/_/g, " ")}${
                  combos.data.dataLive === false ? " · синтетические свечи" : ""
                }`
              : "по EVS"
          }
          className="xl:col-span-5"
          pad={false}
          actions={
            <div className="flex items-center gap-2">
              <button
                onClick={() => onOpenView("combinations")}
                className="hoverable pressable text-[13px] font-medium text-accent hover:text-text-1"
              >
                Все связки →
              </button>
              <AiButton scope="combo_audit" title="Аудит комбинаций" compact />
            </div>
          }
        >
          <div className="h-full p-2">
            <TopCombos combos={combos} onOpenView={onOpenView} />
          </div>
        </Panel>
      </div>

      {/* ——— Bottom: ledger / weights / walk-forward ——— */}
      <div className="grid gap-3 xl:grid-cols-12 anim-fade-up" style={{ animationDelay: "120ms" }}>
        <Panel
          title="Журнал прогнозов"
          sub="живая лента: вход → цель/инвалидация → исход"
          className="xl:col-span-4"
          actions={
            <button onClick={() => onOpenView("ledger")} className="hoverable pressable text-[13px] font-medium text-accent hover:text-text-1">
              Весь журнал →
            </button>
          }
        >
          <LedgerTimeline ledger={ledger} />
        </Panel>
        <Panel
          title="Веса обучения"
          sub="Δ веса к приору · байесовское онлайн-обучение"
          className="xl:col-span-4"
          actions={
            <button onClick={() => onOpenView("learning")} className="hoverable pressable text-[13px] font-medium text-accent hover:text-text-1">
              Обучение →
            </button>
          }
        >
          <WeightsPanel learning={learning} />
        </Panel>
        <Panel
          title="Walk-Forward"
          sub="честный тест: обучение / валидация / холдаут"
          className="xl:col-span-4"
          actions={
            <button onClick={() => onOpenView("walkforward")} className="hoverable pressable text-[13px] font-medium text-accent hover:text-text-1">
              Детали теста →
            </button>
          }
        >
          <WalkForwardCompact wf={walkforward} />
        </Panel>
      </div>
    </div>
  );
}

function REGIME_RU_SHORT(r: string): string {
  switch (r) {
    case "TRENDING_BULL": return "bull-тренд";
    case "TRENDING_BEAR": return "bear-тренд";
    case "HIGH_VOLATILITY_CHOP": return "пила";
    case "LOW_VOLATILITY_SQUEEZE": return "сжатие";
    case "LIQUIDITY_CRUNCH": return "кранч";
    default: return "консолидация";
  }
}
