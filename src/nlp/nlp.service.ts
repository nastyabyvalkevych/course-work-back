import { Injectable, Logger } from '@nestjs/common'

import { STOP_WORDS } from './stop-words'

const UKRAINIAN_TOKENIZER = /[а-яіїєґА-ЯІЇЄҐ]+(?:['-][а-яіїєґА-ЯІЇЄҐ]+)*/g

@Injectable()
export class NlpService {
    private readonly logger = new Logger(NlpService.name)
    private readonly lemmatizerUrl = this.resolveLemmatizerUrl()

    async processText(text: string): Promise<string[]> {
        const tokens = this.tokenize(text)
        const filtered = this.removeStopWords(tokens)
        return this.lemmatize(filtered)
    }

    tokenize(text: string): string[] {
        if (!text) {
            return []
        }
        return text.toLowerCase().match(UKRAINIAN_TOKENIZER) ?? []
    }

    removeStopWords(tokens: string[]): string[] {
        return tokens.filter((token) => token && !STOP_WORDS.has(token))
    }

    async lemmatize(tokens: string[]): Promise<string[]> {
        if (!tokens.length) {
            return []
        }

        return this.lemmatizeRemote(tokens)
    }

    private async lemmatizeRemote(tokens: string[]): Promise<string[]> {
        try {
            const response = await fetch(this.lemmatizerUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tokens, language: 'uk' }),
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
        const raw = process.env.LEMMATIZER_URL ?? 'http://localhost:5001/lemmatize'
        if (raw.endsWith('/lemmatize')) {
            return raw
        }
        if (raw.endsWith('/')) {
            return `${raw}lemmatize`
        }
        return `${raw}/lemmatize`
    }
}
