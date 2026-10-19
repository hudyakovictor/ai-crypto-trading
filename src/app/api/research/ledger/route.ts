import { NextResponse } from "next/server";
import { db } from "@/db";
import { hypotheses, forecasts } from "@/db/schema";
import { desc, eq, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

/** Сколько записей журнала отдаём за один запрос. */
const PAGE_SIZE = 50;

/**
 * Журнал бумажных прогнозов: что система предсказала и чем это кончилось.
 *
 * Что исправлено:
 *  1. **LEFT JOIN вместо соединения в JS.** Раньше двумя независимыми
 *     запросами брались 50 свежих гипотез и 50 свежих прогнозов, а затем
 *     прогноз искал родителя перебором `find()` по этому списку. Как только
 *     гипотеза оказывалась за пределами первой خمидесяти (а это нормальный
 *     случай: на один цикл создаётся до 15 гипотез, но прогнозов может быть
 *     больше), в журнал попадал `hypothesis: null` — экран терял код, формулу,
 *     механизм и неопределённость, то есть ровно то, ради чего журнал существует.
 *  2. **totalCount — настоящая величина.** Прежнее значение было размером
 *     страницы (всегда ≤ 50) и выдавалось за общее число записей, поэтому UI
 *     не мог показать, сколько журнала осталось за пределами выборки.
 *  3. Список гипотез собирается из тех же строк, что и прогнозы: рассинхрон
 *     двух выборок исключён.
 */
export async function GET() {
  try {
    const [rows, totalRows] = await Promise.all([
      db
        .select({ forecast: forecasts, hypothesis: hypotheses })
        .from(forecasts)
        .leftJoin(hypotheses, eq(hypotheses.id, forecasts.hypothesisId))
        .orderBy(desc(forecasts.createdAt))
        .limit(PAGE_SIZE),
      db.select({ total: sql<number>`count(*)::int` }).from(forecasts),
    ]);

    const joined = rows.map(({ forecast, hypothesis }) => ({
      ...forecast,
      hypothesis: hypothesis ?? null,
    }));

    // Уникальные гипотезы этой страницы — в порядке появления.
    const seen = new Set<number>();
    const hypList = joined
      .map((row) => row.hypothesis)
      .filter((h) => {
        if (!h || seen.has(h.id)) return false;
        seen.add(h.id);
        return true;
      });

    const totalCount = totalRows[0]?.total ?? joined.length;

    return NextResponse.json({
      success: true,
      hypotheses: hypList,
      forecasts: joined,
      /** Всего записей в журнале (не размер страницы). */
      totalCount,
      /** Сколько записей вернул этот запрос. */
      pageSize: joined.length,
      /** Сколько записей осталось за пределами страницы. */
      hiddenCount: Math.max(0, totalCount - joined.length),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to load ledger";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
