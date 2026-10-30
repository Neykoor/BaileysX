import { join } from 'node:path'
import type { UserFacingSocketConfig } from '../Types'
import type { AnyMessageContent, MiscMessageGenerationOptions } from '../Types/Message'
import type { AuditLog } from './audit-log'
import { TokenBucket } from './rate-limiter'
import {
	makeSessionManager,
	type SessionEntry,
	type SessionManager,
	type SessionManagerHealth,
	type SessionManagerOptions
} from './session-manager'

export type TenantLimits = {
	maxSessions?: number
	maxMessagesPerMinute?: number
}

export type TenantManagerOptions = Omit<SessionManagerOptions, 'baseAuthDir'> & {
	baseAuthDir: string
	limits?: TenantLimits | ((tenantId: string) => TenantLimits)
	audit?: AuditLog
	sessionManagerFactory?: (opts: SessionManagerOptions) => SessionManager
	now?: () => number
}

export type TenantInfo = {
	tenantId: string
	sessions: string[]
}

export type TenantManagerHealth = {
	tenants: Record<string, SessionManagerHealth>
	totalSessions: number
}

const SAFE_TENANT_ID = /^[a-zA-Z0-9_-]+$/

const assertTenantId = (tenantId: string): void => {
	if (!tenantId || !SAFE_TENANT_ID.test(tenantId)) {
		throw new Error(
			`invalid tenant id "${tenantId}": only alphanumeric characters, "-" and "_" are allowed`
		)
	}
}

/**
 * Multi-tenant wrapper around `makeSessionManager`. Each tenant gets an
 * isolated auth directory, its own session limit and an optional outgoing
 * message quota.
 */
export const makeTenantManager = (opts: TenantManagerOptions) => {
	const {
		baseAuthDir,
		limits,
		audit,
		sessionManagerFactory = makeSessionManager,
		now = Date.now,
		...sessionOptions
	} = opts
	const managers = new Map<string, SessionManager>()
	const quotas = new Map<string, TokenBucket>()

	const limitsFor = (tenantId: string): TenantLimits =>
		typeof limits === 'function' ? limits(tenantId) : (limits ?? {})

	const getManager = (tenantId: string): SessionManager => {
		assertTenantId(tenantId)
		let manager = managers.get(tenantId)
		if (!manager) {
			manager = sessionManagerFactory({
				...sessionOptions,
				baseAuthDir: join(baseAuthDir, tenantId)
			})
			managers.set(tenantId, manager)
		}

		return manager
	}

	const quotaFor = (tenantId: string): TokenBucket | undefined => {
		const max = limitsFor(tenantId).maxMessagesPerMinute
		if (max === undefined) {
			return undefined
		}

		if (!Number.isFinite(max) || max <= 0) {
			throw new Error(`invalid maxMessagesPerMinute for tenant "${tenantId}"`)
		}

		let bucket = quotas.get(tenantId)
		if (!bucket) {
			bucket = new TokenBucket({
				capacity: Math.max(1, Math.floor(max)),
				refillTokens: 1,
				refillIntervalMs: Math.max(1, Math.floor(60_000 / max)),
				now
			})
			quotas.set(tenantId, bucket)
		}

		return bucket
	}

	const start = async (
		tenantId: string,
		sessionId: string,
		overrideConfig?: Omit<Partial<UserFacingSocketConfig>, 'auth'>
	): Promise<SessionEntry> => {
		const manager = getManager(tenantId)
		const maxSessions = limitsFor(tenantId).maxSessions
		if (maxSessions !== undefined && manager.list().length >= maxSessions) {
			const error = new Error(`tenant "${tenantId}" reached its session limit (${maxSessions})`)
			await audit?.record({
				action: 'session.start',
				tenantId,
				sessionId,
				outcome: 'failure',
				metadata: { error: error.message }
			})
			throw error
		}

		try {
			const entry = await manager.start(sessionId, overrideConfig)
			await audit?.record({ action: 'session.start', tenantId, sessionId, outcome: 'success' })
			return entry
		} catch (error) {
			await audit?.record({
				action: 'session.start',
				tenantId,
				sessionId,
				outcome: 'failure',
				metadata: { error: error instanceof Error ? error.message : String(error) }
			})
			throw error
		}
	}

	const stop = async (tenantId: string, sessionId: string): Promise<void> => {
		const manager = managers.get(tenantId)
		if (!manager) {
			return
		}

		try {
			await manager.stop(sessionId)
			await audit?.record({ action: 'session.stop', tenantId, sessionId, outcome: 'success' })
		} catch (error) {
			await audit?.record({
				action: 'session.stop',
				tenantId,
				sessionId,
				outcome: 'failure',
				metadata: { error: error instanceof Error ? error.message : String(error) }
			})
			throw error
		}
	}

	const stopAll = async (tenantId?: string): Promise<void> => {
		if (tenantId) {
			const manager = managers.get(tenantId)
			if (manager) {
				await manager.stopAll()
				managers.delete(tenantId)
				quotas.delete(tenantId)
			}
			return
		}

		await Promise.all(
			Array.from(managers.entries()).map(async ([id, manager]) => {
				await manager.stopAll()
				managers.delete(id)
				quotas.delete(id)
			})
		)
	}

	const sendMessage = async (
		tenantId: string,
		sessionId: string,
		jid: string,
		content: AnyMessageContent,
		options?: MiscMessageGenerationOptions
	): Promise<unknown> => {
		const manager = getManager(tenantId)
		const entry = manager.get(sessionId)
		if (!entry) {
			throw new Error(`session "${sessionId}" is not running for tenant "${tenantId}"`)
		}

		const quota = quotaFor(tenantId)
		if (quota) {
			await quota.acquire()
		}

		try {
			const result = await entry.sock.sendMessage(jid, content, options)
			await audit?.record({
				action: 'message.send',
				tenantId,
				sessionId,
				outcome: 'success',
				metadata: { jid }
			})
			return result
		} catch (error) {
			await audit?.record({
				action: 'message.send',
				tenantId,
				sessionId,
				outcome: 'failure',
				metadata: { jid, error: error instanceof Error ? error.message : String(error) }
			})
			throw error
		}
	}

	const list = (tenantId?: string): TenantInfo[] => {
		if (tenantId) {
			const manager = managers.get(tenantId)
			return manager ? [{ tenantId, sessions: manager.list() }] : []
		}

		return Array.from(managers.entries()).map(([id, manager]) => ({
			tenantId: id,
			sessions: manager.list()
		}))
	}

	const getHealth = (tenantId?: string): TenantManagerHealth => {
		const entries = tenantId
			? managers.has(tenantId)
				? [[tenantId, managers.get(tenantId)!] as const]
				: []
			: Array.from(managers.entries())
		const tenants: Record<string, SessionManagerHealth> = {}
		let totalSessions = 0
		for (const [id, manager] of entries) {
			const health = manager.getHealth()
			tenants[id] = health
			totalSessions += health.total
		}

		return { tenants, totalSessions }
	}

	const getQuota = (tenantId: string) => {
		const bucket = quotas.get(tenantId)
		return bucket ? { available: bucket.available } : undefined
	}

	return {
		start,
		stop,
		stopAll,
		sendMessage,
		list,
		getHealth,
		getQuota,
		getManager
	}
}

export type TenantManager = ReturnType<typeof makeTenantManager>
