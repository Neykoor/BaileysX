import { proto } from '../../WAProto/index.js'

export type ProcessedPastParticipant = {
	jid: string
	leaveTs: number | undefined
	leaveReason: 'left' | 'removed' | undefined
}

export type ProcessedPastParticipants = {
	groupJid: string
	participants: ProcessedPastParticipant[]
}

export const processPastParticipants = (
	pastParticipantsList: proto.IPastParticipants[]
): ProcessedPastParticipants[] =>
	pastParticipantsList.map(pp => ({
		groupJid: pp.groupJid ?? '',
		participants: (pp.pastParticipants ?? []).map(p => ({
			jid: p.userJid ?? '',
			leaveTs: p.leaveTs ? Number(p.leaveTs) : undefined,
			leaveReason:
				p.leaveReason === proto.PastParticipant.LeaveReason.LEFT
					? 'left'
					: p.leaveReason === proto.PastParticipant.LeaveReason.REMOVED
						? 'removed'
						: undefined
		}))
	}))

export const hasPastParticipants = (event: { pastParticipants?: unknown[] | null }): boolean =>
	Array.isArray(event.pastParticipants) && event.pastParticipants.length > 0
