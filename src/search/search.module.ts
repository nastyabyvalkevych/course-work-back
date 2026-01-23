import { Module } from '@nestjs/common'

import { SearchController } from './search.controller'
import { SearchService } from './search.service'
import { NlpModule } from '../nlp/nlp.module'
import { RedisModule } from '../redis/redis.module'

@Module({
    imports: [NlpModule, RedisModule],
    controllers: [SearchController],
    providers: [SearchService],
    exports: [SearchService],
})
export class SearchModule {}
