import { Body, Controller, Post, UseGuards } from '@nestjs/common'

import { ApiKeyGuard } from '../auth/api-key.guard'
import { ProzorroService } from './prozorro.service'

// P3.9: every endpoint here mutates the local tender mirror — guard the lot.
@UseGuards(ApiKeyGuard)
@Controller('api/prozorro')
export class ProzorroController {
    constructor(private readonly prozorroService: ProzorroService) {}

    @Post('fetch')
    async fetchTenders(
        @Body()
        body: {
            limit: number
            offset?: string
            reverse?: boolean
            mode?: 'modified' | 'all'
        },
    ) {
        return this.prozorroService.fetchTenders(body)
    }

    @Post('sync')
    async syncTenders(@Body() body: { since?: string; limit?: number }) {
        return this.prozorroService.syncTenders(body)
    }

    /**
     * Fetch and upsert an explicit list of tenders by their CDB hex ids.
     * Used by the AMCU-tenderer collector (evaluation/collect_amcu_tenderers.py):
     * the collector resolves participant EDRPOU -> tenderID (portal search API)
     * -> hex id (CDB feed), then hands the ids here for storage.
     */
    @Post('fetch-by-ids')
    async fetchTendersByIds(
        @Body() body: { ids: string[]; pauseMs?: number; concurrency?: number },
    ) {
        return this.prozorroService.fetchTendersByIds(
            body?.ids ?? [],
            body?.pauseMs,
            body?.concurrency,
        )
    }
}
