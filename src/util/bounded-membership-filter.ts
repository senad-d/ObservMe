import { createHash } from "node:crypto";

const bitsPerExpectedEntry = 16;
const minimumByteLength = 128;
const hashFunctionCount = 4;

export class BoundedMembershipFilter {
  readonly #bits: Uint8Array;
  readonly #bitCount: number;

  constructor(expectedEntries: number) {
    assertValidExpectedEntries(expectedEntries);
    const byteLength = Math.max(minimumByteLength, Math.ceil((expectedEntries * bitsPerExpectedEntry) / 8));
    this.#bits = new Uint8Array(byteLength);
    this.#bitCount = byteLength * 8;
  }

  get byteLength(): number {
    return this.#bits.byteLength;
  }

  add(value: string): void {
    const digest = createHash("sha256").update(value).digest();
    for (let index = 0; index < hashFunctionCount; index += 1) this.setDigestBit(digest, index);
  }

  has(value: string): boolean {
    const digest = createHash("sha256").update(value).digest();
    for (let index = 0; index < hashFunctionCount; index += 1) {
      if (!this.hasDigestBit(digest, index)) return false;
    }
    return true;
  }

  clear(): void {
    this.#bits.fill(0);
  }

  private setDigestBit(digest: Buffer, hashIndex: number): void {
    const bitIndex = this.digestBitIndex(digest, hashIndex);
    this.#bits[Math.floor(bitIndex / 8)] |= 1 << (bitIndex % 8);
  }

  private hasDigestBit(digest: Buffer, hashIndex: number): boolean {
    const bitIndex = this.digestBitIndex(digest, hashIndex);
    return (this.#bits[Math.floor(bitIndex / 8)] & (1 << (bitIndex % 8))) !== 0;
  }

  private digestBitIndex(digest: Buffer, hashIndex: number): number {
    return digest.readUInt32BE(hashIndex * Uint32Array.BYTES_PER_ELEMENT) % this.#bitCount;
  }
}

export function assertValidExpectedEntries(expectedEntries: number): void {
  if (!Number.isInteger(expectedEntries) || expectedEntries < 1) {
    throw new Error("BoundedMembershipFilter expectedEntries must be a positive integer");
  }
}
