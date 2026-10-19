"""Generate research artifacts for iteration 1 (no code changes to the trading system).

Run from research/2026-10:
    python3 tools/make_artifacts.py

Outputs: hypotheses.jsonl, claims.tsv, rejected.tsv, contradictions.tsv, trials.tsv,
state/state.json, map.md.
"""
import json
import os

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def base_availability(event_time, publish_time, earliest, pit="собственный журнал сырых сообщений с метками приёма"):
    return {
        "event_time": event_time,
        "publish_time": publish_time,
        "ingest_time": "измеряется отдельно; задержка приёма не предполагается нулевой",
        "earliest_actionable": earliest,
        "revision_risk": "публичные рыночные данные не пересматриваются; календарь событий может обновляться",
        "pit_source": pit,
    }


def base_ai(function, justification, model_class="правило + градиентный бустинг; LLM не в контуре вероятности"):
    return {
        "function": function,
        "justification": justification,
        "model_class": model_class,
        "reproducibility": "фиксация версии библиотек, семян и снимка входов",
        "leakage_guard": "все признаки считаются только по данным, доступным до момента решения",
        "injection_guard": "внешний текст не подаётся в контур исполнения; LLM-аннотации только для research",
        "cost_per_decision": "доли секунды CPU; LLM-вызовы вне торгового контура",
        "latency_per_decision_ms": 50,
    }


def base_evidence(supports, contradicts, confirmations, objections, open_questions, score):
    return {
        "supports": supports,
        "contradicts": contradicts,
        "independent_confirmations": confirmations,
        "independent_objections": objections,
        "open_questions": open_questions,
        "score": score,
        "score_rationale": {
            "механизм": "оценка силы причинного механизма, 0-5",
            "независимость_подтверждений": "число разных групп происхождения, не число ссылок",
            "качество_данных": "насколько данные публичны, point-in-time и полны",
            "исполнение": "реалистичность входа/выхода и проскальзывания",
            "устойчивость_к_издержкам": "остаётся ли эффект после комиссии, спреда и funding",
            "стоимость_проверки": "сколько стоит получить решающее наблюдение (5 = дёшево)",
        },
    }


def _normalize_params(signal):
    """Schema allows only scalar parameter values: join lists into comma strings."""
    params = signal.get("parameters") or {}
    signal["parameters"] = {
        k: ",".join(str(x) for x in v) if isinstance(v, (list, tuple)) else v
        for k, v in params.items()
    }
    return signal


def hyp(
    hid, title, mechanism, market, horizon, signal, availability, ai_role, baseline,
    costs, testability, statistics, decision, evidence, provenance_extra="",
):
    signal = _normalize_params(signal)
    return {
        "id": hid,
        "version": 1,
        "title": title,
        "lifecycle": "карточка",
        "mechanism": mechanism,
        "market": market,
        "horizon": horizon,
        "signal": signal,
        "availability": availability,
        "ai_role": ai_role,
        "baseline": baseline,
        "costs": costs,
        "testability": testability,
        "statistics": statistics,
        "decision": decision,
        "evidence": evidence,
        "provenance": {
            "created_in_iteration": 1,
            "created_at": "2026-10-18",
            "real_capital_delta": provenance_extra or "при реальном капитале добавляются лимиты заявок, маржинальная нагрузка и отказоустойчивость соединения",
        },
    }


H = []

# H001 Turn-of-candle
H.append(hyp(
    "H001", "Поворот 15-минутной свечи: положительный дрейф на границе бара",
    {
        "actor": "алгоритмы и маркет-мейкеры, синхронизированные на общем временном гриде",
        "constraint": "исполнение и перебалансировка привязаны к границам баров и к API, отдающим свечи",
        "observable": "в минуты 0/15/30/45 растут число сделок, объём и |return|; средняя доходность этих минут выше",
        "opportunity": "краткосрочный дрейф на границе бара, который можно поймать maker-ордером",
        "action": "вход в начале граничной минуты, выход через 1-3 минуты или на следующей границе",
        "decay": "эффект исчезает, если все участники перейдут на event-time или биржа изменит сборку баров",
        "risk_premium_or_alpha": "структурное ограничение",
        "alternative_explanations": ["артефакт сборки свечей на конкретной бирже", "bid-ask bounce", "сезонность часа"],
        "crowding_indicator": "снижение доходности граничных минут после 2023 года",
        "half_life": "неизвестен; оценить по годам 2019-2026",
    },
    {"venue_class": "CEX бессрочные", "instrument": "USDT-перпетуал", "assets": ["BTC-USDT-SWAP", "ETH-USDT-SWAP"], "data_vendor_class": "1-минутные свечи и сделки, публично"},
    {"bar_minutes": 1, "holding_minutes": 3, "target_move_bps": 8, "decision_latency_ms": 500},
    {"inputs": ["minute_of_hour", "return_1m", "volume_1m", "spread"], "rule": "minute_of_hour in {0,15,30,45} and spread <= median_spread", "direction": "UP", "entry": "post-only limit на лучшем bid", "exit": "через 1-3 минуты или по таймауту", "invalidation": "спред расширился выше 2 медиан", "parameters": {"boundary_minutes": [0, 15, 30, 45], "hold_min": 3}},
    base_availability("граница 15-минутного бара", "сразу после закрытия предыдущего бара", "в момент формирования нового бара"),
    base_ai("объединение сигналов", "правило простое; ML нужен только для фильтра режима и спреда"),
    {"simple_algorithm": "покупать в каждую граничную минуту и держать 3 минуты", "comparison_ladder": ["без торговли", "buy-and-hold", "фиксированное правило", "правило с фильтром спреда", "ML-фильтр"], "expected_uplift": "8-15 bps за сделку после maker-издержек", "base_rate": "средняя доходность неграничной минуты"},
    {"fee_bps": 2, "spread_bps": 1, "slippage_bps": 1, "funding_bps": 0, "round_trip_bps": 6, "model": "OKX maker 0.02% + спред BTC/ETH", "adverse_case_bps": 14, "capacity_note": "правдоподобно до размера, малого относительно минуты объёма"},
    {"tier": "T0", "why": "нужны только 1-минутные свечи, которые уже есть", "harness": "исторические 1-минутные бары OKX 2023-2026", "missing_data": [], "required_build": "ничего, кроме bracket-симулятора"},
    {"n_planned": 500, "min_detectable_effect": "3-5 bps за сделку при 500 событиях", "power_note": "при таком n можно поймать только крупный эффект; малый неотличим от шума", "test_method": "event study + block bootstrap по дням", "multiplicity_budget": 3, "correction": "DSR по числу проверенных граничных минут", "concentration_risk": "эффект может держаться на нескольких днях высокой волатильности"},
    {"success_criterion": "средний net PnL граничной минуты > 3 bps и значим на block bootstrap", "kill_criterion": "после 2023 эффект не отличается от нуля или исчезает при maker-исполнении", "cheapest_experiment": "event study на уже сохранённых 1-минутных барах", "expected_cost": "0 внешних затрат", "expected_runtime": "1 день", "stop_rule": "после 500 событий или 2 недель", "confidence": 0.35},
    base_evidence(["S240", "S241"], ["S288"], 2, 1, ["Сохраняется ли эффект после 2023?", "Не является ли он bid-ask bounce?"], {"механизм": 3, "независимость_подтверждений": 2, "качество_данных": 5, "исполнение": 4, "устойчивость_к_издержкам": 3, "стоимость_проверки": 5}),
))

# H002 Boundary OFI
H.append(hyp(
    "H002", "Quarter-hour boundary OFI предсказывает 4-12-часовую доходность",
    {
        "actor": "институциональные алгоритмы, исполняющие крупные мета-ордера на границах интервалов",
        "constraint": "им нужно исполнение в узком окне, они оставляют устойчивый дисбаланс в стакане",
        "observable": "в первые 10-60 секунд после 00/15/30/45 минут OFI резко отклоняется от нуля",
        "opportunity": "направление дисбаланса продолжается несколько часов, пока мета-ордер не исполнен",
        "action": "вход по направлению boundary OFI, удержание 4-12 часов",
        "decay": "рост доли HFT, которые арбитрируют этот дисбаланс за секунды",
        "risk_premium_or_alpha": "структурное ограничение",
        "alternative_explanations": ["общий рыночный импульс", "реакция на новость", "артефакт выбора окна"],
        "crowding_indicator": "снижение IC boundary OFI после 2025",
        "half_life": "неизвестен; 6-18 месяцев по аналогии с intraday-эффектами",
    },
    {"venue_class": "CEX бессрочные", "instrument": "USDT-перпетуал", "assets": ["BTC-USDT-SWAP", "ETH-USDT-SWAP"], "data_vendor_class": "L2 стакан (Tardis/Kaiko) или 400-level OKX"},
    {"bar_minutes": 1, "holding_minutes": 360, "target_move_bps": 40, "decision_latency_ms": 1000},
    {"inputs": ["ofi_first_10s", "ofi_first_60s", "depth", "spread", "funding", "session"], "rule": "|OFI_10s| > q95(|OFI_10s|) and sign(OFI) == sign(OFI_60s)", "direction": "BOTH", "entry": "limit по направлению, taker только при сильном сигнале", "exit": "через 4-12 часов или по стопу", "invalidation": "OFI развернулся в первые 5 минут", "parameters": {"windows_sec": [10, 60, 300], "hold_hours": [4, 12]}},
    base_availability("00/15/30/45 UTC", "не позднее 1 с после события", "после накопления окна 10-60 с"),
    base_ai("объединение сигналов", "нужен фильтр режима и волатильности; сам OFI — правило"),
    {"simple_algorithm": "знак OFI за первые 60 секунд → направление на 4 часа", "comparison_ladder": ["без торговли", "buy-and-hold", "знак OFI", "OFI с фильтром режима", "ML-ансамбль"], "expected_uplift": "10-20 bps за сделку после издержек", "base_rate": "доля успешных 4-часовых направленных ставок"},
    {"fee_bps": 5, "spread_bps": 2, "slippage_bps": 5, "funding_bps": 2, "round_trip_bps": 14, "model": "OKX taker + BTC спред + ожидаемый funding", "adverse_case_bps": 30, "capacity_note": "до размера, малого относительно 10-секундного объёма"},
    {"tier": "T1", "why": "нужен L2-стакан с метками приёма; 15-минутные бары не подходят", "harness": "Tardis replay + симулятор исполнения", "missing_data": ["исторический L2 стакан OKX/Binance", "журнал заявок"], "required_build": "приём L2, пересборка OFI, измерение задержки"},
    {"n_planned": 300, "min_detectable_effect": "8-10 bps на 4-часовом горизонте", "power_note": "300 событий хватит только для крупного эффекта; иначе нужен больший период", "test_method": "CPCV с purge/embargo 12 ч, block bootstrap", "multiplicity_budget": 6, "correction": "DSR + PBO", "concentration_risk": "эффект может концентрироваться в нескольких неделях"},
    {"success_criterion": "IC > 0.03 и net PnL > 8 bps после издержек на OOS", "kill_criterion": "IC исчезает при контроле на общий momentum или после 2025", "cheapest_experiment": "один месяц L2 replay на BTC", "expected_cost": "подписка Tardis ~$350/мес", "expected_runtime": "2-3 недели", "stop_rule": "после 300 событий или 1 месяца данных", "confidence": 0.3},
    base_evidence(["S241", "S001", "S005"], ["S288"], 2, 1, ["Сколько эффекта остаётся после HFT?", "Работает ли на 15-минутном баре, а не на 1-минутном?"], {"механизм": 3, "независимость_подтверждений": 2, "качество_данных": 2, "исполнение": 3, "устойчивость_к_издержкам": 2, "стоимость_проверки": 2}),
))

# H003 Intraday momentum
H.append(hyp(
    "H003", "Внутридневной моментум: первые 30 минут → последние 30 минут",
    {
        "actor": "участники, исполняющие мета-ордера в начале дня и закрывающие позиции в конце",
        "constraint": "им нужно исполнить объём в ликвидном окне; они не могут ждать весь день",
        "observable": "доходность первых 30 минут положительно коррелирует с доходностью последних 30 минут",
        "opportunity": "продолжение направления в конце дня после формирования импульса",
        "action": "вход после первых 30 минут, удержание до последних 30 минут",
        "decay": "рост доли алгоритмов, которые арбитрируют паттерн",
        "risk_premium_or_alpha": "структурное ограничение",
        "alternative_explanations": ["общий momentum", "волатильность", "новости"],
        "crowding_indicator": "снижение R2 после 2024",
        "half_life": "2-5 лет по данным equity-литературы",
    },
    {"venue_class": "CEX бессрочные", "instrument": "USDT-перпетуал", "assets": ["BTC-USDT-SWAP", "ETH-USDT-SWAP"], "data_vendor_class": "15-минутные свечи, публично"},
    {"bar_minutes": 30, "holding_minutes": 180, "target_move_bps": 30, "decision_latency_ms": 1000},
    {"inputs": ["first_30m_return", "volume_first_30m", "volatility", "session", "macro_calendar"], "rule": "first_30m_return > 0 и volume_first_30m > median", "direction": "UP", "entry": "после закрытия первых 30 минут", "exit": "в последние 30 минут или по стопу", "invalidation": "возврат ниже начала дня", "parameters": {"first_window_min": 30, "last_window_min": 30}},
    base_availability("начало торгового дня по объёму", "после закрытия первых 30 минут", "через 30 минут после начала"),
    base_ai("объединение сигналов", "правило простое; ML фильтрует режим и новости"),
    {"simple_algorithm": "знак первых 30 минут → позиция до последних 30 минут", "comparison_ladder": ["без торговли", "buy-and-hold", "знак первых 30 минут", "с фильтром объёма", "ML-фильтр"], "expected_uplift": "10-20 bps за день после издержек", "base_rate": "средняя доходность дня"},
    {"fee_bps": 5, "spread_bps": 2, "slippage_bps": 3, "funding_bps": 1, "round_trip_bps": 12, "model": "OKX taker + BTC спред", "adverse_case_bps": 24, "capacity_note": "до размера, малого относительно 30-минутного объёма"},
    {"tier": "T0", "why": "нужны 15/30-минутные свечи, которые уже есть", "harness": "исторические бары OKX 2020-2026", "missing_data": [], "required_build": "bracket-симулятор и календарь макро-событий"},
    {"n_planned": 1000, "min_detectable_effect": "5 bps в день", "power_note": "1000 дней достаточно для среднего эффекта, но не для редких режимов", "test_method": "CPCV с embargo 1 день, block bootstrap", "multiplicity_budget": 4, "correction": "DSR + PBO", "concentration_risk": "эффект может держаться на 2020-2022"},
    {"success_criterion": "net PnL > 5 bps в день и значим на OOS 2023-2026", "kill_criterion": "эффект исчезает после 2023 или объясняется общим momentum", "cheapest_experiment": "репликация на 15-минутных барах BTC/ETH", "expected_cost": "0 внешних затрат", "expected_runtime": "3 дня", "stop_rule": "после 1000 дней или 2 недель", "confidence": 0.4},
    base_evidence(["S344", "S345", "S346"], ["S288", "S239"], 3, 2, ["Как определить «открытие» в 24/7 рынке?", "Не съедает ли эффект первый 15-минутный бар?"], {"механизм": 4, "независимость_подтверждений": 3, "качество_данных": 5, "исполнение": 4, "устойчивость_к_издержкам": 3, "стоимость_проверки": 5}),
))

# H004 Funding settlement timing
H.append(hyp(
    "H004", "Тайминг фандинга: не пересекать расчётный момент без премии",
    {
        "actor": "держатели перпетуалов, которые платят/получают funding в фиксированные моменты",
        "constraint": "funding начисляется только за позицию, открытую в момент расчёта; после расчёта обязательство исчезает",
        "observable": "расписание 00/08/16 UTC (или 1/2/4 ч) и опубликованная ставка",
        "opportunity": "открывать позицию сразу после расчёта и закрывать до следующего; экономия/доход",
        "action": "сдвиг входа/выхода относительно расчёта; при экстремальном funding — позиция на получающей стороне",
        "decay": "биржа может изменить интервал или механику (уже меняла)",
        "risk_premium_or_alpha": "структурное ограничение",
        "alternative_explanations": ["цена уже учитывает funding", "издержки входа съедают экономию"],
        "crowding_indicator": "рост доли позиций, открытых сразу после расчёта",
        "half_life": "пока существует механика; риск — изменение правил",
    },
    {"venue_class": "CEX бессрочные", "instrument": "USDT-перпетуал", "assets": ["BTC-USDT-SWAP", "ETH-USDT-SWAP"], "data_vendor_class": "публичное расписание и история funding"},
    {"bar_minutes": 15, "holding_minutes": 240, "target_move_bps": 20, "decision_latency_ms": 1000},
    {"inputs": ["minutes_to_funding", "funding_rate", "predicted_funding", "position"], "rule": "не открывать позицию, если время до расчёта < holding и funding против позиции", "direction": "BOTH", "entry": "после расчёта", "exit": "до следующего расчёта", "invalidation": "funding изменил знак", "parameters": {"settlements_utc": ["00:00", "08:00", "16:00"]}},
    base_availability("00/08/16 UTC", "ставка публикуется заранее", "в момент расчёта"),
    base_ai("настройка исполнения", "нужен планировщик и проверка календаря, а не LLM"),
    {"simple_algorithm": "всегда входить после расчёта и выходить за 5 минут до следующего", "comparison_ladder": ["случайный вход", "вход после расчёта", "вход с учётом знака funding", "оптимизация по funding"], "expected_uplift": "10-20 bps в месяц на позицию", "base_rate": "средний funding за период"},
    {"fee_bps": 5, "spread_bps": 2, "slippage_bps": 2, "funding_bps": 0, "round_trip_bps": 9, "model": "OKX taker + спред; funding = 0 при правильном тайминге", "adverse_case_bps": 18, "capacity_note": "не зависит от размера до лимитов биржи"},
    {"tier": "T0", "why": "funding и свечи уже есть", "harness": "исторические funding + 15-минутные бары", "missing_data": [], "required_build": "календарь расчётов и учёт funding в PnL"},
    {"n_planned": 2000, "min_detectable_effect": "3 bps на сделку", "power_note": "много событий, но эффект мал; нужен точный учёт", "test_method": "сравнение правил на одних и тех же сигналах", "multiplicity_budget": 3, "correction": "DSR", "concentration_risk": "низкая"},
    {"success_criterion": "экономия > 5 bps в месяц после издержек", "kill_criterion": "экономия меньше 2 bps или исчезает при изменении интервала", "cheapest_experiment": "пересчёт PnL существующих прогнозов с учётом времени входа", "expected_cost": "0", "expected_runtime": "1 день", "stop_rule": "после 2000 прогнозов", "confidence": 0.5},
    base_evidence(["S108", "S006", "S280", "S333"], ["S111"], 3, 1, ["Меняет ли биржа интервал?", "Учитывает ли цена funding заранее?"], {"механизм": 5, "независимость_подтверждений": 3, "качество_данных": 5, "исполнение": 5, "устойчивость_к_издержкам": 4, "стоимость_проверки": 5}),
))

# H005 Funding tail + OI crowding
H.append(hyp(
    "H005", "Экстремальный funding вместе с высоким OI/cap предсказывает разворот",
    {
        "actor": "перегруженные лонги/шорты, платящие funding",
        "constraint": "они не могут удерживать позицию без затрат; при движении против них — ликвидация",
        "observable": "funding percentile > 95 или < 5, OI/cap > 90-го перцентиля",
        "opportunity": "контр-трендовая ставка на сжатие позиции",
        "action": "вход против перегруженной стороны, удержание 8-72 часа",
        "decay": "если funding остаётся высоким, позиция может быть преждевременной",
        "risk_premium_or_alpha": "премия за риск",
        "alternative_explanations": ["сильный тренд", "рост волатильности", "макро-шок"],
        "crowding_indicator": "рост OI при том же funding",
        "half_life": "несколько дней",
    },
    {"venue_class": "CEX бессрочные", "instrument": "USDT-перпетуал", "assets": ["BTC-USDT-SWAP", "ETH-USDT-SWAP"], "data_vendor_class": "публичные funding/OI, CoinGlass"},
    {"bar_minutes": 60, "holding_minutes": 1440, "target_move_bps": 80, "decision_latency_ms": 1000},
    {"inputs": ["funding_percentile_30d", "oi_change_24h", "oi_over_cap", "price_trend", "realized_vol"], "rule": "funding_pct > 0.95 and oi_over_cap > q90 and trend < 0", "direction": "DOWN", "entry": "limit против тренда", "exit": "через 8-72 часа", "invalidation": "funding ещё выше и OI растёт", "parameters": {"funding_pct": 0.95, "oi_cap_q": 0.9}},
    base_availability("funding каждые 8 ч", "OI с задержкой агрегатора", "после публикации обоих рядов"),
    base_ai("объединение сигналов", "нужен фильтр тренда и волатильности"),
    {"simple_algorithm": "funding > q95 → short на 24 ч", "comparison_ladder": ["без торговли", "funding only", "funding + OI", "funding + OI + trend", "ML"], "expected_uplift": "15-25 bps на сделку", "base_rate": "безусловная 24-часовая доходность"},
    {"fee_bps": 5, "spread_bps": 2, "slippage_bps": 5, "funding_bps": 3, "round_trip_bps": 15, "model": "OKX taker + спред + funding", "adverse_case_bps": 35, "capacity_note": "до размера, малого относительно OI"},
    {"tier": "T1", "why": "нужны исторические OI и funding с одинаковой частотой", "harness": "CoinGlass/OKX history + 1-часовые бары", "missing_data": ["полный OI history по всем активам"], "required_build": "нормализация OI на капитализацию"},
    {"n_planned": 200, "min_detectable_effect": "20 bps на 24 ч", "power_note": "200 событий — минимально достаточно", "test_method": "event study + CPCV", "multiplicity_budget": 6, "correction": "DSR/PBO", "concentration_risk": "10/10/2025 может дать большую часть эффекта"},
    {"success_criterion": "net PnL > 15 bps на событие и значим без 10/10/2025", "kill_criterion": "эффект исчезает при исключении одного события или объясняется волатильностью", "cheapest_experiment": "event study на 2021-2026", "expected_cost": "0", "expected_runtime": "1 неделя", "stop_rule": "после 200 событий", "confidence": 0.3},
    base_evidence(["S280", "S337", "S013", "S015"], ["S283"], 2, 2, ["Не является ли это просто прокси волатильности?", "Сколько событий вне 2025?"], {"механизм": 3, "независимость_подтверждений": 2, "качество_данных": 3, "исполнение": 3, "устойчивость_к_издержкам": 3, "стоимость_проверки": 4}),
))

# H006 Session clock
H.append(hyp(
    "H006", "Сессионный профиль ликвидности: торговать в часы качества",
    {
        "actor": "участники разных часовых поясов; ликвидность распределена по сессиям",
        "constraint": "в азиатскую ночь меньше маркет-мейкеров и внимания; спреды шире",
        "observable": "профиль volume, spread, |return| по часам UTC",
        "opportunity": "торговать только в часы с низкими издержками и достаточным движением",
        "action": "фильтр часа; размер позиции зависит от ликвидности",
        "decay": "ETF-потоки и глобализация могут сгладить профиль",
        "risk_premium_or_alpha": "структурное ограничение",
        "alternative_explanations": ["макро-календарь", "время выхода новостей"],
        "crowding_indicator": "сглаживание профиля после 2024",
        "half_life": "2-5 лет",
    },
    {"venue_class": "CEX бессрочные", "instrument": "USDT-перпетуал", "assets": ["BTC-USDT-SWAP", "ETH-USDT-SWAP"], "data_vendor_class": "15-минутные свечи, публично"},
    {"bar_minutes": 15, "holding_minutes": 60, "target_move_bps": 20, "decision_latency_ms": 1000},
    {"inputs": ["hour_utc", "session", "spread", "volume", "realized_vol"], "rule": "hour in high_liquidity_hours and spread < q50", "direction": "BOTH", "entry": "по сигналу, только в разрешённые часы", "exit": "по горизонту", "invalidation": "спред выше порога", "parameters": {"high_liq_hours": [12, 13, 14, 15, 16, 17]}},
    base_availability("каждый час", "сразу", "в момент бара"),
    base_ai("настройка исполнения", "фильтр часа — правило, ML не нужен"),
    {"simple_algorithm": "торговать только 12-18 UTC", "comparison_ladder": ["все часы", "12-18 UTC", "spread-фильтр", "spread + vol"], "expected_uplift": "снижение издержек на 20-30%", "base_rate": "средний спред по всем часам"},
    {"fee_bps": 5, "spread_bps": 2, "slippage_bps": 2, "funding_bps": 1, "round_trip_bps": 10, "model": "OKX taker + спред", "adverse_case_bps": 20, "capacity_note": "зависит от часа"},
    {"tier": "T0", "why": "данные уже есть", "harness": "исторические бары", "missing_data": [], "required_build": "ничего"},
    {"n_planned": 5000, "min_detectable_effect": "3 bps", "power_note": "много данных, но эффект мал", "test_method": "сравнение часовых подвыборок", "multiplicity_budget": 24, "correction": "Benjamini-Hochberg", "concentration_risk": "низкая"},
    {"success_criterion": "издержки в выбранные часы ниже на 20% при том же gross PnL", "kill_criterion": "разница исчезает после 2024", "cheapest_experiment": "агрегация существующих прогнозов по часам", "expected_cost": "0", "expected_runtime": "1 день", "stop_rule": "после 5000 прогнозов", "confidence": 0.5},
    base_evidence(["S236", "S161", "S163"], ["S237"], 2, 1, ["Не изменился ли профиль после ETF?"], {"механизм": 4, "независимость_подтверждений": 2, "качество_данных": 5, "исполнение": 4, "устойчивость_к_издержкам": 4, "стоимость_проверки": 5}),
))

# H007 OI/cap risk overlay
H.append(hyp(
    "H007", "OI/капитализация и ΔOI как риск-оверлей, а не направленный сигнал",
    {
        "actor": "спекулянты с плечом и ликвидационный движок биржи",
        "constraint": "при падении цены ликвидации становятся принудительными продажами",
        "observable": "OI/cap и ΔOI растут быстрее цены",
        "opportunity": "сократить риск до каскада, а не предсказывать его",
        "action": "снижать gross exposure при высоком OI/cap; не открывать новые лонги",
        "decay": "после deleveraging риск падает",
        "risk_premium_or_alpha": "премия за риск",
        "alternative_explanations": ["хеджирование", "рост институционального интереса"],
        "crowding_indicator": "OI/cap выше 95-го перцентиля",
        "half_life": "дни",
    },
    {"venue_class": "CEX бессрочные", "instrument": "USDT-перпетуал", "assets": ["BTC-USDT-SWAP", "ETH-USDT-SWAP"], "data_vendor_class": "публичные OI и капитализация"},
    {"bar_minutes": 60, "holding_minutes": 0, "target_move_bps": 0, "decision_latency_ms": 1000},
    {"inputs": ["oi", "oi_change_1h", "oi_over_cap", "funding", "realized_vol"], "rule": "oi_over_cap > q95 → снизить риск на 50%", "direction": "NEUTRAL", "entry": "не применимо", "exit": "не применимо", "invalidation": "OI/cap вернулся ниже q80", "parameters": {"q": 0.95, "reduce": 0.5}},
    base_availability("OI каждые 5 минут", "с задержкой агрегатора", "после публикации"),
    base_ai("обнаружение режима", "риск-оверлей, не прогноз"),
    {"simple_algorithm": "при OI/cap > q95 уменьшить позицию вдвое", "comparison_ladder": ["без оверлея", "OI/cap", "OI/cap + funding", "ML"], "expected_uplift": "снижение max drawdown на 20-30%", "base_rate": "исторический drawdown"},
    {"fee_bps": 0, "spread_bps": 0, "slippage_bps": 0, "funding_bps": 0, "round_trip_bps": 0, "model": "оверлей не торгует, только меняет размер", "adverse_case_bps": 0, "capacity_note": "не применимо"},
    {"tier": "T1", "why": "нужен полный OI history и капитализация", "harness": "CoinGlass + 1-часовые бары", "missing_data": ["полный OI history"], "required_build": "нормализация OI"},
    {"n_planned": 500, "min_detectable_effect": "снижение drawdown на 5 п.п.", "power_note": "мало независимых каскадов; выводы осторожные", "test_method": "сравнение стратегий с оверлеем и без", "multiplicity_budget": 4, "correction": "block bootstrap", "concentration_risk": "10/10/2025 доминирует"},
    {"success_criterion": "max drawdown ниже на 20% при том же Sharpe", "kill_criterion": "оверлей не улучшает drawdown вне 2025", "cheapest_experiment": "ретроспективный оверлей на существующих прогнозах", "expected_cost": "0", "expected_runtime": "3 дня", "stop_rule": "после 500 дней", "confidence": 0.4},
    base_evidence(["S337", "S339", "S013", "S015"], ["S283"], 3, 1, ["Не является ли OI/cap просто прокси волатильности?"], {"механизм": 4, "независимость_подтверждений": 3, "качество_данных": 3, "исполнение": 5, "устойчивость_к_издержкам": 5, "стоимость_проверки": 4}),
))

# H008 Token unlock
H.append(hyp(
    "H008", "Pre-drift токен-анлоков: избегать лонгов и шортить thin-float",
    {
        "actor": "получатели вестинга и маркет-мейкеры, знающие расписание",
        "constraint": "unlock увеличивает свободный float; ранние держатели могут продавать",
        "observable": "календарь unlock и размер tranche относительно float",
        "opportunity": "pre-drift за 2-4 недели до события",
        "action": "не держать лонг; при возможности — short",
        "decay": "рынок всё лучше учитывает расписание",
        "risk_premium_or_alpha": "структурное ограничение",
        "alternative_explanations": ["общий альт-моментум", "листинг", "рыночный режим"],
        "crowding_indicator": "снижение pre-drift после 2025",
        "half_life": "2-3 года",
    },
    {"venue_class": "CEX бессрочные", "instrument": "USDT-перпетуал", "assets": ["ликвидные альт-перпы"], "data_vendor_class": "публичные календари unlock"},
    {"bar_minutes": 1440, "holding_minutes": 20160, "target_move_bps": 300, "decision_latency_ms": 1000},
    {"inputs": ["days_to_unlock", "unlock_pct_float", "float", "market_cap", "age"], "rule": "days_to_unlock in [5, 30] and unlock_pct_float > 1% and age < 18m", "direction": "DOWN", "entry": "short perp или отказ от лонга", "exit": "за 2 дня до unlock", "invalidation": "цена выше entry на 10%", "parameters": {"window_days": [5, 30], "min_pct_float": 1.0}},
    base_availability("дата unlock известна заранее", "календарь публичен", "в любой момент"),
    base_ai("извлечение событий из текста", "календарь можно парсить; LLM полезен для грязных источников"),
    {"simple_algorithm": "short за 30 дней до unlock >1% float", "comparison_ladder": ["buy-and-hold", "short all alts", "short unlock", "short thin-float unlock", "ML"], "expected_uplift": "10-20% на сделку", "base_rate": "средняя доходность альта"},
    {"fee_bps": 5, "spread_bps": 10, "slippage_bps": 15, "funding_bps": 5, "round_trip_bps": 35, "model": "альт-перп taker + широкий спред", "adverse_case_bps": 80, "capacity_note": "небольшой размер, иначе impact"},
    {"tier": "T1", "why": "нужен календарь unlock и исторические перпы", "harness": "Tokenomist/Keyrock + бары", "missing_data": ["полный календарь с историей"], "required_build": "парсер календаря"},
    {"n_planned": 150, "min_detectable_effect": "10% на событие", "power_note": "150 событий достаточно для крупного эффекта", "test_method": "event study + matched peers", "multiplicity_budget": 4, "correction": "DSR", "concentration_risk": "несколько крупных unlock"},
    {"success_criterion": "pre-drift > 5% после издержек на OOS", "kill_criterion": "эффект исчезает у ликвидных токенов или после 2025", "cheapest_experiment": "event study на 236 событиях", "expected_cost": "0", "expected_runtime": "1 неделя", "stop_rule": "после 150 событий", "confidence": 0.35},
    base_evidence(["S268", "S269", "S270", "S083"], ["S271"], 3, 1, ["Сколько остаётся после 2025?", "Можно ли шортить перп?"], {"механизм": 3, "независимость_подтверждений": 3, "качество_данных": 3, "исполнение": 2, "устойчивость_к_издержкам": 2, "стоимость_проверки": 4}),
))

# H009 Listing/delisting
H.append(hyp(
    "H009", "Календарь листингов и делистингов: событийная торговля",
    {
        "actor": "биржа, объявляющая листинг/делистинг; маркет-мейкеры, входящие в новую книгу",
        "constraint": "листинг создаёт новый пул покупателей; делистинг отрезает пул и заставляет продавать",
        "observable": "анонс и дата начала/прекращения торгов",
        "opportunity": "fade первого часа листинга; избегать/шортить делистинг",
        "action": "событийная ставка с малым размером",
        "decay": "рынок привыкает к календарю; эффект сжимается",
        "risk_premium_or_alpha": "структурное ограничение",
        "alternative_explanations": ["общий альт-режим", "ликвидация книги", "новостной шум"],
        "crowding_indicator": "снижение первого часа",
        "half_life": "1-2 года",
    },
    {"venue_class": "CEX спот", "instrument": "спот-пара", "assets": ["новые листинги", "делистинги"], "data_vendor_class": "публичные анонсы бирж"},
    {"bar_minutes": 1, "holding_minutes": 240, "target_move_bps": 100, "decision_latency_ms": 1000},
    {"inputs": ["announcement_time", "listing_time", "delisting_time", "spread", "depth"], "rule": "listing first 60 min or delisting announcement", "direction": "BOTH", "entry": "limit после открытия", "exit": "через 1-4 часа", "invalidation": "spread > 5%", "parameters": {"first_hour": 60}},
    base_availability("анонс", "в момент публикации", "после публикации, но ликвидность может быть нулевой"),
    base_ai("извлечение событий из текста", "парсинг анонсов; LLM для нормализации"),
    {"simple_algorithm": "fade первый час листинга", "comparison_ladder": ["buy-and-hold", "fade listing", "avoid delisting", "ML"], "expected_uplift": "20-50 bps на событие", "base_rate": "средняя доходность дня"},
    {"fee_bps": 8, "spread_bps": 30, "slippage_bps": 30, "funding_bps": 0, "round_trip_bps": 68, "model": "спот taker + широкий спред", "adverse_case_bps": 150, "capacity_note": "очень малый размер"},
    {"tier": "T1", "why": "нужен архив анонсов и минутные бары", "harness": "биржевые анонсы + 1-минутные бары", "missing_data": ["архив анонсов"], "required_build": "парсер и календарь"},
    {"n_planned": 100, "min_detectable_effect": "30 bps", "power_note": "мало событий; выводы осторожные", "test_method": "event study", "multiplicity_budget": 4, "correction": "DSR", "concentration_risk": "крупные листинги доминируют"},
    {"success_criterion": "net PnL > 20 bps на событие", "kill_criterion": "эффект исчезает после 2025 или издержки выше", "cheapest_experiment": "event study на 100 событиях", "expected_cost": "0", "expected_runtime": "1 неделя", "stop_rule": "после 100 событий", "confidence": 0.3},
    base_evidence(["S272", "S274", "S275"], ["S288"], 2, 1, ["Доступен ли шорт при делистинге?", "Сколько остаётся после издержек?"], {"механизм": 3, "независимость_подтверждений": 2, "качество_данных": 3, "исполнение": 1, "устойчивость_к_издержкам": 1, "стоимость_проверки": 4}),
))

# H010 ETF flow
H.append(hyp(
    "H010", "ETF-потоки как медленный моментум",
    {
        "actor": "инвесторы, создающие/погашающие ETF; уполномоченные участники",
        "constraint": "ETF-поток — это реальный спрос/предложение спота, но публикуется с задержкой",
        "observable": "дневные net flows и AUM",
        "opportunity": "поток предсказывает доходность на 1-10 дней",
        "action": "лонг BTC при устойчивом притоке, хедж перпом",
        "decay": "рынок учится; потоки становятся эндогенными",
        "risk_premium_or_alpha": "премия за риск",
        "alternative_explanations": ["цена вызывает поток", "общий риск-аппетит"],
        "crowding_indicator": "рост корреляции flow и цены",
        "half_life": "2-3 года",
    },
    {"venue_class": "межплощадочное", "instrument": "spot BTC + perp", "assets": ["BTC-USDT", "BTC-USDT-SWAP"], "data_vendor_class": "публичные ETF flows"},
    {"bar_minutes": 1440, "holding_minutes": 10080, "target_move_bps": 100, "decision_latency_ms": 1000},
    {"inputs": ["etf_net_flow_1d", "etf_flow_5d", "price", "funding"], "rule": "5d cumulative flow > q80 and price > ma20", "direction": "UP", "entry": "spot long + perp hedge при высоком funding", "exit": "через 5-10 дней", "invalidation": "flow меняет знак", "parameters": {"window_days": 5}},
    base_availability("после закрытия US рынка", "вечером US", "на следующий день"),
    base_ai("объединение сигналов", "простое правило, ML для режима"),
    {"simple_algorithm": "лонг при 5-дневном притоке > $100M", "comparison_ladder": ["buy-and-hold", "flow", "flow + trend", "ML"], "expected_uplift": "20-40 bps на сделку", "base_rate": "средняя 5-дневная доходность"},
    {"fee_bps": 5, "spread_bps": 2, "slippage_bps": 3, "funding_bps": 2, "round_trip_bps": 12, "model": "spot+perp, две ноги", "adverse_case_bps": 25, "capacity_note": "средний размер"},
    {"tier": "T1", "why": "нужны исторические ETF flows", "harness": "публичные данные + бары", "missing_data": ["полная история flows"], "required_build": "парсер"},
    {"n_planned": 600, "min_detectable_effect": "10 bps", "power_note": "600 дней достаточно", "test_method": "CPCV с embargo 10 дней", "multiplicity_budget": 5, "correction": "DSR", "concentration_risk": "2024-2025 доминируют"},
    {"success_criterion": "net PnL > 10 bps на сделку", "kill_criterion": "эффект объясняется ценой (эндогенность)", "cheapest_experiment": "регрессия flow → forward return", "expected_cost": "0", "expected_runtime": "1 неделя", "stop_rule": "после 600 дней", "confidence": 0.35},
    base_evidence(["S290", "S291", "S292", "S294"], ["S293"], 3, 1, ["Эндогенность flow и цены", "Сколько остаётся после хеджа"], {"механизм": 3, "независимость_подтверждений": 3, "качество_данных": 4, "исполнение": 4, "устойчивость_к_издержкам": 3, "стоимость_проверки": 4}),
))

# H011 Stablecoin mint
H.append(hyp(
    "H011", "Крупные mint/burn стейблкоинов как медленный поток капитала",
    {
        "actor": "Tether/Circle и авторизованные участники",
        "constraint": "mint создаёт новый стейблкоин, который должен быть размещён; burn — отток",
        "observable": "Transfer с/на zero address, supply",
        "opportunity": "крупный mint предшествует притоку капитала в крипто",
        "action": "лонг BTC/ETH при крупном mint, удержание 1-7 дней",
        "decay": "mint может быть техническим, а не покупкой",
        "risk_premium_or_alpha": "неизвестно",
        "alternative_explanations": ["переезд между сетями", "инвентарь биржи", "плановая эмиссия"],
        "crowding_indicator": "рост supply без роста цены",
        "half_life": "неизвестен",
    },
    {"venue_class": "межплощадочное", "instrument": "on-chain + spot", "assets": ["BTC", "ETH"], "data_vendor_class": "публичный on-chain"},
    {"bar_minutes": 1440, "holding_minutes": 4320, "target_move_bps": 80, "decision_latency_ms": 1000},
    {"inputs": ["usdt_mint_1d", "usdc_mint_1d", "supply_change", "exchange_netflow"], "rule": "mint > $100M and exchange_netflow < 0", "direction": "UP", "entry": "spot", "exit": "через 1-7 дней", "invalidation": "mint сопровождается burn", "parameters": {"min_mint_usd": 100_000_000}},
    base_availability("момент транзакции", "сразу on-chain", "после подтверждения"),
    base_ai("извлечение событий из текста", "on-chain правило, LLM не нужен"),
    {"simple_algorithm": "mint > $100M → long 3 дня", "comparison_ladder": ["buy-and-hold", "mint", "mint + netflow", "ML"], "expected_uplift": "10-20 bps", "base_rate": "средняя 3-дневная доходность"},
    {"fee_bps": 5, "spread_bps": 2, "slippage_bps": 3, "funding_bps": 1, "round_trip_bps": 11, "model": "spot taker", "adverse_case_bps": 25, "capacity_note": "средний размер"},
    {"tier": "T1", "why": "нужны on-chain данные с дедупликацией", "harness": "Dune/DeFiLlama + бары", "missing_data": ["чистая история mint/burn"], "required_build": "пайплайн on-chain"},
    {"n_planned": 300, "min_detectable_effect": "15 bps", "power_note": "300 событий — минимум", "test_method": "event study", "multiplicity_budget": 4, "correction": "DSR", "concentration_risk": "крупные эпизоды"},
    {"success_criterion": "net PnL > 10 bps на событие", "kill_criterion": "mint не отличается от технического", "cheapest_experiment": "event study на 300 mint", "expected_cost": "0", "expected_runtime": "1 неделя", "stop_rule": "после 300 событий", "confidence": 0.25},
    base_evidence(["S247", "S085"], ["S334"], 2, 2, ["Технические mint", "Дедупликация сетей"], {"механизм": 2, "независимость_подтверждений": 2, "качество_данных": 3, "исполнение": 4, "устойчивость_к_издержкам": 3, "стоимость_проверки": 4}),
))

# H012 Options expiry
H.append(hyp(
    "H012", "Экспирация Deribit и хеджирование дилеров",
    {
        "actor": "маркет-мейкеры опционов, управляющие гаммой",
        "constraint": "при приближении экспирации дельта-хедж меняется быстро",
        "observable": "OI по страйкам, дата экспирации 08:00 UTC",
        "opportunity": "поток хеджей вокруг крупных страйков",
        "action": "торговать волатильность/направление в окне экспирации",
        "decay": "рынок адаптируется; объёмы Deribit растут",
        "risk_premium_or_alpha": "структурное ограничение",
        "alternative_explanations": ["spot-движение", "новости", "общий режим"],
        "crowding_indicator": "снижение эффекта вокруг экспирации",
        "half_life": "1-3 года",
    },
    {"venue_class": "опционы", "instrument": "BTC/ETH options + perp", "assets": ["BTC", "ETH"], "data_vendor_class": "Deribit public API + Tardis"},
    {"bar_minutes": 15, "holding_minutes": 240, "target_move_bps": 50, "decision_latency_ms": 1000},
    {"inputs": ["expiry_time", "strike_oi", "gamma", "spot", "iv"], "rule": "expiry day and large strike cluster within 2%", "direction": "BOTH", "entry": "в 07:00-08:00 UTC", "exit": "после 08:00", "invalidation": "spot ушёл от страйка", "parameters": {"expiry_hour_utc": 8}},
    base_availability("08:00 UTC пятницы", "заранее", "в момент"),
    base_ai("объединение сигналов", "нужен расчёт гаммы"),
    {"simple_algorithm": "покупать вол перед экспирацией", "comparison_ladder": ["без торговли", "vol", "pin к страйку", "gamma-хедж"], "expected_uplift": "10-20 bps", "base_rate": "средняя волатильность"},
    {"fee_bps": 5, "spread_bps": 5, "slippage_bps": 5, "funding_bps": 1, "round_trip_bps": 16, "model": "perp taker + спред", "adverse_case_bps": 35, "capacity_note": "малый размер"},
    {"tier": "T2", "why": "нужны опционные данные и греки", "harness": "Deribit/Tardis + симулятор", "missing_data": ["исторические греки"], "required_build": "опционный пайплайн"},
    {"n_planned": 100, "min_detectable_effect": "20 bps", "power_note": "мало экспираций", "test_method": "event study", "multiplicity_budget": 5, "correction": "DSR", "concentration_risk": "квартальные экспирации"},
    {"success_criterion": "net PnL > 10 bps в окне", "kill_criterion": "эффект исчезает после 2025", "cheapest_experiment": "event study на 100 экспирациях", "expected_cost": "данные Deribit", "expected_runtime": "2 недели", "stop_rule": "после 100 событий", "confidence": 0.25},
    base_evidence(["S278", "S279", "S277"], ["S276"], 2, 1, ["Max pain не работает", "Гамма-поток неизвестен"], {"механизм": 2, "независимость_подтверждений": 2, "качество_данных": 2, "исполнение": 3, "устойчивость_к_издержкам": 2, "стоимость_проверки": 2}),
))

# H013 Basis/carry
H.append(hyp(
    "H013", "Кэрри: long spot / short perp при высоком funding",
    {
        "actor": "арбитражёры, ограниченные капиталом и маржой",
        "constraint": "нужно финансировать обе ноги; short perp требует маржи",
        "observable": "funding и basis",
        "opportunity": "собирать funding, пока он положительный",
        "action": "long spot + short perp, ребаланс",
        "decay": "приток арбитражного капитала сжимает basis",
        "risk_premium_or_alpha": "премия за риск",
        "alternative_explanations": ["риск ликвидации short leg", "counterparty risk"],
        "crowding_indicator": "снижение среднего funding",
        "half_life": "месяцы",
    },
    {"venue_class": "межплощадочное", "instrument": "spot + perp", "assets": ["BTC", "ETH"], "data_vendor_class": "публичные funding/basis"},
    {"bar_minutes": 480, "holding_minutes": 43200, "target_move_bps": 0, "decision_latency_ms": 1000},
    {"inputs": ["funding_8h", "basis", "margin", "liquidation_price"], "rule": "funding_8h > q70 and basis > 0", "direction": "NEUTRAL", "entry": "spot long + perp short", "exit": "при funding < q30", "invalidation": "margin call", "parameters": {"entry_q": 0.7}},
    base_availability("каждые 8 ч", "сразу", "в момент"),
    base_ai("настройка исполнения", "правило, LLM не нужен"),
    {"simple_algorithm": "всегда long spot / short perp", "comparison_ladder": ["buy-and-hold", "carry always", "carry timing", "carry + risk overlay"], "expected_uplift": "2-3% в месяц", "base_rate": "средний funding"},
    {"fee_bps": 5, "spread_bps": 2, "slippage_bps": 3, "funding_bps": -8, "round_trip_bps": 20, "model": "две ноги, комиссии и funding", "adverse_case_bps": 60, "capacity_note": "зависит от маржи"},
    {"tier": "T1", "why": "нужны исторические funding и basis", "harness": "биржа + бары", "missing_data": ["полный basis history"], "required_build": "учёт двух ног"},
    {"n_planned": 1000, "min_detectable_effect": "10 bps в месяц", "power_note": "1000 дней достаточно", "test_method": "walk-forward", "multiplicity_budget": 3, "correction": "DSR", "concentration_risk": "2021 и 2025"},
    {"success_criterion": "Sharpe > 1 после издержек и без плеча", "kill_criterion": "max drawdown > 20% или funding < 0", "cheapest_experiment": "бэктест на funding history", "expected_cost": "0", "expected_runtime": "1 неделя", "stop_rule": "после 1000 дней", "confidence": 0.45},
    base_evidence(["S075", "S333", "S335", "S009"], ["S079"], 3, 1, ["Ликвидация short leg", "Counterparty risk"], {"механизм": 5, "независимость_подтверждений": 3, "качество_данных": 4, "исполнение": 3, "устойчивость_к_издержкам": 4, "стоимость_проверки": 4}),
))

# H014 Macro event
H.append(hyp(
    "H014", "Макро-события: внутридневной моментум после CPI/FOMC",
    {
        "actor": "макро-фонды и алгоритмы, переставляющие позиции после релиза",
        "constraint": "релиз создаёт скачок информации; реакция растянута",
        "observable": "календарь CPI/FOMC; первые 30 минут после релиза",
        "opportunity": "продолжение движения после первоначальной реакции",
        "action": "вход после первых 15-30 минут, удержание до конца дня",
        "decay": "рынок учится; HFT арбитрирует",
        "risk_premium_or_alpha": "структурное ограничение",
        "alternative_explanations": ["случайный шум", "общий риск-аппетит"],
        "crowding_indicator": "снижение эффекта после 2024",
        "half_life": "2-3 года",
    },
    {"venue_class": "CEX бессрочные", "instrument": "USDT-перпетуал", "assets": ["BTC-USDT-SWAP", "ETH-USDT-SWAP"], "data_vendor_class": "публичный календарь + 1-минутные бары"},
    {"bar_minutes": 15, "holding_minutes": 360, "target_move_bps": 40, "decision_latency_ms": 1000},
    {"inputs": ["event_type", "surprise", "first_30m_return", "volume", "spread"], "rule": "CPI/FOMC day and |first_30m_return| > q80", "direction": "BOTH", "entry": "после 30 минут", "exit": "конец дня", "invalidation": "возврат к pre-event", "parameters": {"events": ["CPI", "FOMC"]}},
    base_availability("фиксированное время релиза", "сразу", "в момент"),
    base_ai("объединение сигналов", "правило + фильтр волатильности"),
    {"simple_algorithm": "знак первых 30 минут → до конца дня", "comparison_ladder": ["без торговли", "buy-and-hold", "momentum", "momentum + surprise", "ML"], "expected_uplift": "15-30 bps", "base_rate": "средняя доходность дня"},
    {"fee_bps": 5, "spread_bps": 5, "slippage_bps": 5, "funding_bps": 1, "round_trip_bps": 16, "model": "taker + расширенный спред", "adverse_case_bps": 40, "capacity_note": "малый размер"},
    {"tier": "T1", "why": "нужен календарь и минутные бары", "harness": "исторические события", "missing_data": [], "required_build": "календарь"},
    {"n_planned": 100, "min_detectable_effect": "20 bps", "power_note": "мало событий", "test_method": "event study", "multiplicity_budget": 4, "correction": "DSR", "concentration_risk": "крупные CPI"},
    {"success_criterion": "net PnL > 15 bps на событие", "kill_criterion": "эффект исчезает после 2024", "cheapest_experiment": "event study на 100 событиях", "expected_cost": "0", "expected_runtime": "1 неделя", "stop_rule": "после 100 событий", "confidence": 0.3},
    base_evidence(["S345", "S293", "S347"], ["S239"], 2, 1, ["Сколько остаётся после 2024", "Спред в момент релиза"], {"механизм": 3, "независимость_подтверждений": 2, "качество_данных": 4, "исполнение": 2, "устойчивость_к_издержкам": 2, "стоимость_проверки": 4}),
))


if __name__ == "__main__":
    # hypotheses.jsonl
    with open(os.path.join(BASE, "hypotheses.jsonl"), "w", encoding="utf-8") as f:
        for h in H:
            f.write(json.dumps(h, ensure_ascii=False) + "\n")
    print("hypotheses", len(H))
