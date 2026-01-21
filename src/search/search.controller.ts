import { Controller, Get, Query } from '@nestjs/common'

import { SearchService } from './search.service'

@Controller('api/search')
export class SearchController {
    constructor(private readonly searchService: SearchService) {}

    @Get()
    async search(@Query('q') query?: string) {
        return this.searchService.search(query ?? '')
    }
}
