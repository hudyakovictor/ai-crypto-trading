"use client";

import React from "react";
import { RefreshCw } from "lucide-react";
import type { ApiState } from "../data";
import { AiButton } from "../ai-dock";
import type { HeatmapResponse } from "@/lib/ui-types";
import { CATEGORY_RU, CATEGORY_SHORT, fmtPct, fmtPrice, fmtSigned } from "@/lib/format";
import { EmptyState, ErrorState, heatColor, Panel, Pill, SkeletonRows, Tip, TipRow,
  ViewGuide,
} from "../ui";
import { Sparkline } from "../charts";
import { Inbox } from "lucide-react";

export function HeatmapView({ heatmap }: { heatmap: ApiState<HeatmapResponse> }) {
  const d = heatmap.data;

  return (
    <div className="mx-auto grid max-w-[1920px] gap-4 p-5 anim-fade-up">
      <ViewGuide
        right={<AiButton scope="heatmap_read" title="Чтение хитмапа" label="Прочитать матрицу" />}
        note="ИИ скажет, какие ячейки значимы с учётом весов обучения, а какие — шум."
        accent="Хитмап · карта давления"
        steps={[
          { t: "Строка = актив, колонка = категория", d: "зелёный — давление вверх, красный — вниз, яркость — сила |score|" },
          { t: "Яркие квадраты важнее чисел", d: "|score| ≥ 0.4 — кандидаты в связки следующего цикла" },
          { t: "Сравнивайте строки", d: "актив с самым широким «фронтом» одного цвета — лидер текущего фона" },
        ]}
      />

      <Panel
        title="Хитмап сигналов · активы вселенной"
        sub={`строки выбирает цикл · ${d?.assets.length ?? "—"} активов × 15 категорий · интенсивность цвета = |normalized score|`}
        actions={
          <div className="flex items-center gap-2">
            {d && <Pill tone={d.isLive ? "bull" : "warn"} dot>{d.isLive ? "LIVE" : "SYNTH"}</Pill>}
            {d && <span className="num text-[13px] text-text-3">{d.latencyMs} ms</span>}
            <button
              onClick={() => void heatmap.refresh()}
              className="hoverable pressable flex items-center gap-1.5 rounded-md border border-border-strong bg-surface2 px-2.5 py-1 text-[13px] font-medium text-text-2 hover:text-text-1"
            >
              <RefreshCw className="size-3" strokeWidth={2} />
              Пересчитать
            </button>
          </div>
        }
        pad={false}
      >
        <div className="p-3">
          {heatmap.loading && !d ? (
            <SkeletonRows rows={4} height={60} />
          ) : heatmap.error && !d ? (
            <ErrorState message={heatmap.error} onRetry={() => void heatmap.refresh()} />
          ) : !d ? (
            <EmptyState icon={<Inbox className="size-4.5" />} title="Нет данных" text="Пересчитайте хитмап." />
          ) : (
            <div className="grid gap-x-1.5 gap-y-2" style={{ gridTemplateColumns: "150px repeat(15, 1fr)" }}>
              <span />
              {d.categories.map((c) => (
                <Tip key={c} label={<span className="text-[13px]">{CATEGORY_RU[c] ?? c}</span>}>
                  <span className="num cursor-help text-center text-[13px] font-semibold tracking-wider text-text-3">
                    {CATEGORY_SHORT[c] ?? c.slice(0, 3).toUpperCase()}
                  </span>
                </Tip>
              ))}

              {d.assets.map((a) => (
                <React.Fragment key={a.symbol}>
                  <div className="flex items-center gap-2.5 pr-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="num text-[15px] font-semibold text-text-1">{a.symbol.replace("-USDT", "")}</span>
                        {a.role === "explore" && (
                          <span className="num rounded-[4px] border border-dashed border-border-strong px-1 text-[13px] text-text-3">
                            разв.
                          </span>
                        )}
                        {a.dataLive === false && (
                          <span className="size-[5px] rounded-full" style={{ background: "var(--amber)" }} />
                        )}
                      </div>
                      <div className="num text-[13px]" style={{ color: a.change24h >= 0 ? "var(--green)" : "var(--red)" }}>
                        ${fmtPrice(a.lastPrice)} · {fmtPct(a.change24h, 1)}
                      </div>
                    </div>
                    <div className="ml-auto hidden w-[76px] xl:block">
                      <Sparkline data={a.closes24} height={24} width={76} />
                    </div>
                  </div>
                  {d.categories.map((c) => {
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
                            <TipRow k="Направление" v={sig?.direction ?? "—"} />
                            <TipRow k="Примитив" v={sig?.primitiveName ?? "—"} />
                            <TipRow k="Raw value" v={(sig?.rawValue ?? 0).toFixed(5)} />
                            <TipRow k="Confidence" v={`${Math.round((sig?.confidence ?? 0) * 100)}%`} />
                            <TipRow k="Missingness" v={`${Math.round((sig?.missingness ?? 0) * 100)}%`} />
                            <TipRow k="Support n" v={String(sig?.supportCount ?? 0)} />
                          </div>
                        }
                      >
                        <div
                          className="hm-cell flex h-[64px] cursor-help flex-col items-center justify-center gap-0.5 rounded-md border border-[rgba(255,255,255,0.05)]"
                          style={{ background: heatColor(score) }}
                        >
                          <span
                            className="num text-[15px] font-semibold"
                            style={{ color: Math.abs(score) > 0.2 ? "var(--text-1)" : "var(--text-3)" }}
                          >
                            {fmtSigned(score, 2)}
                          </span>
                          <span className="num text-[13px] uppercase tracking-wide text-text-3">{sig?.direction ?? "—"}</span>
                        </div>
                      </Tip>
                    );
                  })}
                </React.Fragment>
              ))}
            </div>
          )}

          {/* Legend + reading guide */}
          {d && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
              <div className="flex items-center gap-2 text-[13px] text-text-3">
                <span>−1.0 сильный медвежий</span>
                <div
                  className="h-2 w-44 rounded-full"
                  style={{
                    background:
                      "linear-gradient(90deg, rgba(245,101,101,0.95), rgba(245,101,101,0.12), rgba(96,165,250,0.08), rgba(34,211,160,0.12), rgba(34,211,160,0.95))",
                  }}
                />
                <span>+1.0 сильный бычий</span>
              </div>
              <p className="text-[13px] text-text-3">
                Читайте строки как «вектор давления» актива: столбцы с |score| ≥ 0.4 — кандидаты в комбинации цикла.
              </p>
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}
