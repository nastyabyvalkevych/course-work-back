import { Controller, Get, Post } from '@nestjs/common'

import { IndexingService } from './indexing.service'

@Controller('api/indexing')
export class IndexingController {
    constructor(private readonly indexingService: IndexingService) {}

    @Post('index')
    async indexTenders() {
        return this.indexingService.getPlaceholderResponse('index')
    }

    @Get('status')
    async getStatus() {
        return this.indexingService.getPlaceholderResponse('status')
    }

    @Post('update-stats')
    async updateStats() {
        return this.indexingService.getPlaceholderResponse('update-stats')
    }
}
