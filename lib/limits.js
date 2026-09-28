export const DEFAULT_RESOURCE_LIMITS = Object.freeze({
  maxFrameSize: 16 * 1024 * 1024,
  maxReceiveBufferSize: 16 * 1024 * 1024 + 5,
  maxStringBytes: 1024 * 1024,
  maxBufferBytes: 16 * 1024 * 1024,
  maxSequenceLength: 100_000,
  maxDiscoveredProcesses: 4096,
  maxConnections: 128,
  maxInterestsPerBus: 4096,
  maxRemoteInterestsPerBus: 4096,
  maxPendingRequestsPerBus: 65_536,
  maxForwardedObjectRoutesPerBus: 100_000,
  maxPendingTransitCallsPerBus: 16_384,
  maxRemoteParticipantsPerBus: 4096,
  maxPendingStatesPerObject: 64,
  maxPendingMethodCallsPerBus: 16_384
});

function positiveInteger(value, fallback, name) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new RangeError(`SEN resource limit ${name} must be a positive safe integer`);
  }
  return number;
}

/** Normalize public resource-limit options and reject internally inconsistent values. */
export function normalizeResourceLimits(options = {}) {
  const input = options.resourceLimits ?? options.limits ?? options;
  const limits = Object.fromEntries(Object.entries(DEFAULT_RESOURCE_LIMITS).map(([name, fallback]) => [
    name,
    positiveInteger(input[name], fallback, name)
  ]));
  if (limits.maxReceiveBufferSize < limits.maxFrameSize + 5) {
    throw new RangeError('SEN resource limit maxReceiveBufferSize must be at least maxFrameSize + 5');
  }
  return Object.freeze(limits);
}

export function resourceLimitError(resource, limit, actual, context = '') {
  const suffix = context ? ` (${context})` : '';
  const error = new RangeError(`SEN ${resource} limit exceeded: ${actual} > ${limit}${suffix}`);
  error.code = 'SEN_RESOURCE_LIMIT';
  error.resource = resource;
  error.limit = limit;
  error.actual = actual;
  return error;
}
