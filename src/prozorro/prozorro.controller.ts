import { Body, Controller, Post } from '@nestjs/common'

import { ProzorroService } from './prozorro.service'

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
