import { Body, Controller, Get, Post, Query } from '@nestjs/common'

import { SearchBodyDto } from './dto/search-body.dto'
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
            profile: query.profile,
            sort: query.sort,
            filters: {
                status: query.status,
                minValue: query.minValue,
                maxValue: query.maxValue,
                dateFrom: query.dateFrom,
                dateTo: query.dateTo,
            },
        })
    }

    @Post()
    async searchWithBody(@Body() body: SearchBodyDto) {
        return this.searchService.search(body.q, {
            limit: body.limit,
            offset: body.offset,
            k1: body.k1,
            b: body.b,
            useMultifield: body.useMultifield,
            profile: body.profile,
            sort: body.sort,
            fieldWeights: body.fieldWeights,
            fieldB: body.fieldB,
            exactMatchFields: body.exactMatchFields,
            exactMatchBoost: body.exactMatchBoost,
            filters: {
                status: body.status,
                minValue: body.minValue,
                maxValue: body.maxValue,
                dateFrom: body.dateFrom,
                dateTo: body.dateTo,
            },
        })
    }
}
