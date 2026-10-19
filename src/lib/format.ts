/**
 * Formatting helpers — client-safe, no imports.
 */

export function fmtPrice(v: number): string {
  if (!isFinite(v) || v === 0) return "—";
  if (v >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  if (v >= 100) return v.toFixed(2);
  if (v >= 1) return v.toFixed(2);
  if (v >= 0.01) return v.toFixed(4);
  return v.toFixed(6);
}

export function fmtUsd(v: number, signed = true): string {
  const sign = signed ? (v > 0 ? "+" : v < 0 ? "−" : "") : v < 0 ? "−" : "";
  const abs = Math.abs(v);
  return `${sign}$${abs.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

export function fmtPct(v: number, digits = 2, signed = true): string {
  const sign = signed && v > 0 ? "+" : "";
  return `${sign}${v.toFixed(digits)}%`;
}

export function fmtBps(v: number, signed = true): string {
  const sign = signed && v > 0 ? "+" : "";
  return `${sign}${v.toFixed(1)} bps`;
}

export function fmtSigned(v: number, digits = 3): string {
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}${Math.abs(v).toFixed(digits)}`;
}

export function fmtCompact(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toFixed(0);
}

export function timeAgo(iso: string | Date | null): string {
  if (!iso) return "—";
  const t = typeof iso === "string" ? new Date(iso) : iso;
  const diff = Date.now() - t.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "только что";
  if (min < 60) return `${min} мин назад`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.floor(h / 24);
  return `${d} д назад`;
}

export function fmtClock(iso: string | Date): string {
  const t = typeof iso === "string" ? new Date(iso) : iso;
  return t.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

export function fmtCountdown(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Short Russian labels for the 15 signal categories (heatmap headers). */
export const CATEGORY_SHORT: Record<string, string> = {
  price_returns: "PRC",
  volume_liquidity: "VOL",
  volatility_regime: "VLT",
  order_flow: "FLW",
  order_book_microstructure: "OBI",
  derivatives_positioning: "DRV",
  liquidations: "LIQ",
  cross_exchange_dispersion: "XCH",
  cross_asset_relationships: "XAS",
  market_breadth_rotation: "BRD",
  stablecoin_flow_proxies: "STB",
  on_chain_activity: "ONC",
  sentiment_attention: "SNT",
  time_calendar_session: "TME",
  anomaly_novelty: "ANM",
};

export const CATEGORY_RU: Record<string, string> = {
  price_returns: "Цена и доходности",
  volume_liquidity: "Объём и ликвидность",
  volatility_regime: "Волатильность и режим",
  order_flow: "Поток ордеров и CVD",
  order_book_microstructure: "Микроструктура стакана",
  derivatives_positioning: "Деривативы и фандинг",
  liquidations: "Ликвидации",
  cross_exchange_dispersion: "Межрыночная дисперсия",
  cross_asset_relationships: "Межассетные связи",
  market_breadth_rotation: "Ширина рынка",
  stablecoin_flow_proxies: "Потоки стейблкоинов",
  on_chain_activity: "Ончейн активность",
  sentiment_attention: "Сентимент и внимание",
  time_calendar_session: "Сессии и время",
  anomaly_novelty: "Аномалии и новизна",
};

export const REGIME_RU: Record<string, string> = {
  TRENDING_BULL: "Восходящий тренд",
  TRENDING_BEAR: "Нисходящий тренд",
  RANGING: "Боковик",
  VOLATILE: "Высокая волатильность",
  HIGH_VOLATILITY_CHOP: "Высоковолатильный пил",
  LOW_VOLATILITY_SQUEEZE: "Сжатие волатильности",
  LIQUIDITY_CRUNCH: "Дефицит ликвидности",
  NEUTRAL_CONSOLIDATION: "Нейтральная консолидация",
  // Строка-заполнитель для записей, у которых нет рыночного режима
  // (например, ручной пересчёт весов обучения).
  NO_REGIME: "—",
};

export const ERROR_RU: Record<string, { label: string; fix: string }> = {
  none: { label: "Без ошибки", fix: "—" },
  weak_signal: {
    label: "Слабый сигнал",
    fix: "Повысить порог EVS до ≥ 72 и требовать 3+ согласованных категорий",
  },
  wrong_sign: {
    label: "Неверный знак",
    fix: "Добавить VETO против толпы по funding-экстремумам",
  },
  wrong_horizon: {
    label: "Неверный горизонт",
    fix: "Расширить сетку горизонтов: 15m / 1h / 4h с отдельной статистикой",
  },
  regime_mismatch: {
    label: "Режим не совпал",
    fix: "Торговать методику только в её профильном режиме из Regime Matrix",
  },
  cost_drag: {
    label: "Издержки съели edge",
    fix: "Отсекать сигналы с ожидаемым ходом < 3× round-trip costs",
  },
  insufficient_liquidity: { label: "Нет ликвидности", fix: "Фильтр RVOL ≥ 1.4" },
  category_conflict: { label: "Конфликт категорий", fix: "Штраф за рассогласование > 30%" },
  external_event: { label: "Внешнее событие", fix: "Пауза вокруг макро-релизов" },
  data_gap: { label: "Разрыв данных", fix: "Пропускать цикл при quality < OK" },
};
