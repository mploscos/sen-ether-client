/**
 * @fileoverview Local Sen object publication lifecycle for one Ether client.
 *
 * The registry owns object state, local TypeSpec responses, matching against
 * remote interests, property updates, events and incoming method calls. It is
 * intentionally separate from connection routing: callers provide the four
 * transport operations needed to send already encoded messages.
 */

import {
    encodeRuntimeEvents,
    encodeRuntimeMethodResponse,
    encodeRuntimeObjectUpdate
} from './bus.js';
import { eventHash, methodHash } from './hash32.js';
import { remoteInterestKey } from './ether-network.js';
import { senTypeHash } from './type-hash.js';
import { decodeArguments, encodeArguments, encodeValue } from './values.js';
import {
    buildLocalObject,
    collectClassEvents,
    collectTypeDependencies,
    localObjectPatchBuffer,
    localObjectStateBuffer,
    localObjectTypeRegistry,
    methodById,
    normalizeTypeDefinitions,
    setterName,
    writablePropertySetterById
} from './local-objects.js';

/**
 * Coordinates JavaScript objects published on joined Sen buses.
 *
 * @param {object} transport
 * @param {(name:string, detail:object) => void} transport.emit
 * @param {(bus:object, connection:object|undefined, message:object, routing?:object) => void} transport.sendControl
 * @param {(bus:object, connection:object|undefined, payload:Buffer) => void} transport.sendMessage
 * @param {(bus:object, payload:Buffer) => Promise<void>} transport.sendMulticast
 * @param {(bus:object, payload:Buffer) => Promise<boolean>} transport.sendUnicast
 */
export class LocalPublications {
    #emit;
    #sendControl;
    #sendMessage;
    #sendMulticast;
    #sendUnicast;

    constructor(transport) {
        this.#emit = transport.emit;
        this.#sendControl = transport.sendControl;
        this.#sendMessage = transport.sendMessage;
        this.#sendMulticast = transport.sendMulticast;
        this.#sendUnicast = transport.sendUnicast;
    }

    /**
     * Add objects and their optional external TypeSpecs to a joined bus.
     *
     * @param {object} bus Bus state owned by `EtherClient`.
     * @param {object|object[]} objects Publication descriptors.
     * @param {{types?:Map<string, object>|Record<string, object>|object[]}} [options]
     * @returns {object[]} Normalized local object records.
     */
    publish(bus, objects, options = {}) {
        const list = Array.isArray(objects) ? objects : [objects];
        const externalTypes = normalizeTypeDefinitions(options.types);
        for (const type of externalTypes) {
            bus.localTypeRegistry.set(type.qualifiedName, type);
        }
        for (const type of externalTypes) {
            this.#registerType(bus, type);
        }

        const published = [];
        for (const item of list) {
            const localObject = buildLocalObject(item, bus.localTypeRegistry, {
                strictTypes: externalTypes.length > 0
            });
            bus.publishedObjects.set(localObject.id, localObject);
            this.#registerType(bus, localObject.spec, localObject.typeHash);
            published.push(localObject);
        }

        this.publishForInterests(bus, published);
        this.#emit('objectsPublishedLocal', {
            busName: bus.busName,
            busId: bus.busId,
            objects: published
        });
        return published;
    }

    /** Update object state and notify matching remote participants. */
    update(bus, selector, patch) {
        const object = this.#find(bus, selector);
        if (!Object.keys(patch).length) {
            return object;
        }

        const registry = localObjectTypeRegistry(bus, object);
        const propertiesBuffer = localObjectPatchBuffer(object, registry, patch);
        Object.assign(object.state, patch);
        object.timestamp = BigInt(Date.now()) * 1_000_000n;
        object.stateBuffer = localObjectStateBuffer(object, registry);
        this.publishForInterests(bus, [object], undefined, true);
        this.#sendMessage(bus, undefined, encodeRuntimeObjectUpdate({
            objectId: object.id,
            time: object.timestamp,
            propertiesBuffer
        }));

        this.#emit('runtimeObjectUpdateLocal', {
            busName: bus.busName,
            busId: bus.busId,
            object,
            patch
        });
        return object;
    }

    /** Encode and transmit one declared object event. */
    async emitEvent(bus, selector, eventName, args = [], options = {}) {
        const object = this.#find(bus, selector);
        const registry = localObjectTypeRegistry(bus, object);
        const event = collectClassEvents(object.spec, registry).find(candidate => candidate.name === eventName);
        if (!event) {
            throw new Error(`SEN event not found: ${object.className}.${eventName}`);
        }
        if (!Array.isArray(args)) {
            throw new TypeError(`SEN event arguments must be an array: ${object.className}.${eventName}`);
        }
        if (args.length !== (event.args?.length ?? 0)) {
            throw new TypeError(
                `SEN event ${object.className}.${eventName} expects ${event.args?.length ?? 0} argument(s), got ${args.length}`
            );
        }

        const argumentsBuffer = encodeArguments(args, event.args ?? [], registry);
        const creationTime = options.creationTime ?? BigInt(Date.now()) * 1_000_000n;
        const creationTimeNs = typeof creationTime === 'bigint' ? creationTime : BigInt(creationTime);
        const eventId = (event.id ?? eventHash(event.name)) >>> 0;
        const message = encodeRuntimeEvents([{
            producerId: object.id,
            eventId,
            creationTime,
            argumentsBuffer
        }]);

        const transportMode = event.transportMode ?? 'multicast';
        if (transportMode === 'multicast' && bus.multicastSocket && bus.multicastGroup) {
            await this.#sendMulticast(bus, message);
        } else if (transportMode === 'unicast' && bus.multicastSocket) {
            const sent = await this.#sendUnicast(bus, message);
            if (!sent) {
                this.#sendMessage(bus, undefined, message);
            }
        } else {
            this.#sendMessage(bus, undefined, message);
        }

        const emitted = {
            busName: bus.busName,
            busId: bus.busId,
            object,
            event: { ...event, id: eventId },
            args: [...args],
            creationTime,
            creationTimeNs,
            transportMode
        };
        this.#emit('runtimeEventLocal', emitted);
        return emitted;
    }

    /** Remove local objects and withdraw them from every matching interest. */
    remove(bus, selectors) {
        const values = Array.isArray(selectors) ? selectors : [selectors];
        const removed = [];
        for (const selector of values) {
            const id = typeof selector === 'number'
                ? selector >>> 0
                : [...bus.publishedObjects.values()].find(object => object.name === selector)?.id;
            if (id !== undefined && bus.publishedObjects.delete(id)) {
                removed.push(id);
            }
        }

        this.#removeFromInterests(bus, removed);
        this.#emit('objectsRemovedLocal', {
            busName: bus.busName,
            busId: bus.busId,
            objectIds: removed
        });
        return removed;
    }

    /** Execute a method call addressed to a locally published object. */
    async handleMethodCall(bus, call, connection) {
        const object = bus.publishedObjects.get(call.objectId >>> 0);
        if (!object) {
            this.#sendMethodResponse(bus, connection, {
                result: 'objectNotFound',
                objectId: call.objectId,
                ticketId: call.ticketId
            });
            return;
        }

        const registry = localObjectTypeRegistry(bus, object);
        const method = methodById(object.spec, registry, call.methodId);
        const methodHandler = method
            ? object.methods[method.name] ?? object.methods[String(method.id ?? methodHash(method.name))]
            : undefined;
        const writableProperty = writablePropertySetterById(object.spec, registry, call.methodId);
        const propertyHandler = writableProperty
            ? object.methods[setterName(writableProperty.name)]
                ?? object.methods[String(methodHash(setterName(writableProperty.name)))]
            : undefined;
        const handledMethod = methodHandler ? method : undefined;
        const handledProperty = handledMethod ? undefined : writableProperty;
        const handler = methodHandler ?? propertyHandler;
        if (!handledMethod && !handledProperty) {
            this.#sendMethodResponse(bus, connection, {
                result: 'logicError',
                objectId: object.id,
                ticketId: call.ticketId,
                error: `SEN method handler not found: ${object.className}.${call.methodId}`
            });
            return;
        }

        try {
            const args = decodeArguments(
                call.argumentsBuffer,
                handledMethod?.args ?? [{ name: 'value', type: handledProperty.type }],
                registry
            );
            const context = {
                busName: bus.busName,
                busId: bus.busId,
                object,
                state: object.state,
                update: patch => this.update(bus, object.id, patch),
                set: patch => this.update(bus, object.id, patch),
                publishObjects: (objects, options = {}) => this.publish(bus, objects, options),
                removeObjects: objects => this.remove(bus, objects)
            };
            const result = handler
                ? await handler.apply(context, args)
                : await context.update({ [handledProperty.name]: args[0] });
            const returnValue = !handledMethod?.returnType || handledMethod.returnType === 'void'
                ? Buffer.alloc(0)
                : encodeValue(result, handledMethod.returnType, registry);
            this.#sendMethodResponse(bus, connection, {
                result: 'success',
                objectId: object.id,
                ticketId: call.ticketId,
                returnValue
            });
            this.#emit('runtimeMethodCallLocal', {
                busName: bus.busName,
                busId: bus.busId,
                object,
                method: handledMethod ?? {
                    id: call.methodId,
                    name: setterName(handledProperty.name),
                    args: [{ name: 'value', type: handledProperty.type }],
                    returnType: 'void'
                },
                args,
                result
            });
        } catch (error) {
            this.#sendMethodResponse(bus, connection, {
                result: 'runtimeError',
                objectId: object.id,
                ticketId: call.ticketId,
                error: error?.message || String(error)
            });
        }
    }

    /** Answer an `ObjectsStateRequest` for locally owned objects. */
    respondToStateRequest(bus, frame, value, connection) {
        const participantId = frame.to >>> 0;
        const responses = [];
        for (const request of value.requests ?? []) {
            const interest = bus.remoteInterests.get(remoteInterestKey(participantId, request.interestId));
            if (!interest) {
                continue;
            }
            const objectStates = [];
            for (const objectId of request.objectIds ?? []) {
                const object = bus.publishedObjects.get(objectId >>> 0);
                if (object && interest.objectIds.has(object.id)) {
                    objectStates.push({ id: object.id, timestamp: object.timestamp, state: object.stateBuffer });
                }
            }
            if (objectStates.length) {
                responses.push({ interestId: request.interestId, objectStates });
            }
        }
        if (responses.length) {
            this.#sendControl(bus, connection, {
                type: 'ObjectsStateResponse',
                value: { ownerId: participantId, responses }
            });
        }
    }

    /** Answer a `TypesInfoRequest` from the bus-local TypeSpec cache. */
    respondToTypesRequest(bus, frame, value, connection) {
        const types = [];
        const rejections = [];
        for (const request of value.requests ?? []) {
            const type = bus.localTypeResponsesByHash.get(request >>> 0);
            if (type) {
                types.push(type);
            } else {
                rejections.push(String(request));
            }
        }
        if (types.length) {
            this.#sendControl(bus, connection, {
                type: 'TypesInfoResponse',
                value: { ownerId: frame.to >>> 0, types }
            });
        }
        if (rejections.length) {
            this.#sendControl(bus, connection, {
                type: 'TypesInfoRejection',
                value: { ownerId: frame.to >>> 0, rejections }
            });
        }
    }

    /** Re-evaluate local objects for selected or all remote interests. */
    publishForInterests(bus, objects, keys = undefined, changesOnly = false) {
        if (!objects.length) {
            return;
        }
        const targets = (keys ?? [...bus.remoteInterests.keys()])
            .map(key => bus.remoteInterests.get(key))
            .filter(Boolean);
        const byTarget = new Map();
        for (const interest of targets) {
            const connection = interest.connection;
            if (!connection) {
                continue;
            }
            const selected = [];
            const removed = [];
            for (const object of objects) {
                const wasIncluded = interest.objectIds.has(object.id);
                if (interest.matches(object, bus.localTypeRegistry)) {
                    interest.objectIds.add(object.id);
                    if (!changesOnly || !wasIncluded) {
                        selected.push(object);
                    }
                } else if (wasIncluded) {
                    interest.objectIds.delete(object.id);
                    removed.push(object.id);
                }
            }
            if (removed.length) {
                this.#sendControl(bus, connection, {
                    type: 'ObjectsRemoved',
                    value: { removals: [{ interestId: interest.id, ids: removed }] }
                });
            }
            if (!selected.length) {
                continue;
            }
            const key = `${connection.id}:${interest.participantId}`;
            const target = byTarget.get(key) ?? {
                connection,
                ownerId: interest.participantId,
                discoveries: []
            };
            target.discoveries.push({
                interestId: interest.id,
                objects: selected.map(object => ({
                    className: object.className,
                    typeHash: object.typeHash,
                    name: object.name,
                    id: object.id,
                    state: object.stateBuffer,
                    time: object.timestamp
                }))
            });
            byTarget.set(key, target);
        }

        for (const { connection, ownerId, discoveries } of byTarget.values()) {
            this.#sendControl(bus, connection, {
                type: 'ObjectsPublished',
                value: { ownerId, discoveries }
            }, { reason: 'interest-owner', ownerId });
        }
    }

    #registerType(bus, spec, hash = undefined) {
        if (!spec?.qualifiedName) {
            return;
        }
        bus.localTypeRegistry.set(spec.qualifiedName, spec);
        const resolvedHash = hash === undefined ? senTypeHash(spec, bus.localTypeRegistry) : hash >>> 0;
        const response = spec.data?.type === 'ClassTypeSpec'
            ? {
                type: 'ClassSpecResponse',
                classHash: resolvedHash,
                spec,
                dependentTypes: [...collectTypeDependencies(spec, bus.localTypeRegistry)]
            }
            : { type: 'NonClassSpecResponse', spec };
        bus.localTypeResponsesByHash.set(resolvedHash, response);
    }

    #removeFromInterests(bus, objectIds) {
        if (!objectIds.length) {
            return;
        }
        const byConnection = new Map();
        for (const interest of bus.remoteInterests.values()) {
            if (!interest.connection) {
                continue;
            }
            const ids = objectIds.filter(id => interest.objectIds.delete(id));
            if (!ids.length) {
                continue;
            }
            const removals = byConnection.get(interest.connection) ?? [];
            removals.push({ interestId: interest.id, ids });
            byConnection.set(interest.connection, removals);
        }
        for (const [connection, removals] of byConnection) {
            this.#sendControl(bus, connection, {
                type: 'ObjectsRemoved',
                value: { removals }
            });
        }
    }

    #sendMethodResponse(bus, connection, response) {
        this.#sendMessage(bus, connection, encodeRuntimeMethodResponse(response));
    }

    #find(bus, selector) {
        if (typeof selector === 'object' && selector?.id !== undefined) {
            return bus.publishedObjects.get(selector.id >>> 0) ?? selector;
        }
        if (typeof selector === 'number') {
            const object = bus.publishedObjects.get(selector >>> 0);
            if (object) {
                return object;
            }
        } else {
            const object = [...bus.publishedObjects.values()].find(value => value.name === selector);
            if (object) {
                return object;
            }
        }
        throw new Error(`SEN published object not found: ${selector}`);
    }
}
