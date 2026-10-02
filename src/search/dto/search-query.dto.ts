import { Transform, Type } from 'class-transformer'
import {
    IsBoolean,
    IsDateString,
    IsIn,
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
    // Лише 'true'/'false'; інше значення лишається рядком і відхиляється @IsBoolean.
    @Transform(({ value }) =>
        value === 'true' ? true : value === 'false' ? false : value,
    )
    @IsBoolean()
    useMultifield?: boolean

    @IsOptional()
    @IsIn(['bm25f_default', 'da_bm25f_combined'])
    profile?: 'bm25f_default' | 'da_bm25f_combined'

    @IsOptional()
    @IsIn(['score', 'date'])
    sort?: 'score' | 'date'
}
