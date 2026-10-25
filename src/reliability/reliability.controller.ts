import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common'

import type { ReliabilityProfile } from './markov'
import { ReliabilityService } from './reliability.service'

/**
 * Markov reliability self-assessment.
 *   GET  /api/reliability?horizonHours=24&live=1   report for the built-in profile
 *   GET  /api/reliability/profile                  the built-in operational profile
 *   POST /api/reliability/evaluate?horizonHours=   report for a user-supplied profile
 */
@Controller('api/reliability')
export class ReliabilityController {
    constructor(private readonly service: ReliabilityService) {}

    @Get()
    report(@Query('horizonHours') horizonHours?: string, @Query('live') live?: string) {
        const h = horizonHours ? Number(horizonHours) : 24
        if (live === '1' || live === 'true') return this.service.evaluateLive(h)
        return this.service.evaluate(undefined, h)
    }

    @Get('profile')
    profile() {
        return this.service.profile()
    }

    @Post('evaluate')
    @HttpCode(200) // a computation, nothing is created
    evaluate(@Body() profile: ReliabilityProfile, @Query('horizonHours') horizonHours?: string) {
        return this.service.evaluate(profile, horizonHours ? Number(horizonHours) : 24)
    }
}
