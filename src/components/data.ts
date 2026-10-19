"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface ApiState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
  updatedAt: number | null;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    throw new Error(`HTTP ${res.status}: нечитаемый ответ сервера`);
  }
  const body = json as { success?: boolean; error?: string; message?: string } & T;
  if (!res.ok || body.success === false) {
    throw new Error(body.error || body.message || `HTTP ${res.status}`);
  }
  return body;
}

/** Потолок экспоненциального backoff: во сколько раз реже опрашивать падающий эндпоинт. */
const MAX_BACKOFF = 8;

/**
 * Минимальный клиент для read-only и поллинговых эндпоинтов лаборатории.
 *
 * Что исправлено относительно прежней версии:
 *  1. **Гонка ответов.** Каждый запрос получает порядковый номер, а прошлый
 *     прерывается через AbortController. Раньше медленный ответ, пришедший
 *     позже быстрого, перезаписывал свежие данные — дашборд «откатывался» в
 *     прошлое на глазах у пользователя.
 *  2. **Поллинг в скрытой вкладке.** Вкладки, которые никто не смотрит, больше
 *     не долбят сервер каждые 20 секунд; при возврате делается свежий запрос.
 *  3. **Backoff при авариях.** Серия ошибок увеличивает интервал опроса
 *     (×2, ×4, … до ×8), а не повторяет заведомо падающий запрос без остановки.
 *  4. **loading для отключённого URL.** Если url === null, состояние не «вечно
 *     грузится», а честно «нет данных» — иначе экран показывал скелетон, пока
 *     лаборатория не инициализирована.
 */
export function useApi<T>(url: string | null, pollMs = 0): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(url !== null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const mounted = useRef(true);
  /** Номер последнего запроса: устаревшие ответы отбрасываются. */
  const seq = useRef(0);
  /**
   * Смена URL сбрасывает состояние во время рендера (официальный паттерн React
   * «корректировка состояния при изменении пропсов»), а не через setState в
   * эффекте: иначе данные прошлого актива успевали отрисоваться под новым.
   */
  const [prevUrl, setPrevUrl] = useState(url);
  if (url !== prevUrl) {
    setPrevUrl(url);
    setData(null);
    setError(null);
    setUpdatedAt(null);
    setLoading(url !== null);
  }
  const abortRef = useRef<AbortController | null>(null);
  const failures = useRef(0);
  /** До какого момента автополлинг paused (backoff после ошибок). */
  const pausedUntil = useRef(0);

  const refresh = useCallback(async () => {
    if (!url) return;
    const mine = ++seq.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    // setLoading(true) здесь не вызывается: первый запрос уже помечен как
    // loading начальным состоянием, а повторные опросы работают в режиме
    // stale-while-revalidate — скелетон не мигает каждые 20 секунд.
    try {
      const body = await fetchJson<T>(url, { signal: controller.signal });
      if (!mounted.current || mine !== seq.current) return;
      failures.current = 0;
      pausedUntil.current = 0;
      setData(body);
      setError(null);
      setUpdatedAt(Date.now());
    } catch (err) {
      if (!mounted.current || mine !== seq.current) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      failures.current += 1;
      const multiplier = Math.min(MAX_BACKOFF, Math.pow(2, failures.current - 1));
      pausedUntil.current = Date.now() + pollMs * multiplier;
      setError(err instanceof Error ? err.message : "Неизвестная ошибка");
    } finally {
      if (mounted.current && mine === seq.current) setLoading(false);
    }
  }, [url, pollMs]);

  useEffect(() => {
    mounted.current = true;
    // Единственный setState в refresh() происходит уже после await (в catch/finally),
    // то есть не синхронно с телом эффекта: правило react-hooks/set-state-in-effect
    // не моделирует границу await для try/catch и срабатывает формально.
    // Это штатный паттерн «запрос при монтировании и по интервалу».
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();

    if (pollMs <= 0) {
      return () => {
        mounted.current = false;
        abortRef.current?.abort();
      };
    }

    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (Date.now() < pausedUntil.current) return;
      void refresh();
    }, pollMs);

    const onVisible = () => {
      if (typeof document !== "undefined" && !document.hidden) void refresh();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible);
    }

    return () => {
      mounted.current = false;
      clearInterval(id);
      abortRef.current?.abort();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible);
      }
    };
  }, [refresh, pollMs]);

  return { data, error, loading, refresh, updatedAt };
}

export async function postJson<T>(url: string, body?: unknown): Promise<T> {
  return fetchJson<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
}

/* ================= Tiny toast bus ================= */

export type ToastTone = "ok" | "err" | "info";
export interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  text?: string;
}

type Listener = (t: ToastItem) => void;
const listeners = new Set<Listener>();
let toastId = 0;

export function toast(tone: ToastTone, title: string, text?: string) {
  const item: ToastItem = { id: ++toastId, tone, title, text };
  listeners.forEach((l) => l(item));
}

export function subscribeToasts(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
