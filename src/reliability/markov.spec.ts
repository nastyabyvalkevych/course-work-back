import {
    ReliabilityProfile,
    UsageProfile,
    buildUsage,
    cheungReliability,
    evaluateProfile,
    expectedVisits,
    gokhaleReliability,
    invert,
    kubatModuleReliability,
    laprieRunReliability,
    laprieStationary,
    solve,
} from './markov'
import { ReliabilityService } from './reliability.service'
import { DEFAULT_PROFILE } from './default-profile'

const serial = (r: number[], tau = 10): ReliabilityProfile => ({
    system: 'serial',
    modules: r.map((x, i) => ({ id: `m${i}`, name: `m${i}`, reliability: x, meanSojournMs: tau })),
    tasks: [{ id: 't', name: 't', weight: 1, path: r.map((_, i) => `m${i}`) }],
})

describe('linear algebra', () => {
    it('solves a small system and inverts a matrix', () => {
        expect(solve([[2, 1], [1, 3]], [3, 5])).toEqual([0.8, 1.4].map((v) => expect.closeTo(v, 10)))
        const a = [[4, 7], [2, 6]]
        const inv = invert(a)
        const prod = a.map((row, i) => inv[0].map((_, j) => row.reduce((s, v, k) => s + v * inv[k][j], 0)))
        expect(prod[0][0]).toBeCloseTo(1)
        expect(prod[0][1]).toBeCloseTo(0)
        expect(prod[1][1]).toBeCloseTo(1)
    })
})

describe('usage profile from task–module structure', () => {
    it('derives π0, P and exit probabilities that form proper distributions', () => {
        const usage = buildUsage(DEFAULT_PROFILE)
        expect(usage.initial.reduce((s, v) => s + v, 0)).toBeCloseTo(1)
        usage.transition.forEach((row, i) => {
            const out = row.reduce((s, v) => s + v, 0) + usage.exit[i]
            expect(out === 0 || Math.abs(out - 1) < 1e-9).toBe(true)
        })
        expect(usage.initial[usage.moduleIds.indexOf('gateway')]).toBeCloseTo(1)
    })

    it('computes the module-call probability from task weights', () => {
        const p: ReliabilityProfile = {
            system: 'x',
            modules: ['a', 'b', 'c'].map((id) => ({ id, name: id, reliability: 1, meanSojournMs: 1 })),
            tasks: [
                { id: 't1', name: 't1', weight: 3, path: ['a', 'b'] },
                { id: 't2', name: 't2', weight: 1, path: ['a', 'c'] },
            ],
        }
        const u = buildUsage(p)
        expect(u.moduleUsage).toEqual([1, 0.75, 0.25])
        expect(u.transition[0]).toEqual([0, 0.75, 0.25])
        expect(u.exit).toEqual([0, 1, 1])
        expect(u.taskModule).toEqual([[1, 1, 0], [1, 0, 1]])
    })

    it('rejects malformed profiles', () => {
        expect(() => buildUsage({ system: 'x', modules: [], tasks: [] })).toThrow(/no modules/)
        expect(() => buildUsage(serial([1.2]))).toThrow(/reliability/)
        const bad = serial([1])
        bad.tasks[0].path = ['nope']
        expect(() => buildUsage(bad)).toThrow(/unknown module/)
    })
})

describe("Cheung's discrete-time model", () => {
    it('reduces to the product of module reliabilities for a serial path', () => {
        const r = [0.99, 0.95, 0.9]
        const rep = evaluateProfile(serial(r))
        expect(rep.discrete.systemReliability).toBeCloseTo(0.99 * 0.95 * 0.9, 10)
        expect(rep.tasks[0].modelReliability).toBeCloseTo(0.99 * 0.95 * 0.9, 10)
    })

    it('is 1 for perfect modules and 0 when an unavoidable module always fails', () => {
        expect(evaluateProfile(serial([1, 1, 1])).discrete.systemReliability).toBe(1)
        expect(evaluateProfile(serial([1, 0, 1])).discrete.systemReliability).toBe(0)
    })

    it('weights alternative paths by task frequency', () => {
        const p: ReliabilityProfile = {
            system: 'x',
            modules: [
                { id: 'in', name: 'in', reliability: 1, meanSojournMs: 1 },
                { id: 'good', name: 'good', reliability: 1, meanSojournMs: 1 },
                { id: 'bad', name: 'bad', reliability: 0.5, meanSojournMs: 1 },
            ],
            tasks: [
                { id: 'g', name: 'g', weight: 3, path: ['in', 'good'] },
                { id: 'b', name: 'b', weight: 1, path: ['in', 'bad'] },
            ],
        }
        expect(evaluateProfile(p).discrete.systemReliability).toBeCloseTo(0.75 * 1 + 0.25 * 0.5, 10)
    })

    it('handles loops (repeated module visits) through the fundamental matrix', () => {
        const r = [0.99, 0.9]
        const p = serial(r)
        p.tasks[0].path = ['m0', 'm1', 'm0', 'm1'] // each module visited twice
        // Markov chains are memoryless: after m1 control returns to m0 with p=0.5 or exits with 0.5,
        // so R = v1·R1·e1 with v = π0ᵀ(I−Q)^{-1}: (0.99/(1−0.99·0.45))·0.9·0.5
        const rep = evaluateProfile(p)
        expect(rep.discrete.systemReliability).toBeCloseTo((0.99 / (1 - 0.99 * 0.45)) * 0.9 * 0.5, 10)
        // the per-task figure follows the exact path and equals the plain product
        expect(rep.tasks[0].modelReliability).toBeCloseTo(0.99 ** 2 * 0.9 ** 2, 10)
        const usage = buildUsage(p)
        expect(cheungReliability(usage, [1, 1]).visits).toEqual([expect.closeTo(2, 9), expect.closeTo(2, 9)])
    })

    it('ranks the weakest heavily used module as most sensitive', () => {
        const rep = evaluateProfile(DEFAULT_PROFILE)
        const bySens = [...rep.modules].sort((a, b) => b.sensitivity - a.sensitivity)
        expect(['postgres', 'risk_service', 'gateway', 'risk_controller']).toContain(bySens[0].id)
        rep.modules.forEach((m) => expect(m.improvementPotential).toBeGreaterThanOrEqual(-1e-12))
        const byGain = [...rep.modules].sort((a, b) => b.improvementPotential - a.improvementPotential)
        expect(byGain[0].id).toBe('postgres')
    })
})

describe("Laprie's continuous-time model", () => {
    it('matches a single exponential module exactly', () => {
        const p = serial([0.99], 3_600_000) // one hour in the module, R = 0.99 per visit
        const rep = evaluateProfile(p, 10)
        expect(rep.continuous.failureRatePerHour).toBeCloseTo(-Math.log(0.99), 10)
        expect(rep.continuous.reliabilityAtHorizon).toBeCloseTo(Math.exp(Math.log(0.99) * 10), 10)
        expect(rep.continuous.curve[0]).toEqual({ hours: 0, reliability: 1 })
        expect(rep.continuous.mttfHours).toBeCloseTo(1 / -Math.log(0.99), 6)
    })

    it('uses explicit failure rates and time shares when given', () => {
        const p: ReliabilityProfile = {
            system: 'x',
            meanRepairMinutes: 60,
            modules: [
                { id: 'a', name: 'a', reliability: 1, meanSojournMs: 100, failureRatePerHour: 0.01 },
                { id: 'b', name: 'b', reliability: 1, meanSojournMs: 300, failureRatePerHour: 0.05 },
            ],
            tasks: [{ id: 't', name: 't', weight: 1, path: ['a', 'b'] }],
        }
        const rep = evaluateProfile(p, 24)
        expect(rep.continuous.failureRatePerHour).toBeCloseTo(0.25 * 0.01 + 0.75 * 0.05, 10)
        expect(rep.discrete.meanResponseMs).toBeCloseTo(400)
        const mttf = 1 / rep.continuous.failureRatePerHour
        expect(rep.continuous.availability).toBeCloseTo(mttf / (mttf + 1), 10)
    })
})

describe('busy-time to calendar-time conversion', () => {
    it('scales derived failure rates by utilisation', () => {
        const base = serial([0.999], 100) // 100 ms per request
        const idle = evaluateProfile({ ...base, requestsPerHour: 360 }) // 36 s busy per hour → u = 0.01
        const saturated = evaluateProfile({ ...base, requestsPerHour: 36_000 }) // u = 1
        expect(idle.continuous.utilisation).toBeCloseTo(0.01, 10)
        expect(saturated.continuous.utilisation).toBe(1)
        expect(idle.continuous.failureRatePerHour).toBeCloseTo(saturated.continuous.failureRatePerHour * 0.01, 10)
        // at u = 1 the two models agree: failed requests per hour ≈ λ_sys
        expect(saturated.discrete.operationalFailuresPerHour).toBeCloseTo(36_000 * 0.001, 6)
        expect(saturated.continuous.failureRatePerHour).toBeCloseTo(-Math.log(0.999) * 36_000, 6)
    })
})

describe('live status overlay', () => {
    it('moves cached traffic onto no-cache paths when Redis is down', () => {
        const p = ReliabilityService.applyLiveStatus(DEFAULT_PROFILE, { database: 'ok', cache: 'unavailable' })
        const w = (id: string) => p.tasks.find((t) => t.id === id)?.weight
        expect(w('summary_hit')).toBe(0)
        expect(w('summary_miss')).toBe(22)
        expect(evaluateProfile(p).discrete.systemReliability).toBeLessThan(evaluateProfile(DEFAULT_PROFILE).discrete.systemReliability)
        expect(evaluateProfile(p).discrete.meanResponseMs).toBeGreaterThan(evaluateProfile(DEFAULT_PROFILE).discrete.meanResponseMs)
    })

    it('drives reliability of database-dependent tasks to zero when PostgreSQL is down', () => {
        const p = ReliabilityService.applyLiveStatus(DEFAULT_PROFILE, { database: 'down', cache: 'ok' })
        const rep = evaluateProfile(p)
        expect(rep.tasks.find((t) => t.id === 'ranking')?.modelReliability).toBe(0)
        expect(rep.tasks.find((t) => t.id === 'summary_hit')?.modelReliability).toBeGreaterThan(0.99)
        expect(rep.discrete.systemReliability).toBeLessThan(0.7)
    })
})

// Lecture 8, example 1: M1 interface → M2 business logic / M3 database → M4 report (exit)
const L8_P = [
    [0, 0.7, 0.3, 0],
    [0, 0, 0.6, 0.4],
    [0, 0.2, 0, 0.8],
    [0, 0, 0, 0],
]
const L8_Q = [1, 0, 0, 0]
const L8_R = [0.99, 0.95, 0.98, 0.97]

describe("Gokhale's model (lecture 8, example 1)", () => {
    it('solves V_i = q_i + Σ V_j p_ji', () => {
        const v = expectedVisits(L8_Q, L8_P)
        expect(v[0]).toBeCloseTo(1, 10)
        expect(v[1]).toBeCloseTo(0.76 / 0.88, 10) // ≈ 0.86
        expect(v[2]).toBeCloseTo(0.3 + 0.6 * (0.76 / 0.88), 10) // ≈ 0.82
        expect(v[3]).toBeCloseTo(1, 10)
    })

    it('gives R = Π R_i^{V_i} ≈ 0.90', () => {
        const r = gokhaleReliability(expectedVisits(L8_Q, L8_P), L8_R)
        expect(r).toBeCloseTo(0.904, 3)
    })

    it('agrees with Cheung on the same chain to first order', () => {
        const usage: UsageProfile = {
            moduleIds: ['m1', 'm2', 'm3', 'm4'],
            initial: L8_Q,
            transition: L8_P,
            exit: [0, 0, 0, 1],
            taskModule: [],
            moduleUsage: [],
        }
        const cheung = cheungReliability(usage, L8_R).systemReliability
        expect(Math.abs(cheung - 0.904)).toBeLessThan(0.01)
    })

    it('names the module with the largest V_i·t_i as critical', () => {
        const rep = evaluateProfile(DEFAULT_PROFILE)
        expect(rep.gokhale.criticalModule).toBe('postgres')
        expect(rep.gokhale.visits).toEqual(rep.modules.map(() => expect.any(Number)))
    })
})

describe("Laprie's model (lecture 8, example 2)", () => {
    it('gives R = exp(−Σ V_i θ_i λ_i) ≈ 0.91', () => {
        const v = expectedVisits(L8_Q, L8_P)
        const r = laprieRunReliability(v, [2, 5, 4, 3], [0.005, 0.01, 0.006, 0.008])
        expect(r).toBeCloseTo(Math.exp(-(0.01 + 0.05 * v[1] + 0.024 * v[2] + 0.024)), 12)
        expect(r).toBeCloseTo(0.908, 3)
    })

    it('reduces to Gokhale when λ_i is derived from R_i over θ_i', () => {
        const v = expectedVisits(L8_Q, L8_P)
        const theta = [2, 5, 4, 3]
        const lambda = L8_R.map((r, i) => -Math.log(r) / theta[i])
        expect(laprieRunReliability(v, theta, lambda)).toBeCloseTo(gokhaleReliability(v, L8_R), 12)
    })

    it('stationary π of π·B′ = 0 equals the share of time V_i τ_i / Σ V_j τ_j', () => {
        const usage = buildUsage(DEFAULT_PROFILE)
        const tau = DEFAULT_PROFILE.modules.map((m) => m.meanSojournMs)
        const pi = laprieStationary(usage, tau) as number[]
        const v = expectedVisits(usage.initial, usage.transition)
        const busy = v.reduce((s, x, i) => s + x * tau[i], 0)
        expect(pi.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 10)
        pi.forEach((x, i) => expect(x).toBeCloseTo((v[i] * tau[i]) / busy, 10))
    })
})

describe("Kubat's model: N modules, K tasks", () => {
    it('computes R_i(k) = ∫ e^{−λt} g(t) dt for deterministic and exponential sojourn', () => {
        expect(kubatModuleReliability(0.01, 5)).toBeCloseTo(Math.exp(-0.05), 12)
        expect(kubatModuleReliability(0.01, 5, 'exponential')).toBeCloseTo(1 / 1.05, 12)
    })

    it('builds V_i(k) per task and R(k) = Π R_i^{V_i(k)}', () => {
        const rep = evaluateProfile(DEFAULT_PROFILE)
        const ids = DEFAULT_PROFILE.modules.map((m) => m.id)
        const miss = rep.tasks.find((t) => t.id === 'company_miss')!
        expect(miss.visits[ids.indexOf('postgres')]).toBeCloseTo(2, 10)
        expect(miss.visits[ids.indexOf('prozorro_client')]).toBe(0)
        const R = DEFAULT_PROFILE.modules.map((m) => m.reliability)
        expect(miss.modelReliability).toBeCloseTo(miss.visits.reduce((r, v, i) => r * R[i] ** v, 1), 12)
    })

    it('λ_s = Σ r_k [1 − R(k)] matches the per-request failure count', () => {
        const rep = evaluateProfile(DEFAULT_PROFILE)
        const W = DEFAULT_PROFILE.tasks.reduce((s, t) => s + t.weight, 0)
        const expected = rep.tasks.reduce((s, t) => s + (t.weight / W) * (1 - t.modelReliability), 0)
        expect(rep.kubat.failureProbabilityPerRequest).toBeCloseTo(expected, 12)
        expect(rep.kubat.failuresPerHour).toBeCloseTo(expected * 3600, 9)
        // tasks are short and loop-free, so Kubat and Cheung give close per-request figures
        expect(Math.abs(rep.kubat.failureProbabilityPerRequest - (1 - rep.discrete.systemReliability))).toBeLessThan(5e-4)
    })
})

describe('invariants on random profiles (property-based)', () => {
    // deterministic LCG so failures are reproducible
    let seed = 20261025
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32)
    const randomProfile = (): ReliabilityProfile => {
        const n = 2 + Math.floor(rnd() * 6)
        const modules = Array.from({ length: n }, (_, i) => ({ id: `m${i}`, name: `m${i}`, reliability: 0.9 + 0.1 * rnd(), meanSojournMs: 1 + 100 * rnd() }))
        const tasks = Array.from({ length: 1 + Math.floor(rnd() * 5) }, (_, k) => ({
            id: `t${k}`,
            name: `t${k}`,
            weight: 0.1 + rnd(),
            path: Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => `m${Math.floor(rnd() * n)}`),
        }))
        return { system: 'random', modules, tasks, requestsPerHour: 1000 }
    }

    it('keeps probabilities in [0, 1], distributions normalised and R monotone in every Rᵢ (200 profiles)', () => {
        for (let k = 0; k < 200; k++) {
            const p = randomProfile()
            const rep = evaluateProfile(p)
            for (const r of [rep.discrete.systemReliability, rep.gokhale.systemReliability, rep.continuous.reliabilityAtHorizon, ...rep.tasks.map((t) => t.modelReliability)]) {
                expect(r).toBeGreaterThanOrEqual(0)
                expect(r).toBeLessThanOrEqual(1)
            }
            expect(rep.usage.initial.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 9)
            expect(rep.modules.reduce((s, m) => s + m.timeShare, 0)).toBeCloseTo(1, 9)
            rep.modules.forEach((m) => expect(m.sensitivity).toBeGreaterThanOrEqual(-1e-9))
            expect(rep.kubat.failureProbabilityPerRequest).toBeGreaterThanOrEqual(0)
        }
    })
})
