import { Module } from '@nestjs/common'

import { IndexingController } from './indexing.controller'
import { IndexingService } from './indexing.service'
import { NlpModule } from '../nlp/nlp.module'

@Module({
    imports: [NlpModule],
    controllers: [IndexingController],
    providers: [IndexingService],
    exports: [IndexingService],
})
export class IndexingModule {}
