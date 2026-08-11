// core/systems/link_masters.js — СВЯЗЬ: ремесло живёт в людях, а не в списке
// изученного.
//
// ЗАЧЕМ ЭТОТ ФАЙЛ. Технология в игре — это галочка: изучил кузнечное дело, и
// кузница работает одинаково хорошо всегда, кто бы в ней ни стоял. Люди при
// этом именные, они рождаются и умирают, но для хозяйства они взаимозаменяемы,
// как мешки. Отсюда странность: набег унёс половину поселения — производство не
// заметило; голодная зима выкосила стариков — выпуск тот же.
//
// Здесь у ремесла появляется носитель. У каждого промысла есть МАСТЕР — живой
// житель с именем, который годами стоит у одной наковальни и делает работу
// лучше прочих. Пока он жив, промысел даёт прибавку. Когда он умирает, всё
// зависит от того, успел ли он взять УЧЕНИКА: успел — ремесло переходит почти
// без потерь, не успел — умение уходит вместе с ним, и набирать его заново
// придётся годами.
//
// ЧТО ЭТО МЕНЯЕТ В ИГРЕ. Защита людей перестаёт быть заботой о численности.
// Один погибший в набеге — это не «−1 к населению», а возможная потеря
// половины выпуска кузницы на десять лет. Появляется смысл держать на
// производстве вторую пару рук, даже когда это не нужно по числу рабочих мест:
// вторая пара рук — это ученик.
//
// ПОЧЕМУ МАСТЕР ВЫБИРАЕТСЯ ДЕТЕРМИНИРОВАННО. Здесь запрещён и Math.random, и
// sim.rng: имя мастера обязано совпасть до и после загрузки сейва. Поэтому
// мастером становится не «случайный работник», а тот, кто в списке жителей идёт
// первым среди работающих на этом промысле — список ведёт ядро, и порядок в нём
// одинаков всегда.
import { BUILDINGS } from '../data.js';

// Потолок умения. 1.0 значит «мастер своего дела»; выше не бывает, иначе один
// долгожитель обесценивал бы всё остальное хозяйство.
export const MAX_LEVEL = 1.0;

// За сколько дней непрерывной работы мастер набирает полное умение. Десять лет:
// ремесло не выучивается за сезон, и в этом весь смысл потери.
export const LEARN_DAYS = 1000;

// Прибавка к выпуску промысла при полном умении.
export const MASTER_GAIN = 0.45;

// Что остаётся от умения, когда мастер умер.
export const KEEP_WITH_HEIR = 0.85;   // ученик перенял почти всё
export const KEEP_NO_HEIR = 0.25;     // некому было передать

// Ученик появляется, только если на промысле есть кому учиться: вторая пара рук.
export const APPRENTICE_MIN_WORKERS = 2;
// И перенимает не сразу: пока он подмастерье, он не мастер.
export const APPRENTICE_DAYS = 250;

// Ниже этого умение считается утраченным и промысел выбывает из списка: держать
// запись про давно забытое ремесло незачем, она попадает в каждый сейв.
export const FORGET_BELOW = 0.02;

// Сколько дней подряд промысел должен простоять пустым, чтобы считаться
// заброшенным.
//
// ЗАЧЕМ ЭТА ОТСРОЧКА. Жители не стоят у наковальни неотлучно: они идут к ней,
// несут добытое на склад, перевыбирают работу — и в ЛЮБОЙ отдельно взятый день
// на промысле может не оказаться никого. Первая версия на это сразу забывала
// мастера, и на живом городе после девяти лет умение честно росло до 68%, а
// мастер во всех четырёх промыслах был null: его назначали и тут же теряли.
// Мастер держится за место, пока жив, а не пока стоит у горна.
export const IDLE_GRACE = 40;

export function createMasters() {
  return { v: 1, day: -1, crafts: {} };
}

export function restoreMasters(data) {
  const m = createMasters();
  if (!data || typeof data !== 'object') return m;
  m.day = num(data.day, -1);
  if (data.crafts && typeof data.crafts === 'object') {
    for (const [id, c] of Object.entries(data.crafts)) {
      if (!c || typeof c !== 'object') continue;
      m.crafts[id] = {
        level: clamp(num(c.level, 0), 0, MAX_LEVEL),
        master: typeof c.master === 'string' ? c.master : null,
        since: num(c.since, 0),
        apprentice: typeof c.apprentice === 'string' ? c.apprentice : null,
        appSince: num(c.appSince, 0),
        idle: Math.max(0, num(c.idle, 0)),
      };
    }
  }
  return m;
}

// ---------- Чтение мира ----------

// Кто на каком промысле сегодня работает. Работники привязаны к постройке через
// v.target.b, а НЕ через b.workers: последний список ядро держит только для
// строителей. Ошибиться здесь — значит не найти ни одного мастера ни разу.
export function workersByCraft(sim) {
  const map = new Map();
  const list = sim && sim.villagers ? sim.villagers : [];
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    if (!v || (v.hp !== undefined && v.hp <= 0)) continue;
    const b = v.target && v.target.b;
    if (!b || !b.done || b.destroyed) continue;
    const def = BUILDINGS[b.id];
    // Промысел — это то, что что-то производит. Жильё и стены мастеров не имеют.
    if (!def || !def.out) continue;
    if (!map.has(b.id)) map.set(b.id, []);
    map.get(b.id).push({ v, idx: i });
  }
  return map;
}

const aliveNames = (sim) => {
  const s = new Set();
  for (const v of (sim.villagers || [])) {
    if (v && (v.hp === undefined || v.hp > 0)) s.add(v.name);
  }
  return s;
};

// ---------- Главная функция ----------

export function masterLinks(sim) {
  const day = sim && typeof sim.day === 'number' ? sim.day : 0;
  const M = sim && sim.linkMasters ? sim.linkMasters : createMasters();
  const out = {
    mods: { output: {} },           // ресурс → сколько добавить за сутки
    events: [],
    flags: { memory: M, lost: [], promoted: [], crafts: {} },
  };
  if (M.day === day) return out;   // один день считается один раз

  const N = { v: 1, day, crafts: {} };
  for (const [k, c] of Object.entries(M.crafts)) N.crafts[k] = { ...c };

  const byCraft = workersByCraft(sim);
  const alive = aliveNames(sim);

  // Промыслы, о которых мы уже знаем, плюс те, где сегодня кто-то работает.
  const ids = new Set([...Object.keys(N.crafts), ...byCraft.keys()]);

  for (const id of ids) {
    const workers = byCraft.get(id) || [];
    let c = N.crafts[id];
    if (!c) c = N.crafts[id] = { level: 0, master: null, since: day, apprentice: null, appSince: 0, idle: 0 };

    // --- Жив ли мастер ------------------------------------------------------
    const masterAlive = c.master && alive.has(c.master);
    if (c.master && !masterAlive) {
      const heir = c.apprentice && alive.has(c.apprentice) ? c.apprentice : null;
      const before = c.level;
      if (heir) {
        c.level = c.level * KEEP_WITH_HEIR;
        c.master = heir; c.since = day;
        c.apprentice = null; c.appSince = 0;
        out.events.push({
          text: `⚒ ${craftName(id)}: мастера не стало, но дело принял ${heir} — ремесло сохранено.`,
          type: 'info',
        });
      } else {
        c.level = c.level * KEEP_NO_HEIR;
        c.master = null; c.since = day;
        out.flags.lost.push({ id, before: round2(before), after: round2(c.level) });
        // Говорим только о заметной потере: если мастер был новичком, терять
        // было нечего, и сообщение только зашумило бы журнал.
        if (before >= 0.25) {
          out.events.push({
            text: `⚒ ${craftName(id)}: мастер умер, не оставив ученика. С ним ушло ремесло — умение упало с `
              + `${Math.round(before * 100)}% до ${Math.round(c.level * 100)}%.`,
            type: 'bad',
          });
        }
      }
    }

    // --- Некому работать -----------------------------------------------------
    if (!workers.length) {
      c.idle = (c.idle || 0) + 1;
      // Короткий простой — это обычный ход дня, а не заброшенность: мастер
      // просто понёс железо на склад. Ремесло при этом не забывается.
      if (c.idle <= IDLE_GRACE) {
        if (c.master && !alive.has(c.master)) c.master = null;
        if (c.apprentice && !alive.has(c.apprentice)) c.apprentice = null;
        continue;
      }
      // Забывается втрое медленнее, чем набиралось: заброшенная кузница не
      // становится пустым местом за сезон.
      c.level = Math.max(0, c.level - MAX_LEVEL / (LEARN_DAYS * 3));
      c.master = null; c.apprentice = null;
      if (c.level < FORGET_BELOW) delete N.crafts[id];
      continue;
    }
    c.idle = 0;

    // --- Назначение мастера -------------------------------------------------
    // Первый по списку жителей среди работающих. Не «случайный» и не «лучший»:
    // порядок в списке ведёт ядро, он одинаков до и после загрузки сейва.
    if (!c.master || !alive.has(c.master)) {
      const first = workers[0];
      c.master = first.v.name;
      c.since = day;
      out.flags.promoted.push({ id, name: c.master });
    }
    // Мастер, вышедший сегодня со двора, места не теряет: он назначен, пока жив.

    // --- Ученик -------------------------------------------------------------
    if (c.apprentice && !alive.has(c.apprentice)) { c.apprentice = null; c.appSince = 0; }
    if (!c.apprentice && workers.length >= APPRENTICE_MIN_WORKERS) {
      const cand = workers.find(w => w.v.name !== c.master);
      if (cand) {
        c.apprentice = cand.v.name;
        c.appSince = day;
        // Про ученика говорим только когда мастеру уже есть что передавать.
        if (c.level >= 0.3) {
          out.events.push({
            text: `⚒ ${craftName(id)}: ${c.master} взял ученика — ${c.apprentice}. Теперь ремесло переживёт мастера.`,
            type: 'good',
          });
        }
      }
    }

    // --- Рост умения --------------------------------------------------------
    c.level = Math.min(MAX_LEVEL, c.level + MAX_LEVEL / LEARN_DAYS);

    // --- Прибавка к выпуску -------------------------------------------------
    const def = BUILDINGS[id];
    if (def && def.out && c.level > 0.01) {
      const k = MASTER_GAIN * c.level;
      // Считаем по числу работающих: мастер поднимает своё дело, а не всю
      // державу. Иначе одна кузница с долгожителем кормила бы весь склад.
      for (const [res, amount] of Object.entries(def.out)) {
        out.mods.output[res] = (out.mods.output[res] || 0) + amount * workers.length * k;
      }
    }
    out.flags.crafts[id] = {
      level: round2(c.level), master: c.master, apprentice: c.apprentice,
      workers: workers.length,
      // Сколько лет мастер у дела — это и есть то, что игрок теряет.
      years: round2((day - c.since) / 100),
    };
  }

  out.flags.memory = N;
  return out;
}

// ---------- Для HUD ----------

// Что за промысел. Имя постройки — единственный источник: свой список названий
// разошёлся бы с игрой при первой же правке данных.
export function craftName(id) {
  const def = BUILDINGS[id];
  // Поле называется name, а не ru: у построек своё соглашение, отличное от
  // ресурсов и эпох. Проверено по данным, а не угадано — с ru здесь во все
  // сообщения журнала попадали бы английские идентификаторы вроде «smithy».
  return def && def.name ? def.name : id;
}

// Строки для панели «Народ»: у кого что в руках и что мы потеряем, если его
// не станет. Память НЕ двигает — звать из рендера безопасно.
export function mastersReport(sim) {
  const M = sim && sim.linkMasters ? sim.linkMasters : createMasters();
  const day = sim && typeof sim.day === 'number' ? sim.day : 0;
  const rows = [];
  for (const [id, c] of Object.entries(M.crafts)) {
    if (c.level < 0.05) continue;
    rows.push({
      id, ru: craftName(id),
      level: round2(c.level),
      master: c.master,
      apprentice: c.apprentice,
      years: round2((day - c.since) / 100),
      // Прямой ответ на вопрос «чем я рискую»: во сколько обойдётся смерть
      // мастера прямо сейчас.
      atRisk: round2(c.level * (c.apprentice ? (1 - KEEP_WITH_HEIR) : (1 - KEEP_NO_HEIR))),
      safe: !!c.apprentice,
    });
  }
  rows.sort((a, b) => b.level - a.level);
  return rows;
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function num(v, def) { return Number.isFinite(v) ? v : def; }
function round2(v) { return Math.round(v * 100) / 100; }

/* ПОДКЛЮЧЕНИЕ ─────────────────────────────────────────────────────────────────

integrate.js: импорт, sim.linkMasters = MAS.createMasters() в installSystems,
applyMasterLinks(sim) в systemsNewDay ПОСЛЕ applyIndustryLinks (мастера
поднимают выпуск, который тот уже посчитал), сейв/восстановление поля masters.

Применитель начисляет out.mods.output в sim.res с тем же потолком склада, что и
у самих цепочек, и пишет события в журнал.

────────────────────────────────────────────────────────────────────────────── */
