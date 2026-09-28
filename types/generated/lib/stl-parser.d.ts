/**
 * @fileoverview Filesystem-free tokenizer and recursive-descent parser for STL.
 *
 * The parser returns source-located declarations and performs syntax validation
 * only. Import loading, name resolution and TypeSpec adaptation are separate.
 */
export declare class StlSyntaxError extends Error {
    location: {
        line: any;
        column: any;
        offset: any;
    } | undefined;
    constructor(message: any, token: any);
}
/** Tokenizes the STL lexical grammar used by SEN's StlScanner. */
export declare function tokenizeStl(source: any, fileName?: string): {
    type: any;
    lexeme: any;
    value: undefined;
    line: any;
    column: any;
    offset: any;
}[];
/** Parses STL source text into a transport-independent AST. */
export declare function parseStl(source: any, options?: {}): Readonly<{
    kind: "Program";
    fileName: any;
    statements: readonly any[];
}>;
