import { FormatSenUnit } from './model.js';

const SI_PREFIXES = [
    ['femto', 'f', 1e-15], ['pico', 'p', 1e-12], ['nano', 'n', 1e-9],
    ['micro', 'u', 1e-6], ['milli', 'm', 1e-3], ['centi', 'c', 1e-2],
    ['deci', 'd', 1e-1], ['deca', 'da', 1e1], ['hecto', 'h', 1e2],
    ['kilo', 'k', 1e3], ['mega', 'M', 1e6], ['giga', 'G', 1e9],
    ['tera', 'T', 1e12], ['peta', 'P', 1e15]
];

/** @type {Array<{name:string,namePlural:string,abbreviation:string,category:string,f:number,x:number,y:number}>} */
const UNITS = [];

function addUnit(name, namePlural, abbreviation, category, f = 1, x = 0, y = 0) {
    UNITS.push(Object.freeze({ name, namePlural, abbreviation, category, f, x, y }));
}

function addSIUnit(name, namePlural, abbreviation, category) {
    addUnit(name, namePlural, abbreviation, category);
    for (const [prefix, abbreviationPrefix, factor] of SI_PREFIXES) {
        addUnit(`${prefix}${name}`, `${prefix}${namePlural}`, `${abbreviationPrefix}${abbreviation}`, category, factor);
    }
}

for (const [name, namePlural, abbreviation, category] of [
    ['meter', 'meters', 'm', 'length'], ['second', 'seconds', 's', 'time'],
    ['radian', 'radians', 'rad', 'angle'], ['kelvin', 'kelvin', 'k', 'temperature'],
    ['gram', 'grams', 'g', 'mass'],
    ['radians_per_second', 'radians_per_second', 'rad_per_s', 'angularVelocity'],
    ['grams_per_centimeters_cube', 'grams_per_centimeters_cube', 'g_per_cm3', 'density'],
    ['pascals', 'pascals', 'pa', 'pressure'], ['square_meter', 'square_meter', 'm_sq', 'area'],
    ['newton', 'newton', 'nw', 'force']
]) addSIUnit(name, namePlural, abbreviation, category);

const PI = 3.14159265358979323846264338327950288419716939937510;
for (const unit of [
    ['hertz', 'hertz', 'hz', 'frequency', 1],
    ['meters_per_second', 'meters_per_second', 'm_per_s', 'velocity', 1],
    ['decimeters_per_second', 'decimeters_per_second', 'dm_per_s', 'velocity', 0.1],
    ['meters_per_second_squared', 'meters_per_second_squared', 'm_per_s_sq', 'acceleration', 1],
    ['radians_per_second_squared', 'radians_per_second_squared', 'rad_per_s_sq', 'angularAcceleration', 1],
    ['min', 'minutes', 'min', 'time', 60], ['hour', 'hours', 'hour', 'time', 3600],
    ['day', 'days', 'day', 'time', 86400], ['week', 'weeks', 'week', 'time', 604800],
    ['month', 'months', 'month', 'time', 2.628e6], ['year', 'years', 'year', 'time', 3.154e7],
    ['newton_meter', 'newton_meters', 'Nm', 'torque', 1],
    ['foot', 'feet', 'ft', 'length', 381 / 1250], ['mile', 'miles', 'mi', 'length', 1609.344],
    ['nauticalMile', 'nauticalMiles', 'nmi', 'length', 1852],
    ['degree', 'degrees', 'deg', 'angle', PI / 180],
    ['arcminute', 'arcminutes', 'arcmin', 'angle', PI / (180 * 60)],
    ['arcsecond', 'arcseconds', 'arcsec', 'angle', PI / (180 * 3600)],
    ['centigrade', 'centigrades', 'degC', 'temperature', 1, 273.15, 0],
    ['fahrenheit', 'fahrenheit', 'degF', 'temperature', 5 / 9, 273.15, -32],
    ['km_per_hour', 'km_per_hour', 'kph', 'velocity', 5 / 18],
    ['miles_per_hour', 'miles_per_hour', 'mph', 'velocity', 0.44704],
    ['knot', 'knots', 'kn', 'velocity', 1852 / 3600],
    ['feet_per_second', 'feets_per_second', 'ft_per_s', 'velocity', 381 / 1250],
    ['feet_per_minute', 'feets_per_minute', 'ft_per_min', 'velocity', 381 / (60 * 1250)],
    ['degrees_per_second', 'degrees_per_second', 'deg_per_s', 'angularVelocity', 180 / PI],
    ['revolutions_per_min', 'revolutions_per_min', 'rpm', 'angularVelocity', 60 / (2 * PI)],
    ['pound', 'pounds', 'lb', 'mass', 453.59237],
    ['kilograms_per_meters_cube', 'kilograms_per_meters_cube', 'kg_per_m3', 'density', 0.001]
]) addUnit(...unit);

const UNIT_BY_NAME = new Map(UNITS.flatMap(unit => [[unit.name, unit], [unit.abbreviation, unit]]));

/** Internal full SEN unit descriptor used by the structural type hasher. */
export function FindSenUnit(nameOrAbbreviation) {
    return UNIT_BY_NAME.get(String(nameOrAbbreviation ?? ''));
}

/** Return fresh descriptors for every unit in the standard SEN registry. */
export function SenUnits() {
    return UNITS.map(({ name, abbreviation, category }) => ({
        name,
        abbreviation,
        category,
        label: FormatSenUnit(abbreviation)
    }));
}
