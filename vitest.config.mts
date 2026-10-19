import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Конфигурация тестов.
 *
 * Тестируются ЧИСТЫЕ функции лаборатории: контракт исхода, оценщик исходов,
 * детектор режима, движок признаков, байесовское сглаживание весов, парсер
 * параметров модели. Они не требуют ни БД, ни сети, поэтому прогон работает
 * где угодно, включая CI без Postgres.
 *
 * Запросы к БД (агрегаты обучения, LEFT JOIN журнала, статусные счётчики)
 * здесь не проверяются: для них нужен настоящий Postgres — эмуляторы молча
 * искажают результаты `COUNT(*) FILTER` и не поддерживают `LATERAL`, поэтому
 * тест на эмуляторе дал бы ложную уверенность. Поднимите базу через
 * `docker compose up -d db` и `npm run db:push`, затем `npm run dev`.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Подставляет фиктивный DATABASE_URL: модуль @/db бросает исключение при
    // импорте без него, а соединение в тестах чистых функций не используется.
    setupFiles: ["./tests/setup.ts"],
  },
});
