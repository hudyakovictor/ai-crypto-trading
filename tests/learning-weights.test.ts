import { describe, expect, it } from "vitest";
import { smoothedWeight } from "@/lib/quant/learning-loop";
import { CATEGORY_KEYS } from "@/lib/types";

/**
 * Байесовское сглаживание веса категории.
 *
 * Пересчёт весов в лаборатории АБСОЛЮТНЫЙ: `rebuildFromHistory()` каждый раз
 * считает счётчики из всей истории заново, поэтому вес — чистая функция пары
 * (hits, n). Именно это свойство делает обучение идемпотентным: прежняя
 * инкрементальная схема прибавляла счётчики и при повторном прогоне той же
 * истории раздувала totalSamples в десятки раз.
 */
describe("smoothedWeight", () => {
  it("без данных вес равен 1: категория не лучше и не хуже базовой ставки", () => {
    expect(smoothedWeight(0, 0)).toBe(1);
  });

  it("вес ограничен диапазоном [0.25, 2.5] на любых выборках", () => {
    for (const n of [0, 1, 5, 20, 100, 10_000]) {
      for (const hits of [0, Math.floor(n / 2), n]) {
        const w = smoothedWeight(hits, n);
        expect(w).toBeGreaterThanOrEqual(0.25);
        expect(w).toBeLessThanOrEqual(2.5);
      }
    }
  });

  it("монотонен по числу попаданий при равной выборке", () => {
    const n = 40;
    let prev = -Infinity;
    for (let hits = 0; hits <= n; hits += 4) {
      const w = smoothedWeight(hits, n);
      expect(w).toBeGreaterThanOrEqual(prev);
      prev = w;
    }
  });

  it("маленькая выборка не уводит вес далеко от 1 (приор сильнее)", () => {
    // 3 попадания из 3 — 100% hit rate, но выборка ничтожна.
    expect(smoothedWeight(3, 3)).toBeLessThan(1.6);
    // Те же 100% на большой выборке — вес заметно выше.
    expect(smoothedWeight(100, 100)).toBeGreaterThan(smoothedWeight(3, 3));
  });

  it("провальная категория прижимается к полу, а не обнуляется", () => {
    expect(smoothedWeight(0, 500)).toBe(0.25);
  });

  it("идемпотентность: одна и та же история даёт один и тот же вес", () => {
    const first = smoothedWeight(17, 30);
    const second = smoothedWeight(17, 30);
    expect(first).toBe(second);
    // Иначе говоря, повторный пересчёт не «накручивает» счётчики.
    expect(smoothedWeight(17 * 2, 30 * 2)).not.toBe(first);
  });

  it("результат — число с тремя знаками, пригодное для записи в БД", () => {
    const w = smoothedWeight(7, 19);
    expect(Number.isFinite(w)).toBe(true);
    expect(String(w).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(3);
  });
});

describe("контракт категорий", () => {
  it("категорий ровно 15 и они уникальны", () => {
    expect(CATEGORY_KEYS.length).toBe(15);
    expect(new Set(CATEGORY_KEYS).size).toBe(15);
  });
});
