/** Compile queries for objects published by this JavaScript client, without eval. */
export declare function compileInterestQuery(query: any): (object: any, types: any) => any;
/** Parse the common SELECT/FROM/WHERE envelope without altering quoted values. */
export declare function parseInterestQuery(query: any): {
    entity: string;
    bus: string;
    where: string;
};
