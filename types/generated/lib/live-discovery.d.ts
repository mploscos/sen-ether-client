export declare class LiveDiscovery {
    options: any;
    onTarget: any;
    onWarning: any;
    makeScanner: any;
    targets: Map<any, any>;
    waiters: Set<any>;
    closed: boolean;
    scanner: any;
    cancelStart: ((reason?: any) => void) | undefined;
    started: boolean | undefined;
    restartTimer: NodeJS.Timeout | undefined;
    constructor(options: any, onTarget: any, onWarning: any, makeScanner: any);
    start(recovering?: boolean): Promise<void>;
    scheduleRestart(): void;
    waitFor(session: any, timeout: any): Promise<any>;
    close(): Promise<void>;
}
