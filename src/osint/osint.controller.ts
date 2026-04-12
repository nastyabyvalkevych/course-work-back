import { Controller, Get, Post, Param, UseGuards } from '@nestjs/common'

import { ApiKeyGuard } from '../auth/api-key.guard'

import { OsintService } from './osint.service'

@Controller('api/osint')
export class OsintController {
    constructor(private readonly osintService: OsintService) {}

    @Get('report')
    async getLatestReport() {
        return this.osintService.getLatestReport()
    }

    @Get('report/:id')
    async getReportById(@Param('id') id: string) {
        return this.osintService.getReportById(parseInt(id, 10))
    }

    @Get('supplier/:edrpou')
    async getSupplierStats(@Param('edrpou') edrpou: string) {
        return this.osintService.getSupplierStats(edrpou)
    }

    @Get('entity/:edrpou')
    async getProcuringEntityStats(@Param('edrpou') edrpou: string) {
        return this.osintService.getProcuringEntityStats(edrpou)
    }

    @Get('tender/:tenderId/signals')
    async getTenderSignals(@Param('tenderId') tenderId: string) {
        return this.osintService.getTenderSignals(tenderId)
    }

    @Post('generate')
    @UseGuards(ApiKeyGuard)
    async generateReport() {
        return this.osintService.generateReport()
    }
}
