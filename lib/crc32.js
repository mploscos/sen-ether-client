const table = new Uint32Array(256);

for (let i = 0; i < table.length; i += 1) {
  let value = i;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? ((value >>> 1) ^ 0xedb88320) : (value >>> 1);
  }
  table[i] = value >>> 0;
}

/**
 * CRC32 compatible with sen::crc32 from sen/core/base/hash32.h.
 *
 * @param {string | Buffer | Uint8Array} input
 * @returns {number}
 */
export function crc32(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let checksum = 0xffffffff;

  for (const byte of bytes) {
    checksum = table[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
  }

  return (~checksum) >>> 0;
}
