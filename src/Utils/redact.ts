export const redactSensitive = (obj: unknown): unknown => {
	const SENSITIVE = ['keys', 'creds', 'auth', 'session', 'token', 'passphrase', 'privateKey', 'signingKey']
	const seen = new WeakSet()

	const walk = (v: any): any => {
		if (v === null || typeof v !== 'object') return v
		if (Buffer.isBuffer(v) || v instanceof Uint8Array) return '[REDACTED]'
		if (seen.has(v)) return '[CIRCULAR]'
		seen.add(v)
		if (Array.isArray(v)) return v.map(walk)
		const out: any = {}
		for (const k of Object.keys(v)) {
			const lk = k.toLowerCase()
			if (SENSITIVE.some(s => lk.includes(s.toLowerCase()))) {
				out[k] = '[REDACTED]'
			} else {
				out[k] = walk((v as any)[k])
			}
		}
		return out
	}

	return walk(obj)
}
