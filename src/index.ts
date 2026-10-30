import makeWASocket from './Socket/index'

export * from '../WAProto/index.js'
export * from './Store/index'
export * from './Types/index'
export * from './Defaults/index'
export * from './WABinary/index'
export { BinaryInfo } from './WAM/BinaryInfo'
export * from './WAUSync/index'
export * from './Cli/index'
export * from './Errors'
export * from './Utils'

export type WASocket = ReturnType<typeof makeWASocket>
export { makeWASocket }
export default makeWASocket
