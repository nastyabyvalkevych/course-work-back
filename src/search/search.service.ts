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
    fieldB?: Record<string, number>
    exactMatchFields?: string[]
    exactMatchBoost?: number
    profile?: SearchProfile
    sort?: 'score' | 'date'
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
        profile?: SearchProfile
        queryTerms: string[]
    }
}

type SearchProfile = 'bm25f_default' | 'da_bm25f_combined'

type CachedStats = {
    value: {
        totalDocuments: number
        avgDocumentLength: number
        avgTitleLength: number
        avgDescriptionLength: number
        avgCpvCodesLength: number
        avgFieldLengths: Record<string, number>
    }
    expiresAt: number
}

export const DEFAULT_SEARCH_PROFILE: SearchProfile = 'bm25f_default'

export const DEFAULT_FIELD_WEIGHTS = {
    title: 4.0,
    itemsText: 3.0,
    description: 2.5,
    cpvText: 2.0,
    cpv: 1.5,
    participantsNames: 2.5,
    participantsIds: 1.5,
    winnerNames: 2.5,
    winnerIds: 1.5,
    procuringEntityName: 2.0,
    procuringEntityId: 1.0,
    itemsQuantityText: 1.0,
    itemsUnit: 0.8,
    procuringEntityGeoText: 1.0,
    procuringEntityRegion: 0.8,
    procuringEntityLocality: 0.8,
    participantsRegions: 0.6,
    participantsLocalities: 0.6,
    winnerAwardStatus: 0.4,
    winnerValueCurrency: 0.3,
    bidValuesText: 0.7,
    bidUnitPricesText: 0.8,
    deliveryRegion: 0.7,
    deliveryLocality: 0.7,
    deliveryGeoText: 0.8,
    docsText: 0.5,
    milestonesText: 0.5,
    paymentTermsText: 0.5,
    procurementMethodType: 0.4,
    awardCriteria: 0.4,
    awardPeriodText: 0.4,
    contractStatus: 0.4,
    technicalRequirementsText: 1.5,
    technicalResponsesText: 1.0,
    status: 0.3,
    valueCurrency: 0.3,
}

export const DEFAULT_FIELD_B = {
    cpv: 0.0,
    participantsIds: 0.0,
    winnerIds: 0.0,
    procuringEntityId: 0.0,
    status: 0.0,
    procurementMethodType: 0.0,
    winnerAwardStatus: 0.0,
    contractStatus: 0.0,
    valueCurrency: 0.0,
    winnerValueCurrency: 0.0,
    title: 0.1,
    cpvText: 0.1,
    procuringEntityName: 0.2,
    participantsNames: 0.2,
    winnerNames: 0.2,
    description: 0.4,
    itemsText: 0.3,
    technicalRequirementsText: 0.5,
    technicalResponsesText: 0.5,
}

export const EXACT_MATCH_FIELDS = [
    'cpv',
    'participantsIds',
    'winnerIds',
    'procuringEntityId',
    'status',
    'procurementMethodType',
    'winnerAwardStatus',
    'contractStatus',
    'valueCurrency',
    'winnerValueCurrency',
]

export const DEFAULT_EXACT_MATCH_BOOST = 2.0
const CANONICAL_FIELD_NAMES = new Set(Object.keys(DEFAULT_FIELD_WEIGHTS))

export const SEARCH_PROFILE_OPTIONS: Record<
    SearchProfile,
    Partial<SearchOptions>
> = {
    bm25f_default: {
        k1: 0.2,
        b: 0.0,
        useMultifield: true,
        fieldWeights: DEFAULT_FIELD_WEIGHTS,
    },
    da_bm25f_combined: {
        k1: 0.2,
        b: 0.0,
        useMultifield: true,
        fieldWeights: DEFAULT_FIELD_WEIGHTS,
        fieldB: DEFAULT_FIELD_B,
        exactMatchFields: EXACT_MATCH_FIELDS,
        exactMatchBoost: DEFAULT_EXACT_MATCH_BOOST,
    },
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
        const resolvedOptions = this.resolveSearchOptions(options)
        const cacheKey = this.buildSearchCacheKey(query, resolvedOptions)

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
                    k1: resolvedOptions.k1 ?? 0.5,
                    b: resolvedOptions.b ?? 0.0,
                    profile: resolvedOptions.profile,
                    queryTerms,
                },
            }
            await this.redisService.set(cacheKey, emptyResponse)
            return emptyResponse
        }

        const candidateIds = await this.findCandidates(queryTerms)
        const filteredIds = await this.filterCandidateIds(
            candidateIds,
            resolvedOptions.filters,
        )

        const k1 = resolvedOptions.k1 ?? 0.5
        const b = resolvedOptions.b ?? 0.0

        const scored = resolvedOptions.useMultifield
            ? await this.calculateBM25FBatch(filteredIds, queryTerms, {
                  k1,
                  b,
                  fieldWeights:
                      resolvedOptions.fieldWeights ?? DEFAULT_FIELD_WEIGHTS,
                  fieldB: resolvedOptions.fieldB,
                  exactMatchFields: resolvedOptions.exactMatchFields,
                  exactMatchBoost: resolvedOptions.exactMatchBoost,
              })
            : await this.calculateBM25Batch(filteredIds, queryTerms, { k1, b })

        if (resolvedOptions.sort === 'date') {
            const dateRows = await this.prisma.tender.findMany({
                where: { id: { in: scored.map((s) => s.tenderId) } },
                select: { id: true, datePublished: true },
            })
            const dateMap = new Map(
                dateRows.map((row) => [row.id, row.datePublished]),
            )
            scored.sort((a, bItem) => {
                const dateA = dateMap.get(a.tenderId)?.getTime() ?? 0
                const dateB = dateMap.get(bItem.tenderId)?.getTime() ?? 0
                if (dateB !== dateA) {
                    return dateB - dateA
                }
                return a.tenderId - bItem.tenderId
            })
        } else {
            scored.sort((a, bItem) => {
                if (bItem.score !== a.score) {
                    return bItem.score - a.score
                }
                return a.tenderId - bItem.tenderId
            })
        }

        const limit = resolvedOptions.limit ?? 20
        const offset = resolvedOptions.offset ?? 0
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
                profile: resolvedOptions.profile,
                queryTerms,
            },
        }
        await this.redisService.set(cacheKey, response)

        return response
    }

    private resolveSearchOptions(options: SearchOptions): SearchOptions {
        const effectiveProfile =
            options.profile ??
            (options.useMultifield === false
                ? undefined
                : DEFAULT_SEARCH_PROFILE)
        const filters = Object.fromEntries(
            Object.entries(options.filters ?? {}).filter(
                ([, value]) => value !== undefined,
            ),
        ) as SearchFilters
        const sanitizedOptions = Object.fromEntries(
            Object.entries(options).filter(
                ([key, value]) => key !== 'filters' && value !== undefined,
            ),
        ) as SearchOptions

        if (!effectiveProfile) {
            return {
                ...sanitizedOptions,
                filters,
            }
        }

        const profileOptions = SEARCH_PROFILE_OPTIONS[effectiveProfile]
        if (!profileOptions) {
            return {
                ...sanitizedOptions,
                filters,
            }
        }

        return {
            ...profileOptions,
            ...sanitizedOptions,
            profile: effectiveProfile,
            fieldWeights: options.fieldWeights ?? profileOptions.fieldWeights,
            fieldB: options.fieldB ?? profileOptions.fieldB,
            exactMatchFields:
                options.exactMatchFields ?? profileOptions.exactMatchFields,
            exactMatchBoost:
                options.exactMatchBoost ?? profileOptions.exactMatchBoost,
            filters,
        }
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

        return candidates.map((candidate) => candidate.tenderId)
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
        params: {
            k1: number
            b: number
            fieldWeights: Record<string, number>
            fieldB?: Record<string, number>
            exactMatchFields?: string[]
            exactMatchBoost?: number
        },
    ): Promise<number> {
        if (!queryTerms.length) {
            return 0
        }

        const stats = await this.getCollectionStats()
        if (!stats.totalDocuments) {
            return 0
        }

        const fieldLengths = await this.getFieldLengths(tenderId)
        const indexEntries = (
            await this.prisma.tenderIndex.findMany({
                where: { tenderId, term: { in: queryTerms } },
            })
        ).filter((entry) => CANONICAL_FIELD_NAMES.has(entry.fieldName))

        const termStats = await this.prisma.termStatistics.findMany({
            where: { term: { in: queryTerms } },
        })

        const termStatsMap = new Map(termStats.map((stat) => [stat.term, stat]))
        const exactMatchFields = new Set(params.exactMatchFields ?? [])
        const exactMatchBoost = params.exactMatchBoost ?? 1

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
                const fieldB = params.fieldB?.[entry.fieldName] ?? params.b

                const numerator = entry.termFrequency * (params.k1 + 1)
                const denominator =
                    entry.termFrequency +
                    params.k1 *
                        (1 - fieldB + fieldB * (fieldLength / avgFieldLength))
                let contribution = weight * (numerator / denominator)

                if (exactMatchFields.has(entry.fieldName)) {
                    contribution *= exactMatchBoost
                }

                fieldScore += contribution
            }

            totalScore += stat.idf * fieldScore
        }

        return totalScore
    }

    async calculateBM25Batch(
        tenderIds: number[],
        queryTerms: string[],
        params: { k1: number; b: number },
    ): Promise<Array<{ tenderId: number; score: number }>> {
        if (!queryTerms.length || !tenderIds.length) {
            return tenderIds.map((tenderId) => ({ tenderId, score: 0 }))
        }

        const stats = await this.getCollectionStats()
        if (!stats.totalDocuments || !stats.avgDocumentLength) {
            return tenderIds.map((tenderId) => ({ tenderId, score: 0 }))
        }

        const [tenders, indexEntries, termStats] = await Promise.all([
            this.prisma.tender.findMany({
                where: { id: { in: tenderIds } },
                select: { id: true, documentLength: true },
            }),
            this.prisma.tenderIndex.findMany({
                where: {
                    tenderId: { in: tenderIds },
                    term: { in: queryTerms },
                },
            }),
            this.prisma.termStatistics.findMany({
                where: { term: { in: queryTerms } },
            }),
        ])

        const docLengthMap = new Map(
            tenders.map((t) => [t.id, t.documentLength ?? 0]),
        )
        const termStatsMap = new Map(termStats.map((s) => [s.term, s]))

        const indexByTender = new Map<number, typeof indexEntries>()
        for (const entry of indexEntries) {
            const arr = indexByTender.get(entry.tenderId) ?? []
            arr.push(entry)
            indexByTender.set(entry.tenderId, arr)
        }

        return tenderIds.map((tenderId) => {
            const docLength = docLengthMap.get(tenderId) ?? 0
            const entries = indexByTender.get(tenderId) ?? []

            let totalScore = 0
            for (const term of queryTerms) {
                const entry = entries.find((e) => e.term === term)
                if (!entry) continue
                const stat = termStatsMap.get(term)
                if (!stat) continue

                const tf = entry.termFrequency
                const idf = stat.idf
                const numerator = tf * (params.k1 + 1)
                const denominator =
                    tf +
                    params.k1 *
                        (1 -
                            params.b +
                            params.b * (docLength / stats.avgDocumentLength))
                totalScore += idf * (numerator / denominator)
            }

            return { tenderId, score: totalScore }
        })
    }

    async calculateBM25FBatch(
        tenderIds: number[],
        queryTerms: string[],
        params: {
            k1: number
            b: number
            fieldWeights: Record<string, number>
            fieldB?: Record<string, number>
            exactMatchFields?: string[]
            exactMatchBoost?: number
        },
    ): Promise<Array<{ tenderId: number; score: number }>> {
        if (!queryTerms.length || !tenderIds.length) {
            return tenderIds.map((tenderId) => ({ tenderId, score: 0 }))
        }

        const stats = await this.getCollectionStats()
        if (!stats.totalDocuments) {
            return tenderIds.map((tenderId) => ({ tenderId, score: 0 }))
        }

        const [fieldLengthsAll, indexEntries, termStats] = await Promise.all([
            this.getFieldLengthsBatch(tenderIds),
            this.prisma.tenderIndex.findMany({
                where: {
                    tenderId: { in: tenderIds },
                    term: { in: queryTerms },
                },
            }),
            this.prisma.termStatistics.findMany({
                where: { term: { in: queryTerms } },
            }),
        ])

        const termStatsMap = new Map(termStats.map((s) => [s.term, s]))
        const exactMatchFields = new Set(params.exactMatchFields ?? [])
        const exactMatchBoost = params.exactMatchBoost ?? 1

        const indexByTender = new Map<number, typeof indexEntries>()
        for (const entry of indexEntries) {
            if (!CANONICAL_FIELD_NAMES.has(entry.fieldName)) continue
            const arr = indexByTender.get(entry.tenderId) ?? []
            arr.push(entry)
            indexByTender.set(entry.tenderId, arr)
        }

        return tenderIds.map((tenderId) => {
            const fieldLengths = fieldLengthsAll.get(tenderId) ?? {}
            const entries = indexByTender.get(tenderId) ?? []

            let totalScore = 0
            let matchedTermCount = 0

            for (const term of queryTerms) {
                const stat = termStatsMap.get(term)
                if (!stat) continue

                let fieldScore = 0
                for (const entry of entries) {
                    if (entry.term !== term) continue

                    const weight = params.fieldWeights[entry.fieldName] ?? 1
                    const fieldLength = fieldLengths[entry.fieldName] ?? 0
                    const avgFieldLength = this.resolveAvgFieldLength(
                        stats,
                        entry.fieldName,
                    )
                    const fieldB = params.fieldB?.[entry.fieldName] ?? params.b

                    const numerator = entry.termFrequency * (params.k1 + 1)
                    const denominator =
                        entry.termFrequency +
                        params.k1 *
                            (1 -
                                fieldB +
                                fieldB * (fieldLength / avgFieldLength))
                    let contribution = weight * (numerator / denominator)

                    if (exactMatchFields.has(entry.fieldName)) {
                        contribution *= exactMatchBoost
                    }

                    fieldScore += contribution
                }

                if (fieldScore > 0) {
                    matchedTermCount++
                }
                totalScore += stat.idf * fieldScore
            }

            // Coordination factor: boost documents that match more query terms
            const coordFactor =
                queryTerms.length > 0 ? matchedTermCount / queryTerms.length : 1
            const finalScore = totalScore * coordFactor

            return { tenderId, score: finalScore }
        })
    }

    private async getFieldLengthsBatch(
        tenderIds: number[],
    ): Promise<Map<number, Record<string, number>>> {
        if (!tenderIds.length) {
            return new Map()
        }

        const rows = await this.prisma.$queryRaw<
            Array<{
                tender_id: number
                field_name: string
                field_length: number
            }>
        >(
            Prisma.sql`
                SELECT "tenderId" AS tender_id,
                    "fieldName" AS field_name,
                    SUM("termFrequency")::int AS field_length
                FROM "TenderIndex"
                WHERE "tenderId" = ANY(${tenderIds}::int[])
                GROUP BY "tenderId", "fieldName"
            `,
        )

        const result = new Map<number, Record<string, number>>()
        for (const row of rows) {
            const fields = result.get(row.tender_id) ?? {}
            fields[row.field_name] = row.field_length
            result.set(row.tender_id, fields)
        }

        return result
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
            if (!CANONICAL_FIELD_NAMES.has(entry.fieldName)) {
                return
            }
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
        avgFieldLengths: Record<string, number>
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
            avgFieldLengths: this.parseAvgFieldLengths(stats?.avgFieldLengths),
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
            avgFieldLengths: Record<string, number>
        },
        fieldName: string,
    ): number {
        const avgFieldLength = stats.avgFieldLengths[fieldName]
        if (avgFieldLength && avgFieldLength > 0) {
            return avgFieldLength
        }
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

    private parseAvgFieldLengths(value: Prisma.JsonValue | null | undefined) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return {}
        }

        return Object.entries(value as Record<string, unknown>).reduce<
            Record<string, number>
        >((acc, [field, avgLength]) => {
            if (typeof avgLength === 'number' && Number.isFinite(avgLength)) {
                acc[field] = avgLength
            } else if (
                typeof avgLength === 'string' &&
                Number.isFinite(Number(avgLength))
            ) {
                acc[field] = Number(avgLength)
            }
            return acc
        }, {})
    }
}
