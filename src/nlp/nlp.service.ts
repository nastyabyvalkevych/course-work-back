import { Injectable, Logger } from '@nestjs/common'

import { STOP_WORDS } from './stop-words'

const UKRAINIAN_TOKENIZER = /[0-9a-zа-яіїєґ]+(?:['-][0-9a-zа-яіїєґ]+)*/gi
const UKRAINIAN_WORD = /^[а-яіїєґ]+(?:['-][а-яіїєґ]+)*$/i

@Injectable()
export class NlpService {
    private readonly logger = new Logger(NlpService.name)
    private readonly lemmatizerUrl = this.resolveLemmatizerUrl()

    async processText(text: string): Promise<string[]> {
        const tokens = this.tokenize(text)
        const filtered = this.removeStopWords(tokens)
        return this.lemmatize(filtered)
    }

    /**
     * Нормалізація пошукового запиту (R2.2): лише початкові форми, без поверхневих словоформ,
     * щоб набір слів для пошуку не залежав від граматичної форми запиту. Індекс містить і
     * словоформи, і леми (processText), тож збіг за лемою завжди можливий.
     */
    async processQuery(text: string): Promise<string[]> {
        return (await this.processQueryDetailed(text)).terms
    }

    /** Те саме, що processQuery, плюс ознака, що лематизатор був недоступний і слова лишились у вихідній формі. */
    async processQueryDetailed(
        text: string,
    ): Promise<{ terms: string[]; degraded: boolean }> {
        const tokens = this.tokenize(text)
        const filtered = this.removeStopWords(tokens)
        const state = { degraded: false }
        const lemmas = await this.lemmatize(filtered, false, state)
        return { terms: [...new Set(lemmas)], degraded: state.degraded }
    }

    tokenize(text: string | number | boolean | null | undefined): string[] {
        if (text === null || text === undefined) {
            return []
        }
        const normalized =
            typeof text === 'string'
                ? text
                : typeof text === 'number' || typeof text === 'boolean'
                  ? String(text)
                  : ''
        if (!normalized) {
            return []
        }
        return normalized.toLowerCase().match(UKRAINIAN_TOKENIZER) ?? []
    }

    removeStopWords(tokens: string[]): string[] {
        return tokens.filter((token) => token && !STOP_WORDS.has(token))
    }

    async lemmatize(
        tokens: string[],
        keepSurface = true,
        state?: { degraded: boolean },
    ): Promise<string[]> {
        if (!tokens.length) {
            return []
        }

        const ukrainianIndexes: number[] = []
        const ukrainianTokens: string[] = []

        tokens.forEach((token, index) => {
            if (UKRAINIAN_WORD.test(token)) {
                ukrainianIndexes.push(index)
                ukrainianTokens.push(token)
            }
        })

        if (!ukrainianTokens.length) {
            return tokens
        }

        const lemmas = await this.lemmatizeRemote(ukrainianTokens).catch(
            () => {
                if (state) state.degraded = true
                return ukrainianTokens
            },
        )
        const normalized: string[] = []
        tokens.forEach((token, index) => {
            if (!UKRAINIAN_WORD.test(token)) {
                normalized.push(token)
                return
            }
            const lemmaIndex = ukrainianIndexes.indexOf(index)
            const lemma = lemmas[lemmaIndex] ?? token
            if (keepSurface) {
                normalized.push(token)
            }
            if (lemma !== token || !keepSurface) {
                normalized.push(lemma)
            }
        })
        return normalized
    }

    /** Перевірка доступності лематизатора для /health. */
    async isLemmatizerAvailable(): Promise<boolean> {
        try {
            const response = await fetch(this.lemmatizerUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tokens: ['перевірка'], language: 'uk' }),
                signal: AbortSignal.timeout(1000),
            })
            return response.ok
        } catch {
            return false
        }
    }

    private async lemmatizeRemote(tokens: string[]): Promise<string[]> {
        try {
            const response = await fetch(this.lemmatizerUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tokens, language: 'uk' }),
                signal: AbortSignal.timeout(2000),
            })

            if (!response.ok) {
                const body = await response.text()
                const message = `Lemmatizer error ${response.status}: ${body}`
                this.logger.error(message)
                throw new Error(message)
            }

            const data = (await response.json()) as { lemmas?: string[] }
            if (!data.lemmas) {
                throw new Error('Lemmatizer response missing lemmas.')
            }
            return data.lemmas
        } catch (error) {
            this.logger.error(`Lemmatizer request failed: ${String(error)}`)
            throw error
        }
    }

    private resolveLemmatizerUrl(): string {
        const raw =
            process.env.LEMMATIZER_URL ?? 'http://localhost:5001/lemmatize'
        if (raw.endsWith('/lemmatize')) {
            return raw
        }
        if (raw.endsWith('/')) {
            return `${raw}lemmatize`
        }
        return `${raw}/lemmatize`
    }
}
