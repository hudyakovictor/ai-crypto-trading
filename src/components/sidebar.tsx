"use client";

import React from "react";
import {
  Brain,
  CircleHelp,
  Crosshair,
  FlaskConical,
  Grid3x3,
  History,
  Layers,
  LayoutDashboard,
  Sparkles,
} from "lucide-react";

export type ViewKey =
  | "overview"
  | "combinations"
  | "heatmap"
  | "ledger"
  | "learning"
  | "walkforward"
  | "edge"
  | "copilot";

export const VIEWS: { key: ViewKey; num: string; label: string; short: string; icon: React.ElementType }[] = [
  { key: "overview", num: "1", label: "Обзор · Command Deck", short: "Обзор", icon: LayoutDashboard },
  { key: "combinations", num: "2", label: "Комбинации · 100 на актив", short: "Комбо", icon: Layers },
  { key: "heatmap", num: "3", label: "Хитмап · матрица сигналов", short: "Хитмап", icon: Grid3x3 },
  { key: "ledger", num: "4", label: "Журнал · гипотезы и исходы", short: "Журнал", icon: History },
  { key: "learning", num: "5", label: "Обучение · веса категорий", short: "Обучение", icon: Brain },
  { key: "walkforward", num: "6", label: "Walk-Forward · честный тест", short: "Тест", icon: FlaskConical },
  { key: "edge", num: "7", label: "Edge Lab · путь к $15 000", short: "Edge", icon: Crosshair },
  { key: "copilot", num: "8", label: "AI Копилот · аналитик", short: "AI", icon: Sparkles },
];

export function Sidebar({
  active,
  onSelect,
  onHelp,
}: {
  active: ViewKey;
  onSelect: (v: ViewKey) => void;
  onHelp: () => void;
}) {
  return (
    <nav
      aria-label="Основная навигация"
      className="fixed inset-y-0 left-0 z-40 flex w-[72px] flex-col items-center border-r border-border bg-surface py-2.5"
    >
      <div className="mb-2 flex size-10 items-center justify-center rounded-[10px] border border-[rgba(91,141,238,0.45)] bg-accent-dim">
        <span className="num text-[15px] font-bold tracking-tight text-accent">Q</span>
      </div>
      <div className="h-px w-8 bg-border" />

      <div className="mt-2 flex flex-1 flex-col items-center gap-1">
        {VIEWS.map((v) => {
          const isActive = v.key === active;
          const Icon = v.icon;
          return (
            <button
              key={v.key}
              onClick={() => onSelect(v.key)}
              aria-label={v.label}
              aria-current={isActive ? "page" : undefined}
              className={`hoverable pressable relative flex w-[62px] flex-col items-center gap-1 rounded-[9px] py-1.5 ${
                isActive ? "bg-surface3" : "hover:bg-surface2"
              }`}
            >
              {isActive && (
                <span className="absolute left-0 top-1/2 h-[22px] w-[2.5px] -translate-y-1/2 rounded-r bg-accent" />
              )}
              <Icon
                className="size-[18px]"
                strokeWidth={isActive ? 2.1 : 1.7}
                style={{ color: isActive ? "var(--text-1)" : "var(--text-3)" }}
              />
              <span
                className={`text-[12px] font-semibold leading-none tracking-wide ${
                  isActive ? "text-text-1" : "text-text-3"
                }`}
              >
                {v.short}
              </span>
            </button>
          );
        })}
      </div>

      <button
        onClick={onHelp}
        aria-label="Горячие клавиши"
        className="hoverable pressable flex w-[62px] flex-col items-center gap-1 rounded-[9px] py-1.5 hover:bg-surface2"
      >
        <CircleHelp className="size-[18px] text-text-3" strokeWidth={1.7} />
        <span className="text-[12px] font-semibold text-text-3">Ключи</span>
      </button>
    </nav>
  );
}
