import { Body, Controller, Post } from '@nestjs/common'

import { NlpService } from './nlp.service'

@Controller('api/nlp')
export class NlpController {
    constructor(private readonly nlpService: NlpService) {}

    @Post('process')
    async processText(@Body('text') text?: string) {
        const tokens = await this.nlpService.processText(text ?? '')
        return { tokens }
    }
}
