import { Transform, Type } from 'class-transformer'
import {
    IsBoolean,
    IsDateString,
    IsInt,
    IsNotEmpty,
    IsNumber,
    IsOptional,
    IsString,
    Max,
    Min,
} from 'class-validator'

export class SearchQueryDto {
    @IsString()
    @IsNotEmpty()
    q: string

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(100)
    limit?: number = 20

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    offset?: number = 0

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    @Min(0)
    @Max(5)
    k1?: number

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    @Min(0)
    @Max(1)
    b?: number

    @IsOptional()
    @IsString()
    status?: string

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    minValue?: number

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    maxValue?: number

    @IsOptional()
    @IsDateString()
    dateFrom?: string

    @IsOptional()
    @IsDateString()
    dateTo?: string

    @IsOptional()
    @Transform(({ value }) =>
        value === undefined ? undefined : value === 'true' || value === true,
    )
    @IsBoolean()
    useMultifield?: boolean

    @IsOptional()
    @IsString()
    profile?: 'bm25f_default' | 'da_bm25f_combined'

    @IsOptional()
    @IsString()
    sort?: 'score' | 'date'
}
