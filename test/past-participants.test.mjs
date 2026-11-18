import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { proto } from '../WAProto/index.js'
import { hasPastParticipants, processPastParticipants } from '../lib/Utils/past-participants.js'

describe('processPastParticipants', () => {
	it('maps leave reasons and timestamps', () => {
		const result = processPastParticipants([
			{
				groupJid: '123@g.us',
				pastParticipants: [
					{ userJid: 'a@s.whatsapp.net', leaveReason: proto.PastParticipant.LeaveReason.LEFT, leaveTs: 100 },
					{ userJid: 'b@lid', leaveReason: proto.PastParticipant.LeaveReason.REMOVED, leaveTs: 200 },
					{ userJid: 'c@s.whatsapp.net' }
				]
			}
		])

		assert.deepEqual(result, [
			{
				groupJid: '123@g.us',
				participants: [
					{ jid: 'a@s.whatsapp.net', leaveTs: 100, leaveReason: 'left' },
					{ jid: 'b@lid', leaveTs: 200, leaveReason: 'removed' },
					{ jid: 'c@s.whatsapp.net', leaveTs: undefined, leaveReason: undefined }
				]
			}
		])
	})

	it('tolerates missing fields', () => {
		assert.deepEqual(processPastParticipants([{}]), [{ groupJid: '', participants: [] }])
		assert.deepEqual(processPastParticipants([]), [])
	})
})

describe('hasPastParticipants', () => {
	it('is true only for a non empty list', () => {
		assert.equal(hasPastParticipants({ pastParticipants: [{}] }), true)
		assert.equal(hasPastParticipants({ pastParticipants: [] }), false)
		assert.equal(hasPastParticipants({ pastParticipants: null }), false)
		assert.equal(hasPastParticipants({}), false)
	})
})
