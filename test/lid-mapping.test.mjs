import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LIDMappingStore } from '../lib/Signal/lid-mapping.js'
import { createMemoryKeyStore, logger } from './support/signal.mjs'

const pn = '123@s.whatsapp.net'
const lid = '456@lid'

function makeStore(options = {}) {
	const keys = createMemoryKeyStore()
	return { keys, mapping: new LIDMappingStore(keys, logger, options.pnToLIDFunc) }
}

describe('LIDMappingStore', () => {
	it('stores a mapping and resolves it in both directions', async () => {
		const { mapping } = makeStore()
		await mapping.storeLIDPNMappings([{ pn, lid }])

		assert.equal(await mapping.getLIDForPN(pn), lid)
		assert.equal(await mapping.getPNForLID(lid), pn)
		assert.equal(mapping.phoneCache.getLidForPhone(pn), lid)
		assert.equal(mapping.phoneCache.getPhoneForLid(lid), pn)
	})

	it('resolves device-specific mappings', async () => {
		const { mapping } = makeStore()
		await mapping.storeLIDPNMappings([{ pn, lid }])

		assert.deepEqual(await mapping.getLIDsForPNs(['123:5@s.whatsapp.net']), [
			{ lid: '456:5@lid', pn: '123:5@s.whatsapp.net' }
		])
		assert.deepEqual(await mapping.getPNsForLIDs(['456:5@lid']), [
			{ lid: '456:5@lid', pn: '123:5@s.whatsapp.net' }
		])
	})

	it('normalizes reversed PN/LID pairs', async () => {
		const { mapping } = makeStore()
		await mapping.storeLIDPNMappings([{ pn: lid, lid: pn }])

		assert.equal(await mapping.getLIDForPN(pn), lid)
		assert.equal(await mapping.getPNForLID(lid), pn)
	})

	it('supports hosted PN and hosted LID mappings', async () => {
		const { mapping } = makeStore()
		const hostedPn = '123@hosted'
		const hostedLid = '456@hosted.lid'
		await mapping.storeLIDPNMappings([{ pn: hostedPn, lid: hostedLid }])

		assert.equal(await mapping.getLIDForPN(hostedPn), hostedLid)
		assert.equal(await mapping.getPNForLID(hostedLid), hostedPn)
	})

	it('removes the stale reverse mapping when a PN is remapped', async () => {
		const { keys, mapping } = makeStore()
		await mapping.storeLIDPNMappings([{ pn, lid }])
		await mapping.storeLIDPNMappings([{ pn, lid: '789@lid' }])

		assert.equal(await mapping.getLIDForPN(pn), '789@lid')
		assert.equal(await mapping.getPNForLID(lid), null)
		assert.equal(await mapping.getPNForLID('789@lid'), pn)
		assert.equal((await keys.get('lid-mapping', ['456_reverse']))['456_reverse'], undefined)
	})

	it('falls back to the USync resolver and stores its result', async () => {
		let requested = []
		const { mapping } = makeStore({
			pnToLIDFunc: async jids => {
				requested = jids
				return [{ pn: '123@s.whatsapp.net', lid }]
			}
		})

		assert.equal(await mapping.getLIDForPN(pn), lid)
		assert.deepEqual(requested, [pn])
		assert.equal(await mapping.getPNForLID(lid), pn)
	})

	it('returns null for unsupported or unknown JIDs', async () => {
		const { mapping } = makeStore()
		assert.equal(await mapping.getLIDForPN('123@lid'), null)
		assert.equal(await mapping.getPNForLID('123@s.whatsapp.net'), null)
		assert.equal(await mapping.getLIDForPN('999@s.whatsapp.net'), null)
		assert.equal(await mapping.getPNForLID('999@lid'), null)
	})

	it('keeps reverse mappings consistent under concurrent writes', async () => {
		const { mapping } = makeStore()
		const candidates = ['456@lid', '789@lid', '101112@lid']

		await Promise.all(candidates.map(candidate => mapping.storeLIDPNMappings([{ pn, lid: candidate }])))

		const finalLid = await mapping.getLIDForPN(pn)
		assert.ok(candidates.includes(finalLid))
		for (const candidate of candidates) {
			assert.equal(await mapping.getPNForLID(candidate), candidate === finalLid ? pn : null)
		}
	})

	it('deduplicates concurrent lookups', async () => {
		let calls = 0
		const { mapping } = makeStore({
			pnToLIDFunc: async () => {
				calls += 1
				await new Promise(resolve => setTimeout(resolve, 5))
				return [{ pn, lid }]
			}
		})

		const [first, second] = await Promise.all([mapping.getLIDsForPNs([pn]), mapping.getLIDsForPNs([pn])])
		assert.equal(calls, 1)
		assert.deepEqual(first, second)
	})

	it('clears its caches on close', async () => {
		const { mapping } = makeStore()
		await mapping.storeLIDPNMappings([{ pn, lid }])
		assert.equal(mapping.phoneCache.size, 2)
		mapping.close()
		assert.equal(mapping.phoneCache.size, 0)
		assert.equal(await mapping.getLIDForPN(pn), lid)
	})
})
