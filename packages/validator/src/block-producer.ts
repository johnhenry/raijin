/**
 * Block producer: pulls transactions from the mempool, builds blocks,
 * and proposes them via consensus.
 */

import type { Block, Transaction } from 'raijin-core'
import { hash, merkleRoot, encodeTxSigned } from 'raijin-core'
import type { PBFTConsensus } from 'raijin-consensus'
import type { Mempool } from './mempool.js'

export interface BlockProducerConfig {
  /** This validator's public key (32 bytes). */
  proposer: Uint8Array
  /** The consensus engine to propose blocks through. */
  consensus: PBFTConsensus
  /** The transaction mempool. */
  mempool: Mempool
  /** Maximum transactions per block. Default: 100. */
  maxTxPerBlock?: number
}

export class BlockProducer {
  #proposer: Uint8Array
  #consensus: PBFTConsensus
  #mempool: Mempool
  #maxTxPerBlock: number
  #nextBlockNumber = 1n
  #parentHash = new Uint8Array(32)

  constructor(config: BlockProducerConfig) {
    this.#proposer = config.proposer
    this.#consensus = config.consensus
    this.#mempool = config.mempool
    this.#maxTxPerBlock = config.maxTxPerBlock ?? 100
  }

  /** Build a block from pending mempool transactions and propose it. */
  async produceBlock(): Promise<Block | null> {
    if (!this.#consensus.isLeader) return null

    const txs = this.#mempool.pending(this.#maxTxPerBlock)
    if (txs.length === 0) return null

    const block = await this.#buildBlock(txs)
    await this.#consensus.propose(block)
    return block
  }

  /** Update state after a block is finalized. */
  advance(block: Block): void {
    this.#nextBlockNumber = block.header.number + 1n
    // Use a hash of the block number as parent hash (simplified)
    // In production, this would be the actual block hash
    this.#parentHash = new Uint8Array(block.header.stateRoot)
  }

  /** Current next block number. */
  get nextBlockNumber(): bigint {
    return this.#nextBlockNumber
  }

  async #buildBlock(txs: Transaction[]): Promise<Block> {
    // Compute tx root from transaction hashes
    const txHashes: Uint8Array[] = []
    for (const tx of txs) {
      txHashes.push(await hash(encodeTxSigned(tx)))
    }
    const txRoot = await merkleRoot(txHashes)

    const block: Block = {
      header: {
        number: this.#nextBlockNumber,
        parentHash: this.#parentHash,
        stateRoot: new Uint8Array(32), // filled after execution
        txRoot,
        receiptRoot: new Uint8Array(32), // filled after execution
        timestamp: Date.now(),
        proposer: this.#proposer,
      },
      transactions: txs,
      signatures: [],
    }

    return block
  }
}
