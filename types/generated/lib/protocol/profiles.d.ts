/** Transport compatibility profiles for released SEN protocol families. */
export declare const SEN_PROTOCOL_PROFILES: Readonly<{
    legacy: Readonly<{
        name: "legacy";
        kernelProtocolVersion: 9;
        etherProtocolVersion: 2;
        tcpDiscoveryFraming: "fixed-508";
        busMulticastAllocation: "legacy-hash-bytes";
        busMulticastRange: readonly (Readonly<{
            min: 224;
            max: 239;
        }> | Readonly<{
            min: 0;
            max: 255;
        }>)[];
        busMulticastExclusions: readonly never[];
    }>;
    enhanced: Readonly<{
        name: "enhanced";
        kernelProtocolVersion: 11;
        etherProtocolVersion: 2;
        tcpDiscoveryFraming: "length-prefixed";
        busMulticastAllocation: "usable-address-index";
        busMulticastRange: readonly (Readonly<{
            min: 239;
            max: 239;
        }> | Readonly<{
            min: 0;
            max: 255;
        }>)[];
        busMulticastExclusions: readonly (Readonly<{
            min: "239.0.0.0";
            max: "239.0.255.255";
        }> | Readonly<{
            min: "239.128.0.0";
            max: "239.128.255.255";
        }> | Readonly<{
            min: "239.195.255.0";
            max: "239.195.255.255";
        }> | Readonly<{
            min: "239.255.0.0";
            max: "239.255.0.255";
        }> | Readonly<{
            min: "239.255.255.0";
            max: "239.255.255.255";
        }>)[];
    }>;
}>;
/** Resolve a public protocol profile. */
export declare function resolveProtocolProfile(value?: string): any;
