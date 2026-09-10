import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import Redis from 'ioredis'

/**
 * Soft cache. Redis is an accelerator, never a dependency: every operation is
 * bounded by a short timeout and any failure degrades to "no cache" instead of
 * failing the request. While Redis is down, ioredis queues commands and would
 * otherwise block callers until its reconnect back-off gives up.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
    private readonly logger = new Logger(RedisService.name)
    private readonly client: Redis | null
    private readonly timeoutMs = Number(process.env.REDIS_TIMEOUT_MS ?? 200)
    private lastErrorLog = 0

    constructor() {
        const redisUrl = process.env.REDIS_URL
        if (redisUrl) {
            this.client = new Redis(redisUrl, {
                enableOfflineQueue: false, // fail fast when disconnected
                maxRetriesPerRequest: 0,
                connectTimeout: 1000,
                lazyConnect: false,
            })
            this.client.on('error', (error) => {
                // ioredis emits one error per reconnect attempt; log at most once a minute
                const now = Date.now()
                if (now - this.lastErrorLog > 60_000) {
                    this.lastErrorLog = now
                    this.logger.warn(`Redis unavailable, running without cache: ${String(error)}`)
                }
            })
        } else {
            this.client = null
            this.logger.warn('REDIS_URL is not set. Redis cache is disabled.')
        }
    }

    /** Resolve with `fallback` if Redis does not answer within the timeout or throws. */
    private async guarded<T>(op: () => Promise<T>, fallback: T): Promise<T> {
        if (!this.client || this.client.status !== 'ready') {
            return fallback
        }
        let timer: NodeJS.Timeout | undefined
        try {
            return await Promise.race([
                op(),
                new Promise<T>((resolve) => {
                    timer = setTimeout(() => resolve(fallback), this.timeoutMs)
                }),
            ])
        } catch {
            return fallback
        } finally {
            if (timer) {
                clearTimeout(timer)
            }
        }
    }

    async get<T>(key: string): Promise<T | null> {
        const value = await this.guarded(() => this.client!.get(key), null as string | null)
        if (!value) {
            return null
        }
        try {
            return JSON.parse(value) as T
        } catch {
            return null
        }
    }

    async set(key: string, value: unknown, ttlSeconds = 60): Promise<void> {
        await this.guarded(
            () => this.client!.set(key, JSON.stringify(value), 'EX', ttlSeconds),
            'OK' as string | null,
        )
    }

    async del(key: string): Promise<void> {
        await this.guarded(() => this.client!.del(key), 0)
    }

    /** Health probe for /api/health and the reliability report. */
    isReady(): boolean {
        return !!this.client && this.client.status === 'ready'
    }

    async onModuleDestroy() {
        if (!this.client) {
            return
        }
        try {
            await this.client.quit()
        } catch {
            this.client.disconnect()
        }
    }
}
