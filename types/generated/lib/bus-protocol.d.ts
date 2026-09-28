/** @fileoverview Shared numeric constants used by native Sen bus codecs. */
/** Native Sen bus message categories, indexed by the first envelope byte. */
export declare const BUS_MESSAGE_CATEGORY: Readonly<{
    controlMessage: 0;
    runtimeObjectUpdate: 1;
    runtimeMethodCallBestEffort: 2;
    runtimeMethodCallConfirmed: 3;
    runtimeMethodResponse: 4;
    runtimeEvents: 5;
}>;
/** Result codes carried by runtime method responses. */
export declare const REMOTE_CALL_RESULT: readonly string[];
