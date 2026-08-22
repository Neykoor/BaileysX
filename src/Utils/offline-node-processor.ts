import type { BinaryNode } from '../WABinary'

export type MessageType = 'message' | 'call' | 'receipt' | 'notification'

type OfflineNode = {
	type: MessageType
	node: BinaryNode
}

export type OfflineNodeProcessorDeps = {
	isWsOpen: () => boolean
	onUnexpectedError: (error: Error, msg: string) => void
	yieldToEventLoop: () => Promise<void>
}

export function makeOfflineNodeProcessor(
	nodeProcessorMap: Map<MessageType, (node: BinaryNode) => Promise<void>>,
	deps: OfflineNodeProcessorDeps,
	batchSize = 10
) {
	const nodes: OfflineNode[] = []
	let head = 0
	let isProcessing = false

	const dequeue = (): OfflineNode | undefined => {
		if (head >= nodes.length) {
			return undefined
		}

		const item = nodes[head]
		nodes[head] = undefined as unknown as OfflineNode
		head++

		// compact once the consumed prefix is at least half the array, so we
		// don't keep an ever-growing array of empty slots for large offline backlogs
		if (head > 64 && head * 2 >= nodes.length) {
			nodes.splice(0, head)
			head = 0
		}

		return item
	}

	const pending = () => nodes.length - head

	const runLoop = () => {
		if (isProcessing) {
			return
		}

		if (!pending() || !deps.isWsOpen()) {
			return
		}

		isProcessing = true

		const promise = async () => {
			let processedInBatch = 0

			while (pending() && deps.isWsOpen()) {
				const { type, node } = dequeue()!

				const nodeProcessor = nodeProcessorMap.get(type)

				if (!nodeProcessor) {
					deps.onUnexpectedError(new Error(`unknown offline node type: ${type}`), 'processing offline node')
					continue
				}

				await nodeProcessor(node).catch(err => deps.onUnexpectedError(err, `processing offline ${type}`))
				processedInBatch++

				if (processedInBatch >= batchSize) {
					processedInBatch = 0
					await deps.yieldToEventLoop()
				}
			}

			isProcessing = false

			if (pending() && deps.isWsOpen()) {
				runLoop()
			}
		}

		promise().catch(error => {
			isProcessing = false
			deps.onUnexpectedError(error, 'processing offline nodes')
		})
	}

	const enqueue = (type: MessageType, node: BinaryNode) => {
		nodes.push({ type, node })
		runLoop()
	}

	const resume = () => {
		runLoop()
	}

	return { enqueue, resume }
}
