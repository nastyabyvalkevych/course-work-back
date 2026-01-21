import { IsIn, IsOptional } from 'class-validator'

export class ExperimentResultsQueryDto {
    @IsOptional()
    @IsIn(['map', 'precision', 'recall'])
    sortBy?: 'map' | 'precision' | 'recall'

    @IsOptional()
    @IsIn(['asc', 'desc'])
    order?: 'asc' | 'desc'
}
