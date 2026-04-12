import {
    CanActivate,
    ExecutionContext,
    Injectable,
    Logger,
    ServiceUnavailableException,
    UnauthorizedException,
} from '@nestjs/common'
import type { Request } from 'express'

/**
 * Simple shared-secret API key guard for write / mutating endpoints
 * (indexing, prozorro fetch/sync, experiment runs).
 *
 * Read endpoints — search, stats, health — are intentionally left
 * unauthenticated, since the system is meant to be a public OSINT tool.
 *
 * Configuration
 * -------------
 * Set the `INDEXING_API_KEY` environment variable to a strong random
 * string. Clients pass it in the `x-api-key` request header (or as the
 * `Bearer <key>` token in the `Authorization` header).
 *
 * If `INDEXING_API_KEY` is not set the guard returns 503 Service
 * Unavailable rather than silently allowing access — preventing the
 * common "forgot to configure auth in prod" footgun.
 *
 * Security caveats
 * ----------------
 * - This is a *bearer*-style shared secret, not a real auth scheme.
 *   It is appropriate for an admin-only mutating surface that has a
 *   single trusted operator (the thesis author / dev environment).
 * - For multi-user / production deployments, replace with @nestjs/passport
 *   + JWT / OIDC and proper user accounts.
 *
 * Phase 3, P3.9 — see CHANGES.md.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
    private readonly logger = new Logger(ApiKeyGuard.name)

    canActivate(context: ExecutionContext): boolean {
        const expected = process.env.INDEXING_API_KEY
        if (!expected) {
            this.logger.error(
                'INDEXING_API_KEY is not configured — refusing all write traffic. ' +
                    'Set the env variable to enable mutating endpoints.',
            )
            throw new ServiceUnavailableException(
                'Authentication is not configured on this server.',
            )
        }

        const request = context.switchToHttp().getRequest<Request>()
        const provided = this.extractKey(request)

        if (!provided) {
            throw new UnauthorizedException('Missing API key.')
        }

        if (!this.constantTimeEquals(provided, expected)) {
            this.logger.warn(
                `Rejected write request to ${request.method} ${request.url}: bad API key`,
            )
            throw new UnauthorizedException('Invalid API key.')
        }

        return true
    }

    private extractKey(request: Request): string | undefined {
        const headerKey = request.headers['x-api-key']
        if (typeof headerKey === 'string' && headerKey.length > 0) {
            return headerKey
        }
        if (Array.isArray(headerKey) && headerKey[0]) {
            return headerKey[0]
        }

        const auth = request.headers['authorization']
        if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
            return auth.slice('Bearer '.length).trim()
        }
        return undefined
    }

    /** Length-aware constant-time string comparison. */
    private constantTimeEquals(a: string, b: string): boolean {
        if (a.length !== b.length) {
            // Still walk the loop on the shorter buffer to avoid an
            // immediate-return timing oracle on length.
            let diff = a.length ^ b.length
            const len = Math.min(a.length, b.length)
            for (let i = 0; i < len; i++) {
                diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
            }
            return false
        }
        let diff = 0
        for (let i = 0; i < a.length; i++) {
            diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
        }
        return diff === 0
    }
}
