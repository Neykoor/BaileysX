export class FakePostgres {
	constructor() {
		this.tables = new Map()
		this.ended = false
	}

	table(name, kind) {
		let table = this.tables.get(name)
		if (!table) {
			table = { kind, rows: new Map() }
			this.tables.set(name, table)
		}
		return table
	}

	async query(sql, values = []) {
		const text = sql.replace(/\s+/g, ' ').trim()

		const create = text.match(/^CREATE TABLE IF NOT EXISTS ([a-zA-Z0-9_]+)/)
		if (create) {
			const name = create[1]
			const kind = text.includes('expires_at')
				? 'idempotency'
				: text.includes('status TEXT')
					? 'scheduled'
					: 'auth'
			this.table(name, kind)
			return { rows: [] }
		}

		if (text.startsWith('CREATE INDEX')) {
			return { rows: [] }
		}

		const insert = text.match(/^INSERT INTO ([a-zA-Z0-9_]+) \(([^)]+)\)/)
		if (insert) {
			const table = this.table(insert[1])
			const columns = insert[2].split(',').map(column => column.trim())
			if (columns.includes('expires_at')) {
				const key = values[0]
				if (table.rows.has(key)) {
					return { rows: [] }
				}
				table.rows.set(key, { key, expires_at: values[1] })
				return { rows: text.includes('RETURNING key') ? [{ key }] : [] }
			}

			if (columns.includes('status')) {
				table.rows.set(values[0], { id: values[0], status: values[1], value: values[2] })
				return { rows: [] }
			}

			table.rows.set(values[0], { key: values[0], value: values[1] })
			return { rows: [] }
		}

		const select = text.match(/^SELECT (.+) FROM ([a-zA-Z0-9_]+)(.*)$/)
		if (select) {
			const [, columns, tableName, rest] = select
			const table = this.table(tableName)
			let rows = Array.from(table.rows.values())
			if (rest.includes('WHERE key = $1')) {
				rows = rows.filter(row => row.key === values[0])
			} else if (rest.includes('WHERE key IN (')) {
				const keys = new Set(values)
				rows = rows.filter(row => keys.has(row.key))
			} else if (rest.includes('WHERE key LIKE $1')) {
				const prefix = String(values[0]).replace(/%$/, '').replace(/\\(.)/g, '$1')
				rows = rows.filter(row => row.key.startsWith(prefix))
			} else if (rest.includes("WHERE status = 'pending'")) {
				rows = rows.filter(row => row.status === 'pending')
			}

			if (columns === 'value') {
				return { rows: rows.map(row => ({ value: row.value })) }
			}

			return { rows: rows.map(row => ({ key: row.key, value: row.value })) }
		}

		const remove = text.match(/^DELETE FROM ([a-zA-Z0-9_]+)(.*)$/)
		if (remove) {
			const table = this.table(remove[1])
			const rest = remove[2]
			if (rest.includes('key LIKE $1')) {
				const prefix = String(values[0]).replace(/%$/, '').replace(/\\(.)/g, '$1')
				for (const key of Array.from(table.rows.keys())) {
					if (key.startsWith(prefix)) {
						table.rows.delete(key)
					}
				}
			} else if (rest.includes('expires_at <= $2')) {
				const row = table.rows.get(values[0])
				if (row && row.expires_at <= values[1]) {
					table.rows.delete(values[0])
				}
			} else if (rest.includes('id = $1')) {
				table.rows.delete(values[0])
			} else if (rest.includes('key = $1')) {
				table.rows.delete(values[0])
			}
			return { rows: [] }
		}

		throw new Error(`FakePostgres does not understand: ${text}`)
	}

	async end() {
		this.ended = true
	}
}
