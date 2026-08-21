// src/props/materials.js — the prop palette.
//
// Scene albedo in the low-key blue-hour band city.js uses for ground cover, never display colours.
// One table so a material is defined once and every domain module in props/ reads the same one.
// Conventions: see ./kit.js.


export const M = {
  // --- metals -------------------------------------------------------------
  poleGrey: [0.082, 0.085, 0.092, 0, 0, 0.42, 0],   // anodised aluminium mast
  poleDark: [0.040, 0.042, 0.047, 0, 0, 0.36, 0],   // heritage black cast iron
  galv: [0.115, 0.118, 0.126, 0, 0, 0.46, 0],       // hot-dip galvanised
  steel: [0.090, 0.093, 0.099, 0, 0, 0.28, 0],
  castIron: [0.050, 0.051, 0.055, 0, 0, 0.62, 0],
  lampBody: [0.096, 0.098, 0.103, 0, 0, 0.34, 0],   // LED head casing
  signalBody: [0.034, 0.037, 0.035, 0, 0, 0.44, 0], // signal heads are near-black

  // --- masonry, timber, plastics -----------------------------------------
  concrete: [0.120, 0.121, 0.125, 0, 0, 0.90, 0],
  granite: [0.088, 0.088, 0.093, 0, 0, 0.58, 0],
  woodSlat: [0.104, 0.074, 0.049, 0, 0, 0.84, 0],
  glass: [0.028, 0.036, 0.048, 0, 0, 0.07, 0],
  dark: [0.014, 0.015, 0.017, 0, 0, 0.68, 0],       // apertures, recesses, unlit lenses
  soil: [0.036, 0.030, 0.025, 0, 0, 0.94, 0],
  grateIron: [0.038, 0.039, 0.042, 0, 0, 0.56, 0],

  // --- painted furniture --------------------------------------------------
  postRed: [0.300, 0.036, 0.028, 0, 0, 0.55, 0],    // Canada Post
  hydBody: [0.330, 0.268, 0.052, 0, 0, 0.62, 0],    // hydrant yellow
  hydCap: [0.052, 0.108, 0.225, 0, 0, 0.62, 0],     // colour-coded bonnet
  binBody: [0.068, 0.071, 0.076, 0, 0, 0.55, 0],    // waste stream
  binRecycle: [0.036, 0.070, 0.094, 0, 0, 0.55, 0], // recycling stream
  binHood: [0.046, 0.048, 0.052, 0, 0, 0.44, 0],
  greenP: [0.038, 0.100, 0.055, 0, 0, 0.55, 0],
  signGreen: [0.028, 0.084, 0.050, 0, 0, 0.70, 0],  // provincial/regional route blade
  signWhite: [0.230, 0.233, 0.238, 0, 0, 0.72, 0],
  signRed: [0.250, 0.040, 0.034, 0, 0, 0.70, 0],
  // Toronto's own street blade: white reflective sheet, blue legend and a blue border, with the
  // heritage districts (Old Town, the Distillery, Yorkville) on a brown ground instead. The
  // LETTERING is drawn by text.js into the signage mesh; these are the plates it sits on.
  bladeWhite: [0.244, 0.247, 0.252, 0, 0, 0.66, 0],
  bladeBlue: [0.022, 0.040, 0.112, 0, 0, 0.62, 0],
  bladeBrown: [0.062, 0.040, 0.026, 0, 0, 0.70, 0],
  cabGrey: [0.086, 0.088, 0.090, 0, 0, 0.72, 0],
  cabGreen: [0.048, 0.068, 0.052, 0, 0, 0.72, 0],
  cabBeige: [0.110, 0.104, 0.088, 0, 0, 0.74, 0],

  // --- vegetation ---------------------------------------------------------
  bark: [0.054, 0.045, 0.037, 0, 0, 0.92, 0],
  barkPale: [0.068, 0.060, 0.050, 0, 0, 0.92, 0],
  foliage: [0.033, 0.054, 0.035, 0, 0, 0.95, 0],
  foliageWarm: [0.044, 0.058, 0.031, 0, 0, 0.95, 0],
  foliageCool: [0.028, 0.050, 0.040, 0, 0, 0.95, 0],

  // --- emitters (emissive >= 0.50, see the header) ------------------------
  ledWhite: [1.000, 0.930, 0.780, 1.00, 0, 0.55, 0],
  sodium: [1.000, 0.600, 0.220, 1.00, 0, 0.58, 0],
  acornWarm: [1.000, 0.820, 0.520, 0.92, 0, 0.30, 0],
  sigRed: [1.000, 0.120, 0.080, 0.85, 0, 0.40, 0],
  sigAmber: [1.000, 0.520, 0.060, 0.85, 0, 0.40, 0],
  sigGreen: [0.180, 1.000, 0.420, 0.85, 0, 0.40, 0],
  sigHand: [1.000, 0.400, 0.100, 0.80, 0, 0.40, 0],
  adPanel: [0.880, 0.915, 1.000, 0.70, 0, 0.20, 0],
  screen: [0.280, 0.880, 0.540, 0.55, 0, 0.25, 0],

  // --- roofscape, vehicles, marine and works ------------------------------
  // Same rules as everything above: albedo + roughness only, profile 0, emissive 0 unless the
  // surface is a real lamp. Nothing here encodes a time of day.
  alum: [0.140, 0.143, 0.150, 0, 0, 0.40, 0],       // mill-finish aluminium panel
  galvPale: [0.148, 0.152, 0.160, 0, 0, 0.50, 0],   // new galvanised sheet
  craneYellow: [0.300, 0.232, 0.048, 0, 0, 0.70, 0],
  craneWhite: [0.205, 0.208, 0.212, 0, 0, 0.72, 0],
  rustRed: [0.148, 0.062, 0.042, 0, 0, 0.88, 0],
  plywood: [0.132, 0.098, 0.062, 0, 0, 0.90, 0],    // sidewalk hoarding ply
  timber: [0.116, 0.088, 0.060, 0, 0, 0.88, 0],     // quay decking
  carGlass: [0.020, 0.024, 0.030, 0, 0, 0.06, 0],
  tyre: [0.016, 0.016, 0.017, 0, 0, 0.90, 0],
  chrome: [0.145, 0.148, 0.154, 0, 0, 0.12, 0],
  lampRed: [0.180, 0.030, 0.026, 0, 0, 0.55, 0],    // UNLIT tail-lamp lens
  lampClear: [0.180, 0.176, 0.165, 0, 0, 0.30, 0],  // UNLIT head-lamp lens
  taxiOrange: [0.300, 0.170, 0.020, 0, 0, 0.60, 0],
  hullWhite: [0.215, 0.220, 0.226, 0, 0, 0.55, 0],
  hullNavy: [0.026, 0.034, 0.062, 0, 0, 0.50, 0],
  canvas: [0.180, 0.168, 0.148, 0, 0, 0.92, 0],
  canvasRed: [0.190, 0.052, 0.044, 0, 0, 0.92, 0],
  flagRed: [0.260, 0.036, 0.032, 0, 0, 0.90, 0],
  flagWhite: [0.235, 0.238, 0.242, 0, 0, 0.90, 0],
  binGreen: [0.040, 0.078, 0.048, 0, 0, 0.78, 0],
  binBlue: [0.032, 0.056, 0.092, 0, 0, 0.78, 0],
  railSilver: [0.128, 0.131, 0.136, 0, 0, 0.42, 0],
  railGreen: [0.030, 0.058, 0.040, 0, 0, 0.66, 0],
  railMaroon: [0.086, 0.030, 0.032, 0, 0, 0.66, 0],
  chalk: [0.070, 0.068, 0.064, 0, 0, 0.92, 0],

  // --- surveyed street furniture (the OSM node classes) --------------------
  ttcRed: [0.252, 0.032, 0.030, 0, 0, 0.58, 0],         // TTC stop flag and subway pylon
  ttcCream: [0.196, 0.192, 0.178, 0, 0, 0.76, 0],
  vendFront: [0.046, 0.048, 0.054, 0, 0, 0.30, 0],      // vending machine glazing surround
  slate: [0.058, 0.059, 0.062, 0, 0, 0.88, 0],          // asphalt shingle / slate roof
  clayTile: [0.108, 0.058, 0.040, 0, 0, 0.86, 0],       // clay pantile
  roofTin: [0.104, 0.106, 0.111, 0, 0, 0.48, 0],        // standing-seam metal roof

  // --- waterfront (CONTRACT §8.3) -----------------------------------------
  // Harbour hardware is a small, specific material set: cast iron that has been painted black
  // and re-painted for a century, hot-dip galvanised steel, creosoted timber, quarried armour
  // stone, and the one saturated colour on the whole quay — the lifebuoy.
  quayIron: [0.044, 0.045, 0.048, 0, 0, 0.58, 0],       // bollards, ladders, cast fittings
  quayTimber: [0.092, 0.066, 0.044, 0, 0, 0.88, 0],     // decking and fender timber
  pileTimber: [0.048, 0.036, 0.027, 0, 0, 0.92, 0],     // creosoted pile, dark and matte
  armourStone: [0.070, 0.069, 0.066, 0, 0, 0.94, 0],    // dolostone armour block
  floatDeck: [0.104, 0.106, 0.110, 0, 0, 0.72, 0],      // GRP / concrete floating dock
  lifeRing: [0.320, 0.108, 0.026, 0, 0, 0.74, 0],       // lifebuoy orange
  buoyYellow: [0.260, 0.196, 0.030, 0, 0, 0.66, 0],     // mooring buoy
  markerRed: [0.230, 0.036, 0.030, 0, 0, 0.68, 0],      // port-hand daymark
  markerGreen: [0.030, 0.130, 0.062, 0, 0, 0.68, 0],    // starboard-hand daymark

  // --- further emitters (emissive >= 0.50) --------------------------------
  beaconRed: [1.000, 0.090, 0.060, 0.90, 0, 0.40, 0],   // aviation obstruction light
  shedLamp: [1.000, 0.940, 0.820, 0.85, 0, 0.55, 0],    // under-deck lamp on a sidewalk shed
  navRed: [1.000, 0.140, 0.090, 0.80, 0, 0.35, 0],      // port-hand navigation light
  navGreen: [0.140, 1.000, 0.360, 0.80, 0, 0.35, 0],    // starboard-hand navigation light
  quayLamp: [1.000, 0.900, 0.740, 0.80, 0, 0.55, 0],    // lifebuoy-station lamp

  // --- the islands and the airfield (the south half of the map) ------------
  // The Toronto Islands are parkland and the airfield is mown grass and asphalt, so this set is
  // deliberately warmer and greener than the downtown palette above. Same rules throughout:
  // albedo and roughness only, profile 0, emissive 0 unless the surface is a real lamp.
  sandDry: [0.148, 0.132, 0.101, 0, 0, 0.95, 0],        // dry beach sand, backshore
  sandWet: [0.056, 0.050, 0.041, 0, 0, 0.58, 0],        // the swash zone, still wet
  duneGrass: [0.048, 0.058, 0.032, 0, 0, 0.96, 0],      // marram on the back of the beach
  hedgeLeaf: [0.024, 0.044, 0.026, 0, 0, 0.96, 0],      // clipped privet, denser than a canopy
  bloomWarm: [0.190, 0.086, 0.034, 0, 0, 0.94, 0],      // bedding plants, the one warm accent
  bloomCool: [0.078, 0.056, 0.140, 0, 0, 0.94, 0],
  bloomPale: [0.185, 0.176, 0.150, 0, 0, 0.94, 0],
  bedSoil: [0.030, 0.024, 0.019, 0, 0, 0.96, 0],        // turned bed, darker than path soil

  aircraftWhite: [0.228, 0.231, 0.238, 0, 0, 0.32, 0],  // painted airframe
  aircraftGrey: [0.116, 0.120, 0.127, 0, 0, 0.34, 0],   // unpainted panel, radome, nacelle
  aircraftTrim: [0.020, 0.031, 0.056, 0, 0, 0.30, 0],   // cheatline and fin
  cabinGlass: [0.015, 0.019, 0.025, 0, 0, 0.05, 0],
  propBlade: [0.024, 0.025, 0.027, 0, 0, 0.28, 0],
  hangarClad: [0.126, 0.129, 0.136, 0, 0, 0.50, 0],     // profiled steel sheet
  hangarDoor: [0.094, 0.096, 0.102, 0, 0, 0.46, 0],
  chainLink: [0.070, 0.073, 0.077, 0, 0, 0.62, 0],
  windsockFlag: [0.310, 0.140, 0.021, 0, 0, 0.92, 0],

  lightStone: [0.150, 0.147, 0.138, 0, 0, 0.86, 0],     // Gibraltar Point: limewashed rubble
  lightTrim: [0.118, 0.030, 0.026, 0, 0, 0.58, 0],
  ferryHull: [0.024, 0.038, 0.066, 0, 0, 0.42, 0],
  ferryHouse: [0.212, 0.215, 0.221, 0, 0, 0.54, 0],
  ferryDeck: [0.056, 0.058, 0.062, 0, 0, 0.74, 0],
  rideRed: [0.215, 0.038, 0.032, 0, 0, 0.62, 0],        // Centreville fairground paint
  rideCream: [0.205, 0.190, 0.150, 0, 0, 0.64, 0],
  rideGold: [0.190, 0.145, 0.038, 0, 0, 0.40, 0],
  shingle: [0.048, 0.044, 0.042, 0, 0, 0.92, 0],        // asphalt shingle on an island cottage
  boardRail: [0.086, 0.062, 0.041, 0, 0, 0.88, 0],      // boardwalk handrail timber

  // --- aeronautical and navigation emitters (emissive >= 0.50) ------------
  // Amendment 7: these are the only new light sources in the south half. A runway edge light, a
  // threshold bar and a lighthouse lantern are all genuine lamps; the renderer decides when.
  signYellow: [0.360, 0.268, 0.036, 0, 0, 0.72, 0],    // taxiway location sign face
  signRed: [0.300, 0.036, 0.030, 0, 0, 0.72, 0],       // runway holding position sign face
  runwayEdge: [1.000, 0.958, 0.880, 0.95, 0, 0.34, 0],
  runwayGreen: [0.120, 1.000, 0.340, 0.92, 0, 0.34, 0], // threshold
  runwayRed: [1.000, 0.120, 0.088, 0.92, 0, 0.34, 0],   // runway end
  taxiBlue: [0.170, 0.350, 1.000, 0.85, 0, 0.34, 0],    // taxiway edge
  approachLamp: [1.000, 0.972, 0.930, 1.00, 0, 0.28, 0],
  lanternLight: [1.000, 0.902, 0.715, 1.00, 0, 0.18, 0],
};

export const NEWSBOX_COLOURS = [
  [0.040, 0.062, 0.150, 0, 0, 0.60, 0],   // broadsheet blue
  [0.190, 0.150, 0.030, 0, 0, 0.60, 0],   // listings yellow
  [0.150, 0.030, 0.030, 0, 0, 0.60, 0],   // tabloid red
  [0.062, 0.064, 0.068, 0, 0, 0.60, 0],   // plain grey
];

export const CABINET_COLOURS = [M.cabGrey, M.cabGreen, M.cabBeige, M.cabGrey];

// Parked-car bodywork. Deliberately low-key: a Toronto kerb is mostly white, silver, grey and
// black, with the occasional dark red or blue. Bright paint punches out of the image.
export const CAR_COLOURS = [
  [0.210, 0.214, 0.220, 0, 0, 0.30, 0],   // white
  [0.126, 0.130, 0.136, 0, 0, 0.26, 0],   // silver
  [0.062, 0.064, 0.068, 0, 0, 0.28, 0],   // graphite
  [0.024, 0.025, 0.027, 0, 0, 0.24, 0],   // black
  [0.098, 0.032, 0.030, 0, 0, 0.28, 0],   // dark red
  [0.028, 0.040, 0.072, 0, 0, 0.28, 0],   // navy
  [0.040, 0.056, 0.048, 0, 0, 0.30, 0],   // dark green
];

export const DUMPSTER_COLOURS = [M.binGreen, M.binBlue, M.rustRed, M.cabGreen];

export const BOAT_HULLS = [M.hullWhite, M.hullNavy, M.hullWhite, M.granite];

export const RAIL_LIVERY = [M.railSilver, M.railGreen, M.railMaroon];
