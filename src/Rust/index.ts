import { rustCodec } from './codec'

export { isRustAreaEnabled } from './bridge'
export { createRustCodec, materializeNode, rustCodec, sameNode, toBridgeNode } from './codec'
export type { CodecReference, RustCodec, RustCodecOptions, RustCodecState, RustCodecStatus } from './codec'

export const describeRust = () => ({ codec: rustCodec.status() })
