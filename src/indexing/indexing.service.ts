import { Injectable } from '@nestjs/common'

@Injectable()
export class IndexingService {
    getPlaceholderResponse(action: string) {
        return {
            message: `Indexing ${action} endpoint is not implemented yet.`,
        }
    }
}
