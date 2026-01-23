import { Module } from '@nestjs/common'

import { AppController } from './app.controller'
import { AppService } from './app.service'
import { ExperimentsModule } from './experiments/experiments.module'
import { HealthModule } from './health/health.module'
import { IndexingModule } from './indexing/indexing.module'
import { MetricsModule } from './metrics/metrics.module'
import { NlpModule } from './nlp/nlp.module'
import { PrismaModule } from './prisma/prisma.module'
import { ProzorroModule } from './prozorro/prozorro.module'
import { SearchModule } from './search/search.module'
import { StatsModule } from './stats/stats.module'
import { TendersModule } from './tenders/tenders.module'

@Module({
    imports: [
        PrismaModule,
        HealthModule,
        ProzorroModule,
        NlpModule,
        IndexingModule,
        SearchModule,
        ExperimentsModule,
        MetricsModule,
        StatsModule,
        TendersModule,
    ],
    controllers: [AppController],
    providers: [AppService],
})
export class AppModule {}
