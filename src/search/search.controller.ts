import { Controller, Get, Query } from '@nestjs/common'

import { SearchService } from './search.service'
import { SearchQueryDto } from './dto/search-query.dto'

@Controller('api/search')
export class SearchController {
    constructor(private readonly searchService: SearchService) {}

    @Get()
    async search(@Query() query: SearchQueryDto) {
        return this.searchService.search(query.q, {
            limit: query.limit,
            offset: query.offset,
            k1: query.k1,
            b: query.b,
            useMultifield: query.useMultifield,
            filters: {
                status: query.status,
                minValue: query.minValue,
                maxValue: query.maxValue,
                dateFrom: query.dateFrom,
                dateTo: query.dateTo,
            },
        })
    }
}
