import { Module } from '@nestjs/common'

import { NlpModule } from '../nlp/nlp.module'
import { PrismaModule } from '../prisma/prisma.module'
import { RedisModule } from '../redis/redis.module'

import { HealthController } from './health.controller'

@Module({
    imports: [PrismaModule, RedisModule, NlpModule],
    controllers: [HealthController],
})
export class HealthModule {}
