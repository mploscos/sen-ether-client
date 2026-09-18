const AMBIGUOUS = Symbol('ambiguous type name');

/**
 * Mutable SEN type catalog with cached name indexes.
 * Mutations invalidate every index, including set(key, sameValue).
 * @extends {Map<string, any>}
 */
export class SenTypeCatalog extends Map {
  #indexes = new Map();
  revision = 0;

  /** @param {Iterable<readonly [string, any]>} [entries] */
  constructor(entries = []) {
    super();
    for (const [key, value] of entries) super.set(key, value);
  }

  set(key, value) {
    this.#indexes.clear();
    this.revision += 1;
    return super.set(key, value);
  }

  delete(key) {
    const removed = super.delete(key);
    if (removed) {
      this.#indexes.clear();
      this.revision += 1;
    }
    return removed;
  }

  clear() {
    super.clear();
    this.#indexes.clear();
    this.revision += 1;
  }

  #index(normalize) {
    let index = this.#indexes.get(normalize);
    if (!index) {
      index = buildIndex(this, normalize);
      this.#indexes.set(normalize, index);
    }
    return index;
  }

  /**
   * Resolve using legacy precedence: key, declared name, then first suffix.
   * Prefer findUnique() for user-provided or unqualified names.
   * @param {string} name
   * @param {(name: any) => string} normalize
   */
  resolve(name, normalize) {
    const target = normalize(name);
    if (!target) return null;
    const index = this.#index(normalize);
    const match = index.keys.get(target)
      ?? index.names.get(target)
      ?? index.suffixes.get(target.split('.').pop() || '');
    return match ? match.value : null;
  }

  /**
   * Return a definition only when its full or unqualified name is unambiguous.
   * @param {string} name
   * @param {(name: any) => string} normalize
   * @returns {{value: any} | null}
   */
  findUnique(name, normalize) {
    const target = normalize(name);
    if (!target) return null;
    const index = this.#index(normalize);
    const exact = index.unique.get(target);
    if (exact && exact !== AMBIGUOUS) return exact;
    const short = !target.includes('.') ? index.short.get(target) : null;
    return short && short !== AMBIGUOUS ? short : null;
  }
}

function buildIndex(definitions, normalize) {
  const keys = new Map();
  const names = new Map();
  const suffixes = new Map();
  const unique = new Map();
  const short = new Map();

  const addUnique = (index, key, entry) => {
    if (!key) return;
    const current = index.get(key);
    if (!current) index.set(key, entry);
    else if (current !== AMBIGUOUS && current.value !== entry.value) index.set(key, AMBIGUOUS);
  };

  const addShort = (key, entry) => {
    if (!key) return;
    const current = short.get(key);
    short.set(key, current ? AMBIGUOUS : entry);
  };

  for (const [key, value] of definitions) {
    const keyName = normalize(key);
    const name = normalize(value?.name);
    const qualified = normalize(value?.qualifiedName);
    const entry = { value };

    if (keyName && !keys.has(keyName)) keys.set(keyName, entry);
    for (const alias of [name, qualified]) {
      if (alias && !names.has(alias)) names.set(alias, entry);
    }
    const fullNames = new Set([keyName, name, qualified].filter(Boolean));
    for (const full of fullNames) {
      addUnique(unique, full, entry);
      const suffix = full.split('.').pop() || '';
      if (suffix && !suffixes.has(suffix)) suffixes.set(suffix, entry);
    }
    for (const suffix of new Set([...fullNames].map(full => full.split('.').pop() || ''))) {
      addShort(suffix, entry);
    }
  }
  return { keys, names, suffixes, unique, short };
}
