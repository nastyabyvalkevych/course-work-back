import { ReliabilityProfile } from './markov'

/**
 * Operational profile of the risk API. Module reliabilities and sojourn times
 * come from the test plan (docs/тест_план_і_надійність.md): autocannon load
 * tests, fault injection and the unit/e2e suites. Task weights approximate
 * how the Next.js pages call the API (a ranking page = summary + ranking,
 * a company page = card + graph, the map = regions + ranking).
 *
 * Outage rates (`failureRatePerHour`, calendar time) are rough estimates from
 * incidents seen over ~340 hours of development and fault-injection sessions;
 * they drive the continuous-time model, while `reliability` (per request) drives
 * the discrete one.
 *
 * Tasks that end in `_hit` have a `_miss` twin; when Redis is unavailable the
 * live evaluation moves the hit weight onto the miss path.
 */
export const DEFAULT_PROFILE: ReliabilityProfile = {
    system: 'Prozorro collusion-risk API (NestJS)',
    version: '2026-09',
    requestsPerHour: 3600,
    meanRepairMinutes: 5,
    modules: [
        {
            id: 'gateway',
            name: 'HTTP-шлюз (Express, маршрутизація, розбір параметрів)',
            reliability: 0.99999,
            meanSojournMs: 1,
            evidence: '0 помилок на ~200 тис. запитів autocannon; збої: бекенд перезапускався 6 разів за 340 год робіт, усі планові; закладено 1 позаплановий на ~500 год',
            failureRatePerHour: 0.002,
        },
        {
            id: 'risk_controller',
            name: 'RiskController (валідація запиту, делегування)',
            reliability: 0.9999,
            meanSojournMs: 0.5,
            evidence: '11 jest-тестів контракту, 7 e2e; збої: без стану, відмовляє лише разом із процесом',
            failureRatePerHour: 0,
        },
        {
            id: 'risk_service',
            name: 'RiskService (побудова SQL, агрегація, формування відповіді)',
            reliability: 0.9995,
            meanSojournMs: 3,
            evidence: 'e2e на реальній базі; 1 помилка 404 на 825 холодних запитів; збої: без стану, відмовляє лише разом із процесом',
            failureRatePerHour: 0,
        },
        {
            id: 'redis_cache',
            name: 'Кеш Redis (м’який, таймаут 200 мс)',
            reliability: 0.9995,
            meanSojournMs: 2,
            evidence: 'fault injection: зупинка Redis → HTTP 200 за <0,6 с; збої: 1 зупинка Redis (fault injection) за період спостереження',
            failureRatePerHour: 0.001,
        },
        {
            id: 'postgres',
            name: 'PostgreSQL через Prisma (CTE-запити, індекси)',
            reliability: 0.998,
            meanSojournMs: 250,
            evidence: 'холодна картка 0,27–0,65 с, ranking p50 86 мс, tender p50 47 мс; збої: 1 аварійна зупинка (переповнення диска Docker) за 340 год',
            failureRatePerHour: 0.003,
        },
        {
            id: 'prozorro_client',
            name: 'Клієнт публічного API Prozorro (зовнішня залежність)',
            reliability: 0.97,
            meanSojournMs: 800,
            evidence: 'збір даних: 429/таймаути ≈3 % запитів при паузі 250 мс; збої: періодичні 429/недоступність публічного API',
            failureRatePerHour: 0.02,
        },
        {
            id: 'health',
            name: 'HealthController (SELECT 1 з таймаутом 2 с)',
            reliability: 0.9999,
            meanSojournMs: 2,
            evidence: 'fault injection: 503 за 2,0 с при паузі бази; збої: без стану',
            failureRatePerHour: 0,
        },
    ],
    tasks: [
        { id: 'summary_hit', name: 'Зведення /risk/summary (кеш)', weight: 20, path: ['gateway', 'risk_controller', 'risk_service', 'redis_cache'], observedSuccessRate: 1 },
        { id: 'summary_miss', name: 'Зведення /risk/summary (без кешу)', weight: 2, path: ['gateway', 'risk_controller', 'risk_service', 'redis_cache', 'postgres', 'risk_service', 'redis_cache'] },
        { id: 'ranking', name: 'Рейтинг компаній /risk/ranking', weight: 20, path: ['gateway', 'risk_controller', 'risk_service', 'postgres', 'risk_service'], observedSuccessRate: 1 },
        { id: 'regions_hit', name: 'Мапа областей /risk/regions (кеш)', weight: 4, path: ['gateway', 'risk_controller', 'risk_service', 'redis_cache'] },
        { id: 'regions_miss', name: 'Мапа областей /risk/regions (без кешу)', weight: 1, path: ['gateway', 'risk_controller', 'risk_service', 'redis_cache', 'postgres', 'risk_service', 'redis_cache'] },
        { id: 'company_hit', name: 'Картка компанії (кеш)', weight: 12, path: ['gateway', 'risk_controller', 'risk_service', 'redis_cache'], observedSuccessRate: 1 },
        { id: 'company_miss', name: 'Картка компанії (без кешу)', weight: 6, path: ['gateway', 'risk_controller', 'risk_service', 'redis_cache', 'postgres', 'postgres', 'risk_service', 'redis_cache'], observedSuccessRate: 0.9988 },
        { id: 'graph_hit', name: 'Граф партнерів (кеш)', weight: 10, path: ['gateway', 'risk_controller', 'risk_service', 'redis_cache'], observedSuccessRate: 1 },
        { id: 'graph_miss', name: 'Граф партнерів (без кешу)', weight: 5, path: ['gateway', 'risk_controller', 'risk_service', 'redis_cache', 'postgres', 'risk_service', 'redis_cache'] },
        { id: 'tender', name: 'Картка тендера з бази', weight: 8, path: ['gateway', 'risk_controller', 'risk_service', 'postgres', 'risk_service'], observedSuccessRate: 1 },
        { id: 'tender_fetch', name: 'Картка тендера з довантаженням із Prozorro', weight: 2, path: ['gateway', 'risk_controller', 'risk_service', 'postgres', 'prozorro_client', 'postgres', 'risk_service'] },
        { id: 'health', name: 'Перевірка /health', weight: 3, path: ['gateway', 'health', 'postgres'], observedSuccessRate: 1 },
    ],
}
