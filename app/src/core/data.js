// core/data.js — ФРОНТИР v2.0 + модуль «Фракции». Весь контент data-driven.
// Таблицы переносятся в UE5 DataAssets/JSON без изменения логики.

export const SAVE_VERSION = 3;

export const TILE = { DEEP: 0, WATER: 1, SAND: 2, GRASS: 3, FOREST: 4, HILL: 5, MOUNTAIN: 6 };
export const WALKABLE = new Set([TILE.SAND, TILE.GRASS, TILE.FOREST, TILE.HILL]);
export const TILE_COST = { [TILE.GRASS]: 1, [TILE.FOREST]: 1.4, [TILE.HILL]: 1.6, [TILE.SAND]: 1.1 };

// ---- Ресурсы ----
export const RES = [
  { id: 'food', icon: '🍞', ru: 'Еда' },
  { id: 'wood', icon: '🪵', ru: 'Дерево' },
  { id: 'stone', icon: '🪨', ru: 'Камень' },
  { id: 'steel', icon: '⚙️', ru: 'Сталь' },
  { id: 'gold', icon: '🪙', ru: 'Золото' },
  { id: 'knowledge', icon: '📜', ru: 'Знания' },
];

// ---- Эпохи (10) ----
export const ERAS = [
  { id: 'stone',       ru: 'Каменный век',   years: '10000–3300 до н.э.', hue: '#8a8578' },
  { id: 'bronze',      ru: 'Бронзовый век',  years: '3300–1200 до н.э.',  hue: '#b08d57' },
  { id: 'iron',        ru: 'Железный век',   years: '1200–500 до н.э.',   hue: '#9aa0a6' },
  { id: 'classical',   ru: 'Античность',     years: '500 до н.э. – 500',  hue: '#e8e0c8' },
  { id: 'medieval',    ru: 'Средневековье',  years: '500–1450',           hue: '#a0522d' },
  { id: 'renaissance', ru: 'Ренессанс',      years: '1450–1750',          hue: '#d4af37' },
  { id: 'industrial',  ru: 'Индустриальная', years: '1750–1900',          hue: '#5a6b7a' },
  { id: 'modern',      ru: 'Современность',  years: '1900–1990',          hue: '#4aa3c7' },
  { id: 'digital',     ru: 'Информационная', years: '1990–2016',          hue: '#7d9de8' },
  { id: 'future',      ru: 'Будущее',        years: '2016+',              hue: '#7de3ff' },
];

// ---- Технологии (62). Поле era — гейт эпохи ----
export const TECHS = [
  { id: 'fire',        name: 'Огонь',            cost: 0,    prereq: [], effect: 'Стартовая. Тепло и защита.' },
  { id: 'tools',       name: 'Орудия труда',     cost: 20,   prereq: ['fire'], effect: '+30% к добыче дерева, камня и собирательству.' },
  { id: 'hunting',     name: 'Охота',            cost: 35,   prereq: ['fire'], effect: 'Охотничья стоянка; жители охотятся на дичь.' },
  { id: 'language',    name: 'Язык',             cost: 50,   prereq: ['fire'], effect: 'Костёр историй; +25% к скорости знаний.' },
  { id: 'farming',     name: 'Земледелие',       cost: 70,   prereq: ['tools'], effect: 'Открывает Ферму.' },
  { id: 'pottery',     name: 'Гончарство',       cost: 90,   prereq: ['farming'], effect: 'Амбар (+300 еды к максимуму), +10% счастья.' },
  { id: 'animal_husbandry', name: 'Скотоводство', cost: 110, prereq: ['hunting'], effect: 'Пастбище — еда даже зимой.' },
  { id: 'bronze',      name: 'Бронза',           cost: 140,  prereq: ['pottery'], era: 'bronze', effect: 'ЭПОХА. Шахта, Кузница.' },
  { id: 'writing',     name: 'Письменность',     cost: 170,  prereq: ['bronze'], effect: 'Библиотека; +50% знаний.' },
  { id: 'wheel',       name: 'Колесо',           cost: 190,  prereq: ['bronze'], effect: '+20% скорость жителей.' },
  { id: 'masonry',     name: 'Кладка',           cost: 210,  prereq: ['bronze'], effect: 'Каменный дом, Частокол.' },
  { id: 'trade',       name: 'Торговля',         cost: 240,  prereq: ['wheel'], effect: 'Рынок, караваны, ресурс 🪙 золото.' },
  { id: 'laws',        name: 'Законы',           cost: 260,  prereq: ['writing'], effect: '+10% счастья; налоги +🪙.' },
  { id: 'iron',        name: 'Железо',           cost: 280,  prereq: ['bronze'], era: 'iron', effect: 'ЭПОХА. +25% добыча; Оружейная.' },
  { id: 'warfare',     name: 'Военное дело',     cost: 320,  prereq: ['iron'], effect: 'Казарма, воины; вражеские рейды активны.' },
  { id: 'currency',    name: 'Деньги',           cost: 350,  prereq: ['trade'], effect: 'Сокровищница; курсы рынка −20%.' },
  { id: 'construction', name: 'Строительство',   cost: 380,  prereq: ['masonry'], effect: 'Акведук (+счастье).' },
  { id: 'sailing',     name: 'Мореходство',      cost: 400,  prereq: ['wheel'], effect: 'Порт — еда с воды.' },
  { id: 'philosophy',  name: 'Философия',        cost: 450,  prereq: ['writing'], era: 'classical', effect: 'ЭПОХА. +30% знаний.' },
  { id: 'engineering', name: 'Инженерия',        cost: 550,  prereq: ['philosophy'], effect: 'Стройка ×2.' },
  { id: 'mathematics', name: 'Математика',       cost: 600,  prereq: ['philosophy'], effect: '+15% знаний; Академия; баллисты.' },
  { id: 'medicine',    name: 'Медицина',         cost: 640,  prereq: ['philosophy'], effect: 'Лечебница: болезни ×0.5, рост населения.' },
  { id: 'theology',    name: 'Теология',         cost: 620,  prereq: ['laws'], effect: 'Храм: +счастье, события веры.' },
  { id: 'aesthetics',  name: 'Искусство',        cost: 680,  prereq: ['theology'], effect: 'Амфитеатр: +счастье.' },
  { id: 'feudalism',   name: 'Феодализм',        cost: 700,  prereq: ['laws', 'iron'], era: 'medieval', effect: 'ЭПОХА. +20% еды с ферм.' },
  { id: 'guilds',      name: 'Гильдии',          cost: 800,  prereq: ['currency', 'feudalism'], effect: 'Мастерская гильдии (+🪙).' },
  { id: 'machinery',   name: 'Механика',         cost: 850,  prereq: ['engineering'], effect: 'Мельница: +50% фермам в радиусе 3.' },
  { id: 'steel_tech',  name: 'Сталь',            cost: 900,  prereq: ['iron'], effect: 'Рыцари; шахты +25%.' },
  { id: 'education',   name: 'Образование',      cost: 950,  prereq: ['philosophy'], effect: 'Университет.' },
  { id: 'banking',     name: 'Банки',            cost: 1000, prereq: ['guilds'], effect: 'Банк: всё 🪙 +25%.' },
  { id: 'castles',     name: 'Фортификация',     cost: 1050, prereq: ['masonry', 'warfare'], effect: 'Замок; Каменные стены.' },
  { id: 'printing',    name: 'Книгопечатание',   cost: 1100, prereq: ['education'], era: 'renaissance', effect: 'ЭПОХА. Библиотеки ×2; Печатный двор.' },
  { id: 'gunpowder',   name: 'Порох',            cost: 1200, prereq: ['steel_tech'], effect: 'Мушкетёры; Литейная.' },
  { id: 'optics',      name: 'Оптика',           cost: 1250, prereq: ['printing'], effect: 'Обсерватория.' },
  { id: 'navigation',  name: 'Навигация',        cost: 1300, prereq: ['sailing', 'optics'], effect: 'Верфь; караваны +50%.' },
  { id: 'chemistry',   name: 'Химия',            cost: 1400, prereq: ['optics'], effect: 'Шахты +25%; лечебницы лучше.' },
  { id: 'economics',   name: 'Экономика',        cost: 1450, prereq: ['banking', 'printing'], effect: 'Рынки и мастерские +25%.' },
  { id: 'steam',       name: 'Паровая машина',   cost: 1600, prereq: ['machinery', 'chemistry'], era: 'industrial', effect: 'ЭПОХА. Мануфактура.' },
  { id: 'sanitation',  name: 'Санитария',        cost: 1800, prereq: ['chemistry'], effect: 'Канализация: эпидемии ×0.3.' },
  { id: 'railroads',   name: 'Железные дороги',  cost: 1900, prereq: ['steam'], effect: 'Вокзал: караваны ×2, радиусы +2.' },
  { id: 'industrialization', name: 'Индустриализация', cost: 2000, prereq: ['steam'], effect: 'Фабрика: ресурс ⚙️ сталь.' },
  { id: 'corporations', name: 'Корпорации',      cost: 2100, prereq: ['economics'], effect: 'Биржа: 🪙 +30%.' },
  { id: 'electricity', name: 'Электричество',    cost: 2200, prereq: ['industrialization'], era: 'modern', effect: 'ЭПОХА. Электростанция, Лаборатория, Многоэтажка.' },
  { id: 'automobile',  name: 'Автомобили',       cost: 2400, prereq: ['electricity'], effect: 'Радиусы эффектов +1.' },
  { id: 'mass_media',  name: 'Массмедиа',        cost: 2500, prereq: ['electricity'], effect: 'Телецентр: +счастье всем.' },
  { id: 'penicillin',  name: 'Медицина XX века', cost: 2700, prereq: ['sanitation'], effect: 'Госпиталь: смертность −50%.' },
  { id: 'flight',      name: 'Авиация',          cost: 2800, prereq: ['automobile'], effect: 'Аэропорт: торговля ++.' },
  { id: 'plastics',    name: 'Полимеры',         cost: 2900, prereq: ['chemistry'], effect: 'Фабрики +25%.' },
  { id: 'rocketry',    name: 'Ракеты',           cost: 3100, prereq: ['flight'], effect: 'Задел под Космопорт.' },
  { id: 'nuclear',     name: 'Атом',             cost: 3300, prereq: ['plastics'], effect: 'АЭС: промышленность +50%, редкий риск аварии.' },
  { id: 'computing',   name: 'Компьютеры',       cost: 3600, prereq: ['mass_media'], era: 'digital', effect: 'ЭПОХА (Информационная). Дата-центр.' },
  { id: 'internet',    name: 'Интернет',         cost: 3900, prereq: ['computing'], effect: 'Знания зданий +25%; торговля онлайн +🪙.' },
  { id: 'smartphones', name: 'Смартфоны',        cost: 4200, prereq: ['internet'], effect: '+10% счастья; +10% знаний.' },
  { id: 'renewables',  name: 'Зелёная энергия',  cost: 4400, prereq: ['nuclear'], effect: 'Солнечная ферма (без риска).' },
  { id: 'biotech',     name: 'Биотех',           cost: 4600, prereq: ['penicillin', 'computing'], effect: 'Биолаборатория; жизнь длиннее.' },
  { id: 'robotics',    name: 'Робототехника',    cost: 4900, prereq: ['computing'], effect: 'Робозавод: работает без рабочих; Дроны.' },
  { id: 'ai',          name: 'Искусственный интеллект', cost: 5400, prereq: ['internet', 'robotics'], era: 'future', effect: 'ЭПОХА (Будущее). ИИ-центр.' },
  { id: 'fusion',      name: 'Термояд',          cost: 6000, prereq: ['ai', 'renewables'], effect: 'Реактор: промышленность ×1.5.' },
  { id: 'nanotech',    name: 'Нанотех',          cost: 6400, prereq: ['ai', 'biotech'], effect: 'Стройка ×3.' },
  { id: 'quantum',     name: 'Квантовые вычисления', cost: 6800, prereq: ['ai'], effect: 'Знания ×2.' },
  { id: 'spaceflight', name: 'Космонавтика',     cost: 7200, prereq: ['rocketry', 'ai'], effect: 'Космопорт: миссии Луна/Марс.' },
  { id: 'singularity', name: 'Проект «Шпиль»',   cost: 8000, prereq: ['fusion', 'nanotech', 'quantum'], effect: 'Открывает ШПИЛЬ ЦИВИЛИЗАЦИИ.' },
];

// Эпоха, к которой относится технология (для группировки в UI)
export const TECH_ERA_IDX = (() => {
  const map = {}; let era = 0;
  for (const t of TECHS) { map[t.id] = era; if (t.era) era++; }
  return map;
})();

// ---- Здания (~46). Старые 11 id сохранены ----
// out: добыча в день на рабочего; housing: жильё; happy: счастье всем; special: маркер особой логики
export const BUILDINGS = {
  campfire:      { name: 'Кострище',           cost: {},                                  housing: 6,  know: 0.3, req: null, desc: 'Сердце поселения. +0.3📜/день.' },
  hut:           { name: 'Хижина',             cost: { wood: 6 },                         housing: 4,  req: null, desc: 'Жильё для 4 жителей.', evolve: 'house' },
  forager:       { name: 'Собиратели',         cost: { wood: 8 },                         workers: 2, out: { food: 2.2 }, req: null, desc: 'Собирательство поблизости.' },
  lumber:        { name: 'Лесопилка',          cost: { wood: 10 },                        workers: 3, out: { wood: 1.2 }, needTile: TILE.FOREST, req: null, desc: 'Ставится вплотную к лесу.', evolve: 'lumber' },
  quarry:        { name: 'Каменоломня',        cost: { wood: 12 },                        workers: 3, out: { stone: 1.0 }, needTile: TILE.HILL, req: null, desc: 'Ставится вплотную к холму.' },
  story_fire:    { name: 'Костёр историй',     cost: { wood: 10 },                        workers: 2, out: { knowledge: 0.5 }, req: 'language', desc: 'Шаман рассказывает у огня.' },
  hunter_lodge:  { name: 'Охотничья стоянка',  cost: { wood: 10 },                        workers: 3, out: { food: 2.6 }, req: 'hunting', desc: 'Охотники добывают дичь.' },
  pasture:       { name: 'Пастбище',           cost: { wood: 14 },                        workers: 3, out: { food: 2.4 }, needTile: TILE.GRASS, winter: true, req: 'animal_husbandry', desc: 'Еда даже зимой.' },
  farm:          { name: 'Ферма',              cost: { wood: 14 },                        workers: 4, out: { food: 3.0 }, needTile: TILE.GRASS, req: 'farming', desc: 'Основа питания. Зимой не работает.', evolve: 'farm' },
  granary:       { name: 'Амбар',              cost: { wood: 20, stone: 8 },              cap: { food: 300 }, req: 'pottery', desc: '+300 к максимуму еды.' },
  mine:          { name: 'Шахта',              cost: { wood: 25, stone: 10 },             workers: 4, out: { stone: 1.6 }, needTile: TILE.MOUNTAIN, req: 'bronze', desc: 'Ставится вплотную к горе.' },
  smithy:        { name: 'Кузница',            cost: { wood: 20, stone: 15 },             workers: 3, out: { stone: 0.8 }, aura: { r: 2, gather: 1.1 }, req: 'bronze', desc: '+10% добычи соседям в радиусе 2.' },
  market:        { name: 'Рынок',              cost: { wood: 25, stone: 10 },             workers: 3, out: { gold: 0.8 }, req: 'trade', desc: 'Открывает обмен ресурсов и караваны.', evolve: 'market' },
  stone_house:   { name: 'Каменный дом',       cost: { wood: 10, stone: 18 },             housing: 8,  req: 'masonry', desc: 'Жильё для 8 жителей.', evolve: 'house' },
  palisade:      { name: 'Частокол',           cost: { wood: 6 },                         defense: 2, wall: 200, req: 'masonry', desc: 'Оборона +2 за сегмент.' },
  barracks:      { name: 'Казарма',            cost: { wood: 30, stone: 25 },             req: 'warfare', special: 'train', desc: 'Обучает бойцов: 20🍞+10🪙 за бойца.' },
  armory:        { name: 'Оружейная',          cost: { stone: 30, gold: 10 },             armyMult: 1.15, req: 'iron', desc: 'Сила армии +15%.' },
  treasury:      { name: 'Сокровищница',       cost: { stone: 40 },                       out: { gold: 0.5 }, passive: true, marketBoost: 1.2, req: 'currency', desc: '+0.5🪙/день, курсы рынка на 20% лучше.' },
  port:          { name: 'Порт',               cost: { wood: 35 },                        workers: 4, out: { food: 2.8 }, coast: true, winter: true, req: 'sailing', desc: 'Ставится на берегу. Еда с воды.' },
  aqueduct:      { name: 'Акведук',            cost: { stone: 50 },                       happy: 6,  req: 'construction', desc: '+6 счастья всем.' },
  temple:        { name: 'Храм',               cost: { stone: 60, gold: 20 },             workers: 2, happy: 8,  req: 'theology', desc: '+8 счастья.' },
  clinic:        { name: 'Лечебница',          cost: { wood: 30, stone: 30 },             workers: 2, medicine: 0.5, req: 'medicine', desc: 'Болезни ×0.5.' },
  amphitheater:  { name: 'Амфитеатр',          cost: { stone: 80 },                       happy: 10, req: 'aesthetics', desc: '+10 счастья.' },
  academy:       { name: 'Академия',           cost: { stone: 70, gold: 30 },             workers: 4, out: { knowledge: 1.2 }, req: 'mathematics', desc: 'Наука Античности.' },
  castle:        { name: 'Замок',              cost: { stone: 160, gold: 60 },            housing: 10, defense: 30, unique: true, req: 'castles', desc: 'Оборона +30, жильё 10. Одна штука.' },
  university:    { name: 'Университет',        cost: { stone: 90, gold: 50 },             workers: 5, out: { knowledge: 2.2 }, req: 'education', desc: 'Кузница знаний.' },
  mill:          { name: 'Мельница',           cost: { wood: 40, stone: 20 },             aura: { r: 3, farm: 1.5 }, req: 'machinery', desc: 'Фермы в радиусе 3 +50%.' },
  guild_hall:    { name: 'Мастерская гильдии', cost: { wood: 50, stone: 40 },             workers: 4, out: { gold: 1.4 }, req: 'guilds', desc: 'Золото ремёсел.' },
  bank:          { name: 'Банк',               cost: { stone: 100, gold: 80 },            goldMult: 1.25, req: 'banking', desc: 'Всё золото ×1.25 (не стакается).' },
  stone_walls:   { name: 'Каменные стены',     cost: { stone: 12 },                       defense: 5, wall: 500, req: 'castles', desc: 'Оборона +5 за сегмент.' },
  press:         { name: 'Печатный двор',      cost: { wood: 60, stone: 40, gold: 30 },   workers: 3, out: { knowledge: 1.8 }, happy: 5, req: 'printing', desc: '📜1.8 и +5% счастья.' },
  observatory:   { name: 'Обсерватория',       cost: { stone: 120, gold: 60 },            workers: 3, out: { knowledge: 2.6 }, req: 'optics', desc: 'Окно в звёзды.' },
  shipyard:      { name: 'Верфь',              cost: { wood: 120, stone: 60 },            workers: 4, out: { gold: 2.0 }, coast: true, caravanMult: 1.5, req: 'navigation', desc: 'Караваны +50%.' },
  foundry:       { name: 'Литейная',           cost: { stone: 100, gold: 50 },            armyMult: 1.2, req: 'gunpowder', desc: 'Армия +20%, мушкетёры.' },
  workshop:      { name: 'Мануфактура',        cost: { wood: 60, stone: 40 },             workers: 5, out: { wood: 1.5, stone: 1.5 }, req: 'steam', desc: 'Мастерские пара.' },
  train_station: { name: 'Вокзал',             cost: { wood: 150, stone: 150, gold: 100 }, caravanMult: 2, radiusBonus: 2, req: 'railroads', desc: 'Караваны ×2, радиусы +2.' },
  factory:       { name: 'Фабрика',            cost: { stone: 200, gold: 100 },           workers: 6, out: { steel: 1.5 }, consume: { stone: 1.0 }, req: 'industrialization', desc: 'Производит ⚙️ сталь из камня.' },
  sewers:        { name: 'Канализация',        cost: { stone: 120 },                      medicine: 0.3, req: 'sanitation', desc: 'Эпидемии ×0.3.' },
  stock_exchange:{ name: 'Биржа',              cost: { stone: 180, gold: 200 },           goldMult: 1.3, req: 'corporations', desc: 'Всё золото ×1.3.' },
  power_plant:   { name: 'Электростанция',     cost: { stone: 220, steel: 80 },           industry: 1.25, req: 'electricity', desc: 'Вся промышленность +25%.' },
  lab:           { name: 'Лаборатория',        cost: { stone: 100, steel: 40, gold: 80 }, workers: 5, out: { knowledge: 3.0 }, req: 'electricity', desc: 'Наука Современности.' },
  apartment:     { name: 'Многоэтажка',        cost: { stone: 150, steel: 60 },           housing: 24, req: 'electricity', desc: 'Жильё для 24.', evolve: 'house' },
  media_tower:   { name: 'Телецентр',          cost: { stone: 120, steel: 80, gold: 100 }, happy: 12, req: 'mass_media', desc: '+12 счастья всем.' },
  hospital:      { name: 'Госпиталь',          cost: { stone: 180, steel: 60 },           medicine: 0.5, birthMult: 1.3, req: 'penicillin', desc: 'Смертность −50%.' },
  airport:       { name: 'Аэропорт',           cost: { stone: 300, steel: 150, gold: 200 }, workers: 4, out: { gold: 4.0 }, caravanMult: 2, req: 'flight', desc: 'Глобальная торговля.' },
  npp:           { name: 'АЭС',                cost: { stone: 400, steel: 200 },          industry: 1.5, risk: 'npp', req: 'nuclear', desc: 'Промышленность +50%. Риск аварии 0.2%/день.' },
  datacenter:    { name: 'Дата-центр',         cost: { stone: 200, steel: 150, gold: 150 }, workers: 4, out: { knowledge: 4.0 }, req: 'internet', desc: 'Серверы знаний.' },
  solar:         { name: 'Солнечная ферма',    cost: { steel: 120, gold: 80 },            industry: 1.2, req: 'renewables', desc: 'Промышленность +20% (стакается).' },
  robo_factory:  { name: 'Робозавод',          cost: { steel: 300, gold: 200 },           workers: 0, out: { steel: 3.0 }, req: 'robotics', desc: '⚙️3.0 без рабочих.' },
  biolab:        { name: 'Биолаборатория',     cost: { steel: 180, gold: 150 },           workers: 4, out: { knowledge: 3.0 }, birthMult: 1.2, req: 'biotech', desc: '📜3.0 и здоровье.' },
  skyscraper:    { name: 'Небоскрёб',          cost: { stone: 300, steel: 200 },          housing: 40, req: 'internet', desc: 'Жильё для 40.', evolve: 'house' },
  ai_core:       { name: 'ИИ-центр',           cost: { steel: 400, gold: 300 },           workers: 2, out: { knowledge: 8.0 }, req: 'ai', desc: 'Разум машины.' },
  fusion_reactor:{ name: 'Термояд',            cost: { steel: 600, gold: 400 },           industry: 1.5, req: 'fusion', desc: 'Промышленность ×1.5 глобально.' },
  spaceport:     { name: 'Космопорт',          cost: { steel: 500, gold: 500 },           special: 'missions', req: 'spaceflight', desc: 'Миссии: Луна (30д, +2000🪙), Марс (60д, +3000📜).' },
  spire:         { name: 'ШПИЛЬ ЦИВИЛИЗАЦИИ',  cost: {}, size: 2, unique: true, special: 'spire', req: 'singularity', desc: 'Мегапроект из 5 стадий. Финал игры.' },
};

// Эпоха появления здания (по его req-технологии) — для спрайтов
export const BUILDING_ERA_IDX = (() => {
  const map = {};
  for (const [id, b] of Object.entries(BUILDINGS)) map[id] = b.req ? (TECH_ERA_IDX[b.req] ?? 0) : 0;
  return map;
})();

// ---- Стадии Шпиля ----
export const SPIRE_STAGES = [
  { name: 'Фундамент',  cost: { stone: 1000, steel: 400 },                 days: 15 },
  { name: 'Каркас',     cost: { steel: 800, gold: 600 },                   days: 15 },
  { name: 'Ядро ИИ',    cost: { knowledge: 4000, gold: 800 },              days: 20 },
  { name: 'Оболочка',   cost: { steel: 1200, gold: 1000 },                 days: 20 },
  { name: 'Маяк',       cost: { knowledge: 6000, steel: 800, gold: 1500 }, days: 25 },
];

// ---- Юниты армии (авто-апгрейд по технологиям) ----
export const UNITS = [
  { id: 'militia',   name: 'Ополченец',  power: 2,  req: 'warfare',            role: 'inf' },
  { id: 'swordsman', name: 'Мечник',     power: 4,  req: 'steel_tech',         role: 'inf' },
  { id: 'knight',    name: 'Рыцарь',     power: 7,  req: 'castles',            role: 'cav' },
  { id: 'musketeer', name: 'Мушкетёр',   power: 10, req: 'gunpowder',          role: 'range' },
  { id: 'marksman',  name: 'Стрелок',    power: 14, req: 'industrialization',  role: 'range' },
  { id: 'soldier',   name: 'Пехотинец',  power: 20, req: 'electricity',        role: 'inf' },
  { id: 'drone',     name: 'Дрон',       power: 30, req: 'robotics',           role: 'range' },
];
export const TRAIN_COST = { food: 20, gold: 10 };
export const ARMY_UPKEEP = { food: 0.5, gold: 0.2 }; // на бойца в день

// Контры: атакующий получает +7 эффективной силы против цели
export const COUNTERS = { inf: { cav: 7 }, cav: { range: 7 }, range: { inf: 7 }, siege: { building: 3 } };

// ---- Фракции (8) ----
export const FACTIONS = [
  { id: 'wolves', name: 'Волчий Предел', leader: 'ярл Хродгейр', color: '#8e2f2f', banner: 'волк',
    traits: { aggression: 9, expansion: 7, trade: 3, science: 3, faith: 4, defense: 5 },
    bonus: { army: 1.25, trainCost: 0.8 }, penalty: { science: 0.85 },
    agenda: { likes: 'военную мощь не ниже своей', hates: 'армию слабее половины своей', likeMod: 10, hateMod: -15 },
    lines: { greet: 'Волк здоровается только с теми, у кого клыки остры.', praise: 'Твоя стая сильна. Волк это уважает.', threat: 'Слабых мы не бьём — мы их стираем.', war: 'Стая выходит на тропу. Молиться поздно.', peace: 'Хорошо. Сегодня волк сыто ложится спать.' } },
  { id: 'guild', name: 'Золотая Гильдия', leader: 'консул Мерцелла', color: '#c9a227', banner: 'весы',
    traits: { aggression: 3, expansion: 4, trade: 9, science: 6, faith: 2, defense: 4 },
    bonus: { gold: 1.3, caravans: 1.5 }, penalty: { army: 0.8 },
    agenda: { likes: 'торговые союзы', hates: 'грабёж караванов', likeMod: 10, hateMod: -15 },
    lines: { greet: 'Караваны — кровь мира. Обереги их — и озолотимся оба.', praise: 'С тобой приятно вести дела.', threat: 'Мой кошель тяжелее твоей армии. Подумай.', war: 'Война — плохая сделка. Но ты настоял.', peace: 'Мир — лучший контракт сезона. Подписан.' } },
  { id: 'dawn', name: 'Орден Зари', leader: 'иерофант Селена', color: '#e8ddc0', banner: 'солнце',
    traits: { aggression: 5, expansion: 4, trade: 4, science: 3, faith: 9, defense: 6 },
    bonus: { happy: 2 }, penalty: { science: 0.9 },
    agenda: { likes: 'строящих храмы', hates: 'разрушивших храм', likeMod: 10, hateMod: -40 },
    lines: { greet: 'Заря встаёт для всех. Не для всякого — дважды.', praise: 'Свет в твоём народе силён.', threat: 'Тьма перед рассветом глубока. Не становись ею.', war: 'Свет очищает. Даже огнём.', peace: 'Заря прощает. Один раз.' } },
  { id: 'cog', name: 'Дом Механиков', leader: 'магистр Ирвин', color: '#4a7fa5', banner: 'шестерня',
    traits: { aggression: 2, expansion: 3, trade: 6, science: 9, faith: 2, defense: 5 },
    bonus: { science: 1.25, diffusion: 0.4 }, penalty: { growth: 0.9 },
    agenda: { likes: 'лидера по технологиям', hates: 'отстающих на 2+ эпохи', likeMod: 10, hateMod: -15 },
    lines: { greet: 'Каждый механизм прост, если понять его. Кроме людей.', praise: 'Твои мысли идут впереди твоих стен.', threat: 'Рычаг длиной в знание сдвинет и тебя.', war: 'Мы просчитали эту войну. Тебе не понравится результат.', peace: 'Рационально. Заключаем.' } },
  { id: 'horde', name: 'Степная Орда Кха', leader: 'хан Тэмуджэй', color: '#b5722f', banner: 'конь',
    traits: { aggression: 7, expansion: 9, trade: 4, science: 2, faith: 3, defense: 2 },
    bonus: { speed: 1.5, outpost: 0.5 }, penalty: { happy: 0.7 },
    agenda: { likes: 'быстро растущих', hates: '«черепах» без экспансии', likeMod: 10, hateMod: -15 },
    lines: { greet: 'Степь не знает стен. Интересно, зачем они тебе?', praise: 'Ты движешься, как ветер. Это по-нашему.', threat: 'Кони чуют страх за три перехода.', war: 'Орда уже в пути. Считай степные огни.', peace: 'Конь отдохнёт. Ненадолго.' } },
  { id: 'tide', name: 'Морской Народ Тайр', leader: 'навигатор Кайя', color: '#2fa5a0', banner: 'трезубец',
    traits: { aggression: 4, expansion: 6, trade: 7, science: 5, faith: 3, defense: 4 },
    bonus: { port: 1.5 }, penalty: { hills: 0.8 },
    agenda: { likes: 'прибрежных торговцев', hates: 'претендующих на «его» море', likeMod: 10, hateMod: -15 },
    lines: { greet: 'Море помнит все имена. Твоё — пока без метки.', praise: 'Твои гавани полны — волна тебя любит.', threat: 'Отлив уносит целые города. Знаешь об этом?', war: 'Волна уже поднялась. Не смотри на горизонт.', peace: 'Море успокоилось. Плывём рядом.' } },
  { id: 'grove', name: 'Лесное Согласие Эйр', leader: 'старейшина Ниа', color: '#3f7d3f', banner: 'лист',
    traits: { aggression: 2, expansion: 2, trade: 4, science: 5, faith: 6, defense: 9 },
    bonus: { wood: 1.3, happy: 10, forestDefense: 1.5 }, penalty: { outpost: 1.5 },
    agenda: { likes: 'не рубящих лес у границ', hates: 'вырубку в 6 клетках от рощ', likeMod: 10, hateMod: -15 },
    lines: { greet: 'Роща слушает. Говори тихо.', praise: 'Ты берёшь у леса с благодарностью. Это редкость.', threat: 'Топор, поднятый на рощу, падает на поднявшего.', war: 'Корни запомнят эту зиму. И ответят.', peace: 'Листва шумит о перемирии.' } },
  { id: 'syndicate', name: 'Железный Синдикат', leader: 'директор Крамм', color: '#d06a1f', banner: 'молот',
    traits: { aggression: 6, expansion: 5, trade: 7, science: 7, faith: 1, defense: 6 },
    bonus: { steel: 1.3, build: 1.25 }, penalty: { happy: -10 },
    agenda: { likes: 'индустриализацию', hates: '«аграриев» без фабрик', likeMod: 10, hateMod: -15 },
    lines: { greet: 'Синдикат не здоровается. Синдикат оценивает мощности.', praise: 'Твои трубы дымят правильно.', threat: 'Плавильня не выбирает, что плавить.', war: 'Производственный план скорректирован: цель — ты.', peace: 'Простой линий невыгоден. Мир.' } },
];

// ---- Дипломатия: факторы отношений ----
export const DIPLO_FACTORS = {
  tradeTreaty:  { dR: 20,  decay: 0,     ru: 'Торговый договор' },
  gift:         { dR: 15,  decay: 0.1,   ru: 'Подарок' },
  jointWar:     { dR: 15,  decay: 0.05,  ru: 'Совместная война' },
  agendaLike:   { dR: 10,  decay: 0,     ru: 'Агенда уважается' },
  agendaHate:   { dR: -15, decay: 0,     ru: 'Агенда нарушена' },
  border:       { dR: -0.1, decay: 0,    ru: 'Границы близко' },
  declaredWar:  { dR: -60, decay: 0.1,   ru: 'Объявление войны' },
  caravanRaid:  { dR: -25, decay: 1 / 15, ru: 'Ограбление каравана' },
  refusedTribute: { dR: -10, decay: 0.1, ru: 'Отказ в дани' },
  tributePaid:  { dR: 8,   decay: 0,     ru: 'Дань выплачена' },
};

// ---- Рынок: базовые курсы (за 1 ед. ресурса в золоте) ----
export const MARKET_BASE = { food: 0.1, wood: 0.125, stone: 0.167, steel: 4 };

// ---- Сезоны и погода ----
export const SEASONS = ['Весна', 'Лето', 'Осень', 'Зима'];
export const DAYS_PER_SEASON = 25;
export const WEATHER_TABLE = [
  [['sun', 55], ['cloud', 25], ['rain', 18], ['snow', 2]],
  [['sun', 70], ['cloud', 15], ['rain', 15], ['snow', 0]],
  [['sun', 40], ['cloud', 30], ['rain', 25], ['snow', 5]],
  [['sun', 30], ['cloud', 20], ['rain', 5], ['snow', 45]],
];
export const WEATHER = {
  sun:   { ru: 'Ясно',  gather: 1.0, farm: 1.0, happy: 2 },
  cloud: { ru: 'Облачно', gather: 1.0, farm: 0.95, happy: 0 },
  rain:  { ru: 'Дождь', gather: 0.85, farm: 1.15, happy: -3 },
  snow:  { ru: 'Снег',  gather: 0.7, farm: 0.4, happy: -5 },
};

// ---- События (22, data-driven) ----
export const EVENT_DEFS = [
  { id: 'omen',      w: 10, ru: 'Знамение',        text: 'Шаманы видят добрый знак в звёздах.', effect: { happy: 5 } },
  { id: 'wanderer',  w: 10, ru: 'Странник',        text: 'Странник просится в поселение.', effect: { pop: 1 }, cond: 'housing' },
  { id: 'insight',   w: 8,  ru: 'Озарение',        text: 'Кому-то пришла в голову светлая мысль.', effect: { knowledge: 15 }, boost: 'story_fire' },
  { id: 'harvest',   w: 8,  ru: 'Хороший урожай',  text: 'Год выдался урожайным.', effect: { foodPct: 0.1 }, minEra: 0 },
  { id: 'wolf',      w: 6,  ru: 'Волки',           text: 'Волчья стая подошла к домам.', effect: { foodPct: -0.05 } },
  { id: 'cold',      w: 5,  ru: 'Лютой холод',     text: 'Морозы трещат. Нужно больше дров.', effect: { woodPct: -0.08 }, season: 3 },
  { id: 'fire_event', w: 5, ru: 'Пожар',           text: 'Вспыхнуло здание! Огонь распространяется.', choice: { a: { ru: 'Тушить (10🪵)', cost: { wood: 10 } }, b: { ru: 'Дать выгореть', effect: { damageBuilding: 1 } } } },
  { id: 'trader',    w: 7,  ru: 'Странствующий торговец', text: 'Торговец предлагает партию припасов по дешёвке.', req: 'trade', choice: { a: { ru: 'Купить 80🍞 за 20🪙', cost: { gold: 20 }, effect: { food: 80 } }, b: { ru: 'Отказать' } } },
  { id: 'flood',     w: 4,  ru: 'Наводнение',      text: 'Река вышла из берегов: прибрежные поля потеряют урожай сезона.', effect: { farmPenalty: 25 } },
  { id: 'quake',     w: 3,  ru: 'Землетрясение',   text: 'Земля содрогнулась — здания повреждены!', effect: { damageBuilding: 2 }, minEra: 2 },
  { id: 'plague_event', w: 4, ru: 'Чума',          text: 'Мор пришёл в поселение.', effect: { plague: 5 }, minEra: 4 },
  { id: 'riot',      w: 6,  ru: 'Бунт',            text: 'Недовольство кипит: толпа требует перемен.', cond: 'unhappy', choice: { a: { ru: 'Уступки (−30🪙)', cost: { gold: 30 }, effect: { happy: 15 } }, b: { ru: 'Подавить', effect: { happy: -10, pop: -1 } } } },
  { id: 'gold_vein', w: 5,  ru: 'Золотая жила',    text: 'В холмах нашли золотую жилу!', effect: { gold: 40 }, req: 'trade' },
  { id: 'scholar',   w: 6,  ru: 'Учёный-гость',    text: 'Странствующий мудрец делится знаниями.', effect: { knowledge: 40 }, minEra: 1 },
  { id: 'meteor_shower', w: 4, ru: 'Метеорный дождь', text: 'Небо расчертили падающие звёзды — все загадывают желания.', effect: { knowledge: 25, happy: 5 }, visual: 'meteor' },
  { id: 'crash',     w: 4,  ru: 'Биржевой кризис', text: 'Рынки рухнули: золото тает на глазах.', effect: { goldPct: -0.3 }, req: 'corporations' },
  { id: 'npp_event', w: 1,  ru: 'Авария АЭС',      text: 'Тревога на АЭС! Радиоактивное облако.', effect: { happy: -15, steel: -50 }, cond: 'npp' },
  { id: 'pandemic',  w: 3,  ru: 'Пандемия',        text: 'Вирус гуляет по городу.', effect: { plague: 8 }, minEra: 8 },
  { id: 'solar_storm', w: 3, ru: 'Солнечная буря', text: 'Магнитная буря: дата-центры работают вполсилы.', effect: { dcPenalty: 5 }, minEra: 8 },
  { id: 'envoys',    w: 5,  ru: 'Дипломаты соседей', text: 'Послы предлагают прекратить набеги: мир или дань.', cond: 'repelled2', choice: { a: { ru: 'Мир (+отношения)', effect: { peaceNeighbors: 1 } }, b: { ru: 'Требовать дань (+100🪙)', effect: { gold: 100 } } } },
  { id: 'festival',  w: 6,  ru: 'Праздник',        text: 'Поселение устраивает праздник.', effect: { happy: 8 } },
  { id: 'twins',     w: 5,  ru: 'Близнецы',        text: 'В поселении родились близнецы — добрый знак!', effect: { pop: 2 }, cond: 'housing' },
];

// ---- Цели кампании (25) ----
export const OBJECTIVES = [
  { id: 'o1',  text: 'Постройте Хижину',                 check: 'building:hut' },
  { id: 'o2',  text: 'Лесопилка вплотную к лесу',        check: 'building:lumber' },
  { id: 'o3',  text: 'Население 10',                     check: 'pop:10' },
  { id: 'o4',  text: 'Костёр историй',                   check: 'building:story_fire' },
  { id: 'o5',  text: 'Земледелие и Ферма',               check: 'tech:farming+building:farm' },
  { id: 'o6',  text: 'Амбар',                            check: 'building:granary' },
  { id: 'o7',  text: 'Бронзовый век',                    check: 'era:1' },
  { id: 'o8',  text: 'Библиотека',                       check: 'building:academy|building:press', checkAlt: 'tech:writing' },
  { id: 'o9',  text: 'Рынок и 50🪙',                      check: 'building:market+gold:50' },
  { id: 'o10', text: 'Железный век',                     check: 'era:2' },
  { id: 'o11', text: 'Казарма и 3 бойца',                check: 'building:barracks+army:3' },
  { id: 'o12', text: 'Отбейте первый рейд',              check: 'repelled:1' },
  { id: 'o13', text: 'Античность',                       check: 'era:3' },
  { id: 'o14', text: 'Храм или Амфитеатр',               check: 'any:temple,amphitheater' },
  { id: 'o15', text: 'Средневековье',                    check: 'era:4' },
  { id: 'o16', text: 'Университет',                      check: 'building:university' },
  { id: 'o17', text: 'Ренессанс',                        check: 'era:5' },
  { id: 'o18', text: 'Верфь или Обсерватория',           check: 'any:shipyard,observatory' },
  { id: 'o19', text: 'Индустриальная эпоха',             check: 'era:6' },
  { id: 'o20', text: 'Фабрика и 100⚙️',                   check: 'building:factory+steel:100' },
  { id: 'o21', text: 'Современность',                    check: 'era:7' },
  { id: 'o22', text: 'Аэропорт',                         check: 'building:airport' },
  { id: 'o23', text: 'Информационная эпоха',             check: 'era:8' },
  { id: 'o24', text: 'Эпоха Будущего',                   check: 'era:9' },
  { id: 'o25', text: 'Постройте ШПИЛЬ ЦИВИЛИЗАЦИИ',      check: 'spire:5' },
];

// ---- Имена жителей ----
export const NAMES = ['Алёна', 'Борис', 'Вела', 'Горд', 'Дана', 'Егор', 'Жана', 'Зорян', 'Ива', 'Крам', 'Лада', 'Милан', 'Нора', 'Олег', 'Пламена', 'Радо', 'Света', 'Тверд', 'Уля', 'Хорс', 'Цвета', 'Чага', 'Шана', 'Эль', 'Яромир', 'Яна', 'Велимир', 'Гост', 'Добрыня', 'Злата'];

// ---- Великие люди ----
export const GREAT_TYPES = [
  { id: 'scientist', ru: 'Учёный',    desc: '+📜 (300 × номер эпохи)' },
  { id: 'general',   ru: 'Полководец', desc: '+2 силы всем юнитам навсегда' },
  { id: 'merchant',  ru: 'Торговец',  desc: '+15% 🪙 навсегда' },
  { id: 'architect', ru: 'Зодчий',    desc: 'Следующее здание возводится мгновенно' },
  { id: 'prophet',   ru: 'Пророк',    desc: '+10 счастья навсегда' },
];
