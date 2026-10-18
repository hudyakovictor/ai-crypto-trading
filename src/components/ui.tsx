"use client";

import React, { useCallback, useRef, useState } from "react";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Loader2, Minus } from "lucide-react";

/* ================= Panel ================= */

export function Panel({
  title,
  sub,
  actions,
  children,
  className = "",
  bodyClassName = "",
  pad = true,
}: {
  title?: React.ReactNode;
  sub?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  pad?: boolean;
}) {
  return (
    <section
      className={`relative flex min-h-0 flex-col panel-lift rounded-[10px] border border-border bg-surface ${className}`}
    >
      {title !== undefined && (
        <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
          <div className="flex min-w-0 items-baseline gap-2.5">
            <h2 className="truncate text-[13px] font-bold uppercase tracking-[0.12em] text-text-1">
              {title}
            </h2>
            {sub && <span className="truncate text-[13px] text-text-3">{sub}</span>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={`min-h-0 flex-1 ${pad ? "p-4" : ""} ${bodyClassName}`}>{children}</div>
    </section>
  );
}

/* ================= Pill ================= */

type Tone = "bull" | "bear" | "info" | "warn" | "accent" | "neutral";

const TONE_STYLES: Record<Tone, { color: string; background: string; borderColor: string }> = {
  bull: { color: "var(--green)", background: "var(--green-dim)", borderColor: "rgba(34,211,160,0.22)" },
  bear: { color: "var(--red)", background: "var(--red-dim)", borderColor: "rgba(245,101,101,0.22)" },
  info: { color: "var(--blue)", background: "var(--blue-dim)", borderColor: "rgba(96,165,250,0.25)" },
  warn: { color: "var(--amber)", background: "var(--amber-dim)", borderColor: "rgba(251,191,36,0.25)" },
  accent: { color: "var(--accent)", background: "var(--accent-dim)", borderColor: "rgba(91,141,238,0.3)" },
  neutral: {
    color: "var(--text-2)",
    background: "rgba(255,255,255,0.04)",
    borderColor: "rgba(255,255,255,0.08)",
  },
};

export function Pill({
  tone = "neutral",
  children,
  className = "",
  dot = false,
}: {
  tone?: Tone;
  children: React.ReactNode;
  className?: string;
  dot?: boolean;
}) {
  const s = TONE_STYLES[tone];
  return (
    <span
      className={`inline-flex h-5 items-center gap-1.5 rounded-[5px] border px-1.5 text-[13px] font-medium leading-none ${className}`}
      style={{ color: s.color, background: s.background, borderColor: s.borderColor }}
    >
      {dot && <span className="size-[5px] rounded-full pulse-dot" style={{ background: s.color }} />}
      {children}
    </span>
  );
}

/* ================= Delta (weight change arrows) ================= */

export function Delta({
  value,
  digits = 2,
  suffix = "",
  invert = false,
  className = "",
}: {
  value: number;
  digits?: number;
  suffix?: string;
  invert?: boolean;
  className?: string;
}) {
  const positive = value > 0.0005;
  const negative = value < -0.0005;
  const good = invert ? negative : positive;
  const bad = invert ? positive : negative;
  const color = good ? "var(--green)" : bad ? "var(--red)" : "var(--text-3)";
  const Icon = positive ? ArrowUpRight : negative ? ArrowDownRight : Minus;
  return (
    <span
      className={`num inline-flex items-center gap-0.5 text-[14px] ${className}`}
      style={{ color }}
      title={`Δ ${value >= 0 ? "+" : ""}${value.toFixed(digits)}${suffix}`}
    >
      <Icon className="size-3" strokeWidth={2.2} />
      {positive ? "+" : negative ? "−" : ""}
      {Math.abs(value).toFixed(digits)}
      {suffix}
    </span>
  );
}

/* ================= Keyboard hint ================= */

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-border-strong bg-surface2 px-1 font-mono text-[13px] font-medium leading-none text-text-3">
      {children}
    </kbd>
  );
}

/* ================= Tooltip → отключена по требованию UX =================
 * Всплывающие подсказки убраны: `Tip` и `TipRow` сохранены как no-op
 * пасsthrough-обёртки, чтобы не трогать сотни мест вызова.
 * Вся информация теперь видима прямо в интерфейсе (гид-шаги, сноски). */

export function Tip({
  label,
  children,
  className = "",
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  align?: "center" | "start" | "end";
  side?: "top" | "right";
}) {
  return <div className={className}>{children}</div>;
}

/* eslint-disable @typescript-eslint/no-unused-vars */
function TipLegacyNeverUsed({
  label,
  children,
  className = "",
  align = "center",
  side = "top",
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  align?: "center" | "start" | "end";
  side?: "top" | "right";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; below: boolean } | null>(null);

  const show = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (side === "right") {
      setPos({ x: r.right + 10, y: r.top + r.height / 2, below: false });
      return;
    }
    const cx = align === "center" ? r.left + r.width / 2 : align === "start" ? r.left : r.right;
    setPos({ x: cx, y: r.top, below: r.top < 130 });
  }, [align, side]);

  const transform =
    side === "right"
      ? "translate(0, -50%)"
      : `translate(${align === "center" ? "-50%" : align === "start" ? "0" : "-100%"}, ${pos?.below ? "0" : "-100%"})`;

  return (
    <div
      ref={ref}
      className={`relative ${className}`}
      onMouseEnter={show}
      onMouseLeave={() => setPos(null)}
      onFocus={show}
      onBlur={() => setPos(null)}
    >
      {children}
      {pos && (
        <div
          role="tooltip"
          className="pointer-events-none fixed z-[90] w-max max-w-[280px] rounded-md border border-border-strong bg-surface3 px-2.5 py-2 text-left shadow-[0_8px_28px_rgba(0,0,0,0.55)] anim-tick"
          style={{
            left: pos.x,
            top: side === "right" ? pos.y : pos.below ? pos.y + 22 : pos.y - 8,
            transform,
          }}
        >
          {label}
        </div>
      )}
    </div>
  );
}

export function TipRow({ k, v, tone }: { k: string; v: React.ReactNode; tone?: Tone }) {
  return (
    <div className="flex items-center justify-between gap-6 py-[1px] text-[13px]">
      <span className="text-text-3">{k}</span>
      <span className="num" style={{ color: tone ? TONE_STYLES[tone].color : "var(--text-1)" }}>
        {v}
      </span>
    </div>
  );
}

/* ================= Loading / Empty / Error ================= */

export function SkeletonRows({ rows = 5, height = 34 }: { rows?: number; height?: number }) {
  return (
    <div className="flex flex-col gap-2 p-1">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton w-full" style={{ height, opacity: 1 - i * 0.09 }} />
      ))}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  text,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  text: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-[140px] flex-col items-center justify-center gap-2 px-6 text-center">
      <div className="flex size-10 items-center justify-center rounded-[10px] border border-border bg-surface2 text-text-3">
        {icon}
      </div>
      <p className="text-[15px] font-medium text-text-1">{title}</p>
      <p className="max-w-[300px] text-[14px] leading-relaxed text-text-3">{text}</p>
      {action && <div className="mt-1.5">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex h-full min-h-[140px] flex-col items-center justify-center gap-2 px-6 text-center">
      <div className="flex size-10 items-center justify-center rounded-[10px] border border-[rgba(245,101,101,0.25)] bg-bear-dim text-bear">
        <AlertTriangle className="size-4.5" strokeWidth={1.8} />
      </div>
      <p className="text-[15px] font-medium text-text-1">Сбой загрузки данных</p>
      <p className="num max-w-[320px] text-[13px] leading-relaxed text-text-3">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="hoverable pressable mt-1 rounded-md border border-border-strong bg-surface2 px-3 py-1.5 text-[14px] font-medium text-text-1 hover:border-accent hover:text-accent"
        >
          Повторить
        </button>
      )}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-[14px] text-text-3">
      <Loader2 className="size-3.5 animate-spin" />
      {label}
    </span>
  );
}

/* ================= EVS bar ================= */

export function MeterBar({
  value,
  max = 100,
  tone,
  height = 4,
  className = "",
}: {
  value: number;
  max?: number;
  tone?: Tone;
  height?: number;
  className?: string;
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const color = tone ? TONE_STYLES[tone].color : "var(--accent)";
  return (
    <div
      className={`w-full overflow-hidden rounded-full bg-[rgba(255,255,255,0.05)] ${className}`}
      style={{ height }}
    >
      <div
        className="h-full rounded-full transition-[width] duration-150 ease-out"
        style={{ width: `${pct}%`, background: color }}
      />
    </div>
  );
}

export function evsTone(score: number): Tone {
  if (score >= 75) return "bull";
  if (score >= 60) return "accent";
  if (score >= 45) return "warn";
  return "neutral";
}

/** Continuous heat intensity color for a -1..1 score. */
export function heatColor(score: number, alpha = 1): string {
  const a = Math.min(1, Math.abs(score)) * alpha;
  if (score > 0.04) return `rgba(34, 211, 160, ${(0.06 + a * 0.82).toFixed(3)})`;
  if (score < -0.04) return `rgba(245, 101, 101, ${(0.06 + a * 0.82).toFixed(3)})`;
  return `rgba(96, 165, 250, ${(0.05 + Math.abs(score) * 12 * 0.5).toFixed(3)})`;
}

export function scoreTextTone(score: number): Tone {
  if (score > 0.04) return "bull";
  if (score < -0.04) return "bear";
  return "info";
}

/* ================= ViewGuide — сворачиваемая подсказка по экрану =================
 * По умолчанию одна спокойная строка: акцент + AI-действие + кнопка «Как читать».
 * Шаги раскрываются только по клику и не крадут первый экран. */

const GUIDE_STORAGE = "ql.guide.open";

function guideInitiallyOpen(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(GUIDE_STORAGE) === "1";
}

export function ViewGuide({
  accent,
  steps,
  note,
  right,
  className = "",
}: {
  accent: string;
  steps: { t: string; d: string }[];
  note?: string;
  right?: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(guideInitiallyOpen);

  const toggle = () => {
    setOpen((o) => {
      window.localStorage.setItem(GUIDE_STORAGE, o ? "0" : "1");
      return !o;
    });
  };

  return (
    <aside className={`rounded-[10px] border border-border bg-surface anim-fade-up ${className}`}>
      <div className="flex h-[42px] items-center gap-3 px-4">
        <span className="text-[13.5px] font-semibold tracking-wide text-text-2">{accent}</span>
        <button
          onClick={toggle}
          aria-expanded={open}
          className="hoverable pressable rounded-md border border-border-strong bg-surface2 px-2.5 py-1 text-[13px] font-medium text-text-3 hover:text-text-1"
        >
          {open ? "Скрыть" : "Как читать"}
        </button>
        <div className="ml-auto flex shrink-0 items-center gap-2">{right}</div>
      </div>
      {open && (
        <div className="grid gap-x-5 gap-y-3 border-t border-border px-4 py-3.5 md:grid-cols-3">
          {steps.map((s, i) => (
            <div key={i} className="flex items-start gap-2.5">
              <span className="num mt-px flex size-5 shrink-0 items-center justify-center rounded-[6px] bg-surface3 text-[12.5px] font-bold text-accent">
                {i + 1}
              </span>
              <div className="min-w-0">
                <div className="text-[13px] font-semibold leading-snug text-text-1">{s.t}</div>
                <div className="mt-0.5 text-[13px] leading-snug text-text-3">{s.d}</div>
              </div>
            </div>
          ))}
          {note && (
            <p className="text-[13px] leading-snug text-text-3 md:col-span-3 md:border-t md:border-border md:pt-3">{note}</p>
          )}
        </div>
      )}
    </aside>
  );
}
