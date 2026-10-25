/**
 * Markov-chain reliability models of a modular software system.
 *
 * The system is described by n modules and m tasks (use cases). Every task is a
 * sequence of module calls; a module may serve many tasks and a task may visit
 * many modules. From that task–module structure we derive the usage profile:
 *   - π0  – probability that a request enters the system through module i;
 *   - P   – matrix of control-transfer probabilities between modules;
 *   - e   – probability that module i terminates the request successfully.
 *
 * Discrete-time model (Cheung, 1980): failures are absorbed by state F, correct
 * termination by state C; module i passes control with probability R_i·P_ij and
 * fails with 1−R_i.  R_sys = π0ᵀ (I − Q)^{-1} (R ∘ e), Q = diag(R)·P.
 *
 * Gokhale's model: expected visits V_i = q_i + Σ_j V_j p_ji (q = π0) and
 * R = Π_i R_i^{V_i}; the critical module has the largest V_i·t_i.
 *
 * Kubat's model: N modules serve K tasks and every task visits several modules.
 * For task k, q_i(k) and p_ij(k) come from its path, V_i(k) solves the same system
 * as in Gokhale's model, R(k) ≈ Π_i R_i(k)^{V_i(k)} with
 * R_i(k) = ∫ e^{−λ_i t} g_i(k,t) dt, and λ_s = Σ_k r_k [1 − R(k)].
 *
 * Continuous-time model (Laprie, 1984): every module has a failure rate λ_i and
 * a mean sojourn time τ_i = 1/μ_i; with λ_i ≪ μ_i the system behaves as a single
 * exponential with λ_sys = Σ_i π_i λ_i, where π solves π·B' = 0 for the generator
 * B' of the failure-free execution process.  R(T) = exp(−λ_sys T).
 */

export interface ModuleSpec {
    id: string
    name: string
    /** Probability that one visit to the module completes correctly. */
    reliability: number
    /** Mean time spent in the module per visit. */
    meanSojournMs: number
    /**
     * Optional outage rate in calendar time (1/h): crashes, hangs, unavailability.
     * When absent it is derived from the per-visit reliability and sojourn time
     * and converted from busy time to calendar time with the utilisation.
     */
    failureRatePerHour?: number
    /** Where the reliability figure comes from (tests, load test, fault injection…). */
    evidence?: string
}

export interface TaskSpec {
    id: string
    name: string
    /** Relative frequency of the task in the operational profile. */
    weight: number
    /** Module ids in execution order. */
    path: string[]
    /** Empirical success rate for validation against the model. */
    observedSuccessRate?: number
}

export interface ReliabilityProfile {
    system: string
    version?: string
    modules: ModuleSpec[]
    tasks: TaskSpec[]
    /** Requests per hour; turns per-request unreliability into an operational failure rate. */
    requestsPerHour?: number
    /** Mean time to restore the service after a failure; enables availability. */
    meanRepairMinutes?: number
}

export interface UsageProfile {
    moduleIds: string[]
    /** π0: probability that module i is called first. */
    initial: number[]
    /** P: control-transfer probabilities between modules. */
    transition: number[][]
    /** e: probability that module i hands the result to the user. */
    exit: number[]
    /** U[t][i]: how many times task t visits module i. */
    taskModule: number[][]
    /** Probability that module i is used by a random request. */
    moduleUsage: number[]
}

export interface ModuleResult {
    id: string
    name: string
    reliability: number
    meanSojournMs: number
    failureRatePerHour: number
    /** Expected visits per request. */
    expectedVisits: number
    /** Long-run fraction of busy time spent in the module. */
    timeShare: number
    /** ∂R_sys/∂R_i. */
    sensitivity: number
    /** R_sys if this module were perfect minus current R_sys. */
    improvementPotential: number
}

export interface TaskResult {
    id: string
    name: string
    weight: number
    /** Kubat's R(k) = Π_i R_i(k)^{V_i(k)}. */
    modelReliability: number
    /** V_i(k): expected visits to each module while the task runs. */
    visits: number[]
    observedSuccessRate?: number
    absError?: number
}

export interface ReliabilityReport {
    system: string
    version?: string
    computedAt: string
    horizonHours: number
    usage: UsageProfile
    discrete: {
        /** Probability that one request completes correctly. */
        systemReliability: number
        /** Expected module visits per request. */
        expectedPathLength: number
        /** Mean response time from sojourn times, ms. */
        meanResponseMs: number
        /** (1 − R_sys) × requests per hour, if requests per hour known. */
        operationalFailuresPerHour?: number
    }
    continuous: {
        /** Fraction of calendar time the system is busy (requests/h × mean response). */
        utilisation: number
        /** System failure rate in calendar time, 1/h. */
        failureRatePerHour: number
        mttfHours: number
        reliabilityAtHorizon: number
        /** R(t) sampled over [0, horizon]. */
        curve: { hours: number; reliability: number }[]
        availability?: number
    }
    gokhale: {
        /** V_i = q_i + Σ_j V_j p_ji. */
        visits: number[]
        /** R = Π R_i^{V_i}. */
        systemReliability: number
        /** Module with the largest expected execution time V_i·t_i. */
        criticalModule: string
    }
    kubat: {
        /** Σ_k r_k [1 − R(k)] with r_k the share of task k. */
        failureProbabilityPerRequest: number
        /** Σ_k r_k [1 − R(k)] with r_k task executions per hour, if requests per hour known. */
        failuresPerHour?: number
    }
    modules: ModuleResult[]
    tasks: TaskResult[]
}

export class ProfileError extends Error {}

const EPS = 1e-12

/** Solve A·x = b by Gaussian elimination with partial pivoting. */
export function solve(a: number[][], b: number[]): number[] {
    const n = b.length
    const m = a.map((row, i) => [...row, b[i]])
    for (let col = 0; col < n; col++) {
        let pivot = col
        for (let r = col + 1; r < n; r++)
            if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r
        if (Math.abs(m[pivot][col]) < EPS)
            throw new ProfileError(
                'singular matrix: the chain never terminates',
            )
        ;[m[col], m[pivot]] = [m[pivot], m[col]]
        for (let r = 0; r < n; r++) {
            if (r === col) continue
            const f = m[r][col] / m[col][col]
            if (f === 0) continue
            for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c]
        }
    }
    return m.map((row, i) => row[n] / row[i])
}

export function invert(a: number[][]): number[][] {
    const n = a.length
    const cols: number[][] = []
    for (let j = 0; j < n; j++) {
        const e = Array(n).fill(0)
        e[j] = 1
        cols.push(solve(a, e))
    }
    return a.map((_, i) => cols.map((c) => c[i]))
}

export function validateProfile(p: ReliabilityProfile): void {
    if (!p.modules?.length) throw new ProfileError('profile has no modules')
    if (!p.tasks?.length) throw new ProfileError('profile has no tasks')
    const ids = new Set<string>()
    for (const m of p.modules) {
        if (ids.has(m.id)) throw new ProfileError(`duplicate module id ${m.id}`)
        ids.add(m.id)
        if (!(m.reliability >= 0 && m.reliability <= 1))
            throw new ProfileError(
                `module ${m.id}: reliability must be in [0,1]`,
            )
        if (!(m.meanSojournMs >= 0))
            throw new ProfileError(`module ${m.id}: meanSojournMs must be >= 0`)
    }
    let total = 0
    for (const t of p.tasks) {
        if (!(t.weight >= 0))
            throw new ProfileError(`task ${t.id}: weight must be >= 0`)
        if (!t.path?.length) throw new ProfileError(`task ${t.id}: empty path`)
        for (const id of t.path)
            if (!ids.has(id))
                throw new ProfileError(`task ${t.id}: unknown module ${id}`)
        total += t.weight
    }
    if (total <= 0) throw new ProfileError('all task weights are zero')
}

/** Derive π0, P, e and the task–module matrix from the task paths. */
export function buildUsage(p: ReliabilityProfile): UsageProfile {
    validateProfile(p)
    const ids = p.modules.map((m) => m.id)
    const idx = new Map(ids.map((id, i) => [id, i]))
    const n = ids.length
    const total = p.tasks.reduce((s, t) => s + t.weight, 0)
    const initial = Array(n).fill(0)
    const counts = Array.from({ length: n }, () => Array(n).fill(0))
    const exitCounts = Array(n).fill(0)
    const taskModule = p.tasks.map(() => Array(n).fill(0))
    const used = Array(n).fill(0)
    p.tasks.forEach((t, ti) => {
        const w = t.weight / total
        const path = t.path.map((id) => idx.get(id) as number)
        initial[path[0]] += w
        for (let k = 0; k < path.length; k++) {
            taskModule[ti][path[k]] += 1
            if (k + 1 < path.length) counts[path[k]][path[k + 1]] += w
            else exitCounts[path[k]] += w
        }
        for (const i of new Set(path)) used[i] += w
    })
    const transition = counts.map((row, i) => {
        const out = row.reduce((s, v) => s + v, 0) + exitCounts[i]
        return out > 0 ? row.map((v) => v / out) : row.map(() => 0)
    })
    const exit = exitCounts.map((v, i) => {
        const out = counts[i].reduce((s, x) => s + x, 0) + v
        return out > 0 ? v / out : 0
    })
    return {
        moduleIds: ids,
        initial,
        transition,
        exit,
        taskModule,
        moduleUsage: used,
    }
}

/** Cheung's model: probability that a request terminates correctly. */
export function cheungReliability(
    usage: UsageProfile,
    reliabilities: number[],
): { systemReliability: number; visits: number[] } {
    const n = usage.moduleIds.length
    // (I − Q)ᵀ v = π0  →  v = π0ᵀ (I − Q)^{-1}, Q_ij = R_i P_ij
    const a = Array.from({ length: n }, (_, i) =>
        Array.from(
            { length: n },
            (_, j) =>
                (i === j ? 1 : 0) - reliabilities[j] * usage.transition[j][i],
        ),
    )
    const visits = solve(a, usage.initial)
    const systemReliability = visits.reduce(
        (s, v, i) => s + v * reliabilities[i] * usage.exit[i],
        0,
    )
    return { systemReliability: clamp01(systemReliability), visits }
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

/** V_i = q_i + Σ_j V_j p_ji: expected visits to every module (Gokhale, Kubat). */
export function expectedVisits(
    initial: number[],
    transition: number[][],
): number[] {
    const n = initial.length
    const a = Array.from({ length: n }, (_, i) =>
        Array.from(
            { length: n },
            (_, j) => (i === j ? 1 : 0) - transition[j][i],
        ),
    )
    return solve(a, initial)
}

/** Gokhale's model: R = Π R_i^{V_i}. */
export function gokhaleReliability(
    visits: number[],
    reliabilities: number[],
): number {
    return visits.reduce(
        (r, v, i) => r * (v > 0 ? reliabilities[i] ** v : 1),
        1,
    )
}

/** Laprie's per-run form R = exp(−Σ V_i θ_i λ_i) (θ_i — time per visit, λ_i — failures per unit of that time). */
export function laprieRunReliability(
    visits: number[],
    theta: number[],
    lambda: number[],
): number {
    return Math.exp(
        -visits.reduce((s, v, i) => s + v * theta[i] * lambda[i], 0),
    )
}

/**
 * R_i(k) = ∫ e^{−λ_i t} g_i(k,t) dt for a module that stays θ in the task:
 * deterministic sojourn gives e^{−λθ}, exponential sojourn gives 1/(1 + λθ).
 */
export function kubatModuleReliability(
    lambda: number,
    theta: number,
    sojourn: 'deterministic' | 'exponential' = 'deterministic',
): number {
    return sojourn === 'exponential'
        ? 1 / (1 + lambda * theta)
        : Math.exp(-lambda * theta)
}

/**
 * Stationary distribution of the failure-free CTMC: from module i control leaves
 * at rate μ_i = 1/τ_i, goes to j with P_ij, and a finished request is replaced by a
 * new one entering at j with π0_j. Solves π·B' = 0, Σ π = 1 over the modules a
 * request can reach. Returns null when a reachable module has zero sojourn time.
 */
export function laprieStationary(
    usage: UsageProfile,
    sojournMs: number[],
): number[] | null {
    const reach = expectedVisits(usage.initial, usage.transition).map(
        (v) => v > EPS,
    )
    const S = reach.flatMap((r, i) => (r ? [i] : []))
    if (S.some((i) => !(sojournMs[i] > 0))) return null
    const k = S.length
    const rate = (i: number, j: number) =>
        (usage.transition[i][j] + usage.exit[i] * usage.initial[j]) /
        sojournMs[i]
    // B'ᵀ π = 0 with the last equation replaced by Σ π = 1
    const a = Array.from({ length: k }, (_, r) =>
        Array.from({ length: k }, (_, c) => {
            if (r === k - 1) return 1
            const i = S[c]
            const j = S[r]
            if (i !== j) return rate(i, j)
            return rate(i, i) - S.reduce((s, x) => s + rate(i, x), 0)
        }),
    )
    const b = Array(k).fill(0)
    b[k - 1] = 1
    const pi = solve(a, b)
    const out = Array(usage.moduleIds.length).fill(0)
    S.forEach((i, r) => (out[i] = Math.max(0, pi[r])))
    return out
}

export function evaluateProfile(
    p: ReliabilityProfile,
    horizonHours = 24,
    curvePoints = 48,
): ReliabilityReport {
    const usage = buildUsage(p)
    const R = p.modules.map((m) => m.reliability)
    const { systemReliability, visits } = cheungReliability(usage, R)

    // usage without failures: Gokhale's V_i = q_i + Σ V_j p_ji
    const visitsNoFail = expectedVisits(usage.initial, usage.transition)
    const tau = p.modules.map((m) => m.meanSojournMs)
    const busy = visitsNoFail.reduce((s, v, i) => s + v * tau[i], 0)
    const timeShare =
        laprieStationary(usage, tau) ??
        visitsNoFail.map((v, i) => (busy > 0 ? (v * tau[i]) / busy : 0))
    let critical = 0
    visitsNoFail.forEach((v, i) => {
        if (v * tau[i] > visitsNoFail[critical] * tau[critical]) critical = i
    })
    const utilisation =
        p.requestsPerHour === undefined
            ? 1
            : Math.min(1, (p.requestsPerHour * busy) / 3_600_000)
    const lambda = p.modules.map((m) => {
        if (m.failureRatePerHour !== undefined) return m.failureRatePerHour
        if (m.reliability >= 1) return 0
        if (m.reliability <= 0 || m.meanSojournMs <= 0)
            return Number.POSITIVE_INFINITY
        // per-visit unreliability spread over the visit duration, then busy → calendar time
        return (
            (-Math.log(m.reliability) / (m.meanSojournMs / 3_600_000)) *
            utilisation
        )
    })
    const lambdaSys = lambda.reduce(
        (s, l, i) => s + (timeShare[i] > 0 ? timeShare[i] * l : 0),
        0,
    )
    const curve = Array.from({ length: curvePoints + 1 }, (_, k) => {
        const hours = (horizonHours * k) / curvePoints
        return { hours, reliability: Math.exp(-lambdaSys * hours) }
    })
    const mttfHours = lambdaSys > 0 ? 1 / lambdaSys : Number.POSITIVE_INFINITY
    const availability =
        p.meanRepairMinutes !== undefined && Number.isFinite(mttfHours)
            ? mttfHours / (mttfHours + p.meanRepairMinutes / 60)
            : p.meanRepairMinutes !== undefined
              ? 1
              : undefined

    const modules: ModuleResult[] = p.modules.map((m, i) => {
        const h = 1e-6
        const up = [...R]
        up[i] = Math.min(1, R[i] + h)
        const down = [...R]
        down[i] = Math.max(0, R[i] - h)
        const sensitivity =
            (cheungReliability(usage, up).systemReliability -
                cheungReliability(usage, down).systemReliability) /
            (up[i] - down[i] || 1)
        const perfect = [...R]
        perfect[i] = 1
        return {
            id: m.id,
            name: m.name,
            reliability: m.reliability,
            meanSojournMs: m.meanSojournMs,
            failureRatePerHour: lambda[i],
            expectedVisits: visits[i],
            timeShare: timeShare[i],
            sensitivity,
            improvementPotential:
                cheungReliability(usage, perfect).systemReliability -
                systemReliability,
        }
    })

    // Kubat: q_i(k), p_ij(k) from the task's own path; R_i(k) = R_i (one visit lasts τ_i)
    const totalWeight = p.tasks.reduce((s, t) => s + t.weight, 0)
    const tasks: TaskResult[] = p.tasks.map((t) => {
        const own = buildUsage({ ...p, tasks: [{ ...t, weight: 1 }] })
        const v = expectedVisits(own.initial, own.transition)
        const model = gokhaleReliability(v, R)
        return {
            id: t.id,
            name: t.name,
            weight: t.weight,
            modelReliability: model,
            visits: v,
            observedSuccessRate: t.observedSuccessRate,
            absError:
                t.observedSuccessRate === undefined
                    ? undefined
                    : Math.abs(model - t.observedSuccessRate),
        }
    })

    return {
        system: p.system,
        version: p.version,
        computedAt: new Date().toISOString(),
        horizonHours,
        usage,
        discrete: {
            systemReliability,
            expectedPathLength: visitsNoFail.reduce((s, v) => s + v, 0),
            meanResponseMs: busy,
            operationalFailuresPerHour:
                p.requestsPerHour === undefined
                    ? undefined
                    : (1 - systemReliability) * p.requestsPerHour,
        },
        continuous: {
            utilisation,
            failureRatePerHour: lambdaSys,
            mttfHours,
            reliabilityAtHorizon: Math.exp(-lambdaSys * horizonHours),
            curve,
            availability,
        },
        gokhale: {
            visits: visitsNoFail,
            systemReliability: gokhaleReliability(visitsNoFail, R),
            criticalModule: p.modules[critical].id,
        },
        kubat: {
            failureProbabilityPerRequest: tasks.reduce(
                (s, t) =>
                    s + (t.weight / totalWeight) * (1 - t.modelReliability),
                0,
            ),
            failuresPerHour:
                p.requestsPerHour === undefined
                    ? undefined
                    : tasks.reduce(
                          (s, t) =>
                              s +
                              (((p.requestsPerHour as number) * t.weight) /
                                  totalWeight) *
                                  (1 - t.modelReliability),
                          0,
                      ),
        },
        modules,
        tasks,
    }
}
