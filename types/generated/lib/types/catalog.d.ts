/**
 * Mutable SEN type catalog with cached name indexes.
 * Mutations invalidate every index, including set(key, sameValue).
 * @extends {Map<string, any>}
 */
export declare class SenTypeCatalog extends Map<string, any> {
    #private;
    revision: number;
    /** @param {Iterable<readonly [string, any]>} [entries] */
    constructor(entries?: Iterable<readonly [string, any]>);
    set(key: any, value: any): this;
    delete(key: any): boolean;
    clear(): void;
    /**
     * Resolve using legacy precedence: key, declared name, then first suffix.
     * Prefer findUnique() for user-provided or unqualified names.
     * @param {string} name
     * @param {(name: any) => string} normalize
     */
    resolve(name: string, normalize: (name: any) => string): any;
    /**
     * Return a definition only when its full or unqualified name is unambiguous.
     * @param {string} name
     * @param {(name: any) => string} normalize
     * @returns {{value: any} | null}
     */
    findUnique(name: string, normalize: (name: any) => string): {
        value: any;
    } | null;
}
