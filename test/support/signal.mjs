import * as libsignal from 'libsignal'
import { makeLibSignalRepository } from '../../lib/Signal/libsignal.js'
import { Curve, generateSignalPubKey, signedKeyPair } from '../../lib/Utils/crypto.js'

export const KEY_BUNDLE_TYPE = Buffer.from([5])

export const prefixKey = value => (value.length === 33 ? Buffer.from(value) : Buffer.concat([KEY_BUNDLE_TYPE, value]))

const noop = () => {}
export const logger = {
	trace: noop,
	debug: noop,
	info: noop,
	warn: noop,
	error: noop,
	child: () => logger
}

export function createMemoryKeyStore() {
	const data = new Map()

	return {
		data,
		async get(type, ids) {
			const bucket = data.get(type) || {}
			const result = {}
			for (const id of ids) {
				if (Object.prototype.hasOwnProperty.call(bucket, id)) {
					result[id] = bucket[id]
				}
			}
			return result
		},
		async set(updates) {
			for (const [type, values] of Object.entries(updates)) {
				let bucket = data.get(type)
				if (!bucket) {
					bucket = {}
					data.set(type, bucket)
				}

				for (const [id, value] of Object.entries(values)) {
					if (value === null || value === undefined) {
						delete bucket[id]
					} else {
						bucket[id] = value
					}
				}
			}
		},
		isInTransaction: () => false,
		async transaction(work) {
			return work()
		},
		async clear() {
			data.clear()
		}
	}
}

export function makeIdentity() {
	const identity = Curve.generateKeyPair()
	const signedPreKey = signedKeyPair(identity, 1)
	return {
		identity,
		signedPreKey,
		creds: {
			signedIdentityKey: identity,
			signedPreKey,
			registrationId: libsignal.keyhelper.generateRegistrationId()
		}
	}
}

export function makeBundle(identity, preKey, preKeyId) {
	return {
		registrationId: identity.creds.registrationId,
		identityKey: prefixKey(identity.identity.public),
		signedPreKey: {
			keyId: identity.signedPreKey.keyId,
			publicKey: prefixKey(identity.signedPreKey.keyPair.public),
			signature: Buffer.from(identity.signedPreKey.signature)
		},
		preKey: {
			keyId: preKeyId,
			publicKey: prefixKey(preKey.public)
		}
	}
}

export async function makeRecipient({ preKeyId = 7 } = {}) {
	const identity = makeIdentity()
	const preKey = Curve.generateKeyPair()
	const keys = createMemoryKeyStore()
	await keys.set({
		'pre-key': {
			[String(preKeyId)]: {
				public: Buffer.from(preKey.public),
				private: Buffer.from(preKey.private)
			}
		}
	})
	return { identity, preKey, preKeyId, keys, repository: makeLibSignalRepository({ creds: identity.creds, keys }, logger) }
}

export function makeRepository(identity, keys) {
	return makeLibSignalRepository({ creds: identity.creds, keys }, logger)
}

export { libsignal, Curve, generateSignalPubKey, signedKeyPair }
