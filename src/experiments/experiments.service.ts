import { Injectable, Logger } from '@nestjs/common'
import { ExperimentResult } from '@prisma/client'

import { PrismaService } from '../prisma/prisma.service'
import { MetricsService } from '../metrics/metrics.service'
import { SearchService } from '../search/search.service'

type ExperimentConfig = {
    name: string
    k1: number
    b: number
    fieldWeights?: Record<string, number>
    usesLemmatization: boolean
    usesMultifield?: boolean
}

@Injectable()
export class ExperimentsService {
    private readonly logger = new Logger(ExperimentsService.name)

    constructor(
        private readonly prisma: PrismaService,
        private readonly metricsService: MetricsService,
        private readonly searchService: SearchService,
    ) {}

    async runExperiment(config: ExperimentConfig): Promise<ExperimentResult> {
        const testQueries = await this.prisma.testQuery.findMany()

        if (!testQueries.length) {
            throw new Error('No test queries found.')
        }

        if (config.usesMultifield) {
            this.logger.warn(
                'BM25F is not implemented yet. Falling back to BM25.',
            )
        }

        let sumPrecision = 0
        let sumRecall = 0
        let sumAP = 0

        for (const query of testQueries) {
            const results = await this.searchService.search(query.queryText, {
                k1: config.k1,
                b: config.b,
                useMultifield: config.usesMultifield ?? false,
                fieldWeights: config.fieldWeights,
            })

            const judgments = await this.prisma.relevanceJudgment.findMany({
                where: { queryId: query.id },
            })

            const precision = this.metricsService.calculatePrecision(
                results.results,
                judgments,
            )
            const recall = this.metricsService.calculateRecall(
                results.results,
                judgments,
            )
            const ap = this.metricsService.calculateAveragePrecision(
                results.results,
                judgments,
            )

            sumPrecision += precision
            sumRecall += recall
            sumAP += ap
        }

        const numQueries = testQueries.length

        return this.prisma.experimentResult.create({
            data: {
                experimentName: config.name,
                k1: config.k1,
                b: config.b,
                fieldWeights: config.fieldWeights,
                usesLemmatization: config.usesLemmatization,
                usesMultifield: config.usesMultifield ?? false,
                precisionAt10: sumPrecision / numQueries,
                recallAt10: sumRecall / numQueries,
                meanAvgPrecision: sumAP / numQueries,
                numTestQueries: numQueries,
            },
        })
    }

    async gridSearch(
        k1Values: number[],
        bValues: number[],
    ): Promise<ExperimentResult[]> {
        const results: ExperimentResult[] = []

        for (const k1 of k1Values) {
            for (const b of bValues) {
                const result = await this.runExperiment({
                    name: `k1=${k1}, b=${b}`,
                    k1,
                    b,
                    usesLemmatization: true,
                    usesMultifield: false,
                })
                results.push(result)
            }
        }

        return results
    }

    async getResults(
        sortBy?: 'map' | 'precision' | 'recall',
        order: 'asc' | 'desc' = 'desc',
    ) {
        const orderByField =
            sortBy === 'precision'
                ? 'precisionAt10'
                : sortBy === 'recall'
                  ? 'recallAt10'
                  : 'meanAvgPrecision'

        return this.prisma.experimentResult.findMany({
            orderBy: { [orderByField]: order },
        })
    }

    async getBest(): Promise<ExperimentResult | null> {
        return this.prisma.experimentResult.findFirst({
            orderBy: { meanAvgPrecision: 'desc' },
        })
    }
}
