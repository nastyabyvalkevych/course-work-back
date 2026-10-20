import { Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { PrismaService } from '../prisma/prisma.service'
import { RedisService } from '../redis/redis.service'

/** Company card columns in the pre-normalisation order (v_company_card keeps the old names). */
const CARD_COLUMNS = Prisma.sql`edrpou, name, score, rank, percentile, label, "firstDecision", "group", coverage,
    "nTenders", "nWon", coalesce("winRate", 0)::float8 AS "winRate", degree, region`

type CardRow = {
    edrpou: string
    name: string | null
    score: number
    rank: number
    percentile: number
    label: boolean
    firstDecision: Date | null
    group: string
    coverage: string
    nTenders: number
    nWon: number
    winRate: number
    degree: number
    region: string | null
}

type Neighbor = { edrpou?: string; orgCode?: string; name?: string | null; weight?: number; score?: number; label?: boolean; influence?: number }

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
        const [total, [known], byGroup, decisions, tenders] = await Promise.all([
            this.prisma.companyRisk.count(),
            this.prisma.$queryRaw<{ c: number }[]>(Prisma.sql`SELECT count(*)::int AS c FROM v_company_card WHERE label`),
            this.prisma.$queryRaw<{ group: string; coverage: string; count: number }[]>(Prisma.sql`
                SELECT "group", coverage, count(*)::int AS count FROM v_company_card GROUP BY "group", coverage`),
            this.prisma.amcuRegisterRow.groupBy({
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
            companiesInRegister: known.c,
            tendersInDatabase: tenders,
            coverage: byGroup.map((g) => ({
                group: g.group,
                coverage: g.coverage,
                count: g.count,
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
        const cond: Prisma.Sql[] = [Prisma.sql`"nTenders" >= ${params.minTenders ?? 5}`]
        if (params.excludeKnown) {
            cond.push(Prisma.sql`NOT label`)
        }
        if (params.fullCoverageOnly) {
            cond.push(Prisma.sql`coverage = 'full'`)
        }
        if (params.region && params.region.trim()) {
            cond.push(Prisma.sql`region = ${params.region.trim()}`)
        }
        if (params.q && params.q.trim()) {
            const q = params.q.trim()
            cond.push(Prisma.sql`(strpos(edrpou, ${q}) > 0 OR name ILIKE ${'%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%'})`)
        }
        const where = Prisma.join(cond, ' AND ')
        // the page shows "why" chips per row: it needs the feature values and how many
        // of the closest partners are already sanctioned, not the neighbour list itself.
        // A neighbour's own label is used when the pipeline stored it, the register otherwise.
        const [items, [count]] = await Promise.all([
            this.prisma.$queryRaw<Array<CardRow & { features: unknown; sanctionedNeighbors: number }>>(Prisma.sql`
                SELECT ${CARD_COLUMNS}, c.features,
                       (SELECT count(*)::int FROM jsonb_array_elements(
                                CASE WHEN jsonb_typeof(c."topNeighbors") = 'array' THEN c."topNeighbors" ELSE '[]'::jsonb END) n
                         WHERE CASE WHEN n ? 'label' THEN coalesce((n->>'label')::boolean, false)
                                    ELSE EXISTS (SELECT 1 FROM v_org_amcu a WHERE a."orgCode" = coalesce(n->>'orgCode', n->>'edrpou')) END
                       ) AS "sanctionedNeighbors"
                  FROM v_company_card c
                 WHERE ${where}
                 ORDER BY score DESC, rank, edrpou
                 OFFSET ${offset} LIMIT ${limit}`),
            this.prisma.$queryRaw<{ c: number }[]>(Prisma.sql`SELECT count(*)::int AS c FROM v_company_card WHERE ${where}`),
        ])
        return { total: count.c, limit, offset, items }
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
            FROM v_company_card c, jsonb_each(c.features::jsonb) f
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
                SELECT region, score, label, "nTenders" FROM v_company_card
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
        const [card] = await this.prisma.$queryRaw<
            Array<CardRow & { features: unknown; contributions: unknown; topNeighbors: unknown; modelVersion: string; computedAt: Date }>
        >(Prisma.sql`
            SELECT ${CARD_COLUMNS}, features, contributions, "topNeighbors", "modelVersion", "computedAt"
              FROM v_company_card WHERE edrpou = ${edrpou}`)
        if (!card) {
            throw new NotFoundException(
                `Company ${edrpou} is not in the scored graph (no bids found).`,
            )
        }
        const [decisions, coBidders, recent, topNeighbors] = await Promise.all([
            // one row per decision and court event (the register keeps a row per court event)
            this.prisma.$queryRaw<
                Array<{ decisionNumber: string; decisionDate: Date; body: string | null; courtCaseNumber: string | null; courtContent: string | null }>
            >(Prisma.sql`
                SELECT d.number AS "decisionNumber", d.date AS "decisionDate", d.body,
                       ce."caseNumber" AS "courtCaseNumber", ce.content AS "courtContent"
                  FROM "DecisionParty" p
                  JOIN "Decision" d ON d.id = p."decisionId"
                  LEFT JOIN "CourtEvent" ce ON ce."decisionId" = p."decisionId" AND ce.code = p.code
                 WHERE p.code = ${edrpou}
                 ORDER BY d.date DESC, d.number, ce."courtDate" NULLS LAST, ce.id`),
            this.coBidders(edrpou, 25),
            this.recentTenders(edrpou, 15),
            this.neighbors(card.topNeighbors),
        ])
        const response = { ...card, topNeighbors, decisions, coBidders, recentTenders: recent }
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
        const [center] = await this.prisma.$queryRaw<CardRow[]>(Prisma.sql`
            SELECT ${CARD_COLUMNS} FROM v_company_card WHERE edrpou = ${edrpou}`)
        if (!center) {
            throw new NotFoundException(`Company ${edrpou} not found`)
        }
        const partners = await this.coBidders(edrpou, limit)
        const ids = [edrpou, ...partners.map((p) => p.edrpou)]
        // edges among the partners themselves (so triangles / cliques are visible)
        const inner = await this.prisma.$queryRaw<
            Array<{ a: string; b: string; weight: number }>
        >(Prisma.sql`
            SELECT p1."orgCode" AS a, p2."orgCode" AS b, COUNT(DISTINCT p1."tenderId")::int AS weight
            FROM "Bid" p1
            JOIN "Bid" p2
              ON p2."tenderId" = p1."tenderId" AND p2."orgCode" > p1."orgCode"
            WHERE p1."orgCode" = ANY(${ids}) AND p2."orgCode" = ANY(${ids})
            GROUP BY p1."orgCode", p2."orgCode"
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
        const [risk] = await this.prisma.$queryRaw<Array<{ label: boolean; firstDecision: Date | null }>>(Prisma.sql`
            SELECT label, "firstDecision" FROM v_company_card WHERE edrpou = ${edrpou}`)
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
            WITH my_bids AS (
                SELECT "tenderId", "lotId", amount::float8 AS amount, "bidDate"
                FROM "Bid"
                WHERE "orgCode" = ${edrpou} AND COALESCE("datePublished", '1900-01-01') < ${cut}
            ),
            mine AS (                       -- one bid per tender: the lowest; its lot gives the expected value
                SELECT "tenderId", MIN(amount) AS amount, MIN("bidDate") AS bid_date,
                       (ARRAY_AGG("lotId" ORDER BY amount NULLS LAST))[1] AS lot_id
                FROM my_bids GROUP BY "tenderId"
            ),
            bids AS (                       -- every bidder by its code in the card (placeholder codes too, as before)
                SELECT p."tenderId", p."codeInCard" AS edrpou, MIN(p.amount)::float8 AS amount, MIN(p."bidDate") AS bid_date
                FROM "Bid" p JOIN mine m ON m."tenderId" = p."tenderId"
                GROUP BY p."tenderId", p."codeInCard"
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
                SELECT DISTINCT ON (w."tenderId") w."tenderId", w."codeInCard" AS edrpou
                FROM "Award" w JOIN mine m ON m."tenderId" = w."tenderId"
                ORDER BY w."tenderId", (w."codeInCard" = ${edrpou}) DESC, w.id
            )
            SELECT t.id, t."tenderID", t.title, t."procuringEntity" AS buyer,
                   t."datePublished", COALESCE(l."valueAmount"::float8, t."valueAmount") AS "valueAmount",
                   a.bidders, a.min_amount AS "minAmount", a.second_amount AS "secondAmount", a.cv, m.amount, m.bid_date AS "bidDate",
                   w.edrpou AS winner,
                   (pb.edrpou IS NOT NULL) AS "partnerIn", pb.amount AS "partnerAmount", pb.bid_date AS "partnerBidDate"
            FROM mine m
            JOIN "Tender" t ON t.id = m."tenderId"
            JOIN agg a ON a."tenderId" = m."tenderId"
            LEFT JOIN "Lot" l ON l."tenderId" = m."tenderId" AND l."lotId" = m.lot_id
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
            tenderId = (await this.prisma.tender.findUnique({ where: { tenderID: idOrUid }, select: { id: true } }))?.id ?? null
        }
        const tender = tenderId
            ? await this.prisma.tender.findUnique({
                  where: { id: tenderId },
                  select: {
                      id: true,
                      prozorroId: true,
                      tenderID: true,
                      procurementMethodType: true,
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
        // participants by the code in their card (placeholder codes included, as before);
        // a participant won if there is an award to the same code in this tender
        const bidders = await this.prisma.$queryRaw<Array<{ edrpou: string; name: string | null; bidAmount: number | null }>>(Prisma.sql`
            SELECT edrpou, name, "bidAmount" FROM (
                SELECT DISTINCT ON (b."codeInCard") b."codeInCard" AS edrpou, b."nameInCard" AS name,
                       b.amount::float8 AS "bidAmount", MIN(b.id) OVER (PARTITION BY b."codeInCard") AS first_id
                  FROM "Bid" b WHERE b."tenderId" = ${tender.id}
                 ORDER BY b."codeInCard", b.id DESC
            ) x ORDER BY first_id`)
        const winners = new Set(
            (await this.prisma.award.findMany({ where: { tenderId: tender.id }, select: { codeInCard: true } })).map((a) => a.codeInCard),
        )
        const risks = bidders.length
            ? await this.prisma.$queryRaw<CardRow[]>(Prisma.sql`
                SELECT ${CARD_COLUMNS} FROM v_company_card WHERE edrpou = ANY(${bidders.map((b) => b.edrpou)})`)
            : []
        const riskBy = new Map(risks.map((r) => [r.edrpou, r]))
        const ids = bidders.map((b) => b.edrpou)
        const pairs = ids.length > 1
            ? await this.prisma.$queryRaw<
                  Array<{ a: string; b: string; shared: number; a_won: number; b_won: number }>
              >(Prisma.sql`
                WITH bids AS (
                    SELECT DISTINCT "tenderId", "orgCode" AS edrpou FROM "Bid"
                    WHERE "orgCode" = ANY(${ids}) AND "tenderId" <> ${tender.id}
                ),
                wins AS (
                    SELECT DISTINCT "tenderId", "orgCode" AS edrpou FROM "Award"
                    WHERE "orgCode" = ANY(${ids})
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
                tenderID: tender.tenderID ?? raw?.tenderID ?? null,
                title: tender.title,
                procuringEntity: tender.procuringEntity,
                buyerEdrpou: tender.buyerEdrpou ?? ((raw?.procuringEntity as Record<string, unknown> | undefined)?.identifier as Record<string, unknown> | undefined)?.id ?? null,
                valueAmount: tender.valueAmount === null ? null : Number(tender.valueAmount),
                valueCurrency: tender.valueCurrency,
                status: tender.status,
                datePublished: tender.datePublished,
                procurementMethodType: tender.procurementMethodType ?? raw?.procurementMethodType ?? null,
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
            if (y.cutoffYear == null) continue
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
        const where = Prisma.sql`"cutoffYear" = ${cutoffYear} AND NOT "knownAtCutoff" AND "nTenders" >= ${minTenders}
            ${fullOnly ? Prisma.sql`AND coverage = 'full'` : Prisma.empty}`
        const orderBy = fullOnly ? Prisma.sql`"rankFull" ASC NULLS LAST, edrpou` : Prisma.sql`rank ASC, edrpou`
        type Row = {
            edrpou: string; name: string | null; score: number; rank: number; rankFull: number | null; group: string; coverage: string
            nTenders: number; degree: number; firstDecision: Date | null; outcome: string
        }
        const columns = Prisma.sql`edrpou, name, score, rank, "rankFull", "group", coverage, "nTenders", degree, "firstDecision", outcome`
        const [top, caught, metrics] = await Promise.all([
            this.prisma.$queryRaw<Row[]>(Prisma.sql`SELECT ${columns} FROM v_risk_backtest WHERE ${where} ORDER BY ${orderBy} LIMIT ${limit}`),
            this.prisma.$queryRaw<Row[]>(Prisma.sql`SELECT ${columns} FROM v_risk_backtest WHERE ${where} AND outcome = 'caught' ORDER BY ${orderBy}`),
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
        const rows = await this.prisma.$queryRaw<Array<{
            cutoffYear: number; cutoffDate: Date; score: number; rankFull: number | null; rank: number; nTenders: number
            coverage: string; knownAtCutoff: boolean; outcome: string; firstDecision: Date | null
        }>>(Prisma.sql`
            SELECT "cutoffYear", "cutoffDate", score, "rankFull", rank, "nTenders", coverage, "knownAtCutoff", outcome, "firstDecision"
              FROM v_risk_backtest WHERE edrpou = ${edrpou} ORDER BY "cutoffYear" ASC, "cutoffDate" ASC`)
        if (!rows.length) return []
        const pops = await this.prisma.$queryRaw<Array<{ cutoffYear: number; c: number }>>(Prisma.sql`
            SELECT "cutoffYear", count(*)::int AS c FROM v_risk_backtest
             WHERE NOT "knownAtCutoff" AND coverage = 'full' AND "nTenders" >= 5 GROUP BY "cutoffYear"`)
        const popBy = new Map(pops.map((p) => [p.cutoffYear, p.c]))
        const out: Record<string, unknown>[] = []
        for (const r of rows) {
            if (r.knownAtCutoff) { out.push({ ...r, position: null, population: null, note: 'уже в реєстрі на дату зрізу' }); continue }
            const cond = Prisma.sql`"cutoffYear" = ${r.cutoffYear} AND "knownAtCutoff" = false AND coverage = 'full' AND "nTenders" >= 5`
            const pos = r.coverage === 'full' && r.nTenders >= 5
                ? (await this.prisma.$queryRaw<{ c: number }[]>(Prisma.sql`SELECT count(*)::int AS c FROM v_risk_backtest WHERE ${cond} AND score > ${r.score}`))[0].c + 1
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
              FROM v_risk_backtest
             WHERE "cutoffYear" = ${cutoffYear} AND "knownAtCutoff" = false ${covFilter}
             ORDER BY ${rankCol} ASC NULLS LAST, edrpou`)
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
            Array<{ edrpou: string; name: string | null; shared: number; they_won: number; we_won: number; score: number | null; label: boolean | null; rank: number | null }>
        >(Prisma.sql`
            WITH mine AS (
                SELECT DISTINCT "tenderId" FROM "Bid" WHERE "orgCode" = ${edrpou}
            ),
            bids AS (                       -- one row per (tender, partner), no lot duplicates
                SELECT DISTINCT b."tenderId", b."orgCode" AS edrpou
                FROM "Bid" b JOIN mine ON mine."tenderId" = b."tenderId"
                WHERE b."orgCode" IS NOT NULL AND b."orgCode" <> ${edrpou}
            ),
            wins AS (                       -- winners in my tenders (partners and me)
                SELECT DISTINCT w."tenderId", w."orgCode" AS edrpou
                FROM "Award" w JOIN mine ON mine."tenderId" = w."tenderId"
                WHERE w."orgCode" IS NOT NULL
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
                ORDER BY shared DESC, b.edrpou
                LIMIT ${limit}
            )
            SELECT t.edrpou, o.name, t.shared, t.they_won, t.we_won, c.score, c.label, c.rank
            FROM top t
            LEFT JOIN "Organization" o ON o.code = t.edrpou
            LEFT JOIN v_company_card c ON c.edrpou = t.edrpou
            ORDER BY t.shared DESC, t.edrpou
        `)
        return rows.map((r) => ({
            edrpou: r.edrpou,
            name: r.name,
            sharedTenders: r.shared,
            theyWon: r.they_won,
            weWon: r.we_won,
            score: r.score ?? null,
            label: r.label ?? null,
            rank: r.rank ?? null,
        }))
    }

    /**
     * The pipeline stores neighbours by orgCode; the card shows them in the old shape
     * {edrpou, name, weight, score, label, influence}, filling name and label from the
     * organisation and the register when they were not stored.
     */
    private async neighbors(raw: unknown) {
        const list = Array.isArray(raw) ? (raw as Neighbor[]) : []
        const codes = list.map((n) => n.edrpou ?? n.orgCode).filter((c): c is string => !!c)
        const known = codes.length
            ? await this.prisma.$queryRaw<Array<{ code: string; name: string | null; label: boolean }>>(Prisma.sql`
                SELECT o.code, o.name, (a."orgCode" IS NOT NULL) AS label
                  FROM "Organization" o LEFT JOIN v_org_amcu a ON a."orgCode" = o.code
                 WHERE o.code = ANY(${codes})`)
            : []
        const by = new Map(known.map((k) => [k.code, k]))
        return list.map(({ orgCode, edrpou, name, label, ...rest }) => {
            const code = edrpou ?? orgCode ?? ''
            const k = by.get(code)
            return { edrpou: code, name: name ?? k?.name ?? null, ...rest, label: label ?? k?.label ?? false }
        })
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
                SELECT DISTINCT "tenderId" FROM "Bid" WHERE "orgCode" = ${edrpou}
            ),
            recent AS (
                SELECT t.id, t."tenderID", t.title, t."procuringEntity",
                       t."datePublished", t."valueAmount"::float8 AS "valueAmount"
                FROM "Tender" t JOIN mine m ON m."tenderId" = t.id
                ORDER BY t."datePublished" DESC NULLS LAST
                LIMIT ${limit}
            ),
            cnt AS (
                SELECT b."tenderId", COUNT(DISTINCT b."codeInCard")::int AS bidders
                FROM "Bid" b JOIN recent r ON r.id = b."tenderId"
                GROUP BY b."tenderId"
            ),
            won AS (
                SELECT DISTINCT w."tenderId" FROM "Award" w JOIN recent r ON r.id = w."tenderId"
                WHERE w."orgCode" = ${edrpou}
            )
            SELECT r.*, COALESCE(c.bidders, 0) AS bidders, (won."tenderId" IS NOT NULL) AS won
            FROM recent r LEFT JOIN cnt c ON c."tenderId" = r.id LEFT JOIN won ON won."tenderId" = r.id
            ORDER BY r."datePublished" DESC NULLS LAST
        `)
    }
}
