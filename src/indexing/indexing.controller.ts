import { Body, Controller, Get, Logger, Post } from '@nestjs/common'

import { IndexingService } from './indexing.service'
import { IndexRequestDto } from './dto/index-request.dto'

@Controller('api/indexing')
export class IndexingController {
    constructor(private readonly indexingService: IndexingService) {}
    private readonly logger = new Logger(IndexingController.name)

    @Post('index')
    async indexTenders(@Body() dto: IndexRequestDto) {
        const startTime = Date.now()

        if (dto.reindex) {
            await this.indexingService.clearIndex()
        }

        const tenderIds = dto.tenderIds ?? (await this.indexingService.getAllTenderIds())
        const total = tenderIds.length
        const batchSize = 100

        this.indexingService.startJob(total)

        try {
            for (let i = 0; i < tenderIds.length; i += batchSize) {
                const batch = tenderIds.slice(i, i + batchSize)
                await this.indexingService.indexTendersBatch(batch)
                this.indexingService.updateJobProgress(batch.length)
                this.logger.log(`Indexed ${Math.min(i + batch.length, total)}/${total} tenders`)
            }

            await this.indexingService.updateCollectionStats()
            await this.indexingService.updateTermStatistics()
        } finally {
            this.indexingService.finishJob()
        }

        const duration = (Date.now() - startTime) / 1000

        return {
            indexed: total,
            duration,
            message: `Indexed ${total} tenders in ${duration.toFixed(2)}s`,
        }
    }

    @Get('status')
    async getStatus() {
        return this.indexingService.getStatus()
    }

    @Post('update-stats')
    async updateStats() {
        await this.indexingService.updateCollectionStats()
        await this.indexingService.updateTermStatistics()
        return { message: 'Stats updated.' }
    }
}
