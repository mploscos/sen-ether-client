/** Transport compatibility profiles for released SEN protocol families. */

const SEN_06_MULTICAST_RANGE = Object.freeze([
  Object.freeze({ min: 224, max: 239 }),
  Object.freeze({ min: 0, max: 255 }),
  Object.freeze({ min: 0, max: 255 }),
  Object.freeze({ min: 0, max: 255 })
]);

const SEN_07_MULTICAST_RANGE = Object.freeze([
  Object.freeze({ min: 239, max: 239 }),
  Object.freeze({ min: 0, max: 255 }),
  Object.freeze({ min: 0, max: 255 }),
  Object.freeze({ min: 0, max: 255 })
]);

const SEN_07_MULTICAST_EXCLUSIONS = Object.freeze([
  Object.freeze({ min: '239.0.0.0', max: '239.0.255.255' }),
  Object.freeze({ min: '239.128.0.0', max: '239.128.255.255' }),
  Object.freeze({ min: '239.195.255.0', max: '239.195.255.255' }),
  Object.freeze({ min: '239.255.0.0', max: '239.255.0.255' }),
  Object.freeze({ min: '239.255.255.0', max: '239.255.255.255' })
]);

export const SEN_PROTOCOL_PROFILES = Object.freeze({
  legacy: Object.freeze({
    name: 'legacy',
    kernelProtocolVersion: 9,
    etherProtocolVersion: 2,
    tcpDiscoveryFraming: 'fixed-508',
    busMulticastAllocation: 'legacy-hash-bytes',
    busMulticastRange: SEN_06_MULTICAST_RANGE,
    busMulticastExclusions: Object.freeze([])
  }),
  enhanced: Object.freeze({
    name: 'enhanced',
    kernelProtocolVersion: 11,
    etherProtocolVersion: 2,
    tcpDiscoveryFraming: 'length-prefixed',
    busMulticastAllocation: 'usable-address-index',
    busMulticastRange: SEN_07_MULTICAST_RANGE,
    busMulticastExclusions: SEN_07_MULTICAST_EXCLUSIONS
  })
});

/** Resolve a public protocol profile. */
export function resolveProtocolProfile(value = 'legacy') {
  const name = String(value).trim().toLowerCase();
  const profile = SEN_PROTOCOL_PROFILES[name];
  if (!profile) {
    throw new TypeError(
      `unsupported SEN protocol profile "${value}"; expected "legacy" or "enhanced"`
    );
  }
  return profile;
}

