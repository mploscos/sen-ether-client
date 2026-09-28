/** @fileoverview Bounded, optionally coalescing change delivery for interests. */

/** Bounded change queue shared by one interest. */
export class ChangeBatcher {
    /** Configure queue bounds, coalescing and overflow policy for one interest. */
    constructor(interest, options = {}) {
        this.interest = interest;
        this.intervalMs = options.batchIntervalMs ?? options.batch?.intervalMs ?? 16;
        this.maxSize = options.batchMaxSize ?? options.batch?.maxSize ?? 1000;
        this.maxQueued = options.maxQueuedChanges ?? options.batch?.maxQueued ?? 10000;
        this.backpressure = options.backpressure ?? options.batch?.backpressure ?? 'drop-oldest';
        this.coalesce = Boolean(options.coalesce ?? options.batch?.coalesce ?? false);
        this.queue = [];
        this.coalesced = new Map();
        this.timer = undefined;
        this.dropped = 0;
    }

    /** Queue one decoded property change and schedule or trigger a flush. */
    push(change) {
        if (this.coalesce) {
            const key = `${change.object.id}:${change.name}`;
            if (!this.coalesced.has(key)) {
                this.queue.push(key);
            }
            this.coalesced.set(key, change);
        } else {
            this.queue.push(change);
        }

        while (this.queue.length > this.maxQueued) {
            if (this.backpressure === 'error') {
                const error = new Error(`SEN change queue exceeded ${this.maxQueued} item(s)`);
                error.code = 'SEN_CHANGE_BACKPRESSURE';
                this.interest.emit('backpressure', error);
                this.interest.bus.emit('warning', error);
                this.interest.bus.sen.emit('warning', error);
                const newest = this.queue.pop();
                if (this.coalesce) {
                    this.coalesced.delete(newest);
                }
                this.dropped += 1;
                continue;
            }
            if (this.backpressure === 'drop-newest') {
                const newest = this.queue.pop();
                if (this.coalesce) {
                    this.coalesced.delete(newest);
                }
            } else {
                const oldest = this.queue.shift();
                if (this.coalesce) {
                    this.coalesced.delete(oldest);
                }
            }
            this.dropped += 1;
        }

        if (this.queue.length >= this.maxSize) {
            this.flush();
            return;
        }

        if (!this.timer) {
            this.timer = setTimeout(() => this.flush(), this.intervalMs);
            this.timer.unref?.();
        }
    }

    /** Emit the current batch synchronously and reset drop accounting. */
    flush() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        if (!this.queue.length) {
            return;
        }

        const items = this.coalesce
            ? this.queue.map(key => this.coalesced.get(key)).filter(Boolean)
            : this.queue;
        this.queue = [];
        this.coalesced.clear();

        const batch = {
            interest: this.interest,
            bus: this.interest.bus,
            changes: items,
            dropped: this.dropped
        };
        this.dropped = 0;

        this.interest.emit('changes', batch);
        this.interest.bus.emit('changes', batch);
        this.interest.bus.sen.emit('changes', batch);
    }

    /** Flush pending changes and release the timer and queue references. */
    close() {
        this.flush();
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        this.queue = [];
        this.coalesced.clear();
    }
}
