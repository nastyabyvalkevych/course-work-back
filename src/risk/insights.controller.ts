import { Controller, Get, Param, Query } from '@nestjs/common'

import { InsightsService } from './insights.service'

/**
 *   GET /api/risk/buyers?limit&region&minTenders&q
 *   GET /api/risk/buyer/:edrpou
 *   GET /api/risk/groups?limit&offset&region&minSize&sort=risk|money|size|sanctioned&onlyUnsanctioned
 *   GET /api/risk/groups/:id
 *   GET /api/risk/company/:edrpou/links
 *   GET /api/risk/company/:edrpou/groups
 *   GET /api/risk/markets?minTenders
 *   GET /api/risk/money?by=year|region
 */
@Controller('api/risk')
export class InsightsController {
    constructor(private readonly service: InsightsService) {}

    @Get('buyers')
    buyers(@Query('limit') limit?: string, @Query('region') region?: string, @Query('minTenders') minTenders?: string, @Query('q') q?: string) {
        return this.service.buyers({ limit: limit ? Number(limit) : undefined, region, minTenders: minTenders ? Number(minTenders) : undefined, q })
    }

    @Get('buyer/:edrpou')
    buyer(@Param('edrpou') edrpou: string) {
        return this.service.buyer(edrpou.trim())
    }

    @Get('groups')
    groups(@Query('limit') limit?: string, @Query('offset') offset?: string, @Query('region') region?: string,
           @Query('minSize') minSize?: string, @Query('sort') sort?: string, @Query('onlyUnsanctioned') onlyUnsanctioned?: string) {
        return this.service.groups({ limit: limit ? Number(limit) : undefined, offset: offset ? Number(offset) : undefined, region,
            minSize: minSize ? Number(minSize) : undefined, sort, onlyUnsanctioned: onlyUnsanctioned === '1' || onlyUnsanctioned === 'true' })
    }

    @Get('groups/:id')
    group(@Param('id') id: string) {
        return this.service.group(Number(id))
    }

    @Get('company/:edrpou/links')
    links(@Param('edrpou') edrpou: string) {
        return this.service.links(edrpou.trim())
    }

    @Get('company/:edrpou/groups')
    companyGroups(@Param('edrpou') edrpou: string) {
        return this.service.groupsOfCompany(edrpou.trim())
    }

    @Get('markets')
    markets(@Query('minTenders') minTenders?: string) {
        return this.service.markets(minTenders ? Number(minTenders) : undefined)
    }

    @Get('money')
    money(@Query('by') by?: string) {
        return this.service.money(by === 'region' ? 'region' : 'year')
    }
}
