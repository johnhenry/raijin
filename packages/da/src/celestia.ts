/**
 * CelestiaDA — data availability client for a Celestia light node.
 *
 * Talks to the Celestia Node REST API (default: http://localhost:26658).
 * Requires a running light node. Does NOT embed a Celestia node.
 *
 * API reference: https://docs.celestia.org/developers/node-api
 */

import { hash, equal, toHex, fromHex } from 'raijin-core'
import type { DALayer, DACommitment } from './types.js'

export interface CelestiaDAOptions {
  /** Base URL for the Celestia light node API. Default: http://localhost:26658 */
  endpoint?: string
  /** Auth token for the node API (required by most Celestia nodes). */
  authToken?: string
  /** Namespace ID (8 bytes hex). Data is posted to this namespace. */
  namespace: string
}

export class CelestiaDA implements DALayer {
  readonly name = 'celestia'

  readonly #endpoint: string
  readonly #authToken: string | undefined
  readonly #namespace: string

  constructor(options: CelestiaDAOptions) {
    this.#endpoint = (options.endpoint ?? 'http://localhost:26658').replace(/\/$/, '')
    this.#authToken = options.authToken
    this.#namespace = options.namespace
  }

  async submit(data: Uint8Array): Promise<DACommitment> {
    const h = await hash(data)
    const payload = {
      namespace_id: this.#namespace,
      data: uint8ToBase64(data),
      gas_limit: 80000,
      fee: 2000,
    }

    const res = await fetch(`${this.#endpoint}/submit_pfb`, {
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify(payload),
    })

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`CelestiaDA submit failed (${res.status}): ${body}`)
    }

    const result = await res.json() as { height: number; txhash: string }

    return {
      layer: this.name,
      height: BigInt(result.height),
      index: 0, // Celestia returns the blob index in share commits; simplified here
      hash: h,
    }
  }

  async retrieve(commitment: DACommitment): Promise<Uint8Array> {
    const height = commitment.height.toString()
    const res = await fetch(
      `${this.#endpoint}/namespaced_data/${this.#namespace}/height/${height}`,
      { headers: this.#headers() },
    )

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`CelestiaDA retrieve failed (${res.status}): ${body}`)
    }

    const result = await res.json() as { data: string[] }

    if (!result.data || result.data.length === 0) {
      throw new Error(`CelestiaDA: no data at height ${height} in namespace ${this.#namespace}`)
    }

    // Find the blob matching our commitment hash
    for (const blob of result.data) {
      const bytes = base64ToUint8(blob)
      const blobHash = await hash(bytes)
      if (equal(blobHash, commitment.hash)) {
        return bytes
      }
    }

    throw new Error(`CelestiaDA: no blob matching hash ${toHex(commitment.hash)} at height ${height}`)
  }

  async verify(commitment: DACommitment): Promise<boolean> {
    try {
      const data = await this.retrieve(commitment)
      const computed = await hash(data)
      return equal(computed, commitment.hash)
    } catch {
      return false
    }
  }

  #headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.#authToken) {
      h['Authorization'] = `Bearer ${this.#authToken}`
    }
    return h
  }
}

// ── Base64 helpers ─────────────────────────────────────────────────────

function uint8ToBase64(data: Uint8Array): string {
  // Works in both browser (btoa) and Node (Buffer)
  if (typeof btoa === 'function') {
    return btoa(String.fromCharCode(...data))
  }
  return Buffer.from(data).toString('base64')
}

function base64ToUint8(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i)
    }
    return bytes
  }
  return new Uint8Array(Buffer.from(b64, 'base64'))
}
