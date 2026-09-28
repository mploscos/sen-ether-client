/**
 * Small, dependency-free XML reader for SEN/HLA interface documents.
 *
 * It intentionally exposes only the tree operations needed by the FOM loader.
 * XML namespaces are matched by local name so IEEE OMT documents work with or
 * without a default namespace.
 */
export declare class XmlSyntaxError extends Error {
    fileName: string;
    offset: number;
    constructor(message: any, fileName?: string, offset?: number);
}
export declare class XmlElement {
    name: any;
    attributes: Readonly<{}>;
    parent: any;
    children: any[];
    textParts: any[];
    constructor(name: any, attributes?: {}, parent?: null);
    child(name: any): any;
    childrenNamed(name: any): any[];
    childText(name: any): any;
    attribute(name: any): any;
    text(): string;
    descendants(name: any): any[];
}
/** Parses XML into a lightweight immutable-name element tree. */
export declare function parseXml(source: any, options?: {}): any;
