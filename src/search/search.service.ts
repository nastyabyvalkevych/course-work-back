import { Injectable } from '@nestjs/common'

@Injectable()
export class SearchService {
    async search(query: string) {
        return {
            query,
            results: [],
            message: 'Search is not implemented yet.',
        }
    }
}
