import { Injectable, Logger } from '@nestjs/common'

import { PrismaService } from '../prisma/prisma.service'
import { NlpService } from '../nlp/nlp.service'

type IndexingStatus = 'idle' | 'running'

type IndexingJobState = {
    status: IndexingStatus
    total: number
    processed: number
    startedAt?: Date
    finishedAt?: Date
}

@Injectable()
export class IndexingService {
    private readonly logger = new Logger(IndexingService.name)
    private job: IndexingJobState = { status: 'idle', total: 0, processed: 0 }

    constructor(
        private readonly prisma: PrismaService,
        private readonly nlpService: NlpService,
    ) {}

    async indexTender(tenderId: number): Promise<void> {
        const tender = await this.prisma.tender.findUnique({
            where: { id: tenderId },
        })

        if (!tender) {
            this.logger.warn(`Tender ${tenderId} not found.`)
            return
        }

        await this.prisma.tenderIndex.deleteMany({ where: { tenderId } })

        const { entries, documentLength } = await this.buildIndexEntries(tender)

        if (entries.length > 0) {
            await this.prisma.tenderIndex.createMany({ data: entries })
        }

        await this.prisma.tender.update({
            where: { id: tenderId },
            data: { documentLength },
        })
    }

    async indexTendersBatch(tenderIds: number[]): Promise<void> {
        if (!tenderIds.length) {
            return
        }

        const tenders = await this.prisma.tender.findMany({
            where: { id: { in: tenderIds } },
        })

        if (!tenders.length) {
            return
        }

        await this.prisma.tenderIndex.deleteMany({
            where: { tenderId: { in: tenderIds } },
        })

        const entries: Array<{
            tenderId: number
            term: string
            termFrequency: number
            fieldName: string
        }> = []
        const updates: Array<{ id: number; documentLength: number }> = []

        for (const tender of tenders) {
            const result = await this.buildIndexEntries(tender)
            entries.push(...result.entries)
            updates.push({ id: tender.id, documentLength: result.documentLength })
        }

        if (entries.length > 0) {
            await this.prisma.tenderIndex.createMany({ data: entries })
        }

        await this.prisma.$transaction(
            updates.map((update) =>
                this.prisma.tender.update({
                    where: { id: update.id },
                    data: { documentLength: update.documentLength },
                }),
            ),
        )
    }

    async updateCollectionStats(): Promise<void> {
        const aggregate = await this.prisma.tender.aggregate({
            _count: { _all: true },
            _avg: { documentLength: true },
        })

        const totalDocuments = aggregate._count._all
        const avgDocumentLength = aggregate._avg.documentLength ?? 0

        const uniqueTermsResult = await this.prisma.$queryRaw<
            Array<{ unique_terms: number }>
        >`SELECT COUNT(DISTINCT "term")::int AS unique_terms FROM "TenderIndex"`

        const uniqueTerms = uniqueTermsResult[0]?.unique_terms ?? 0

        const fieldStats = await this.prisma.$queryRaw<
            Array<{ field_name: string; avg_length: number | null }>
        >`
            SELECT "fieldName" AS field_name, AVG(field_length) AS avg_length
            FROM (
                SELECT "tenderId", "fieldName", SUM("termFrequency") AS field_length
                FROM "TenderIndex"
                GROUP BY "tenderId", "fieldName"
            ) AS field_lengths
            GROUP BY "fieldName"
        `

        const avgTitleLength =
            fieldStats.find((row) => row.field_name === 'title')?.avg_length ?? 0
        const avgDescriptionLength =
            fieldStats.find((row) => row.field_name === 'description')?.avg_length ?? 0
        const avgCpvCodesLength =
            fieldStats.find((row) => row.field_name === 'cpv')?.avg_length ?? 0

        await this.prisma.collectionStats.upsert({
            where: { id: 1 },
            update: {
                totalDocuments,
                avgDocumentLength,
                uniqueTerms,
                avgTitleLength,
                avgDescriptionLength,
                avgCpvCodesLength,
                version: { increment: 1 },
            },
            create: {
                id: 1,
                totalDocuments,
                avgDocumentLength,
                uniqueTerms,
                avgTitleLength,
                avgDescriptionLength,
                avgCpvCodesLength,
                version: 1,
            },
        })
    }

    async updateTermStatistics(): Promise<void> {
        const collectionStats = await this.prisma.collectionStats.findFirst({
            where: { id: 1 },
        })

        if (!collectionStats) {
            throw new Error('Collection stats not found. Run updateCollectionStats first.')
        }

        const totalDocuments = collectionStats.totalDocuments

        const termStats = await this.prisma.$queryRaw<
            Array<{
                term: string
                document_frequency: number
                df_title: number
                df_description: number
                df_cpv: number
                collection_frequency: number
            }>
        >`
            SELECT
                "term" AS term,
                COUNT(DISTINCT "tenderId")::int AS document_frequency,
                COUNT(DISTINCT CASE WHEN "fieldName" = 'title' THEN "tenderId" END)::int AS df_title,
                COUNT(DISTINCT CASE WHEN "fieldName" = 'description' THEN "tenderId" END)::int AS df_description,
                COUNT(DISTINCT CASE WHEN "fieldName" = 'cpv' THEN "tenderId" END)::int AS df_cpv,
                SUM("termFrequency")::int AS collection_frequency
            FROM "TenderIndex"
            GROUP BY "term"
        `

        const batchSize = 200
        for (let i = 0; i < termStats.length; i += batchSize) {
            const batch = termStats.slice(i, i + batchSize)
            await this.prisma.$transaction(
                batch.map((row) => {
                    const idf = this.calculateIDF(row.document_frequency, totalDocuments)
                    return this.prisma.termStatistics.upsert({
                        where: { term: row.term },
                        update: {
                            documentFrequency: row.document_frequency,
                            idf,
                            dfTitle: row.df_title,
                            dfDescription: row.df_description,
                            dfCpv: row.df_cpv,
                            collectionFrequency: row.collection_frequency,
                        },
                        create: {
                            term: row.term,
                            documentFrequency: row.document_frequency,
                            idf,
                            dfTitle: row.df_title,
                            dfDescription: row.df_description,
                            dfCpv: row.df_cpv,
                            collectionFrequency: row.collection_frequency,
                        },
                    })
                }),
            )
        }
    }

    calculateIDF(documentFrequency: number, totalDocuments: number): number {
        return Math.log((totalDocuments - documentFrequency + 0.5) / (documentFrequency + 0.5) + 1)
    }

    async clearIndex(): Promise<void> {
        await this.prisma.$transaction([
            this.prisma.tenderIndex.deleteMany(),
            this.prisma.termStatistics.deleteMany(),
            this.prisma.collectionStats.deleteMany(),
            this.prisma.tender.updateMany({ data: { documentLength: 0 } }),
        ])
    }

    async getAllTenderIds(): Promise<number[]> {
        const tenders = await this.prisma.tender.findMany({ select: { id: true } })
        return tenders.map((tender) => tender.id)
    }

    getStatus() {
        if (this.job.status === 'idle') {
            return { status: 'idle' }
        }

        const percentage = this.job.total
            ? (this.job.processed / this.job.total) * 100
            : 0

        return {
            status: this.job.status,
            progress: {
                total: this.job.total,
                processed: this.job.processed,
                percentage,
            },
            startedAt: this.job.startedAt,
            finishedAt: this.job.finishedAt,
        }
    }

    startJob(total: number) {
        this.job = {
            status: 'running',
            total,
            processed: 0,
            startedAt: new Date(),
            finishedAt: undefined,
        }
    }

    updateJobProgress(processedDelta: number) {
        if (this.job.status !== 'running') {
            return
        }
        this.job.processed += processedDelta
    }

    finishJob() {
        if (this.job.status !== 'running') {
            return
        }
        this.job.status = 'idle'
        this.job.finishedAt = new Date()
    }

    private async buildIndexEntries(tender: {
        id: number
        title: string | null
        description: string | null
        cpvCodes: string[]
    }) {
        const fields = [
            { name: 'title', value: tender.title ?? '' },
            { name: 'description', value: tender.description ?? '' },
            { name: 'cpv', value: tender.cpvCodes?.join(' ') ?? '' },
        ]

        const entries: Array<{
            tenderId: number
            term: string
            termFrequency: number
            fieldName: string
        }> = []

        let documentLength = 0

        for (const field of fields) {
            const terms = await this.nlpService.processText(field.value)
            documentLength += terms.length
            const frequencies = this.countTermFrequencies(terms)
            for (const [term, termFrequency] of frequencies) {
                entries.push({
                    tenderId: tender.id,
                    term,
                    termFrequency,
                    fieldName: field.name,
                })
            }
        }

        return { entries, documentLength }
    }

    private countTermFrequencies(terms: string[]): Map<string, number> {
        const frequencies = new Map<string, number>()
        for (const term of terms) {
            frequencies.set(term, (frequencies.get(term) ?? 0) + 1)
        }
        return frequencies
    }
}
