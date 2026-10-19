"use client";

import React, { useState } from "react";
import { Brain, RefreshCcw, ShieldAlert } from "lucide-react";
import type { ApiState } from "../data";
import { AiButton } from "../ai-dock";
import { postJson, toast } from "../data";
import type { LearningResponse } from "@/lib/ui-types";
import { ERROR_RU, fmtPct, timeAgo } from "@/lib/format";
import { Delta, EmptyState, ErrorState, Panel, Pill, SkeletonRows, Tip, TipRow,
  ViewGuide,
} from "../ui";
import { CalibrationChart } from "../charts";

export function LearningView({
  learning,
  onRetrained,
}: {
  learning: ApiState<LearningResponse>;
  onRetrained: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const d = learning.data;

  const retrain = async () => {
    setBusy(true);
    try {
      const r = await postJson<{ message: string; retrainedCount: number }>("/api/research/learning");
      toast("ok", "Переобучение завершено", r.message);
      onRetrained();
    } catch (err) {
      toast("err", "Ошибка переобучения", err instanceof Error ? err.message : "неизвестно");
    } finally {
      setBusy(false);
    }
  };

  const weights = [...(d?.weights ?? [])].sort((a, b) => b.currentWeight - a.currentWeight);
  const errors = Object.entries(d?.errorDistribution ?? {}).filter(([k]) => k !== "none");
  const totalErr = errors.reduce((a, [, v]) => a + v, 0);

  return (
    <div className="mx-auto grid max-w-[1920px] gap-4 p-5 lg:grid-cols-12 anim-fade-up">
      <ViewGuide
        right={<AiButton scope="weights_doctor" title="Диагностика обучения" label="Проверить модель" />}
        note="ИИ оценит калибровку, найдёт переоценённые категории и предложит, кого приглушить."
        accent="Обучение · доверие модели"
        steps={[
          { t: "Вес = доверие к категории", d: "выше 1.00 — усиливает сигналы, ниже — приглушается в комбинациях" },
          { t: "Δ — сдвиг после переобучения", d: "зелёная стрелка: категория оправдывает доверие последних циклов" },
          { t: "Brier — честность вероятностей", d: "≤ 0.20 отлично; ≥ 0.26 — «вероятностям» модели верить нельзя" },
        ]}
        className="lg:col-span-12"
      />

      {/* Weights table */}
      <Panel
        title="Веса категорий · Bayesian online-learning"
        sub={d ? `выборка ${d.totalAccumulatedSamples} · avg Brier ${d.averageBrierScore ?? "нет данных"}` : ""}
        className="lg:col-span-7"
        pad={false}
        actions={
          <button
            onClick={retrain}
            disabled={busy}
            className="hoverable pressable flex items-center gap-1.5 rounded-md border border-[rgba(91,141,238,0.45)] bg-accent-dim px-2.5 py-1 text-[13px] font-semibold text-accent hover:bg-accent hover:text-white disabled:opacity-50"
          >
            <RefreshCcw className={`size-3 ${busy ? "animate-spin" : ""}`} strokeWidth={2.2} />
            {busy ? "Обучение…" : "Переобучить на всей истории"}
          </button>
        }
      >
        <div className="max-h-[calc(100vh-232px)] overflow-y-auto p-2">
          {learning.loading && !d ? (
            <SkeletonRows rows={15} height={30} />
          ) : learning.error && !d ? (
            <ErrorState message={learning.error} onRetry={() => void learning.refresh()} />
          ) : weights.length === 0 ? (
            <EmptyState
              icon={<Brain className="size-4.5" strokeWidth={1.6} />}
              title="Веса ещё не созданы"
              text="Нажмите «Переобучить» после первых разрешённых прогнозов — веса построятся по Байесу со сглаживанием α=β=5."
            />
          ) : (
            <div className="stagger">
              <div className="grid grid-cols-[24px_1fr_150px_70px_90px_84px_86px] items-center gap-2 px-2 pb-1.5 text-[13px] font-semibold uppercase tracking-[0.12em] text-text-3">
                <span>#</span><span>Категория</span><span>Вес (0.25–2.5)</span><span className="text-right">Вес</span>
                <span className="text-right">Δ приор</span><span className="text-right">Winrate</span><span className="text-right">Brier</span>
              </div>
              {weights.map((w, i) => {
                const delta = w.currentWeight - w.priorWeight;
                const hot = w.currentWeight >= 1.3;
                const cold = w.currentWeight <= 0.7;
                return (
                  <Tip
                    key={w.categoryName}
                    align="start"
                    label={
                      <div>
                        <div className="mb-1 text-[13px] font-semibold text-text-1">{w.labelRu}</div>
                        <TipRow k="Samples" v={String(w.totalSamples)} />
                        <TipRow k="Hits / Misses" v={`${w.totalHits} / ${w.totalMisses}`} />
                        <TipRow k="Обновлён" v={timeAgo(w.lastUpdated)} />
                      </div>
                    }
                  >
                    <div className="hoverable grid cursor-default grid-cols-[24px_1fr_150px_70px_90px_84px_86px] items-center gap-2 rounded-md px-2 py-[10px] hover:bg-surface2">
                      <span className="num text-[13px] text-text-3">{i + 1}</span>
                      <span className="truncate text-[14px] text-text-2">{w.labelRu}</span>
                      <div className="relative h-[5px] overflow-hidden rounded-full bg-[rgba(255,255,255,0.05)]">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${Math.min(100, (w.currentWeight / 2.5) * 100)}%`,
                            background: hot ? "var(--green)" : cold ? "var(--red)" : "var(--blue)",
                          }}
                        />
                        <span className="absolute top-0 h-full w-px bg-[rgba(255,255,255,0.25)]" style={{ left: "40%" }} />
                      </div>
                      <span className="num text-right text-[14px] font-semibold text-text-1">{w.currentWeight.toFixed(3)}</span>
                      <Delta value={delta} digits={2} className="justify-end" />
                      <span className="num text-right text-[13px]" style={{ color: w.empiricalWinrate >= 0.55 ? "var(--green)" : w.empiricalWinrate <= 0.48 ? "var(--red)" : "var(--text-2)" }}>
                        {fmtPct(w.empiricalWinrate * 100, 1, false)}
                      </span>
                      <span className="num text-right text-[13px] text-text-3">{w.brierScore.toFixed(3)}</span>
                    </div>
                  </Tip>
                );
              })}
            </div>
          )}
        </div>
      </Panel>

      {/* Right column: calibration + errors */}
      <div className="grid gap-3 lg:col-span-5">
        <div className="panel-lift rounded-[10px] border border-border bg-surface px-4 py-3">
          <p className="text-[13px] leading-relaxed text-text-3">
            <span className="font-medium text-text-2">Как обновляются веса:</span> байесовское сглаживание с приором
            α=β=5 не даёт малой выборке перекосить рейтинг; множитель веса = (winrate / 0.50)^0.75, жёстко
            ограничен диапазоном [0.25; 2.50] — защита от переобучения. Brier показывает качество вероятностей:
            ниже 0.20 — модель калибрована, выше 0.26 — прогнозам нельзя доверять как процентам.
          </p>
        </div>
        <Panel title="Калибровка вероятностей" sub="прогноз vs факт">
          {learning.loading && !d ? (
            <SkeletonRows rows={4} height={22} />
          ) : d && d.calibrationBins.length > 0 ? (
            <>
              <CalibrationChart bins={d.calibrationBins} height={130} />
              <div className="mt-2 flex items-center justify-center gap-4 text-[13px] text-text-3">
                <span className="flex items-center gap-1.5"><span className="size-2 rounded-[2px] bg-[rgba(96,165,250,0.45)]" /> Прогнозная p</span>
                <span className="flex items-center gap-1.5"><span className="size-2 rounded-[2px] bg-[rgba(34,211,160,0.75)]" /> Фактическая частота</span>
              </div>
            </>
          ) : (
            <EmptyState icon={<Brain className="size-4.5" strokeWidth={1.6} />} title="Нет биннинга" text="Калибровка появится после накопления прогнозов." />
          )}
        </Panel>

        <Panel title="Таксономия ошибок" sub={totalErr > 0 ? `${totalErr} промахов классифицировано` : "пока чисто"}>
          {learning.loading && !d ? (
            <SkeletonRows rows={4} height={22} />
          ) : errors.length === 0 ? (
            <EmptyState
              icon={<ShieldAlert className="size-4.5" strokeWidth={1.6} />}
              title="Промахов не зафиксировано"
              text="Когда прогнозы начнут промахиваться, каждый будет размечен по типу ошибки — чтобы резать конкретный failure mode."
            />
          ) : (
            <div className="stagger space-y-2">
              {errors.sort((a, b) => b[1] - a[1]).map(([type, count]) => {
                const meta = ERROR_RU[type] ?? { label: type, fix: "—" };
                const share = totalErr > 0 ? (count / totalErr) * 100 : 0;
                return (
                  <Tip
                    key={type}
                    align="start"
                    label={
                      <div className="max-w-[240px]">
                        <div className="mb-1 text-[13px] font-semibold text-text-1">{meta.label}</div>
                        <div className="text-[13px] leading-snug text-text-2">Как исправить: {meta.fix}</div>
                      </div>
                    }
                  >
                    <div className="cursor-default">
                      <div className="mb-1 flex items-center justify-between text-[13px]">
                        <span className="text-text-2">{meta.label}</span>
                        <span className="num text-text-1">{count} · {share.toFixed(0)}%</span>
                      </div>
                      <div className="h-[4px] overflow-hidden rounded-full bg-[rgba(255,255,255,0.05)]">
                        <div className="h-full rounded-full" style={{ width: `${share}%`, background: "var(--red)", opacity: 0.75 }} />
                      </div>
                    </div>
                  </Tip>
                );
              })}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
