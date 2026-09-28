/** @fileoverview Bounded, optionally coalescing change delivery for interests. */
/** Bounded change queue shared by one interest. */
export declare class ChangeBatcher {
    interest: any;
    intervalMs: any;
    maxSize: any;
    maxQueued: any;
    backpressure: any;
    coalesce: boolean;
    queue: any[];
    coalesced: Map<any, any>;
    timer: NodeJS.Timeout | undefined;
    dropped: number;
    /** Configure queue bounds, coalescing and overflow policy for one interest. */
    constructor(interest: any, options?: {});
    /** Queue one decoded property change and schedule or trigger a flush. */
    push(change: any): void;
    /** Emit the current batch synchronously and reset drop accounting. */
    flush(): void;
    /** Flush pending changes and release the timer and queue references. */
    close(): void;
}
