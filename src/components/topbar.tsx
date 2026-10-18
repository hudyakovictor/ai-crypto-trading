"use client";

import React from "react";
import { Eraser, Play, Radio, Settings2 } from "lucide-react";
import { Kbd, Pill } from "./ui";
import { fmtCountdown } from "@/lib/format";
import type { StatusResponse } from "@/lib/ui-types";
import { REGIME_RU } from "@/lib/format";

export function Topbar({
  title,
  status,
  running,
  onRun,
  onOpenSettings,
  onClearHistory,
  countdown,
  showRun = true,
}: {
  title: string;
  status: StatusResponse | null;
  running: boolean;
  onRun: () => void;
  onOpenSettings: () => void;
  onClearHistory: () => void;
  countdown: number;
  /** Primary CTA «Запустить цикл» показываем только на главном экране */
  showRun?: boolean;
}) {
  const isLive = status?.isLive;
  const regime = status?.latestRegime ? REGIME_RU[status.latestRegime] ?? status.latestRegime : null;
  const latency = status?.latestLatencyMs;

  return (
    <header className="sticky top-0 z-30 flex h-[56px] items-center gap-3 border-b border-border bg-[rgba(6,9,15,0.88)] px-4 backdrop-blur-md">
      {/* Brand + текущий раздел */}
      <div className="flex items-center gap-2.5">
        <div className="flex size-7 items-center justify-center rounded-md border border-[rgba(91,141,238,0.45)] bg-accent-dim">
          <span className="num text-[14px] font-bold text-accent">Q</span>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-[15px] font-semibold tracking-wide text-text-1">OKX QUANT LAB</span>
          <span className="text-[14px] text-text-3">/ {title}</span>
        </div>
      </div>

      <div className="mx-1 h-5 w-px bg-border" />

      {/* Статус: live/synth + режим + латентность — одним компактным блоком */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        <Pill tone={isLive === false ? "warn" : "bull"} dot>
          {isLive === false ? "SYNTH" : "LIVE"}
        </Pill>
        {regime && <Pill tone="info">{regime}</Pill>}
        {typeof latency === "number" && (
          <span className="num text-[13px] text-text-3" title={`Латентность последнего цикла: ${latency} ms`}>
            {latency} ms
          </span>
        )}
      </div>

      {/* Right cluster */}
      <div className="flex items-center gap-2.5">
        <div
          className="flex items-center gap-1.5 text-text-3"
          title={`Следующий авто-цикл через ${fmtCountdown(countdown)} · интервал планировщика 15 минут`}
        >
          <Radio className="size-3.5" strokeWidth={1.8} />
          <span className="num text-[14px]">{fmtCountdown(countdown)}</span>
          <span className="text-[13px] uppercase tracking-[0.12em] text-text-3">до цикла</span>
        </div>
        <button
          onClick={onOpenSettings}
          aria-label="Настройки и фильтры сигналов"
          className="hoverable pressable flex size-8 items-center justify-center rounded-md border border-border-strong bg-surface2 text-text-2 hover:text-text-1"
        >
          <Settings2 className="size-4" strokeWidth={1.9} />
        </button>
        {showRun ? (
          <button
            onClick={onRun}
            disabled={running}
            className="hoverable pressable flex h-8 items-center gap-2 rounded-md border border-[rgba(91,141,238,0.5)] bg-accent px-3 text-[14px] font-semibold text-white hover:bg-[#6d9bf3] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {running ? (
              <span className="size-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            ) : (
              <Play className="size-3.5" fill="currentColor" strokeWidth={0} />
            )}
            {running ? "Цикл выполняется…" : "Запустить цикл"}
            {!running && <Kbd>R</Kbd>}
          </button>
        ) : (
          <button
            onClick={onClearHistory}
            aria-label="Очистить всю историю исследований"
            title="Очистить всю историю исследований"
            className="hoverable pressable flex size-8 items-center justify-center rounded-md border border-border-strong bg-surface2 text-text-3 hover:border-[rgba(245,101,101,0.5)] hover:text-bear"
          >
            <Eraser className="size-4" strokeWidth={1.9} />
          </button>
        )}
      </div>
    </header>
  );
}
