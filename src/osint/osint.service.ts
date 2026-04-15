import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { PrismaService } from '../prisma/prisma.service'
import { RedisService } from '../redis/redis.service'

// OECD-aligned thresholds
const THRESHOLDS = {
    PRICE_CLUSTER_STRICT_PCT: 1.0,
    PRICE_CLUSTER_LOOSE_PCT: 5.0,
    PRICE_CLUSTER_MIN_AMOUNT: 10_000,
    WINRATE_MIN_BIDS: 3,
    REGIONAL_DOMINANCE_PCT: 20.0,
    REGIONAL_DOMINANCE_MIN_WINS: 3,
    REGIONAL_DOMINANCE_MIN_REGION_SIZE: 5,
    HHI_HIGHLY_CONCENTRATED: 2500,
    HHI_MODERATE: 1500,
    HHI_MIN_TENDERS_PER_DIVISION: 10,
    CO_PARTICIPATION_MIN: 3,
    BID_ROTATION_MIN_COHORT_SIZE: 3,
    BID_ROTATION_MIN_TENDERS: 4,
    BID_ROTATION_UNIFORMITY_THRESHOLD: 0.6,
}

type RawTender = {
    bids?: Array<{
        tenderers?: Array<{
            identifier?: { id?: string }
            name?: string
        }>
        lotValues?: Array<{
            value?: { amount?: number }
        }>
        value?: { amount?: number }
    }>
    awards?: Array<{
        status?: string
        suppliers?: Array<{
            identifier?: { id?: string }
            name?: string
        }>
    }>
    procuringEntity?: {
        identifier?: { id?: string }
        name?: string
        address?: { region?: string }
    }
}

type CoParticipationPair = {
    edrpouA: string
    edrpouB: string
    nameA: string
    nameB: string
    count: number
    tenderIds: string[]
}

type WinRateAnomaly = {
    edrpou: string
    name: string
    bids: number
    wins: number
    rate: number
}

type RegionalDominanceEntry = {
    region: string
    dominantEdrpou: string
    dominantName: string
    wins: number
    total: number
    pct: number
}

type HhiEntry = {
    cpvDivision: string
    totalAwards: number
    uniqueSuppliers: number
    hhi: number
    level: 'highly concentrated' | 'moderately concentrated' | 'unconcentrated'
    topSupplierEdrpou: string
    topSupplierSharePct: number
}

type BidRotationCohort = {
    cohortEdrs: string[]
    cohortSize: number
    numTenders: number
    winnersCount: number
    uniformity: number
}

@Injectable()
export class OsintService {
    private readonly logger = new Logger(OsintService.name)

    constructor(
        private readonly prisma: PrismaService,
        private readonly redisService: RedisService,
    ) {}

    async getLatestReport() {
        const cacheKey = 'osint:latest-report'
        const cached = await this.redisService.get(cacheKey)
        if (cached) {
            return cached
        }

        const report = await this.prisma.osintReport.findFirst({
            orderBy: { generatedAt: 'desc' },
        })

        if (!report) {
            throw new NotFoundException(
                'OSINT report not found. Run POST /api/osint/generate first.',
            )
        }

        await this.redisService.set(cacheKey, report, 300) // 5 min cache
        return report
    }

    async getReportById(id: number) {
        const report = await this.prisma.osintReport.findUnique({
            where: { id },
        })
        if (!report) {
            throw new NotFoundException(`Report ${id} not found`)
        }
        return report
    }

    async getSupplierStats(edrpou: string) {
        const stats = await this.prisma.supplierOsintStats.findUnique({
            where: { edrpou },
        })
        if (!stats) {
            throw new NotFoundException(`Supplier ${edrpou} not found`)
        }
        return stats
    }

    async getProcuringEntityStats(edrpou: string) {
        const stats = await this.prisma.procuringEntityOsintStats.findUnique({
            where: { edrpou },
        })
        if (!stats) {
            throw new NotFoundException(`Procuring entity ${edrpou} not found`)
        }
        return stats
    }

    async getTenderSignals(tenderId: string) {
        const tender = await this.prisma.tender.findFirst({
            where: {
                OR: [
                    { prozorroId: tenderId },
                    { id: parseInt(tenderId, 10) || -1 },
                ],
            },
        })

        if (!tender) {
            throw new NotFoundException(`Tender ${tenderId} not found`)
        }

        const rawData = tender.rawData as RawTender
        const signals: Array<{
            id: string
            label: string
            description: string
            tone: 'danger' | 'warning' | 'info'
        }> = []

        // 1. Single Bidder
        const participants = this.extractParticipants(rawData)
        if (Object.keys(participants).length === 1) {
            signals.push({
                id: 'single-bidder',
                label: 'Single Bidder',
                description: 'У закупівлі зафіксовано лише одного учасника.',
                tone: 'warning',
            })
        }

        // 2. Price Clustering
        const bidAmounts = this.extractBidValues(rawData)
        if (bidAmounts.length >= 2) {
            const amounts = bidAmounts
                .map((b) => b.amount)
                .sort((a, b) => a - b)
            const minAmount = amounts[0]
            const maxAmount = amounts[amounts.length - 1]
            const spreadPct =
                maxAmount > 0 ? ((maxAmount - minAmount) / maxAmount) * 100 : 0

            if (
                minAmount >= THRESHOLDS.PRICE_CLUSTER_MIN_AMOUNT &&
                spreadPct < THRESHOLDS.PRICE_CLUSTER_STRICT_PCT
            ) {
                signals.push({
                    id: 'price-clustering',
                    label:
                        maxAmount - minAmount === 0
                            ? 'Identical Bids'
                            : 'Price Clustering',
                    description: `Пропозиції дуже близькі: spread ${spreadPct.toFixed(3)}%.`,
                    tone: 'danger',
                })
            }
        }

        // 3. Winner stats (from pre-computed)
        const { winnerId } = this.extractWinner(rawData)
        if (winnerId) {
            const supplierStats =
                await this.prisma.supplierOsintStats.findUnique({
                    where: { edrpou: winnerId },
                })
            if (
                supplierStats &&
                supplierStats.totalBids >= THRESHOLDS.WINRATE_MIN_BIDS &&
                supplierStats.winRate === 1
            ) {
                signals.push({
                    id: 'winner-100-winrate',
                    label: `100% Win Rate`,
                    description: `Переможець виграв ${supplierStats.totalWins}/${supplierStats.totalBids} тендерів.`,
                    tone: 'warning',
                })
            }
        }

        // 4. Procuring entity stats
        const { entityId } = this.extractProcuringEntity(rawData)
        if (entityId) {
            const entityStats =
                await this.prisma.procuringEntityOsintStats.findUnique({
                    where: { edrpou: entityId },
                })
            if (entityStats && entityStats.singleBidderTenders >= 10) {
                signals.push({
                    id: 'entity-many-single-bidder',
                    label: `${entityStats.singleBidderTenders} Single-Bid`,
                    description: `Цей замовник має ${entityStats.singleBidderTenders} тендерів з одним учасником.`,
                    tone: 'warning',
                })
            }
        }

        // 5. Co-participation (check if participants appeared together before)
        const participantEdrs = Object.keys(participants)
        if (participantEdrs.length >= 2) {
            const report = await this.prisma.osintReport.findFirst({
                orderBy: { generatedAt: 'desc' },
            })
            if (report) {
                const pairs =
                    report.coParticipationPairs as CoParticipationPair[]
                for (let i = 0; i < participantEdrs.length; i++) {
                    for (let j = i + 1; j < participantEdrs.length; j++) {
                        const a = participantEdrs[i]
                        const b = participantEdrs[j]
                        const pair = pairs.find(
                            (p) =>
                                (p.edrpouA === a && p.edrpouB === b) ||
                                (p.edrpouA === b && p.edrpouB === a),
                        )
                        if (pair && pair.count >= 5) {
                            signals.push({
                                id: 'co-participation',
                                label: `${pair.count} Co-bids`,
                                description: `Учасники ${pair.nameA.slice(0, 20)} та ${pair.nameB.slice(0, 20)} подавались разом у ${pair.count} тендерах.`,
                                tone: 'info',
                            })
                            break
                        }
                    }
                }
            }
        }

        return {
            tenderId: tender.prozorroId,
            signals,
        }
    }

    async generateReport() {
        this.logger.log('Starting OSINT report generation...')
        const startTime = Date.now()

        // Fetch in batches to avoid Prisma memory/encoding issues with large JSON blobs
        const BATCH_SIZE = 1000
        const totalCount = await this.prisma.tender.count()
        this.logger.log(
            `Total tenders: ${totalCount}, fetching in batches of ${BATCH_SIZE}`,
        )

        const tenders: Array<{
            id: number
            prozorroId: string
            cpvCodes: string[]
            rawData: Prisma.JsonValue
        }> = []

        for (let skip = 0; skip < totalCount; skip += BATCH_SIZE) {
            const batch = await this.prisma.tender.findMany({
                select: {
                    id: true,
                    prozorroId: true,
                    cpvCodes: true,
                    rawData: true,
                },
                skip,
                take: BATCH_SIZE,
                orderBy: { id: 'asc' },
            })
            tenders.push(...batch)
            this.logger.log(`Fetched ${tenders.length}/${totalCount} tenders`)
        }

        this.logger.log(`Loaded ${tenders.length} tenders`)

        // Run all analyses
        const [
            singleBidderStats,
            coParticipation,
            winRates,
            regionalDominance,
            hhiData,
            bidRotation,
        ] = await Promise.all([
            this.analyzeSingleBidder(tenders),
            this.analyzeCoParticipation(tenders),
            this.analyzeWinRates(tenders),
            this.analyzeRegionalDominance(tenders),
            this.analyzeMarketConcentration(tenders),
            this.analyzeBidRotation(tenders),
        ])

        // Save report
        const report = await this.prisma.osintReport.create({
            data: {
                numTenders: tenders.length,
                metadata: {
                    thresholds: THRESHOLDS,
                    generatedAt: new Date().toISOString(),
                    durationMs: Date.now() - startTime,
                },
                singleBidderCount: singleBidderStats.singleBidderCount,
                singleBidderRatio: singleBidderStats.singleBidderRatio,
                multiBidderCount: singleBidderStats.multiBidderCount,
                topSingleBidderEntities:
                    singleBidderStats.topEntities as Prisma.InputJsonValue,
                coParticipationPairs:
                    coParticipation.pairs as Prisma.InputJsonValue,
                winRateAnomalies: winRates.anomalies as Prisma.InputJsonValue,
                regionalDominance:
                    regionalDominance.entries as Prisma.InputJsonValue,
                hhiPerCpv: hhiData.entries as Prisma.InputJsonValue,
                bidRotationCohorts:
                    bidRotation.cohorts as Prisma.InputJsonValue,
            },
        })

        // Update supplier stats
        await this.updateSupplierStats(
            winRates.allSuppliers,
            coParticipation.partnerMap,
        )

        // Update procuring entity stats
        await this.updateProcuringEntityStats(singleBidderStats.byEntity)

        // Clear cache
        await this.redisService.del('osint:latest-report')

        this.logger.log(`OSINT report generated in ${Date.now() - startTime}ms`)

        return report
    }

    // === Analysis Methods ===

    private analyzeSingleBidder(
        tenders: Array<{ prozorroId: string; rawData: Prisma.JsonValue }>,
    ) {
        let singleBidderCount = 0
        let multiBidderCount = 0
        const byEntity: Map<string, { name: string; count: number }> = new Map()

        for (const tender of tenders) {
            const rawData = tender.rawData as RawTender
            const participants = this.extractParticipants(rawData)
            const { entityId, entityName } =
                this.extractProcuringEntity(rawData)

            if (Object.keys(participants).length === 1) {
                singleBidderCount++
                if (entityId) {
                    const existing = byEntity.get(entityId) || {
                        name: entityName,
                        count: 0,
                    }
                    existing.count++
                    byEntity.set(entityId, existing)
                }
            } else if (Object.keys(participants).length > 1) {
                multiBidderCount++
            }
        }

        const total = singleBidderCount + multiBidderCount
        const topEntities = Array.from(byEntity.entries())
            .map(([edrpou, data]) => ({
                edrpou,
                name: data.name,
                count: data.count,
            }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 20)

        return {
            singleBidderCount,
            multiBidderCount,
            singleBidderRatio: total > 0 ? singleBidderCount / total : 0,
            topEntities,
            byEntity,
        }
    }

    private analyzeCoParticipation(
        tenders: Array<{ prozorroId: string; rawData: Prisma.JsonValue }>,
    ) {
        const pairCount: Map<string, number> = new Map()
        const pairTenders: Map<string, string[]> = new Map()
        const companyNames: Map<string, string> = new Map()

        for (const tender of tenders) {
            const rawData = tender.rawData as RawTender
            const participants = this.extractParticipants(rawData)

            if (Object.keys(participants).length < 2) continue

            for (const [edr, name] of Object.entries(participants)) {
                companyNames.set(edr, name)
            }

            const edrList = Object.keys(participants).sort()
            for (let i = 0; i < edrList.length; i++) {
                for (let j = i + 1; j < edrList.length; j++) {
                    const pairKey = `${edrList[i]}|${edrList[j]}`
                    pairCount.set(pairKey, (pairCount.get(pairKey) || 0) + 1)
                    const tenderList = pairTenders.get(pairKey) || []
                    tenderList.push(tender.prozorroId)
                    pairTenders.set(pairKey, tenderList)
                }
            }
        }

        const pairs: CoParticipationPair[] = Array.from(pairCount.entries())
            .filter(([, count]) => count >= THRESHOLDS.CO_PARTICIPATION_MIN)
            .map(([key, count]) => {
                const [edrpouA, edrpouB] = key.split('|')
                return {
                    edrpouA,
                    edrpouB,
                    nameA: companyNames.get(edrpouA) || '',
                    nameB: companyNames.get(edrpouB) || '',
                    count,
                    tenderIds: (pairTenders.get(key) || []).slice(0, 10),
                }
            })
            .sort((a, b) => b.count - a.count)
            .slice(0, 50)

        // Build partner map for supplier stats
        const partnerMap: Map<
            string,
            Map<string, { name: string; count: number }>
        > = new Map()
        for (const pair of pairs) {
            // A -> B
            if (!partnerMap.has(pair.edrpouA)) {
                partnerMap.set(pair.edrpouA, new Map())
            }
            partnerMap.get(pair.edrpouA)!.set(pair.edrpouB, {
                name: pair.nameB,
                count: pair.count,
            })

            // B -> A
            if (!partnerMap.has(pair.edrpouB)) {
                partnerMap.set(pair.edrpouB, new Map())
            }
            partnerMap.get(pair.edrpouB)!.set(pair.edrpouA, {
                name: pair.nameA,
                count: pair.count,
            })
        }

        return { pairs, partnerMap }
    }

    private analyzeWinRates(
        tenders: Array<{ prozorroId: string; rawData: Prisma.JsonValue }>,
    ) {
        const companyBids: Map<string, number> = new Map()
        const companyWins: Map<string, number> = new Map()
        const companyNames: Map<string, string> = new Map()

        for (const tender of tenders) {
            const rawData = tender.rawData as RawTender
            const participants = this.extractParticipants(rawData)
            const { winnerId, winnerName } = this.extractWinner(rawData)

            for (const [edr, name] of Object.entries(participants)) {
                companyBids.set(edr, (companyBids.get(edr) || 0) + 1)
                companyNames.set(edr, name)
            }

            if (winnerId) {
                companyWins.set(winnerId, (companyWins.get(winnerId) || 0) + 1)
                if (winnerName) companyNames.set(winnerId, winnerName)
            }
        }

        // Find anomalies: 100% win rate with >= N bids
        const anomalies: WinRateAnomaly[] = []
        const allSuppliers: Map<
            string,
            { name: string; bids: number; wins: number; rate: number }
        > = new Map()

        for (const [edr, bids] of companyBids.entries()) {
            const wins = companyWins.get(edr) || 0
            const rate = bids > 0 ? wins / bids : 0

            allSuppliers.set(edr, {
                name: companyNames.get(edr) || '',
                bids,
                wins,
                rate,
            })

            if (bids >= THRESHOLDS.WINRATE_MIN_BIDS && wins === bids) {
                anomalies.push({
                    edrpou: edr,
                    name: companyNames.get(edr) || '',
                    bids,
                    wins,
                    rate: 1,
                })
            }
        }

        anomalies.sort((a, b) => b.bids - a.bids)

        return { anomalies: anomalies.slice(0, 50), allSuppliers }
    }

    private analyzeRegionalDominance(
        tenders: Array<{ prozorroId: string; rawData: Prisma.JsonValue }>,
    ) {
        const regionWinners: Map<string, Map<string, number>> = new Map()
        const companyNames: Map<string, string> = new Map()

        for (const tender of tenders) {
            const rawData = tender.rawData as RawTender
            const { region } = this.extractProcuringEntity(rawData)
            const { winnerId, winnerName } = this.extractWinner(rawData)

            if (region && winnerId) {
                if (!regionWinners.has(region)) {
                    regionWinners.set(region, new Map())
                }
                const winners = regionWinners.get(region)!
                winners.set(winnerId, (winners.get(winnerId) || 0) + 1)
                if (winnerName) companyNames.set(winnerId, winnerName)
            }
        }

        const entries: RegionalDominanceEntry[] = []

        for (const [region, winners] of regionWinners.entries()) {
            const total = Array.from(winners.values()).reduce(
                (a, b) => a + b,
                0,
            )
            if (total < THRESHOLDS.REGIONAL_DOMINANCE_MIN_REGION_SIZE) continue

            const [topWinner, topCount] = Array.from(winners.entries()).sort(
                (a, b) => b[1] - a[1],
            )[0]
            const dominance = (topCount / total) * 100

            if (
                dominance >= THRESHOLDS.REGIONAL_DOMINANCE_PCT &&
                topCount >= THRESHOLDS.REGIONAL_DOMINANCE_MIN_WINS
            ) {
                entries.push({
                    region,
                    dominantEdrpou: topWinner,
                    dominantName: companyNames.get(topWinner) || '',
                    wins: topCount,
                    total,
                    pct: Math.round(dominance * 10) / 10,
                })
            }
        }

        entries.sort((a, b) => b.pct - a.pct)

        return { entries: entries.slice(0, 30) }
    }

    private analyzeMarketConcentration(
        tenders: Array<{
            prozorroId: string
            cpvCodes: string[]
            rawData: Prisma.JsonValue
        }>,
    ) {
        const awardsByMarket: Map<string, Map<string, number>> = new Map()

        for (const tender of tenders) {
            const cpvCodes = tender.cpvCodes || []
            if (cpvCodes.length === 0) continue

            const division = String(cpvCodes[0]).slice(0, 2)
            const rawData = tender.rawData as RawTender
            const { winnerId } = this.extractWinner(rawData)

            if (winnerId) {
                if (!awardsByMarket.has(division)) {
                    awardsByMarket.set(division, new Map())
                }
                const suppliers = awardsByMarket.get(division)!
                suppliers.set(winnerId, (suppliers.get(winnerId) || 0) + 1)
            }
        }

        const entries: HhiEntry[] = []

        for (const [division, supplierWins] of awardsByMarket.entries()) {
            const totalAwards = Array.from(supplierWins.values()).reduce(
                (a, b) => a + b,
                0,
            )
            if (totalAwards < THRESHOLDS.HHI_MIN_TENDERS_PER_DIVISION) continue

            // HHI = sum of squared market shares (as percentages)
            const hhi = Array.from(supplierWins.values()).reduce(
                (sum, wins) => {
                    const share = (wins / totalAwards) * 100
                    return sum + share * share
                },
                0,
            )

            let level: HhiEntry['level']
            if (hhi >= THRESHOLDS.HHI_HIGHLY_CONCENTRATED) {
                level = 'highly concentrated'
            } else if (hhi >= THRESHOLDS.HHI_MODERATE) {
                level = 'moderately concentrated'
            } else {
                level = 'unconcentrated'
            }

            const [topSupplierEdrpou, topWins] = Array.from(
                supplierWins.entries(),
            ).sort((a, b) => b[1] - a[1])[0]

            entries.push({
                cpvDivision: division,
                totalAwards,
                uniqueSuppliers: supplierWins.size,
                hhi: Math.round(hhi * 10) / 10,
                level,
                topSupplierEdrpou,
                topSupplierSharePct:
                    Math.round((topWins / totalAwards) * 1000) / 10,
            })
        }

        entries.sort((a, b) => b.hhi - a.hhi)

        return { entries }
    }

    private analyzeBidRotation(
        tenders: Array<{
            id: number
            prozorroId: string
            rawData: Prisma.JsonValue
        }>,
    ) {
        const cohortTenders: Map<
            string,
            Array<{ tenderId: string; winnerId: string | null }>
        > = new Map()

        for (const tender of tenders) {
            const rawData = tender.rawData as RawTender
            const participants = this.extractParticipants(rawData)

            if (
                Object.keys(participants).length <
                THRESHOLDS.BID_ROTATION_MIN_COHORT_SIZE
            ) {
                continue
            }

            const cohortKey = Object.keys(participants).sort().join('|')
            const { winnerId } = this.extractWinner(rawData)

            if (!cohortTenders.has(cohortKey)) {
                cohortTenders.set(cohortKey, [])
            }
            cohortTenders
                .get(cohortKey)!
                .push({ tenderId: tender.prozorroId, winnerId })
        }

        const cohorts: BidRotationCohort[] = []

        for (const [cohortKey, items] of cohortTenders.entries()) {
            if (items.length < THRESHOLDS.BID_ROTATION_MIN_TENDERS) continue

            const cohortEdrs = cohortKey.split('|')
            const winnerCounts: Map<string, number> = new Map()

            for (const item of items) {
                if (item.winnerId && cohortEdrs.includes(item.winnerId)) {
                    winnerCounts.set(
                        item.winnerId,
                        (winnerCounts.get(item.winnerId) || 0) + 1,
                    )
                }
            }

            const totalWins = Array.from(winnerCounts.values()).reduce(
                (a, b) => a + b,
                0,
            )
            if (totalWins === 0) continue

            // Calculate rotation uniformity
            const n = cohortEdrs.length
            const ideal = 1.0 / n
            let l1 = 0
            for (const edr of cohortEdrs) {
                const wins = winnerCounts.get(edr) || 0
                l1 += Math.abs(wins / totalWins - ideal)
            }
            const maxL1 = 2 * (1 - ideal)
            const uniformity = maxL1 > 0 ? 1.0 - l1 / maxL1 : 0

            if (
                winnerCounts.size >= 2 &&
                uniformity >= THRESHOLDS.BID_ROTATION_UNIFORMITY_THRESHOLD
            ) {
                cohorts.push({
                    cohortEdrs,
                    cohortSize: n,
                    numTenders: items.length,
                    winnersCount: winnerCounts.size,
                    uniformity: Math.round(uniformity * 1000) / 1000,
                })
            }
        }

        cohorts.sort(
            (a, b) =>
                b.uniformity - a.uniformity || b.numTenders - a.numTenders,
        )

        return { cohorts: cohorts.slice(0, 30) }
    }

    // === Helper Methods ===

    private extractParticipants(rawData: RawTender): Record<string, string> {
        const participants: Record<string, string> = {}

        for (const bid of rawData.bids || []) {
            for (const t of bid.tenderers || []) {
                const edr = t.identifier?.id
                const name = t.name || ''
                if (edr) {
                    participants[edr] = name
                }
            }
        }

        return participants
    }

    private extractWinner(rawData: RawTender): {
        winnerId: string | null
        winnerName: string | null
    } {
        for (const award of rawData.awards || []) {
            if (award.status === 'active') {
                for (const s of award.suppliers || []) {
                    const edr = s.identifier?.id
                    const name = s.name || ''
                    if (edr) {
                        return { winnerId: edr, winnerName: name }
                    }
                }
            }
        }
        return { winnerId: null, winnerName: null }
    }

    private extractProcuringEntity(rawData: RawTender): {
        entityId: string | null
        entityName: string
        region: string
    } {
        const pe = rawData.procuringEntity || {}
        return {
            entityId: pe.identifier?.id || null,
            entityName: pe.name || '',
            region: pe.address?.region || '',
        }
    }

    private extractBidValues(
        rawData: RawTender,
    ): Array<{ edr: string; name: string; amount: number }> {
        const bids: Array<{ edr: string; name: string; amount: number }> = []

        for (const bid of rawData.bids || []) {
            let edr = ''
            let name = ''
            for (const t of bid.tenderers || []) {
                edr = t.identifier?.id || ''
                name = t.name || ''
            }

            // Try lotValues first, then value
            let amount: number | null = null
            for (const lv of bid.lotValues || []) {
                if (lv.value?.amount && lv.value.amount > 0) {
                    amount = lv.value.amount
                    break
                }
            }
            if (!amount && bid.value?.amount && bid.value.amount > 0) {
                amount = bid.value.amount
            }

            if (amount && edr) {
                bids.push({ edr, name, amount })
            }
        }

        return bids
    }

    private async updateSupplierStats(
        allSuppliers: Map<
            string,
            { name: string; bids: number; wins: number; rate: number }
        >,
        partnerMap: Map<string, Map<string, { name: string; count: number }>>,
    ) {
        this.logger.log(`Updating ${allSuppliers.size} supplier stats...`)

        const operations: Prisma.PrismaPromise<unknown>[] = []
        for (const [edrpou, data] of allSuppliers.entries()) {
            const partners = partnerMap.get(edrpou)
            const topPartners = partners
                ? Array.from(partners.entries())
                      .map(([e, p]) => ({
                          edrpou: e,
                          name: p.name,
                          count: p.count,
                      }))
                      .sort((a, b) => b.count - a.count)
                      .slice(0, 5)
                : []

            operations.push(
                this.prisma.supplierOsintStats.upsert({
                    where: { edrpou },
                    create: {
                        edrpou,
                        name: data.name,
                        totalBids: data.bids,
                        totalWins: data.wins,
                        winRate: data.rate,
                        topPartners: topPartners,
                    },
                    update: {
                        name: data.name,
                        totalBids: data.bids,
                        totalWins: data.wins,
                        winRate: data.rate,
                        topPartners: topPartners,
                    },
                }),
            )
        }

        // Batch in chunks of 100
        for (let i = 0; i < operations.length; i += 100) {
            await this.prisma.$transaction(operations.slice(i, i + 100))
        }

        this.logger.log('Supplier stats updated')
    }

    private async updateProcuringEntityStats(
        byEntity: Map<string, { name: string; count: number }>,
    ) {
        this.logger.log(`Updating ${byEntity.size} procuring entity stats...`)

        // Get total tenders per entity
        const tenderCounts = await this.prisma.$queryRaw<
            Array<{ procuringEntity: string; count: bigint }>
        >`
            SELECT "procuringEntity", COUNT(*) as count
            FROM "Tender"
            WHERE "procuringEntity" IS NOT NULL
            GROUP BY "procuringEntity"
        `

        const totalMap = new Map(
            tenderCounts.map((r) => [r.procuringEntity, Number(r.count)]),
        )

        const operations: Prisma.PrismaPromise<unknown>[] = []
        for (const [edrpou, data] of byEntity.entries()) {
            const total = totalMap.get(edrpou) || data.count
            const ratio = total > 0 ? data.count / total : 0

            operations.push(
                this.prisma.procuringEntityOsintStats.upsert({
                    where: { edrpou },
                    create: {
                        edrpou,
                        name: data.name,
                        totalTenders: total,
                        singleBidderTenders: data.count,
                        singleBidderRatio: ratio,
                    },
                    update: {
                        name: data.name,
                        totalTenders: total,
                        singleBidderTenders: data.count,
                        singleBidderRatio: ratio,
                    },
                }),
            )
        }

        // Batch in chunks of 100
        for (let i = 0; i < operations.length; i += 100) {
            await this.prisma.$transaction(operations.slice(i, i + 100))
        }

        this.logger.log('Procuring entity stats updated')
    }
}
