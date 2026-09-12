import { BadRequestException } from '@nestjs/common'

import { DEFAULT_PROFILE } from './default-profile'
import { ReliabilityController } from './reliability.controller'
import { ReliabilityService } from './reliability.service'

describe('ReliabilityController', () => {
    const service = new ReliabilityService({} as never, { isReady: () => false } as never)
    const controller = new ReliabilityController(service)

    it('returns a report for the built-in profile with the requested horizon', () => {
        const rep = controller.report('72', undefined) as ReturnType<ReliabilityService['evaluate']>
        expect(rep.horizonHours).toBe(72)
        expect(rep.modules).toHaveLength(DEFAULT_PROFILE.modules.length)
        expect(rep.discrete.systemReliability).toBeGreaterThan(0.99)
        expect(rep.discrete.systemReliability).toBeLessThan(1)
    })

    it('exposes the profile and evaluates a custom one', () => {
        expect(controller.profile()).toBe(DEFAULT_PROFILE)
        const custom = { ...DEFAULT_PROFILE, modules: DEFAULT_PROFILE.modules.map((m) => ({ ...m, reliability: 1 })) }
        expect(controller.evaluate(custom, undefined).discrete.systemReliability).toBe(1)
    })

    it('turns profile errors and bad horizons into HTTP 400', () => {
        expect(() => controller.evaluate({ system: 'x', modules: [], tasks: [] }, undefined)).toThrow(BadRequestException)
        expect(() => controller.report('-1', undefined)).toThrow(BadRequestException)
    })
})
