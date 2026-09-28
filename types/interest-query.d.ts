export type SenInterestQueryParts = {
  entity: string;
  bus: string;
  where: string;
};

export function parseInterestQuery(query: string): SenInterestQueryParts;
export function compileInterestQuery(query: string): (object: any, types: any) => boolean;
