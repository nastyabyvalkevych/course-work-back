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
                },
            }),
            this.prisma.companyRisk.count({ where }),
        ])
        return { total, limit, offset, items }
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
                SELECT DISTINCT p."tenderId" FROM "Participation" p WHERE p.edrpou = ${edrpou} AND p.role = 'bidder'
            ),
            recent AS (
                SELECT t.id, t."rawData"->>'tenderID' AS "tenderID", t.title, t."procuringEntity",
                       t."datePublished", t."valueAmount"
                FROM "Tender" t JOIN mine ON mine."tenderId" = t.id
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
