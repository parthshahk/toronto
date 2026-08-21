// src/props/index.js — the props barrel and the prop registry.
//
// CONTRACT.md §6.1 and Amendment 11.1/11.2. Zero dependencies. World axes: X = east, Y = up,
// Z = south, true metres.
//
// props/ holds every piece of hardware that stands on the ground, on a roof, on the water or on a
// runway: the things that are neither terrain, nor road surface, nor building envelope. It used to
// be one flat file of ~60 append* builders; it is now one module per DOMAIN, each of which
// publishes its builders through a BUILDERS map. This file merges those maps and re-exports every
// builder by name, so the public surface is unchanged from the old src/props.js.
//
// THE CONVENTIONS EVERY BUILDER OBEYS — orientation, the (x, y, z) datum, the vertex channels,
// winding, and the rule that nothing here allocates or keeps state between calls — are documented
// once, in ./kit.js. Read that first.
//
// Builders are PURE: build(mb, ...) appends into a MeshBuilder the caller owns and returns either
// nothing or a vertex count. Nothing in props/ creates a Mesh, reads data/toronto.json, or knows
// which tile it is being built for, so tiles may be built independently and in any order.

import { BUILDERS as LIGHTING } from './lighting.js';
import { BUILDERS as FURNITURE } from './furniture.js';
import { BUILDERS as VEGETATION } from './vegetation.js';
import { BUILDERS as VEHICLES } from './vehicles.js';
import { BUILDERS as PEOPLE } from './people.js';
import { BUILDERS as MARINE } from './marine.js';
import { BUILDERS as STRUCTURES } from './structures.js';
import { BUILDERS as ROOFTOP } from './rooftop.js';
import { BUILDERS as AIRFIELD } from './airfield.js';

// lighting
export {
  appendCobraLamp, appendTwinCobraLamp, appendAcornLamp, appendPedestrianLamp,
  appendCatenaryPole, appendTrafficSignal, bladeLength, appendSignPost, appendUtilityPole,
} from './lighting.js';

// furniture
export {
  appendBench, appendLitterBin, appendBikeRing, appendBollard, appendPlanter, appendHydrant,
  appendMailbox, appendNewsBox, appendParkingMachine, appendTransitShelter,
  appendPlatformShelter, appendManhole, appendGrate, appendUtilityBox, appendPatioSet,
  appendSandwichBoard, appendDumpster, appendPicnicTable, appendLifeguardChair, appendStopFlag,
  appendDrinkingFountain, appendVendingMachine, appendPayphone, appendBikeCorral,
  appendFountainBasin,
} from './furniture.js';

// vegetation
export {
  appendStreetTree, appendParkTree, appendShrub, appendCanopyTree, appendHedgeRun,
  appendFlowerBed, appendBeachGrass,
} from './vegetation.js';

// vehicles
export { appendParkedCar, appendRailCar } from './vehicles.js';

// people
export {
  appendPedestrian, appendPedestrianGroup, appendCyclist, appendDogWalker,
} from './people.js';

// marine
export {
  appendBoat, appendFerryDock, appendMooringBollard, appendQuayLadder, appendLifebuoyStation,
  appendQuayRailing, appendTimberBench, appendWaveRock, appendGangway, appendNavMarker,
  appendMooringBuoy, appendDolphin, appendLighthouse, appendIslandFerry, appendSlipway,
} from './marine.js';

// structures
export {
  appendConstructionCrane, appendScaffold, appendChainFence, appendCarousel, appendRidePad,
  appendTimberRail, appendGableRoof, appendPitchedRoof, appendSubwayEntrance, appendBillboard,
  appendAdColumn,
} from './structures.js';

// rooftop
export {
  appendTowerSign, appendRooftopUnit, appendElevatorPenthouse, appendCoolingTower,
  appendRoofAntenna, appendWindowRig, appendSatelliteDish, appendACondenser, appendFlagPole,
} from './rooftop.js';

// airfield
export {
  appendRunwayLight, appendApproachMast, appendWindsock, appendHangar, appendAirliner,
  appendLightPlane, appendAirstairs, appendGSECart, appendAirfieldSign,
} from './airfield.js';

/* ================================================================ registry = */
// The prop registry. Every builder in props/ is reachable by name, grouped by the domain module
// it lives in, so a caller that dispatches on a surveyed feature kind can look a builder up
// instead of switching on it. Adding a prop type is a new builder plus one entry in its domain's
// BUILDERS map; adding a whole DOMAIN is a new file, one import, and one line in each of the two
// lists below.

export const DOMAINS = Object.freeze({
  lighting: LIGHTING,
  furniture: FURNITURE,
  vegetation: VEGETATION,
  vehicles: VEHICLES,
  people: PEOPLE,
  marine: MARINE,
  structures: STRUCTURES,
  rooftop: ROOFTOP,
  airfield: AIRFIELD,
});

export const PROPS = Object.freeze(Object.assign({},
  LIGHTING,
  FURNITURE,
  VEGETATION,
  VEHICLES,
  PEOPLE,
  MARINE,
  STRUCTURES,
  ROOFTOP,
  AIRFIELD,
));

/** The builder registered under `name`, or null. Never throws on an unknown name. */
export function propBuilder(name) {
  return Object.prototype.hasOwnProperty.call(PROPS, name) ? PROPS[name] : null;
}

/** Every registered builder name, in domain order. */
export function propNames() {
  return Object.keys(PROPS);
}

/** The domain a builder belongs to, or null. */
export function propDomain(name) {
  for (const d of Object.keys(DOMAINS)) {
    if (Object.prototype.hasOwnProperty.call(DOMAINS[d], name)) return d;
  }
  return null;
}
