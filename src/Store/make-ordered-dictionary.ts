export type OrderedDictionary<T> = {
	array: T[]
	get: (id: string) => T | undefined
	upsert: (item: T, mode: 'append' | 'prepend') => void
	update: (item: T) => boolean
	remove: (item: T) => boolean
	updateAssign: (id: string, update: Partial<T>) => boolean
	clear: () => void
	filter: (contain: (item: T) => boolean) => void
	toJSON: () => T[]
	fromJSON: (newItems: T[]) => void
}

export function makeOrderedDictionary<T>(idGetter: (item: T) => string): OrderedDictionary<T> {
	const array: T[] = []
	const dict: { [id: string]: T } = {}

	const get = (id: string) => dict[id]

	const indexOfId = (id: string) => {
		for (let i = array.length - 1; i >= 0; i--) {
			if (idGetter(array[i] as T) === id) {
				return i
			}
		}

		return -1
	}

	const update = (item: T) => {
		const id = idGetter(item)
		const idx = indexOfId(id)
		if (idx >= 0) {
			array[idx] = item
			dict[id] = item
			return true
		}

		return false
	}

	const upsert = (item: T, mode: 'append' | 'prepend') => {
		const id = idGetter(item)
		if (get(id)) {
			update(item)
		} else {
			if (mode === 'append') {
				array.push(item)
			} else {
				array.splice(0, 0, item)
			}

			dict[id] = item
		}
	}

	const remove = (item: T) => {
		const id = idGetter(item)
		const idx = indexOfId(id)
		if (idx >= 0) {
			array.splice(idx, 1)
			delete dict[id]
			return true
		}

		return false
	}

	return {
		array,
		get,
		upsert,
		update,
		remove,
		updateAssign: (id: string, update: Partial<T>) => {
			const item = get(id)
			if (item) {
				Object.assign(item, update)
				delete dict[id]
				dict[idGetter(item)] = item
				return true
			}

			return false
		},
		clear: () => {
			array.splice(0, array.length)
			for (const key of Object.keys(dict)) {
				delete dict[key]
			}
		},
		filter: (contain: (item: T) => boolean) => {
			let read = 0
			let write = 0
			try {
				for (; read < array.length; read++) {
					const item = array[read] as T
					if (contain(item)) {
						array[write++] = item
					} else {
						delete dict[idGetter(item)]
					}
				}
			} finally {
				while (read < array.length) {
					array[write++] = array[read++] as T
				}

				array.length = write
			}
		},
		toJSON: () => array,
		fromJSON: (newItems: T[]) => {
			const items = newItems === array ? newItems.slice() : newItems
			array.length = 0
			for (const key of Object.keys(dict)) {
				delete dict[key]
			}

			for (const item of items) {
				array.push(item)
				dict[idGetter(item)] = item
			}
		}
	}
}
