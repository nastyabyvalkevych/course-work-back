import { Injectable, Logger } from '@nestjs/common'
import { Prisma } from '@prisma/client'

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
            updates.push({
                id: tender.id,
                documentLength: result.documentLength,
            })
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
            fieldStats.find((row) => row.field_name === 'title')?.avg_length ??
            0
        const avgDescriptionLength =
            fieldStats.find((row) => row.field_name === 'description')
                ?.avg_length ?? 0
        const avgCpvCodesLength =
            fieldStats.find((row) => row.field_name === 'cpv')?.avg_length ?? 0

        // Build per-field average lengths (averaged over ALL documents, not
        // just those that contain the field — standard BM25F convention)
        const avgFieldLengths: Record<string, number> = {}
        for (const row of fieldStats) {
            if (row.avg_length !== null && totalDocuments > 0) {
                // row.avg_length is avg over docs that HAVE the field;
                // we need avg over ALL docs: (avg_per_present * count) / totalDocs
                // Since we don't have count per field, use the per-present avg
                // as a reasonable approximation (fields present in most docs
                // have near-identical values either way)
                avgFieldLengths[row.field_name] = Number(row.avg_length)
            }
        }

        await this.prisma.collectionStats.upsert({
            where: { id: 1 },
            update: {
                totalDocuments,
                avgDocumentLength,
                uniqueTerms,
                avgTitleLength,
                avgDescriptionLength,
                avgCpvCodesLength,
                avgFieldLengths,
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
                avgFieldLengths,
                version: 1,
            },
        })
    }

    async updateTermStatistics(): Promise<void> {
        const collectionStats = await this.prisma.collectionStats.findFirst({
            where: { id: 1 },
        })

        if (!collectionStats) {
            throw new Error(
                'Collection stats not found. Run updateCollectionStats first.',
            )
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
                    const idf = this.calculateIDF(
                        row.document_frequency,
                        totalDocuments,
                    )
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
        return Math.log(
            (totalDocuments - documentFrequency + 0.5) /
                (documentFrequency + 0.5) +
                1,
        )
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
        const tenders = await this.prisma.tender.findMany({
            select: { id: true },
        })
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
        status?: string | null
        rawData: Prisma.JsonValue | null
    }) {
        const raw = this.normalizeRawData(tender.rawData)
        const items = Array.isArray(raw.items) ? raw.items : []
        const bids = Array.isArray(raw.bids) ? raw.bids : []
        const awards = Array.isArray(raw.awards) ? raw.awards : []
        const documents = Array.isArray(raw.documents) ? raw.documents : []
        const milestones = Array.isArray(raw.milestones) ? raw.milestones : []
        const contracts = Array.isArray(raw.contracts) ? raw.contracts : []
        const criteria = Array.isArray(raw.criteria) ? raw.criteria : []
        const itemsText = this.joinValues(
            items.map((item) => item?.description),
        )
        const itemsQuantityText = this.joinValues(
            items.map((item) => {
                const quantity = item?.quantity
                const unitName = item?.unit?.name ?? item?.unit?.code
                if (quantity === undefined && !unitName) {
                    return null
                }
                return [quantity, unitName].filter(Boolean).join(' ')
            }),
        )
        const itemsUnit = this.joinValues(
            items.flatMap((item) => [item?.unit?.name, item?.unit?.code]),
        )
        const cpvText = this.joinValues(
            items.map((item) => item?.classification?.description),
        )

        const procuringEntityName = this.joinValues([
            raw.procuringEntity?.name,
            raw.procuringEntity?.contactPoint?.name,
            raw.procuringEntity?.identifier?.legalName,
        ])
        const procuringEntityId = raw.procuringEntity?.identifier?.id
        const procuringEntityRegion = raw.procuringEntity?.address?.region
        const procuringEntityLocality = raw.procuringEntity?.address?.locality
        const procuringEntityGeoText = this.joinValues([
            procuringEntityRegion,
            procuringEntityLocality,
        ])

        const participantNames = new Set<string>()
        const participantIds = new Set<string>()
        const participantRegions = new Set<string>()
        const participantLocalities = new Set<string>()
        const bidValueTexts: Array<string | number> = []
        const bidUnitPriceTexts: string[] = []

        for (const bid of bids) {
            const tenderers = Array.isArray(bid?.tenderers) ? bid.tenderers : []
            for (const tenderer of tenderers) {
                if (tenderer?.name) {
                    participantNames.add(tenderer.name)
                }
                if (tenderer?.identifier?.legalName) {
                    participantNames.add(tenderer.identifier.legalName)
                }
                if (tenderer?.contactPoint?.name) {
                    participantNames.add(tenderer.contactPoint.name)
                }
                if (tenderer?.identifier?.id) {
                    participantIds.add(String(tenderer.identifier.id))
                }
                if (tenderer?.address?.region) {
                    participantRegions.add(tenderer.address.region)
                }
                if (tenderer?.address?.locality) {
                    participantLocalities.add(tenderer.address.locality)
                }
            }

            const amount = bid?.value?.amount
            const currency = bid?.value?.currency
            if (amount !== undefined && amount !== null) {
                bidValueTexts.push(String(amount))
                if (currency) {
                    bidValueTexts.push(currency)
                }
            }

            const bidItems = Array.isArray(bid?.items) ? bid.items : []
            const totalQuantity = bidItems.reduce((sum, item) => {
                const quantity = Number(item?.quantity ?? 0)
                return sum + (Number.isFinite(quantity) ? quantity : 0)
            }, 0)
            if (amount && totalQuantity > 0) {
                const unitName =
                    bidItems[0]?.unit?.name ?? bidItems[0]?.unit?.code
                const unitPrice = amount / totalQuantity
                const unitText = unitName ? `/${unitName}` : ''
                const currencyText = currency ?? raw.value?.currency ?? 'UAH'
                bidUnitPriceTexts.push(
                    `${unitPrice.toFixed(2)} ${currencyText}${unitText}`,
                )
            }
        }

        // Note: bidsCount, minBidValue, maxBidValue, winnerValueAmounts removed
        // from BM25F indexing (Phase 3, Q4=4ii). Numerical aggregation logic
        // also removed from this builder. If needed for analytics or filters,
        // recompute at query time from raw `bids`/`awards` JSON columns.

        const winnerNames = new Set<string>()
        const winnerIds = new Set<string>()
        const winnerStatuses = new Set<string>()
        const winnerValueCurrencies: Array<string | number> = []

        for (const award of awards) {
            const suppliers = Array.isArray(award?.suppliers)
                ? award.suppliers
                : []
            for (const supplier of suppliers) {
                if (supplier?.name) {
                    winnerNames.add(supplier.name)
                }
                if (supplier?.identifier?.id) {
                    winnerIds.add(String(supplier.identifier.id))
                }
            }
            if (award?.status) {
                winnerStatuses.add(String(award.status))
            }
            if (award?.value?.currency) {
                winnerValueCurrencies.push(String(award.value.currency))
            }
        }

        const deliveryRegions = this.joinValues(
            items.map((item) => item?.deliveryAddress?.region),
        )
        const deliveryLocalities = this.joinValues(
            items.map((item) => item?.deliveryAddress?.locality),
        )
        const deliveryGeoText = this.joinValues([
            deliveryRegions,
            deliveryLocalities,
        ])

        const docsText = this.joinValues(
            documents
                .filter((doc) => {
                    const format = String(doc?.format ?? '').toLowerCase()
                    const title = String(doc?.title ?? '').toLowerCase()
                    const isSignature =
                        format.includes('pkcs7') ||
                        title === 'sign.p7s' ||
                        title.endsWith('.p7s')
                    if (isSignature) {
                        return false
                    }
                    if (format.includes('pdf') || format.includes('doc')) {
                        return true
                    }
                    return (
                        title.endsWith('.pdf') ||
                        title.endsWith('.doc') ||
                        title.endsWith('.docx')
                    )
                })
                .flatMap((doc) => [doc?.documentType, doc?.title]),
        )

        const milestonesText = this.joinValues(
            milestones.flatMap((milestone) => [
                milestone?.title,
                milestone?.description,
            ]),
        )

        const paymentTermsText = milestonesText

        const awardPeriodText = this.joinValues([
            raw.awardPeriod?.startDate,
            raw.awardPeriod?.endDate,
        ])

        const contractStatus = this.joinValues(
            contracts.map((contract) => contract?.status),
        )

        const technicalRequirementsText = this.joinValues(
            criteria.flatMap((criterion) => {
                const groups = Array.isArray(criterion?.requirementGroups)
                    ? criterion.requirementGroups
                    : []
                return groups.flatMap((group) => {
                    const requirements = Array.isArray(group?.requirements)
                        ? group.requirements
                        : []
                    return requirements.flatMap((req) => {
                        const values = Array.isArray(req?.expectedValues)
                            ? req.expectedValues
                            : req?.expectedValue
                              ? [req.expectedValue]
                              : []
                        return [req?.title, ...values]
                    })
                })
            }),
        )

        const technicalResponsesText = this.joinValues(
            bids.flatMap((bid) => {
                const responses = Array.isArray(bid?.requirementResponses)
                    ? bid.requirementResponses
                    : []
                return responses.flatMap((response) => {
                    if (Array.isArray(response?.values)) {
                        return response.values
                    }
                    if (response?.value !== undefined) {
                        return [response.value]
                    }
                    return []
                })
            }),
        )

        // 36-field schema (Phase 3, Q4=4ii): 7 non-textual fields removed
        // (datePublished, dateModified — dates; valueAmount, winnerValueAmount,
        // minBidValue, maxBidValue, bidsCount — numerics).
        // Dates are still queryable via DB filter clauses, not via BM25F text scoring.
        const fields = [
            { name: 'title', value: tender.title ?? '' },
            { name: 'description', value: tender.description ?? '' },
            { name: 'status', value: raw.status ?? tender?.status ?? '' },
            { name: 'valueCurrency', value: raw.value?.currency ?? '' },
            { name: 'cpv', value: tender.cpvCodes?.join(' ') ?? '' },
            { name: 'cpvText', value: cpvText },
            { name: 'itemsText', value: itemsText },
            { name: 'itemsQuantityText', value: itemsQuantityText },
            { name: 'itemsUnit', value: itemsUnit },
            { name: 'procuringEntityName', value: procuringEntityName ?? '' },
            { name: 'procuringEntityId', value: procuringEntityId ?? '' },
            {
                name: 'procuringEntityRegion',
                value: procuringEntityRegion ?? '',
            },
            {
                name: 'procuringEntityLocality',
                value: procuringEntityLocality ?? '',
            },
            { name: 'procuringEntityGeoText', value: procuringEntityGeoText },
            {
                name: 'participantsNames',
                value: this.joinValues(Array.from(participantNames)),
            },
            {
                name: 'participantsIds',
                value: this.joinValues(Array.from(participantIds)),
            },
            {
                name: 'participantsRegions',
                value: this.joinValues(Array.from(participantRegions)),
            },
            {
                name: 'participantsLocalities',
                value: this.joinValues(Array.from(participantLocalities)),
            },
            {
                name: 'winnerNames',
                value: this.joinValues(Array.from(winnerNames)),
            },
            {
                name: 'winnerIds',
                value: this.joinValues(Array.from(winnerIds)),
            },
            {
                name: 'winnerAwardStatus',
                value: this.joinValues(Array.from(winnerStatuses)),
            },
            {
                name: 'winnerValueCurrency',
                value: this.joinValues(winnerValueCurrencies),
            },
            { name: 'bidValuesText', value: this.joinValues(bidValueTexts) },
            {
                name: 'bidUnitPricesText',
                value: this.joinValues(bidUnitPriceTexts),
            },
            { name: 'deliveryRegion', value: deliveryRegions },
            { name: 'deliveryLocality', value: deliveryLocalities },
            { name: 'deliveryGeoText', value: deliveryGeoText },
            { name: 'docsText', value: docsText },
            { name: 'milestonesText', value: milestonesText },
            { name: 'paymentTermsText', value: paymentTermsText },
            {
                name: 'procurementMethodType',
                value: raw.procurementMethodType ?? '',
            },
            { name: 'awardCriteria', value: raw.awardCriteria ?? '' },
            { name: 'awardPeriodText', value: awardPeriodText },
            { name: 'contractStatus', value: contractStatus },
            {
                name: 'technicalRequirementsText',
                value: technicalRequirementsText,
            },
            { name: 'technicalResponsesText', value: technicalResponsesText },
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

    private joinValues(
        values: Array<string | number | null | undefined>,
    ): string {
        const filtered = values
            .flatMap((value) => {
                if (value === null || value === undefined) {
                    return []
                }
                if (Array.isArray(value)) {
                    return value.map((entry) => String(entry))
                }
                return [String(value)]
            })
            .map((value) => value.trim())
            .filter((value) => value.length > 0)

        return Array.from(new Set(filtered)).join(' ')
    }

    private normalizeRawData(
        rawData: Prisma.JsonValue | null,
    ): Record<string, any> {
        if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) {
            return {}
        }
        return rawData as Record<string, any>
    }

    private countTermFrequencies(terms: string[]): Map<string, number> {
        const frequencies = new Map<string, number>()
        for (const term of terms) {
            frequencies.set(term, (frequencies.get(term) ?? 0) + 1)
        }
        return frequencies
    }
}
