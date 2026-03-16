/**
 * Seeded xorshift128+ PRNG for reproducible fault schedules.
 */
export class SeededPRNG {
  #s0: bigint
  #s1: bigint

  constructor(seed: number) {
    let s = BigInt(seed) & 0xFFFFFFFFFFFFFFFFn
    s = (s ^ (s >> 30n)) * 0xBF58476D1CE4E5B9n & 0xFFFFFFFFFFFFFFFFn
    this.#s0 = (s ^ (s >> 27n)) * 0x94D049BB133111EBn & 0xFFFFFFFFFFFFFFFFn
    s = (this.#s0 ^ (this.#s0 >> 30n)) * 0xBF58476D1CE4E5B9n & 0xFFFFFFFFFFFFFFFFn
    this.#s1 = (s ^ (s >> 27n)) * 0x94D049BB133111EBn & 0xFFFFFFFFFFFFFFFFn
    if (this.#s0 === 0n && this.#s1 === 0n) this.#s1 = 1n
  }

  /** Returns a float in [0, 1) */
  next(): number {
    let s1 = this.#s0
    const s0 = this.#s1
    this.#s0 = s0
    s1 ^= (s1 << 23n) & 0xFFFFFFFFFFFFFFFFn
    s1 ^= s1 >> 17n
    s1 ^= s0
    s1 ^= s0 >> 26n
    this.#s1 = s1 & 0xFFFFFFFFFFFFFFFFn
    const result = ((this.#s0 + this.#s1) & 0xFFFFFFFFFFFFFFFFn)
    return Number(result & 0x1FFFFFFFFFFFFFn) / 0x20000000000000
  }

  /** Returns an integer in [0, max) */
  nextInt(max: number): number {
    return Math.floor(this.next() * max)
  }

  /** Returns true with given probability */
  nextBool(probability: number): boolean {
    return this.next() < probability
  }

  /** Pick a random element from an array */
  pick<T>(arr: T[]): T {
    return arr[this.nextInt(arr.length)]
  }
}
