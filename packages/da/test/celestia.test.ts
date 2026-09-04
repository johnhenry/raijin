import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { CelestiaDA } from '../src/celestia.js'
import { hash, equal } from '@johnhenry/raijin-core'

const encoder = new TextEncoder()

function base64Encode(data: Uint8Array): string {
  return Buffer.from(data).toString('base64')
}

/** Build a minimal `Response`-like object for the mocked fetch. */
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

describe('CelestiaDA', () => {
  const originalFetch = globalThis.fetch
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('has name "celestia"', () => {
    const da = new CelestiaDA({ namespace: 'ns1' })
    expect(da.name).toBe('celestia')
  })

  it('submit posts to /submit_pfb and returns a commitment matching the data hash', async () => {
    const da = new CelestiaDA({ endpoint: 'http://localhost:26658', namespace: 'ns1' })
    fetchMock.mockResolvedValueOnce(jsonResponse({ height: 42, txhash: '0xdeadbeef' }))

    const data = encoder.encode('hello celestia')
    const commitment = await da.submit(data)

    expect(commitment.layer).toBe('celestia')
    expect(commitment.height).toBe(42n)
    expect(equal(commitment.hash, await hash(data))).toBe(true)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:26658/submit_pfb')
    expect(init.method).toBe('POST')
  })

  it('includes the auth token header when configured', async () => {
    const da = new CelestiaDA({ namespace: 'ns1', authToken: 'secret-token' })
    fetchMock.mockResolvedValueOnce(jsonResponse({ height: 1, txhash: '0x00' }))

    await da.submit(encoder.encode('x'))

    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers.Authorization).toBe('Bearer secret-token')
  })

  it('retrieve finds the blob matching the commitment hash among several returned blobs', async () => {
    const da = new CelestiaDA({ namespace: 'ns1' })
    const wanted = encoder.encode('the real data')
    const other = encoder.encode('unrelated blob')

    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [base64Encode(other), base64Encode(wanted)] }))

    const commitment = { layer: 'celestia', height: 7n, index: 0, hash: await hash(wanted) }
    const retrieved = await da.retrieve(commitment)

    expect(equal(retrieved, wanted)).toBe(true)
  })

  it('retrieve throws when no blob matches the commitment hash', async () => {
    const da = new CelestiaDA({ namespace: 'ns1' })
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [base64Encode(encoder.encode('nope'))] }))

    const commitment = { layer: 'celestia', height: 7n, index: 0, hash: await hash(encoder.encode('missing')) }
    await expect(da.retrieve(commitment)).rejects.toThrow('no blob matching hash')
  })

  it('verify returns true when the commitment round-trips through retrieve', async () => {
    const da = new CelestiaDA({ namespace: 'ns1' })
    const data = encoder.encode('verify me')
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [base64Encode(data)] }))

    const commitment = { layer: 'celestia', height: 3n, index: 0, hash: await hash(data) }
    expect(await da.verify(commitment)).toBe(true)
  })

  it('verify returns false when retrieval fails (e.g. node error, no matching blob)', async () => {
    const da = new CelestiaDA({ namespace: 'ns1' })
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'not found' }, false, 404))

    const commitment = { layer: 'celestia', height: 3n, index: 0, hash: new Uint8Array(32) }
    expect(await da.verify(commitment)).toBe(false)
  })
  // Regression: uint8ToBase64 spread the whole blob into String.fromCharCode,
  // one argument per byte, and threw RangeError between 64 KiB and 128 KiB --
  // exactly the sizes a DA layer carries. See issue #22.
  it('submit encodes a 1 MiB blob without overflowing the stack', async () => {
    const da = new CelestiaDA({ endpoint: 'http://localhost:26658', namespace: 'ns1' })
    fetchMock.mockResolvedValue(jsonResponse({ height: 7, txhash: 'abc' }))

    const big = new Uint8Array(1024 * 1024)
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff

    const commitment = await da.submit(big)
    expect(commitment.height).toBe(7n)
    expect(equal(commitment.hash, await hash(big))).toBe(true)

    // The blob round-trips through base64 byte-for-byte.
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(Buffer.from(body.data, 'base64').equals(Buffer.from(big))).toBe(true)
  })
})
