/** Internal full SEN unit descriptor used by the structural type hasher. */
export declare function FindSenUnit(nameOrAbbreviation: any): {
    name: string;
    namePlural: string;
    abbreviation: string;
    category: string;
    f: number;
    x: number;
    y: number;
} | undefined;
/** Return fresh descriptors for every unit in the standard SEN registry. */
export declare function SenUnits(): {
    name: string;
    abbreviation: string;
    category: string;
    label: any;
}[];
