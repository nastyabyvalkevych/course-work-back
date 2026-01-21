import { Module } from '@nestjs/common'

import { ExperimentsController } from './experiments.controller'
import { ExperimentsService } from './experiments.service'
import { MetricsModule } from '../metrics/metrics.module'
import { SearchModule } from '../search/search.module'

@Module({
    imports: [MetricsModule, SearchModule],
    controllers: [ExperimentsController],
    providers: [ExperimentsService],
    exports: [ExperimentsService],
})
export class ExperimentsModule {}
