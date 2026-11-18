import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isStaleQueryError, makeMexWithFallback } from '../lib/Socket/mex.js'
import { QueryIds } from '../lib/Types/index.js'

const ok = (path, value) => ({
	tag: 'iq',
	attrs: {},
	content: [{ tag: 'result', attrs: {}, content: Buffer.from(JSON.stringify({ data: { [path]: value } })) }]
})

const fail = (message, code) => ({
	tag: 'iq',
	attrs: {},
	content: [
		{
			tag: 'result',
			attrs: {},
			content: Buffer.from(JSON.stringify({ errors: [{ message, extensions: code ? { error_code: code } : {} }] }))
		}
	]
})

const setup = handler => {
	const calls = []
	const query = async node => {
		const child = node.content[0]
		const variables = JSON.parse(child.content.toString()).variables
		const id = child.attrs.query_id
		calls.push({ id, variables })
		return handler(id, variables)
	}

	let n = 0
	const mex = makeMexWithFallback({ query, generateMessageTag: () => `t${n++}` })
	return { calls, mex }
}

describe('isStaleQueryError', () => {
	it('detects stale document id errors', () => {
		assert.equal(isStaleQueryError(new Error('PersistedQueryNotFound')), true)
		assert.equal(isStaleQueryError(new Error('Unknown query id')), true)
		assert.equal(isStaleQueryError(new Error('rate limited')), false)
	})
})

describe('makeMexWithFallback', () => {
	const primary = QueryIds.METADATA
	const alternate = '27456920720571478'

	it('uses the primary id when it works', async () => {
		const { calls, mex } = setup(() => ok('p', 1))
		assert.equal(await mex.executeWMexQuery({ a: 1 }, primary, 'p'), 1)
		assert.deepEqual(calls.map(c => c.id), [primary])
	})

	it('falls back to an alternate id and remembers it', async () => {
		const { calls, mex } = setup(id => (id === alternate ? ok('p', 'alt') : fail('boom')))
		assert.equal(await mex.executeWMexQuery({ a: 1 }, primary, 'p'), 'alt')
		assert.deepEqual(calls.map(c => c.id), [primary, alternate])
		assert.equal(calls[1].variables.fetch_pinned_messages, false)
		assert.equal(calls[1].variables.a, 1)

		await mex.executeWMexQuery({ a: 2 }, primary, 'p')
		assert.equal(calls[2].id, alternate)
	})

	it('does not retry auth errors', async () => {
		const { calls, mex } = setup(() => fail('forbidden', 403))
		await assert.rejects(() => mex.executeWMexQuery({}, primary, 'p'), e => e.output.statusCode === 403)
		assert.equal(calls.length, 1)
	})

	it('retries a write query only for stale id errors', async () => {
		const create = QueryIds.CREATE
		const generic = setup(() => fail('something else'))
		await assert.rejects(() => generic.mex.executeWMexQuery({}, create, 'p'))
		assert.equal(generic.calls.length, 1)

		const stale = setup(id => (id === create ? fail('PersistedQueryNotFound') : ok('p', 'created')))
		assert.equal(await stale.mex.executeWMexQuery({}, create, 'p'), 'created')
		assert.equal(stale.calls.length, 2)
	})

	it('throws the first error when every candidate fails', async () => {
		const { calls, mex } = setup(id => fail(`bad ${id}`))
		await assert.rejects(() => mex.executeWMexQuery({}, primary, 'p'), /bad 6563316087068696/)
		assert.equal(calls.length, 2)
	})

	it('passes unknown ids straight through', async () => {
		const { calls, mex } = setup(() => ok('p', 7))
		assert.equal(await mex.executeWMexQuery({}, '111', 'p'), 7)
		assert.equal(calls.length, 1)
	})
})
