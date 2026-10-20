// Unit tests for Exporter: node test/exporter.test.js
global.PdxParser = require("../js/parser.js");
const Exporter = require("../js/exporter.js");

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
}

const settings = structuredClone(Exporter.DEFAULT_SETTINGS);
const buildingOf = (g) => Exporter.resolveBuilding(g, settings, {}).building;

// Map data that names buildings directly (building_gold_mine = 10) must not get a second prefix
check("building_ keys are used as-is", buildingOf("building_gold_mine") === "building_gold_mine", buildingOf("building_gold_mine"));
check("bg_ keys are converted", buildingOf("bg_gold_mining") === "building_gold_mine", buildingOf("bg_gold_mining"));
check("bg_ farm keys are converted", buildingOf("bg_wheat_farms") === "building_wheat_farm", buildingOf("bg_wheat_farms"));

const changes = new Map([["STATE_X", {
  capped: { building_gold_mine: 3 },
  arable: { building_rice_farm: 1, building_wheat_farm: -1 },
  discovered: {}, undiscovered: {},
}]]);
const { text } = Exporter.generate(changes, settings, buildingOf);
check("no building_building_ in output", !text.includes("building_building_"), text);
check("capped change uses the building name", /type = building_gold_mine\s+amount = 3/.test(text), text);
check("arable add/remove use the building name",
  text.includes("add_resource_potential = building_rice_farm") && text.includes("remove_resource_potential = building_wheat_farm"), text);

// Importing it back maps buildings to the same keys
const groups = ["building_gold_mine", "building_rice_farm", "building_wheat_farm"];
const back = Exporter.importHistory(text, (b) => groups.find((g) => buildingOf(g) === b), () => false);
const x = back.changes.get("STATE_X");
check("round trip with building_ keys", x?.capped.building_gold_mine === 3 && x?.arable.building_rice_farm === 1 && x?.arable.building_wheat_farm === -1, JSON.stringify(x));

// Settings saved by older versions
check("old 'history' setting becomes undiscovered-only", Exporter.normalizeSettings({ discoveredTarget: "history" }).target === "undiscovered");
check("old 'map' setting becomes discoverable", Exporter.normalizeSettings({ discoveredTarget: "map" }).target === "discoverable");
check("history file skips everything in 'all' mode", Exporter.generate(changes, { ...settings, target: "all" }, buildingOf).empty);

console.log(failures ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures ? 1 : 0);
