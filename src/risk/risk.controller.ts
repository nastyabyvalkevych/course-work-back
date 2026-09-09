import { Controller, Get, Param, Query } from '@nestjs/common'

import { RiskService } from './risk.service'

/**
 * Bid-rigging risk API (read-only, public).
 *   GET /api/risk/summary
 *   GET /api/risk/ranking?limit&offset&minTenders&excludeKnown&fullCoverageOnly&q
 *   GET /api/risk/company/:edrpou
 *   GET /api/risk/company/:edrpou/graph?limit
 *   GET /api/risk/tender/:id        (numeric id, hex prozorroId or UA-YYYY-... tenderID)
 */
@Controller('api/risk')
export class RiskController {
    constructor(private readonly riskService: RiskService) {}

    @Get('summary')
    summary() {
        return this.riskService.summary()
    }

    @Get('ranking')
    ranking(
        @Query('limit') limit?: string,
        @Query('offset') offset?: string,
        @Query('minTenders') minTenders?: string,
        @Query('excludeKnown') excludeKnown?: string,
        @Query('fullCoverageOnly') fullCoverageOnly?: string,
        @Query('q') q?: string,
    ) {
        return this.riskService.ranking({
            limit: limit ? Number(limit) : undefined,
            offset: offset ? Number(offset) : undefined,
            minTenders: minTenders ? Number(minTenders) : undefined,
            excludeKnown: excludeKnown === '1' || excludeKnown === 'true',
            fullCoverageOnly: fullCoverageOnly === '1' || fullCoverageOnly === 'true',
            q,
        })
    }

    @Get('company/:edrpou')
    company(@Param('edrpou') edrpou: string) {
        return this.riskService.company(edrpou.trim())
    }

    @Get('company/:edrpou/graph')
    graph(@Param('edrpou') edrpou: string, @Query('limit') limit?: string) {
        return this.riskService.graph(edrpou.trim(), limit ? Number(limit) : undefined)
    }

    @Get('tender/:id')
    tender(@Param('id') id: string) {
        return this.riskService.tender(id.trim())
    }
}
