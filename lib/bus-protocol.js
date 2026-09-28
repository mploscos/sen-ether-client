/** @fileoverview Shared numeric constants used by native Sen bus codecs. */

/** Native Sen bus message categories, indexed by the first envelope byte. */
export const BUS_MESSAGE_CATEGORY = Object.freeze({
    controlMessage: 0,
    runtimeObjectUpdate: 1,
    runtimeMethodCallBestEffort: 2,
    runtimeMethodCallConfirmed: 3,
    runtimeMethodResponse: 4,
    runtimeEvents: 5
});

/** Result codes carried by runtime method responses. */
export const REMOTE_CALL_RESULT = Object.freeze([
    'success',
    'objectNotFound',
    'runtimeError',
    'logicError',
    'unknownException'
]);
