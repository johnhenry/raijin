/**
 * Data availability layer abstraction.
 *
 * Every DA backend implements DALayer. The commitment returned by submit()
 * is everything a verifier needs to retrieve and validate the data later.
 */

/** Commitment receipt returned after data is posted to a DA layer. */
export interface DACommitment {
  /** Identifies which DA layer produced this commitment (e.g. "local", "celestia", "eth-blobs") */
  layer: string
  /** Block height on the DA layer at which the data was included */
  height: bigint
  /** Index within that block (namespace slot, blob index, etc.) */
  index: number
  /** Content-addressable hash of the submitted data */
  hash: Uint8Array
}

/** Pluggable data availability backend. */
export interface DALayer {
  /** Human-readable identifier for this backend */
  readonly name: string

  /** Submit data to the DA layer and return a commitment. */
  submit(data: Uint8Array): Promise<DACommitment>

  /** Retrieve previously submitted data by its commitment. */
  retrieve(commitment: DACommitment): Promise<Uint8Array>

  /** Verify that a commitment is valid (hash matches stored data). */
  verify(commitment: DACommitment): Promise<boolean>
}
