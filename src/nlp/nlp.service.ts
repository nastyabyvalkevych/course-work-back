import { Injectable, Logger } from '@nestjs/common'

import { STOP_WORDS } from './stop-words'

const UKRAINIAN_TOKENIZER = /[а-яіїєґА-ЯІЇЄҐ]+(?:['-][а-яіїєґА-ЯІЇЄҐ]+)*/g

@Injectable()
export class NlpService {
    private readonly logger = new Logger(NlpService.name)
    private readonly lemmatizerUrl =
        process.env.LEMMATIZER_URL ?? 'http://localhost:5001/lemmatize'

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
        if (tokens.length === 0) {
            return []
        }

        try {
            const response = await fetch(this.lemmatizerUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tokens, language: 'uk' }),
            })

            if (!response.ok) {
                this.logger.warn(`Lemmatizer returned ${response.status}.`)
                return tokens
            }

            const data = (await response.json()) as { lemmas?: string[] }
            return data.lemmas ?? tokens
        } catch (error) {
            this.logger.warn(`Lemmatizer request failed: ${String(error)}`)
            return tokens
        }
    }
}
