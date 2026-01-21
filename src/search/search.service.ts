import { Injectable } from '@nestjs/common'
import { Prisma, Tender } from '@prisma/client'

import { PrismaService } from '../prisma/prisma.service'
import { NlpService } from '../nlp/nlp.service'

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
    filters?: SearchFilters
}

type SearchResultItem = {
    tender: Tender
    score: number
    highlights: string[]
}

type SearchResponse = {
    query: string
    total: number
    results: SearchResultItem[]
    metadata: {
        queryTimeMs: number
        k1: number
        b: number
    }
}

type CachedStats = {
    value: { totalDocuments: number; avgDocumentLength: number }
    expiresAt: number
}

@Injectable()
export class SearchService {
    private statsCache: CachedStats | null = null
    private readonly cacheTtlMs = 60_000

    constructor(
        private readonly prisma: PrismaService,
        private readonly nlpService: NlpService,
    ) {}

    async search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
        const startTime = Date.now()
        const queryTerms = await this.nlpService.processText(query)

        if (!queryTerms.length) {
            return {
                query,
                total: 0,
                results: [],
                metadata: {
                    queryTimeMs: Date.now() - startTime,
                    k1: options.k1 ?? 1.2,
                    b: options.b ?? 0.75,
                },
            }
        }

        const candidateIds = await this.findCandidates(queryTerms)
        const filteredIds = await this.filterCandidateIds(candidateIds, options.filters)

        const scored: Array<{ tenderId: number; score: number }> = []
        const k1 = options.k1 ?? 1.2
        const b = options.b ?? 0.75

        for (const tenderId of filteredIds) {
            const score = await this.calculateBM25(queryTerms, tenderId, { k1, b })
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

        const results: SearchResultItem[] = slice
            .map((item) => {
                const tender = tenderMap.get(item.tenderId)
                if (!tender) {
                    return null
                }
                return {
                    tender,
                    score: item.score,
                    highlights: this.generateHighlights(tender, queryTerms),
                }
            })
            .filter((item): item is SearchResultItem => Boolean(item))

        return {
            query,
            total: scored.length,
            results,
            metadata: {
                queryTimeMs: Date.now() - startTime,
                k1,
                b,
            },
        }
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
                tf + params.k1 * (1 - params.b + params.b * (docLength / stats.avgDocumentLength))
            const termScore = idf * (numerator / denominator)
            totalScore += termScore
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
        }

        this.statsCache = { value, expiresAt: now + this.cacheTtlMs }

        return value
    }
}
