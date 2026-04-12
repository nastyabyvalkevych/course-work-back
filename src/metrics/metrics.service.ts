import { Injectable } from '@nestjs/common'
import { RelevanceJudgment } from '@prisma/client'

type SearchResultItem = {
    tender: { id: number }
    score: number
}

@Injectable()
export class MetricsService {
    calculatePrecision(
        results: SearchResultItem[],
        judgments: RelevanceJudgment[],
        k: number = 10,
    ): number {
        const topK = results.slice(0, k)
        const relevant = topK.filter((result) =>
            this.isRelevant(result.tender.id, judgments),
        )
        return k > 0 ? relevant.length / k : 0
    }

    calculateRecall(
        results: SearchResultItem[],
        judgments: RelevanceJudgment[],
        k: number = 10,
    ): number {
        const topK = results.slice(0, k)
        const totalRelevant = judgments.filter(
            (judgment) => judgment.relevanceScore >= 2,
        ).length
        if (!totalRelevant) {
            return 0
        }
        const found = topK.filter((result) =>
            this.isRelevant(result.tender.id, judgments),
        ).length
        return found / totalRelevant
    }

    calculateAveragePrecision(
        results: SearchResultItem[],
        judgments: RelevanceJudgment[],
    ): number {
        const totalRelevant = judgments.filter(
            (judgment) => judgment.relevanceScore >= 2,
        ).length
        if (!totalRelevant) {
            return 0
        }

        let sumPrecision = 0
        let numRelevant = 0

        for (let i = 0; i < results.length; i += 1) {
            if (this.isRelevant(results[i].tender.id, judgments)) {
                numRelevant += 1
                sumPrecision += numRelevant / (i + 1)
            }
        }

        return sumPrecision / totalRelevant
    }

    private isRelevant(
        tenderId: number,
        judgments: RelevanceJudgment[],
    ): boolean {
        const judgment = judgments.find((item) => item.tenderId === tenderId)
        return Boolean(judgment && judgment.relevanceScore >= 2)
    }
}
