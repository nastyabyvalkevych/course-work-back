import { Body, Controller, HttpCode, Post } from '@nestjs/common'

import { NlpService } from './nlp.service'

@Controller('api/nlp')
export class NlpController {
    constructor(private readonly nlpService: NlpService) {}

    @Post('process')
    @HttpCode(200)
    async processText(@Body('text') text?: string) {
        const tokens = await this.nlpService.processText(text ?? '')
        return { tokens }
    }
}
