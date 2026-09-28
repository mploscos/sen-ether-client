export declare const DEFAULT_RESOURCE_LIMITS: Readonly<{
    maxFrameSize: number;
    maxReceiveBufferSize: number;
    maxStringBytes: number;
    maxBufferBytes: number;
    maxSequenceLength: 100000;
    maxDiscoveredProcesses: 4096;
    maxConnections: 128;
    maxInterestsPerBus: 4096;
    maxRemoteInterestsPerBus: 4096;
    maxPendingRequestsPerBus: 65536;
    maxForwardedObjectRoutesPerBus: 100000;
    maxPendingTransitCallsPerBus: 16384;
    maxRemoteParticipantsPerBus: 4096;
    maxPendingStatesPerObject: 64;
    maxPendingMethodCallsPerBus: 16384;
}>;
/** Normalize public resource-limit options and reject internally inconsistent values. */
export declare function normalizeResourceLimits(options?: {}): Readonly<{
    [k: string]: number;
}>;
export declare function resourceLimitError(resource: any, limit: any, actual: any, context?: string): RangeError;
