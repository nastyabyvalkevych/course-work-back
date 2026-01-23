import { Injectable } from '@nestjs/common'
import { Tender } from '@prisma/client'

import { PrismaService } from '../prisma/prisma.service'

@Injectable()
export class TendersService {
    constructor(private readonly prisma: PrismaService) {}

    async getTenderById(id: number): Promise<Tender | null> {
        return this.prisma.tender.findUnique({ where: { id } })
    }

    async getTenderByProzorroId(prozorroId: string): Promise<Tender | null> {
        return this.prisma.tender.findUnique({ where: { prozorroId } })
    }
}
