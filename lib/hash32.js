export const HASH_SEED = 23835769;
export const PROPERTY_HASH_SEED = 19830715;
export const METHOD_HASH_SEED = 93580253;
export const EVENT_HASH_SEED = 12125807;

const FNV1A_OFFSET_BASIS = 0x811c9dc5;
const FNV1A_PRIME = 0x01000193;
const HASH_COMBINE_MAGIC = 0x9e3779b9;

export function fnv1aString(value) {
  let hash = FNV1A_OFFSET_BASIS;
  for (const byte of Buffer.from(String(value))) {
    hash ^= byte;
    hash = Math.imul(hash, FNV1A_PRIME) >>> 0;
  }
  return hash >>> 0;
}

export function hashCombine(seed, ...values) {
  let result = seed >>> 0;
  for (const value of values) {
    const hashed = typeof value === 'number' ? value >>> 0 : fnv1aString(value);
    result = (result ^ (
      (hashed + HASH_COMBINE_MAGIC + ((result << 6) >>> 0) + (result >>> 2)) >>> 0
    )) >>> 0;
  }
  return result >>> 0;
}

export function propertyHash(name) {
  return hashCombine(PROPERTY_HASH_SEED, name);
}

export function methodHash(name) {
  return hashCombine(METHOD_HASH_SEED, name);
}

export function eventHash(name) {
  return hashCombine(EVENT_HASH_SEED, name);
}
