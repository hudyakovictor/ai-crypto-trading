/**
 * ТОЧКА СТАРТА СЕРВЕРНОГО ПРОЦЕССА (Next.js instrumentation hook).
 *
 * Зачем этот файл нужен: автопилот лаборатории жил в `setInterval`, который
 * запускался лениво — из обработчика API-роута, то есть только после того, как
 * кто-то открыл дашборд в браузере (или дёрнул `/api/research/status`).
 * Следствия были такие:
 *   • сервер, поднятый без открытой вкладки, не делал НИ ОДНОГО цикла;
 *   • после рестарта процесса расписание обнулялось и цикл откладывался;
 *   • `next build`/serverless-окружение вообще не имели постоянного таймера;
 *   • в нескольких процессах (dev + worker) таймер заводился по нескольку раз.
 *
 * Теперь `register()` вызывается самим Next.js при старте серверного процесса,
 * один раз, до первого запроса. Автопилот стартует сразу, и журнал прогнозов
 * наполняется независимо от того, смотрит ли кто-нибудь в UI.
 *
 * Отключение: `AUTOPILOT=0` (например, для тестов или миграций БД).
 */

const AUTOPILOT_ENV_FLAG = "AUTOPILOT";

export async function register(): Promise<void> {
  // Хук вызывается и для edge-рантайма: там нет ни `pg`, ни долгоживущего
  // процесса, поэтому автопилот имеет смысл только в nodejs-рантайме.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  if (process.env[AUTOPILOT_ENV_FLAG] === "0") {
    console.warn(
      "[autopilot] отключён через AUTOPILOT=0: циклы нужно запускать вручную (POST /api/research/cycle)"
    );
    return;
  }

  try {
    // Динамический импорт: не тянем клиент БД и OKX-клиент в граф сборки
    // клиентских/edge-бандлов.
    const { ensureAutopilot, CYCLE_INTERVAL_MIN } = await import("@/lib/quant/autopilot");
    const state = ensureAutopilot();
    console.info(
      `[autopilot] запущен: цикл каждые ${CYCLE_INTERVAL_MIN} минут, enabled=${state.enabled}`
    );
  } catch (err) {
    // Старт автопилота не должен ронять сервер: чаще всего причина — недоступная
    // БД на холодном старте. Первый тик повторит попытку через минуту.
    console.error(
      "[autopilot] не удалось стартовать:",
      err instanceof Error ? err.message : String(err)
    );
  }
}

/**
 * Единая точка логирования необработанных ошибок запросов.
 *
 * Раньше ошибка рендера/роута уходила в Next без следа в наших логах: не было
 * ни корреляции, ни возможности понять, какой именно экран упал. Формат — одна
 * строка JSON, чтобы её можно было собрать любым лог-агрегатором.
 */
export async function onRequestError(
  err: unknown,
  request: { path?: string; method?: string },
  context?: { routerKind?: string; routePath?: string }
): Promise<void> {
  console.error(
    JSON.stringify({
      level: "error",
      scope: "request",
      path: request?.path ?? null,
      method: request?.method ?? null,
      routerKind: context?.routerKind ?? null,
      routePath: context?.routePath ?? null,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack?.split("\n").slice(0, 4).join(" | ") : null,
      at: new Date().toISOString(),
    })
  );
}
