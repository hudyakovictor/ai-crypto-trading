import { db, pool } from "@/db";
import { selectionPolicy } from "@/db/schema";
import { eq } from "drizzle-orm";

/**
 * КТО ПРИНИМАЕТ РЕШЕНИЕ ОБ ОТБОРЕ.
 *
 * signalFilters — это вето человека: что вообще допустимо (порог EVS, операторы,
 * исключённые категории). Здесь ответ на другой вопрос: кому принадлежит выбор
 * «сколько гипотез оформлять и какие именно». По умолчанию — модели.
 *
 * ceiling — страховка от неконтролируемого потока записей (и от токен-бомбежки),
 * а не план: взять меньше потолка или ноль — коррежное решение, а не недобор.
 */

export type SelectionAuthority = "ai" | "rule";

export interface SelectionPolicyState {
  authority: SelectionAuthority;
  ceiling: number;
  updatedAt?: string;
}

export const POLICY_DEFAULTS: SelectionPolicyState = { authority: "ai", ceiling: 12 };
export const CEILING_MIN = 1;
export const CEILING_MAX = 30;

let ensurePromise: Promise<void> | null = null;

function ensureTable(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = pool
      .query(
        `CREATE TABLE IF NOT EXISTS selection_policy (
          id SERIAL PRIMARY KEY,
          profile TEXT NOT NULL DEFAULT 'default' UNIQUE,
          authority TEXT NOT NULL DEFAULT 'ai',
          ceiling INTEGER NOT NULL DEFAULT 12,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`
      )
      .then(() => undefined)
      .catch((e) => {
        ensurePromise = null;
        throw e;
      });
  }
  return ensurePromise;
}

export async function loadPolicy(): Promise<SelectionPolicyState> {
  try {
    await ensureTable();
    const rows = await db.select().from(selectionPolicy).where(eq(selectionPolicy.profile, "default")).limit(1);
    if (rows.length === 0) {
      const [created] = await db
        .insert(selectionPolicy)
        .values({ profile: "default" })
        .returning();
      return {
        authority: created.authority === "rule" ? "rule" : "ai",
        ceiling: created.ceiling,
        updatedAt: created.updatedAt.toISOString(),
      };
    }
    return {
      authority: rows[0].authority === "rule" ? "rule" : "ai",
      ceiling: rows[0].ceiling,
      updatedAt: rows[0].updatedAt.toISOString(),
    };
  } catch {
    // Нет БД/таблицы — не повод останавливать цикл: решение за моделью по умолчанию
    return { ...POLICY_DEFAULTS };
  }
}

export async function savePolicy(patch: { authority?: unknown; ceiling?: unknown }): Promise<SelectionPolicyState> {
  await ensureTable();
  const current = await loadPolicy();
  const next: SelectionPolicyState = { ...current };

  if (patch.authority !== undefined) {
    if (patch.authority !== "ai" && patch.authority !== "rule") {
      throw new Error("authority должен быть 'ai' или 'rule'");
    }
    next.authority = patch.authority;
  }
  if (patch.ceiling !== undefined) {
    const n = Math.round(Number(patch.ceiling));
    if (!Number.isFinite(n)) throw new Error("ceiling должен быть числом");
    next.ceiling = Math.max(CEILING_MIN, Math.min(CEILING_MAX, n));
  }

  await db
    .insert(selectionPolicy)
    .values({ profile: "default", authority: next.authority, ceiling: next.ceiling, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: selectionPolicy.profile,
      set: { authority: next.authority, ceiling: next.ceiling, updatedAt: new Date() },
    });

  return { ...next, updatedAt: new Date().toISOString() };
}
