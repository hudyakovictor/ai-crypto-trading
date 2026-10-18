"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Info, Rocket, XCircle } from "lucide-react";
import { Sidebar, VIEWS, type ViewKey } from "./sidebar";
import { Topbar } from "./topbar";
import { Kbd } from "./ui";
import { postJson, subscribeToasts, toast, useApi, type ToastItem } from "./data";
import type { CycleApiResult } from "@/lib/ui-types";
import { OverviewView } from "./views/overview";
import { CombinationsView } from "./views/combinations";
import { HeatmapView } from "./views/heatmap-view";
import { LedgerView } from "./views/ledger-view";
import { LearningView } from "./views/learning-view";
import { WalkForwardView } from "./views/walkforward-view";
import { EdgeView } from "./views/edge-view";
import { CopilotView } from "./views/copilot-view";
import { SettingsDrawer } from "./settings-drawer";
import { AiDockProvider } from "./ai-dock";

const VIEW_TITLES: Record<ViewKey, string> = {
  overview: "Обзор",
  combinations: "Комбинации",
  heatmap: "Хитмап",
  ledger: "Журнал",
  learning: "Обучение",
  walkforward: "Честный тест",
  edge: "Цель $15 000",
  copilot: "AI Копилот",
};

/* ---------------- Toaster ---------------- */

function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    return subscribeToasts((t) => {
      setItems((prev) => [...prev, t].slice(-4));
      setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== t.id)), 5200);
    });
  }, []);

  if (items.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-[100] flex w-[340px] flex-col gap-2">
      {items.map((t) => {
        const color = t.tone === "ok" ? "var(--green)" : t.tone === "err" ? "var(--red)" : "var(--blue)";
        const Icon = t.tone === "ok" ? CheckCircle2 : t.tone === "err" ? XCircle : Info;
        return (
          <div
            key={t.id}
            className="anim-fade-up rounded-lg border border-border-strong bg-surface3 p-3 shadow-[0_12px_40px_rgba(0,0,0,0.6)]"
          >
            <div className="flex items-center gap-2">
              <Icon className="size-4 shrink-0" style={{ color }} strokeWidth={2} />
              <span className="text-[14px] font-semibold text-text-1">{t.title}</span>
            </div>
            {t.text && <p className="num mt-1 break-words pl-6 text-[13px] leading-snug text-text-3">{t.text}</p>}
          </div>
        );
      })}
    </div>
  );
}

/* ---------------- Shortcuts overlay ---------------- */

function ShortcutsOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-[rgba(3,5,9,0.72)] backdrop-blur-sm" onClick={onClose}>
      <div className="anim-fade-up w-[380px] rounded-[12px] border border-border-strong bg-surface p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-3 text-[15px] font-semibold text-text-1">Горячие клавиши</h3>
        <div className="space-y-1.5">
          {[
            ["1 – 7", "Переключение разделов"],
            ["R", "Запустить исследовательский цикл"],
            ["S", "Настройки и фильтры сигналов"],
            ["?", "Эта справка"],
            ["Esc", "Закрыть справку"],
            ["Tab / Enter", "Навигация и активация контролов"],
          ].map(([k, d]) => (
            <div key={k} className="flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-surface2">
              <span className="text-[14px] text-text-2">{d}</span>
              <Kbd>{k}</Kbd>
            </div>
          ))}
        </div>
        <p className="mt-3 border-t border-border pt-3 text-[13px] leading-relaxed text-text-3">
          Все числовые ячейки, точки хитмапа и бары показывают детальный breakdown по hover.
        </p>
      </div>
    </div>
  );
}

/* ---------------- First-run initializer ---------------- */

function InitScreen({ onReady }: { onReady: () => void }) {
  const [phase, setPhase] = useState<"idle" | "seeding" | "cycling" | "error">("idle");
  const [err, setErr] = useState("");

  const init = useCallback(async () => {
    setPhase("seeding");
    setErr("");
    try {
      await postJson("/api/research/seed");
    } catch (e) {
      // Seed may report "already populated" as success; hard errors surface here
      console.warn("seed note:", e);
    }
    setPhase("cycling");
    try {
      await postJson("/api/research/cycle", { isManual: true });
      toast("ok", "Лаборатория инициализирована", "Первый цикл завершён: связки оценены, отбор решил планировщик.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Ошибка запуска цикла");
      setPhase("error");
      return;
    }
    onReady();
  }, [onReady]);

  useEffect(() => {
    void init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="grid min-h-screen place-items-center">
      <div className="anim-fade-up flex w-[380px] flex-col items-center gap-4 rounded-[14px] border border-border bg-surface p-8 text-center">
        <div className="flex size-12 items-center justify-center rounded-[12px] border border-[rgba(91,141,238,0.4)] bg-accent-dim">
          <Rocket className="size-5 text-accent" strokeWidth={1.8} />
        </div>
        <div>
          <h1 className="text-[15px] font-semibold text-text-1">OKX Quant Hypotheses Lab</h1>
          <p className="mt-1 text-[14px] leading-relaxed text-text-3">
            Поднимаем исследовательскую инфраструктуру: сиды истории, веса обучения и первый цикл — вселенная, связки, отбор.
          </p>
        </div>
        {phase === "error" ? (
          <>
            <p className="num text-[13px] text-bear">{err}</p>
            <button
              onClick={() => void init()}
              className="hoverable pressable rounded-md border border-[rgba(91,141,238,0.5)] bg-accent px-4 py-2 text-[14px] font-semibold text-white"
            >
              Повторить инициализацию
            </button>
          </>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <span className="size-4 animate-spin rounded-full border-2 border-white/20 border-t-accent" />
            <span className="num text-[13px] text-text-3">
              {phase === "seeding" ? "Восстановление истории гипотез…" : "Первый цикл: OKX → вселенная → связки → отбор планировщика…"}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- Shell ---------------- */

export function AppShell() {
  const [view, setView] = useState<ViewKey>("overview");
  const [running, setRunning] = useState(false);
  const [help, setHelp] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [booted, setBooted] = useState(false);
  const [initChecked, setInitChecked] = useState(false);
  /** Актив, по которому экран «Комбинации» считает связки. Якорь вселенной всегда валиден. */
  const [asset, setAsset] = useState<string>("BTC-USDT");
  const needsInitRef = useRef(false);

  const status = useApi<import("@/lib/ui-types").StatusResponse>("/api/research/status", 20000);
  const heatmap = useApi<import("@/lib/ui-types").HeatmapResponse>(booted ? "/api/research/heatmap" : null, 90000);
  const combos = useApi<import("@/lib/ui-types").CombinationsResponse>(
    booted ? `/api/research/combinations?symbol=${encodeURIComponent(asset)}` : null
  );
  const ledger = useApi<import("@/lib/ui-types").LedgerResponse>(booted ? "/api/research/ledger" : null, 30000);
  const learning = useApi<import("@/lib/ui-types").LearningResponse>(booted ? "/api/research/learning" : null, 45000);
  const walkforward = useApi<import("@/lib/ui-types").WalkForwardResponse>(booted ? "/api/research/walkforward" : null, 60000);
  const edge = useApi<import("@/lib/ui-types").EdgeResponse>(booted ? "/api/research/edge" : null, 45000);
  const ai = useApi<import("@/lib/ui-types").AiStatusResponse>("/api/research/ai");

  // Boot gate: decide whether the lab needs first-run seeding
  useEffect(() => {
    if (initChecked || status.loading) return;
    setInitChecked(true);
    const stats = status.data?.stats;
    // Assets survive a history reset, so they also mark the lab as initialized.
    // Without this guard every page reload after reset would seed the demo history again.
    const hasInitializedLab = (status.data?.assets?.length ?? 0) > 0;
    const empty = !status.data || (!hasInitializedLab && (stats?.totalResolved ?? 0) === 0 && (stats?.activeHypothesesCount ?? 0) === 0);
    needsInitRef.current = empty;
    if (!empty) setBooted(true);
  }, [status, initChecked]);

  const refreshAll = useCallback(() => {
    void Promise.allSettled([
      status.refresh(),
      heatmap.refresh(),
      combos.refresh(),
      ledger.refresh(),
      learning.refresh(),
      walkforward.refresh(),
      edge.refresh(),
    ]);
  }, [status, heatmap, combos, ledger, learning, walkforward, edge]);

  const runCycle = useCallback(async () => {
    if (running) return;
    setRunning(true);
    toast("info", "Цикл запущен", "OKX → вселенная → связки → решение планировщика → прогнозы");
    try {
      const r = await postJson<{ result: CycleApiResult }>("/api/research/cycle", { isManual: true });
      const res = r.result;
      const universeNote = res.universe?.length
        ? `вселенная ${res.trackedCount ?? res.universe.length} пар`
        : `${res.combinationsGenerated} связок`;
      const d = res.planner;
      toast(
        "ok",
        `Цикл завершён · ${res.marketRegime.replace(/_/g, " ")}`,
        d
          ? `${universeNote} · ${d.mode === "ai" ? "решил ИИ" : d.mode === "fallback" ? "запасное правило" : "правило EVS"}: ${d.picks.length} из ${d.offered} кандидатов (потолок ${d.ceiling}) · ${res.latencyMs} ms`
          : `${universeNote} · ${res.combinationsGenerated} связок · ${res.hypothesesCreated} гипотез · ${res.latencyMs} ms`
      );
    } catch (e) {
      toast("err", "Ошибка цикла", e instanceof Error ? e.message : "неизвестно");
    } finally {
      setRunning(false);
      await refreshAll();
    }
  }, [running, refreshAll]);

  const clearHistory = useCallback(async () => {
    setClearing(true);
    try {
      const r = await postJson<{ message: string }>("/api/research/reset", { confirm: true });
      toast("ok", "История очищена", r.message);
      setClearOpen(false);
      await refreshAll();
    } catch (e) {
      toast("err", "Не удалось очистить", e instanceof Error ? e.message : "");
    } finally {
      setClearing(false);
    }
  }, [refreshAll]);

  useEffect(() => {
    runRef.current = () => {
      if (!document.hidden) void runCycle();
    };
  }, [runCycle]);

  // Countdown to next scheduled run — fires the autonomous cycle at zero
  const [countdown, setCountdown] = useState(900);
  const runRef = useRef<() => void>(() => {});
  useEffect(() => {
    setCountdown(status.data?.scheduler.secondsToNextRun ?? 900);
  }, [status.data?.scheduler.secondsToNextRun, status.updatedAt]);
  useEffect(() => {
    const id = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          runRef.current();
          return 900;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key >= "1" && e.key <= "8") {
        const v = VIEWS[Number(e.key) - 1];
        if (v) setView(v.key);
      } else if (e.key.toLowerCase() === "r" || e.key.toLowerCase() === "к") {
        void runCycle();
      } else if (e.key.toLowerCase() === "s" || e.key.toLowerCase() === "ы") {
        setSettingsOpen((v) => !v);
      } else if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        setHelp((h) => !h);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [runCycle]);

  const viewEl = useMemo(() => {
    switch (view) {
      case "overview":
        return (
          <OverviewView
            status={status}
            heatmap={heatmap}
            combos={combos}
            ledger={ledger}
            learning={learning}
            walkforward={walkforward}
            asset={asset}
            onSelectAsset={setAsset}
            onOpenView={setView}
          />
        );
      case "combinations":
        return <CombinationsView combos={combos} asset={asset} onSelectAsset={setAsset} />;
      case "heatmap":
        return <HeatmapView heatmap={heatmap} />;
      case "ledger":
        return <LedgerView ledger={ledger} />;
      case "learning":
        return <LearningView learning={learning} onRetrained={refreshAll} />;
      case "walkforward":
        return <WalkForwardView wf={walkforward} />;
      case "edge":
        return <EdgeView edge={edge} />;
      case "copilot":
        return <CopilotView ai={ai} />;
    }
  }, [view, status, heatmap, combos, ledger, learning, walkforward, edge, ai, asset, refreshAll]);


  if (initChecked && needsInitRef.current && !booted) {
    return (
      <>
        <InitScreen
          onReady={() => {
            setBooted(true);
            needsInitRef.current = false;
          }}
        />
        <Toaster />
      </>
    );
  }

  return (
    <AiDockProvider onApplied={refreshAll}>
    <div className="relative z-[1] min-h-screen">
      <Sidebar active={view} onSelect={setView} onHelp={() => setHelp(true)} />
      <div className="pl-[72px]">
        <Topbar
          title={VIEW_TITLES[view]}
          status={status.data}
          running={running}
          onRun={() => void runCycle()}
          onOpenSettings={() => setSettingsOpen(true)}
          onClearHistory={() => setClearOpen(true)}
          countdown={countdown}
          showRun={view === "overview"}
        />
        <main key={view}>{viewEl}</main>
        <footer className="flex h-7 items-center border-t border-border px-4">
          <span className="text-[12.5px] text-text-3">
            Исследовательский инструмент. Не является финансовой рекомендацией.
          </span>
        </footer>
      </div>
      <ShortcutsOverlay open={help} onClose={() => setHelp(false)} />
      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} onDataChanged={refreshAll} />

      {clearOpen && (
        <div className="fixed inset-0 z-[97] flex items-center justify-center bg-[rgba(4,8,14,0.7)] backdrop-blur-sm" onClick={() => setClearOpen(false)}>
          <div className="anim-fade-up w-[440px] rounded-[12px] border border-[rgba(245,101,101,0.4)] bg-surface p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-[16px] font-bold text-text-1">Очистить всю историю?</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-text-2">
              Будут удалены все прогнозы, гипотезы, комбинации, AI-разборы и журналы. Веса обучения
              вернутся к приорам 1.00. Фильтры и настройки сохранятся. Действие необратимо.
            </p>
            <div className="mt-5 flex gap-2">
              <button
                onClick={() => void clearHistory()}
                disabled={clearing}
                className="hoverable pressable flex flex-1 items-center justify-center gap-2 rounded-md border border-[rgba(245,101,101,0.6)] bg-bear px-4 py-2.5 text-[13px] font-bold text-white disabled:opacity-60"
              >
                {clearing ? "Очищаю…" : "Да, очистить всё"}
              </button>
              <button
                onClick={() => setClearOpen(false)}
                className="hoverable pressable rounded-md border border-border-strong bg-surface2 px-4 py-2.5 text-[13px] font-semibold text-text-2 hover:text-text-1"
              >
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}

      <Toaster />
    </div>
    </AiDockProvider>
  );
}
