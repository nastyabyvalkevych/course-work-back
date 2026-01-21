import { Type } from 'class-transformer'
import { IsArray, IsNumber } from 'class-validator'

export class GridSearchDto {
    @IsArray()
    @Type(() => Number)
    @IsNumber({}, { each: true })
    k1Values: number[]

    @IsArray()
    @Type(() => Number)
    @IsNumber({}, { each: true })
    bValues: number[]
}
