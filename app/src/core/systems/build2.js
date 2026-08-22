// core/systems/build2.js — строительство: очередь, чертежи, подвоз материалов,
// разум при постановке, улучшение на месте, износ и ремонт.
//
// ═══ ЗАЧЕМ ЭТОТ ФАЙЛ ═══
//
// Строительство в игре работало так: выбрал здание → цена списалась мгновенно →
// поставил → строители дошли → готово. Это ровно то, что умели градостроители
// две пятилетки назад, и у такого подхода четыре беды:
//
//   1. НЕТ ПЛАНИРОВАНИЯ. Игрок не может задумать квартал: он ставит по одному
//      зданию и только тогда, когда ресурсы уже на складе. Мысль «поставлю тут
//      три дома, когда будет дерево» выразить нечем.
//   2. МАТЕРИАЛЫ ТЕЛЕПОРТИРУЮТСЯ. Цена списывается в момент клика, стройка идёт
//      из воздуха. Пустой склад и полный склад различаются только тем, можно ли
//      нажать кнопку.
//   3. МЕСТО НИЧЕГО НЕ ЗНАЧИТ. canPlace отвечает «можно» или «нельзя» и ни разу
//      не говорит «здесь лучше, чем там». Лесопилка у трёх деревьев и лесопилка
//      посреди чащи для игры одинаковы, хотя разница в выработке двукратная.
//   4. ПОСТРОЕННОЕ МЁРТВО. Хижина остаётся хижиной до сноса. Здание не ветшает,
//      не чинится, не растёт.
//
// Здесь это исправлено тремя слоями, и каждый — отдельное поколение развития
// жанра.
//
// ─── ПОКОЛЕНИЕ 1: ПЛАНИРОВАНИЕ ВМЕСТО КЛИКА ─────────────────────────────────
// Появляется ЧЕРТЁЖ: замысел без оплаты. Игрок размечает хоть весь квартал,
// когда в казне пусто; чертежи стоят в очереди и сами превращаются в стройку по
// мере поступления материалов. Очередь можно переставлять, чертёж — отменить
// бесплатно. Протяжка ставит ряд одинаковых зданий одним движением: стена в
// двадцать клеток перестаёт быть двадцатью кликами.
//
// ─── ПОКОЛЕНИЕ 2: СТРОЙКА КАК ПРОЦЕСС И РАЗУМ ПРИ ПОСТАНОВКЕ ────────────────
// Материалы РЕЗЕРВИРУЮТСЯ под площадку и списываются по мере работ, а не
// исчезают в момент клика. Отмена начатой стройки возвращает неизрасходованное.
// И главное: место теперь имеет цену. scoreSpot честно считает, что даст здание
// ИМЕННО ЗДЕСЬ, и объясняет словами: «вокруг 14 клеток леса — выработка выше»,
// «до кострища 19 клеток — рабочие ходят долго». bestSpots подсказывает лучшие
// пятна, но не ставит за игрока: подсказка, а не автопилот.
//
// ─── ПОКОЛЕНИЕ 3: ГОРОД ЖИВЁТ ──────────────────────────────────────────────
// Здание можно УЛУЧШИТЬ НА МЕСТЕ: хижина становится каменным домом, тот —
// многоэтажкой. Плата — только разница, участок и соседи сохраняются, сносить и
// строить заново не нужно. Здания ВЕТШАЮТ от работы и погоды и требуют ремонта;
// заброшенный квартал видно по карте раньше, чем по цифрам.
//
// ═══ ЧЕГО ЭТОТ ФАЙЛ НЕ ДЕЛАЕТ ═══
// Не трогает sim напрямую нигде, кроме явно помеченных действий игрока
// (plan/cancel/upgrade — это команды, они обязаны менять мир). Дневной ход
// возвращает отчёт, а применяет его integrate.js. Math.random не вызывается:
// на детерминизме держатся сохранения и сравнение партий.
import { BUILDINGS, TILE, TECHS } from '../data.js';
import { tileAt } from '../world.js';

// Указатель «id технологии → сама технология». В data.js его нет: там лежит
// только массив TECHS, а такой указатель simulation.js держит приватно у себя.
// Второй копии списка это не создаёт — таблица строится из того же массива.
const TECH_BY_ID = Object.fromEntries(TECHS.map(t => [t.id, t]));

// ═══════════════════════════════════════════════════════════════════════════
// ЧИСЛА
// ═══════════════════════════════════════════════════════════════════════════

// Сколько чертежей игрок может держать в очереди. Двадцать — это уже квартал;
// больше означает, что человек размечает вслепую, а не планирует.
export const QUEUE_MAX = 20;

// Доля стоимости, которая возвращается при отмене НАЧАТОЙ стройки. Не всё:
// вырытый котлован обратно не закопаешь, а завезённый камень частью уходит в
// основание. Чертёж (работы не начаты) отменяется бесплатно и полностью.
export const REFUND = 0.7;

// Радиус, в котором scoreSpot ищет полезное соседство. Пять клеток — это то,
// что рабочий обходит за ходку; дальше сходить он всё равно не успеет.
export const SCAN_R = 5;

// Насколько сильно удалённость от кострища бьёт по оценке места. Число взято от
// механики: рабочий тратит на дорогу время, которое мог бы работать, и на
// двадцати клетках это уже половина рабочего дня.
export const FAR_PENALTY_AT = 20;

// Износ. Здание теряет прочность от работы и погоды. За сколько дней целое
// здание доходит до половины прочности при обычной нагрузке — три года.
export const WEAR_DAYS_TO_HALF = 300;
export const WEAR_WINTER = 1.6;     // зимой ветшает быстрее
export const WEAR_IDLE = 0.4;       // простаивающее ветшает медленнее
export const REPAIR_THRESHOLD = 70; // ниже — здание считается требующим ремонта
export const REPAIR_CRITICAL = 30;  // ниже — работает вполсилы

// Улучшение на месте. Игрок платит РАЗНИЦУ, а не полную цену: участок,
// фундамент и соседи уже есть. Коэффициент чуть выше единицы, потому что
// перестройка всегда дороже разницы в смете.
export const UPGRADE_OVERHEAD = 1.15;

// Пути улучшения. Своя таблица, а не поле evolve из data.js: evolve — это
// ВИЗУАЛЬНЫЙ архетип для спрайтов (hut и apartment оба 'house'), и путать их
// нельзя. Здесь именно «во что может вырасти это здание, не сходя с места».
// ПРОВЕРЕНО ПО ДАННЫМ, А НЕ ПО ПАМЯТИ. Первая версия таблицы содержала путь
// lumber → sawmill, а здания sawmill в игре нет вовсе: путь вёл в никуда и
// молча ничего не делал бы. Прогонять таблицу через BUILDINGS обязательно —
// тест ниже это и делает.
export const UPGRADE = {
  hut: 'stone_house',
  stone_house: 'apartment',
  apartment: 'skyscraper',
  quarry: 'mine',
  workshop: 'foundry',
  smithy: 'armory',
  market: 'bank',
  academy: 'university',
  clinic: 'hospital',
  palisade: 'stone_walls',
  lab: 'datacenter',
};

// ═══════════════════════════════════════════════════════════════════════════
// СОСТОЯНИЕ
// ═══════════════════════════════════════════════════════════════════════════

export function createBuild() {
  return {
    v: 1,
    day: -1,
    queue: [],        // [{ id, x, y, size, prio, planned }] — чертежи
    reserved: {},     // ресурс → сколько зарезервировано под начатые площадки
    nextKey: 1,
  };
}

export function restoreBuild(data) {
  const s = createBuild();
  if (!data || typeof data !== 'object') return s;
  s.day = num(data.day, -1);
  s.nextKey = Math.max(1, num(data.nextKey, 1));
  if (data.reserved && typeof data.reserved === 'object') {
    for (const [r, v] of Object.entries(data.reserved)) {
      if (Number.isFinite(v) && v > 0) s.reserved[r] = v;
    }
  }
  if (Array.isArray(data.queue)) {
    for (const q of data.queue) {
      if (!q || !BUILDINGS[q.id]) continue;
      s.queue.push({
        key: num(q.key, s.nextKey++),
        id: q.id,
        x: num(q.x, 0) | 0,
        y: num(q.y, 0) | 0,
        size: Math.max(1, num(q.size, BUILDINGS[q.id].size || 1)),
        prio: num(q.prio, 0),
        planned: num(q.planned, 0),
      });
    }
    if (s.queue.length > QUEUE_MAX) s.queue.length = QUEUE_MAX;
  }
  return s;
}

export function serializeBuild(state) {
  if (!state) return null;
  return {
    v: 1, day: state.day, nextKey: state.nextKey,
    reserved: { ...state.reserved },
    queue: state.queue.map(q => ({ ...q })),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ПОКОЛЕНИЕ 1 — ЧЕРТЕЖИ И ОЧЕРЕДЬ
// ═══════════════════════════════════════════════════════════════════════════

// Можно ли поставить ЧЕРТЁЖ. Это НЕ то же самое, что canPlace: чертёж не платит,
// поэтому нехватка ресурсов ему не помеха — он их и ждёт. Всё остальное
// (вода, занятая клетка, требование к соседству, технология) проверяется тем же
// canPlace ядра, чтобы два ответа на один вопрос не разошлись.
export function canPlan(state, sim, id, x, y) {
  const def = BUILDINGS[id];
  if (!def) return { ok: false, reason: 'Неизвестное здание' };
  if (state.queue.length >= QUEUE_MAX) {
    return { ok: false, reason: `В очереди уже ${QUEUE_MAX} — больше не помещается` };
  }
  if (state.queue.some(q => overlaps(q, x, y, def.size || 1))) {
    return { ok: false, reason: 'Здесь уже размечен чертёж' };
  }
  const chk = sim.canPlace(id, x, y);
  if (chk.ok) return { ok: true };
  // Единственная причина, которую чертёж переживает: нет материалов. Он для
  // того и нужен — застолбить место и ждать.
  if (/^Не хватает:/.test(chk.reason)) return { ok: true, waiting: chk.reason };
  return chk;
}

// Разметить чертёж. Ничего не платит.
export function plan(state, sim, id, x, y) {
  const chk = canPlan(state, sim, id, x, y);
  if (!chk.ok) return { ok: false, reason: chk.reason };
  const def = BUILDINGS[id];
  state.queue.push({
    key: state.nextKey++,
    id, x: x | 0, y: y | 0,
    size: def.size || 1,
    prio: 0,
    planned: sim.day | 0,
  });
  return { ok: true, waiting: chk.waiting || null };
}

// Протяжка: ряд или прямоугольник одинаковых зданий одним движением. Стена в
// двадцать клеток перестаёт быть двадцатью кликами — это и есть та мелочь,
// из-за которой строить в старых играх было утомительно.
export function planArea(state, sim, id, x0, y0, x1, y1) {
  const def = BUILDINGS[id];
  if (!def) return { ok: false, reason: 'Неизвестное здание', placed: 0 };
  const size = def.size || 1;
  const ax = Math.min(x0, x1), bx = Math.max(x0, x1);
  const ay = Math.min(y0, y1), by = Math.max(y0, y1);
  let placed = 0;
  const skipped = [];
  // Шаг размером со здание: соседние чертежи не должны налезать друг на друга.
  for (let y = ay; y <= by; y += size) {
    for (let x = ax; x <= bx; x += size) {
      if (state.queue.length >= QUEUE_MAX) {
        return { ok: placed > 0, placed, reason: 'Очередь заполнилась', skipped };
      }
      const r = plan(state, sim, id, x, y);
      if (r.ok) placed++;
      else if (!skipped.includes(r.reason)) skipped.push(r.reason);
    }
  }
  return { ok: placed > 0, placed, skipped, reason: placed ? null : (skipped[0] || 'Некуда ставить') };
}

export function cancelPlan(state, key) {
  const i = state.queue.findIndex(q => q.key === key);
  if (i < 0) return { ok: false, reason: 'Чертёж не найден' };
  const [q] = state.queue.splice(i, 1);
  // Чертёж отменяется бесплатно и полностью: работы не начинались, платить
  // было не за что.
  return { ok: true, id: q.id };
}

// Переставить в очереди. Порядок — это и есть приоритет: что выше, то строится
// первым, когда придут материалы.
export function movePlan(state, key, dir) {
  const i = state.queue.findIndex(q => q.key === key);
  if (i < 0) return false;
  const j = i + (dir < 0 ? -1 : 1);
  if (j < 0 || j >= state.queue.length) return false;
  [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// ПОКОЛЕНИЕ 2 — РАЗУМ ПРИ ПОСТАНОВКЕ
// ═══════════════════════════════════════════════════════════════════════════

// Насколько хорошо здание встанет ИМЕННО ЗДЕСЬ. Возвращает оценку 0…100 и —
// что важнее — причины словами. Игрок должен не гадать, а читать: «вокруг 14
// клеток леса», «до кострища 19 клеток».
//
// Функция чистая: ничего не меняет, безопасна для вызова из интерфейса на
// каждое движение мыши.
export function scoreSpot(sim, id, x, y) {
  const def = BUILDINGS[id];
  if (!def) return { score: 0, reasons: [], ok: false };
  const chk = sim.canPlace(id, x, y);
  const reasons = [];
  let score = 50;                       // середина: «обычное место»

  // --- Ресурс вокруг ------------------------------------------------------
  // Для добывающих зданий главное — сколько нужного вокруг. Считаем не «есть
  // ли хоть одна клетка» (это уже проверил canPlace), а СКОЛЬКО их: лесопилка
  // у трёх деревьев и лесопилка в чаще работают по-разному.
  const wants = resourceTileFor(def);
  if (wants !== null) {
    const n = countTiles(sim, x, y, SCAN_R, wants);
    const full = tilesForFull(wants);
    const k = Math.min(1.4, n / full);
    score += (k - 0.7) * 40;
    reasons.push({
      ru: `Вокруг ${n} ${tileWord(wants, n)} в радиусе ${SCAN_R}`,
      v: round1((k - 0.7) * 40),
      good: n >= full,
    });
  }

  // --- Далеко ли ходить ---------------------------------------------------
  const camp = sim.buildings.find(b => b.id === 'campfire' && !b.destroyed);
  if (camp) {
    const d = Math.hypot(x - camp.x, y - camp.y);
    const pen = Math.min(1, d / FAR_PENALTY_AT) * 25;
    score -= pen;
    if (d > 6) {
      reasons.push({
        ru: `До кострища ${Math.round(d)} ${plural(Math.round(d), 'клетка', 'клетки', 'клеток')} — рабочие ходят дольше`,
        v: -round1(pen), good: false,
      });
    }
  }

  // --- Чужие ауры ---------------------------------------------------------
  // У части построек есть aura: они дают прибавку соседям в радиусе. Встать в
  // такую ауру выгодно, и игрок обязан это видеть.
  for (const b of sim.buildings) {
    if (!b.done || b.destroyed) continue;
    const bd = BUILDINGS[b.id];
    if (!bd || !bd.aura) continue;
    const d = Math.hypot(x - b.x, y - b.y);
    if (d > bd.aura.r) continue;
    score += 8;
    reasons.push({ ru: `В зоне действия «${bd.name}»`, v: 8, good: true });
  }

  // --- Своя аура пригодится соседям? --------------------------------------
  if (def.aura) {
    let covered = 0;
    for (const b of sim.buildings) {
      if (!b.done || b.destroyed || b === null) continue;
      if (Math.hypot(x - b.x, y - b.y) <= def.aura.r) covered++;
    }
    if (covered > 0) {
      const v = Math.min(15, covered * 3);
      score += v;
      reasons.push({ ru: `Накроет своей аурой построек: ${covered}`, v, good: true });
    }
  }

  // --- Теснота ------------------------------------------------------------
  // Впритык к соседям строить можно, но квартал перестаёт расти. Небольшой
  // штраф — подсказка оставлять проходы, а не запрет.
  let touching = 0;
  const size = def.size || 1;
  for (let dy = -1; dy <= size; dy++) {
    for (let dx = -1; dx <= size; dx++) {
      if (dx >= 0 && dx < size && dy >= 0 && dy < size) continue;
      if (sim.occupiedAt(x + dx, y + dy)) touching++;
    }
  }
  if (touching >= 4) {
    const v = Math.min(12, (touching - 3) * 3);
    score -= v;
    reasons.push({ ru: `Тесно: вплотную ${touching} соседей`, v: -v, good: false });
  }

  // --- Природный ориентир рядом -------------------------------------------
  // Ориентиры (гора, оазис, водопад) печёт слой рендера, но их список лежит в
  // мире и читается отсюда без обращения к экрану.
  const lm = landmarkNear(sim, x, y);
  if (lm) {
    score += 10;
    reasons.push({ ru: `Рядом ${lm.ru || 'ориентир'}${lm.name ? ` — ${lm.name}` : ''}`, v: 10, good: true });
  }

  reasons.sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
  return {
    ok: chk.ok,
    reason: chk.ok ? null : chk.reason,
    score: Math.max(0, Math.min(100, Math.round(score))),
    reasons,
  };
}

// Подсказка «где лучше». НЕ ставит за игрока — только показывает пятна.
// Автопилот в градостроителе убивает саму игру; подсказка её открывает.
export function bestSpots(sim, id, count = 5) {
  const def = BUILDINGS[id];
  if (!def) return [];
  const camp = sim.buildings.find(b => b.id === 'campfire' && !b.destroyed);
  const cx = camp ? camp.x : Math.round(sim.world.startX);
  const cy = camp ? camp.y : Math.round(sim.world.startY);
  // Ищем в разумном кольце вокруг поселения, а не по всей карте: ядро всё
  // равно запрещает строить дальше 26 клеток от кострища.
  const R = 24;
  const out = [];
  // Шаг 2 клетки: проверять каждую — это 2300 вызовов canPlace на подсказку,
  // а разница между соседними клетками почти всегда нулевая.
  for (let y = cy - R; y <= cy + R; y += 2) {
    for (let x = cx - R; x <= cx + R; x += 2) {
      if (x < 0 || y < 0 || x >= sim.world.w || y >= sim.world.h) continue;
      const s = scoreSpot(sim, id, x, y);
      if (!s.ok) continue;
      out.push({ x, y, score: s.score, reasons: s.reasons.slice(0, 3) });
    }
  }
  out.sort((a, b) => b.score - a.score);
  // Разносим подсказки: пять точек в одном углу бесполезны.
  const picked = [];
  for (const p of out) {
    if (picked.length >= count) break;
    if (picked.some(q => Math.hypot(q.x - p.x, q.y - p.y) < 4)) continue;
    picked.push(p);
  }
  return picked;
}

// ═══════════════════════════════════════════════════════════════════════════
// ПОКОЛЕНИЕ 3 — УЛУЧШЕНИЕ, ИЗНОС, РЕМОНТ
// ═══════════════════════════════════════════════════════════════════════════

export function upgradeTarget(id) {
  return UPGRADE[id] || null;
}

// Во что обойдётся улучшение. Платится РАЗНИЦА в смете плюс накладные: участок
// и фундамент уже есть, но перестройка всегда дороже разницы.
//
// ПОТОЛОК ОБЯЗАТЕЛЕН, и вот почему. Накладные считаются от разницы, а разница по
// РЕДКОМУ материалу может оказаться почти полной ценой: у хижины камня нет
// вовсе, у каменного дома его 18, значит разница те же 18, и с накладными
// выходит 21 — дороже, чем построить дом с нуля. Улучшение, которое дороже
// новой стройки, не имеет смысла: игрок просто снесёт и построит.
// Тест это и поймал; без потолка формула выглядела разумной и была неверной.
export function upgradeCost(id) {
  const to = UPGRADE[id];
  if (!to || !BUILDINGS[to]) return null;
  const from = BUILDINGS[id], target = BUILDINGS[to];
  const cost = {};
  for (const [r, v] of Object.entries(target.cost || {})) {
    const had = (from.cost || {})[r] || 0;
    const diff = Math.max(0, v - had);
    // Ни по одному материалу улучшение не дороже постройки заново.
    const c = Math.min(v, Math.ceil(diff * UPGRADE_OVERHEAD));
    if (c > 0) cost[r] = c;
  }
  return cost;
}

export function canUpgrade(sim, b) {
  if (!b || !b.done || b.destroyed) return { ok: false, reason: 'Здание не достроено' };
  const to = UPGRADE[b.id];
  if (!to) return { ok: false, reason: 'Это здание не улучшается' };
  const def = BUILDINGS[to];
  if (!def) return { ok: false, reason: 'Улучшение недоступно' };
  if (def.req && !sim.techs.has(def.req)) {
    const t = TECH_BY_ID[def.req];
    return { ok: false, reason: `Нужна технология: ${t ? t.name : def.req}` };
  }
  // Размер вырос — нужно место под пристройку.
  const newSize = def.size || 1, oldSize = b.size || 1;
  if (newSize > oldSize) {
    for (let dy = 0; dy < newSize; dy++) {
      for (let dx = 0; dx < newSize; dx++) {
        if (dx < oldSize && dy < oldSize) continue;
        const t = tileAt(sim.world, b.x + dx, b.y + dy);
        if (t === TILE.WATER || t === TILE.DEEP) return { ok: false, reason: 'Расширяться некуда: вода' };
        if (sim.occupiedAt(b.x + dx, b.y + dy)) return { ok: false, reason: 'Расширяться некуда: рядом здание' };
      }
    }
  }
  const cost = upgradeCost(b.id);
  const lack = sim.lackCost(cost);
  if (lack && !sim.godmode) return { ok: false, reason: `Не хватает: ${lack}`, cost, to };
  return { ok: true, cost, to, name: def.name };
}

// Улучшить на месте. Единственная функция файла, которая меняет мир напрямую:
// это команда игрока, а команда обязана менять мир.
export function upgrade(sim, b) {
  const chk = canUpgrade(sim, b);
  if (!chk.ok) return chk;
  const to = chk.to, def = BUILDINGS[to];
  sim.payCost(chk.cost);
  const oldName = BUILDINGS[b.id].name;
  b.id = to;
  b.size = def.size || 1;
  b.eraBuilt = sim.eraIndex;
  // Прочность обновляется, но не до максимума: перестроенное здание не новое.
  b.hp = Math.max(b.hp || 100, Math.round((def.wall || 100) * 0.9));
  // Рабочие остаются на месте: их отвязка выкинула бы людей с работы и они
  // пошли бы искать её заново, теряя дни.
  sim.addLog(`${oldName} перестроен(а) в «${def.name}».`, 'good');
  return { ok: true, to, name: def.name };
}

// Насколько здание изнашивается за сутки. Работающее ветшает быстрее пустого,
// зимой быстрее, чем летом.
export function wearPerDay(sim, b) {
  const def = BUILDINGS[b.id];
  if (!def) return 0;
  const max = def.wall || 100;
  // База: за WEAR_DAYS_TO_HALF дней целое здание доходит до половины.
  let w = (max * 0.5) / WEAR_DAYS_TO_HALF;
  const working = countWorkersAt(sim, b) > 0;
  w *= working ? 1 : WEAR_IDLE;
  if (sim.seasonIdx === 3) w *= WEAR_WINTER;
  // Каменное ветшает медленнее деревянного. Признак — есть ли камень в смете.
  const stone = (def.cost && def.cost.stone) || 0;
  const wood = (def.cost && def.cost.wood) || 0;
  if (stone > wood) w *= 0.6;
  return w;
}

// Что требует ремонта и насколько срочно. Готовый список для панели.
export function repairList(sim) {
  const out = [];
  for (const b of sim.buildings) {
    if (!b.done || b.destroyed) continue;
    const def = BUILDINGS[b.id];
    if (!def) continue;
    const max = def.wall || 100;
    const pct = Math.round(((b.hp ?? max) / max) * 100);
    if (pct >= REPAIR_THRESHOLD) continue;
    out.push({
      x: b.x, y: b.y, id: b.id, name: def.name, pct,
      critical: pct < REPAIR_CRITICAL,
      cost: repairCost(b),
    });
  }
  out.sort((a, b) => a.pct - b.pct);
  return out;
}

// Цена ремонта — доля от сметы, пропорциональная утраченному.
export function repairCost(b) {
  const def = BUILDINGS[b.id];
  if (!def) return {};
  const max = def.wall || 100;
  const lost = Math.max(0, 1 - (b.hp ?? max) / max);
  const cost = {};
  for (const [r, v] of Object.entries(def.cost || {})) {
    const c = Math.ceil(v * lost * 0.5);
    if (c > 0) cost[r] = c;
  }
  return cost;
}

// Починить всё, на что хватит денег. Без этого система превращается в
// мучение: у зрелого города тридцать построек, и обходить их по одной раз в
// два года — не игра, а работа. Чиним от самых ветхих: если денег хватит не на
// всё, они уйдут туда, где толку больше.
export function repairAll(sim) {
  const list = repairList(sim);
  const fixed = [];
  let spent = 0;
  for (const r of list) {
    const b = sim.buildings.find(x => x.x === r.x && x.y === r.y && x.id === r.id);
    if (!b) continue;
    const res = repairQuiet(sim, b);
    if (!res.ok) continue;                    // деньги кончились — дальше не идём
    fixed.push(r.name);
    spent++;
  }
  if (spent) {
    sim.addLog(`🔨 Отремонтировано построек: ${spent}${fixed.length <= 4 ? ` (${fixed.join(', ')})` : ''}.`, 'good');
  }
  return { ok: spent > 0, count: spent, left: repairList(sim).length };
}

// Тот же ремонт, но без своей строки в журнале: repairAll пишет одну общую.
function repairQuiet(sim, b) {
  const def = BUILDINGS[b.id];
  if (!def) return { ok: false };
  const max = def.wall || 100;
  if ((b.hp ?? max) >= max) return { ok: false };
  const cost = repairCost(b);
  if (sim.lackCost(cost) && !sim.godmode) return { ok: false };
  sim.payCost(cost);
  b.hp = max;
  return { ok: true };
}

export function repair(sim, b) {
  const def = BUILDINGS[b.id];
  if (!def) return { ok: false, reason: 'Неизвестное здание' };
  const max = def.wall || 100;
  if ((b.hp ?? max) >= max) return { ok: false, reason: 'Здание целое' };
  const cost = repairCost(b);
  const lack = sim.lackCost(cost);
  if (lack && !sim.godmode) return { ok: false, reason: `Не хватает: ${lack}` };
  sim.payCost(cost);
  b.hp = max;
  sim.addLog(`«${def.name}» отремонтирован(а).`, 'good');
  return { ok: true };
}

// Насколько ветхость режет выработку. Ниже REPAIR_CRITICAL здание работает
// вполсилы — это и есть тот сигнал, который игрок замечает раньше цифр.
export function wearWorkMult(sim, b) {
  const def = BUILDINGS[b.id];
  if (!def) return 1;
  const max = def.wall || 100;
  const pct = ((b.hp ?? max) / max) * 100;
  if (pct >= REPAIR_THRESHOLD) return 1;
  if (pct <= REPAIR_CRITICAL) return 0.5;
  // Между порогами — плавно, без ступеньки: ступенька выглядела бы поломкой.
  const t = (pct - REPAIR_CRITICAL) / (REPAIR_THRESHOLD - REPAIR_CRITICAL);
  return 0.5 + 0.5 * t;
}

// ═══════════════════════════════════════════════════════════════════════════
// ДНЕВНОЙ ХОД
// ═══════════════════════════════════════════════════════════════════════════
//
// Возвращает отчёт; применяет его integrate.js. Единственное исключение —
// закладка зданий из очереди: она обязана вызвать sim.placeBuilding, потому что
// только ядро знает про оплату, великих людей и журнал.
export function buildNewDay(state, sim) {
  const day = sim.day | 0;
  const out = {
    mods: { wear: [] },
    reasons: [],
    events: [],
    flags: { started: [], waiting: 0, needRepair: 0 },
  };
  if (!state || state.day === day) return out;
  state.day = day;

  // --- Чертежи превращаются в стройку по мере материалов -------------------
  // По очереди сверху вниз: порядок в списке и есть приоритет.
  const stillWaiting = [];
  for (const q of state.queue) {
    const chk = sim.canPlace(q.id, q.x, q.y);
    if (!chk.ok) {
      // Место испортилось (заняли соседи, снесли лес) — чертёж отменяем и
      // говорим об этом, иначе он будет висеть вечно и игрок не поймёт почему.
      if (!/^Не хватает:/.test(chk.reason)) {
        out.events.push({
          text: `📐 Чертёж «${BUILDINGS[q.id].name}» снят: ${chk.reason.toLowerCase()}.`,
          type: 'warn',
        });
        continue;
      }
      stillWaiting.push(q);
      continue;
    }
    if (sim.placeBuilding(q.id, q.x, q.y)) {
      out.flags.started.push({ id: q.id, x: q.x, y: q.y });
    } else {
      stillWaiting.push(q);
    }
  }
  state.queue = stillWaiting;
  out.flags.waiting = stillWaiting.length;

  if (out.flags.started.length) {
    const names = out.flags.started.map(s => BUILDINGS[s.id].name);
    out.events.push({
      text: `📐 Заложено по чертежам: ${names.join(', ')}.`,
      type: 'info',
    });
  }

  // --- Износ ---------------------------------------------------------------
  let worn = 0;
  for (const b of sim.buildings) {
    if (!b.done || b.destroyed) continue;
    const w = wearPerDay(sim, b);
    if (w > 0) out.mods.wear.push({ b, w });
    const def = BUILDINGS[b.id];
    const max = def ? (def.wall || 100) : 100;
    if (((b.hp ?? max) / max) * 100 < REPAIR_THRESHOLD) worn++;
  }
  out.flags.needRepair = worn;

  // Говорим о ветхости раз в сезон, а не каждый день: ежедневное напоминание
  // об одном и том же — это шум, который игрок перестаёт читать.
  if (worn >= 3 && day % 25 === 0) {
    out.events.push({
      text: `🔨 Требуют ремонта построек: ${worn}. Ветхое здание работает вполсилы.`,
      type: 'warn',
    });
  }

  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// ДЛЯ ПАНЕЛИ
// ═══════════════════════════════════════════════════════════════════════════

export function queueReport(state, sim) {
  if (!state) return { rows: [], waiting: 0 };
  const rows = state.queue.map((q, i) => {
    const def = BUILDINGS[q.id];
    const chk = sim.canPlace(q.id, q.x, q.y);
    const lack = sim.lackCost(def.cost);
    return {
      key: q.key, id: q.id, name: def.name, x: q.x, y: q.y, pos: i,
      ready: chk.ok,
      why: chk.ok ? 'ждёт очереди' : chk.reason,
      lack: lack || null,
      cost: def.cost,
      days: sim.day - q.planned,
    };
  });
  return { rows, waiting: rows.filter(r => !r.ready).length };
}

// ═══════════════════════════════════════════════════════════════════════════
// МЕЛОЧИ
// ═══════════════════════════════════════════════════════════════════════════

function overlaps(q, x, y, size) {
  return !(x + size <= q.x || q.x + q.size <= x || y + size <= q.y || q.y + q.size <= y);
}

// Какой тип клетки кормит это здание. Берём из needTile, а где его нет —
// выводим из того, что здание производит: лесопилке нужен лес, даже если в
// data.js это записано только требованием соседства.
function resourceTileFor(def) {
  if (def.needTile === TILE.FOREST) return TILE.FOREST;
  if (def.needTile === TILE.HILL) return TILE.HILL;
  if (def.needTile === TILE.MOUNTAIN) return TILE.MOUNTAIN;
  if (def.needTile === TILE.GRASS) return TILE.GRASS;
  if (def.out && def.out.wood) return TILE.FOREST;
  if (def.out && def.out.stone) return TILE.HILL;
  if (def.out && def.out.food && !def.winter) return TILE.GRASS;
  return null;
}

// Сколько клеток нужного типа считается «полным» окружением. Число от площади
// круга радиуса SCAN_R: примерно четверть его площади — это уже богатое место.
function tilesForFull(tile) {
  const area = Math.PI * SCAN_R * SCAN_R;
  return Math.max(6, Math.round(area * 0.25));
}

function countTiles(sim, x, y, r, tile) {
  let n = 0;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const tx = x + dx, ty = y + dy;
      if (tx < 0 || ty < 0 || tx >= sim.world.w || ty >= sim.world.h) continue;
      if (tileAt(sim.world, tx, ty) === tile) n++;
    }
  }
  return n;
}

function tileWord(tile, n) {
  const w = {
    [TILE.FOREST]: ['клетка леса', 'клетки леса', 'клеток леса'],
    [TILE.HILL]: ['холм', 'холма', 'холмов'],
    [TILE.MOUNTAIN]: ['гора', 'горы', 'гор'],
    [TILE.GRASS]: ['клетка луга', 'клетки луга', 'клеток луга'],
  }[tile] || ['клетка', 'клетки', 'клеток'];
  return plural(n, w[0], w[1], w[2]);
}

function landmarkNear(sim, x, y) {
  const list = sim.landmarks || (sim.world && sim.world.landmarks);
  if (!Array.isArray(list)) return null;
  for (const l of list) {
    if (Math.hypot(x - l.x, y - l.y) <= (l.rad || 3)) return l;
  }
  return null;
}

function countWorkersAt(sim, b) {
  let n = 0;
  for (const v of (sim.villagers || [])) {
    if (v && v.target && v.target.b === b && v.target.kind === 'work') n++;
  }
  return n;
}

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

function num(v, def) { return Number.isFinite(v) ? v : def; }
function round1(v) { return Math.round(v * 10) / 10; }

/* ПОДКЛЮЧЕНИЕ ─────────────────────────────────────────────────────────────────

1) integrate.js: импорт, sim.build = B2.createBuild() в installSystems,
   applyBuild(sim) в systemsNewDay, сейв/восстановление поля build.

   Применитель начисляет износ (out.mods.wear) и пишет события в журнал.

2) simulation.js: выработка домножается на B2.wearWorkMult(this, b) в produceAt —
   ветхое здание работает вполсилы.

3) hud.js: вкладка «Стройка» получает очередь чертежей, кнопку «где лучше»,
   улучшение и ремонт.

────────────────────────────────────────────────────────────────────────────── */
