import { Injectable } from '@nestjs/common'
import { Prisma, Tender } from '@prisma/client'

import { PrismaService } from '../prisma/prisma.service'
import { NlpService } from '../nlp/nlp.service'
import { RedisService } from '../redis/redis.service'

type SearchFilters = {
    status?: string
    minValue?: number
    maxValue?: number
    dateFrom?: string
    dateTo?: string
}

type SearchOptions = {
    limit?: number
    offset?: number
    k1?: number
    b?: number
    useMultifield?: boolean
    fieldWeights?: Record<string, number>
    filters?: SearchFilters
}

type SearchResultItem = {
    tender: Tender
    score: number
    highlights: string[]
    matchedFields: string[]
    matchedTerms: Array<{ field: string; terms: string[] }>
}

type SearchResponse = {
    query: string
    total: number
    results: SearchResultItem[]
    metadata: {
        queryTimeMs: number
        k1: number
        b: number
        queryTerms: string[]
    }
}

type CachedStats = {
    value: {
        totalDocuments: number
        avgDocumentLength: number
        avgTitleLength: number
        avgDescriptionLength: number
        avgCpvCodesLength: number
    }
    expiresAt: number
}

const DEFAULT_FIELD_WEIGHTS = {
    title: 3,
    itemsText: 2.5,
    description: 1.5,
    cpvText: 1.8,
    cpv: 1.5,
    participantsNames: 2,
    participantsIds: 1.8,
    winnerNames: 2,
    winnerIds: 1.8,
    procuringEntityName: 1.2,
    procuringEntityId: 1,
    itemsQuantityText: 1,
    itemsUnit: 0.8,
    procuringEntityGeoText: 0.8,
    procuringEntityRegion: 0.6,
    procuringEntityLocality: 0.6,
    participantsRegions: 0.6,
    participantsLocalities: 0.6,
    winnerAwardStatus: 0.5,
    winnerValueAmount: 0.7,
    winnerValueCurrency: 0.5,
    bidValuesText: 0.7,
    bidUnitPricesText: 0.9,
    minBidValue: 0.4,
    maxBidValue: 0.4,
    bidsCount: 0.4,
    deliveryRegion: 0.8,
    deliveryLocality: 0.8,
    deliveryGeoText: 1,
    docsText: 0.6,
    milestonesText: 0.6,
    paymentTermsText: 0.6,
    procurementMethodType: 0.4,
    awardCriteria: 0.4,
    awardPeriodText: 0.4,
    contractStatus: 0.4,
    technicalRequirementsText: 1.2,
    technicalResponsesText: 1,
    status: 0.3,
    datePublished: 0.3,
    dateModified: 0.3,
    valueAmount: 0.5,
    valueCurrency: 0.3,
}

@Injectable()
export class SearchService {
    private statsCache: CachedStats | null = null
    private readonly cacheTtlMs = 60_000

    constructor(
        private readonly prisma: PrismaService,
        private readonly nlpService: NlpService,
        private readonly redisService: RedisService,
    ) {}

    async search(
        query: string,
        options: SearchOptions = {},
    ): Promise<SearchResponse> {
        const startTime = Date.now()
        const queryTerms = await this.nlpService.processText(query)
        const cacheKey = this.buildSearchCacheKey(query, options)

        const cached = await this.redisService.get<SearchResponse>(cacheKey)
        if (cached) {
            return cached
        }

        if (!queryTerms.length) {
            const emptyResponse = {
                query,
                total: 0,
                results: [],
                metadata: {
                    queryTimeMs: Date.now() - startTime,
                    k1: options.k1 ?? 0.5,
                    b: options.b ?? 0.0,
                    queryTerms,
                },
            }
            await this.redisService.set(cacheKey, emptyResponse)
            return emptyResponse
        }

        const candidateIds = await this.findCandidates(queryTerms)
        const filteredIds = await this.filterCandidateIds(
            candidateIds,
            options.filters,
        )

        const scored: Array<{ tenderId: number; score: number }> = []
        const k1 = options.k1 ?? 0.5
        const b = options.b ?? 0.0

        for (const tenderId of filteredIds) {
            const score = options.useMultifield
                ? await this.calculateBM25F(queryTerms, tenderId, {
                      k1,
                      b,
                      fieldWeights:
                          options.fieldWeights ?? DEFAULT_FIELD_WEIGHTS,
                  })
                : await this.calculateBM25(queryTerms, tenderId, { k1, b })
            scored.push({ tenderId, score })
        }

        scored.sort((a, bItem) => bItem.score - a.score)

        const limit = options.limit ?? 20
        const offset = options.offset ?? 0
        const slice = scored.slice(offset, offset + limit)
        const tenderIds = slice.map((item) => item.tenderId)

        const tenders = await this.prisma.tender.findMany({
            where: { id: { in: tenderIds } },
        })

        const tenderMap = new Map(tenders.map((tender) => [tender.id, tender]))
        const matchedTermsMap = await this.getMatchedTerms(
            tenderIds,
            queryTerms,
        )

        const results: SearchResultItem[] = slice
            .map((item) => {
                const tender = tenderMap.get(item.tenderId)
                if (!tender) {
                    return null
                }
                const matchedTerms = matchedTermsMap.get(tender.id) ?? []
                return {
                    tender,
                    score: item.score,
                    highlights: this.generateHighlights(tender, queryTerms),
                    matchedFields: matchedTerms.map((match) => match.field),
                    matchedTerms,
                }
            })
            .filter((item): item is SearchResultItem => Boolean(item))

        const response = {
            query,
            total: scored.length,
            results,
            metadata: {
                queryTimeMs: Date.now() - startTime,
                k1,
                b,
                queryTerms,
            },
        }
        await this.redisService.set(cacheKey, response)

        return response
    }

    private buildSearchCacheKey(query: string, options: SearchOptions): string {
        const cachePayload = {
            query,
            options: {
                ...options,
                filters: options.filters ?? {},
            },
        }
        return `search:${this.stableStringify(cachePayload)}`
    }

    private stableStringify(value: unknown): string {
        if (value === null || value === undefined) {
            return 'null'
        }
        if (typeof value !== 'object') {
            return JSON.stringify(value)
        }
        if (Array.isArray(value)) {
            return `[${value.map((item) => this.stableStringify(item)).join(',')}]`
        }
        const entries = Object.entries(value as Record<string, unknown>).sort(
            ([keyA], [keyB]) => keyA.localeCompare(keyB),
        )
        return `{${entries
            .map(
                ([key, entryValue]) =>
                    `${JSON.stringify(key)}:${this.stableStringify(entryValue)}`,
            )
            .join(',')}}`
    }

    async findCandidates(queryTerms: string[]): Promise<number[]> {
        if (!queryTerms.length) {
            return []
        }

        const candidates = await this.prisma.tenderIndex.findMany({
            where: { term: { in: queryTerms } },
            select: { tenderId: true },
            distinct: ['tenderId'],
        })

        const candidateIds = candidates.map((candidate) => candidate.tenderId)

        if (candidateIds.length <= 1000) {
            return candidateIds
        }

        const minMatch = Math.ceil(queryTerms.length / 2)
        const matchCounts = await this.prisma.$queryRaw<
            Array<{ tender_id: number; matched_terms: number }>
        >(
            Prisma.sql`
                SELECT "tenderId" AS tender_id,
                    COUNT(DISTINCT "term")::int AS matched_terms
                FROM "TenderIndex"
                WHERE "term" IN (${Prisma.join(queryTerms)})
                GROUP BY "tenderId"
                HAVING COUNT(DISTINCT "term") >= ${minMatch}
            `,
        )

        return matchCounts.map((row) => row.tender_id)
    }

    async calculateBM25(
        queryTerms: string[],
        tenderId: number,
        params: { k1: number; b: number },
    ): Promise<number> {
        if (!queryTerms.length) {
            return 0
        }

        const stats = await this.getCollectionStats()
        if (!stats.totalDocuments || !stats.avgDocumentLength) {
            return 0
        }

        const tender = await this.prisma.tender.findUnique({
            where: { id: tenderId },
            select: { documentLength: true },
        })

        const docLength = tender?.documentLength ?? 0

        const indexEntries = await this.prisma.tenderIndex.findMany({
            where: { tenderId, term: { in: queryTerms } },
        })

        const termStats = await this.prisma.termStatistics.findMany({
            where: { term: { in: queryTerms } },
        })

        const termStatsMap = new Map(termStats.map((stat) => [stat.term, stat]))

        let totalScore = 0
        for (const term of queryTerms) {
            const entry = indexEntries.find((item) => item.term === term)
            if (!entry) {
                continue
            }
            const stat = termStatsMap.get(term)
            if (!stat) {
                continue
            }
            const tf = entry.termFrequency
            const idf = stat.idf
            const numerator = tf * (params.k1 + 1)
            const denominator =
                tf +
                params.k1 *
                    (1 -
                        params.b +
                        params.b * (docLength / stats.avgDocumentLength))
            const termScore = idf * (numerator / denominator)
            totalScore += termScore
        }

        return totalScore
    }

    async calculateBM25F(
        queryTerms: string[],
        tenderId: number,
        params: { k1: number; b: number; fieldWeights: Record<string, number> },
    ): Promise<number> {
        if (!queryTerms.length) {
            return 0
        }

        const stats = await this.getCollectionStats()
        if (!stats.totalDocuments) {
            return 0
        }

        const fieldLengths = await this.getFieldLengths(tenderId)
        const indexEntries = await this.prisma.tenderIndex.findMany({
            where: { tenderId, term: { in: queryTerms } },
        })

        const termStats = await this.prisma.termStatistics.findMany({
            where: { term: { in: queryTerms } },
        })

        const termStatsMap = new Map(termStats.map((stat) => [stat.term, stat]))

        let totalScore = 0
        for (const term of queryTerms) {
            const stat = termStatsMap.get(term)
            if (!stat) {
                continue
            }

            let fieldScore = 0
            for (const entry of indexEntries) {
                if (entry.term !== term) {
                    continue
                }
                const weight = params.fieldWeights[entry.fieldName] ?? 1
                const fieldLength = fieldLengths[entry.fieldName] ?? 0
                const avgFieldLength = this.resolveAvgFieldLength(
                    stats,
                    entry.fieldName,
                )

                const numerator = entry.termFrequency * (params.k1 + 1)
                const denominator =
                    entry.termFrequency +
                    params.k1 *
                        (1 -
                            params.b +
                            params.b * (fieldLength / avgFieldLength))
                fieldScore += weight * (numerator / denominator)
            }

            totalScore += stat.idf * fieldScore
        }

        return totalScore
    }

    private async filterCandidateIds(
        candidateIds: number[],
        filters?: SearchFilters,
    ): Promise<number[]> {
        if (!candidateIds.length) {
            return []
        }

        if (!filters) {
            return candidateIds
        }

        const where: Prisma.TenderWhereInput = {
            id: { in: candidateIds },
        }

        if (filters.status) {
            where.status = filters.status
        }

        if (filters.minValue !== undefined || filters.maxValue !== undefined) {
            where.valueAmount = {}
            if (filters.minValue !== undefined) {
                where.valueAmount.gte = filters.minValue
            }
            if (filters.maxValue !== undefined) {
                where.valueAmount.lte = filters.maxValue
            }
        }

        if (filters.dateFrom || filters.dateTo) {
            where.datePublished = {}
            if (filters.dateFrom) {
                where.datePublished.gte = new Date(filters.dateFrom)
            }
            if (filters.dateTo) {
                where.datePublished.lte = new Date(filters.dateTo)
            }
        }

        const tenders = await this.prisma.tender.findMany({
            where,
            select: { id: true },
        })

        return tenders.map((tender) => tender.id)
    }

    private async getMatchedTerms(
        tenderIds: number[],
        queryTerms: string[],
    ): Promise<Map<number, Array<{ field: string; terms: string[] }>>> {
        if (!tenderIds.length || !queryTerms.length) {
            return new Map()
        }

        const entries = await this.prisma.tenderIndex.findMany({
            where: {
                tenderId: { in: tenderIds },
                term: { in: queryTerms },
            },
            select: { tenderId: true, fieldName: true, term: true },
        })

        const matched = new Map<number, Map<string, Set<string>>>()
        entries.forEach((entry) => {
            const tenderEntry = matched.get(entry.tenderId) ?? new Map()
            const terms = tenderEntry.get(entry.fieldName) ?? new Set<string>()
            terms.add(entry.term.toLowerCase())
            tenderEntry.set(entry.fieldName, terms)
            matched.set(entry.tenderId, tenderEntry)
        })

        return new Map(
            Array.from(matched.entries()).map(([tenderId, fields]) => [
                tenderId,
                Array.from(fields.entries()).map(([field, terms]) => ({
                    field,
                    terms: Array.from(terms),
                })),
            ]),
        )
    }

    private generateHighlights(tender: Tender, queryTerms: string[]): string[] {
        const title = tender.title?.toLowerCase() ?? ''
        const highlights = new Set<string>()

        for (const term of queryTerms) {
            if (title.includes(term.toLowerCase())) {
                highlights.add(term)
            }
        }

        return Array.from(highlights)
    }

    private async getCollectionStats(): Promise<{
        totalDocuments: number
        avgDocumentLength: number
        avgTitleLength: number
        avgDescriptionLength: number
        avgCpvCodesLength: number
    }> {
        const now = Date.now()
        if (this.statsCache && this.statsCache.expiresAt > now) {
            return this.statsCache.value
        }

        const stats = await this.prisma.collectionStats.findFirst({
            where: { id: 1 },
        })

        const value = {
            totalDocuments: stats?.totalDocuments ?? 0,
            avgDocumentLength: stats?.avgDocumentLength ?? 0,
            avgTitleLength: stats?.avgTitleLength ?? 1,
            avgDescriptionLength: stats?.avgDescriptionLength ?? 1,
            avgCpvCodesLength: stats?.avgCpvCodesLength ?? 1,
        }

        this.statsCache = { value, expiresAt: now + this.cacheTtlMs }

        return value
    }

    private async getFieldLengths(
        tenderId: number,
    ): Promise<Record<string, number>> {
        const rows = await this.prisma.$queryRaw<
            Array<{ field_name: string; field_length: number }>
        >(
            Prisma.sql`
                SELECT "fieldName" AS field_name,
                    SUM("termFrequency")::int AS field_length
                FROM "TenderIndex"
                WHERE "tenderId" = ${tenderId}
                GROUP BY "fieldName"
            `,
        )

        return rows.reduce<Record<string, number>>((acc, row) => {
            acc[row.field_name] = row.field_length
            return acc
        }, {})
    }

    private resolveAvgFieldLength(
        stats: {
            avgTitleLength: number
            avgDescriptionLength: number
            avgCpvCodesLength: number
        },
        fieldName: string,
    ): number {
        if (fieldName === 'title') {
            return stats.avgTitleLength || 1
        }
        if (fieldName === 'description') {
            return stats.avgDescriptionLength || 1
        }
        if (fieldName === 'cpv') {
            return stats.avgCpvCodesLength || 1
        }
        return 1
    }
}
