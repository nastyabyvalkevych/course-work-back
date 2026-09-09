import { Module } from '@nestjs/common'

import { RedisModule } from '../redis/redis.module'

import { RiskController } from './risk.controller'
import { RiskService } from './risk.service'

@Module({
    imports: [RedisModule],
    controllers: [RiskController],
    providers: [RiskService],
    exports: [RiskService],
})
export class RiskModule {}
