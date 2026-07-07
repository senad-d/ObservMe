export interface BoundedMapEviction<K, V> {
  readonly key: K;
  readonly value: V;
  readonly reason: "max_size_exceeded";
}

export interface BoundedMapOptions<K, V> {
  readonly maxSize: number;
  readonly onEvict?: (eviction: BoundedMapEviction<K, V>) => void;
  readonly entries?: Iterable<readonly [K, V]>;
}

export class BoundedMap<K, V> implements Iterable<[K, V]> {
  readonly #maxSize: number;
  readonly #entries = new Map<K, V>();
  readonly #onEvict?: (eviction: BoundedMapEviction<K, V>) => void;

  constructor(options: BoundedMapOptions<K, V>) {
    assertValidMaxSize(options.maxSize);
    this.#maxSize = options.maxSize;
    this.#onEvict = options.onEvict;

    if (options.entries) this.setMany(options.entries);
  }

  get maxSize(): number {
    return this.#maxSize;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: K): V | undefined {
    return this.#entries.get(key);
  }

  has(key: K): boolean {
    return this.#entries.has(key);
  }

  set(key: K, value: V): this {
    this.#entries.set(key, value);
    this.evictOldestEntriesOverLimit();
    return this;
  }

  setMany(entries: Iterable<readonly [K, V]>): this {
    for (const [key, value] of entries) this.set(key, value);
    return this;
  }

  delete(key: K): boolean {
    return this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  keys(): MapIterator<K> {
    return this.#entries.keys();
  }

  values(): MapIterator<V> {
    return this.#entries.values();
  }

  entries(): MapIterator<[K, V]> {
    return this.#entries.entries();
  }

  toMap(): Map<K, V> {
    return new Map(this.#entries);
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }

  private evictOldestEntriesOverLimit(): void {
    while (this.#entries.size > this.#maxSize) this.evictOldestEntry();
  }

  private evictOldestEntry(): void {
    const oldestEntry = this.#entries.entries().next().value;
    if (!oldestEntry) return;

    const [key, value] = oldestEntry;
    this.#entries.delete(key);
    this.#onEvict?.({ key, value, reason: "max_size_exceeded" });
  }
}

export function assertValidMaxSize(maxSize: number): void {
  if (!Number.isInteger(maxSize) || maxSize < 1) throw new Error("BoundedMap maxSize must be a positive integer");
}
