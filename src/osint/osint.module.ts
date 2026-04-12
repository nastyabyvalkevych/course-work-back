import { Module } from '@nestjs/common'

import { PrismaModule } from '../prisma/prisma.module'
import { RedisModule } from '../redis/redis.module'

import { OsintController } from './osint.controller'
import { OsintService } from './osint.service'

@Module({
    imports: [PrismaModule, RedisModule],
    controllers: [OsintController],
    providers: [OsintService],
    exports: [OsintService],
})
export class OsintModule {}
