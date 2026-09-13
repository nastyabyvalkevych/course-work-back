import { Module } from '@nestjs/common'

import { RedisModule } from '../redis/redis.module'

import { InsightsController } from './insights.controller'
import { InsightsService } from './insights.service'
import { RiskController } from './risk.controller'
import { RiskService } from './risk.service'

@Module({
    imports: [RedisModule],
    controllers: [RiskController, InsightsController],
    providers: [RiskService, InsightsService],
    exports: [RiskService, InsightsService],
})
export class RiskModule {}
