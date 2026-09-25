import { Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { PrismaService } from '../prisma/prisma.service'
import { RedisService } from '../redis/redis.service'

type CoBidder = {
    edrpou: string
    name: string | null
    sharedTenders: number
    theyWon: number
    weWon: number
    score: number | null
    label: boolean | null
    rank: number | null
}

@Injectable()
export class RiskService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly redisService: RedisService,
    ) {}

    /** Model version, counts and score distribution for the /risk landing page. */
    async summary() {
        const cacheKey = 'risk:summary'
        const cached = await this.redisService.get(cacheKey)
        if (cached) {
            return cached
        }
        const latest = await this.prisma.companyRisk.findFirst({
            orderBy: { computedAt: 'desc' },
            select: { modelVersion: true, computedAt: true },
        })
        if (!latest) {
            throw new NotFoundException(
                'Risk scores not computed yet. Run evaluation/ml/score_companies.py.',
            )
        }
        const [total, known, byGroup, decisions, tenders] = await Promise.all([
            this.prisma.companyRisk.count(),
            this.prisma.companyRisk.count({ where: { label: true } }),
            this.prisma.companyRisk.groupBy({
                by: ['group', 'coverage'],
                _count: { _all: true },
            }),
            this.prisma.amcuDecision.groupBy({
                by: ['registerVersion'],
                _count: { _all: true },
                _max: { decisionDate: true },
            }),
            this.prisma.tender.count(),
        ])
        const response = {
            modelVersion: latest.modelVersion,
            computedAt: latest.computedAt,
            companiesScored: total,
            companiesInRegister: known,
            tendersInDatabase: tenders,
            coverage: byGroup.map((g) => ({
                group: g.group,
                coverage: g.coverage,
                count: g._count._all,
            })),
            register: decisions.map((d) => ({
                version: d.registerVersion,
                rows: d._count._all,
                latestDecision: d._max.decisionDate,
            })),
        }
        await this.redisService.set(cacheKey, response, 300)
        return response
    }

    /** Top companies by risk. `excludeKnown` hides companies already in the register. */
    async ranking(params: {
        limit?: number
        offset?: number
        minTenders?: number
        excludeKnown?: boolean
        fullCoverageOnly?: boolean
        q?: string
        region?: string
    }) {
        const limit = Math.min(Math.max(params.limit ?? 50, 1), 200)
        const offset = Math.max(params.offset ?? 0, 0)
        const where: Prisma.CompanyRiskWhereInput = {
            nTenders: { gte: params.minTenders ?? 5 },
        }
        if (params.excludeKnown) {
            where.label = false
        }
        if (params.fullCoverageOnly) {
            where.coverage = 'full'
        }
        if (params.region && params.region.trim()) {
            where.region = params.region.trim()
        }
        if (params.q && params.q.trim()) {
            const q = params.q.trim()
            where.OR = [
                { edrpou: { contains: q } },
                { name: { contains: q, mode: 'insensitive' } },
            ]
        }
        const [items, total] = await Promise.all([
            this.prisma.companyRisk.findMany({
                where,
                orderBy: { score: 'desc' },
                skip: offset,
                take: limit,
                select: {
                    edrpou: true,
                    name: true,
                    score: true,
                    rank: true,
                    percentile: true,
                    label: true,
                    firstDecision: true,
                    group: true,
                    coverage: true,
                    nTenders: true,
                    nWon: true,
                    winRate: true,
                    degree: true,
                    region: true,
                    features: true,
                    topNeighbors: true,
                },
            }),
            this.prisma.companyRisk.count({ where }),
        ])
        // the page shows "why" chips per row: it needs the feature values and how many
        // of the closest partners are already sanctioned, not the neighbour list itself
        return {
            total,
            limit,
            offset,
            items: items.map(({ topNeighbors, ...rest }) => ({
                ...rest,
                sanctionedNeighbors: Array.isArray(topNeighbors)
                    ? (topNeighbors as Array<{ label?: boolean }>).filter((n) => n?.label).length
                    : 0,
            })),
        }
    }

    /**
     * Median and 90th percentile of every model feature among companies with 10+ tenders
     * that are not in the register: the "typical company" the card compares against.
     */
    async featureNorms() {
        const cacheKey = 'risk:feature-norms'
        const cached = await this.redisService.get(cacheKey)
        if (cached) {
            return cached
        }
        const rows = await this.prisma.$queryRaw<Array<{ feature: string; p50: number; p90: number }>>(Prisma.sql`
            SELECT f.key AS feature,
                   PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY f.value::text::float)::float AS p50,
                   PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY f.value::text::float)::float AS p90
            FROM "CompanyRisk" c, jsonb_each(c.features::jsonb) f
            WHERE c."nTenders" >= 10 AND NOT c.label AND jsonb_typeof(f.value) = 'number'
            GROUP BY f.key
        `)
        const response = Object.fromEntries(rows.map((r) => [r.feature, { p50: r.p50, p90: r.p90 }]))
        await this.redisService.set(cacheKey, response, 3600)
        return response
    }

    /** Per-oblast aggregates for the map: companies, sanctioned, high-risk share, mean risk, tenders. */
    async regions(minTenders = 5) {
        const cacheKey = `risk:regions:${minTenders}`
        const cached = await this.redisService.get(cacheKey)
        if (cached) {
            return cached
        }
        const rows = await this.prisma.$queryRaw<
            Array<{
                region: string
                companies: number
                sanctioned: number
                high_risk: number
                mean_score: number
                median_score: number
                tenders_as_bidder: number
            }>
        >(Prisma.sql`
            WITH c AS (
                SELECT region, score, label, "nTenders" FROM "CompanyRisk"
                WHERE region IS NOT NULL AND "nTenders" >= ${minTenders}
            )
            SELECT region,
                   COUNT(*)::int AS companies,
                   COUNT(*) FILTER (WHERE label)::int AS sanctioned,
                   COUNT(*) FILTER (WHERE score >= 0.7)::int AS high_risk,
                   AVG(score)::float AS mean_score,
                   PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY score)::float AS median_score,
                   SUM("nTenders")::int AS tenders_as_bidder
            FROM c GROUP BY region ORDER BY companies DESC
        `)
        const total = rows.reduce((a, r) => a + r.companies, 0)
        const response = {
            minTenders,
            totalCompanies: total,
            regions: rows.map((r) => ({
                region: r.region,
                companies: r.companies,
                sanctioned: r.sanctioned,
                sanctionedShare: r.companies ? r.sanctioned / r.companies : 0,
                highRisk: r.high_risk,
                highRiskShare: r.companies ? r.high_risk / r.companies : 0,
                meanScore: r.mean_score,
                medianScore: r.median_score,
                tendersAsBidder: r.tenders_as_bidder,
            })),
        }
        await this.redisService.set(cacheKey, response, 3600)
        return response
    }

    /** Full company card: score, explanation, register decisions, co-bidders. */
    async company(edrpou: string) {
        const cacheKey = `risk:company:${edrpou}`
        const cached = await this.redisService.get(cacheKey)
        if (cached) {
            return cached
        }
        const risk = await this.prisma.companyRisk.findUnique({ where: { edrpou } })
        if (!risk) {
            throw new NotFoundException(
                `Company ${edrpou} is not in the scored graph (no bids found).`,
            )
        }
        const [decisions, coBidders, recent] = await Promise.all([
            this.prisma.amcuDecision.findMany({
                where: { edrpou },
                orderBy: { decisionDate: 'desc' },
                select: {
                    decisionNumber: true,
                    decisionDate: true,
                    body: true,
                    courtCaseNumber: true,
                    courtContent: true,
                },
            }),
            this.coBidders(edrpou, 25),
            this.recentTenders(edrpou, 15),
        ])
        const response = { ...risk, decisions, coBidders, recentTenders: recent }
        await this.redisService.set(cacheKey, response, 3600)
        return response
    }

    /** Ego network (depth 1) for the graph view. */
    async graph(edrpou: string, limit = 40) {
        limit = Math.min(Math.max(limit, 1), 300)
        const cacheKey = `risk:graph:${edrpou}:${limit}`
        const cached = await this.redisService.get(cacheKey)
        if (cached) {
            return cached
        }
        const center = await this.prisma.companyRisk.findUnique({ where: { edrpou } })
        if (!center) {
            throw new NotFoundException(`Company ${edrpou} not found`)
        }
        const partners = await this.coBidders(edrpou, limit)
        const ids = [edrpou, ...partners.map((p) => p.edrpou)]
        // edges among the partners themselves (so triangles / cliques are visible)
        const inner = await this.prisma.$queryRaw<
            Array<{ a: string; b: string; weight: number }>
        >(Prisma.sql`
            SELECT p1.edrpou AS a, p2.edrpou AS b, COUNT(DISTINCT p1."tenderId")::int AS weight
            FROM "Participation" p1
            JOIN "Participation" p2
              ON p2."tenderId" = p1."tenderId" AND p2.role = 'bidder' AND p2.edrpou > p1.edrpou
            WHERE p1.role = 'bidder'
              AND p1.edrpou = ANY(${ids}) AND p2.edrpou = ANY(${ids})
            GROUP BY p1.edrpou, p2.edrpou
        `)
        const nodes = [
            {
                edrpou: center.edrpou,
                name: center.name,
                score: center.score,
                label: center.label,
                nTenders: center.nTenders,
                center: true,
            },
            ...partners.map((p) => ({
                edrpou: p.edrpou,
                name: p.name,
                score: p.score,
                label: p.label,
                nTenders: p.sharedTenders,
                center: false,
            })),
        ]
        const response = { nodes, edges: inner.map((e) => ({ source: e.a, target: e.b, weight: e.weight })) }
        await this.redisService.set(cacheKey, response, 3600)
        return response
    }

    /**
     * Concrete tenders behind each collusion signal on the company card: which tenders
     * had two bidders, bids without a discount, near-identical or same-hour bids with
     * the top partner, and so on. Same rules as evaluation/build_graph.py and
     * extra_features.py (one bid per tender = the lowest lot amount; for a sanctioned
     * company only tenders before its first decision).
     */
    async evidence(edrpou: string) {
        const cacheKey = `risk:evidence:${edrpou}`
        const cached = await this.redisService.get(cacheKey)
        if (cached) {
            return cached
        }
        const risk = await this.prisma.companyRisk.findUnique({
            where: { edrpou },
            select: { label: true, firstDecision: true },
        })
        if (!risk) {
            throw new NotFoundException(`Company ${edrpou} not found`)
        }
        const [partner] = await this.coBidders(edrpou, 1)
        const cut = risk.label && risk.firstDecision ? risk.firstDecision : new Date('2100-01-01')
        const rows = await this.prisma.$queryRaw<
            Array<{
                id: number
                tenderID: string | null
                title: string | null
                buyer: string | null
                datePublished: Date | null
                valueAmount: number | null
                bidders: number
                minAmount: number | null
                secondAmount: number | null
                cv: number | null
                amount: number | null
                bidDate: Date | null
                winner: string | null
                partnerIn: boolean
                partnerAmount: number | null
                partnerBidDate: Date | null
            }>
        >(Prisma.sql`
            WITH mine AS (
                SELECT "tenderId", MIN("bidAmount") AS amount, MIN("bidDate") AS bid_date,
                       MIN("prozorroTenderId") AS tender_uid
                FROM "Participation"
                WHERE edrpou = ${edrpou} AND role = 'bidder' AND COALESCE("datePublished", '1900-01-01') < ${cut}
                GROUP BY "tenderId"
            ),
            bids AS (
                SELECT p."tenderId", p.edrpou, MIN(p."bidAmount") AS amount, MIN(p."bidDate") AS bid_date
                FROM "Participation" p JOIN mine m ON m."tenderId" = p."tenderId"
                WHERE p.role = 'bidder'
                GROUP BY p."tenderId", p.edrpou
            ),
            agg AS (
                SELECT "tenderId", COUNT(*)::int AS bidders, MIN(amount) AS min_amount,
                       (ARRAY_AGG(amount ORDER BY amount) FILTER (WHERE amount IS NOT NULL))[2] AS second_amount,
                       CASE WHEN COUNT(amount) >= 2 AND AVG(amount) > 0
                            THEN (STDDEV_POP(amount) / AVG(amount))::float END AS cv
                FROM bids GROUP BY "tenderId"
            ),
            pb AS MATERIALIZED (            -- the top partner's bids, filtered once (a join on bids loops per row)
                SELECT * FROM bids WHERE edrpou = ${partner?.edrpou ?? ''}
            ),
            win AS (
                SELECT DISTINCT ON (w."tenderId") w."tenderId", w.edrpou
                FROM "Participation" w JOIN mine m ON m."tenderId" = w."tenderId"
                WHERE w.role = 'winner'
                ORDER BY w."tenderId", (w.edrpou = ${edrpou}) DESC
            )
            SELECT t.id, m.tender_uid AS "tenderID", t.title, t."procuringEntity" AS buyer,
                   t."datePublished", t."valueAmount",
                   a.bidders, a.min_amount AS "minAmount", a.second_amount AS "secondAmount", a.cv, m.amount, m.bid_date AS "bidDate",
                   w.edrpou AS winner,
                   (pb.edrpou IS NOT NULL) AS "partnerIn", pb.amount AS "partnerAmount", pb.bid_date AS "partnerBidDate"
            FROM mine m
            JOIN "Tender" t ON t.id = m."tenderId"
            JOIN agg a ON a."tenderId" = m."tenderId"
            LEFT JOIN win w ON w."tenderId" = m."tenderId"
            LEFT JOIN pb ON pb."tenderId" = m."tenderId"
            ORDER BY t."datePublished" DESC NULLS LAST
        `)
        type Row = (typeof rows)[number]
        const minutes = (r: Row) =>
            r.bidDate && r.partnerBidDate ? Math.abs(r.bidDate.getTime() - r.partnerBidDate.getTime()) / 60000 : null
        const example = (r: Row) => ({
            id: r.id,
            tenderID: r.tenderID,
            title: r.title,
            buyer: r.buyer,
            datePublished: r.datePublished,
            valueAmount: r.valueAmount,
            bidders: r.bidders,
            amount: r.amount,
            minAmount: r.minAmount,
            secondAmount: r.secondAmount,
            cv: r.cv,
            partnerAmount: r.partnerIn ? r.partnerAmount : null,
            minutesToPartner: r.partnerIn ? minutes(r) : null,
            winner: r.winner === edrpou ? 'self' : partner && r.winner === partner.edrpou ? 'partner' : r.winner ? 'other' : null,
        })
        const tests: Record<string, (r: Row) => boolean> = {
            two_bidders: (r) => r.bidders === 2,
            cover_bids: (r) => !!r.amount && !!r.valueAmount && r.amount / r.valueAmount >= 0.99,
            lost_cheapest: (r) =>
                r.winner !== edrpou && r.amount != null && r.minAmount != null && r.amount <= r.minAmount + 1e-6 && r.bidders > 1,
            won_not_cheapest: (r) => r.winner === edrpou && r.amount != null && r.minAmount != null && r.amount > r.minAmount + 1e-6,
            with_partner: (r) => r.partnerIn,
            near_identical: (r) =>
                r.partnerIn && !!r.amount && !!r.partnerAmount && !!r.valueAmount &&
                Math.abs(r.amount - r.partnerAmount) / r.valueAmount < 0.01,
            fast_bids: (r) => r.partnerIn && (minutes(r) ?? Infinity) <= 60,
            round_bids: (r) => !!r.amount && r.amount >= 1000 && Math.abs(r.amount / 1000 - Math.round(r.amount / 1000)) < 1e-9,
            small_gap: (r) =>
                !!r.minAmount && !!r.secondAmount && (r.secondAmount - r.minAmount) / r.minAmount <= 0.02,
            similar_bids: (r) => r.cv != null && r.cv <= 0.03,
            single_bidder: (r) => r.bidders === 1,
        }
        const signals = Object.fromEntries(
            Object.entries(tests).map(([k, test]) => {
                const hit = rows.filter(test)
                return [k, { count: hit.length, examples: hit.slice(0, 10).map(example) }]
            }),
        )
        const buyers = new Map<string, { name: string; tenders: number; won: number }>()
        for (const r of rows) {
            if (!r.buyer) continue
            const b = buyers.get(r.buyer) ?? { name: r.buyer, tenders: 0, won: 0 }
            b.tenders += 1
            if (r.winner === edrpou) b.won += 1
            buyers.set(r.buyer, b)
        }
        const pairRows = rows.filter((r) => r.partnerIn)
        const response = {
            tenders: rows.length,
            cutoff: risk.label ? risk.firstDecision : null,
            partner: partner
                ? {
                      ...partner,
                      pairWonSelf: pairRows.filter((r) => r.winner === edrpou).length,
                      pairWonPartner: pairRows.filter((r) => r.winner === partner.edrpou).length,
                  }
                : null,
            topBuyers: [...buyers.values()].sort((a, b) => b.tenders - a.tenders).slice(0, 5),
            signals,
        }
        await this.redisService.set(cacheKey, response, 3600)
        return response
    }

    /** Tender card: participants with risk and their pairwise co-bidding history. */
    async tender(idOrUid: string) {
        let tenderId: number | null = null
        if (/^\d+$/.test(idOrUid)) {
            tenderId = Number(idOrUid)
        } else if (/^[0-9a-f]{32}$/.test(idOrUid)) {
            tenderId = (await this.prisma.tender.findUnique({ where: { prozorroId: idOrUid }, select: { id: true } }))?.id ?? null
        } else {
            tenderId = (await this.prisma.participation.findFirst({
                where: { prozorroTenderId: idOrUid },
                select: { tenderId: true },
            }))?.tenderId ?? null
        }
        const tender = tenderId
            ? await this.prisma.tender.findUnique({
                  where: { id: tenderId },
                  select: {
                      id: true,
                      prozorroId: true,
                      title: true,
                      procuringEntity: true,
                      valueAmount: true,
                      valueCurrency: true,
                      status: true,
                      datePublished: true,
                      buyerEdrpou: true,
                      rawData: true,
                  },
              })
            : null
        if (!tender) {
            throw new NotFoundException(`Tender ${idOrUid} not found in the local mirror`)
        }
        const raw = tender.rawData as Record<string, unknown>
        const parts = await this.prisma.participation.findMany({
            where: { tenderId: tender.id },
            select: { edrpou: true, name: true, role: true, bidAmount: true, isWinner: true },
        })
        const bidders = Array.from(new Map(parts.filter((p) => p.role === 'bidder').map((p) => [p.edrpou, p])).values())
        const winners = new Set(parts.filter((p) => p.role === 'winner').map((p) => p.edrpou))
        const risks = await this.prisma.companyRisk.findMany({
            where: { edrpou: { in: bidders.map((b) => b.edrpou) } },
        })
        const riskBy = new Map(risks.map((r) => [r.edrpou, r]))
        const ids = bidders.map((b) => b.edrpou)
        const pairs = ids.length > 1
            ? await this.prisma.$queryRaw<
                  Array<{ a: string; b: string; shared: number; a_won: number; b_won: number }>
              >(Prisma.sql`
                WITH bids AS (
                    SELECT DISTINCT "tenderId", edrpou FROM "Participation"
                    WHERE role = 'bidder' AND edrpou = ANY(${ids}) AND "tenderId" <> ${tender.id}
                ),
                wins AS (
                    SELECT DISTINCT "tenderId", edrpou FROM "Participation"
                    WHERE role = 'winner' AND edrpou = ANY(${ids})
                )
                SELECT p1.edrpou AS a, p2.edrpou AS b,
                       COUNT(*)::int AS shared,
                       COUNT(wa."tenderId")::int AS a_won,
                       COUNT(wb."tenderId")::int AS b_won
                FROM bids p1
                JOIN bids p2 ON p2."tenderId" = p1."tenderId" AND p2.edrpou > p1.edrpou
                LEFT JOIN wins wa ON wa."tenderId" = p1."tenderId" AND wa.edrpou = p1.edrpou
                LEFT JOIN wins wb ON wb."tenderId" = p1."tenderId" AND wb.edrpou = p2.edrpou
                GROUP BY p1.edrpou, p2.edrpou
              `)
            : []
        const maxScore = Math.max(0, ...risks.map((r) => r.score))
        const knownPairs = pairs.filter((p) => p.shared >= 3).length
        return {
            tender: {
                id: tender.id,
                prozorroId: tender.prozorroId,
                tenderID: raw?.tenderID ?? null,
                title: tender.title,
                procuringEntity: tender.procuringEntity,
                buyerEdrpou: tender.buyerEdrpou ?? ((raw?.procuringEntity as Record<string, unknown> | undefined)?.identifier as Record<string, unknown> | undefined)?.id ?? null,
                valueAmount: tender.valueAmount,
                valueCurrency: tender.valueCurrency,
                status: tender.status,
                datePublished: tender.datePublished,
                procurementMethodType: raw?.procurementMethodType ?? null,
            },
            participants: bidders.map((b) => {
                const r = riskBy.get(b.edrpou)
                return {
                    edrpou: b.edrpou,
                    name: b.name,
                    bidAmount: b.bidAmount,
                    isWinner: winners.has(b.edrpou),
                    score: r?.score ?? null,
                    rank: r?.rank ?? null,
                    label: r?.label ?? false,
                    nTenders: r?.nTenders ?? null,
                    winRate: r?.winRate ?? null,
                }
            }),
            pairs: pairs.map((p) => ({
                a: p.a,
                b: p.b,
                sharedTenders: p.shared,
                aWon: p.a_won,
                bWon: p.b_won,
            })),
            signals: {
                biddersCount: bidders.length,
                maxParticipantScore: maxScore,
                knownParticipants: risks.filter((r) => r.label).length,
                repeatedPairs: knownPairs,
                tenderRisk: Math.min(1, maxScore * 0.7 + (knownPairs > 0 ? 0.3 : 0)),
            },
        }
    }

    // ------------------------------------------------------------------ helpers --

    /** Available backtest cutoffs with headline metrics on the fair population. */
    async backtests() {
        const cacheKey = 'risk:backtests'
        const cached = await this.redisService.get(cacheKey)
        if (cached) return cached
        const years = await this.prisma.riskBacktest.groupBy({
            by: ['cutoffYear', 'cutoffDate', 'modelVersion'],
            _count: { _all: true },
            orderBy: { cutoffYear: 'asc' },
        })
        const items: Record<string, unknown>[] = []
        for (const y of years) {
            const m = await this.backtestMetrics(y.cutoffYear, true, [50, 100, 200, 500])
            const { positions: _p, ...pub } = m
            void _p
            items.push({ cutoffYear: y.cutoffYear, cutoffDate: y.cutoffDate, modelVersion: y.modelVersion, companies: y._count._all, ...pub })
        }
        const result = { items }
        await this.redisService.set(cacheKey, result, 3600)
        return result
    }

    /**
     * Retrospective view for one cutoff: top-ranked companies as of 31.12.cutoffYear with
     * what happened next, precision@k curve against the base rate, and where the companies
     * AMCU sanctioned later stood in the ranking.
     */
    async backtest(cutoffYear: number, params: { limit?: number; fullCoverageOnly?: boolean; minTenders?: number }) {
        const limit = Math.min(Math.max(params.limit ?? 100, 1), 500)
        const fullOnly = params.fullCoverageOnly ?? true
        const minTenders = Math.max(params.minTenders ?? 5, 0)
        const cacheKey = `risk:backtest:${cutoffYear}:${limit}:${fullOnly ? 1 : 0}:${minTenders}`
        const cached = await this.redisService.get(cacheKey)
        if (cached) return cached
        const any = await this.prisma.riskBacktest.findFirst({ where: { cutoffYear }, select: { cutoffDate: true, modelVersion: true, computedAt: true } })
        if (!any) throw new NotFoundException(`No backtest for cutoff ${cutoffYear}`)
        const where: Prisma.RiskBacktestWhereInput = { cutoffYear, knownAtCutoff: false, nTenders: { gte: minTenders } }
        if (fullOnly) where.coverage = 'full'
        const select = {
            edrpou: true, name: true, score: true, rank: true, rankFull: true, group: true, coverage: true,
            nTenders: true, degree: true, firstDecision: true, outcome: true,
        } as const
        const orderBy = fullOnly ? { rankFull: 'asc' as const } : { rank: 'asc' as const }
        const [top, caught, metrics] = await Promise.all([
            this.prisma.riskBacktest.findMany({ where, orderBy, take: limit, select }),
            this.prisma.riskBacktest.findMany({ where: { ...where, outcome: 'caught' }, orderBy, select }),
            this.backtestMetrics(cutoffYear, fullOnly, [10, 20, 50, 100, 200, 300, 500, 1000], minTenders),
        ])
        const population = metrics.population
        // rank among companies unknown at the cutoff (the list a user would actually have seen)
        const pos = metrics.positions
        const caughtRows = caught.map((c) => {
            const r = pos.get(c.edrpou) ?? (fullOnly ? (c.rankFull ?? c.rank) : c.rank)
            return { ...c, rankUsed: r, percentile: population ? 100 * (1 - (r - 1) / population) : null }
        })
        const { positions: _positions, ...publicMetrics } = metrics
        void _positions
        const result = {
            cutoffYear,
            cutoffDate: any.cutoffDate,
            modelVersion: any.modelVersion,
            computedAt: any.computedAt,
            fullCoverageOnly: fullOnly,
            minTenders,
            ...publicMetrics,
            top: top.map((t) => ({ ...t, rankUsed: pos.get(t.edrpou) ?? (fullOnly ? (t.rankFull ?? t.rank) : t.rank) })),
            caughtLater: caughtRows,
        }
        await this.redisService.set(cacheKey, result, 3600)
        return result
    }

    /** How earlier snapshots ranked this company (RiskBacktest), for the company card. */
    async companyHistory(edrpou: string) {
        const rows = await this.prisma.riskBacktest.findMany({ where: { edrpou }, orderBy: { cutoffYear: 'asc' },
            select: { cutoffYear: true, cutoffDate: true, score: true, rankFull: true, rank: true, nTenders: true, coverage: true, knownAtCutoff: true, outcome: true, firstDecision: true } })
        if (!rows.length) return []
        const pops = await this.prisma.riskBacktest.groupBy({ by: ['cutoffYear'], where: { knownAtCutoff: false, coverage: 'full', nTenders: { gte: 5 } }, _count: { _all: true } })
        const popBy = new Map(pops.map((p) => [p.cutoffYear, p._count._all]))
        const out: Record<string, unknown>[] = []
        for (const r of rows) {
            if (r.knownAtCutoff) { out.push({ ...r, position: null, population: null, note: 'уже в реєстрі на дату зрізу' }); continue }
            const cond = Prisma.sql`"cutoffYear" = ${r.cutoffYear} AND "knownAtCutoff" = false AND coverage = 'full' AND "nTenders" >= 5`
            const pos = r.coverage === 'full' && r.nTenders >= 5
                ? (await this.prisma.$queryRaw<{ c: number }[]>(Prisma.sql`SELECT count(*)::int AS c FROM "RiskBacktest" WHERE ${cond} AND score > ${r.score}`))[0].c + 1
                : null
            out.push({ ...r, position: pos, population: popBy.get(r.cutoffYear) ?? null, note: pos === null ? 'мало історії на дату зрізу, у список не входила' : null })
        }
        return out
    }

    /** precision@k, recall@k, base rate and lift on companies unknown at the cutoff. */
    private async backtestMetrics(cutoffYear: number, fullOnly: boolean, ks: number[], minTenders = 5) {
        const covFilter = fullOnly ? Prisma.sql`AND coverage = 'full' AND "nTenders" >= ${minTenders}` : Prisma.sql`AND "nTenders" >= ${minTenders}`
        const rankCol = fullOnly ? Prisma.sql`"rankFull"` : Prisma.sql`rank`
        const rows = await this.prisma.$queryRaw<{ edrpou: string; r: number; caught: boolean }[]>(Prisma.sql`
            SELECT edrpou, ${rankCol} AS r, (outcome = 'caught') AS caught
              FROM "RiskBacktest"
             WHERE "cutoffYear" = ${cutoffYear} AND "knownAtCutoff" = false ${covFilter}
             ORDER BY ${rankCol} ASC`)
        const population = rows.length
        const totalCaught = rows.filter((x) => x.caught).length
        const baseRate = population ? totalCaught / population : 0
        let hits = 0
        const curve: { k: number; precision: number; recall: number; lift: number }[] = []
        const wanted = new Set(ks.filter((k) => k <= population))
        const positions = new Map<string, number>()
        rows.forEach((x, i) => {
            positions.set(x.edrpou, i + 1)
            if (x.caught) hits++
            const k = i + 1
            if (wanted.has(k)) {
                curve.push({ k, precision: hits / k, recall: totalCaught ? hits / totalCaught : 0, lift: baseRate ? hits / k / baseRate : 0 })
            }
        })
        // share of later-sanctioned companies that the model placed in the top 10 %
        const top10 = Math.ceil(population * 0.1)
        const caughtInTop10 = rows.slice(0, top10).filter((x) => x.caught).length
        return {
            population,
            totalCaught,
            baseRate,
            curve,
            recallTop10Pct: totalCaught ? caughtInTop10 / totalCaught : 0,
            positions,
        }
    }

    private async coBidders(edrpou: string, limit: number): Promise<CoBidder[]> {
        const rows = await this.prisma.$queryRaw<
            Array<{ edrpou: string; name: string | null; shared: number; they_won: number; we_won: number }>
        >(Prisma.sql`
            WITH mine AS (
                SELECT DISTINCT "tenderId" FROM "Participation" WHERE edrpou = ${edrpou} AND role = 'bidder'
            ),
            bids AS (                       -- one row per (tender, partner), no lot duplicates
                SELECT DISTINCT p."tenderId", p.edrpou
                FROM "Participation" p JOIN mine ON mine."tenderId" = p."tenderId"
                WHERE p.role = 'bidder' AND p.edrpou <> ${edrpou}
            ),
            wins AS (                       -- winners in my tenders (partners and me)
                SELECT DISTINCT w."tenderId", w.edrpou
                FROM "Participation" w JOIN mine ON mine."tenderId" = w."tenderId"
                WHERE w.role = 'winner'
            ),
            top AS (
                SELECT b.edrpou,
                       COUNT(*)::int AS shared,
                       COUNT(wp."tenderId")::int AS they_won,
                       COUNT(wm."tenderId")::int AS we_won
                FROM bids b
                LEFT JOIN wins wp ON wp."tenderId" = b."tenderId" AND wp.edrpou = b.edrpou
                LEFT JOIN wins wm ON wm."tenderId" = b."tenderId" AND wm.edrpou = ${edrpou}
                GROUP BY b.edrpou
                ORDER BY shared DESC
                LIMIT ${limit}
            )
            SELECT t.edrpou,
                   COALESCE(c.name, (SELECT MIN(p.name) FROM "Participation" p WHERE p.edrpou = t.edrpou)) AS name,
                   t.shared, t.they_won, t.we_won
            FROM top t LEFT JOIN "CompanyRisk" c ON c.edrpou = t.edrpou
            ORDER BY t.shared DESC
        `)
        const risks = await this.prisma.companyRisk.findMany({
            where: { edrpou: { in: rows.map((r) => r.edrpou) } },
            select: { edrpou: true, score: true, label: true, rank: true },
        })
        const by = new Map(risks.map((r) => [r.edrpou, r]))
        return rows.map((r) => ({
            edrpou: r.edrpou,
            name: r.name,
            sharedTenders: r.shared,
            theyWon: r.they_won,
            weWon: r.we_won,
            score: by.get(r.edrpou)?.score ?? null,
            label: by.get(r.edrpou)?.label ?? null,
            rank: by.get(r.edrpou)?.rank ?? null,
        }))
    }

    private async recentTenders(edrpou: string, limit: number) {
        return this.prisma.$queryRaw<
            Array<{
                id: number
                tenderID: string | null
                title: string | null
                procuringEntity: string | null
                datePublished: Date | null
                valueAmount: number | null
                bidders: number
                won: boolean
            }>
        >(Prisma.sql`
            WITH mine AS (
                SELECT p."tenderId", MIN(p."prozorroTenderId") AS tender_uid
                FROM "Participation" p WHERE p.edrpou = ${edrpou} AND p.role = 'bidder'
                GROUP BY p."tenderId"
            ),
            recent AS (
                SELECT t.id, m.tender_uid AS "tenderID", t.title, t."procuringEntity",
                       t."datePublished", t."valueAmount"
                FROM "Tender" t JOIN mine m ON m."tenderId" = t.id
                ORDER BY t."datePublished" DESC NULLS LAST
                LIMIT ${limit}
            ),
            cnt AS (
                SELECT b."tenderId", COUNT(DISTINCT b.edrpou)::int AS bidders
                FROM "Participation" b JOIN recent r ON r.id = b."tenderId" WHERE b.role = 'bidder'
                GROUP BY b."tenderId"
            ),
            won AS (
                SELECT DISTINCT w."tenderId" FROM "Participation" w JOIN recent r ON r.id = w."tenderId"
                WHERE w.role = 'winner' AND w.edrpou = ${edrpou}
            )
            SELECT r.*, COALESCE(c.bidders, 0) AS bidders, (won."tenderId" IS NOT NULL) AS won
            FROM recent r LEFT JOIN cnt c ON c."tenderId" = r.id LEFT JOIN won ON won."tenderId" = r.id
            ORDER BY r."datePublished" DESC NULLS LAST
        `)
    }
}
