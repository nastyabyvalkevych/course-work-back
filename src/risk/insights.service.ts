import { Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { PrismaService } from '../prisma/prisma.service'
import { RedisService } from '../redis/redis.service'

/**
 * Second layer of the risk API: buyers, tight groups, shared-contact links,
 * markets and money. Everything is derived from Participation / Tender /
 * CompanyRisk plus the two loaded tables CompanyLink and TightGroup.
 */
@Injectable()
export class InsightsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly redis: RedisService,
    ) {}

    private async cached<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
        const hit = await this.redis.get(key)
        if (hit) return hit as T
        const value = await fn()
        await this.redis.set(key, value, ttl)
        return value
    }

    // ---------------------------------------------------------------- buyers

    /** Buyer (procuring entity) card: competition indicators, suppliers, repeated bidder pairs. */
    async buyer(edrpou: string) {
        return this.cached(`risk:buyer:${edrpou}`, 3600, async () => {
            const head = await this.prisma.$queryRaw<
                Array<{ name: string | null; region: string | null; tenders: number; with_bids: number; single: number; two: number;
                        value_total: number; first: Date | null; last: Date | null }>
            >(Prisma.sql`
                WITH t AS (
                    SELECT t.id, t."procuringEntity", t."buyerRegion", t."valueAmount", t."datePublished",
                           (SELECT count(DISTINCT p.edrpou) FROM "Participation" p WHERE p."tenderId" = t.id AND p.role = 'bidder') AS bidders
                      FROM "Tender" t WHERE t."buyerEdrpou" = ${edrpou}
                )
                SELECT max("procuringEntity") AS name, max("buyerRegion") AS region,
                       count(*)::int AS tenders, count(*) FILTER (WHERE bidders > 0)::int AS with_bids,
                       count(*) FILTER (WHERE bidders = 1)::int AS single, count(*) FILTER (WHERE bidders = 2)::int AS two,
                       coalesce(sum("valueAmount") FILTER (WHERE bidders > 0), 0)::float AS value_total,
                       min("datePublished") AS first, max("datePublished") AS last
                  FROM t`)
            const h = head[0]
            if (!h || !h.tenders) throw new NotFoundException(`Buyer ${edrpou} has no tenders in the local mirror`)

            const suppliers = await this.prisma.$queryRaw<
                Array<{ edrpou: string; name: string | null; bids: number; wins: number; won_amount: number; score: number | null; label: boolean | null }>
            >(Prisma.sql`
                WITH p AS (
                    SELECT p.edrpou, p.role, p."tenderId", p."bidAmount", p.name
                      FROM "Participation" p JOIN "Tender" t ON t.id = p."tenderId"
                     WHERE t."buyerEdrpou" = ${edrpou}
                ), agg AS (
                    SELECT edrpou, max(name) AS name,
                           count(DISTINCT "tenderId") FILTER (WHERE role = 'bidder')::int AS bids,
                           count(DISTINCT "tenderId") FILTER (WHERE role = 'winner')::int AS wins,
                           coalesce(sum("bidAmount") FILTER (WHERE role = 'winner'), 0)::float AS won_amount
                      FROM p GROUP BY edrpou
                )
                SELECT a.edrpou, coalesce(cr.name, a.name) AS name, a.bids, a.wins, a.won_amount, cr.score, cr.label
                  FROM agg a LEFT JOIN "CompanyRisk" cr ON cr.edrpou = a.edrpou
                 ORDER BY a.wins DESC, a.bids DESC LIMIT 25`)

            const pairs = await this.prisma.$queryRaw<
                Array<{ a: string; b: string; name_a: string | null; name_b: string | null; shared: number; a_won: number; b_won: number;
                        score_a: number | null; score_b: number | null; label_a: boolean | null; label_b: boolean | null }>
            >(Prisma.sql`
                WITH bids AS (
                    SELECT DISTINCT p."tenderId", p.edrpou FROM "Participation" p JOIN "Tender" t ON t.id = p."tenderId"
                     WHERE t."buyerEdrpou" = ${edrpou} AND p.role = 'bidder'
                ), wins AS (
                    SELECT DISTINCT p."tenderId", p.edrpou FROM "Participation" p JOIN "Tender" t ON t.id = p."tenderId"
                     WHERE t."buyerEdrpou" = ${edrpou} AND p.role = 'winner'
                ), pr AS (
                    SELECT p1.edrpou AS a, p2.edrpou AS b, count(*)::int AS shared,
                           count(wa."tenderId")::int AS a_won, count(wb."tenderId")::int AS b_won
                      FROM bids p1 JOIN bids p2 ON p2."tenderId" = p1."tenderId" AND p2.edrpou > p1.edrpou
                      LEFT JOIN wins wa ON wa."tenderId" = p1."tenderId" AND wa.edrpou = p1.edrpou
                      LEFT JOIN wins wb ON wb."tenderId" = p1."tenderId" AND wb.edrpou = p2.edrpou
                     GROUP BY p1.edrpou, p2.edrpou HAVING count(*) >= 3
                )
                SELECT pr.*, ca.name AS name_a, cb.name AS name_b, ca.score AS score_a, cb.score AS score_b, ca.label AS label_a, cb.label AS label_b
                  FROM pr LEFT JOIN "CompanyRisk" ca ON ca.edrpou = pr.a LEFT JOIN "CompanyRisk" cb ON cb.edrpou = pr.b
                 ORDER BY shared DESC LIMIT 20`)

            const recent = await this.prisma.$queryRaw<
                Array<{ id: number; tender_id: string | null; title: string | null; date: Date | null; value: number | null; bidders: number; winner: string | null; winner_score: number | null }>
            >(Prisma.sql`
                SELECT t.id, min(p."prozorroTenderId") AS tender_id, t.title, t."datePublished" AS date, t."valueAmount" AS value,
                       count(DISTINCT p.edrpou) FILTER (WHERE p.role = 'bidder')::int AS bidders,
                       max(coalesce(cr.name, p.name)) FILTER (WHERE p.role = 'winner') AS winner,
                       max(cr.score) FILTER (WHERE p.role = 'winner') AS winner_score
                  FROM "Tender" t JOIN "Participation" p ON p."tenderId" = t.id
                  LEFT JOIN "CompanyRisk" cr ON cr.edrpou = p.edrpou
                 WHERE t."buyerEdrpou" = ${edrpou}
                 GROUP BY t.id ORDER BY t."datePublished" DESC NULLS LAST LIMIT 20`)

            const highRiskSuppliers = suppliers.filter((s) => (s.score ?? 0) >= 0.7).length
            const sanctionedSuppliers = suppliers.filter((s) => s.label).length
            const wonTotal = suppliers.reduce((a, s) => a + s.won_amount, 0)
            const wonHighRisk = suppliers.filter((s) => (s.score ?? 0) >= 0.7 || s.label).reduce((a, s) => a + s.won_amount, 0)
            return {
                edrpou,
                name: h.name,
                region: h.region,
                tenders: h.tenders,
                tendersWithBids: h.with_bids,
                singleBidderShare: h.with_bids ? h.single / h.with_bids : 0,
                twoBidderShare: h.with_bids ? h.two / h.with_bids : 0,
                valueTotal: h.value_total,
                firstTender: h.first,
                lastTender: h.last,
                suppliers: suppliers.map((s) => ({ edrpou: s.edrpou, name: s.name, bids: s.bids, wins: s.wins, wonAmount: s.won_amount, score: s.score, label: !!s.label })),
                repeatedPairs: pairs.map((p) => ({ a: p.a, b: p.b, nameA: p.name_a, nameB: p.name_b, shared: p.shared, aWon: p.a_won, bWon: p.b_won,
                    scoreA: p.score_a, scoreB: p.score_b, labelA: !!p.label_a, labelB: !!p.label_b })),
                recentTenders: recent.map((r) => ({ id: r.id, tenderID: r.tender_id, title: r.title, datePublished: r.date, valueAmount: r.value, bidders: r.bidders, winner: r.winner, winnerScore: r.winner_score })),
                signals: { highRiskSuppliers, sanctionedSuppliers, repeatedPairs: pairs.length, wonTotalTop: wonTotal, wonHighRiskTop: wonHighRisk },
            }
        })
    }

    /** Buyers with the most competition problems (precomputed BuyerStats). */
    async buyers(params: { limit?: number; region?: string; minTenders?: number; q?: string; sort?: string }) {
        const limit = Math.min(Math.max(params.limit ?? 50, 1), 200)
        const minTenders = params.minTenders ?? 20
        const where: Prisma.BuyerStatsWhereInput = { tenders: { gte: minTenders } }
        if (params.region?.trim()) where.region = params.region.trim()
        if (params.q?.trim()) where.OR = [{ edrpou: params.q.trim() }, { name: { contains: params.q.trim(), mode: 'insensitive' } }]
        const rows = await this.prisma.$queryRaw<
            Array<{ edrpou: string; name: string | null; region: string | null; tenders: number; single: number; two: number;
                    high_risk_wins: number; sanctioned_wins: number; won_total: number; won_high_risk: number; repeated_pairs: number }>
        >(Prisma.sql`
            SELECT edrpou, name, region, tenders, "singleBidder" AS single, "twoBidder" AS two, "highRiskWins" AS high_risk_wins,
                   "sanctionedWins" AS sanctioned_wins, "wonTotal" AS won_total, "wonHighRisk" AS won_high_risk, "repeatedPairs" AS repeated_pairs
              FROM "BuyerStats"
             WHERE tenders >= ${minTenders}
               ${params.region?.trim() ? Prisma.sql`AND region = ${params.region.trim()}` : Prisma.empty}
               ${params.q?.trim() ? Prisma.sql`AND (edrpou = ${params.q.trim()} OR name ILIKE ${'%' + params.q.trim() + '%'})` : Prisma.empty}
             ORDER BY ${params.sort === 'money' ? Prisma.sql`"wonHighRisk" DESC` : params.sort === 'pairs' ? Prisma.sql`"repeatedPairs" DESC` : params.sort === 'single' ? Prisma.sql`"singleBidder"::float / tenders DESC` : Prisma.sql`"twoBidder"::float / tenders DESC`}, tenders DESC
             LIMIT ${limit}`)
        void where
        return {
            minTenders,
            items: rows.map((r) => ({
                edrpou: r.edrpou, name: r.name, region: r.region, tenders: r.tenders,
                singleBidderShare: r.tenders ? r.single / r.tenders : 0, twoBidderShare: r.tenders ? r.two / r.tenders : 0,
                highRiskWins: r.high_risk_wins, sanctionedWins: r.sanctioned_wins, wonTotal: r.won_total, wonHighRisk: r.won_high_risk,
                repeatedPairs: r.repeated_pairs,
            })),
        }
    }

    // ---------------------------------------------------------------- groups

    async groups(params: { limit?: number; offset?: number; region?: string; minSize?: number; sort?: string; onlyUnsanctioned?: boolean }) {
        const limit = Math.min(Math.max(params.limit ?? 50, 1), 200)
        const offset = Math.max(params.offset ?? 0, 0)
        const where: Prisma.TightGroupWhereInput = { size: { gte: params.minSize ?? 2 } }
        if (params.region?.trim()) where.regions = { has: params.region.trim() }
        if (params.onlyUnsanctioned) where.sanctioned = 0
        const orderBy: Prisma.TightGroupOrderByWithRelationInput =
            params.sort === 'money' ? { wonAmount: 'desc' } : params.sort === 'size' ? { size: 'desc' } : params.sort === 'sanctioned' ? { sanctioned: 'desc' } : { maxScore: 'desc' }
        const [items, total, summary] = await Promise.all([
            this.prisma.tightGroup.findMany({ where, orderBy: [orderBy, { sharedTenders: 'desc' }], skip: offset, take: limit,
                include: { members: { orderBy: { wonAmount: 'desc' }, select: { edrpou: true, name: true, score: true, label: true, nTenders: true, nWon: true, wonAmount: true } } } }),
            this.prisma.tightGroup.count({ where }),
            this.prisma.tightGroup.aggregate({ _count: { _all: true }, _sum: { wonAmount: true, size: true, sanctioned: true } }),
        ])
        return { total, limit, offset, summary: { groups: summary._count._all, companies: summary._sum.size ?? 0, wonAmount: summary._sum.wonAmount ?? 0, sanctioned: summary._sum.sanctioned ?? 0 }, items }
    }

    async group(id: number) {
        const g = await this.prisma.tightGroup.findUnique({ where: { id }, include: { members: { orderBy: { wonAmount: 'desc' } } } })
        if (!g) throw new NotFoundException(`Group ${id} not found`)
        const ids = g.members.map((m) => m.edrpou)
        const pairs = await this.prisma.$queryRaw<Array<{ a: string; b: string; shared: number; a_won: number; b_won: number }>>(Prisma.sql`
            WITH bids AS (SELECT DISTINCT "tenderId", edrpou FROM "Participation" WHERE role = 'bidder' AND edrpou = ANY(${ids})),
                 wins AS (SELECT DISTINCT "tenderId", edrpou FROM "Participation" WHERE role = 'winner' AND edrpou = ANY(${ids}))
            SELECT p1.edrpou AS a, p2.edrpou AS b, count(*)::int AS shared, count(wa."tenderId")::int AS a_won, count(wb."tenderId")::int AS b_won
              FROM bids p1 JOIN bids p2 ON p2."tenderId" = p1."tenderId" AND p2.edrpou > p1.edrpou
              LEFT JOIN wins wa ON wa."tenderId" = p1."tenderId" AND wa.edrpou = p1.edrpou
              LEFT JOIN wins wb ON wb."tenderId" = p1."tenderId" AND wb.edrpou = p2.edrpou
             GROUP BY p1.edrpou, p2.edrpou ORDER BY shared DESC`)
        const buyers = await this.prisma.$queryRaw<Array<{ edrpou: string | null; name: string | null; tenders: number; amount: number }>>(Prisma.sql`
            SELECT t."buyerEdrpou" AS edrpou, max(t."procuringEntity") AS name, count(DISTINCT t.id)::int AS tenders,
                   coalesce(sum(p."bidAmount") FILTER (WHERE p.role = 'winner'), 0)::float AS amount
              FROM "Participation" p JOIN "Tender" t ON t.id = p."tenderId"
             WHERE p.edrpou = ANY(${ids}) GROUP BY t."buyerEdrpou" ORDER BY tenders DESC LIMIT 10`)
        const links = await this.prisma.companyLink.findMany({ where: { edrpouA: { in: ids }, edrpouB: { in: ids } } })
        const recent = await this.prisma.$queryRaw<Array<{ id: number; tender_id: string | null; title: string | null; buyer: string | null; date: Date | null; value: number | null; members: number; winner: string | null }>>(Prisma.sql`
            SELECT t.id, min(p."prozorroTenderId") AS tender_id, t.title, t."procuringEntity" AS buyer, t."datePublished" AS date, t."valueAmount" AS value,
                   count(DISTINCT p.edrpou) FILTER (WHERE p.role = 'bidder')::int AS members,
                   max(p.name) FILTER (WHERE p.role = 'winner') AS winner
              FROM "Participation" p JOIN "Tender" t ON t.id = p."tenderId"
             WHERE p.edrpou = ANY(${ids})
             GROUP BY t.id HAVING count(DISTINCT p.edrpou) FILTER (WHERE p.role = 'bidder') >= 2
             ORDER BY t."datePublished" DESC NULLS LAST LIMIT 15`)
        return { ...g, pairs: pairs.map((p) => ({ a: p.a, b: p.b, shared: p.shared, aWon: p.a_won, bWon: p.b_won })), buyers, links, recentTenders: recent }
    }

    async groupsOfCompany(edrpou: string) {
        const m = await this.prisma.tightGroupMember.findMany({ where: { edrpou }, select: { groupId: true } })
        if (!m.length) return []
        return this.prisma.tightGroup.findMany({ where: { id: { in: m.map((x) => x.groupId) } }, include: { members: { select: { edrpou: true, name: true, score: true, label: true } } } })
    }

    // ---------------------------------------------------------------- links

    /** Companies sharing a phone / e-mail / contact person / address with the given one. */
    async links(edrpou: string) {
        const rows = await this.prisma.companyLink.findMany({ where: { OR: [{ edrpouA: edrpou }, { edrpouB: edrpou }] } })
        const others = rows.map((r) => (r.edrpouA === edrpou ? r.edrpouB : r.edrpouA))
        const risks = await this.prisma.companyRisk.findMany({ where: { edrpou: { in: others } }, select: { edrpou: true, name: true, score: true, label: true, nTenders: true } })
        const by = new Map(risks.map((r) => [r.edrpou, r]))
        const shared = others.length
            ? await this.prisma.$queryRaw<Array<{ edrpou: string; shared: number }>>(Prisma.sql`
                WITH my AS (SELECT DISTINCT "tenderId" FROM "Participation" WHERE edrpou = ${edrpou} AND role = 'bidder')
                SELECT p.edrpou, count(DISTINCT p."tenderId")::int AS shared FROM "Participation" p JOIN my ON my."tenderId" = p."tenderId"
                 WHERE p.role = 'bidder' AND p.edrpou = ANY(${others}) GROUP BY p.edrpou`)
            : []
        const sharedBy = new Map(shared.map((s) => [s.edrpou, s.shared]))
        return rows.map((r) => {
            const o = r.edrpouA === edrpou ? r.edrpouB : r.edrpouA
            const risk = by.get(o)
            return { edrpou: o, name: risk?.name ?? null, score: risk?.score ?? null, label: risk?.label ?? false, nTenders: risk?.nTenders ?? null, kinds: r.kinds, sharedTenders: sharedBy.get(o) ?? 0 }
        }).sort((a, b) => b.kinds.length - a.kinds.length || (b.sharedTenders - a.sharedTenders))
    }

    // ---------------------------------------------------------------- markets & money

    async markets(minTenders = 200) {
        return this.cached(`risk:markets:${minTenders}`, 3600, async () => {
            const rows = await this.prisma.$queryRaw<
                Array<{ cpv: string; tenders: number; suppliers: number; single: number; two: number; won_total: number; won_high_risk: number; won_sanctioned: number; high_risk_suppliers: number; sanctioned_suppliers: number }>
            >(Prisma.sql`
                WITH t AS (
                    SELECT t.id, t."cpvDivision" AS cpv, count(DISTINCT p.edrpou) AS bidders
                      FROM "Tender" t JOIN "Participation" p ON p."tenderId" = t.id AND p.role = 'bidder'
                     WHERE t."cpvDivision" IS NOT NULL GROUP BY t.id, t."cpvDivision"
                ), w AS (
                    SELECT t.cpv, p.edrpou, p."bidAmount" AS amount, cr.score, cr.label
                      FROM t JOIN "Participation" p ON p."tenderId" = t.id AND p.role = 'winner'
                      LEFT JOIN "CompanyRisk" cr ON cr.edrpou = p.edrpou
                )
                SELECT t.cpv, count(*)::int AS tenders,
                       (SELECT count(DISTINCT edrpou) FROM w WHERE w.cpv = t.cpv)::int AS suppliers,
                       count(*) FILTER (WHERE bidders = 1)::int AS single, count(*) FILTER (WHERE bidders = 2)::int AS two,
                       (SELECT coalesce(sum(amount),0) FROM w WHERE w.cpv = t.cpv)::float AS won_total,
                       (SELECT coalesce(sum(amount),0) FROM w WHERE w.cpv = t.cpv AND score >= 0.7)::float AS won_high_risk,
                       (SELECT coalesce(sum(amount),0) FROM w WHERE w.cpv = t.cpv AND label)::float AS won_sanctioned,
                       (SELECT count(DISTINCT edrpou) FROM w WHERE w.cpv = t.cpv AND score >= 0.7)::int AS high_risk_suppliers,
                       (SELECT count(DISTINCT edrpou) FROM w WHERE w.cpv = t.cpv AND label)::int AS sanctioned_suppliers
                  FROM t GROUP BY t.cpv HAVING count(*) >= ${minTenders} ORDER BY won_total DESC`)
            return {
                minTenders,
                items: rows.map((r) => ({
                    cpv: r.cpv, tenders: r.tenders, suppliers: r.suppliers,
                    singleBidderShare: r.tenders ? r.single / r.tenders : 0, twoBidderShare: r.tenders ? r.two / r.tenders : 0,
                    wonTotal: r.won_total, wonHighRisk: r.won_high_risk, wonSanctioned: r.won_sanctioned,
                    highRiskShareMoney: r.won_total ? r.won_high_risk / r.won_total : 0,
                    highRiskSuppliers: r.high_risk_suppliers, sanctionedSuppliers: r.sanctioned_suppliers,
                    highRiskSupplierShare: r.suppliers ? r.high_risk_suppliers / r.suppliers : 0,
                })),
            }
        })
    }

    /** Money won by risk band, grouped by year or by buyer region. */
    async money(by: 'year' | 'region' = 'year') {
        return this.cached(`risk:money:${by}`, 3600, async () => {
            const col = by === 'year' ? Prisma.sql`extract(year from t."datePublished")::int::text` : Prisma.sql`t."buyerRegion"`
            const rows = await this.prisma.$queryRaw<Array<{ k: string | null; total: number; high: number; sanctioned: number; n: number; n_high: number }>>(Prisma.sql`
                SELECT ${col} AS k,
                       coalesce(sum(p."bidAmount"),0)::float AS total,
                       coalesce(sum(p."bidAmount") FILTER (WHERE cr.score >= 0.7),0)::float AS high,
                       coalesce(sum(p."bidAmount") FILTER (WHERE cr.label),0)::float AS sanctioned,
                       count(*)::int AS n, count(*) FILTER (WHERE cr.score >= 0.7)::int AS n_high
                  FROM "Participation" p JOIN "Tender" t ON t.id = p."tenderId"
                  LEFT JOIN "CompanyRisk" cr ON cr.edrpou = p.edrpou
                 WHERE p.role = 'winner' AND p."bidAmount" IS NOT NULL AND p."bidAmount" < 1e10
                 GROUP BY 1 HAVING ${col} IS NOT NULL ORDER BY 1`)
            return { by, items: rows.map((r) => ({ key: r.k, wonTotal: r.total, wonHighRisk: r.high, wonSanctioned: r.sanctioned, awards: r.n, awardsHighRisk: r.n_high, highRiskShare: r.total ? r.high / r.total : 0 })) }
        })
    }
}
