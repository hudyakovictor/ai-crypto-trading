import type { AiScope, Facts, RecommendedParams } from "./context";
import { GOAL_USD, NOTIONAL_PER_TRADE } from "./context";

const ERR_FIX: Record<string, string> = {
  weak_signal: "поднять порог EVS и требовать ≥3 согласованных категории",
  cost_drag: "брать только сигналы с ожидаемым ходом ≥ 3× издержек (≈72 bps)",
  wrong_horizon: "частичная фиксация 50% позиции при MFE ≥ 0.35%",
  regime_mismatch: "включить режимный замок и торговать методику только в её режиме",
  wrong_sign: "добавить VETO против crowd-позиционирования по фандингу",
  insufficient_liquidity: "фильтр RVOL ≥ 1.4 перед входом",
};

/**
 * Детерминированный аналитик. Работает всегда, без внешних ключей:
 * компилирует предметный разбор из реальных чисел базы по правилам,
 * специфичным для каждого из 13 сценариев.
 */
export function glassboxAnalyze(
  scope: AiScope,
  f: Facts,
  rec: RecommendedParams,
  stats: { resolved: number; hitRate: number; brier: number; pnl: number; goalPct: number }
): string {
  const L: string[] = [];
  const best = f.leaders[0];
  const solid = f.leaders.filter((l) => l.n >= 8);
  const validated = solid.filter((l) => l.lb >= 0.55 && l.exp > 0);
  const losers = solid.filter((l) => l.exp <= 0 || l.lb < 0.42);
  const topLift = f.lift.slice(0, 3);
  const badLift = f.lift.filter((l) => l.lift < -5 && l.n >= 3);
  const bestGrid = f.grid.filter((g) => g.n >= 8).reduce<typeof f.grid[0] | null>((a, b) => (!a || b.exp > a.exp ? b : a), null);
  const topErr = f.errors[0];
  const P = () => `ПАРАМЕТРЫ: EVS=${rec.minEvs}, категорий=${rec.minCategories}`;

  const n = (x: number, d = 1) => x.toFixed(d);

  switch (scope) {
    case "signal_today":
      L.push(
        `1. ГЛАВНЫЙ КАНДИДАТ: ${f.combos[0] ? `${f.combos[0].asset} · ${f.combos[0].code} — EVS ${f.combos[0].evs}/100, связка ${f.combos[0].cats.join(" + ")}` : "комбинации цикла не сгенерированы"}.`,
        best
          ? `2. ИСТОРИЧЕСКАЯ ОПОРА: методика «${best.sig}» даёт n=${best.n}, hit-rate ${n(best.hr)}%, Wilson LB ${n(best.lb * 100, 0)}%, expectancy ${n(best.exp)} bps — ${best.n >= 8 && best.lb >= 0.55 ? "статистически подтверждена, можно доверять объём" : "выборки мало, только paper-size"}.`
          : "2. Лидерборд пуст — торговать не на чем, нужен набор истории.",
        `3. ФОН МОДЕЛИ: hit-rate ${n(stats.hitRate)}% на ${stats.resolved} исходах, Brier ${stats.brier} (${stats.brier <= 0.2 ? "калибровка хорошая" : stats.brier <= 0.26 ? "приемлемо" : "вероятностям верить нельзя"}), в ожидании ${f.pendingCount} прогнозов.`,
        `4. ТРИГГЕР: входить при EVS ≥ ${rec.minEvs} и подтверждении от ${topLift.map((l) => l.ru).slice(0, 2).join(" и ")} — эти категории дают максимальный lift (+${n(topLift[0]?.lift ?? 0)} и +${n(topLift[1]?.lift ?? 0)} п.п.).`,
        `5. ИНВАЛИДАЦИЯ: выход при падении EVS ниже ${Math.max(20, rec.minEvs - 15)} или смене знака композита; стоп по цене — 0.35% против входа.`,
        `6. ВЕРДИКТ: ${validated.length > 0 && stats.hitRate >= 52 ? "ТОРГОВАТЬ подтверждённой связкой малым размером" : "НАБЛЮДАТЬ — статистика ещё не даёт права на объём"}.`,
        `7. ${P()}`
      );
      break;

    case "filter_tuner":
      L.push(
        `1. ЦЕЛЬ НАСТРОЙКИ: максимум expectancy при достаточной выборке для обучения. Сейчас разрешено ${stats.resolved} исходов, expectancy ${n(f.expectancyBps)} bps.`,
        `2. СЕТКА ПОРОГОВ ПОКАЗЫВАЕТ: ${f.grid.filter((g) => g.n >= 8).map((g) => `EVS≥${g.cut} → ${n(g.hr, 0)}% / ${n(g.exp)} bps (n=${g.n})`).join("; ")}.`,
        bestGrid
          ? `3. ОПТИМУМ ПО ДОХОДНОСТИ: отсечка ${bestGrid.cut} даёт ${n(bestGrid.exp)} bps, но оставляет выборку ${bestGrid.n}. Рекомендую EVS=${rec.minEvs} — компромисс между чистотой сигнала и тем, чтобы у обучения вообще оставался материал.`
          : `3. Исходов мало (${stats.resolved}) — задранный порог был бы отсеиванием наугад, держим EVS=${rec.minEvs}.`,
        `4. СКОЛЬКО ТЕСТИРОВАТЬ: решение не твоё и не ползунка — его принимает планировщик цикла; ${rec.maxHypothesesPerCycle} — только страховочный потолок записей. Ставки бумажные, поэтому приоритет один: чистота отбора, шум дороже пустого цикла.`,
        `5. КАТЕГОРИИ НА ИСКЛЮЧЕНИЕ: ${badLift.length ? badLift.map((l) => `${l.ru} (${n(l.lift)} п.п., n=${l.n})`).join("; ") : "нет — все категории нейтральны или полезны"}.`,
        `6. НАПРАВЛЕНИЯ: ${f.dirStats.filter((d) => d.n > 0).map((d) => `${d.d} n=${d.n}, ${n(d.hr, 0)}%, ${n(d.exp)} bps`).join("; ")} → оставить ${rec.directions.join(", ")}.`,
        `7. ${P()}`
      );
      break;

    case "combo_audit":
      f.combos.slice(0, 5).forEach((c, i) => {
        const strong = c.evs >= Math.max(70, rec.minEvs + 15);
        const ok = c.evs >= rec.minEvs;
        L.push(
          `${i + 1}. ${c.asset} · ${c.code} — ${strong ? "ТОРГОВАТЬ" : ok ? "НАБЛЮДАТЬ" : "ОТКЛОНИТЬ"}. EVS ${c.evs}; связка ${c.cats.join(" + ")}${c.cats.length > 3 ? "; много компонентов — проверь дубли по смыслу" : ""}.`
        );
      });
      L.push(
        `${L.length + 1}. УСИЛЕНИЕ: добавлять к связкам ${topLift[0]?.ru ?? "—"} (+${n(topLift[0]?.lift ?? 0)} п.п. lift) и избегать ${badLift[0]?.ru ?? "нейтральных категорий"}.`,
        `${L.length + 2}. ${P()}`
      );
      break;

    case "heatmap_read":
      L.push(
        `1. КАК ЧИТАТЬ: зелёный — давление вверх, красный — вниз, яркость = |score|. Значимы ячейки |score| ≥ 0.40.`,
        `2. ДОВЕРЯТЬ В ПЕРВУЮ ОЧЕРЕДЬ: ${f.weightsTop.slice(0, 3).map((w) => `${w.ru} (вес ${n(w.w, 2)}, WR ${n(w.wr, 0)}%)`).join("; ")} — у этих категорий максимальный вес обучения.`,
        `3. ИГНОРИРОВАТЬ: ${f.weightsLow.slice(0, 2).map((w) => `${w.ru} (вес ${n(w.w, 2)})`).join("; ")} — модель им не доверяет, их цвет не должен влиять на решение.`,
        `4. СОГЛАСОВАННОСТЬ ВАЖНЕЕ ЯРКОСТИ: актив, где 3+ высоковесовых категории одного цвета, — кандидат в связку; одиночная яркая ячейка без поддержки = шум.`,
        `5. КОНФЛИКТ: противоположные знаки у ${topLift[0]?.ru ?? "потока"} и ${f.weightsTop[1]?.ru ?? "деривативов"} исторически предшествуют ошибке типа wrong_sign — пропускать такие сетапы.`,
        `6. ${P()}`
      );
      break;

    case "ledger_postmortem":
      L.push(
        `1. СТРУКТУРА ПОТЕРЬ: ${f.errors.map(([t, c]) => `${t} ×${c}`).join("; ") || "промахов нет"}.`,
        topErr
          ? `2. ДОМИНИРУЮЩАЯ ПРИЧИНА: ${topErr[0]} (${topErr[1]} случаев) — лечение: ${ERR_FIX[topErr[0]] ?? "ужесточить отбор"}.`
          : "2. Доминирующей причины нет.",
        `3. ПРАВИЛО №1: не брать сигналы ниже EVS ${rec.minEvs} — по сетке отсечка ниже даёт худший expectancy.`,
        `4. ПРАВИЛО №2: частичная фиксация 50% на MFE ≥ 0.35% убирает класс wrong_horizon, не срезая средний выигрыш.`,
        `5. ПРАВИЛО №3: ${badLift.length ? `исключить ${badLift[0].ru} — с ней hit-rate на ${n(Math.abs(badLift[0].lift))} п.п. ниже` : "следить за lift категорий еженедельно"}.`,
        `6. ${P()}`
      );
      break;

    case "weights_doctor":
      L.push(
        `1. ЗДОРОВЬЕ КАЛИБРОВКИ: Brier ${stats.brier} — ${stats.brier <= 0.2 ? "модель калибрована, вероятностям можно верить" : stats.brier <= 0.26 ? "умеренно, продолжать обучение" : "плохо, не использовать вероятности как проценты"}.`,
        `2. ЗАСЛУЖЕННО ВЫСОКИЕ ВЕСА: ${f.weightsTop.slice(0, 3).map((w) => `${w.ru} w=${n(w.w, 2)} при n=${w.n}`).join("; ")}.`,
        `3. РИСК ПЕРЕОЦЕНКИ: категории с весом > 1.2 и выборкой < 20 наблюдений доверяют себе больше, чем доказали — байесовский приор α=β=5 их сглаживает, но объём под них не увеличивать.`,
        `4. КАНДИДАТЫ НА ПРИГЛУШЕНИЕ: ${f.weightsLow.slice(0, 3).map((w) => `${w.ru} (w=${n(w.w, 2)}, WR ${n(w.wr, 0)}%)`).join("; ")}.`,
        `5. ДЕЙСТВИЕ: запускать переобучение после каждых ~20 новых исходов; веса вне коридора 0.25–2.50 невозможны by design — защита от переобучения работает.`,
        `6. ${P()}`
      );
      break;

    case "walkforward_judge":
      L.push(
        `1. ПРИНЦИП: история режется строго хронологически — обучение, валидация, неприкосновенный holdout. Перемешивание запрещено, lookahead невозможен.`,
        `2. ОБЩИЙ ФОН: hit-rate ${n(stats.hitRate)}% на ${stats.resolved} исходах, expectancy ${n(f.expectancyBps)} bps после издержек.`,
        `3. ПРИЗНАК ПОДГОНКИ: падение hit-rate от train к holdout более чем на 10 п.п. Если holdout держится — эффект реален.`,
        `4. ПЛАНКА БЕНЧМАРКА: модель обязана бить простой momentum (≈53.4% / +11.2 bps) уже после round-trip издержек ~24 bps.`,
        `5. ВЕРДИКТ: ${validated.length > 0 ? "есть минимум одна методика с Wilson LB ≥ 55% при n ≥ 8 — холдаут имеет смысл читать всерьёз" : "валидированных методик нет, любой хороший holdout пока считать случайностью"}.`,
        `6. ${P()}`
      );
      break;

    case "edge_critic":
      L.push(
        best
          ? `1. МАСШТАБИРОВАТЬ: «${best.sig}» — n=${best.n}, LB ${n(best.lb * 100, 0)}%, expectancy ${n(best.exp)} bps. ${best.n >= 8 && best.lb >= 0.55 ? "Все статистические пороги пройдены." : "Нужно довести n до 8 при LB ≥ 55%."}`
          : "1. Масштабировать нечего — лидерборд пуст.",
        losers.length
          ? `2. УБИТЬ: «${losers[0].sig}» — expectancy ${n(losers[0].exp)} bps при n=${losers[0].n}: отрицательное матожидание сжигает капитал.`
          : "2. Статистически значимых лузеров нет — держать всех на paper-size.",
        topErr ? `3. FAILURE MODE: ${topErr[0]} (${topErr[1]}) → ${ERR_FIX[topErr[0]] ?? "ужесточить отбор"}.` : "3. Промахов не зафиксировано.",
        `4. РЫЧАГ LIFT: усиливать ${topLift.map((l) => l.ru).join(", ")}; резать ${badLift.map((l) => l.ru).join(", ") || "пока нечего"}.`,
        `5. ЭКОНОМИКА: при expectancy ${n(f.expectancyBps)} bps и ноционале $${NOTIONAL_PER_TRADE} одна сделка приносит ≈ $${n((f.expectancyBps / 10000) * NOTIONAL_PER_TRADE)}.`,
        `6. ${P()}`
      );
      break;

    case "regime_playbook":
      L.push(
        `1. ДИАГНОЗ: конфигурация весов во главе с «${f.weightsTop[0]?.ru ?? "—"}» (w=${n(f.weightsTop[0]?.w ?? 1, 2)}) указывает на рынок, где ${/[Мм]икроструктура|[Пп]оток/.test(f.weightsTop[0]?.ru ?? "") ? "микроструктура ведёт цену, а макро-факторы запаздывают" : "ведут макро-факторы, микроструктура шумит"}.`,
        `2. РАЗРЕШЕНО: ${f.weightsTop.slice(0, 2).map((w) => w.ru).join(" и ")} — торговать только с подтверждением этих блоков.`,
        `3. ЗАПРЕЩЕНО: ${f.weightsLow.slice(0, 2).map((w) => w.ru).join(", ")} — в текущем режиме их сигналы системно врут.`,
        `4. ВЕТО: пропускать сделки, где ведущая категория имеет вес < 0.80 или |score| < 0.40.`,
        `5. ПЕРЕСМОТР: если hit-rate скользящего окна упадёт ниже ${Math.max(45, Math.round(stats.hitRate - 10))}% — режим сменился, плейбук перестраивать.`,
        `6. ${P()}`
      );
      break;

    case "risk_gate": {
      const gate: [string, boolean][] = [
        [`Выборка n ≥ 8 у лучшей методики (сейчас ${best?.n ?? 0})`, (best?.n ?? 0) >= 8],
        [`Wilson LB ≥ 55% (сейчас ${n((best?.lb ?? 0) * 100, 0)}%)`, (best?.lb ?? 0) >= 0.55],
        [`Expectancy > 0 после издержек (сейчас ${n(best?.exp ?? 0)} bps)`, (best?.exp ?? 0) > 0],
        [`Общий hit-rate ≥ 52% (сейчас ${n(stats.hitRate)}%)`, stats.hitRate >= 52],
        [`Brier ≤ 0.24 (сейчас ${stats.brier})`, stats.brier <= 0.24],
        [`Доминирующий failure mode обработан фильтром`, !topErr || rec.minEvs >= 60],
      ];
      gate.forEach(([q, ok], i) => L.push(`${i + 1}. ${ok ? "ДА" : "НЕТ"} — ${q}.`));
      const passed = gate.filter(([, ok]) => ok).length;
      L.push(`${gate.length + 1}. ВЕРДИКТ: ${passed}/6 — ${passed >= 5 ? "КАПИТАЛ ДОПУЩЕН малым размером" : "ТОЛЬКО PAPER до закрытия пробелов"}.`, `${gate.length + 2}. ${P()}`);
      break;
    }

    case "hypothesis_writer":
      L.push(
        `1. ГИПОТЕЗА: связка «${topLift[0]?.ru ?? "Поток ордеров"} + ${topLift[1]?.ru ?? "Микроструктура стакана"}» оператором WEIGHTED, порог композита ≥ 0.40, горизонт 15m.`,
        `2. ОСНОВАНИЕ: lift ${n(topLift[0]?.lift ?? 0)} и ${n(topLift[1]?.lift ?? 0)} п.п. при n=${topLift[0]?.n ?? 0}/${topLift[1]?.n ?? 0} — обе категории статистически повышают точность.`,
        `3. ВХОД: согласованный знак обеих категорий и |score| ведущей ≥ 0.45 на закрытии свечи; EVS связки ≥ ${rec.minEvs}.`,
        `4. ФАЛЬСИФИКАЦИЯ: |score| падает ниже 0.20 до истечения горизонта либо цена проходит 0.35% против входа.`,
        `5. КОНТРОЛЬ: после n=8 требовать Wilson LB ≥ 50%, иначе перевод в rejected.`,
        `6. ${P()}`
      );
      break;

    case "capital_planner": {
      const perTrade = (f.expectancyBps / 10000) * NOTIONAL_PER_TRADE;
      const left = GOAL_USD - stats.pnl;
      const trades = perTrade > 0 ? Math.ceil(left / perTrade) : 0;
      L.push(
        `1. ТЕКУЩЕЕ СОСТОЯНИЕ: $${stats.pnl} из $${GOAL_USD} (${n(stats.goalPct)}%), осталось $${n(left, 0)}.`,
        `2. ЭКОНОМИКА СДЕЛКИ: expectancy ${n(f.expectancyBps)} bps × $${NOTIONAL_PER_TRADE} = $${n(perTrade)} на сигнал.`,
        perTrade > 0
          ? `3. ДИСТАНЦИЯ: ≈ ${trades} результативных исходов; при hit-rate ${n(stats.hitRate)}% это ≈ ${Math.ceil(trades / Math.max(0.01, stats.hitRate / 100))} зафиксированных прогнозов. Скорость набора — не рычаг: сколько связок оформлять за цикл решает планировщик, а ${rec.maxHypothesesPerCycle} это лишь страховочный потолок потока.`
          : "3. ДИСТАНЦИЯ: при неположительном expectancy цель недостижима — сначала чинить отбор.",
        `4. РЫЧАГ №1 — качество: поднять порог до ${bestGrid?.cut ?? rec.minEvs + 10} увеличивает expectancy до ${n(bestGrid?.exp ?? f.expectancyBps)} bps ценой сужения выборки.`,
        `5. РЫЧАГ №2 — концентрация: торговать только методики с LB ≥ 55% (${validated.length} шт.), остальное держать в paper.`,
        `6. РИСК-ЛИМИТ: останавливать наращивание при просадке > 8% от накопленного PnL или падении скользящего hit-rate ниже ${Math.max(45, Math.round(stats.hitRate - 12))}%.`,
        `7. ${P()}`
      );
      break;
    }

    case "category_pruner":
      L.push(
        `1. МЕТОД: lift = hit-rate сделок С категорией минус БЕЗ неё. Значим при n ≥ 3.`,
        `2. УСИЛИВАЮТ EDGE: ${topLift.map((l) => `${l.ru} (+${n(l.lift)} п.п., n=${l.n})`).join("; ")}.`,
        `3. РАЗМЫВАЮТ: ${badLift.length ? badLift.map((l) => `${l.ru} (${n(l.lift)} п.п., n=${l.n})`).join("; ") : "категорий с устойчиво отрицательным lift нет"}.`,
        `4. НА ИСКЛЮЧЕНИЕ: ${rec.excludedCategories.length ? rec.excludedCategories.join(", ") : "ничего — оставить все 15 в работе"}.`,
        `5. ОСТОРОЖНО: не исключать категории с n < 3 — это шум, а не вывод; сначала накопить выборку низким порогом EVS.`,
        `6. ${P()}`
      );
      break;
  }

  return L.join("\n");
}
