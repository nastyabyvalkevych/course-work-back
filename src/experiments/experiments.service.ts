import { Injectable } from '@nestjs/common'

@Injectable()
export class ExperimentsService {
    getPlaceholderResponse(action: string) {
        return {
            message: `Experiments ${action} endpoint is not implemented yet.`,
        }
    }
}
