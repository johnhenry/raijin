/**
 * @johnhenry/raijin-sdk — Developer-facing client API for the Raijin mesh rollup.
 *
 * Depends on @johnhenry/raijin-core for types and encoding.
 */

export { RaijinClient } from './client.js'
export type { ClientTransport } from './client.js'

export { Wallet } from './wallet.js'
export type { BuildTxOptions, GenerateOptions, ImportOptions } from './wallet.js'

// Wire codec (re-exported from core; consensus-typed helpers live in raijin-consensus).
export { encodeMessage, decodeMessage, WireFormatError } from '@johnhenry/raijin-core'
export type { WireValue } from '@johnhenry/raijin-core'
