import { BadRequestException, Injectable } from '@nestjs/common'

import { PrismaService } from '../prisma/prisma.service'
import { RedisService } from '../redis/redis.service'

import { DEFAULT_PROFILE } from './default-profile'
import { ProfileError, ReliabilityProfile, ReliabilityReport, evaluateProfile } from './markov'

export interface LiveStatus {
    database: 'ok' | 'down'
    cache: 'ok' | 'unavailable'
}

/**
 * Self-assessment of the API's reliability. The static profile gives the
 * design-time estimate; `live` folds in the current state of the dependencies
 * (database unreachable → PostgreSQL module reliability 0, Redis unavailable →
 * every cached task runs its no-cache path).
 */
@Injectable()
export class ReliabilityService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly redis: RedisService,
    ) {}

    profile(): ReliabilityProfile {
        return DEFAULT_PROFILE
    }

    evaluate(profile: ReliabilityProfile = DEFAULT_PROFILE, horizonHours = 24): ReliabilityReport {
        if (!(horizonHours > 0 && horizonHours <= 24 * 365)) throw new BadRequestException('horizonHours must be in (0, 8760]')
        try {
            return evaluateProfile(profile, horizonHours)
        } catch (error) {
            if (error instanceof ProfileError) throw new BadRequestException(error.message)
            throw error
        }
    }

    async liveStatus(): Promise<LiveStatus> {
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
        return { database, cache: this.redis.isReady() ? 'ok' : 'unavailable' }
    }

    /** Apply the observed dependency state to a profile. Pure; exported for tests. */
    static applyLiveStatus(profile: ReliabilityProfile, status: LiveStatus): ReliabilityProfile {
        const modules = profile.modules.map((m) => (m.id === 'postgres' && status.database === 'down' ? { ...m, reliability: 0 } : m))
        let tasks = profile.tasks
        if (status.cache === 'unavailable') {
            const byId = new Map(tasks.map((t) => [t.id, t]))
            tasks = tasks.map((t) => {
                if (t.id.endsWith('_hit')) return { ...t, weight: 0 }
                if (t.id.endsWith('_miss')) {
                    const hit = byId.get(t.id.replace(/_miss$/, '_hit'))
                    return hit ? { ...t, weight: t.weight + hit.weight } : t
                }
                return t
            })
        }
        return { ...profile, modules, tasks }
    }

    async evaluateLive(horizonHours = 24): Promise<ReliabilityReport & { live: LiveStatus }> {
        const status = await this.liveStatus()
        const report = this.evaluate(ReliabilityService.applyLiveStatus(DEFAULT_PROFILE, status), horizonHours)
        return { ...report, live: status }
    }
}
