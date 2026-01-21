import { IsArray, IsBoolean, IsInt, IsOptional, Min } from 'class-validator'

export class IndexRequestDto {
    @IsOptional()
    @IsArray()
    @IsInt({ each: true })
    @Min(1, { each: true })
    tenderIds?: number[]

    @IsOptional()
    @IsBoolean()
    reindex?: boolean
}
