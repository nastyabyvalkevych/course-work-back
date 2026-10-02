import { Controller, Get, HttpCode, Res } from '@nestjs/common'
import type { Response } from 'express'

import { NlpService } from '../nlp/nlp.service'
import { PrismaService } from '../prisma/prisma.service'
import { RedisService } from '../redis/redis.service'

/**
 * Liveness + readiness. `database` is required (503 when down); `cache` is
 * optional and only reported, because the API degrades to no-cache mode.
 */
@Controller('health')
export class HealthController {
    constructor(
        private readonly prisma: PrismaService,
        private readonly redis: RedisService,
        private readonly nlp: NlpService,
    ) {}

    @Get()
    @HttpCode(200)
    async getHealth(@Res({ passthrough: true }) res: Response) {
        const started = Date.now()
        let database: 'ok' | 'down' = 'down'
        try {
            await Promise.race([
                this.prisma.$queryRaw`SELECT 1`,
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
            ])
            database = 'ok'
        } catch {
            database = 'down'
        }
        // Лематизатор необов'язковий: за його відмови пошук працює на словоформах, стан — degraded (R4.1).
        const lemmatizer = (await this.nlp.isLemmatizerAvailable())
            ? 'ok'
            : 'unavailable (surface-form search)'
        const body = {
            status: database === 'ok' && lemmatizer === 'ok' ? 'ok' : 'degraded',
            service: 'prozorro-insight-backend',
            components: {
                database,
                cache: this.redis.isReady() ? 'ok' : 'unavailable (no-cache mode)',
                lemmatizer,
            },
            latencyMs: Date.now() - started,
            timestamp: new Date().toISOString(),
        }
        if (database !== 'ok') {
            res.status(503)
        }
        return body
    }
}
