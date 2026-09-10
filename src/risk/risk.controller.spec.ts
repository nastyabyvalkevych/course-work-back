import { RiskController } from './risk.controller'
import { RiskService } from './risk.service'

/** Contract of the public risk API: query parsing and delegation. */
describe('RiskController', () => {
    const service = {
        summary: jest.fn().mockResolvedValue({ ok: true }),
        ranking: jest.fn().mockResolvedValue({ items: [] }),
        company: jest.fn().mockResolvedValue({}),
        graph: jest.fn().mockResolvedValue({}),
        tender: jest.fn().mockResolvedValue({}),
    } as unknown as jest.Mocked<RiskService>
    const controller = new RiskController(service)

    beforeEach(() => jest.clearAllMocks())

    it('parses ranking filters with safe defaults', async () => {
        await controller.ranking('20', undefined, '5', '1', 'true', ' Кубл ')
        expect(service.ranking).toHaveBeenCalledWith({
            limit: 20,
            offset: undefined,
            minTenders: 5,
            excludeKnown: true,
            fullCoverageOnly: true,
            q: ' Кубл ',
        })
        await controller.ranking(undefined, undefined, undefined, '0', 'no', undefined)
        expect(service.ranking).toHaveBeenLastCalledWith(
            expect.objectContaining({ excludeKnown: false, fullCoverageOnly: false }),
        )
    })

    it('trims identifiers before delegating', async () => {
        await controller.company(' 12345678 ')
        expect(service.company).toHaveBeenCalledWith('12345678')
        await controller.graph(' 12345678 ', '15')
        expect(service.graph).toHaveBeenCalledWith('12345678', 15)
        await controller.tender(' UA-2024-01-01-000001-a ')
        expect(service.tender).toHaveBeenCalledWith('UA-2024-01-01-000001-a')
    })
})
