import { deriveSecrets } from 'libsignal/lib/crypto.js'

export class SenderMessageKey {
	private readonly iteration: number
	private readonly seed: Uint8Array
	private iv: Uint8Array | undefined
	private cipherKey: Uint8Array | undefined

	constructor(iteration: number, seed: Uint8Array) {
		this.iteration = iteration
		this.seed = Buffer.from(seed)
	}

	private derive(): void {
		if (this.iv && this.cipherKey) {
			return
		}

		const derivative = deriveSecrets(Buffer.from(this.seed), Buffer.alloc(32), Buffer.from('WhisperGroup'))
		const first = derivative[0]
		const second = derivative[1]
		if (!first || !second) {
			throw new Error('Failed to derive sender message key secrets')
		}

		const keys = new Uint8Array(32)
		keys.set(new Uint8Array(first.slice(16)))
		keys.set(new Uint8Array(second.slice(0, 16)), 16)

		this.iv = Buffer.from(first.slice(0, 16))
		this.cipherKey = Buffer.from(keys.buffer)
	}

	public getIteration(): number {
		return this.iteration
	}

	public getIv(): Uint8Array {
		this.derive()
		return this.iv as Uint8Array
	}

	public getCipherKey(): Uint8Array {
		this.derive()
		return this.cipherKey as Uint8Array
	}

	public getSeed(): Uint8Array {
		return this.seed
	}
}
