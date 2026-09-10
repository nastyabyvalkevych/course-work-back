import { execSync } from 'node:child_process'

import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

/**
 * End-to-end test of the risk API against a throw-away PostgreSQL container
 * (started with the docker CLI — testcontainers' undici does not load inside
 * the jest sandbox): real migrations, real Prisma queries, minimal fixtures,
 * no Redis (the cache must degrade gracefully). Skipped without Docker.
 */

const sh = (cmd: string) => execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()

async function startPostgres(): Promise<{ id: string; url: string }> {
    const id = sh('docker run -d --rm -e POSTGRES_PASSWORD=test -e POSTGRES_USER=test -e POSTGRES_DB=test -p 127.0.0.1::5432 postgres:16')
    const port = sh(`docker port ${id} 5432/tcp`).split(':').pop()
    for (let i = 0; i < 60; i += 1) {
        try {
            sh(`docker exec ${id} pg_isready -U test -d test`)
            break
        } catch {
            await new Promise((r) => setTimeout(r, 1000))
        }
    }
    await new Promise((r) => setTimeout(r, 1500)) // postgres restarts once after init
    return { id, url: `postgresql://test:test@127.0.0.1:${port}/test` }
}
jest.setTimeout(180_000)

const hasDocker = (() => {
    try {
        execSync('docker info', { stdio: 'ignore' })
        return true
    } catch {
        return false
    }
})()

const describeE2E = hasDocker ? describe : describe.skip

describeE2E('Risk API (e2e, testcontainers)', () => {
    let container: { id: string; url: string }
    let app: INestApplication

    const A = '11111111' // sanctioned, in CompanyRisk
    const B = '22222222' // co-bidder of A, control
    const C = '33333333' // never bid -> 404 on company card
    const TENDER_UID = 'UA-2024-03-01-000001-a'
    const TENDER_HEX = 'f'.repeat(32)

    beforeAll(async () => {
        container = await startPostgres()
        process.env.DATABASE_URL = container.url
        delete process.env.REDIS_URL // exercise the no-cache path
        process.env.INDEXING_API_KEY = 'e2e-key'
        execSync('npx prisma migrate deploy', { env: process.env, stdio: 'ignore' })

        // seed fixtures with a fresh client bound to the container
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { PrismaClient } = require('@prisma/client')
        const prisma = new PrismaClient()
        const tender = await prisma.tender.create({
            data: {
                prozorroId: TENDER_HEX,
                title: 'Поставка продуктів',
                procuringEntity: 'Школа №1',
                cpvCodes: ['15800000-6'],
                valueAmount: 100000,
                valueCurrency: 'UAH',
                status: 'complete',
                datePublished: new Date('2024-03-01T10:00:00Z'),
                rawData: {
                    tenderID: TENDER_UID,
                    procurementMethodType: 'belowThreshold',
                    procuringEntity: { identifier: { id: '99999999' }, name: 'Школа №1' },
                },
            },
        })
        await prisma.participation.createMany({
            data: [
                { tenderId: tender.id, prozorroTenderId: TENDER_UID, edrpou: A, name: 'ТОВ Альфа', role: 'bidder', bidAmount: 95000, isWinner: true, datePublished: tender.datePublished },
                { tenderId: tender.id, prozorroTenderId: TENDER_UID, edrpou: B, name: 'ТОВ Бета', role: 'bidder', bidAmount: 99000, isWinner: false, datePublished: tender.datePublished },
                { tenderId: tender.id, prozorroTenderId: TENDER_UID, edrpou: A, name: 'ТОВ Альфа', role: 'winner', bidAmount: 95000, isWinner: true, datePublished: tender.datePublished },
            ],
        })
        await prisma.amcuDecision.create({
            data: { decisionNumber: '1/2024', decisionDate: new Date('2024-06-01'), edrpou: A, companyName: 'ТОВ Альфа', registerVersion: 'e2e' },
        })
        await prisma.companyRisk.createMany({
            data: [
                { edrpou: A, name: 'ТОВ Альфа', score: 0.9, rank: 1, percentile: 100, label: true, firstDecision: new Date('2024-06-01'), group: 'amcu', coverage: 'full', nTenders: 1, nWon: 1, winRate: 1, degree: 1, features: { n_tenders: 1 }, contributions: [], topNeighbors: [], modelVersion: 'e2e' },
                { edrpou: B, name: 'ТОВ Бета', score: 0.2, rank: 2, percentile: 50, label: false, group: 'control', coverage: 'full', nTenders: 1, nWon: 0, winRate: 0, degree: 1, features: { n_tenders: 1 }, contributions: [], topNeighbors: [], modelVersion: 'e2e' },
            ],
        })
        await prisma.$disconnect()

        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { AppModule } = require('../src/app.module')
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
        app = moduleRef.createNestApplication()
        await app.init()
    })

    afterAll(async () => {
        await app?.close()
        if (container?.id) {
            try {
                sh(`docker rm -f ${container.id}`)
            } catch {
                /* already gone */
            }
        }
    })

    it('GET /health reports database ok and cache unavailable', async () => {
        const res = await request(app.getHttpServer()).get('/health').expect(200)
        expect(res.body.components.database).toBe('ok')
        expect(res.body.components.cache).toContain('unavailable')
    })

    it('GET /api/risk/summary returns model version and counts', async () => {
        const res = await request(app.getHttpServer()).get('/api/risk/summary').expect(200)
        expect(res.body.modelVersion).toBe('e2e')
        expect(res.body.companiesScored).toBe(2)
        expect(res.body.companiesInRegister).toBe(1)
    })

    it('GET /api/risk/ranking orders by score and can hide known companies', async () => {
        const all = await request(app.getHttpServer()).get('/api/risk/ranking?minTenders=1').expect(200)
        expect(all.body.items.map((i: { edrpou: string }) => i.edrpou)).toEqual([A, B])
        const unknownOnly = await request(app.getHttpServer()).get('/api/risk/ranking?minTenders=1&excludeKnown=1').expect(200)
        expect(unknownOnly.body.items.map((i: { edrpou: string }) => i.edrpou)).toEqual([B])
    })

    it('GET /api/risk/company/:edrpou joins decisions, co-bidders and recent tenders', async () => {
        const res = await request(app.getHttpServer()).get(`/api/risk/company/${A}`).expect(200)
        expect(res.body.label).toBe(true)
        expect(res.body.decisions).toHaveLength(1)
        expect(res.body.coBidders).toHaveLength(1)
        expect(res.body.coBidders[0]).toMatchObject({ edrpou: B, sharedTenders: 1, weWon: 1, theyWon: 0 })
        expect(res.body.recentTenders[0]).toMatchObject({ tenderID: TENDER_UID, bidders: 2, won: true })
    })

    it('GET /api/risk/company/:edrpou/graph returns centre + partners', async () => {
        const res = await request(app.getHttpServer()).get(`/api/risk/company/${A}/graph`).expect(200)
        expect(res.body.nodes).toHaveLength(2)
        expect(res.body.nodes.find((n: { center: boolean }) => n.center).edrpou).toBe(A)
    })

    it('GET /api/risk/tender/:id resolves UA-id, hex id and numeric id', async () => {
        for (const id of [TENDER_UID, TENDER_HEX]) {
            const res = await request(app.getHttpServer()).get(`/api/risk/tender/${id}`).expect(200)
            expect(res.body.participants).toHaveLength(2)
            expect(res.body.signals.knownParticipants).toBe(1)
            expect(res.body.signals.biddersCount).toBe(2)
        }
    })

    it('returns 404 for a company without bids and for an unknown tender', async () => {
        await request(app.getHttpServer()).get(`/api/risk/company/${C}`).expect(404)
        await request(app.getHttpServer()).get('/api/risk/tender/UA-0000-00-00-000000-a').expect(404)
    })
})
