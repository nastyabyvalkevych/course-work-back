import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common'

import { ApiKeyGuard } from '../auth/api-key.guard'
import { ExperimentsService } from './experiments.service'
import { ExperimentConfigDto } from './dto/experiment-config.dto'
import { GridSearchDto } from './dto/grid-search.dto'
import { ExperimentResultsQueryDto } from './dto/experiment-results-query.dto'

@Controller('api/experiments')
export class ExperimentsController {
    constructor(private readonly experimentsService: ExperimentsService) {}

    // P3.9: experiment runs are expensive (full grid sweep ≈ minutes of CPU)
    // and write to the experiment_results table — guarded.
    @UseGuards(ApiKeyGuard)
    @Post('run')
    async runExperiment(@Body() config: ExperimentConfigDto) {
        return this.experimentsService.runExperiment(config)
    }

    @UseGuards(ApiKeyGuard)
    @Post('grid-search')
    async gridSearch(@Body() dto: GridSearchDto) {
        return this.experimentsService.gridSearch(dto.k1Values, dto.bValues)
    }

    @Get('results')
    async getResults(@Query() query: ExperimentResultsQueryDto) {
        return this.experimentsService.getResults(query.sortBy, query.order)
    }

    @Get('best')
    async getBest() {
        return this.experimentsService.getBest()
    }
}
