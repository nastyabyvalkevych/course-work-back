import { Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { PrismaService } from '../prisma/prisma.service'
import { RedisService } from '../redis/redis.service'

/**
 * Second layer of the risk API: buyers, tight groups, shared-contact links,
 * markets and money. Everything is derived from Bid / Award / Tender / TenderItem and
 * the API views (v_company_card, v_tight_group_member, v_buyer_stats, v_risk_backtest)
 * plus the materialized view CompanyLink. Bidder counts use the code in the card
 * (placeholder codes count as bidders, as before); company identity uses orgCode.
 * Money columns are numeric in the database and are cast to float8 for the API.
 */

/** Stable positive int id of a shared-contact pair (CompanyLink is a view without ids). */
const LINK_ID = Prisma.sql`(hashtext(l."orgCodeA" || '|' || l."orgCodeB")::bigint & 2147483647)::int`

type GroupRow = {
    id: number; size: number; sharedTenders: number; totalTenders: number; wonAmount: number; sanctioned: number
    sameDecision: number; meanScore: number; maxScore: number; regions: string[]; topCpv: string[]
    firstShared: Date | null; lastShared: Date | null; computedAt: Date
}
const GROUP_COLUMNS = Prisma.sql`g.id, g.size, g."sharedTenders", g."totalTenders", g."wonAmount"::float8 AS "wonAmount",
    g.sanctioned, g."sameDecision", g."meanScore", g."maxScore", g.regions, g."topCpv", g."firstShared", g."lastShared", g."computedAt"`
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
                           (SELECT count(DISTINCT b."codeInCard") FROM "Bid" b WHERE b."tenderId" = t.id) AS bidders
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
                WITH t AS (SELECT id FROM "Tender" WHERE "buyerEdrpou" = ${edrpou}),
                p AS (
                    SELECT b."orgCode" AS edrpou, 'bidder' AS role, b."tenderId", NULL::numeric AS amount, b."nameInCard" AS name
                      FROM "Bid" b JOIN t ON t.id = b."tenderId" WHERE b."orgCode" IS NOT NULL
                    UNION ALL
                    SELECT a."orgCode", 'winner', a."tenderId", a.amount, a."nameInCard"
                      FROM "Award" a JOIN t ON t.id = a."tenderId" WHERE a."orgCode" IS NOT NULL
                ), agg AS (
                    SELECT edrpou, max(name) AS name,
                           count(DISTINCT "tenderId") FILTER (WHERE role = 'bidder')::int AS bids,
                           count(DISTINCT "tenderId") FILTER (WHERE role = 'winner')::int AS wins,
                           coalesce(sum(amount) FILTER (WHERE role = 'winner'), 0)::float8 AS won_amount
                      FROM p GROUP BY edrpou
                )
                SELECT a.edrpou, coalesce(o.name, a.name) AS name, a.bids, a.wins, a.won_amount, cr.score, cr.label
                  FROM agg a LEFT JOIN "Organization" o ON o.code = a.edrpou LEFT JOIN v_company_card cr ON cr.edrpou = a.edrpou
                 ORDER BY a.wins DESC, a.bids DESC, a.edrpou LIMIT 25`)

            const pairs = await this.prisma.$queryRaw<
                Array<{ a: string; b: string; name_a: string | null; name_b: string | null; shared: number; a_won: number; b_won: number;
                        score_a: number | null; score_b: number | null; label_a: boolean | null; label_b: boolean | null }>
            >(Prisma.sql`
                WITH bids AS (
                    SELECT DISTINCT p."tenderId", p."orgCode" AS edrpou FROM "Bid" p JOIN "Tender" t ON t.id = p."tenderId"
                     WHERE t."buyerEdrpou" = ${edrpou} AND p."orgCode" IS NOT NULL
                ), wins AS (
                    SELECT DISTINCT p."tenderId", p."orgCode" AS edrpou FROM "Award" p JOIN "Tender" t ON t.id = p."tenderId"
                     WHERE t."buyerEdrpou" = ${edrpou} AND p."orgCode" IS NOT NULL
                ), pr AS (
                    SELECT p1.edrpou AS a, p2.edrpou AS b, count(*)::int AS shared,
                           count(wa."tenderId")::int AS a_won, count(wb."tenderId")::int AS b_won
                      FROM bids p1 JOIN bids p2 ON p2."tenderId" = p1."tenderId" AND p2.edrpou > p1.edrpou
                      LEFT JOIN wins wa ON wa."tenderId" = p1."tenderId" AND wa.edrpou = p1.edrpou
                      LEFT JOIN wins wb ON wb."tenderId" = p1."tenderId" AND wb.edrpou = p2.edrpou
                     GROUP BY p1.edrpou, p2.edrpou HAVING count(*) >= 3
                )
                SELECT pr.*, ca.name AS name_a, cb.name AS name_b, ca.score AS score_a, cb.score AS score_b, ca.label AS label_a, cb.label AS label_b
                  FROM pr LEFT JOIN v_company_card ca ON ca.edrpou = pr.a LEFT JOIN v_company_card cb ON cb.edrpou = pr.b
                 ORDER BY shared DESC, pr.a, pr.b LIMIT 20`)

            const recent = await this.prisma.$queryRaw<
                Array<{ id: number; tender_id: string | null; title: string | null; date: Date | null; value: number | null; bidders: number; winner: string | null; winner_score: number | null }>
            >(Prisma.sql`
                SELECT t.id, t."tenderID" AS tender_id, t.title, t."datePublished" AS date, t."valueAmount"::float8 AS value,
                       (SELECT count(DISTINCT b."codeInCard") FROM "Bid" b WHERE b."tenderId" = t.id)::int AS bidders,
                       w.winner, w.winner_score
                  FROM "Tender" t
                  LEFT JOIN LATERAL (
                      SELECT max(coalesce(cr.name, a."nameInCard")) AS winner, max(cr.score) AS winner_score
                        FROM "Award" a LEFT JOIN v_company_card cr ON cr.edrpou = a."orgCode"
                       WHERE a."tenderId" = t.id
                  ) w ON true
                 WHERE t."buyerEdrpou" = ${edrpou}
                   AND (EXISTS (SELECT 1 FROM "Bid" b WHERE b."tenderId" = t.id) OR EXISTS (SELECT 1 FROM "Award" a WHERE a."tenderId" = t.id))
                 ORDER BY t."datePublished" DESC NULLS LAST, t.id DESC LIMIT 20`)

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
        const rows = await this.prisma.$queryRaw<
            Array<{ edrpou: string; name: string | null; region: string | null; tenders: number; single: number; two: number;
                    high_risk_wins: number; sanctioned_wins: number; won_total: number; won_high_risk: number; repeated_pairs: number }>
        >(Prisma.sql`
            SELECT edrpou, name, region, tenders, "singleBidder" AS single, "twoBidder" AS two, "highRiskWins" AS high_risk_wins,
                   "sanctionedWins" AS sanctioned_wins, "wonTotal"::float8 AS won_total, "wonHighRisk"::float8 AS won_high_risk, "repeatedPairs" AS repeated_pairs
              FROM v_buyer_stats
             WHERE tenders >= ${minTenders}
               ${params.region?.trim() ? Prisma.sql`AND region = ${params.region.trim()}` : Prisma.empty}
               ${params.q?.trim() ? Prisma.sql`AND (edrpou = ${params.q.trim()} OR name ILIKE ${'%' + params.q.trim() + '%'})` : Prisma.empty}
             ORDER BY ${params.sort === 'money' ? Prisma.sql`"wonHighRisk" DESC` : params.sort === 'pairs' ? Prisma.sql`"repeatedPairs" DESC` : params.sort === 'single' ? Prisma.sql`"singleBidder"::float / tenders DESC` : Prisma.sql`"twoBidder"::float / tenders DESC`}, tenders DESC, edrpou
             LIMIT ${limit}`)
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

    /** Members of the given groups in the old TightGroupMember shape (plus groupId when `withGroupId`). */
    private async members(groupIds: number[], withGroupId: boolean) {
        if (!groupIds.length) return new Map<number, Record<string, unknown>[]>()
        const rows = await this.prisma.$queryRaw<
            Array<{ groupId: number; edrpou: string; name: string | null; score: number | null; label: boolean; nTenders: number; nWon: number; wonAmount: number }>
        >(Prisma.sql`
            SELECT "groupId", edrpou, name, score, label, "nTenders", "nWon", "wonAmount"::float8 AS "wonAmount"
              FROM v_tight_group_member WHERE "groupId" = ANY(${groupIds})
             ORDER BY "wonAmount" DESC, edrpou`)
        const by = new Map<number, Record<string, unknown>[]>()
        for (const { groupId, ...m } of rows) {
            const list = by.get(groupId) ?? []
            list.push(withGroupId ? { groupId, ...m } : m)
            by.set(groupId, list)
        }
        return by
    }

    async groups(params: { limit?: number; offset?: number; region?: string; minSize?: number; sort?: string; onlyUnsanctioned?: boolean }) {
        const limit = Math.min(Math.max(params.limit ?? 50, 1), 200)
        const offset = Math.max(params.offset ?? 0, 0)
        const cond: Prisma.Sql[] = [Prisma.sql`g.size >= ${params.minSize ?? 2}`]
        if (params.region?.trim()) cond.push(Prisma.sql`${params.region.trim()} = ANY(g.regions)`)
        if (params.onlyUnsanctioned) cond.push(Prisma.sql`g.sanctioned = 0`)
        const where = Prisma.join(cond, ' AND ')
        const orderBy =
            params.sort === 'money' ? Prisma.sql`g."wonAmount" DESC` : params.sort === 'size' ? Prisma.sql`g.size DESC` : params.sort === 'sanctioned' ? Prisma.sql`g.sanctioned DESC` : Prisma.sql`g."maxScore" DESC`
        const [rows, [count], [summary]] = await Promise.all([
            this.prisma.$queryRaw<GroupRow[]>(Prisma.sql`
                SELECT ${GROUP_COLUMNS} FROM "TightGroup" g WHERE ${where}
                 ORDER BY ${orderBy}, g."sharedTenders" DESC, g.id OFFSET ${offset} LIMIT ${limit}`),
            this.prisma.$queryRaw<{ c: number }[]>(Prisma.sql`SELECT count(*)::int AS c FROM "TightGroup" g WHERE ${where}`),
            this.prisma.$queryRaw<{ groups: number; companies: number; wonAmount: number; sanctioned: number }[]>(Prisma.sql`
                SELECT count(*)::int AS groups, coalesce(sum(size), 0)::int AS companies,
                       coalesce(sum("wonAmount"), 0)::float8 AS "wonAmount", coalesce(sum(sanctioned), 0)::int AS sanctioned
                  FROM "TightGroup"`),
        ])
        const members = await this.members(rows.map((g) => g.id), false)
        const items = rows.map((g) => ({ ...g, members: members.get(g.id) ?? [] }))
        return { total: count.c, limit, offset, summary, items }
    }

    async group(id: number) {
        const [row] = await this.prisma.$queryRaw<GroupRow[]>(Prisma.sql`SELECT ${GROUP_COLUMNS} FROM "TightGroup" g WHERE g.id = ${id}`)
        if (!row) throw new NotFoundException(`Group ${id} not found`)
        const g = { ...row, members: (await this.members([id], true)).get(id) ?? [] }
        const ids = g.members.map((m) => m.edrpou as string)
        const pairs = await this.prisma.$queryRaw<Array<{ a: string; b: string; shared: number; a_won: number; b_won: number }>>(Prisma.sql`
            WITH bids AS (SELECT DISTINCT "tenderId", "orgCode" AS edrpou FROM "Bid" WHERE "orgCode" = ANY(${ids})),
                 wins AS (SELECT DISTINCT "tenderId", "orgCode" AS edrpou FROM "Award" WHERE "orgCode" = ANY(${ids}))
            SELECT p1.edrpou AS a, p2.edrpou AS b, count(*)::int AS shared, count(wa."tenderId")::int AS a_won, count(wb."tenderId")::int AS b_won
              FROM bids p1 JOIN bids p2 ON p2."tenderId" = p1."tenderId" AND p2.edrpou > p1.edrpou
              LEFT JOIN wins wa ON wa."tenderId" = p1."tenderId" AND wa.edrpou = p1.edrpou
              LEFT JOIN wins wb ON wb."tenderId" = p1."tenderId" AND wb.edrpou = p2.edrpou
             GROUP BY p1.edrpou, p2.edrpou ORDER BY shared DESC, a, b`)
        const buyers = await this.prisma.$queryRaw<Array<{ edrpou: string | null; name: string | null; tenders: number; amount: number }>>(Prisma.sql`
            WITH p AS (
                SELECT "tenderId", NULL::numeric AS amount FROM "Bid" WHERE "orgCode" = ANY(${ids})
                UNION ALL
                SELECT "tenderId", amount FROM "Award" WHERE "orgCode" = ANY(${ids})
            )
            SELECT t."buyerEdrpou" AS edrpou, max(t."procuringEntity") AS name, count(DISTINCT t.id)::int AS tenders,
                   coalesce(sum(p.amount), 0)::float8 AS amount
              FROM p JOIN "Tender" t ON t.id = p."tenderId"
             GROUP BY t."buyerEdrpou" ORDER BY tenders DESC, amount DESC LIMIT 10`)
        const links = await this.prisma.$queryRaw<Array<{ id: number; edrpouA: string; edrpouB: string; kinds: string[] }>>(Prisma.sql`
            SELECT ${LINK_ID} AS id, l."orgCodeA" AS "edrpouA", l."orgCodeB" AS "edrpouB", l.kinds
              FROM "CompanyLink" l WHERE l."orgCodeA" = ANY(${ids}) AND l."orgCodeB" = ANY(${ids})
             ORDER BY l."orgCodeA", l."orgCodeB"`)
        const recent = await this.prisma.$queryRaw<Array<{ id: number; tender_id: string | null; title: string | null; buyer: string | null; date: Date | null; value: number | null; members: number; winner: string | null }>>(Prisma.sql`
            WITH mb AS (
                SELECT "tenderId", count(DISTINCT "orgCode")::int AS members FROM "Bid" WHERE "orgCode" = ANY(${ids})
                 GROUP BY "tenderId" HAVING count(DISTINCT "orgCode") >= 2
            )
            SELECT t.id, t."tenderID" AS tender_id, t.title, t."procuringEntity" AS buyer, t."datePublished" AS date, t."valueAmount"::float8 AS value,
                   mb.members,
                   (SELECT max(a."nameInCard") FROM "Award" a WHERE a."tenderId" = t.id AND a."orgCode" = ANY(${ids})) AS winner
              FROM mb JOIN "Tender" t ON t.id = mb."tenderId"
             ORDER BY t."datePublished" DESC NULLS LAST, t.id DESC LIMIT 15`)
        return { ...g, pairs: pairs.map((p) => ({ a: p.a, b: p.b, shared: p.shared, aWon: p.a_won, bWon: p.b_won })), buyers, links, recentTenders: recent }
    }

    async groupsOfCompany(edrpou: string) {
        const rows = await this.prisma.$queryRaw<GroupRow[]>(Prisma.sql`
            SELECT ${GROUP_COLUMNS} FROM "TightGroup" g JOIN "TightGroupMember" m ON m."groupId" = g.id
             WHERE m."orgCode" = ${edrpou} ORDER BY g.id`)
        if (!rows.length) return []
        const members = await this.members(rows.map((g) => g.id), false)
        return rows.map((g) => ({
            ...g,
            members: (members.get(g.id) ?? []).map(({ edrpou: e, name, score, label }) => ({ edrpou: e, name, score, label })),
        }))
    }

    // ------------------------------------------------------- register updates

    /** Versions of the AMCU register loaded into the database. */
    async registerVersions() {
        const rows = await this.prisma.$queryRaw<Array<{ version: string; rows: number; companies: number; decisions: number; latest: Date | null }>>(Prisma.sql`
            SELECT "registerVersion" AS version, count(*)::int AS rows, count(DISTINCT edrpou)::int AS companies,
                   count(DISTINCT ("decisionNumber","decisionDate"))::int AS decisions, max("decisionDate") AS latest
              FROM "AmcuRegisterRow" GROUP BY 1 ORDER BY 1`)
        return rows
    }

    /**
     * What changed between two register versions and how the system had rated the newly
     * sanctioned companies before their decision became known. Scores come from the current
     * model, which was trained on the older register, so for these companies they are genuine
     * pre-decision assessments.
     */
    async registerUpdates(params: { from?: string; to?: string }) {
        const versions = await this.registerVersions()
        if (versions.length < 2 && !params.from) throw new NotFoundException('Only one register version is loaded')
        const to = params.to ?? versions[versions.length - 1].version
        const from = params.from ?? versions[Math.max(0, versions.findIndex((v) => v.version === to) - 1)].version
        const key = `risk:register-updates:${from}:${to}`
        return this.cached(key, 3600, async () => {
            const added = await this.prisma.$queryRaw<Array<{
                edrpou: string; name: string | null; decision_number: string; decision_date: Date; body: string | null;
                score: number | null; rank: number | null; percentile: number | null; n_tenders: number | null; n_won: number | null;
                coverage: string | null; region: string | null; degree: number | null;
                fc_rank: number | null; fc_rank_full: number | null; fc_score: number | null;
            }>>(Prisma.sql`
                WITH old AS (SELECT DISTINCT edrpou FROM "AmcuRegisterRow" WHERE "registerVersion" = ${from}),
                     new AS (
                        SELECT edrpou, max("companyName") AS name, min("decisionDate") AS decision_date,
                               (array_agg("decisionNumber" ORDER BY "decisionDate"))[1] AS decision_number,
                               (array_agg(body ORDER BY "decisionDate"))[1] AS body
                          FROM "AmcuRegisterRow" WHERE "registerVersion" = ${to} GROUP BY edrpou
                     )
                SELECT n.edrpou, coalesce(c.name, n.name) AS name, n.decision_number, n.decision_date, n.body,
                       c.score, c.rank, c.percentile, c."nTenders" AS n_tenders, c."nWon" AS n_won, c.coverage, c.region, c.degree,
                       b.rank AS fc_rank, b."rankFull" AS fc_rank_full, b.score AS fc_score
                  FROM new n
                  LEFT JOIN v_company_card c ON c.edrpou = n.edrpou
                  LEFT JOIN "RiskBacktest" b ON b."orgCode" = n.edrpou AND b."cutoffYear" = (SELECT max("cutoffYear") FROM "RiskBacktest")
                 WHERE n.edrpou NOT IN (SELECT edrpou FROM old)
                 ORDER BY n.decision_date DESC, n.decision_number`)
            const removed = await this.prisma.$queryRaw<Array<{ edrpou: string; name: string | null }>>(Prisma.sql`
                SELECT DISTINCT o.edrpou, max(o."companyName") AS name FROM "AmcuRegisterRow" o
                 WHERE o."registerVersion" = ${from} AND o.edrpou NOT IN (SELECT edrpou FROM "AmcuRegisterRow" WHERE "registerVersion" = ${to})
                 GROUP BY o.edrpou`)
            const totalScored = await this.prisma.companyRisk.count()
            const fcPop = await this.prisma.riskBacktest.count({ where: { cutoffYear: (await this.prisma.riskBacktest.aggregate({ _max: { cutoffYear: true } }))._max.cutoffYear ?? 0 } })
            const inGraph = added.filter((a) => a.score !== null)
            const high = inGraph.filter((a) => (a.score ?? 0) >= 0.7)
            const raised = inGraph.filter((a) => (a.score ?? 0) >= 0.45)
            const pcts = inGraph.map((a) => a.percentile ?? 0).sort((x, y) => x - y)
            const medianPct = pcts.length ? pcts[Math.floor(pcts.length / 2)] : null
            const top10 = inGraph.filter((a) => (a.rank ?? Infinity) <= totalScored * 0.1).length
            return {
                from, to, versions,
                summary: {
                    added: added.length, removed: removed.length, inGraph: inGraph.length, notInData: added.length - inGraph.length,
                    fullCoverage: inGraph.filter((a) => a.coverage === 'full').length,
                    highRisk: high.length, raisedOrHigh: raised.length, inTop10Pct: top10, medianPercentile: medianPct,
                    totalScored, forecastPopulation: fcPop,
                },
                added: added.map((a) => ({
                    edrpou: a.edrpou, name: a.name, decisionNumber: a.decision_number, decisionDate: a.decision_date, body: a.body,
                    score: a.score, rank: a.rank, percentile: a.percentile, nTenders: a.n_tenders, nWon: a.n_won, coverage: a.coverage, region: a.region, degree: a.degree,
                    forecastRank: a.fc_rank, forecastRankFull: a.fc_rank_full, forecastScore: a.fc_score,
                })),
                removed,
            }
        })
    }

    // ---------------------------------------------------------------- links

    /** Companies sharing a phone / e-mail / contact person / address with the given one. */
    async links(edrpou: string) {
        const rows = await this.prisma.$queryRaw<Array<{ other: string; kinds: string[] }>>(Prisma.sql`
            SELECT CASE WHEN l."orgCodeA" = ${edrpou} THEN l."orgCodeB" ELSE l."orgCodeA" END AS other, l.kinds
              FROM "CompanyLink" l WHERE l."orgCodeA" = ${edrpou} OR l."orgCodeB" = ${edrpou}`)
        const others = rows.map((r) => r.other)
        const risks = others.length
            ? await this.prisma.$queryRaw<Array<{ edrpou: string; name: string | null; score: number; label: boolean; nTenders: number }>>(Prisma.sql`
                SELECT edrpou, name, score, label, "nTenders" FROM v_company_card WHERE edrpou = ANY(${others})`)
            : []
        const by = new Map(risks.map((r) => [r.edrpou, r]))
        const shared = others.length
            ? await this.prisma.$queryRaw<Array<{ edrpou: string; shared: number }>>(Prisma.sql`
                WITH my AS (SELECT DISTINCT "tenderId" FROM "Bid" WHERE "orgCode" = ${edrpou})
                SELECT p."orgCode" AS edrpou, count(DISTINCT p."tenderId")::int AS shared FROM "Bid" p JOIN my ON my."tenderId" = p."tenderId"
                 WHERE p."orgCode" = ANY(${others}) GROUP BY p."orgCode"`)
            : []
        const sharedBy = new Map(shared.map((s) => [s.edrpou, s.shared]))
        return rows.map((r) => {
            const o = r.other
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
                WITH div AS (               -- tender's CPV division: the most frequent among its items (ties: lower code)
                    SELECT DISTINCT ON ("tenderId") "tenderId", left("cpvCode", 2) AS cpv
                      FROM "TenderItem" WHERE "cpvCode" IS NOT NULL
                     GROUP BY "tenderId", left("cpvCode", 2)
                     ORDER BY "tenderId", count(*) DESC, left("cpvCode", 2)
                ), t AS (
                    SELECT d."tenderId" AS id, d.cpv, count(DISTINCT b."codeInCard") AS bidders
                      FROM div d JOIN "Bid" b ON b."tenderId" = d."tenderId"
                     GROUP BY d."tenderId", d.cpv
                ), w AS (
                    SELECT t.cpv, a."codeInCard" AS edrpou, a.amount::float8 AS amount, cr.score, cr.label
                      FROM t JOIN "Award" a ON a."tenderId" = t.id
                      LEFT JOIN v_company_card cr ON cr.edrpou = a."orgCode"
                )
                SELECT t.cpv, count(*)::int AS tenders,
                       (SELECT count(DISTINCT edrpou) FROM w WHERE w.cpv = t.cpv)::int AS suppliers,
                       count(*) FILTER (WHERE bidders = 1)::int AS single, count(*) FILTER (WHERE bidders = 2)::int AS two,
                       (SELECT coalesce(sum(amount),0) FROM w WHERE w.cpv = t.cpv)::float AS won_total,
                       (SELECT coalesce(sum(amount),0) FROM w WHERE w.cpv = t.cpv AND score >= 0.7)::float AS won_high_risk,
                       (SELECT coalesce(sum(amount),0) FROM w WHERE w.cpv = t.cpv AND label)::float AS won_sanctioned,
                       (SELECT count(DISTINCT edrpou) FROM w WHERE w.cpv = t.cpv AND score >= 0.7)::int AS high_risk_suppliers,
                       (SELECT count(DISTINCT edrpou) FROM w WHERE w.cpv = t.cpv AND label)::int AS sanctioned_suppliers
                  FROM t GROUP BY t.cpv HAVING count(*) >= ${minTenders} ORDER BY won_total DESC, t.cpv`)
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
                       coalesce(sum(p.amount),0)::float8 AS total,
                       coalesce(sum(p.amount) FILTER (WHERE cr.score >= 0.7),0)::float8 AS high,
                       coalesce(sum(p.amount) FILTER (WHERE cr.label),0)::float8 AS sanctioned,
                       count(*)::int AS n, count(*) FILTER (WHERE cr.score >= 0.7)::int AS n_high
                  FROM "Award" p JOIN "Tender" t ON t.id = p."tenderId"
                  LEFT JOIN v_company_card cr ON cr.edrpou = p."orgCode"
                 WHERE p.amount IS NOT NULL AND p.amount < 1e10
                 GROUP BY 1 HAVING ${col} IS NOT NULL ORDER BY 1`)
            return { by, items: rows.map((r) => ({ key: r.k, wonTotal: r.total, wonHighRisk: r.high, wonSanctioned: r.sanctioned, awards: r.n, awardsHighRisk: r.n_high, highRiskShare: r.total ? r.high / r.total : 0 })) }
        })
    }
}
