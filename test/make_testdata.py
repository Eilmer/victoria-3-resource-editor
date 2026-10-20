# Builds a tiny fake map_data folder (and a "mod" overlay) for testing the editor.
import os
from PIL import Image

root = os.path.dirname(os.path.abspath(__file__))
base = os.path.join(root, "testdata", "base", "map_data")
mod = os.path.join(root, "testdata", "mod", "map_data")
os.makedirs(os.path.join(base, "state_regions"), exist_ok=True)
os.makedirs(os.path.join(mod, "state_regions"), exist_ok=True)

W, H = 400, 200
sea = (10, 20, 200)
img = Image.new("RGB", (W, H), sea)
px = img.load()
# 3x2 grid of provinces per state, 3 states side by side, sea on the right
colours = {}
for s in range(3):
    for i in range(6):
        c = (40 + s * 60, 30 + i * 30, 100 + s * 20 + i)
        colours.setdefault(s, []).append(c)
        x0 = 20 + s * 110 + (i % 3) * 35
        y0 = 30 + (i // 3) * 70
        for x in range(x0, x0 + 35):
            for y in range(y0, y0 + 70):
                px[x, y] = c
img.save(os.path.join(base, "provinces.png"))

def hexes(s):
    return " ".join('"x%02X%02X%02X"' % c for c in colours[s])

west = f'''﻿# west
STATE_ALPHA = {{
    id = 1
    subsistence_building = "building_subsistence_farms"
    provinces = {{ {hexes(0)} }}
    traits = {{ "state_trait_good_soils" }}
    city = "x{'%02X%02X%02X' % colours[0][0]}"
    arable_land = 40
    arable_resources = {{ "bg_wheat_farms" "bg_livestock_ranches" }}
    capped_resources = {{
        bg_coal_mining = 20
        bg_iron_mining = 12
        bg_logging = 8
    }}
    resource = {{
        type = "bg_gold_fields"
        discovered_amount = 2
        undiscovered_amount = 4
    }}
    naval_exit_id = 3000
}}

STATE_BRAVO = {{
    id = 2
    subsistence_building = "building_subsistence_farms"
    provinces = {{ {hexes(1)} }}
    arable_land = 30
    arable_resources = {{ "bg_wheat_farms" }}
    capped_resources = {{
        bg_lead_mining = 15
        bg_logging = 30
    }}
}}
'''
east = f'''﻿STATE_CHARLIE = {{
    id = 3
    provinces = {{ {hexes(2)} }}
    arable_land = 25
    arable_resources = {{ "bg_rice_farms" "bg_tea_plantations" }}
    capped_resources = {{
        bg_sulfur_mining = 10
        bg_fishing = 6
    }}
    resource = {{
        type = "bg_oil_extraction"
        undiscovered_amount = 12
    }}
    resource = {{
        type = "bg_rubber"
        discovered_amount = 4
        undiscovered_amount = 6
    }}
}}
'''
open(os.path.join(base, "state_regions", "00_west.txt"), "w", encoding="utf-8").write(west)
open(os.path.join(base, "state_regions", "01_east.txt"), "w", encoding="utf-8").write(east)
# The mod overrides 01_east.txt: CHARLIE gets more sulfur and some coal
open(os.path.join(mod, "state_regions", "01_east.txt"), "w", encoding="utf-8").write(
    east.replace("bg_sulfur_mining = 10", "bg_sulfur_mining = 25\n        bg_coal_mining = 5"))
# The mod also ships a buildings file, as if the mod root (with common/) was picked
bdir = os.path.join(root, "testdata", "mod", "common", "buildings")
os.makedirs(bdir, exist_ok=True)
open(os.path.join(bdir, "hmps_buildings.txt"), "w", encoding="utf-8").write('''\ufeff
building_tea_plantation = {
    building_group = bg_tea_plantations
}
building_oil_rig = {
    building_group = bg_oil_extraction
}
''')
print("ok")
