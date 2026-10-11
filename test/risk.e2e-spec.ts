import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

/**
 * End-to-end test of the risk API against a PostgreSQL test database: the normalized
 * schema (prisma db push), the procedures and API views from db/migration, real Prisma
 * queries, minimal fixtures, no Redis (the cache must degrade gracefully).
 *
 * E2E_DATABASE_URL points at an existing throw-away database (its name must end in
 * "_test" or be "test"; it is reset). Without it a postgres:16 container is started with
 * the docker CLI (testcontainers' undici does not load inside the jest sandbox).
 * Skipped when neither is available.
 */

const sh = (cmd: string) => execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
const SQL_DIR = path.resolve(__dirname, '../../db/migration')

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

/** Runs SQL: inside the container when we own one, with the host psql otherwise. */
function runSql(sql: string | Buffer, container: { id: string; url: string }) {
    const cmd = container.id
        ? `docker exec -i ${container.id} psql -U test -d test -q -v ON_ERROR_STOP=1`
        : `psql "${container.url}" -q -v ON_ERROR_STOP=1`
    execSync(cmd, { input: sql, stdio: ['pipe', 'ignore', 'pipe'] })
}

function assertTestDatabase(url: string) {
    const db = new URL(url).pathname.replace(/^\//, '')
    if (!(db === 'test' || db.endsWith('_test'))) {
        throw new Error(`E2E_DATABASE_URL must point at a throw-away database (name "test" or "*_test"), got "${db}"`)
    }
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

const describeE2E = process.env.E2E_DATABASE_URL || hasDocker ? describe : describe.skip

describeE2E('Risk API (e2e, testcontainers)', () => {
    let container: { id: string; url: string }
    let app: INestApplication

    const A = '31234567' // sanctioned, in CompanyRisk (one-digit codes like 11111111 are placeholders now)
    const B = '41234568' // co-bidder of A, control
    const C = '35555551' // never bid -> 404 on company card
    const TENDER_UID = 'UA-2024-03-01-000001-a'
    const TENDER_HEX = 'f'.repeat(32)

    const BUYER = '02145678'
    const REGION = 'Київська область'

    beforeAll(async () => {
        container = process.env.E2E_DATABASE_URL ? { id: '', url: process.env.E2E_DATABASE_URL } : await startPostgres()
        assertTestDatabase(container.url)
        process.env.DATABASE_URL = container.url
        // exercise the no-cache path; empty rather than deleted, because Prisma loads back/.env
        // into process.env without overriding defined variables and would re-enable Redis
        process.env.REDIS_URL = ''
        process.env.INDEXING_API_KEY = 'e2e-key'
        // start from an empty schema (the name check above guards this), then push the schema
        runSql('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;', container)
        execSync('npx -y prisma@6.19.2 db push --skip-generate', { env: process.env, stdio: 'ignore' })
        runSql(readFileSync(path.join(SQL_DIR, 'procedures.sql')), container)
        runSql(readFileSync(path.join(SQL_DIR, 'views.sql')), container)

        // seed fixtures with a fresh client bound to the test database
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { PrismaClient } = require('@prisma/client')
        const prisma = new PrismaClient()
        const published = new Date('2024-03-01T10:00:00Z')
        await prisma.region.create({ data: { name: REGION } })
        await prisma.cpv.create({ data: { code: '15800000-6', description: 'Різні харчові продукти' } })
        const tender = await prisma.tender.create({
            data: {
                prozorroId: TENDER_HEX,
                tenderID: TENDER_UID,
                title: 'Поставка продуктів',
                procuringEntity: 'Школа №1',
                buyerEdrpou: BUYER,
                buyerRegion: REGION,
                procurementMethodType: 'belowThreshold',
                cpvCodes: ['15800000-6'],
                valueAmount: 100000,
                valueCurrency: 'UAH',
                status: 'complete',
                datePublished: published,
                rawData: {
                    tenderID: TENDER_UID,
                    procurementMethodType: 'belowThreshold',
                    procuringEntity: { identifier: { id: BUYER }, name: 'Школа №1' },
                },
                items: { create: [{ itemId: 'i1', description: 'Хліб', cpvCode: '15800000-6' }] },
            },
        })
        await prisma.bid.createMany({
            data: [
                { tenderId: tender.id, codeInCard: A, schemeInCard: 'UA-EDR', nameInCard: 'ТОВ Альфа', regionInCard: REGION, amount: 95000, bidDate: new Date('2024-03-05T09:00:00Z'), datePublished: published },
                { tenderId: tender.id, codeInCard: B, schemeInCard: 'UA-EDR', nameInCard: 'ТОВ Бета', regionInCard: REGION, amount: 99000, bidDate: new Date('2024-03-05T09:30:00Z'), datePublished: published },
            ],
        })
        await prisma.award.create({
            data: { tenderId: tender.id, codeInCard: A, schemeInCard: 'UA-EDR', nameInCard: 'ТОВ Альфа', amount: 95000, awardDate: new Date('2024-03-10'), datePublished: published },
        })
        await prisma.amcuRegisterRow.createMany({
            data: [
                { decisionNumber: '1/2024', decisionDate: new Date('2024-06-01'), body: 'АМКУ', edrpou: A, companyName: 'ТОВ Альфа', registerVersion: '2026-07-31' },
                { decisionNumber: '1/2024', decisionDate: new Date('2024-06-01'), body: 'АМКУ', edrpou: A, companyName: 'ТОВ Альфа', registerVersion: '2026-08-31',
                  courtCaseNumber: '910/1/24', courtName: 'Господарський суд', courtContent: 'відмовлено' },
            ],
        })
        await prisma.$executeRawUnsafe('CALL sp_refresh_organizations()')
        await prisma.$executeRawUnsafe('CALL sp_refresh_decisions()')
        await prisma.studyCompany.createMany({
            data: [
                { code: A, cohort: 'amcu', coverage: 'full', status: 'done', tendersFound: 1 },
                { code: B, cohort: 'control', coverage: 'full', status: 'done', tendersFound: 1 },
            ],
        })
        // winRate and cutoffYear are generated in the real database; plain columns after db push
        await prisma.companyRisk.createMany({
            data: [
                { orgCode: A, score: 0.9, rank: 1, percentile: 100, nTenders: 1, nWon: 1, winRate: 1, degree: 1, features: { n_tenders: 1 }, contributions: [], topNeighbors: [{ orgCode: B, weight: 1, score: 0.2 }], modelVersion: 'e2e' },
                { orgCode: B, score: 0.2, rank: 2, percentile: 50, nTenders: 1, nWon: 0, winRate: 0, degree: 1, features: { n_tenders: 1 }, contributions: [], topNeighbors: [{ orgCode: A, weight: 1, score: 0.9 }], modelVersion: 'e2e' },
            ],
        })
        await prisma.riskBacktest.createMany({
            data: [
                { cutoffDate: new Date('2023-12-31'), cutoffYear: 2023, orgCode: A, score: 0.8, rank: 1, rankFull: 1, nTenders: 5, degree: 1, knownAtCutoff: false, outcome: 'caught', modelVersion: 'e2e' },
                { cutoffDate: new Date('2023-12-31'), cutoffYear: 2023, orgCode: B, score: 0.1, rank: 2, rankFull: 2, nTenders: 5, degree: 1, knownAtCutoff: false, outcome: 'none', modelVersion: 'e2e' },
            ],
        })
        await prisma.tightGroup.create({
            data: {
                id: 1, size: 2, sharedTenders: 1, totalTenders: 1, wonAmount: '95000.50', sanctioned: 1, sameDecision: 0,
                meanScore: 0.55, maxScore: 0.9, regions: [REGION], topCpv: ['15'],
                members: { create: [{ orgCode: A, nTenders: 1, nWon: 1, wonAmount: '95000.50' }, { orgCode: B, nTenders: 1, nWon: 0, wonAmount: 0 }] },
            },
        })
        await prisma.buyerStats.create({
            data: { orgCode: BUYER, tenders: 1, singleBidder: 0, twoBidder: 1, highRiskWins: 1, sanctionedWins: 1, wonTotal: '95000.25', wonHighRisk: '95000.25', repeatedPairs: 0 },
        })
        await prisma.organizationContact.createMany({
            data: [
                { code: A, kind: 'phone', value: '+380441234567' },
                { code: B, kind: 'phone', value: '+380441234567' },
            ],
        })
        await prisma.$executeRawUnsafe('REFRESH MATERIALIZED VIEW "CompanyLink"')
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
        expect(res.body).toMatchObject({ edrpou: A, name: 'ТОВ Альфа', group: 'amcu', coverage: 'full', region: REGION, winRate: 1 })
        expect(res.body.decisions[0]).toMatchObject({ decisionNumber: '1/2024', body: 'АМКУ', courtCaseNumber: '910/1/24', courtContent: 'відмовлено' })
        expect(res.body.topNeighbors[0]).toMatchObject({ edrpou: B, name: 'ТОВ Бета', weight: 1, label: false })
        expect(res.body).not.toHaveProperty('orgCode')
    })

    it('GET /api/risk/company/:edrpou/graph returns centre + partners', async () => {
        const res = await request(app.getHttpServer()).get(`/api/risk/company/${A}/graph`).expect(200)
        expect(res.body.nodes).toHaveLength(2)
        expect(res.body.nodes.find((n: { center: boolean }) => n.center).edrpou).toBe(A)
    })

    it('GET /api/risk/tender/:id resolves UA-id, hex id and numeric id', async () => {
        const numericId = (await request(app.getHttpServer()).get(`/api/risk/tender/${TENDER_UID}`)).body.tender.id
        for (const id of [TENDER_UID, TENDER_HEX, String(numericId)]) {
            const res = await request(app.getHttpServer()).get(`/api/risk/tender/${id}`).expect(200)
            expect(res.body.participants).toHaveLength(2)
            expect(res.body.signals.knownParticipants).toBe(1)
            expect(res.body.signals.biddersCount).toBe(2)
            expect(res.body.tender).toMatchObject({ tenderID: TENDER_UID, procurementMethodType: 'belowThreshold', buyerEdrpou: BUYER })
            const a = res.body.participants.find((p: { edrpou: string }) => p.edrpou === A)
            expect(a).toMatchObject({ isWinner: true, bidAmount: 95000, label: true, winRate: 1 })
        }
    })

    it('returns 404 for a company without bids and for an unknown tender', async () => {
        await request(app.getHttpServer()).get(`/api/risk/company/${C}`).expect(404)
        await request(app.getHttpServer()).get('/api/risk/tender/UA-0000-00-00-000000-a').expect(404)
    })

    it('GET /api/risk/company/:edrpou/evidence finds the two-bidder tender with the partner', async () => {
        const res = await request(app.getHttpServer()).get(`/api/risk/company/${A}/evidence`).expect(200)
        expect(res.body.tenders).toBe(1)
        expect(res.body.partner).toMatchObject({ edrpou: B, pairWonSelf: 1 })
        expect(res.body.signals.two_bidders.count).toBe(1)
        expect(res.body.signals.two_bidders.examples[0]).toMatchObject({ tenderID: TENDER_UID, amount: 95000, valueAmount: 100000, winner: 'self', minutesToPartner: 30 })
        expect(res.body.signals.fast_bids.count).toBe(1)
    })

    it('GET /api/risk/summary, ranking and regions keep their shape', async () => {
        const summary = await request(app.getHttpServer()).get('/api/risk/summary').expect(200)
        expect(summary.body.coverage).toEqual(expect.arrayContaining([{ group: 'amcu', coverage: 'full', count: 1 }]))
        expect(summary.body.register.map((r: { version: string }) => r.version).sort()).toEqual(['2026-07-31', '2026-08-31'])
        const ranking = await request(app.getHttpServer()).get(`/api/risk/ranking?minTenders=1&q=альфа&region=${encodeURIComponent(REGION)}`).expect(200)
        expect(ranking.body.total).toBe(1)
        expect(Object.keys(ranking.body.items[0])).toEqual([
            'edrpou', 'name', 'score', 'rank', 'percentile', 'label', 'firstDecision', 'group', 'coverage',
            'nTenders', 'nWon', 'winRate', 'degree', 'region', 'features', 'sanctionedNeighbors',
        ])
        const b = await request(app.getHttpServer()).get(`/api/risk/ranking?minTenders=1&q=${B}`).expect(200)
        expect(b.body.items[0].sanctionedNeighbors).toBe(1) // neighbour A is in the register
        const regions = await request(app.getHttpServer()).get('/api/risk/regions?minTenders=1').expect(200)
        expect(regions.body.regions[0]).toMatchObject({ region: REGION, companies: 2, sanctioned: 1 })
        await request(app.getHttpServer()).get('/api/risk/feature-norms').expect(200)
    })

    it('GET /api/risk/backtest, backtest/:year and company history read v_risk_backtest', async () => {
        const list = await request(app.getHttpServer()).get('/api/risk/backtest').expect(200)
        expect(list.body.items[0]).toMatchObject({ cutoffYear: 2023, companies: 2, population: 2, totalCaught: 1 })
        const bt = await request(app.getHttpServer()).get('/api/risk/backtest/2023?minTenders=1').expect(200)
        expect(bt.body.top.map((t: { edrpou: string }) => t.edrpou)).toEqual([A, B])
        expect(bt.body.caughtLater[0]).toMatchObject({ edrpou: A, group: 'amcu', coverage: 'full', rankUsed: 1 })
        await request(app.getHttpServer()).get('/api/risk/backtest/1999').expect(404)
        const hist = await request(app.getHttpServer()).get(`/api/risk/company/${B}/history`).expect(200)
        expect(hist.body[0]).toMatchObject({ cutoffYear: 2023, position: 2, population: 2 })
    })

    it('insights: buyers list and buyer card return numbers for money', async () => {
        const list = await request(app.getHttpServer()).get('/api/risk/buyers?minTenders=1').expect(200)
        expect(list.body.items[0]).toMatchObject({ edrpou: BUYER, name: 'Школа №1', region: REGION, wonTotal: 95000.25, wonHighRisk: 95000.25 })
        const card = await request(app.getHttpServer()).get(`/api/risk/buyer/${BUYER}`).expect(200)
        expect(card.body).toMatchObject({ tenders: 1, tendersWithBids: 1, twoBidderShare: 1, valueTotal: 100000 })
        expect(card.body.suppliers[0]).toMatchObject({ edrpou: A, bids: 1, wins: 1, wonAmount: 95000, label: true })
        expect(card.body.recentTenders[0]).toMatchObject({ tenderID: TENDER_UID, bidders: 2, winner: 'ТОВ Альфа', winnerScore: 0.9 })
    })

    it('insights: groups, group card with links and company groups', async () => {
        const groups = await request(app.getHttpServer()).get('/api/risk/groups').expect(200)
        expect(groups.body.summary).toEqual({ groups: 1, companies: 2, wonAmount: 95000.5, sanctioned: 1 })
        expect(groups.body.items[0].wonAmount).toBe(95000.5)
        expect(groups.body.items[0].members[0]).toEqual({ edrpou: A, name: 'ТОВ Альфа', score: 0.9, label: true, nTenders: 1, nWon: 1, wonAmount: 95000.5 })
        const g = await request(app.getHttpServer()).get('/api/risk/groups/1').expect(200)
        expect(g.body.pairs).toEqual([{ a: A, b: B, shared: 1, aWon: 1, bWon: 0 }])
        expect(g.body.buyers[0]).toMatchObject({ edrpou: BUYER, tenders: 1, amount: 95000 })
        expect(g.body.links).toHaveLength(1)
        expect(g.body.links[0]).toMatchObject({ edrpouA: A, edrpouB: B, kinds: ['phone'] })
        expect(Number.isInteger(g.body.links[0].id)).toBe(true)
        expect(g.body.recentTenders[0]).toMatchObject({ tender_id: TENDER_UID, members: 2, winner: 'ТОВ Альфа' })
        const mine = await request(app.getHttpServer()).get(`/api/risk/company/${B}/groups`).expect(200)
        expect(mine.body[0].members).toHaveLength(2)
        await request(app.getHttpServer()).get('/api/risk/groups/999').expect(404)
    })

    it('insights: links, register versions and updates, markets, money', async () => {
        const links = await request(app.getHttpServer()).get(`/api/risk/company/${A}/links`).expect(200)
        expect(links.body).toEqual([{ edrpou: B, name: 'ТОВ Бета', score: 0.2, label: false, nTenders: 1, kinds: ['phone'], sharedTenders: 1 }])
        const versions = await request(app.getHttpServer()).get('/api/risk/register-versions').expect(200)
        expect(versions.body).toHaveLength(2)
        const updates = await request(app.getHttpServer()).get('/api/risk/register-updates').expect(200)
        expect(updates.body.summary.added).toBe(0)
        const markets = await request(app.getHttpServer()).get('/api/risk/markets?minTenders=1').expect(200)
        expect(markets.body.items[0]).toMatchObject({ cpv: '15', tenders: 1, suppliers: 1, twoBidderShare: 1, wonTotal: 95000, wonSanctioned: 95000 })
        const money = await request(app.getHttpServer()).get('/api/risk/money?by=region').expect(200)
        expect(money.body.items[0]).toMatchObject({ key: REGION, wonTotal: 95000, wonHighRisk: 95000, awards: 1 })
    })
})
