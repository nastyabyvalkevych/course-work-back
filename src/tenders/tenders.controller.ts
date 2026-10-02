import { Controller, Get, NotFoundException, Param } from '@nestjs/common'

import { TendersService } from './tenders.service'

const INT4_MAX = 2_147_483_647

@Controller('api/tenders')
export class TendersController {
    constructor(private readonly tendersService: TendersService) {}

    @Get(':id')
    async getTender(@Param('id') idParam: string) {
        // Внутрішній id — ціле в межах int4; усе інше шукається як prozorroId.
        const id = /^\d+$/.test(idParam) ? Number(idParam) : NaN
        const tender = Number.isNaN(id)
            ? await this.tendersService.getTenderByProzorroId(idParam)
            : id >= 1 && id <= INT4_MAX
              ? await this.tendersService.getTenderById(id)
              : null

        if (!tender) {
            throw new NotFoundException('Tender not found')
        }

        return tender
    }
}
