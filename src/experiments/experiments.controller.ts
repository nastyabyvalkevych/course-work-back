import { Controller, Get, Post } from '@nestjs/common'

import { ExperimentsService } from './experiments.service'

@Controller('api/experiments')
export class ExperimentsController {
    constructor(private readonly experimentsService: ExperimentsService) {}

    @Post('run')
    async runExperiment() {
        return this.experimentsService.getPlaceholderResponse('run')
    }

    @Post('grid-search')
    async gridSearch() {
        return this.experimentsService.getPlaceholderResponse('grid-search')
    }

    @Get('results')
    async getResults() {
        return this.experimentsService.getPlaceholderResponse('results')
    }

    @Get('best')
    async getBest() {
        return this.experimentsService.getPlaceholderResponse('best')
    }
}
