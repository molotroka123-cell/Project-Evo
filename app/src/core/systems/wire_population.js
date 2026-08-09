// core/systems/wire_population.js — оживление core/systems/population.js.
//
// Модуль населения написан, покрыт тестами и до сих пор не вызывался ни разу.
// Здесь — слой подключения (по образцу integrate.js) и экран «Люди» для игрока.
//
// ПРАВИЛО СЛОЯ. population.js не знает про Simulation: он получает ctx, считает
// день и возвращает отчёт. Применяет отчёт к миру этот файл. Поэтому здесь нет
// ни одной формулы демографии — только сборка ctx, применение отчёта и показ.
//
// ЗАМЕНА, А НЕ ДОБАВКА. Ядро вело своё примитивное население: «рождение по шансу
// при счастье > 45» и «смерть от старости после 11000 дней». Оба пути в onNewDay
// должны быть выключены — иначе поселение получит двойной прирост и две разные
// смертности. Точные строки к удалению — в блоке ПОДКЛЮЧЕНИЕ в конце файла.
//
// DOM здесь не трогается: renderPanel() возвращает строку, bindPanel() получает
// корневой узел снаружи. Math.random запрещён — только sim.rng.

import { BUILDINGS } from '../data.js';
import * as Pop from './population.js';

// Ядро не экспортирует EAT_PER_DAY, а ctx модуля просит запас еды в днях.
// Значение обязано совпадать с simulation.js: там та же константа 0.7.
const EAT = 0.7;

// Шанс, что к поселению за день прибьются чужаки. Ядро на этом же месте
// «рожало» с шансом 0.1 — рождения теперь считает модуль, а прежний блок
// становится притоком извне (как в Banished): без него шесть стартовых жителей
// возрастом 18–90 лет часто не успевают дать второе поколение.
export const MIGRATE_CHANCE = 0.03;

// Подъёмные переселенцу: чем больше поселение, тем дороже сманить человека.
const INVITE_BASE = 30;
const INVITE_PER_POP = 8;

// Отсрочка по просьбе жителей: откуп, чтобы не терять настроение зря.
const DELAY_COST = 20;
const DELAY_DAYS = 30;
// Пауза после отказа. В population.js REQUEST_GAP = 90 и наружу не выведен;
// после прямого отказа держим паузу короче — люди обижаются, но не молчат год.
const DECLINE_GAP = 60;
const DECLINE_MOOD = 5;

// Сколько жителей показывать в списке до нажатия «показать всех».
const LIST_LIMIT = 10;
// Глубина списка некрологов.
const OBIT_KEEP = 12;

const JOB_RU = {
  idle: 'без дела', build: 'на стройке', work: 'на работе',
  hunt: 'на охоте', deadfall: 'собирает валежник', forage: 'собирает еду',
};

// Промысел вне зданий — тоже ремесло. Ядро зовёт produceAt только для работы
// внутри здания, поэтому охотники, собиратели и строители не получали опыта
// вовсе: в молодом поселении зданий на всех не хватает, и ранги не появлялись
// ни у кого. Здесь эти занятия переводятся в отрасли модуля.
const OUTDOOR_INDUSTRY = { build: 'build', hunt: 'food', forage: 'food', deadfall: 'wood' };

// ============================ АДАПТЕР ============================

// Ставится в конце конструктора Simulation: к этому моменту стартовые жители
// уже созданы (в том числе доп. жители startFromEra), и всем сразу выдаются
// пол, черта характера и учётная карточка.
export function wirePopulationInstall(sim) {
  sim.pop = Pop.createPopulation(sim.rng);
  sim.popWire = createWireState();
  Pop.syncVillagers(sim.pop, sim.villagers, sim.rng);
  return sim.pop;
}

function createWireState() {
  return {
    ver: 1,
    obits: [],                                   // [{day, text}] — последние некрологи
    last: { day: 0, born: 0, died: 0, arrived: 0 },
    arrived: 0, invited: 0, declined: 0,
    // Состояние экрана держим здесь же: HUD перерисовывается каждый кадр и
    // своей памяти между кадрами не имеет, а лишнее поле в Hud — лишняя правка
    // чужого файла. В сейв ui не попадает: это вид, а не мир.
    ui: { sort: 'age', sel: null, all: false },
  };
}

// Один игровой день. Зовётся из onNewDay ПОСЛЕ systemsNewDay (зима уже пометила
// замёрзших) и ДО общего фильтра `villagers.filter(v => v.hp > 0)` — модуль
// только помечает hp = 0, а вычищает всех один и тот же фильтр ядра.
export function wirePopulationNewDay(sim) {
  if (!sim || !sim.pop) return null;
  const w = _wire(sim);

  // Ядро местами убирает жителя молча (голод, бунт, эмиграция, мор) — через
  // villagers.pop(). Ссылка на супруга у оставшегося при этом повисает, и вдова
  // навсегда выпадает из поиска пары. Чиним до расчёта дня.
  _sweepPartners(sim.villagers);

  // Возраст двигало ядро в блоке «старение и смерть». Блок выключается целиком
  // (там же сидела смерть по таймеру), поэтому возраст двигаем здесь: модуль
  // v.age намеренно не трогает.
  for (const v of sim.villagers) if (v.hp > 0) v.age++;

  const rep = Pop.tickDay(sim.pop, sim.villagers, populationCtx(sim), sim.rng);

  // Тексты берём из отчёта: своего второго журнала рождений и смертей здесь
  // быть не должно, иначе каждое событие попадёт в лог дважды.
  for (const e of rep.events) sim.addLog(e.text, e.type);

  for (const d of rep.died) {
    const text = Pop.obituary(d.v, d.cause);
    w.obits.push({ day: sim.day, text });
    // В хронику — только те, чью жизнь есть чем помянуть: мастера и старики.
    if ((d.v.rank || 0) >= 3 || Pop.ageYears(d.v) >= 80) sim.addChronicle(text);
  }
  if (w.obits.length > OBIT_KEEP) w.obits.splice(0, w.obits.length - OBIT_KEEP);

  // Опыт за день промысла. Работу внутри зданий считает tickVillagers (правка 6
  // в блоке ПОДКЛЮЧЕНИЕ) — тех, кто на смене, здесь пропускаем, иначе двойной счёт.
  const learn = wirePopulationLearnMult(sim);
  for (const v of sim.villagers) {
    if (v.hp <= 0 || v.atWork) continue;
    const ind = OUTDOOR_INDUSTRY[v.job];
    if (ind) Pop.registerWork(sim.pop, v, ind, learn);
  }

  const arrived = _tickMigration(sim, w);
  w.last = { day: sim.day, born: rep.born.length, died: rep.died.length, arrived };
  w.arrived += arrived;
  return rep;
}

// Сборка ctx — единственное место, где ядро переводится на язык модуля.
export function populationCtx(sim) {
  const pop = aliveCount(sim);
  return {
    day: sim.day,
    pop,
    housingCap: sim.housingCap(),
    happiness: sim._happy ?? sim.happiness(),
    foodDays: sim.res.food / Math.max(1, pop * EAT),
    birthMult: birthMult(sim),
    mortalityMult: mortalityMult(sim),
    builtIds: sim.doneBuildings().map(b => b.id),
    // Просить можно только то, что игроку доступно: иначе жители требуют
    // небоскрёб в каменном веке.
    buildable: Object.keys(BUILDINGS).filter(id => !BUILDINGS[id].req || sim.techs.has(BUILDINGS[id].req)),
    threat: !!(sim.raids && sim.raids.warning) || !!(sim.wars && sim.wars.length),
    homeX: sim.world.startX, homeY: sim.world.startY,
  };
}

// Рождаемость от построек. Множители лежат в data.js (hospital 1.3, biolab 1.2),
// поэтому читаем их оттуда, а не переписываем числа сюда.
export function birthMult(sim) {
  let m = 1;
  const seen = new Set();
  for (const b of sim.doneBuildings()) {
    if (seen.has(b.id)) continue;                // два госпиталя — не двойная рождаемость
    seen.add(b.id);
    m *= BUILDINGS[b.id].birthMult || 1;
  }
  return m;
}

// Смертность от медицины, холода и голода. medicineMult() ядра рассчитан на
// разовый мор и при полном наборе даёт 0.075 — для ежедневной смертности это
// было бы почти бессмертие. Берём смягчённую долю: полная медицина срезает
// риск примерно вдвое, а не в тринадцать раз.
export function mortalityMult(sim) {
  const med = typeof sim.medicineMult === 'function' ? sim.medicineMult() : 1;
  let m = 0.45 + 0.55 * med;
  const sick = sim.sys && sim.sys.winter ? (sim.sys.winter.sick || 0) : 0;
  if (sick > 0) m *= 1 + Math.min(1, sick / Math.max(1, aliveCount(sim))) * 0.9;
  return m;
}

// Скорость роста ранга: где учат, там ремесло схватывают быстрее. Модулю это
// передаётся множителем к dt в registerWork — своей «школы» здесь не заводим.
export function wirePopulationLearnMult(sim) {
  let m = 1;
  if (sim.hasBuilding('story_fire')) m *= 1.1;
  if (sim.hasBuilding('academy')) m *= 1.2;
  if (sim.hasBuilding('university')) m *= 1.3;
  if (sim.hasBuilding('guild_hall')) m *= 1.25;
  if (sim.techs.has('writing')) m *= 1.1;
  return m;
}

// Вклад просьб жителей в счастье. Ядро прибавляет это в happiness().
export function wirePopulationHappyMod(sim) {
  return sim && sim.pop ? Pop.happyMod(sim.pop) : 0;
}

// ---------- приток извне ----------

function _tickMigration(sim, w) {
  const pop = aliveCount(sim);
  const happy = sim._happy ?? sim.happiness();
  if (!(happy > 45 && sim.res.food > pop * 3 && pop < sim.housingCap())) return 0;
  let chance = MIGRATE_CHANCE;
  if (sim.hasBuilding('market')) chance *= 1.3;   // слух о сытом месте идёт по торговым путям
  if (!sim.rng.chance(chance)) return 0;
  const v = _addSettler(sim, 'сам пришёл на дым костра');
  if (!v) return 0;
  sim.addLog(`К поселению прибились новые люди: ${v.name}.`, 'good');
  return 1;
}

// Новый житель создаётся ядром (spawnVillager), поля модуля выдаёт syncVillagers.
// Своего генератора людей здесь нет — иначе форма жителя разъедется с ядром.
function _addSettler(sim, deed) {
  const before = sim.villagers.length;
  const c = sim.buildings.find(b => b.id === 'campfire' && !b.destroyed)
    || { x: sim.world.startX, y: sim.world.startY };
  sim.spawnVillager(c.x + sim.rng.range(-1, 1), c.y + sim.rng.range(-1, 1));
  if (sim.villagers.length === before) return null;
  const v = sim.villagers[sim.villagers.length - 1];
  // spawnVillager раздаёт возраст 18–90 лет: это годится для стартовой шестёрки,
  // но не для приезжих. С таким разбросом поселение за полвека превращалось в
  // дом престарелых — половина пришлых сразу старики, детей рожать некому.
  // В дорогу снимаются молодые: 17–32 года.
  v.age = sim.rng.int(1700, 3200);
  Pop.syncVillagers(sim.pop, sim.villagers, sim.rng);
  if (deed) Pop.recordDeed(v, deed);
  return v;
}

function _sweepPartners(villagers) {
  const alive = new Set();
  for (const v of villagers) if (v.hp > 0 && v.pid) alive.add(v.pid);
  for (const v of villagers) {
    if (v.partner && !alive.has(v.partner)) v.partner = null;
  }
}

// ---------- сохранение ----------

export function wirePopulationSerialize(sim) {
  if (!sim || !sim.pop) return null;
  const w = _wire(sim);
  return {
    ver: 1,
    pop: Pop.serialize(sim.pop, sim.villagers),
    obits: w.obits.slice(-OBIT_KEEP),
    arrived: w.arrived, invited: w.invited, declined: w.declined,
    last: { ...w.last },
  };
}

export function wirePopulationRestore(sim, data) {
  if (!sim) return;
  sim.popWire = createWireState();
  if (!data) {
    // Сейв старой версии: демографии в нём нет, заводим её на текущих жителях.
    sim.pop = Pop.createPopulation(sim.rng);
    Pop.syncVillagers(sim.pop, sim.villagers, sim.rng);
    return;
  }
  // Ядро сохраняет жителей подряд, а модуль пишет карточки только живых:
  // случайно попавший в сейв помеченный мёртвым сдвинул бы все индексы.
  sim.villagers = sim.villagers.filter(v => v.hp > 0);
  sim.pop = Pop.deserialize(data.pop, sim.villagers, sim.rng);
  const w = sim.popWire;
  w.obits = Array.isArray(data.obits) ? data.obits.slice(-OBIT_KEEP) : [];
  w.arrived = data.arrived || 0;
  w.invited = data.invited || 0;
  w.declined = data.declined || 0;
  if (data.last) w.last = { ...w.last, ...data.last };
}

// ============================ РЕШЕНИЯ ИГРОКА ============================

// Цена подъёмных переселенцу.
export function inviteCost(sim) {
  return Math.round(INVITE_BASE + INVITE_PER_POP * aliveCount(sim));
}

// Почему кнопка «позвать переселенцев» недоступна (null — доступна).
export function inviteBlocker(sim) {
  const pop = aliveCount(sim);
  if (sim.housingCap() - pop < 1) return 'селить некуда — нужно жильё';
  if (sim.res.food < pop * EAT * 5) return 'своих кормить нечем';
  const cost = inviteCost(sim);
  if (sim.res.gold < cost) return `нужно 🪙${cost} на подъёмные`;
  return null;
}

// Разбор строки решения. Отдельная функция, чтобы всё поведение экрана было
// доступно без DOM — и тесту, и консоли.
export function wirePopulationAction(sim, spec) {
  if (!sim || !sim.pop) return { ok: false, reason: 'Модуль населения не подключён' };
  const parts = String(spec || '').split(':');
  const ui = _wire(sim).ui;
  switch (parts[0]) {
    case 'sort':
      ui.sort = ['age', 'young', 'prof', 'rank', 'fam'].includes(parts[1]) ? parts[1] : 'age';
      return { ok: true, quiet: true };
    case 'sel': {
      const pid = Number(parts[1]);
      ui.sel = ui.sel === pid ? null : pid;      // повторный тык закрывает карточку
      return { ok: true, quiet: true };
    }
    case 'all':
      ui.all = !ui.all;
      return { ok: true, quiet: true };
    case 'invite': return _invite(sim);
    case 'delay': return _delayRequest(sim);
    case 'decline': return _declineRequest(sim);
    default: return { ok: false, reason: 'Неизвестное решение' };
  }
}

function _invite(sim) {
  const why = inviteBlocker(sim);
  if (why) return { ok: false, reason: `Переселенцы не придут: ${why}` };
  const cost = inviteCost(sim);
  sim.res.gold -= cost;
  const v = _addSettler(sim, 'приехал по зову старейшин');
  if (!v) { sim.res.gold += cost; return { ok: false, reason: 'Переселенец не дошёл' }; }
  _wire(sim).invited++;
  sim.addLog(`Подъёмные выплачены (🪙${cost}): ${v.name} перебрался в поселение.`, 'good');
  return { ok: true, text: `${v.name} — новый житель` };
}

function _delayRequest(sim) {
  const req = sim.pop.request;
  if (!req) return { ok: false, reason: 'Жители сейчас ничего не просят' };
  if (req.delayed) return { ok: false, reason: 'Отсрочку уже давали — второй раз не поверят' };
  if (sim.res.gold < DELAY_COST) return { ok: false, reason: `Нужно 🪙${DELAY_COST}` };
  sim.res.gold -= DELAY_COST;
  req.delayed = true;
  req.deadline += DELAY_DAYS;
  sim.addLog(`Жителям поднесли даров (🪙${DELAY_COST}): срок просьбы продлён на ${DELAY_DAYS} дней.`, 'info');
  return { ok: true, text: `Срок продлён на ${DELAY_DAYS} дней` };
}

// Прямой отказ дешевле просрочки (в модуле она стоит −7 настроения), но всё
// равно бьёт по настроению: слово старейшин чего-то стоит.
function _declineRequest(sim) {
  const req = sim.pop.request;
  if (!req) return { ok: false, reason: 'Жители сейчас ничего не просят' };
  const name = BUILDINGS[req.building] ? BUILDINGS[req.building].name : req.building;
  sim.pop.request = null;
  sim.pop.requestCooldown = DECLINE_GAP;
  sim.pop.mood -= DECLINE_MOOD;
  _wire(sim).declined++;
  sim.addLog(`Старейшины отказали жителям: ${name} строить не будут.`, 'bad');
  return { ok: true, text: 'Жители услышали отказ' };
}

// ============================ ДАННЫЕ ДЛЯ ЭКРАНА ============================

export function aliveVillagers(sim) {
  return sim && sim.villagers ? sim.villagers.filter(v => v.hp > 0) : [];
}
function aliveCount(sim) { return aliveVillagers(sim).length; }

// Возрастная пирамида по десятилетиям. Модуль даёт агрегаты (pyramid), а разбивку
// для картинки собираем здесь: это чистое представление, механики в ней нет.
export function ageHistogram(villagers) {
  const rows = [];
  for (let d = 0; d < 9; d++) rows.push({ from: d * 10, to: d * 10 + 9, m: 0, f: 0, n: 0 });
  rows.push({ from: 90, to: 999, m: 0, f: 0, n: 0 });
  for (const v of villagers) {
    const y = Pop.ageYears(v);
    const row = rows[Math.min(9, Math.floor(y / 10))];
    row.n++;
    if (v.sex === 'ж') row.f++; else row.m++;
  }
  return rows;
}

// Сословия: тот же народ, разложенный по общественным ступеням. Считается из
// полей модуля (возраст, ремесло, ранг) — ничего своего не выдумываем.
export function estates(villagers) {
  const out = [
    { id: 'kids', ru: 'Дети', desc: 'учатся у старших, работают вполсилы', n: 0 },
    { id: 'masters', ru: 'Мастера', desc: 'ранг 2–3, выработка выше', n: 0 },
    { id: 'crafts', ru: 'Ремесленники', desc: 'освоили ремесло, ранг 1', n: 0 },
    { id: 'hands', ru: 'Чернорабочие', desc: 'ремесла ещё нет', n: 0 },
    { id: 'elders', ru: 'Старики', desc: '60 лет и старше', n: 0 },
  ];
  const by = Object.fromEntries(out.map(e => [e.id, e]));
  for (const v of villagers) {
    const y = Pop.ageYears(v);
    if (y < 16) by.kids.n++;
    else if (y >= 60) by.elders.n++;
    else if ((v.rank || 0) >= 2) by.masters.n++;
    else if (v.prof) by.crafts.n++;
    else by.hands.n++;
  }
  return out;
}

// Ремёсла: сколько кого и сколько среди них мастеров.
export function crafts(villagers) {
  const out = [];
  for (const [id, def] of Object.entries(Pop.PROFESSIONS)) {
    const list = villagers.filter(v => v.prof === id);
    if (!list.length) continue;
    out.push({
      id, ru: def.plural,
      n: list.length,
      masters: list.filter(v => (v.rank || 0) >= 3).length,
      skilled: list.filter(v => (v.rank || 0) === 2).length,
    });
  }
  out.sort((a, b) => b.n - a.n);
  return out;
}

// Чем житель занят прямо сейчас — по полям ядра, а не по ремеслу.
export function doingNow(v) {
  if (v.atWork && v.target && v.target.b && BUILDINGS[v.target.b.id]) {
    return BUILDINGS[v.target.b.id].name;
  }
  return JOB_RU[v.job] || 'без дела';
}

function sortVillagers(list, mode) {
  const arr = list.slice();
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'ru');
  if (mode === 'young') arr.sort((a, b) => (a.age || 0) - (b.age || 0) || byName(a, b));
  else if (mode === 'rank') arr.sort((a, b) => (b.rank || 0) - (a.rank || 0) || (b.age || 0) - (a.age || 0));
  else if (mode === 'prof') arr.sort((a, b) => String(a.prof || 'яя').localeCompare(String(b.prof || 'яя')) || (b.rank || 0) - (a.rank || 0));
  else if (mode === 'fam') arr.sort((a, b) => String(a.fam || '').localeCompare(String(b.fam || ''), 'ru') || (b.age || 0) - (a.age || 0));
  else arr.sort((a, b) => (b.age || 0) - (a.age || 0) || byName(a, b));
  return arr;
}

// ============================ ОТРИСОВКА ============================

export function renderPopulationPanel(sim) {
  if (!sim) return '';
  if (!sim.pop) {
    return _card('Люди', '', 'Модуль населения ещё не подключён к ядру — см. блок ПОДКЛЮЧЕНИЕ в wire_population.js.');
  }
  const w = _wire(sim);
  const list = aliveVillagers(sim);
  const ctx = populationCtx(sim);

  let html = _renderSummary(sim, w, list, ctx);
  html += _renderRequest(sim, ctx);
  html += '<h4 class="group">Возрастная пирамида</h4>' + _renderPyramid(list);
  html += '<h4 class="group">Сословия и ремёсла</h4>' + _renderEstates(list);
  html += '<h4 class="group">Жители</h4>' + _renderPeople(sim, w, list);
  html += _renderObits(w);
  return html;
}

function _renderSummary(sim, w, list, ctx) {
  const p = Pop.pyramid(list);
  const cap = sim.housingCap();
  const free = cap - list.length;
  const cond = Pop.birthConditions({ ...ctx, pop: list.length });
  const condRu = cond >= 1.2 ? 'семьи заводят детей охотно'
    : cond >= 0.8 ? 'обычные'
      : cond >= 0.4 ? 'тяжёлые: детей рожают реже' : 'бедственные: рождений почти нет';
  const mort = ctx.mortalityMult;
  const mortRu = mort <= 0.7 ? `медицина срезает риск на ${Math.round((1 - mort) * 100)}%`
    : mort <= 1.05 ? 'обычная' : `выше обычной на ${Math.round((mort - 1) * 100)}%`;
  const mood = Pop.happyMod(sim.pop);
  const day = w.last;
  const delta = [
    day.born ? `+${day.born} рождённых` : '',
    day.arrived ? `+${day.arrived} пришлых` : '',
    day.died ? `−${day.died} умерших` : '',
  ].filter(Boolean).join(' · ') || 'без перемен';

  return `<div class="card"><div class="ttl"><span>Народ</span><span class="cost">${list.length}${isFinite(cap) ? ` / ${cap}` : ''}</span></div>
    <div class="desc">За последние сутки: ${delta}. Возраст, ремесло и родство ведёт модуль населения: люди стареют, женятся, учатся ремеслу и умирают по-настоящему.</div>
    <div class="kv"><span>Свободного жилья</span><span>${free > 0 ? `${free} ${Pop.plural(free, 'место', 'места', 'мест')}` : 'нет — рождений не будет'}</span></div>
    <div class="kv"><span>Семейных пар</span><span>${p.pairs}</span></div>
    <div class="kv"><span>Женщин детородного возраста</span><span>${p.fertile}</span></div>
    <div class="kv"><span>Условия для семей</span><span>${condRu}</span></div>
    <div class="kv"><span>Смертность</span><span>${mortRu}</span></div>
    <div class="kv"><span>Настроение от просьб</span><span>${mood > 0 ? '+' : ''}${mood} к счастью</span></div>
    <div class="kv"><span>Всего рождений / смертей</span><span>${sim.pop.stats.births} / ${sim.pop.stats.deaths}</span></div>
    ${_renderInvite(sim)}</div>`;
}

function _renderInvite(sim) {
  const cost = inviteCost(sim);
  const why = inviteBlocker(sim);
  return `<button class="btn${why ? ' disabled' : ''}" style="width:100%;margin-top:8px;padding:8px;font-size:12px"
      data-pop="invite"${why ? ' disabled' : ''}>Позвать переселенцев — 🪙${cost}</button>
    ${why ? `<div class="reason">Недоступно: ${_esc(why)}</div>`
      : '<div class="desc">Подъёмные приводят в поселение взрослого человека сразу — быстрее, чем ждать, пока вырастут свои.</div>'}`;
}

// Просьба жителей — единственное место, где народ говорит с игроком напрямую.
// Кнопка «Заложить» намеренно использует data-build: её уже обслуживает
// Hud.bindPanel, и клик открывает обычный режим постановки здания.
function _renderRequest(sim, ctx) {
  const req = Pop.activeRequest(sim.pop);
  const st = sim.pop.stats;
  const tail = `<div class="kv"><span>Исполнено / просрочено / отказов</span><span>${st.requestsDone} / ${st.requestsFailed} / ${_wire(sim).declined}</span></div>`;

  if (!req) {
    const cd = Math.max(0, sim.pop.requestCooldown || 0);
    return `<h4 class="group">Просьба жителей</h4>
      <div class="card"><div class="ttl"><span>Жители молчат</span><span class="cost">${cd ? `${cd} дн.` : 'скоро'}</span></div>
      <div class="desc">Новая просьба придёт не раньше чем через ${cd} ${Pop.plural(cd, 'день', 'дня', 'дней')}. Просят то, чего не хватает: голодным — амбар, тесно живущим — дома.</div>
      ${tail}</div>`;
  }

  const def = BUILDINGS[req.building] || { name: req.building, cost: {} };
  const total = Math.max(1, sim.pop.request.deadline - sim.pop.request.issued);
  const pct = Math.max(0, Math.min(100, (req.daysLeft / total) * 100));
  const col = req.daysLeft <= 10 ? 'var(--bad)' : req.daysLeft <= 25 ? 'var(--warn)' : 'var(--good)';
  const lack = typeof sim.lackCost === 'function' ? sim.lackCost(def.cost) : '';
  const canDelay = !sim.pop.request.delayed && sim.res.gold >= DELAY_COST;

  return `<h4 class="group">Просьба жителей</h4>
    <div class="card"><div class="ttl"><span>${_esc(req.text)}</span><span class="cost" style="color:${col}">${req.daysLeft} дн.</span></div>
      <div class="desc">Исполнить — значит построить: ${_esc(def.name)} (${_cost(sim, def.cost)}). Исполненная просьба поднимает настроение, просроченная роняет.</div>
      <div class="relbar"><div style="width:${pct.toFixed(0)}%;background:${col}"></div></div>
      <div class="btns" style="display:flex;gap:8px;margin-top:8px">
        <button class="btn primary" style="flex:2;padding:8px;font-size:12px" data-build="${req.building}">Заложить ${_esc(def.name)}</button>
        <button class="btn${canDelay ? '' : ' disabled'}" style="flex:1;padding:8px;font-size:12px" data-pop="delay"${canDelay ? '' : ' disabled'}>Отсрочка 🪙${DELAY_COST}</button>
      </div>
      <button class="btn danger" style="width:100%;margin-top:6px;padding:8px;font-size:12px" data-pop="decline">Отказать (−${DECLINE_MOOD} настроения)</button>
      ${lack ? `<div class="reason">На постройку не хватает: ${_esc(lack)}</div>` : ''}
      ${sim.pop.request.delayed ? '<div class="desc">Отсрочка уже дана — второй раз жители не поверят.</div>' : ''}
      ${tail}</div>
    ${_renderThreatHint(ctx)}`;
}

// Подсказка, почему просят именно это: связь просьбы с бедой поселения.
function _renderThreatHint(ctx) {
  const hints = [];
  if (ctx.foodDays < 8) hints.push('еды в обрез — просить будут амбары и фермы');
  if (ctx.housingCap - ctx.pop <= 3) hints.push('жильё кончается — попросят дома');
  if (ctx.happiness < 55) hints.push('народ хмур — попросят храм или зрелища');
  if (ctx.threat) hints.push('рядом война — попросят стены и казарму');
  if (!hints.length) return '';
  return `<div class="card"><div class="ttl"><span>Чем недовольны</span></div>
    <div class="desc">${hints.join('; ')}.</div></div>`;
}

function _renderPyramid(list) {
  const rows = ageHistogram(list);
  const max = Math.max(1, ...rows.map(r => r.n));
  const p = Pop.pyramid(list);
  let bars = '';
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (!r.n && i > 0 && rows.slice(i).every(x => !x.n)) continue;   // пустой хвост сверху не рисуем
    const label = r.to > 900 ? '90+' : `${r.from}–${r.to}`;
    const wid = (r.n / max) * 100;
    bars += `<div style="display:flex;align-items:center;gap:6px;font-size:11px;margin:2px 0">
      <span style="width:46px;color:var(--dim)">${label}</span>
      <div class="relbar" style="flex:1;margin:0"><div style="width:${wid.toFixed(0)}%;background:var(--accent)"></div></div>
      <span style="width:64px;text-align:right">${r.n ? `${r.m}м ${r.f}ж` : '—'}</span>
    </div>`;
  }
  // Дети — будущее поселения: если их меньше четверти, через поколение будет яма.
  const share = list.length ? Math.round((p.children / list.length) * 100) : 0;
  const verdict = share >= 30 ? 'поселение молодое — смена растёт'
    : share >= 18 ? 'смена есть, но небольшая'
      : 'детей мало: через поколение будет провал';
  return `<div class="card">${bars}
    <div class="kv"><span>Дети / взрослые / старики</span><span>${p.children} / ${p.adults} / ${p.elders}</span></div>
    <div class="desc">Доля детей ${share}% — ${verdict}.</div></div>`;
}

function _renderEstates(list) {
  const es = estates(list);
  const total = Math.max(1, list.length);
  let html = '<div class="card">';
  for (const e of es) {
    const pct = Math.round((e.n / total) * 100);
    html += `<div class="kv"><span>${e.ru} <span style="color:var(--dim)">— ${e.desc}</span></span><span>${e.n} · ${pct}%</span></div>`;
  }
  html += '</div>';

  const cr = crafts(list);
  if (!cr.length) {
    return html + `<div class="card"><div class="ttl"><span>Ремёсел ещё нет</span></div>
      <div class="desc">Ремесло приходит с работой: поставьте жителей в здания на вкладке «Труд». За ${Pop.RANK_DAYS[0]} дней в отрасли житель получает первый ранг, каждый ранг — +${Math.round(Pop.RANK_BONUS * 100)}% к выработке.</div></div>`;
  }
  html += '<div class="card">';
  for (const c of cr) {
    const extra = [c.masters ? `мастеров ${c.masters}` : '', c.skilled ? `опытных ${c.skilled}` : ''].filter(Boolean).join(', ');
    html += `<div class="kv"><span>${_cap(c.ru)}</span><span>${c.n}${extra ? ` · ${extra}` : ''}</span></div>`;
  }
  html += `<div class="desc">Каждый ранг даёт +${Math.round(Pop.RANK_BONUS * 100)}% к выработке в своей отрасли. Ремесло забывается, если долго работать в другой.</div></div>`;
  return html;
}

function _renderPeople(sim, w, list) {
  if (!list.length) return '<div class="card"><div class="desc">В поселении никого не осталось.</div></div>';
  const ui = w.ui;
  const sorts = [
    ['age', 'старшие'], ['young', 'младшие'], ['prof', 'ремесло'], ['rank', 'ранг'], ['fam', 'семьи'],
  ];
  let html = '<div class="btns" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">';
  for (const [id, ru] of sorts) {
    html += `<button class="btn${ui.sort === id ? ' primary' : ''}" style="flex:1;min-width:64px;padding:6px;font-size:11px" data-pop="sort:${id}">${ru}</button>`;
  }
  html += '</div>';

  const sorted = sortVillagers(list, ui.sort);
  const shown = ui.all ? sorted : sorted.slice(0, LIST_LIMIT);
  for (const v of shown) html += _renderPerson(v, ui.sel === v.pid);
  if (sorted.length > LIST_LIMIT) {
    html += `<button class="btn" style="width:100%;padding:8px;font-size:12px" data-pop="all">${ui.all ? 'Свернуть список' : `Показать всех (${sorted.length})`}</button>`;
  }
  return html;
}

function _renderPerson(v, open) {
  const years = Pop.ageYears(v);
  const stars = '★'.repeat(Math.min(3, v.rank || 0));
  const trait = Pop.traitTitle(v);
  const head = `<div class="ttl"><span>${v.sex === 'ж' ? '♀' : '♂'} ${_esc(v.name)}</span>
    <span class="cost">${years} ${Pop.plural(years, 'год', 'года', 'лет')}${stars ? ` ${stars}` : ''}</span></div>`;
  const line = `${_cap(Pop.profTitle(v))}${trait ? `, ${trait}` : ''} · ${doingNow(v)}`;

  if (!open) {
    const deed = v.deeds && v.deeds.length ? v.deeds[v.deeds.length - 1] : '';
    return `<div class="card" data-pop="sel:${v.pid}" style="cursor:pointer">${head}
      <div class="desc">${_esc(line)}${deed ? ` · ${_esc(deed)}` : ''}</div></div>`;
  }
  const card = Pop.villagerCard(v);
  let body = '';
  for (const l of card.lines) body += `<div class="kv"><span>${_esc(l)}</span><span></span></div>`;
  return `<div class="card" data-pop="sel:${v.pid}" style="cursor:pointer;border-color:var(--accent)">${head}
    <div class="desc">${_esc(line)}</div>${body}
    <div class="desc">Нажмите ещё раз, чтобы свернуть.</div></div>`;
}

function _renderObits(w) {
  if (!w.obits.length) return '';
  let html = '<h4 class="group">Некрологи</h4><div class="card">';
  for (const o of w.obits.slice(-5).reverse()) {
    html += `<div class="desc">День ${o.day}. ${_esc(o.text)}</div>`;
  }
  return html + '</div>';
}

// ============================ ПРИВЯЗКА ============================

// По образцу bindMarketPanel: ищем свои data-атрибуты в переданном корне.
// opts: { toast(text, type), audio.play(name), refresh() }.
export function bindPopulationPanel(root, sim, opts = {}) {
  if (!root || typeof root.querySelectorAll !== 'function' || !sim) return 0;
  let bound = 0;
  for (const el of Array.from(root.querySelectorAll('[data-pop]'))) {
    const spec = (el.dataset && el.dataset.pop)
      || (typeof el.getAttribute === 'function' ? el.getAttribute('data-pop') : '');
    el.onclick = (ev) => {
      // Карточка жителя кликабельна целиком, но кнопки внутри неё — свои:
      // без остановки всплытия «Отказать» заодно раскрывал бы карточку.
      if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
      const r = wirePopulationAction(sim, spec);
      if (!r.ok) {
        if (opts.toast) opts.toast(r.reason, 'warn');
        if (opts.audio) opts.audio.play('deny');
      } else if (!r.quiet) {
        if (opts.toast && r.text) opts.toast(r.text, 'good');
        if (opts.audio) opts.audio.play('click');
      } else if (opts.audio) opts.audio.play('click');
      if (opts.refresh) opts.refresh();
      return r;
    };
    bound++;
  }
  return bound;
}

// ============================ МЕЛОЧИ ============================

function _wire(sim) {
  if (!sim.popWire) sim.popWire = createWireState();
  if (!sim.popWire.ui) sim.popWire.ui = { sort: 'age', sel: null, all: false };
  return sim.popWire;
}

function _cost(sim, cost) {
  const m = typeof sim.costMult === 'function' ? sim.costMult() : 1;
  const ICON = { food: '🍞', wood: '🪵', stone: '🪨', steel: '⚙️', gold: '🪙', knowledge: '📜' };
  return Object.entries(cost || {}).map(([r, v]) => `${ICON[r] || r}${Math.ceil(v * m)}`).join(' ') || '—';
}

function _card(title, cost, desc) {
  return `<div class="card"><div class="ttl"><span>${_esc(title)}</span><span class="cost">${cost}</span></div>
    <div class="desc">${_esc(desc)}</div></div>`;
}

function _cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

// Имена жителей берутся из data.js и безопасны, но панель собирает HTML строкой —
// экранируем на случай, если имена когда-нибудь начнут приходить извне.
function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Короткие псевдонимы под общий вид слоёв подключения.
export {
  wirePopulationInstall as install,
  wirePopulationNewDay as onNewDay,
  wirePopulationSerialize as serialize,
  wirePopulationRestore as restore,
  renderPopulationPanel as renderPanel,
  bindPopulationPanel as bindPanel,
};

/* ПОДКЛЮЧЕНИЕ

   Девять правок в двух файлах. Три из них — УДАЛЕНИЕ старого пути ядра: без
   этого поселение получит двойной прирост (ядро рожает + модуль рожает) и две
   несогласованные смертности.

   ─────────────────────── app/src/core/simulation.js ───────────────────────

   1) ИМПОРТ. Якорь (строка 7, единственная в файле):

import { installSystems, systemsNewDay, systemsFactions, systemsHappyMod, systemsWorkMult, systemsSerialize, systemsRestore } from './systems/integrate.js';

      ВСТАВИТЬ СРАЗУ ПОСЛЕ неё:

import * as Pop from './systems/population.js';
import { wirePopulationInstall, wirePopulationNewDay, wirePopulationHappyMod, wirePopulationLearnMult, wirePopulationSerialize, wirePopulationRestore } from './systems/wire_population.js';

   2) УСТАНОВКА. Якорь — последняя строка конструктора (строка 115, единственная):

    this.addLog('Поселение основано. Постройте Хижину — цели слева подскажут путь.');

      ВСТАВИТЬ СРАЗУ ПОСЛЕ неё:

    // Демография: сословия, ремёсла, семьи и просьбы жителей (population.js).
    wirePopulationInstall(this);

   3) УДАЛИТЬ РОЖДЕНИЯ ЯДРА. В onNewDay найти блок (строки 934–946) и ЗАМЕНИТЬ его целиком.

      БЫЛО (13 строк, копия дословная):

    // рождения
    const happy = this.happiness();
    if (happy > 45 && this.res.food > pop * 3 && pop < this.housingCap()) {
      let chance = 0.1;
      if (happy > 70) chance *= 1.5;
      if (this.hasBuilding('hospital')) chance *= 1.3;
      if (this.hasBuilding('biolab')) chance *= 1.2;
      if (this.rng.chance(chance)) {
        const c = this.buildings.find(b => b.id === 'campfire' && !b.destroyed) || { x: this.world.startX, y: this.world.startY };
        this.spawnVillager(c.x + this.rng.range(-1, 1), c.y + this.rng.range(-1, 1));
        this.addLog('Родился новый житель!', 'good');
      }
    }

      СТАЛО (2 строки; happy ниже по коду нужен блоку эмиграции, поэтому он остаётся):

    // Рождения и приток извне считает модуль населения (wirePopulationNewDay).
    const happy = this.happiness();

   4) УДАЛИТЬ СТАРЕНИЕ И СМЕРТЬ ЯДРА. В onNewDay найти блок (строки 964–975,
      сразу после `systemsNewDay(this);`) и ЗАМЕНИТЬ его целиком.

      БЫЛО (12 строк, копия дословная):

    // старение и смерть
    for (const v of this.villagers) {
      v.age++;
      let life = 11000; // дней
      if (this.techs.has('medicine')) life *= 1.15;
      if (this.hasBuilding('hospital')) life *= 1.3;
      if (this.hasBuilding('biolab')) life *= 1.25;
      if (v.age > life && this.rng.chance(0.02)) {
        v.hp = 0;
        this.addLog(`${v.name} умер от старости (${Math.floor(v.age / 100)} лет).`);
      }
    }

      СТАЛО (2 строки):

    // Возраст, смертность по годам, семьи, рождения и просьбы жителей.
    wirePopulationNewDay(this);

      ВАЖНО: строка ниже —  this.villagers = this.villagers.filter(v => v.hp > 0);
      — должна остаться на месте. Модуль только помечает hp = 0, вычищает всех
      этот общий фильтр (так же работает зима).
      Медицина не потерялась: hospital/biolab/clinic/sewers теперь входят в
      mortalityMult() и birthMult() адаптера, а тег `medicine` читается из data.js.

   5) СЧАСТЬЕ. Якорь в happiness() (строка 414, единственная):

    h += systemsHappyMod(this);

      ВСТАВИТЬ СРАЗУ ПОСЛЕ неё:

    // Исполненные просьбы жителей радуют, просроченные злят.
    h += wirePopulationHappyMod(this);

   6) ОПЫТ И РАНГИ. В tickVillagers, ветка `if (v.atWork)`, ЗАМЕНИТЬ одну строку
      (строка 578, единственная такая в файле).

      БЫЛО:

        this.produceAt(b, dt, happyMult);

      СТАЛО (3 строки; workMult уходит множителем к happyMult намеренно —
      produceAt множит на него выработку, но не сырьё в def.consume, поэтому
      опытный сталевар не начнёт жрать больше камня):

        const ind = Pop.industryOfBuilding(b.id);
        Pop.registerWork(this.pop, v, ind, dt * wirePopulationLearnMult(this));
        this.produceAt(b, dt, happyMult * Pop.workMult(v, ind));

      Если эту правку не делать, игра не сломается: адаптер сам засчитывает опыт
      за промысел вне зданий (охота, собирательство, стройка), и ремёсла с рангами
      всё равно появятся. Но работа внутри зданий тогда не учитывается вовсе, и
      ранг перестаёт влиять на выработку — то есть половина смысла ремесла пропадёт.

   7) СЕЙВ. Якорь в serialize() (строка 1729, единственная):

      sys: systemsSerialize(this),

      ВСТАВИТЬ СРАЗУ ПОСЛЕ неё:

      population: wirePopulationSerialize(this),

   8) ЗАГРУЗКА. Якорь в static deserialize() (строка 1766, единственная):

    systemsRestore(sim, data.sys);

      ВСТАВИТЬ СРАЗУ ПОСЛЕ неё:

    wirePopulationRestore(sim, data.population);

      (Старые сейвы без поля population переживут загрузку: restore заведёт
      демографию заново на восстановленных жителях.)

   ────────────────────────── app/src/ui/hud.js ──────────────────────────

   9) ЭКРАН «ЛЮДИ». Четыре вставки.

      9.1 Якорь (строка 6, единственная):

import { renderMarketPanel, bindMarketPanel, createMarketPanelState } from './panel_market.js';

          ВСТАВИТЬ СРАЗУ ПОСЛЕ неё:

import { renderPopulationPanel, bindPopulationPanel } from '../core/systems/wire_population.js';

      9.2 Якорь в массиве TABS (строка 22, единственная):

  { id: 'labor', ru: 'Труд', ic: '👷' },

          ВСТАВИТЬ СРАЗУ ПОСЛЕ неё:

  { id: 'people', ru: 'Люди', ic: '👪' },

      9.3 Якорь — метод панели рынка (строка 869, единственная):

  panel_market() { return renderMarketPanel(this.sim, this.marketState); }

          ВСТАВИТЬ СРАЗУ ПОСЛЕ неё:

  panel_people() { return renderPopulationPanel(this.sim); }

      9.4 Якорь в КОНЦЕ метода bindPanel(root) — вызов панели рынка целиком
          (строки 546–550, единственный в файле):

    bindMarketPanel(root, this.sim, {
      toast: (t, k) => this.toast(t, k),
      audio: this.audio,
      refresh: () => this.renderPanel(),
    });

          ВСТАВИТЬ СРАЗУ ПОСЛЕ него:

    bindPopulationPanel(root, this.sim, {
      toast: (t, k) => this.toast(t, k),
      audio: this.audio,
      refresh: () => this.renderPanel(),
    });

      Кнопка «Заложить …» в карточке просьбы намеренно помечена data-build:
      её уже обслуживает существующий обработчик в начале bindPanel, и клик
      сразу открывает режим постановки здания. Отдельного кода не нужно.

   ─────────────────────────── ПРОВЕРКА ПОСЛЕ ВСТАВКИ ───────────────────────────

   • npm test — 395 проверок зелёные (test-population.mjs гоняет сам модуль,
     simtest.mjs — ядро: население больше не растёт из двух источников).
   • npm run build — сборка проходит.
   • В игре: вкладка «Люди», прогнать пару лет на ускорении. Ожидается: рождения
     у пар, некрологи с именами и заслугами, ранги ★ у жителей, просьба жителей
     с обратным отсчётом и тремя решениями.

*/
