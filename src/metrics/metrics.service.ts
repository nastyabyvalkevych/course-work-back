import { Injectable } from '@nestjs/common'

@Injectable()
export class MetricsService {
    getPlaceholderResponse() {
        return {
            message: 'Metrics calculations are not implemented yet.',
        }
    }
}
