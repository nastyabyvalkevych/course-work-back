import { Controller, Get, NotFoundException, Param } from '@nestjs/common'

import { TendersService } from './tenders.service'

@Controller('api/tenders')
export class TendersController {
    constructor(private readonly tendersService: TendersService) {}

    @Get(':id')
    async getTender(@Param('id') idParam: string) {
        const id = Number(idParam)
        const tender = Number.isNaN(id)
            ? await this.tendersService.getTenderByProzorroId(idParam)
            : await this.tendersService.getTenderById(id)

        if (!tender) {
            throw new NotFoundException('Tender not found')
        }

        return tender
    }
}
