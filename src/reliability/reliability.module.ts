import { Module } from '@nestjs/common'

import { RedisModule } from '../redis/redis.module'

import { ReliabilityController } from './reliability.controller'
import { ReliabilityService } from './reliability.service'

@Module({
    imports: [RedisModule],
    controllers: [ReliabilityController],
    providers: [ReliabilityService],
    exports: [ReliabilityService],
})
export class ReliabilityModule {}
