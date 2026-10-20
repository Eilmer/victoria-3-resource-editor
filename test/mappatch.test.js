// Unit tests for MapPatch.build: node test/mappatch.test.js
global.PdxParser = require("../js/parser.js");
const MapPatch = require("../js/mappatch.js");

let failures = 0;
function eq(label, got, want) {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) { failures++; console.log("--- got:\n" + got + "\n--- want:\n" + want); }
}

// Mimics what MapData does: one state per top-level entry
function setup(text) {
  const { root } = PdxParser.parse(text);
  const states = root.map((entry) => ({ name: entry.key, file: "f.txt", entry }));
  const sources = new Map([["f.txt", { name: "F.txt", origin: "base", text }]]);
  return { states, sources };
}
// targets: { STATE: { capped, arable, discoverable } }; a plain { resource: amounts } means discoverable
function run(text, targets) {
  const { states, sources } = setup(text);
  const wrapped = Object.entries(targets).map(([k, v]) => [k, v.capped || v.arable || v.discoverable ? v : { discoverable: v }]);
  const r = MapPatch.build(states, new Map(wrapped), sources);
  return r.files[0]?.text ?? "(no file)";
}

const src = `# comment at top
STATE_A = {
    id = 1 # keep this comment
    capped_resources = {
        bg_coal_mining = 10
    }
    resource = {
        type = "bg_oil_extraction"
        undiscovered_amount = 12
    }
    resource = {
        type = "bg_rubber"
        discovered_amount = 4
        undiscovered_amount = 6
    }
}

STATE_B = {
    id = 2
}
`;

eq("change existing value", run(src, { STATE_A: { bg_oil_extraction: { discovered: 0, undiscovered: 20 } } }),
  src.replace("undiscovered_amount = 12", "undiscovered_amount = 20"));

eq("add missing key to existing block", run(src, { STATE_A: { bg_oil_extraction: { discovered: 3, undiscovered: 12 } } }),
  src.replace(`        undiscovered_amount = 12
    }`, `        undiscovered_amount = 12
        discovered_amount = 3
    }`));

eq("remove a key that drops to zero", run(src, { STATE_A: { bg_rubber: { discovered: 0, undiscovered: 6 } } }),
  src.replace("        discovered_amount = 4\n", ""));

eq("remove whole block when both are zero", run(src, { STATE_A: { bg_rubber: { discovered: 0, undiscovered: 0 } } }),
  src.replace(`    resource = {
        type = "bg_rubber"
        discovered_amount = 4
        undiscovered_amount = 6
    }
`, ""));

eq("add new block to state", run(src, { STATE_B: { bg_gold_fields: { discovered: 0, undiscovered: 5 } } }),
  src.replace(`    id = 2
}`, `    id = 2
    resource = {
        type = "bg_gold_fields"
        undiscovered_amount = 5
    }
}`));

eq("no change -> no file", run(src, { STATE_A: { bg_oil_extraction: { discovered: 0, undiscovered: 12 } } }), "(no file)");

const tabs = "STATE_T = {\r\n\tid = 1\r\n\tresource = {\r\n\t\ttype = \"bg_rubber\"\r\n\t\tundiscovered_amount = 2\r\n\t}\r\n}\r\n";
eq("tabs + CRLF kept", run(tabs, { STATE_T: { bg_rubber: { discovered: 1, undiscovered: 2 }, bg_oil_extraction: { discovered: 0, undiscovered: 7 } } }),
  "STATE_T = {\r\n\tid = 1\r\n\tresource = {\r\n\t\ttype = \"bg_rubber\"\r\n\t\tundiscovered_amount = 2\r\n\t\tdiscovered_amount = 1\r\n\t}\r\n" +
  "\tresource = {\r\n\t\ttype = \"bg_oil_extraction\"\r\n\t\tundiscovered_amount = 7\r\n\t}\r\n}\r\n");

const oneLine = `STATE_O = { id = 3 }\n`;
eq("closing brace on same line", run(oneLine, { STATE_O: { bg_rubber: { discovered: 0, undiscovered: 1 } } }),
  `STATE_O = { id = 3 \n    resource = {\n        type = "bg_rubber"\n        undiscovered_amount = 1\n    }\n}\n`);

// ---------- Capped resources ----------

const cap = `STATE_C = {
    id = 5
    capped_resources = {
        building_coal_mine = 10
        building_logging_camp = 4
    }
    arable_land = 20
    arable_resources = { "bg_wheat_farms" "bg_rye_farms" }
}
`;

eq("capped: change a value", run(cap, { STATE_C: { capped: { building_coal_mine: 25 } } }),
  cap.replace("building_coal_mine = 10", "building_coal_mine = 25"));

eq("capped: add a new resource", run(cap, { STATE_C: { capped: { building_iron_mine: 7 } } }),
  cap.replace(`        building_logging_camp = 4
    }`, `        building_logging_camp = 4
        building_iron_mine = 7
    }`));

eq("capped: remove a resource that drops to zero", run(cap, { STATE_C: { capped: { building_logging_camp: 0 } } }),
  cap.replace("        building_logging_camp = 4\n", ""));

eq("capped: create the block when missing", run(src, { STATE_B: { capped: { building_coal_mine: 3 } } }),
  src.replace(`    id = 2
}`, `    id = 2
    capped_resources = {
        building_coal_mine = 3
    }
}`));

eq("capped: inline block", run(`STATE_I = {\n    capped_resources = { building_coal_mine = 1 }\n}\n`, { STATE_I: { capped: { building_coal_mine: 0, building_iron_mine: 2 } } }),
  `STATE_I = {\n    capped_resources = { building_iron_mine = 2 }\n}\n`);

// ---------- Arable ----------

eq("arable: add to inline list", run(cap, { STATE_C: { arable: { bg_rice_farms: true } } }),
  cap.replace(`{ "bg_wheat_farms" "bg_rye_farms" }`, `{ "bg_wheat_farms" "bg_rye_farms" "bg_rice_farms" }`));

eq("arable: remove from inline list", run(cap, { STATE_C: { arable: { bg_wheat_farms: false } } }),
  cap.replace(`{ "bg_wheat_farms" "bg_rye_farms" }`, `{ "bg_rye_farms" }`));

eq("arable: add and remove together", run(cap, { STATE_C: { arable: { bg_wheat_farms: false, bg_rice_farms: true, bg_maize_farms: true } } }),
  cap.replace(`{ "bg_wheat_farms" "bg_rye_farms" }`, `{ "bg_rye_farms" "bg_maize_farms" "bg_rice_farms" }`));

const multi = `STATE_M = {\n\tarable_resources = {\n\t\t"bg_wheat_farms"\n\t\t"bg_rye_farms"\n\t}\n}\n`;
eq("arable: multi-line list keeps one per line", run(multi, { STATE_M: { arable: { bg_rye_farms: false, bg_rice_farms: true } } }),
  `STATE_M = {\n\tarable_resources = {\n\t\t"bg_wheat_farms"\n\t\t"bg_rice_farms"\n\t}\n}\n`);

eq("arable: create the list when missing", run(src, { STATE_B: { arable: { bg_rice_farms: true } } }),
  src.replace(`    id = 2
}`, `    id = 2
    arable_resources = { "bg_rice_farms" }
}`));

eq("everything at once", run(cap, { STATE_C: {
  capped: { building_coal_mine: 12 },
  arable: { bg_rice_farms: true },
  discoverable: { bg_oil_extraction: { discovered: 0, undiscovered: 9 } },
} }), cap.replace("building_coal_mine = 10", "building_coal_mine = 12")
  .replace(`"bg_rye_farms" }`, `"bg_rye_farms" "bg_rice_farms" }`)
  .replace(`}
}
`, `}
    resource = {
        type = "bg_oil_extraction"
        undiscovered_amount = 9
    }
}
`));

console.log(failures ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures ? 1 : 0);
