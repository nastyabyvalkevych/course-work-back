import { Module } from '@nestjs/common'

import { PrismaModule } from '../prisma/prisma.module'
import { RedisModule } from '../redis/redis.module'

import { StatsController } from './stats.controller'
import { StatsService } from './stats.service'

@Module({
    imports: [PrismaModule, RedisModule],
    controllers: [StatsController],
    providers: [StatsService],
    exports: [StatsService],
})
export class StatsModule {}
