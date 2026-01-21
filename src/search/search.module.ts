import { Module } from '@nestjs/common'

import { SearchController } from './search.controller'
import { SearchService } from './search.service'
import { NlpModule } from '../nlp/nlp.module'

@Module({
    imports: [NlpModule],
    controllers: [SearchController],
    providers: [SearchService],
    exports: [SearchService],
})
export class SearchModule {}
