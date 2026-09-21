export type SenTypeKind =
  | 'enum'
  | 'quantity'
  | 'sequence'
  | 'struct'
  | 'variant'
  | 'alias'
  | 'optional'
  | 'class';

export const SenTypeCode: Readonly<Record<SenTypeKind, number>>;
export const SenTypeCodeByKind: typeof SenTypeCode;
export const SenTypeKindByCode: Readonly<Record<number, SenTypeKind>>;

export function GetSenTypeCode(definition: unknown): number | null;
export function GetSenTypeKind(definition: unknown): SenTypeKind | null;
export function GetSenTypeValue(definition: unknown): any;
export function NormalizeSenTypeName(value: unknown): string;
export function GetSenTypeNameFromSpec(spec: unknown): string;

export class SenTypeCatalog extends Map<string, any> {
  revision: number;
  constructor(entries?: Iterable<readonly [string, any]>);
  resolve(name: string, normalize: (name: unknown) => string): any | null;
  findUnique(
    name: string,
    normalize: (name: unknown) => string
  ): { value: any } | null;
}

export type SenTypeDefinitions = Map<string, any> | Record<string, any>;

export class SenTypeResolver {
  constructor(definitions: SenTypeDefinitions | (() => SenTypeDefinitions));
  typeDefinitions: () => SenTypeDefinitions;

  resolveTypeDefinition(typeName: string, options?: { unique?: boolean }): any | null;
  resolveValueDefinition(spec: unknown): any | null;
  unwrapTypeDefinition(definition: unknown): any | null;
  optionalValueDefinition(definition: unknown): {
    typeName: string;
    definition: { type: string };
  } | null;
  isArrayDefinition(definition: unknown): boolean;
  arrayItemDefinition(definition: unknown): any | null;
  isQuantityDefinition(definition: unknown): boolean;
  variantDefinition(definition: unknown): {
    options: Array<{ label: string; value: string }>;
  } | null;
  typeFields(definition: unknown): any[];
  enumOptions(definition: unknown): Record<string, any> | null;
  classLineage(typeName: string): any[];
  classMembers(typeName: string, member: string): any[];
  typeDefinitionKey(args: any[]): string;
}

export function NormalizeSenUnit(unit: any): {
  name: string;
  abbreviation: string;
  category: string;
  label: string;
};
export function FormatSenUnit(value: any): string;
export type SenUnitDescriptor = {
  name: string;
  abbreviation: string;
  category: string;
  label: string;
};
export function SenUnits(): SenUnitDescriptor[];
export function DescribeSenPrimitive(spec: any): {
  name: string;
  normalized: string;
  integer: boolean;
  numeric: boolean;
  boolean: boolean;
  string: boolean;
  largeInteger: boolean;
  timestamp: boolean;
};
export function DescribeSenQuantity(spec: any, definitions: SenTypeResolver | Map<string, any> | Record<string, any>): {
  definition: any;
  elementType: any;
  unit: ReturnType<typeof NormalizeSenUnit>;
  minValue: any;
  maxValue: any;
  integer: boolean;
} | null;
export function ResolveSenPresentValueDefinition(spec: any, definitions: SenTypeResolver | Map<string, any> | Record<string, any>): any;
export function ResolveSenValueSpec(spec: any, path: Array<string | number>, definitions: SenTypeResolver | Map<string, any> | Record<string, any>): any;
export function WalkSenValue(value: any, spec: any, definitions: SenTypeResolver | Map<string, any> | Record<string, any>, visitor: (entry: {
  path: Array<string | number>;
  value: any;
  spec: any;
  definition: any;
  code: number | null;
}) => void, path?: Array<string | number>, depth?: number): void;
