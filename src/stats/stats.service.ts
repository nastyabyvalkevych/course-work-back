import { Injectable } from '@nestjs/common'

@Injectable()
export class StatsService {
    getPlaceholderResponse() {
        return {
            message: 'Stats endpoint is not implemented yet.',
        }
    }
}
