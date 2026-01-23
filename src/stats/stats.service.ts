import { Injectable } from '@nestjs/common'

import { PrismaService } from '../prisma/prisma.service'
import { RedisService } from '../redis/redis.service'

@Injectable()
export class StatsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly redisService: RedisService,
    ) {}

    async getStats() {
        const cacheKey = 'stats:summary'
        const cached = await this.redisService.get<{
            totalTenders: number
            statusDistribution: Array<{ status: string; count: number }>
            topTerms: Array<{ term: string; documentFrequency: number }>
        }>(cacheKey)

        if (cached) {
            return cached
        }

        const [totalTenders, statusGroups, topTerms] = await Promise.all([
            this.prisma.tender.count(),
            this.prisma.tender.groupBy({
                by: ['status'],
                _count: { status: true },
                orderBy: { _count: { status: 'desc' } },
            }),
            this.prisma.termStatistics.findMany({
                orderBy: { documentFrequency: 'desc' },
                take: 10,
                select: { term: true, documentFrequency: true },
            }),
        ])

        const response = {
            totalTenders,
            statusDistribution: statusGroups.map((group) => ({
                status: group.status ?? 'Unknown',
                count: group._count.status,
            })),
            topTerms,
        }
        await this.redisService.set(cacheKey, response)
        return response
    }
}
