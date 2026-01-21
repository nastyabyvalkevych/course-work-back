import { Module } from '@nestjs/common'

import { ProzorroController } from './prozorro.controller'
import { ProzorroService } from './prozorro.service'

@Module({
    controllers: [ProzorroController],
    providers: [ProzorroService],
    exports: [ProzorroService],
})
export class ProzorroModule {}
