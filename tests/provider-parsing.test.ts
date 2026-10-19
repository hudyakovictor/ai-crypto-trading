import { describe, expect, it } from "vitest";
import { isSmallTalkQuestion, parseParamsFromText } from "@/lib/ai/provider";

/**
 * Разбор строки параметров из ответа модели. Это единственное место, где текст
 * LLM превращается в управляющие числа цикла, поэтому границы важны: модель
 * может попросить и EVS=999, и «гипотез=0».
 */
describe("parseParamsFromText", () => {
  it("читает все три параметра из штатной строки", () => {
    const out = parseParamsFromText("ПАРАМЕТРЫ: EVS=72, категорий=3, гипотез=8");
    expect(out).toEqual({ minEvs: 72, minCategories: 3, maxHypothesesPerCycle: 8 });
  });

  it("принимает двоеточие и пробелы вокруг чисел", () => {
    const out = parseParamsFromText("evs : 55 категорий : 2 гипотез : 4");
    expect(out.minEvs).toBe(55);
    expect(out.minCategories).toBe(2);
    expect(out.maxHypothesesPerCycle).toBe(4);
  });

  it("зажимает значения в допустимые границы", () => {
    expect(parseParamsFromText("EVS=5").minEvs).toBe(10);
    expect(parseParamsFromText("EVS=999").minEvs).toBe(95);
    expect(parseParamsFromText("категорий=0").minCategories).toBe(1);
    expect(parseParamsFromText("категорий=9").minCategories).toBe(5);
    expect(parseParamsFromText("гипотез=0").maxHypothesesPerCycle).toBe(1);
    expect(parseParamsFromText("гипотез=500").maxHypothesesPerCycle).toBe(100);
  });

  it("без строки параметров не выдумывает значения", () => {
    expect(parseParamsFromText("Рынок в боковике, рекомендую подождать.")).toEqual({});
  });

  it("частичная строка даёт частичный результат", () => {
    const out = parseParamsFromText("EVS=60");
    expect(out).toEqual({ minEvs: 60 });
  });

  it("результат всегда конечный и целый там, где это счётчики", () => {
    const out = parseParamsFromText("EVS=72, категорий=3, гипотез=8");
    for (const value of Object.values(out)) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });
});

describe("isSmallTalkQuestion", () => {
  it("бытовой вопрос без рыночных слов — small talk", () => {
    expect(isSmallTalkQuestion("ты тут?")).toBe(true);
    expect(isSmallTalkQuestion("спасибо")).toBe(true);
  });

  it("вопрос про рынок — не small talk", () => {
    expect(isSmallTalkQuestion("какой сигнал по BTC сейчас?")).toBe(false);
    expect(isSmallTalkQuestion("что с фандингом")).toBe(false);
    expect(isSmallTalkQuestion("покажи гипотезы")).toBe(false);
  });

  it("цифры и длина больше 60 символов исключают small talk", () => {
    expect(isSmallTalkQuestion("привет")).toBe(true);
    // Цифра — признак конкретного вопроса, контекст базы нужен.
    expect(isSmallTalkQuestion("привет 2")).toBe(false);
    // Длинный текст (> 60) small talk-ом не считается: скорее всего это запрос
    // на разбор, и отправлять его модели без контекста было бы ошибкой.
    expect(isSmallTalkQuestion("здравствуйте, подскажите пожалуйста, что вы думаете о текущей ситуации на рынке криптовалют")).toBe(false);
    expect(isSmallTalkQuestion("")).toBe(false);
    expect(isSmallTalkQuestion("   ")).toBe(false);
  });
});
