import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import Redis from 'ioredis'

@Injectable()
export class RedisService implements OnModuleDestroy {
    private readonly logger = new Logger(RedisService.name)
    private readonly client: Redis | null

    constructor() {
        const redisUrl = process.env.REDIS_URL
        if (redisUrl) {
            this.client = new Redis(redisUrl)
            this.client.on('error', (error) => {
                this.logger.error(`Redis error: ${String(error)}`)
            })
        } else {
            this.client = null
            this.logger.warn('REDIS_URL is not set. Redis cache is disabled.')
        }
    }

    async get<T>(key: string): Promise<T | null> {
        if (!this.client) {
            return null
        }
        const value = await this.client.get(key)
        if (!value) {
            return null
        }
        return JSON.parse(value) as T
    }

    async set(key: string, value: unknown, ttlSeconds = 60): Promise<void> {
        if (!this.client) {
            return
        }
        await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds)
    }

    async del(key: string): Promise<void> {
        if (!this.client) {
            return
        }
        await this.client.del(key)
    }

    async onModuleDestroy() {
        if (!this.client) {
            return
        }
        await this.client.quit()
    }
}
