import { Injectable, Logger } from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { PrismaService } from '../prisma/prisma.service'

@Injectable()
export class ProzorroService {
    private readonly logger = new Logger(ProzorroService.name)
    private readonly baseUrl =
        process.env.PROZORRO_API_URL ?? 'https://api.prozorro.gov.ua/api/2.5'

    constructor(private readonly prisma: PrismaService) {}

    async fetchTenders(params: {
        limit: number
        offset?: string
        reverse?: boolean
        mode?: 'modified' | 'all'
    }) {
        const limit = params.limit ?? 100
        const reverse = params.reverse ?? true
        const mode = params.mode ?? 'modified'
        if (!limit || limit <= 0) {
            return {
                fetched: 0,
                stored: 0,
                failed: 0,
                message: 'Limit must be positive.',
            }
        }

        const listResponse = await this.fetchTenderList({
            limit,
            offset: params.offset,
            reverse,
            mode,
        })
        const tenders = listResponse.data ?? []

        let stored = 0
        let failed = 0
        let newestModified: Date | null = null
        let oldestModified: Date | null = null

        for (const tender of tenders) {
            try {
                const details = await this.fetchTenderById(tender.id)
                if (!details?.data) {
                    failed += 1
                    continue
                }
                const tenderData = this.parseTenderData(details.data)
                const modifiedAt = this.normalizeDate(tenderData.dateModified)
                if (modifiedAt) {
                    if (!newestModified || modifiedAt > newestModified) {
                        newestModified = modifiedAt
                    }
                    if (!oldestModified || modifiedAt < oldestModified) {
                        oldestModified = modifiedAt
                    }
                }
                await this.prisma.tender.upsert({
                    where: { prozorroId: tenderData.prozorroId },
                    create: tenderData,
                    update: tenderData,
                })
                stored += 1
            } catch (error) {
                this.logger.warn(
                    `Failed to store tender ${tender.id}: ${String(error)}`,
                )
                failed += 1
            }
        }

        return {
            fetched: tenders.length,
            stored,
            failed,
            nextOffset: this.resolveNextOffset(listResponse, reverse),
            effectiveOffset: listResponse?.offset ?? null,
            requestUrl: listResponse?.requestUrl ?? null,
            newestModified,
            oldestModified,
            message: 'Fetch completed.',
        }
    }

    async syncTenders(params: { since?: string; limit?: number }) {
        const sinceDate = params.since ? new Date(params.since) : undefined
        const limit = params.limit ?? 100
        const listResponse = await this.fetchTenderList({
            limit,
            reverse: true,
        })
        const tenders = listResponse.data ?? []

        let stored = 0
        let skipped = 0
        let failed = 0
        let newestModified: Date | null = null
        let oldestModified: Date | null = null

        for (const tender of tenders) {
            try {
                const details = await this.fetchTenderById(tender.id)
                const data = details?.data
                if (!data) {
                    failed += 1
                    continue
                }

                const modifiedAt = this.resolveModifiedDate(data)
                if (sinceDate && modifiedAt && modifiedAt < sinceDate) {
                    skipped += 1
                    continue
                }

                const tenderData = this.parseTenderData(data)
                const storedModified = this.normalizeDate(
                    tenderData.dateModified,
                )
                if (storedModified) {
                    if (!newestModified || storedModified > newestModified) {
                        newestModified = storedModified
                    }
                    if (!oldestModified || storedModified < oldestModified) {
                        oldestModified = storedModified
                    }
                }
                await this.prisma.tender.upsert({
                    where: { prozorroId: tenderData.prozorroId },
                    create: tenderData,
                    update: tenderData,
                })
                stored += 1
            } catch (error) {
                this.logger.warn(
                    `Failed to sync tender ${tender.id}: ${String(error)}`,
                )
                failed += 1
            }
        }

        return {
            fetched: tenders.length,
            stored,
            skipped,
            failed,
            nextOffset: this.resolveNextOffset(listResponse, true),
            effectiveOffset: listResponse?.offset ?? null,
            requestUrl: listResponse?.requestUrl ?? null,
            newestModified,
            oldestModified,
            message: 'Sync completed.',
        }
    }

    async fetchTenderById(prozorroId: string) {
        const url = `${this.baseUrl}/tenders/${prozorroId}`
        return this.requestJson(url)
    }

    parseTenderData(apiData: Record<string, any>): Prisma.TenderCreateInput {
        const cpvCodes = this.extractCpvCodes(apiData)

        const publishedAt = this.resolvePublishedDate(apiData)
        const modifiedAt = this.resolveModifiedDate(apiData)

        return {
            prozorroId:
                apiData.id ?? apiData.tenderID ?? apiData._id ?? 'unknown',
            title: apiData.title ?? null,
            description: apiData.description ?? null,
            procuringEntity: apiData.procuringEntity?.name ?? null,
            cpvCodes,
            valueAmount: apiData.value?.amount ?? null,
            valueCurrency: apiData.value?.currency ?? null,
            status: apiData.status ?? null,
            datePublished: publishedAt,
            dateModified: modifiedAt,
            documentLength: 0,
            rawData: apiData,
        }
    }

    private async fetchTenderList(params: {
        limit: number
        offset?: string
        reverse?: boolean
        mode?: 'modified' | 'all'
    }) {
        const query = new URLSearchParams({ limit: String(params.limit) })
        const offset = this.resolveOffset(params)
        if (offset) {
            query.set('offset', offset)
        }
        if (params.reverse) {
            query.set('reverse', '1')
        }
        if (params.mode) {
            query.set('mode', params.mode)
        }
        const requestUrl = `${this.baseUrl}/tenders?${query.toString()}`
        const response = await this.requestJson(requestUrl)
        return { ...response, offset, requestUrl }
    }

    private async requestJson(url: string) {
        const response = await fetch(url, {
            headers: { Accept: 'application/json' },
        })

        if (!response.ok) {
            throw new Error(`Request failed (${response.status}): ${url}`)
        }

        return response.json()
    }

    private extractCpvCodes(apiData: Record<string, any>): string[] {
        const codes = new Set<string>()

        if (apiData.classification?.id) {
            codes.add(apiData.classification.id)
        }

        const items = Array.isArray(apiData.items) ? apiData.items : []
        for (const item of items) {
            if (item?.classification?.id) {
                codes.add(item.classification.id)
            }

            const additional = Array.isArray(item?.additionalClassifications)
                ? item.additionalClassifications
                : []
            for (const entry of additional) {
                if (entry?.id) {
                    codes.add(entry.id)
                }
            }
        }

        return Array.from(codes)
    }

    private resolvePublishedDate(apiData: Record<string, any>): Date | null {
        const value = apiData.datePublished ?? apiData.date
        if (!value) {
            return null
        }
        const parsed = new Date(value)
        return Number.isNaN(parsed.getTime()) ? null : parsed
    }

    private resolveModifiedDate(apiData: Record<string, any>): Date | null {
        const value = apiData.dateModified ?? apiData.date
        if (!value) {
            return null
        }
        const parsed = new Date(value)
        return Number.isNaN(parsed.getTime()) ? null : parsed
    }

    private normalizeDate(
        value: Date | string | null | undefined,
    ): Date | null {
        if (!value) {
            return null
        }
        if (value instanceof Date) {
            return Number.isNaN(value.getTime()) ? null : value
        }
        const parsed = new Date(value)
        return Number.isNaN(parsed.getTime()) ? null : parsed
    }

    private resolveNextOffset(
        listResponse: Record<string, any>,
        reverse: boolean,
    ): string | null {
        if (reverse) {
            return (
                listResponse?.prev_page?.offset ??
                listResponse?.next_page?.offset ??
                null
            )
        }
        return listResponse?.next_page?.offset ?? null
    }

    private resolveOffset(params: {
        offset?: string
        reverse?: boolean
    }): string | undefined {
        if (params.offset) {
            return params.offset
        }
        if (params.reverse) {
            return this.getTodayOffset()
        }
        return undefined
    }

    private getTodayOffset(): string {
        const now = new Date()
        now.setUTCHours(0, 0, 0, 0)
        return now.toISOString()
    }
}
