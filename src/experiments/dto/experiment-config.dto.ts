import { Type } from 'class-transformer'
import {
    IsBoolean,
    IsNotEmpty,
    IsNumber,
    IsOptional,
    IsString,
} from 'class-validator'

export class ExperimentConfigDto {
    @IsString()
    @IsNotEmpty()
    name: string

    @Type(() => Number)
    @IsNumber()
    k1: number

    @Type(() => Number)
    @IsNumber()
    b: number

    @IsOptional()
    fieldWeights?: Record<string, number>

    @IsBoolean()
    usesLemmatization: boolean

    @IsOptional()
    @IsBoolean()
    usesMultifield?: boolean
}
