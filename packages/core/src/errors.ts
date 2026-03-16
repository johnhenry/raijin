/**
 * Typed error hierarchy for Raijin.
 */

export class RaijinError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RaijinError'
  }
}

export class InvalidTransactionError extends RaijinError {
  constructor(reason: string) {
    super(`Invalid transaction: ${reason}`)
    this.name = 'InvalidTransactionError'
  }
}

export class InvalidBlockError extends RaijinError {
  constructor(reason: string) {
    super(`Invalid block: ${reason}`)
    this.name = 'InvalidBlockError'
  }
}

export class StateError extends RaijinError {
  constructor(reason: string) {
    super(`State error: ${reason}`)
    this.name = 'StateError'
  }
}

export class InsufficientBalanceError extends RaijinError {
  constructor(address: string, required: bigint, available: bigint) {
    super(`Insufficient balance for ${address}: need ${required}, have ${available}`)
    this.name = 'InsufficientBalanceError'
  }
}
