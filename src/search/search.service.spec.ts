import {
    DEFAULT_FIELD_WEIGHTS,
    DEFAULT_SEARCH_PROFILE,
    EXACT_MATCH_FIELDS,
    SEARCH_PROFILE_OPTIONS,
    SearchService,
} from './search.service'

describe('SearchService configuration', () => {
    it('uses the 36-field canonical BM25F schema', () => {
        expect(Object.keys(DEFAULT_FIELD_WEIGHTS)).toHaveLength(36)
        expect(DEFAULT_FIELD_WEIGHTS).not.toHaveProperty('datePublished')
        expect(DEFAULT_FIELD_WEIGHTS).not.toHaveProperty('dateModified')
        expect(DEFAULT_FIELD_WEIGHTS).not.toHaveProperty('valueAmount')
        expect(DEFAULT_FIELD_WEIGHTS).not.toHaveProperty('winnerValueAmount')
        expect(DEFAULT_FIELD_WEIGHTS).not.toHaveProperty('minBidValue')
        expect(DEFAULT_FIELD_WEIGHTS).not.toHaveProperty('maxBidValue')
        expect(DEFAULT_FIELD_WEIGHTS).not.toHaveProperty('bidsCount')
    })

    it('defaults public search traffic to the BM25F profile', () => {
        const service = new SearchService({} as never, {} as never, {} as never)

        const resolved = (service as any).resolveSearchOptions({})

        expect(resolved.profile).toBe(DEFAULT_SEARCH_PROFILE)
        expect(resolved.useMultifield).toBe(true)
        expect(resolved.k1).toBe(SEARCH_PROFILE_OPTIONS.bm25f_default.k1)
        expect(resolved.fieldWeights).toEqual(DEFAULT_FIELD_WEIGHTS)
    })

    it('does not let undefined query values erase profile defaults', () => {
        const service = new SearchService({} as never, {} as never, {} as never)

        const resolved = (service as any).resolveSearchOptions({
            k1: undefined,
            b: undefined,
            useMultifield: undefined,
        })

        expect(resolved.profile).toBe(DEFAULT_SEARCH_PROFILE)
        expect(resolved.k1).toBe(0.2)
        expect(resolved.b).toBe(0.0)
    })

    it('keeps explicit single-field requests out of the default BM25F profile', () => {
        const service = new SearchService({} as never, {} as never, {} as never)

        const resolved = (service as any).resolveSearchOptions({
            useMultifield: false,
        })

        expect(resolved.profile).toBeUndefined()
        expect(resolved.useMultifield).toBe(false)
    })

    it('keeps the DA profile wired to exact-match fields', () => {
        const profile = SEARCH_PROFILE_OPTIONS.da_bm25f_combined

        expect(profile.fieldWeights).toEqual(DEFAULT_FIELD_WEIGHTS)
        expect(profile.exactMatchFields).toEqual(EXACT_MATCH_FIELDS)
        expect(profile.exactMatchBoost).toBe(2.0)
    })
})
