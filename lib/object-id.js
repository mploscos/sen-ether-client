import { randomBytes } from 'node:crypto';
import { hashCombine } from './hash32.js';

/** Match SEN Object::senImplMakeId(): random UUID hash seed combined with the object name. */
export function makeObjectId(name) {
  const random = randomBytes(16);
  let hi = random.readBigUInt64LE(0);
  let lo = random.readBigUInt64LE(8);
  hi = (hi & 0xffffffffffff0fffn) | 0x4000n;
  lo = (lo & 0x3fffffffffffffffn) | 0x8000000000000000n;
  const uuidHash = hi ^ lo;
  const randomUuidHash = Number(BigInt.asUintN(32, uuidHash ^ (uuidHash >> 32n)));
  return hashCombine(randomUuidHash, String(name ?? '')) >>> 0;
}
