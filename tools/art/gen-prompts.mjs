// tools/art/gen-prompts.mjs — генератор 150 промтов для Nano Banana Pro под реальные
// данные игры ФРОНТИР (app/src/core/data.js). Заказчик генерит вручную в приложении
// Higgsfield (у него куплен Unlimited Nano Banana Pro 4K), я потом забираю результат
// через show_generations/job_display, сопоставляя по точному тексту промта.
//
// Запуск: node tools/art/gen-prompts.mjs
// Результат: tools/art/prompts.json — [{id, category, file, aspect, prompt}]
import { writeFileSync } from 'node:fs';
import { BUILDINGS, BUILDING_ERA_IDX, ERAS, FACTIONS, UNITS, SPIRE_STAGES } from '../../app/src/core/data.js';

const OUT = new URL('./prompts.json', import.meta.url);

// ---------------------------------------------------------------------------
// СТИЛЬ-ЯКОРЬ. Один и тот же на все 150 — это и есть «серийность» из мануала:
// если все промты держат общую камеру/свет/фон, спрайты сложатся в одну картину
// мира, а не в разнобой.
// ---------------------------------------------------------------------------
const CAMERA_LIGHT =
  'Camera: elevated three-quarter top-down view, tilted about 65 degrees from vertical ' +
  '(classic city-builder framing, not a flat icon, not a side view). ' +
  'Lighting: single warm sun from the top-left at 45 degrees, soft baked ambient occlusion ' +
  'in every crevice, one small soft dark contact shadow hugging only the base of the subject.';

const CUTOUT_BG =
  'Background: solid flat uniform magenta color #FF00FF filling the entire frame edge to edge, ' +
  'no gradient, no texture, no floor plane, no ground shadow beyond the subject’s own base, ' +
  'no other objects, no text, no logo, no watermark, no frame or border.';

const PAINT_STYLE =
  'Hand-painted 2.5D strategy-game asset art, semi-realistic historical style, ' +
  'rich saturated natural colors, crisp readable silhouette, confident brushwork, no photo texture.';

function buildingPrompt(subject) {
  return `${PAINT_STYLE} ${CAMERA_LIGHT} Subject: ${subject} ${CUTOUT_BG}`;
}

function iconPrompt(subject) {
  return 'Clean flat-painted game UI icon, bold readable silhouette, subtle inner gradient for volume, ' +
    'thin warm gold outline, lit softly from the top-left. ' + subject + ' ' + CUTOUT_BG;
}

function scenePrompt(subject, mood) {
  return `${PAINT_STYLE} Wide painterly game key-art illustration, epic composition, atmospheric depth, ` +
    `dramatic natural lighting${mood ? ', ' + mood : ''}. Subject: ${subject} ` +
    'No text, no logo, no watermark, no UI elements.';
}

// ---------------------------------------------------------------------------
// Материалы и характер постройки по эпохам — переиспользуются зданиями,
// жителями и заставками, чтобы 10 эпох реально отличались друг от друга.
// ---------------------------------------------------------------------------
const ERA_MATERIAL = [
  'built from animal hide, mammoth bone, thatch and rough-cut timber, Stone Age tribal craftsmanship', // stone
  'built from sun-dried mudbrick, lashed timber and woven reed, early Bronze Age settlement craft',     // bronze
  'built from iron-banded timber and coarse fieldstone, Iron Age hillfort craftsmanship',                 // iron
  'built from creamy limestone and marble with terracotta roof tiles and painted columns, Classical Antiquity architecture', // classical
  'built from half-timber framing, fieldstone and dark slate roofing with wrought-iron fittings, Medieval architecture', // medieval
  'built from warm brick and dressed stone with ornate cornices, glass windows and domed tile roofs, Renaissance architecture', // renaissance
  'built from soot-stained red brick, riveted cast iron and timber, with a tall smoking chimney, Industrial Revolution architecture', // industrial
  'built from painted concrete, steel framing and large glass windows, early-modern civic architecture', // modern
  'built from brushed steel, curtain glass and illuminated panels, Information Age corporate-tech architecture', // digital
  'built from white composite panels and chrome trim with soft cyan holographic light lines and faint floating elements, near-future architecture', // future
];

const ERA_CLOTHING = [
  'wrapped in tanned hide and fur with a bone necklace',
  'wearing a dyed wool tunic with bronze arm bands',
  'wearing a belted wool tunic with iron-studded leather bracers',
  'wearing a draped linen toga-tunic with a laurel-leaf trim',
  'wearing a woollen medieval tunic, hood and leather boots',
  'wearing a fine doublet with a linen collar, Renaissance townsfolk fashion',
  'wearing a flat cap, waistcoat and rolled shirt sleeves, Industrial-era worker fashion',
  'wearing a simple modern shirt, trousers and a canvas work apron',
  'wearing a sleek technical jacket with a small glowing ID badge',
  'wearing a minimalist smart-fabric suit with faint glowing seams',
];

// ---------------------------------------------------------------------------
// 1) ЗДАНИЯ — 55, ровно по BUILDINGS/BUILDING_ERA_IDX. subject — по-английски,
// переведено по смыслу name+desc, чтобы силуэт был узнаваем в игре.
// ---------------------------------------------------------------------------
const BUILDING_SUBJECT = {
  campfire: 'a small stone-ringed communal campfire, the heart of the settlement, with a wooden tripod spit and glowing embers',
  hut: 'a single round hut with a conical thatched roof and a smoke hole at the top',
  forager: 'an open-air foraging camp with woven baskets, drying racks of berries and roots, and a lean-to shelter',
  lumber: 'a rough timber lumberjack hut beside a stack of freshly cut logs with an axe lodged in a stump',
  quarry: 'an open stone quarry pit with wooden scaffolding, ropes, chisels and stacked cut stone blocks',
  story_fire: 'a ceremonial storytelling firepit ringed with carved wooden totems and animal-hide seats',
  hunter_lodge: 'a hunter’s lodge of timber and hide hung with spears, bows and drying pelts on a rack',
  pasture: 'a fenced pasture with a small wooden shelter and a few grazing goats',
  farm: 'a small terraced farm plot with neat furrows of crops and a wooden scarecrow',
  granary: 'an elevated granary on wooden stilts, its woven-basket walls bulging with stored grain',
  mine: 'a mountainside mine entrance shored with timber beams, an ore cart on rails at the mouth',
  smithy: 'an open-air bronze-age smithy with a stone forge, bellows and glowing coals',
  market: 'a bustling open-air market stall with striped awnings, hanging goods and clay amphorae',
  stone_house: 'a solid two-story stone house with small shuttered windows and a thatched roof',
  palisade: 'a short section of sharpened wooden palisade wall with a narrow watch-gap',
  barracks: 'a fortified barracks longhouse with racked spears and shields lined against its outer wall',
  armory: 'a stone armory with a rack of polished swords, shields and helmets displayed at its entrance',
  treasury: 'a small stone treasury vault with a heavy banded door and a chest of coins visible inside',
  port: 'a wooden harbor dock with a moored fishing boat, coiled ropes and stacked crates',
  aqueduct: 'a short arched stone aqueduct segment with water visibly flowing along its top channel',
  temple: 'a classical temple with marble columns, a triangular pediment and a stone altar',
  clinic: 'a modest stone clinic with drying herbs hanging in bundles by the doorway',
  amphitheater: 'a small classical open-air amphitheater with tiered stone seating',
  academy: 'a classical academy building with a colonnaded portico and scrolls stacked visible inside',
  castle: 'a compact medieval stone castle keep with a corner turret and a raised drawbridge',
  university: 'a medieval university hall with tall arched windows and a bell tower',
  mill: 'a medieval watermill with a large wooden waterwheel turning beside a stone building',
  guild_hall: 'an ornate medieval guild hall with a carved wooden facade and hanging craft-guild banners',
  bank: 'a stately Renaissance stone bank building with tall arched windows and an ornate cornice',
  stone_walls: 'a thick fortified medieval stone wall segment with crenellations',
  press: 'a Renaissance printing house with a wooden printing press visible through an open shutter',
  observatory: 'a Renaissance domed observatory tower with a brass telescope protruding from an open slit',
  shipyard: 'a Renaissance shipyard with a half-built wooden galleon on scaffolding beside the water',
  foundry: 'an early industrial iron foundry with a squat brick chimney and a glowing furnace mouth',
  workshop: 'a cluttered Renaissance artisan workshop with tools, gears and half-finished inventions on benches',
  train_station: 'a brick Industrial-era train station platform with an ornate iron-and-glass canopy',
  factory: 'a large soot-stained brick factory with multiple tall smokestacks billowing dark smoke',
  sewers: 'an industrial sewer access structure, a brick archway over a channel of flowing water with an iron grate',
  stock_exchange: 'a grand Industrial-era stock exchange building with tall columns and large arched windows',
  power_plant: 'an early power plant with a huge brick chimney, iron pipework and crackling transformer coils',
  lab: 'an Industrial-era research laboratory with glass beakers and bubbling apparatus visible through the window',
  apartment: 'a tall Industrial-era brick apartment block with rows of small lit windows and iron fire escapes',
  media_tower: 'a modern media broadcast tower building with a tall antenna and a glowing rooftop sign',
  hospital: 'a clean modern hospital building with a red cross sign and large glass windows',
  airport: 'a modern airport terminal building with a curved glass facade and a small radar dish on the roof',
  npp: 'a modern nuclear power plant with two large grey cooling towers venting soft steam',
  datacenter: 'an Information-age data center building, a sleek windowless block glowing with blue server-light vents',
  solar: 'a wide field of angled solar panel arrays glinting under the sun beside a small control hut',
  robo_factory: 'an automated robotics factory with a glass wall revealing robotic arms at work inside',
  biolab: 'a sleek glass biotechnology laboratory with glowing green vats visible through its curved windows',
  skyscraper: 'a tall modern glass-and-steel skyscraper tower with hundreds of tiny lit windows',
  ai_core: 'a futuristic AI core building, a smooth dark dome pulsing with intricate cyan circuit-light patterns',
  fusion_reactor: 'a futuristic fusion reactor complex, a glowing toroidal structure inside an open framework of white composite pylons',
  spaceport: 'a sleek near-future spaceport pad with a slender rocket resting on a gantry, faint engine glow beneath it',
  spire: 'a majestic half-built Spire of Civilization, a slender crystalline tower of white composite and glass with a pulsing cyan energy core at its center, reaching skyward',
};

// ---------------------------------------------------------------------------
// 2) МЕСТНОСТЬ — 7 типов тайлов × 4 сезона = 28.
// ---------------------------------------------------------------------------
const TILE_SUBJECT = {
  deep: 'deep open ocean water, dark blue with slow rolling swells',
  water: 'shallow coastal water with a sandy bottom faintly visible and small ripples',
  sand: 'a flat sandy beach patch with fine wind-blown ripple patterns and a few scattered pebbles',
  grass: 'a flat grassy meadow patch with soft wind-swept grass texture and a few wildflowers',
  forest: 'a dense cluster of deciduous forest trees with overlapping leafy canopies',
  hill: 'a rounded grassy hill mound with a few scattered rocks on its slope',
  mountain: 'a rocky mountain peak with jagged grey stone faces and a dusting near the summit',
};
const SEASON_MOOD = [
  'spring season, fresh bright green growth, a few small white blossoms',
  'summer season, lush saturated green, warm bright sunlight',
  'autumn season, warm gold-orange-brown foliage, a few fallen leaves',
  'winter season, dusted with fresh snow, cool pale light, bare branches where relevant',
];

function tileTexturePrompt(subject, season) {
  return 'Hand-painted seamless top-down game terrain tile texture, square tile designed to repeat edge-to-edge, ' +
    'viewed from directly above (90 degrees, true top-down, not isometric), soft natural painterly detail, ' +
    `${season}. Subject: ${subject}. ` +
    'Even lighting suitable for tiling, no drop shadow, no vignette, no border, no text, no watermark.';
}

// ---------------------------------------------------------------------------
// 3) ЗАСТАВКИ ЭПОХ — 10, широкий кадр для загрузочного экрана/баннера эпохи.
// ---------------------------------------------------------------------------
const ERA_SCENE = [
  'a Stone Age tribal settlement of hide tents around a great bonfire at dusk, mammoths grazing in the misty distance',
  'a Bronze Age mudbrick village with early bronze tools and a caravan of pack donkeys arriving at sunrise',
  'an Iron Age hillfort settlement ringed by a timber-and-iron palisade under a stormy dramatic sky',
  'a Classical Antiquity marble city with a great temple and busy agora, golden midday light',
  'a Medieval walled town with a stone castle on a hill, banners flying, warm late-afternoon light',
  'a Renaissance city of domed cathedrals and canals bustling with merchants, soft golden-hour light',
  'an Industrial-era city skyline of brick factories and smokestacks under a dramatic smoky orange sunset',
  'a modern city skyline of glass towers and busy streets at blue-hour dusk with warm window lights',
  'an Information-age megacity glowing with neon signage and holographic billboards at night',
  'a near-future city with sleek white-and-chrome towers, flying transit lines and a distant glowing space elevator at dawn',
];

// ---------------------------------------------------------------------------
// 4) ЖИТЕЛИ — 10, по одному представителю на эпоху (концепт-лист позы).
// ---------------------------------------------------------------------------
function villagerPrompt(era, i) {
  return `${PAINT_STYLE} Full-body character concept, three-quarter top-down view like a strategy-game villager sprite, ` +
    `standing in a relaxed idle pose facing forward-down toward camera. Subject: a settlement worker of the ${era.ru} era, ` +
    `${ERA_CLOTHING[i]}, ${CAMERA_LIGHT} ${CUTOUT_BG}`;
}

// ---------------------------------------------------------------------------
// 5) ЖИВОТНЫЕ — 4.
// ---------------------------------------------------------------------------
const ANIMALS = [
  { id: 'mammoth', subject: 'a large woolly mammoth with long curved tusks and shaggy brown fur' },
  { id: 'deer', subject: 'an alert wild deer with small antlers, mid-stride' },
  { id: 'wolf', subject: 'a lean grey wolf, low crouched stalking pose, bared teeth' },
  { id: 'boar', subject: 'a stocky wild boar with tusks, head lowered as if about to charge' },
];

// ---------------------------------------------------------------------------
// 6) ЮНИТЫ — 7, из UNITS.
// ---------------------------------------------------------------------------
const UNIT_SUBJECT = {
  militia: 'a Bronze-Age militia spearman with a wooden shield and leather armor, ready stance',
  swordsman: 'an Iron-Age swordsman in banded iron armor with a round shield and short sword',
  knight: 'a Medieval knight in full plate armor on an armored warhorse, lance raised',
  musketeer: 'a Renaissance musketeer in a wide-brimmed hat and bandolier, aiming a long musket',
  marksman: 'an Industrial-era marksman in a long coat with a bolt-action rifle, kneeling aim stance',
  soldier: 'a modern-era infantry soldier in helmet and fatigues with a rifle at ready',
  drone: 'a sleek near-future combat drone hovering with glowing thrusters and a small weapon pod',
};

// ---------------------------------------------------------------------------
// 7) ФРАКЦИИ — 8 эмблем + 8 столиц = 16, по FACTIONS.
// ---------------------------------------------------------------------------
const FACTION_FLAVOR = {
  wolves: { vibe: 'a fierce Norse-raider warband, dark iron and red furs', capital: 'a fortified Norse-style hillfort of dark timber longhouses ringed by a spiked palisade, wolf-skull totems on the gate' },
  guild: { vibe: 'a wealthy Mediterranean merchant-republic, gold and white marble', capital: 'a wealthy Mediterranean merchant-city of white marble counting-houses and a grand columned exchange hall, golden banners' },
  dawn: { vibe: 'a radiant solar temple-order, cream and gold', capital: 'a radiant sun-temple citadel of pale limestone and gold-leaf domes, tall sunburst-topped spires' },
  cog: { vibe: 'an inventive artificer guild-house, blue steel and brass gears', capital: 'a steampunk artificer’s stronghold of blue-painted steel and exposed brass gearwork, smoking chimneys and clockwork towers' },
  horde: { vibe: 'a nomadic steppe horde, orange leather and horsehide', capital: 'a great steppe-nomad camp of orange-and-hide yurts around a central horsetail standard, corrals of horses' },
  tide: { vibe: 'a seafaring coastal people, teal and driftwood', capital: 'a stilted coastal settlement of teal-painted driftwood houses on a harbor, fishing boats and drying nets' },
  grove: { vibe: 'a druidic forest-dwelling people, deep green and living wood', capital: 'a druidic settlement built into and around ancient living trees, green banners and moss-covered stone circles' },
  syndicate: { vibe: 'an industrial cartel, burnt orange and riveted iron', capital: 'a grim industrial cartel compound of riveted iron towers and smokestacks behind a barbed steel fence' },
};

function factionEmblemPrompt(f) {
  return 'Hand-painted heraldic game faction emblem, a bold circular banner-shield icon, ' +
    `symbol: a stylized ${f.banner}, in the color palette of ${f.color} accented with dark iron and parchment cream, ` +
    `representing ${FACTION_FLAVOR[f.id].vibe}. Rendered as a single polished emblem badge, dramatic rim light. ${CUTOUT_BG}`;
}
function factionCapitalPrompt(f) {
  return buildingPrompt(`the capital settlement of the "${f.name}" faction — ${FACTION_FLAVOR[f.id].capital}, a banner bearing a ${f.banner} symbol flying above the largest structure`);
}

// ---------------------------------------------------------------------------
// 8) ШПИЛЬ — 5 стадий + финальный луч.
// ---------------------------------------------------------------------------
const SPIRE_VISUAL = [
  'a massive stone foundation platform under construction, scaffolding and cranes of rope and timber around a shallow circular base',
  'a rising steel skeletal framework tower half-clad in white composite panels, construction cranes still attached',
  'a completed outer shell tower with a visible pulsing cyan energy core glowing faintly through gaps in the panels',
  'a fully clad Spire of Civilization, sleek white and chrome with glowing cyan seams tracing up its surface',
  'the completed Spire of Civilization at its full height, crowned with an intricate glowing energy lattice',
];

// ---------------------------------------------------------------------------
// 9) ИКОНКИ РЕСУРСОВ — 6.
// ---------------------------------------------------------------------------
const RES_ICON = {
  food: 'a small bundle of golden wheat sheaves tied with twine',
  wood: 'three neatly stacked cut wooden logs',
  stone: 'a small pile of three rough grey stone blocks',
  steel: 'a polished steel gear-shaped ingot with a faint blue sheen',
  gold: 'a small stack of three shining gold coins',
  knowledge: 'an open ancient book with a glowing golden bookmark ribbon',
};

// ---------------------------------------------------------------------------
// 10) АТМОСФЕРА ПОГОДЫ — 4, для параллакс-фона/референса пост-эффектов.
// ---------------------------------------------------------------------------
const WEATHER_MOOD = {
  rain: 'a heavy rainstorm over rolling green hills, dark grey clouds, streaks of falling rain, distant lightning flash',
  snow: 'a quiet snowfall over a white winter landscape, soft grey sky, gently drifting snowflakes',
  fog: 'a thick low ground fog rolling over a meadow at dawn, muted pale light, silhouetted distant trees',
  storm: 'a dramatic thunderstorm over open plains, dark churning clouds, a bright lightning bolt striking the horizon',
};

// ---------------------------------------------------------------------------
// СБОРКА СПИСКА
// ---------------------------------------------------------------------------
const items = [];
let n = 0;
const push = (category, file, aspect, prompt) => { n++; items.push({ id: `F${String(n).padStart(3, '0')}`, category, file, aspect, prompt }); };

// 1) здания — 55
for (const id of Object.keys(BUILDINGS)) {
  const era = BUILDING_ERA_IDX[id] ?? 0;
  const subject = `${BUILDING_SUBJECT[id]}, ${ERA_MATERIAL[era]}`;
  push('Здания', `buildings/${id}.png`, '1:1', buildingPrompt(subject));
}

// 2) местность — 28
for (const [tid, subject] of Object.entries(TILE_SUBJECT)) {
  SEASON_MOOD.forEach((season, si) => {
    const seasonName = ['spring', 'summer', 'autumn', 'winter'][si];
    push('Местность', `terrain/${tid}_${seasonName}.png`, '1:1', tileTexturePrompt(subject, season));
  });
}

// 3) заставки эпох — 10
ERAS.forEach((era, i) => {
  push('Заставки эпох', `splash/era_${i}_${era.id}.png`, '16:9', scenePrompt(ERA_SCENE[i]));
});

// 4) жители — 10
ERAS.forEach((era, i) => {
  push('Жители', `villagers/era_${i}_${era.id}.png`, '3:4', villagerPrompt(era, i));
});

// 5) животные — 4
for (const a of ANIMALS) push('Животные', `animals/${a.id}.png`, '4:3', buildingPrompt(a.subject));

// 6) юниты — 7
for (const u of UNITS) push('Юниты', `units/${u.id}.png`, '3:4', buildingPrompt(UNIT_SUBJECT[u.id]));

// 7) фракции — 16
for (const f of FACTIONS) {
  push('Фракции — эмблемы', `factions/${f.id}_emblem.png`, '1:1', factionEmblemPrompt(f));
}
for (const f of FACTIONS) {
  push('Фракции — столицы', `factions/${f.id}_capital.png`, '1:1', factionCapitalPrompt(f));
}

// 8) шпиль — 6
SPIRE_STAGES.forEach((s, i) => {
  push('Шпиль Цивилизации', `spire/stage_${i}_${s.name}.png`, '3:4', buildingPrompt(SPIRE_VISUAL[i]));
});
push('Шпиль Цивилизации', 'spire/victory_beam.png', '9:16',
  scenePrompt('the completed Spire of Civilization firing a brilliant cyan beam of light into a starry night sky, a small silhouetted city gathered around its base', 'awe-inspiring, triumphant'));

// 9) иконки ресурсов — 6
for (const [rid, subject] of Object.entries(RES_ICON)) push('Иконки ресурсов', `ui/res_${rid}.png`, '1:1', iconPrompt(subject));

// 10) погода — 4
for (const [wid, subject] of Object.entries(WEATHER_MOOD)) push('Атмосфера погоды', `mood/${wid}.png`, '16:9', scenePrompt(subject));

// 11) заставки меню — 2
push('Заставки меню', 'menu/cover_alt.png', '9:16', scenePrompt(
  'a lone figure standing before a small Stone Age campfire at the edge of a vast unexplored wilderness at dawn, looking out toward distant misty mountains',
  'hopeful, epic scale, sense of a journey about to begin'));
push('Заставки меню', 'menu/victory_alt.png', '16:9', scenePrompt(
  'a thriving future civilization spread across a green valley beneath the completed Spire of Civilization, its beam reaching into a starlit sky',
  'triumphant, awe-inspiring'));

// 12) лист достижений — 1 (сеткой, чтобы не плодить 20 отдельных промтов)
push('Достижения', 'ui/achievements_sheet.png', '1:1',
  'Hand-painted flat game achievement badge sheet, a clean 5x4 grid of 20 distinct circular medal badges, ' +
  'each with a different simple historical-civilization icon (fire, wheel, book, sword, coin, ship, crown, gear, atom, star, and similar), ' +
  'consistent warm gold-bronze-silver medal styling, evenly spaced, no overlap, no text, no labels. ' + CUTOUT_BG);

// 13) карта мира — 1
push('Карта мира', 'ui/world_map_poster.png', '16:9',
  'Hand-painted fantasy-cartography style world map illustration, a single continent with mountains, forests, ' +
  'rivers, coastlines and eight small settlement icons scattered across it in different regions, aged parchment-paper texture, ' +
  'warm sepia-and-green ink tones, ornate compass rose in a corner, no text, no labels, no legend.');

writeFileSync(OUT, JSON.stringify(items, null, 2), 'utf8');
console.log(`Сгенерировано промтов: ${items.length}`);
const byCat = {};
for (const it of items) byCat[it.category] = (byCat[it.category] || 0) + 1;
for (const [c, n2] of Object.entries(byCat)) console.log(`  ${c}: ${n2}`);
