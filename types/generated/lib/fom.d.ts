/** IEEE 1516.2-2010 HLA FOM to SEN type registry conversion. */
import { StlResolutionError, StlTypeRegistry } from './stl.js';
export declare class FomResolutionError extends StlResolutionError {
    constructor(message: any, document: any);
}
export declare function fomTypeName(value: any): string;
export declare function fomMemberName(value: any): string;
/** Parses one HLA FOM module without resolving cross-document types. */
export declare function parseFom(source: any, options?: {}): {
    fileName: any;
    packageName: any;
    root: any;
    identification: any;
    dependencies: any;
    deps: never[];
    definitions: Map<any, any>;
    classes: any;
    interactions: any;
    resolved: Map<any, any>;
    types: Map<any, any>;
};
/** Resolves already parsed FOM documents into the same registry used by STL. */
export declare function resolveFom(documents: any, options?: {}): StlTypeRegistry;
