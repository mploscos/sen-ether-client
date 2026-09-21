import { FormatSenUnit } from './model.js';

const SI_PREFIXES = [
    ['femto', 'f'], ['pico', 'p'], ['nano', 'n'], ['micro', 'u'], ['milli', 'm'],
    ['centi', 'c'], ['deci', 'd'], ['deca', 'da'], ['hecto', 'h'], ['kilo', 'k'],
    ['mega', 'M'], ['giga', 'G'], ['tera', 'T'], ['peta', 'P']
];

/** @type {Array<{name:string,abbreviation:string,category:string}>} */
const UNITS = [];

/** @param {string} name @param {string} abbreviation @param {string} category */
function addUnit(name, abbreviation, category) {
    UNITS.push({ name, abbreviation, category });
}

/** @param {string} name @param {string} abbreviation @param {string} category */
function addSIUnit(name, abbreviation, category) {
    addUnit(name, abbreviation, category);
    for (const [prefix, abbreviationPrefix] of SI_PREFIXES) {
        addUnit(`${prefix}${name}`, `${abbreviationPrefix}${abbreviation}`, category);
    }
}

for (const [name, abbreviation, category] of [
    ['meter', 'm', 'length'], ['second', 's', 'time'], ['radian', 'rad', 'angle'],
    ['kelvin', 'k', 'temperature'], ['gram', 'g', 'mass'],
    ['radians_per_second', 'rad_per_s', 'angularVelocity'],
    ['grams_per_centimeters_cube', 'g_per_cm3', 'density'], ['pascals', 'pa', 'pressure'],
    ['square_meter', 'm_sq', 'area'], ['newton', 'nw', 'force']
]) addSIUnit(name, abbreviation, category);

for (const [name, abbreviation, category] of [
    ['hertz', 'hz', 'frequency'], ['meters_per_second', 'm_per_s', 'velocity'],
    ['decimeters_per_second', 'dm_per_s', 'velocity'],
    ['meters_per_second_squared', 'm_per_s_sq', 'acceleration'],
    ['radians_per_second_squared', 'rad_per_s_sq', 'angularAcceleration'],
    ['min', 'min', 'time'], ['hour', 'hour', 'time'], ['day', 'day', 'time'],
    ['week', 'week', 'time'], ['month', 'month', 'time'], ['year', 'year', 'time'],
    ['newton_meter', 'Nm', 'torque'], ['foot', 'ft', 'length'], ['mile', 'mi', 'length'],
    ['nauticalMile', 'nmi', 'length'], ['degree', 'deg', 'angle'],
    ['arcminute', 'arcmin', 'angle'], ['arcsecond', 'arcsec', 'angle'],
    ['centigrade', 'degC', 'temperature'], ['fahrenheit', 'degF', 'temperature'],
    ['km_per_hour', 'kph', 'velocity'], ['miles_per_hour', 'mph', 'velocity'],
    ['knot', 'kn', 'velocity'], ['feet_per_second', 'ft_per_s', 'velocity'],
    ['feet_per_minute', 'ft_per_min', 'velocity'],
    ['degrees_per_second', 'deg_per_s', 'angularVelocity'],
    ['revolutions_per_min', 'rpm', 'angularVelocity'], ['pound', 'lb', 'mass'],
    ['kilograms_per_meters_cube', 'kg_per_m3', 'density']
]) addUnit(name, abbreviation, category);

/** Return fresh descriptors for every unit in the standard SEN registry. */
export function SenUnits() {
    return UNITS.map(({ name, abbreviation, category }) => ({
        name,
        abbreviation,
        category,
        label: FormatSenUnit(abbreviation)
    }));
}
