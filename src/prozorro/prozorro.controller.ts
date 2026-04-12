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
}
