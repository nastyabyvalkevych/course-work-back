import { Injectable } from '@nestjs/common'

import { PrismaService } from '../prisma/prisma.service'

@Injectable()
export class StatsService {
    constructor(private readonly prisma: PrismaService) {}

    async getStats() {
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

        return {
            totalTenders,
            statusDistribution: statusGroups.map((group) => ({
                status: group.status ?? 'Unknown',
                count: group._count.status,
            })),
            topTerms,
        }
    }
}
