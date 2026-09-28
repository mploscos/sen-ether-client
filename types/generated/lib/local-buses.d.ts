/**
 * @fileoverview Lifecycle of buses joined by the local JavaScript participant.
 *
 * This registry owns bus state and local interest IDs. It does not decode or
 * route incoming frames; encoded control messages are handed to the transport
 * callbacks supplied by `EtherClient`.
 */
/** Owns locally joined buses and interests. */
export declare class LocalBuses {
    #private;
    /**
     * @param {object} context
     * @param {Map<number, object>} context.buses Shared public bus-state map.
     * @param {() => object} context.options Returns current client options and limits.
     * @param {() => boolean} context.isStarted Whether a listener or connection exists.
     * @param {(bus:object) => Promise<void>} context.openMulticast Opens native bus multicast.
     * @param {(message:object) => void} context.sendProcessControl Sends Ether control to all peers.
     * @param {(bus:object, connection:object, message:object, routing?:object) => void} context.sendBusControl
     * @param {(busId:number) => object[]} context.participants Returns remote bus participants.
     * @param {(name:string, detail:object) => void} context.emit Emits an `EtherClient` event.
     */
    constructor(context: {
        buses: Map<number, object>;
        options: () => object;
        isStarted: () => boolean;
        openMulticast: (bus: object) => Promise<void>;
        sendProcessControl: (message: object) => void;
        sendBusControl: (bus: object, connection: object, message: object, routing?: object) => void;
        participants: (busId: number) => object[];
        emit: (name: string, detail: object) => void;
    });
    /** Join and announce one bus, returning the local participant identity. */
    join(busName: any, options?: {}): Promise<{
        busName: any;
        busId: any;
        participantId: any;
        multicastGroup: any;
        multicastPort: any;
    }>;
    /** Start one idempotent native interest on a joined bus. */
    start(bus: any, query: any, options?: {}): {
        busName: any;
        busId: any;
        id: any;
        query: any;
    };
    /** Stop one interest and invalidate its pending state requests. */
    stop(bus: any, id: any): void;
    /** Leave a bus after stopping all local interests. */
    leave(bus: any): void;
    /** Send all current interests to every known participant for a bus. */
    restartForRemote(bus: any): void;
    /** Send all current interests to one newly ready connection. */
    restartForConnection(bus: any, connection: any): void;
    /** Send an interest once per connection generation. */
    sendInterest(bus: any, connection: any, interest: any): void;
}
