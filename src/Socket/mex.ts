import { Boom } from '@neykoor/boom'
import { QueryIds } from '../Types'
import type { BinaryNode } from '../WABinary'
import { getBinaryNodeChild, S_WHATSAPP_NET } from '../WABinary'

const wMexQuery = (
	variables: Record<string, unknown>,
	queryId: string,
	query: (node: BinaryNode) => Promise<BinaryNode>,
	generateMessageTag: () => string
) => {
	return query({
		tag: 'iq',
		attrs: {
			id: generateMessageTag(),
			type: 'get',
			to: S_WHATSAPP_NET,
			xmlns: 'w:mex'
		},
		content: [
			{
				tag: 'query',
				attrs: { query_id: queryId },
				content: Buffer.from(JSON.stringify({ variables }), 'utf-8')
			}
		]
	})
}

export const executeWMexQuery = async <T>(
	variables: Record<string, unknown>,
	queryId: string,
	dataPath: string,
	query: (node: BinaryNode) => Promise<BinaryNode>,
	generateMessageTag: () => string
): Promise<T> => {
	const result = await wMexQuery(variables, queryId, query, generateMessageTag)
	const child = getBinaryNodeChild(result, 'result')
	if (child?.content) {
		const data = JSON.parse(child.content.toString())

		if (data.errors && data.errors.length > 0) {
			const errorMessages = data.errors.map((err: Error) => err.message || 'Unknown error').join(', ')
			const firstError = data.errors[0]
			const errorCode = firstError.extensions?.error_code || 400
			throw new Boom(`GraphQL server error: ${errorMessages}`, { statusCode: errorCode, data: firstError })
		}

		const response = dataPath ? data?.data?.[dataPath] : data?.data
		if (typeof response !== 'undefined') {
			return response as T
		}
	}

	const action = (dataPath || '').startsWith('xwa2_')
		? dataPath.substring(5).replace(/_/g, ' ')
		: dataPath?.replace(/_/g, ' ')
	throw new Boom(`Failed to ${action}, unexpected response structure.`, { statusCode: 400, data: result })
}

export const executeWMexQueryIgnoreResponse = async (
	variables: Record<string, unknown>,
	queryId: string,
	query: (node: BinaryNode) => Promise<BinaryNode>,
	generateMessageTag: () => string
): Promise<void> => {
	const result = await wMexQuery(variables, queryId, query, generateMessageTag)
	const child = getBinaryNodeChild(result, 'result')
	if (!child?.content) {
		return
	}

	let data: any
	try {
		data = JSON.parse(child.content.toString())
	} catch {
		return
	}

	if (Array.isArray(data.errors) && data.errors.length > 0) {
		const errorMessages = data.errors.map((err: Error) => err.message || 'Unknown error').join(', ')
		const firstError = data.errors[0]
		const errorCode = firstError.extensions?.error_code || 400
		throw new Boom(`GraphQL server error: ${errorMessages}`, { statusCode: errorCode, data: firstError })
	}
}

export const NEWSLETTER_ID_ALTERNATES: Readonly<
	Record<string, { alternates: string[]; readOnly: boolean; extraVariables?: Record<string, unknown> }>
> = Object.freeze({
	METADATA: {
		alternates: ['27456920720571478'],
		readOnly: true,
		extraVariables: { fetch_pinned_messages: false, fetch_status_metadata: false, fetch_wamo_sub: false }
	},
	SUBSCRIBED: { alternates: ['6388546374527196', '25399611239711790'], readOnly: true },
	ADMIN_COUNT: { alternates: ['26278439461859188'], readOnly: true },
	CREATE: { alternates: ['25149874324715067'], readOnly: false }
})

const STALE_QUERY_RE =
	/persisted|not[ _-]?found|unknown (query|doc|operation)|doc[_ -]?id|invalid (query|document|operation)|no such (query|operation)|unsupported (query|operation)|deprecated/i
const AUTH_CODES = new Set([401, 403, 419])

const errorText = (e: any) =>
	[e?.message, e?.data?.message, e?.data?.extensions?.error_code, e?.data?.extensions?.severity, JSON.stringify(e?.data?.attrs ?? '')]
		.filter(Boolean)
		.join(' ')

export const isStaleQueryError = (e: unknown) => STALE_QUERY_RE.test(errorText(e))

export const makeMexWithFallback = ({
	query,
	generateMessageTag,
	logger,
	overrides = {}
}: {
	query: (node: BinaryNode) => Promise<BinaryNode>
	generateMessageTag: () => string
	logger?: { info?: (...a: any[]) => void; debug?: (...a: any[]) => void }
	overrides?: Record<string, string>
}) => {
	const nameById = new Map<string, string>(Object.entries(QueryIds).map(([name, id]) => [String(id), name]))
	const preferred = new Map<string, string>()

	const raw = <T>(variables: Record<string, unknown>, id: string, path: string) =>
		executeWMexQuery<T>(variables, id, path, query, generateMessageTag)

	const candidatesFor = (id: string) => {
		const name = nameById.get(String(id))
		const spec = name ? NEWSLETTER_ID_ALTERNATES[name] : undefined
		const list: string[] = []
		if (name && overrides[name]) list.push(String(overrides[name]))
		if (preferred.has(String(id))) list.push(preferred.get(String(id))!)
		list.push(String(id))
		if (spec) list.push(...spec.alternates)
		return { name, spec, list: [...new Set(list)] }
	}

	const executeWithFallback = async <T>(variables: Record<string, unknown>, queryId: string, dataPath: string): Promise<T> => {
		const { name, spec, list } = candidatesFor(queryId)
		if (list.length === 1) return raw<T>(variables, list[0]!, dataPath)

		let firstError: unknown
		for (let i = 0; i < list.length; i++) {
			const id = list[i]!
			const vars = spec?.extraVariables && id !== String(queryId) ? { ...spec.extraVariables, ...variables } : variables
			try {
				const res = await raw<T>(vars, id, dataPath)
				if (id !== String(queryId) && preferred.get(String(queryId)) !== id) {
					preferred.set(String(queryId), id)
					logger?.info?.({ op: name, primary: queryId, using: id }, 'newsletter mex: alternate doc id worked')
				}

				return res
			} catch (e: any) {
				firstError ??= e
				const status = e?.output?.statusCode ?? e?.data?.statusCode
				const retry = i < list.length - 1 && !AUTH_CODES.has(status) && (spec?.readOnly || isStaleQueryError(e))
				if (!retry) throw firstError
				logger?.debug?.({ op: name, id, err: e?.message }, 'newsletter mex: trying next candidate doc id')
			}
		}

		throw firstError
	}

	return { executeWMexQuery: executeWithFallback, preferred }
}
