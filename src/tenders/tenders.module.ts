import { Module } from '@nestjs/common'

import { PrismaModule } from '../prisma/prisma.module'
import { TendersController } from './tenders.controller'
import { TendersService } from './tenders.service'

@Module({
    imports: [PrismaModule],
    controllers: [TendersController],
    providers: [TendersService],
})
export class TendersModule {}
