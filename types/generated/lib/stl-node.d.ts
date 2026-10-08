/**
 * Loads an IEEE 1516.2 FOM module directory, a SEN FOM layout, or one XML file
 * within such a layout into a reusable SEN type registry.
 *
 * @param {string|URL} sourcePath
 * @param {{mappingPaths?: string[]}} [options]
 */
export declare function loadFom(sourcePath: string | URL, options?: {
    mappingPaths?: string[];
}): Promise<import("./stl-resolver.js").StlTypeRegistry>;
/**
 * Loads the RPR FOM 2.0 modules bundled with sen-ether-client.
 * The resolved registry is shared by every caller in the process.
 *
 * @returns {Promise<import('./stl.js').StlTypeRegistry>}
 */
export declare function loadRprFom(): Promise<import('./stl.js').StlTypeRegistry>;
/**
 * Loads and resolves an STL file or directory once using Node's filesystem.
 * Parsing and resolution remain in ./stl.js, which has no filesystem access.
 *
 * @param {string} sourcePath Entry STL file or a directory containing STL files.
 * @param {{includePaths?: string[]}} [options]
 * @returns {Promise<import('./stl.js').StlTypeRegistry>}
 */
export declare function loadStl(sourcePath: string, options?: {
    includePaths?: string[];
}): Promise<import('./stl.js').StlTypeRegistry>;
