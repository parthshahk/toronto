// src/city/unitkinds.js — THE SURVEYED UNIT TAXONOMY: the map from an OSM premises tag to a
// unit KIND, and from a kind to the STYLE that decides how its frontage is built.
//
// CONTRACT.md §6.2, extended for the surveyed unit data. The material convention (linear-ish scene
// albedo, emissive either exactly 0 or >= 0.50, tintable 0, profile 0) is documented in
// ./facadekit.js.
//
// data/toronto.json carries surveyed UNITS: an address, a category and a value taken from the OSM
// tags on a premises. This file is the whole of the classification: KIND_OF_VALUE and
// KIND_OF_CATEGORY are the lookup, unitKindOf() the entry point, STYLES the per-kind treatment.
// ADDING A UNIT KIND IS TWO ENTRIES IN THIS FILE — one in the lookup, one in STYLES — and no
// change anywhere else (CONTRACT Amendment 11.2, registries not switch statements).

import { MAT_GLASS } from './facadekit.js';

// Extra glazing materials, one per kind of interior you can actually see through a shopfront.
// All of them are the SAME construction as MAT_GLASS_LIT: an opaque renderer cannot see through
// a pane, so the pane carries the room behind it. What changes between them is what that room is
// — a dim bar, a fluorescent convenience store, a spotlit display window, a frosted office — and
// that is most of what tells one unit from the next at night. Emissive stays a genuine emitter
// (>= 0.50) or exactly 0; the renderer decides WHEN (CONTRACT Amendment 7).
const MAT_GLASS_WARM = [0.105, 0.070, 0.044, 0.58, 0, 0.09, 0];    // restaurant, cafe

const MAT_GLASS_DIM = [0.062, 0.040, 0.038, 0.52, 0, 0.10, 0];     // bar, pub, nightclub

export const MAT_GLASS_BRIGHT = [0.140, 0.140, 0.132, 0.72, 0, 0.08, 0];  // convenience, pharmacy

const MAT_GLASS_DISPLAY = [0.118, 0.108, 0.096, 0.64, 0, 0.07, 0]; // apparel, goods

const MAT_GLASS_FROST = [0.070, 0.072, 0.076, 0.50, 0, 0.42, 0];   // office, clinic, salon

const MAT_GLASS_PAPER = [0.086, 0.082, 0.072, 0, 0, 0.88, 0];      // vacant, papered over

const MAT_GLASS_CIVIC = [0.078, 0.076, 0.070, 0.54, 0, 0.11, 0];   // lobby, culture, hotel

// Polished granite: the one material a bank puts on the street, and the reason a branch reads
// as a branch from fifty metres before you can see the name.
export const MAT_STONE_DARK = [0.058, 0.057, 0.060, 0, 0, 0.24, 0];

// Rolling shutter, closed, and the housing box an open one lives in.
export const MAT_SHUTTER_BOX = [0.056, 0.057, 0.060, 0, 0, 0.40, 0];

// A vacant unit's leasing board.
export const MAT_BOARD = [0.150, 0.150, 0.146, 0, 0, 0.90, 0];

// Fascia colours a chain might use. Muted, like everything else in this palette, and chosen by
// hashing the BRAND STRING so every branch of the same chain gets the same fascia across the
// whole city — which is what makes a chain read as a chain. No logo, no trade dress, no real
// colour reproduced: a name in a consistent colour is where this stops.
export const FASCIA_COLS = [
  [0.086, 0.028, 0.026], [0.024, 0.052, 0.036], [0.022, 0.032, 0.070],
  [0.088, 0.062, 0.020], [0.062, 0.062, 0.064], [0.020, 0.048, 0.056],
  [0.074, 0.036, 0.052], [0.038, 0.040, 0.044],
];

// Deterministic 32-bit hash of a string. Used only to pick a brand's fascia colour, so the same
// chain is the same colour everywhere and a different chain is (almost always) a different one.
export function strHash(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/* ------------------------------------------------------------ unit kinds -- */

// OSM value -> canonical kind. The value space is long-tailed (900 restaurants, one gunsmith),
// so this maps the head explicitly and falls back on the CATEGORY, which is always one of
// shop/amenity/office/healthcare/craft/tourism/leisure/historic.
const KIND_OF_VALUE = {
  restaurant: 'food', fast_food: 'food', cafe: 'food', ice_cream: 'food', bakery: 'food',
  food_court: 'food', deli: 'food', confectionery: 'food', pastry: 'food', coffee: 'food',
  juice_bar: 'food', caterer: 'food', chocolate: 'food', tea: 'food',

  bar: 'bar', pub: 'bar', nightclub: 'bar', biergarten: 'bar', casino: 'bar',

  convenience: 'grocery', supermarket: 'grocery', variety_store: 'grocery', kiosk: 'grocery',
  greengrocer: 'grocery', butcher: 'grocery', seafood: 'grocery', alcohol: 'grocery',
  wine: 'grocery', beverages: 'grocery', tobacco: 'grocery', 'e-cigarette': 'grocery',
  cannabis: 'grocery', newsagent: 'grocery', farm: 'grocery', frozen_food: 'grocery',
  health_food: 'grocery', spices: 'grocery',

  bank: 'bank', bureau_de_change: 'bank', money_lender: 'bank', payment_centre: 'bank',

  pharmacy: 'pharmacy', chemist: 'pharmacy', medical_supply: 'pharmacy',

  dentist: 'clinic', doctors: 'clinic', clinic: 'clinic', veterinary: 'clinic',
  physiotherapist: 'clinic', optician: 'clinic', hospital: 'clinic', nursing_home: 'clinic',
  laboratory: 'clinic', psychotherapist: 'clinic', midwife: 'clinic', blood_donation: 'clinic',

  hairdresser: 'salon', beauty: 'salon', massage: 'salon', nail_salon: 'salon', tattoo: 'salon',
  barber: 'salon', spa: 'salon', cosmetics: 'salon', perfumery: 'salon', hairdresser_supply: 'salon',
  herbalist: 'salon',

  clothes: 'apparel', shoes: 'apparel', jewelry: 'apparel', bag: 'apparel', boutique: 'apparel',
  fashion_accessories: 'apparel', watches: 'apparel', second_hand: 'apparel', fabric: 'apparel',
  leather: 'apparel', tailor: 'apparel', charity: 'apparel', department_store: 'apparel',
  clothes_alteration: 'apparel',

  gift: 'goods', books: 'goods', furniture: 'goods', electronics: 'goods', mobile_phone: 'goods',
  computer: 'goods', toys: 'goods', sports: 'goods', music: 'goods', musical_instrument: 'goods',
  art: 'goods', hardware: 'goods', doityourself: 'goods', florist: 'goods', pet: 'goods',
  bicycle: 'goods', photo: 'goods', stationery: 'goods', mall: 'goods', video_games: 'goods',
  interior_decoration: 'goods', houseware: 'goods', lighting: 'goods', antiques: 'goods',
  garden_centre: 'goods', party: 'goods', trade: 'goods', appliance: 'goods', paint: 'goods',
  outdoor: 'goods', craft: 'goods', collector: 'goods', erotic: 'goods', frame: 'goods',
  carpet: 'goods', bed: 'goods', kitchen: 'goods', curtain: 'goods', tiles: 'goods',
  perfume: 'goods', model: 'goods', games: 'goods', comics: 'goods',

  dry_cleaning: 'service', laundry: 'service', copyshop: 'service', travel_agency: 'service',
  key_cutter: 'service', funeral_directors: 'service', car_repair: 'service', locksmith: 'service',
  shoe_repair: 'service', repair: 'service', printer: 'service', driving_school: 'service',
  storage_rental: 'service', pawnbroker: 'service', ticket: 'service', post_office: 'service',
  car_rental: 'service', bicycle_repair: 'service', internet_cafe: 'service', money_transfer: 'service',

  fitness_centre: 'gym', gym: 'gym', sports_centre: 'gym', dance: 'gym', yoga: 'gym',
  swimming_pool: 'gym', dojo: 'gym',

  hotel: 'hotel', hostel: 'hotel', guest_house: 'hotel', motel: 'hotel', apartment: 'hotel',

  theatre: 'culture', cinema: 'culture', museum: 'culture', gallery: 'culture', artwork: 'culture',
  arts_centre: 'culture', library: 'culture', community_centre: 'culture', attraction: 'culture',
  place_of_worship: 'culture', studio: 'culture', events_venue: 'culture', exhibition_centre: 'culture',
  music_venue: 'culture', viewpoint: 'culture', gallery_shop: 'culture',

  townhall: 'civic', police: 'civic', fire_station: 'civic', courthouse: 'civic', embassy: 'civic',
  school: 'civic', college: 'civic', university: 'civic', social_facility: 'civic',
  childcare: 'civic', kindergarten: 'civic', prep_school: 'civic', language_school: 'civic',
  music_school: 'civic', public_building: 'civic', shelter: 'civic', monastery: 'civic',

  vacant: 'vacant', disused: 'vacant', empty: 'vacant', no: 'vacant',

  parking_entrance: 'vehicle', parking: 'vehicle', loading_dock: 'vehicle', car_wash: 'vehicle',
  fuel: 'vehicle', car: 'vehicle', motorcycle: 'vehicle', driving_range: 'vehicle',

  vending_machine: 'fixture', atm: 'fixture', telephone: 'fixture', toilets: 'fixture',
  bicycle_parking: 'fixture', bench: 'fixture', waste_basket: 'fixture', recycling: 'fixture',
  drinking_water: 'fixture', clock: 'fixture', fountain: 'fixture', post_box: 'fixture',
  charging_station: 'fixture', car_sharing: 'fixture', parking_space: 'fixture',
  picnic_table: 'fixture', memorial: 'fixture', monument: 'fixture', information: 'fixture',
  taxi: 'fixture', bbq: 'fixture', water_point: 'fixture', letter_box: 'fixture',
  motorcycle_parking: 'fixture', bicycle_rental: 'fixture', luggage_locker: 'fixture',
  photo_booth: 'fixture', smoking_area: 'fixture', give_box: 'fixture', bicycle_repair_station: 'fixture',
};

const KIND_OF_CATEGORY = {
  shop: 'goods', amenity: 'service', office: 'office', healthcare: 'clinic',
  craft: 'service', tourism: 'culture', leisure: 'gym', historic: 'fixture',
};

/**
 * Canonical unit kind for one surveyed record. `cat` is the OSM key (shop, amenity, office...)
 * and `value` its value. Always returns a kind that unitStyle() knows.
 * @returns {string}
 */
export function unitKindOf(cat, value) {
  const v = typeof value === 'string' ? value : '';
  const k = KIND_OF_VALUE[v];
  if (k) return k;
  // "waste_basket;recycling" and friends: OSM allows a semicolon list.
  const semi = v.indexOf(';');
  if (semi > 0) {
    const k2 = KIND_OF_VALUE[v.slice(0, semi)];
    if (k2) return k2;
  }
  return KIND_OF_CATEGORY[cat] || 'service';
}

/* ------------------------------------------------------------ unit styles - */

// One record per kind. Everything a unit front looks like comes out of this table, which is the
// whole point: a cafe, a bank, a hairdresser, a convenience store, a restaurant and a vacant unit
// do not look alike, and the only way to keep that true across 8,451 surveyed units and the
// synthesised ones between them is to say once, in one place, how each of them differs.
//
//   glaz  fraction of the window zone that is glass (the rest is spandrel panel)
//   bulk  stall riser height, m — a bank's is stone and knee-high, a display window has none
//   fasc  fascia height as a fraction of the shopfront zone
//   proj  fascia projection, m
//   bay   target bay width between mullions, m
//   pil   pilaster half-width, m
//   door  'recess' | 'flush' | 'solid' | 'vehicle' | 'none'
//   glass which glazing material the interior reads as
//   awn   probability of a fabric awning
//   shut  probability of a rolling shutter (its housing shows even when it is open)
//   patio probability of a sidewalk patio
//   lit   probability the fascia sign is internally lit rather than painted
//   cap   sign cap height, m
//   stone true = polished stone bulkhead and pilasters instead of painted host material
const STYLES = {
  food: { glaz: 1.00, bulk: 0.42, fasc: 0.17, proj: 0.20, bay: 2.9, pil: 0.10, door: 'recess', glass: MAT_GLASS_WARM, awn: 0.52, shut: 0.05, patio: 0.34, lit: 0.55, cap: 0.30, stone: false },
  bar: { glaz: 0.62, bulk: 0.66, fasc: 0.19, proj: 0.24, bay: 3.3, pil: 0.13, door: 'recess', glass: MAT_GLASS_DIM, awn: 0.22, shut: 0.10, patio: 0.30, lit: 0.72, cap: 0.32, stone: false },
  grocery: { glaz: 1.00, bulk: 0.30, fasc: 0.21, proj: 0.18, bay: 2.6, pil: 0.09, door: 'flush', glass: MAT_GLASS_BRIGHT, awn: 0.34, shut: 0.55, patio: 0.04, lit: 0.86, cap: 0.31, stone: false },
  bank: { glaz: 0.74, bulk: 0.72, fasc: 0.15, proj: 0.26, bay: 3.6, pil: 0.22, door: 'flush', glass: MAT_GLASS_FROST, awn: 0.00, shut: 0.00, patio: 0.00, lit: 0.40, cap: 0.28, stone: true },
  pharmacy: { glaz: 0.96, bulk: 0.36, fasc: 0.20, proj: 0.18, bay: 2.8, pil: 0.09, door: 'flush', glass: MAT_GLASS_BRIGHT, awn: 0.10, shut: 0.22, patio: 0.00, lit: 0.80, cap: 0.30, stone: false },
  clinic: { glaz: 0.58, bulk: 0.52, fasc: 0.14, proj: 0.14, bay: 3.1, pil: 0.11, door: 'flush', glass: MAT_GLASS_FROST, awn: 0.06, shut: 0.02, patio: 0.00, lit: 0.18, cap: 0.24, stone: false },
  salon: { glaz: 0.80, bulk: 0.48, fasc: 0.16, proj: 0.16, bay: 2.7, pil: 0.10, door: 'flush', glass: MAT_GLASS_FROST, awn: 0.20, shut: 0.14, patio: 0.02, lit: 0.44, cap: 0.27, stone: false },
  apparel: { glaz: 1.00, bulk: 0.18, fasc: 0.13, proj: 0.14, bay: 3.4, pil: 0.08, door: 'recess', glass: MAT_GLASS_DISPLAY, awn: 0.16, shut: 0.18, patio: 0.00, lit: 0.30, cap: 0.28, stone: false },
  goods: { glaz: 0.94, bulk: 0.34, fasc: 0.16, proj: 0.17, bay: 3.0, pil: 0.10, door: 'recess', glass: MAT_GLASS_DISPLAY, awn: 0.26, shut: 0.24, patio: 0.00, lit: 0.38, cap: 0.28, stone: false },
  service: { glaz: 0.64, bulk: 0.50, fasc: 0.15, proj: 0.14, bay: 2.8, pil: 0.10, door: 'flush', glass: MAT_GLASS_FROST, awn: 0.14, shut: 0.16, patio: 0.00, lit: 0.24, cap: 0.25, stone: false },
  office: { glaz: 0.66, bulk: 0.56, fasc: 0.12, proj: 0.12, bay: 3.2, pil: 0.13, door: 'flush', glass: MAT_GLASS_FROST, awn: 0.00, shut: 0.02, patio: 0.00, lit: 0.14, cap: 0.22, stone: true },
  gym: { glaz: 1.00, bulk: 0.26, fasc: 0.14, proj: 0.15, bay: 3.6, pil: 0.09, door: 'flush', glass: MAT_GLASS_BRIGHT, awn: 0.04, shut: 0.06, patio: 0.00, lit: 0.46, cap: 0.29, stone: false },
  hotel: { glaz: 0.86, bulk: 0.40, fasc: 0.12, proj: 0.22, bay: 3.4, pil: 0.16, door: 'recess', glass: MAT_GLASS_CIVIC, awn: 0.10, shut: 0.00, patio: 0.10, lit: 0.34, cap: 0.26, stone: true },
  culture: { glaz: 0.72, bulk: 0.46, fasc: 0.18, proj: 0.26, bay: 3.5, pil: 0.18, door: 'recess', glass: MAT_GLASS_CIVIC, awn: 0.06, shut: 0.02, patio: 0.06, lit: 0.62, cap: 0.32, stone: true },
  civic: { glaz: 0.60, bulk: 0.58, fasc: 0.12, proj: 0.20, bay: 3.3, pil: 0.18, door: 'recess', glass: MAT_GLASS_CIVIC, awn: 0.00, shut: 0.00, patio: 0.00, lit: 0.12, cap: 0.24, stone: true },
  vacant: { glaz: 1.00, bulk: 0.44, fasc: 0.16, proj: 0.16, bay: 3.0, pil: 0.10, door: 'flush', glass: MAT_GLASS_PAPER, awn: 0.04, shut: 0.42, patio: 0.00, lit: 0.00, cap: 0.26, stone: false },
  vehicle: { glaz: 0.00, bulk: 0.00, fasc: 0.12, proj: 0.12, bay: 3.0, pil: 0.14, door: 'vehicle', glass: MAT_GLASS_FROST, awn: 0.00, shut: 0.00, patio: 0.00, lit: 0.20, cap: 0.22, stone: false },
  fixture: { glaz: 0.70, bulk: 0.48, fasc: 0.13, proj: 0.13, bay: 3.0, pil: 0.10, door: 'none', glass: MAT_GLASS_FROST, awn: 0.00, shut: 0.00, patio: 0.00, lit: 0.00, cap: 0.00, stone: false },
  // A house front: the door and its two flanking windows, which is what most of the stock north
  // of Queen actually presents to the street.
  house: { glaz: 0.42, bulk: 0.70, fasc: 0.00, proj: 0.10, bay: 2.2, pil: 0.11, door: 'flush', glass: MAT_GLASS_FROST, awn: 0.00, shut: 0.00, patio: 0.00, lit: 0.00, cap: 0.00, stone: false },
  // An envelope or industrial elevation: a steel door, a plinth and nothing else.
  depot: { glaz: 0.16, bulk: 0.85, fasc: 0.00, proj: 0.10, bay: 3.4, pil: 0.12, door: 'solid', glass: MAT_GLASS, awn: 0.00, shut: 0.06, patio: 0.00, lit: 0.00, cap: 0.00, stone: false },
  // THE PARTY WALL. Not a shop at all — the stretch of elevation between two of them, and the
  // whole ground floor of a building that presents nothing to this street. Deliberately the
  // cheapest thing in the table: a plinth and a punched opening or two. It is applied to about
  // half the frontage in the city, so anything more elaborate here costs more vertices than
  // every shopfront put together and returns a detail nobody looks at.
  blank: { glaz: 0.34, bulk: 0.62, fasc: 0.00, proj: 0.10, bay: 3.2, pil: 0.12, door: 'none', glass: MAT_GLASS, awn: 0.00, shut: 0.00, patio: 0.00, lit: 0.00, cap: 0.00, stone: false, plain: true },
  lobby: { glaz: 0.90, bulk: 0.30, fasc: 0.10, proj: 0.18, bay: 3.4, pil: 0.16, door: 'lobby', glass: MAT_GLASS_CIVIC, awn: 0.00, shut: 0.00, patio: 0.00, lit: 0.16, cap: 0.24, stone: true },
};
for (const k in STYLES) Object.freeze(STYLES[k]);
Object.freeze(STYLES);

/** The style record for a canonical kind. Unknown kinds get the generic service front. */
export function unitStyle(kind) {
  return STYLES[kind] || STYLES.service;
}

/** Every kind unitStyle() knows, for the harness. @returns {string[]} */
export function unitKinds() {
  return Object.keys(STYLES);
}

/* ---------------------------------------------------------- unit builders - */
