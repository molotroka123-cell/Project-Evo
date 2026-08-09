// core/systems/link_industry.js — СВЯЗЬ: цепочки ↔ люди ↔ казна ↔ наука ↔ эпоха.
//
// ЗАЧЕМ ЭТОТ ФАЙЛ. wire_production.js уже считает цепочки «руда → сталь» и
// «зерно → мука → хлеб», уже знает узкое место каждой цепочки и уже собирает
// налоги. Но всё это до сих пор не выходило за пределы одной панели: мельницы
// не было — зерно молча гнило на складе, рабочие стояли без дела, и ни счастье,
// ни казна, ни сословия этого не замечали. Наоборот тоже: держава могла
// вырастить поколение мастеров, и цепочкам от этого не становилось ни легче,
// ни быстрее.
//
// ЧТО ИМЕННО СВЯЗАНО (в обе стороны):
//   разрыв цепочки ──▶ простой зданий ──▶ счастье, доход ремесла, сословия
//   долгий простой ──▶ стабильность (медленно, с потолком)
//   нагрузка + пустая казна + ветхость ──▶ ИЗНОС ──▶ авария на производстве
//   избыток сырья на складе ──▶ 📜 знание (ремесло рождает знание)
//   эпоха ──▶ новые звенья цепочек (кому вообще позволено плавить и печь)
//   ОБРАТНО: образованное население ──▶ выпуск цепочек выше, износ ниже
//   ОБРАТНО: задержка жалования из economy.js ──▶ чинить не на что, износ выше
//
// ГЛАВНОЕ ТРЕБОВАНИЕ ДИЗАЙНА: игрок обязан ПРОЧИТАТЬ узкое место словами —
// чего не хватает и что из-за этого стоит. Поэтому текст берётся не свой, а
// готовый из wire_production.chainTrouble(): там уже разобраны все четыре
// случая (нет здания / нет сырья / склад полон / упёрлись в мощность). Вторая
// формулировка тех же причин разошлась бы с панелью «Хозяйство» — а игроку
// нельзя читать в двух местах два разных объяснения одной беды.
//
// ЧИСТЫЙ МОДУЛЬ. Ничего не мутирует: читает sim, возвращает поправки. Применяет
// их integrate.js (точные строки — в блоке ПОДКЛЮЧЕНИЕ в конце файла). Даже
// счётчик износа не пишется в sim: он приходит снаружи (sim.linkIndustry) и
// уходит обратно новым значением в flags.memory.
//
// СЛУЧАЙНОСТИ ЗДЕСЬ НЕТ ВООБЩЕ — ни Math.random (он ломает сейвы), ни sim.rng.
// Авария не «выпадает», а НАСТУПАЕТ, когда износ дошёл до потолка: игрок обязан
// уметь посчитать беду заранее и успеть её предотвратить.
//
// ПОТОЛОК И ВЫХОД У КАЖДОЙ ПЕТЛИ. Простой не роняет счастье ниже IDLE_HAPPY_MAX,
// доход ремесла — не больше чем наполовину, стабильность — не быстрее
// STAB_FLOOR в сутки. Износ после аварии откатывается к WEAR_AFTER, а не
// остаётся на потолке, и при оплаченном жалованье ремонт (до 1.0/день)
// перекрывает любой износ (до 1.5/день частично, а при обученных людях —
// полностью). Спираль смерти невозможна: заплати жалованье и почини — выйдешь.

import { BUILDINGS, ERAS, TECHS, TECH_ERA_IDX, WEATHER } from '../data.js';
import { CHAINS, INTERMEDIATES, EXTRA_BUILDINGS, chainStatus } from './production.js';
import { chainTrouble, suggestBuilding } from './wire_production.js';
import { SOCIAL_FACTIONS } from './politics.js';

export const ESTATES = Object.keys(SOCIAL_FACTIONS);   // nobles, clergy, merchants, commons, military

// В какой эпохе постройка становится доступной. TECH_ERA_IDX отвечает на другой
// вопрос — «в какой эпохе технологию ИЗУЧАЮТ», и для технологий-переходов это
// на эпоху меньше: Бронзу изучают ещё в каменном веке, а Шахта появляется уже
// в бронзовом. Без этой поправки панель обещала бы плавильню в каменном веке.
const TECH_UNLOCK_ERA = (() => {
  const map = {};
  for (const t of TECHS) map[t.id] = (TECH_ERA_IDX[t.id] ?? 0) + (t.era ? 1 : 0);
  return map;
})();
function unlockEra(reqId) { return reqId ? (TECH_UNLOCK_ERA[reqId] ?? 0) : 0; }

// ───────────────────────── Простой ─────────────────────────

// Стадия считается простаивающей, если фактические прогоны заметно ниже её
// мощности. 0.95, а не 1.0 — тот же допуск, что и в chainTrouble(): округления
// дробных прогонов не должны выглядеть простоем.
export const IDLE_EPS = 0.95;

// Полный простой всей промышленности стоит 6 пунктов счастья — ровно столько
// даёт Акведук. То есть вставшее хозяйство отменяет одну хорошую постройку, но
// не переворачивает настроение города само по себе.
export const IDLE_HAPPY_MAX = -6;

// Доля ремесленно-торгового дохода, которую съедает полный простой. Половина, а
// не всё: рынок торгует и привозным, и полностью его обнулить простой не может.
export const IDLE_GOLD_SHARE = 0.5;
// Чей дневной доход зависит от того, есть ли что продавать. Кузница и ферма
// сюда не входят: они сами звенья цепочки, их простой уже посчитан.
export const CRAFT_GOLD_IDS = ['market', 'guild_hall', 'shipyard', 'airport'];

// Сословия при простое. Ремесленники сидят без работы (простолюдины), купцам
// нечего везти. Для сравнения: голод в link_survival.js бьёт простолюдин на
// 0.60 в день — безделье вдвое мягче голода, и это правильный порядок бед.
export const IDLE_ESTATE = { commons: 0.30, merchants: 0.20, nobles: 0, clergy: 0, military: 0 };
export const ESTATE_DROP_CAP = 1.5;      // не больше этого за сутки на сословие

// Стабильность от простоя. Молчит, пока стоит меньше трети мощностей: короткая
// заминка — это не беспорядок в державе. Дальше набирает силу за IDLE_STAB_DAYS
// суток, чтобы игрок успел прочитать причину и починить цепочку.
export const IDLE_STAB_FROM = 0.35;
export const IDLE_STAB_DAYS = 5;
export const IDLE_STAB = 0.5;            // при полном простое и выдержанном сроке
export const STAB_FLOOR = -1.2;          // потолок дневной потери от ВСЕЙ связи (без аварии)
export const IDLE_LOUD = 0.5;            // с этой доли простоя связь говорит вслух

// ───────────────────────── Износ и аварии ─────────────────────────

// Три причины износа. Числа — прибавка к счётчику за сутки при полной силе
// причины; потолок счётчика WEAR_MAX = 100.
export const WEAR_LOAD = 0.6;      // станки не остывают: полная загрузка мощностей
export const WEAR_ARREARS = 0.8;   // жалованье задержано — чинить не на что и некому
export const WEAR_AGE = 0.5;       // ветхость: постройки на WEAR_ERA_GAP эпох старше державы
export const WEAR_ERA_GAP = 2;
export const WEAR_ARREARS_FULL = 5; // столько дней задержки считаем «полной» бедой
export const WEAR_DAY_CAP = 1.5;   // быстрее этого не изнашивается ничего
export const WEAR_MAX = 100;

// Ремонт. Идёт только когда жалованье выплачено (arrears = 0): казна, которая
// не платит людям, не платит и за починку. Обученные руки чинят быстрее.
// 0.65 против WEAR_LOAD = 0.6 выбрано намеренно: одна только работа на полную
// мощность НИКОГДА не доводит до аварии, если казна платит. Авария — цена
// заброшенности (долги по жалованью, ветхие постройки), а не цена труда;
// иначе игрок наказан ровно за то, что его хозяйство работает.
export const REPAIR_BASE = 0.65;
export const REPAIR_SCHOOL = 0.5;  // +50% ремонта при полной образованности
export const REPAIR_BROKE = 0.4;   // пустая казна: ремонт идёт вчетверо хуже даже без долгов

// Образование гасит износ: мастер бережёт станок. Не больше трети — совсем
// избежать износа обучением нельзя, иначе механика перестаёт существовать.
export const WEAR_SCHOOL = 0.35;

// Авария. Наступает детерминированно на потолке износа.
export const WEAR_AFTER = 45;      // куда откатывается счётчик после аварии
export const ACCIDENT_CD = 20;     // и столько суток аварий точно не будет
export const ACC_STOCK_LOSS = -0.25;  // четверть промежуточного склада пропала
export const ACC_HAPPY = -5;
export const ACC_STAB = -3;
export const ACC_HP = 25;             // прочность пострадавшей постройки
export const ACC_GOLD_BASE = 8;       // разбор завала: дороже в поздние эпохи
export const ACC_ESTATE = { commons: 1.2, merchants: 0.6, nobles: 0, clergy: 0, military: 0 };
// Пороги, на которых связь предупреждает о износе вслух. Второй — последний
// звонок: до аварии остаётся примерно десять суток даже при худшем раскладе.
export const WEAR_WARN = [60, 85];

// ───────────────────────── Знание из ремесла ─────────────────────────

// Склад сырья, забитый выше этой доли потолка, — это уже не запас, а материал
// для опытов: подмастерья пробуют, портят и учатся. Ниже — обычный запас.
export const KNOW_FROM = 0.5;
// Потолок прибавки к науке. Для сравнения: Кострище даёт 0.3📜/день, Костёр
// историй 0.5, Университет 2.2. То есть забитые склады при поголовном ремесле
// стоят примерно двух костров историй — заметно, но не заменяет науку.
export const KNOW_MAX = 1.0;
// Без единого ремесленника опыты не идут вовсе: знание рождает не сырьё, а рука.
export const KNOW_BASE_SHARE = 0.4;

// ───────────────────────── Образование → цепочки ─────────────────────────

// Прибавка к выпуску цепочек при полной образованности. 25% — примерно то же,
// что даёт Электростанция промышленности (×1.25): обученные руки стоят одной
// хорошей постройки, но не заменяют её.
export const SPEED_MAX = 0.25;

// Из чего складывается образованность (0..1):
//   доля взрослых с ремеслом ранга 1+ ...................... до 0.75
//   дома знания (out.knowledge): по SCHOOL_EACH за вид ...... до SCHOOL_CAP
export const SKILL_WEIGHT = 0.75;
export const SCHOOL_EACH = 0.06;
export const SCHOOL_CAP = 0.25;
export const ADULT_AGE = 1600;     // 16 лет: YEAR = 100 в population.js

// ───────────────────────── Память связи ─────────────────────────
// Живёт в sim.linkIndustry, но пишется только через возвращаемый flags.memory:
// сам модуль её не трогает.

export function createIndustryMemory() {
  return {
    v: 1,
    day: -1,          // защита от двойного применения в одни сутки
    wear: 0,          // износ хозяйства 0..WEAR_MAX
    accCd: 0,         // откат после аварии
    accidents: 0,
    idleDays: 0,      // сколько суток подряд простаивает больше IDLE_STAB_FROM
    idleLoud: false,  // о простое уже сказано вслух
    wearWarn: 0,      // сколько порогов износа уже названо
    knowLoud: false,  // о том, что излишки идут в опыты, уже сказано
    lastEra: -1,      // эпоха прошлых суток — для события об открытии звена
    kinds: {},        // chainId -> вид узкого места в прошлые сутки
    happyMod: 0,      // последняя поправка к счастью — её читает happiness()
  };
}

export function restoreIndustryMemory(data) {
  const m = createIndustryMemory();
  if (!data || typeof data !== 'object') return m;
  m.day = num(data.day, -1);
  m.wear = clamp(num(data.wear, 0), 0, WEAR_MAX);
  m.accCd = Math.max(0, num(data.accCd, 0));
  m.accidents = Math.max(0, num(data.accidents, 0));
  m.idleDays = Math.max(0, num(data.idleDays, 0));
  m.idleLoud = !!data.idleLoud;
  m.wearWarn = clamp(num(data.wearWarn, 0), 0, WEAR_WARN.length);
  m.knowLoud = !!data.knowLoud;
  m.lastEra = num(data.lastEra, -1);
  m.kinds = (data.kinds && typeof data.kinds === 'object') ? { ...data.kinds } : {};
  m.happyMod = num(data.happyMod, 0);
  return m;
}

// Поправка к счастью для happiness(). Читается каждый кадр, поэтому берётся из
// памяти, а не пересчитывается: связь считается раз в сутки.
export function industryLinkHappyMod(sim) {
  const mem = sim && sim.linkIndustry;
  return mem ? Math.round(num(mem.happyMod, 0)) : 0;
}

// ───────────────────────── Чтение мира ─────────────────────────
// Единственное место, где ядро переводится на язык этой связи.

export function industryState(sim) {
  const S = (sim && sim.industry) || null;
  const era = Math.max(0, Math.round(num(sim && sim.eraIndex, 0)));
  const day = Math.round(num(sim && sim.day, 0));
  const base = {
    ok: false, day, era, chains: [], locked: [],
    idleShare: 0, loadShare: 0, idleBuildings: 0, craftGold: 0,
    surplus: null, surplusShare: 0, arrears: 0, oldShare: 0,
    schooling: 0, craftShare: 0, gained: {},
  };
  if (!S || !S.prod) return base;

  const buildings = (sim.buildings || []).filter(b => b && b.done && !b.destroyed);
  const rows = chainStatus(S.prod, {
    buildings: sim.buildings || [],
    seasonIdx: sim.seasonIdx,
    mult: chainMultOf(sim),
  });
  const runs = (S.prodReport && S.prodReport.runs) || null;

  // Простой считаем ТОЛЬКО по стадиям, у которых есть здания: там, где строить
  // ещё не начинали, никто и не простаивает — это не беда, а пустое место.
  let idleW = 0, totalW = 0, idleB = 0;
  const chains = [];
  for (const row of rows) {
    let cIdleW = 0, cTotalW = 0;
    for (const st of row.stages) {
      if (st.winter || !st.buildings || !(st.capacity > 0.01)) continue;
      const done = runs ? (runs[st.id] || 0) : st.capacity;   // отчёта нет — считаем, что всё крутилось
      const idle = clamp(1 - done / st.capacity, 0, 1);
      cIdleW += idle * st.buildings;
      cTotalW += st.buildings;
      if (idle > 1 - IDLE_EPS) idleB += st.buildings * idle;
    }
    idleW += cIdleW; totalW += cTotalW;
    const trouble = chainTrouble(S, row) || null;
    const stageDef = trouble ? trouble.stage : null;
    chains.push({
      id: row.id, ru: row.ru, final: row.final,
      output: r2(row.output),
      bottleneck: row.bottleneck,
      stageRu: stageDef ? stageDef.ru : null,
      kind: trouble ? trouble.kind : null,
      lack: trouble && trouble.lack ? trouble.lack : null,
      idle: r2(cTotalW > 0 ? cIdleW / cTotalW : 0),
      buildings: cTotalW,
      text: trouble ? punct(trouble.text) : null,
      suggest: trouble ? suggestBuilding(row.id, stageDef ? stageDef.id : null) : null,
    });
  }

  const idleShare = totalW > 0 ? clamp(idleW / totalW, 0, 1) : 0;

  return {
    ok: true, day, era, chains,
    locked: lockedStages(sim, era),
    idleShare: r2(idleShare),
    loadShare: totalW > 0 ? r2(1 - idleShare) : 0,
    idleBuildings: r2(idleB),
    craftGold: r2(craftGoldOf(sim, buildings)),
    ...surplusOf(S.prod),
    arrears: Math.max(0, num(S.eco && S.eco.arrears, 0)),
    oldShare: r2(oldShareOf(buildings, era)),
    ...schoolingOf(sim, buildings),
    gained: (S.prodReport && S.prodReport.gained) || {},
    gold: Math.max(0, num(sim.res && sim.res.gold, 0)),
  };
}

// ───────────────────────── Разбор для игрока ─────────────────────────
// Отдельная функция: HUD зовёт её каждый кадр, она не двигает память и ничего
// не решает — только объясняет словами, где рвётся цепочка и что из-за этого стоит.

export function industryBreakdown(sim) {
  const s = industryState(sim);
  const mem = readMemory(sim);
  if (!s.ok) return { rows: [], wear: 0, idleShare: 0, text: 'Цепочки ещё не заведены.' };

  const rows = [];
  for (const c of s.chains) {
    if (!c.text) continue;
    rows.push({
      id: c.id, ru: c.ru, kind: c.kind, idle: c.idle,
      // Узкое место словами + чем это оборачивается прямо сейчас.
      text: c.text + idleTail(c) + suggestTail(c),
    });
  }
  const parts = stabParts(s, mem);
  return {
    rows,
    wear: r2(mem.wear),
    wearText: wearText(mem.wear, s),
    idleShare: s.idleShare,
    happy: r2(IDLE_HAPPY_MAX * s.idleShare),
    gold: r2(-s.craftGold * IDLE_GOLD_SHARE * s.idleShare),
    knowledge: r2(knowledgeGain(s)),
    stability: r2(parts.total),
    schooling: s.schooling,
    speed: r2(SPEED_MAX * s.schooling),
    text: rows.length
      ? rows.map(r => `${r.ru}: ${r.text}`).join(' ')
      : 'Цепочки идут без разрывов.',
  };
}

// ───────────────────────── Главная связь ─────────────────────────

export function industryLinks(sim) {
  const s = industryState(sim);
  const prev = readMemory(sim);
  const mem = { ...prev, kinds: { ...prev.kinds } };
  const events = [];
  const mods = {
    happy: 0, stability: 0, stabilityShock: 0, gold: 0, knowledge: 0,
    estates: zeroEstates(), output: {}, stockPct: 0, speed: 0,
  };
  const flags = {
    ok: s.ok, idleShare: s.idleShare, wear: r2(prev.wear),
    bottlenecks: [], unlocked: [], accident: null,
    reasons: [], memory: mem,
  };

  if (!s.ok) { mem.happyMod = 0; return { mods, events, flags }; }

  // Двойной вызов в одни сутки не должен ни копить износ дважды, ни ломать
  // станок второй раз. Ядро зовёт раз в день, но консоль умеет дёргать
  // onNewDay повторно — защищаемся так же, как link_survival.js.
  const sameDay = prev.day === s.day;

  // ── 1. Простой: счастье, доход ремесла, сословия.
  mods.happy = r2(IDLE_HAPPY_MAX * s.idleShare);
  mods.gold = r2(-s.craftGold * IDLE_GOLD_SHARE * s.idleShare);
  for (const fid of ESTATES) {
    const d = -(IDLE_ESTATE[fid] || 0) * s.idleShare;
    if (d) mods.estates[fid] = r2(d);
  }

  // ── 2. Счётчики суток. Двигаются только в живой день.
  if (!sameDay) {
    mem.day = s.day;
    mem.accCd = Math.max(0, mem.accCd - 1);
    mem.idleDays = s.idleShare >= IDLE_STAB_FROM ? mem.idleDays + 1 : 0;
    mem.wear = clamp(mem.wear + wearGain(s) - repairRate(s), 0, WEAR_MAX);
  }

  // ── 3. Стабильность: только затянувшийся простой, с потолком.
  const parts = stabParts(s, mem);
  mods.stability = r2(parts.total);

  // ── 4. Знание из излишков сырья.
  mods.knowledge = r2(knowledgeGain(s));

  // ── 5. ОБРАТНАЯ СВЯЗЬ: образованные руки — прибавка к выпуску цепочек.
  // Множитель к самим цепочкам подмешать неоткуда (ctx собирает
  // wire_production), поэтому связь возвращает ПРИБАВКУ к вчерашнему выпуску:
  // результат тот же, а править чужой файл не нужно.
  const speed = SPEED_MAX * s.schooling;      // без округления: прибавка к выпуску
  mods.speed = r2(speed);                     // округлённое — только для показа
  if (speed > 0) {
    for (const chain of CHAINS) {
      const got = num(s.gained[chain.final], 0);
      if (got > 0) mods.output[chain.final] = r2(got * speed);
    }
  }

  // ── 6. Узкие места словами: главное требование дизайна.
  for (const c of s.chains) {
    if (!c.text) continue;
    const row = { id: c.id, ru: c.ru, kind: c.kind, idle: c.idle,
      text: c.text + idleTail(c) + suggestTail(c) };
    flags.bottlenecks.push(row);
    // Говорим вслух только когда узкое место СМЕНИЛОСЬ и цепочке есть чем
    // работать: иначе журнал каждый день повторял бы «нет шахты».
    if (!sameDay && c.buildings > 0 && mem.kinds[c.id] !== c.kind) {
      events.push({ text: `Цепочка «${c.ru}». ${row.text}`, type: c.kind === 'capacity' ? 'info' : 'bad' });
    }
    if (!sameDay) mem.kinds[c.id] = c.kind;
  }

  // ── 7. Простой вслух: отдельным событием, чтобы игрок связал причину и цену.
  if (!sameDay) {
    if (s.idleShare >= IDLE_LOUD && !mem.idleLoud) {
      mem.idleLoud = true;
      events.push({
        text: `Хозяйство встало: без работы ${Math.round(s.idleShare * 100)}% мастерских`
          + `${mods.gold < 0 ? `, ремесло недодаёт ${fmt(-mods.gold)}🪙 в день` : ''}.`,
        type: 'bad',
      });
    } else if (s.idleShare < IDLE_STAB_FROM && mem.idleLoud) {
      mem.idleLoud = false;
      events.push({ text: 'Цепочки снова загружены: мастерские заработали.', type: 'good' });
    }
  }

  // ── 8. Износ: предупреждения и авария.
  flags.wear = r2(mem.wear);
  if (!sameDay) {
    while (mem.wearWarn < WEAR_WARN.length && mem.wear >= WEAR_WARN[mem.wearWarn]) {
      mem.wearWarn++;
      events.push({ text: `${wearText(mem.wear, s)} ${wearCure(s)}`, type: 'warn' });
    }
    // Починили — предупреждения можно услышать снова.
    while (mem.wearWarn > 0 && mem.wear < WEAR_WARN[mem.wearWarn - 1] - 10) mem.wearWarn--;

    if (mem.wear >= WEAR_MAX && mem.accCd <= 0) {
      const victim = worstBuilding(sim, s.era);
      const cost = r2(ACC_GOLD_BASE * (1 + s.era * 0.5));
      flags.accident = {
        building: victim ? victim.id : null,
        name: victim ? victim.name : 'Мастерская',
        hpLoss: ACC_HP, stockPct: ACC_STOCK_LOSS, gold: -cost,
      };
      mods.stockPct = ACC_STOCK_LOSS;
      mods.gold = r2(mods.gold - cost);
      mods.stabilityShock = ACC_STAB;
      mods.happy = r2(mods.happy + ACC_HAPPY);
      for (const fid of ESTATES) {
        if (ACC_ESTATE[fid]) mods.estates[fid] = r2((mods.estates[fid] || 0) - ACC_ESTATE[fid]);
      }
      mem.wear = WEAR_AFTER;          // выход из петли: счётчик откатывается
      mem.accCd = ACCIDENT_CD;
      mem.accidents++;
      mem.wearWarn = 0;
      events.push({
        text: `⚙️ АВАРИЯ: ${flags.accident.name} встала — изношенное хозяйство не выдержало. `
          + `Четверть сырья пропала, разбор завала ${fmt(cost)}🪙.`,
        type: 'bad',
      });
      flags.wear = r2(mem.wear);
    }
  }

  // Потолок дневной потери на сословие — после всех слагаемых.
  for (const fid of ESTATES) {
    if (mods.estates[fid]) mods.estates[fid] = r2(Math.max(-ESTATE_DROP_CAP, mods.estates[fid]));
  }

  // ── 9. Эпоха открывает новые звенья цепочек.
  flags.locked = s.locked;
  if (!sameDay) {
    if (prev.lastEra >= 0 && s.era > prev.lastEra) {
      const opened = openedAt(sim, prev.lastEra, s.era);
      flags.unlocked = opened;
      if (opened.length) {
        events.push({
          text: `${ERAS[s.era] ? ERAS[s.era].ru : 'Новая эпоха'} открывает звенья цепочек: `
            + opened.map(o => `«${o.stageRu}» (${o.name})`).join(', ') + '.',
          type: 'good',
        });
      }
    }
    mem.lastEra = s.era;
  }

  // ── 10. Знание вслух — один раз за эпизод изобилия.
  if (!sameDay) {
    if (mods.knowledge > 0.05 && !mem.knowLoud) {
      mem.knowLoud = true;
      events.push({
        text: `Излишки (${s.surplus.icon} ${s.surplus.ru}) идут в опыты: мастера дают +${fmt(mods.knowledge)}📜 в день.`,
        type: 'good',
      });
    } else if (mods.knowledge <= 0 && mem.knowLoud) {
      mem.knowLoud = false;
    }
  }

  mem.happyMod = mods.happy;
  flags.reasons = reasonRows(s, mods, parts);
  return { mods, events, flags };
}

// ───────────────────────── Внутреннее ─────────────────────────

// Множители цепочек. Формула повторяет chainMult() из wire_production.js — он
// не экспортирован, а править чужой файл нельзя. Если оттуда его когда-нибудь
// вынесут в экспорт, эту функцию надо снести и звать ту.
function chainMultOf(sim) {
  const g = (k) => (typeof sim.globalMult === 'function' ? sim.globalMult(k) : 1);
  const w = WEATHER[sim && sim.weather] || { gather: 1, farm: 1 };
  const techs = (sim && sim.techs) || null;
  return {
    gather: g('gather') * w.gather,
    farm: w.farm * (techs && techs.has && techs.has('feudalism') ? 1.2 : 1),
    industry: g('industry'),
  };
}

// Слагаемые дневной поправки к стабильности. Отдельно, потому что их читают
// двое: сама связь и разбор для HUD.
function stabParts(s, mem) {
  const out = { idle: 0, total: 0 };
  if (s.idleShare >= IDLE_STAB_FROM) {
    // Свежий простой почти не считается: держава замечает не остановку, а то,
    // что она тянется. Полная сила — на IDLE_STAB_DAYS-е сутки.
    const ripe = Math.min(1, mem.idleDays / IDLE_STAB_DAYS);
    out.idle = -IDLE_STAB * s.idleShare * ripe;
  }
  out.total = Math.max(STAB_FLOOR, out.idle);
  return out;
}

function wearGain(s) {
  const arrearsPress = Math.min(1, s.arrears / WEAR_ARREARS_FULL);
  const raw = WEAR_LOAD * s.loadShare + WEAR_ARREARS * arrearsPress + WEAR_AGE * s.oldShare;
  // Обученные руки берегут станок — но не больше чем на WEAR_SCHOOL.
  return Math.min(WEAR_DAY_CAP, raw) * (1 - WEAR_SCHOOL * s.schooling);
}

function repairRate(s) {
  if (s.arrears > 0) return 0;                 // не платим людям — не платим и за починку
  const money = s.gold > 0 ? 1 : REPAIR_BROKE; // совсем пустая казна чинит еле-еле
  return REPAIR_BASE * (1 + REPAIR_SCHOOL * s.schooling) * money;
}

// Ремесло рождает знание: забитый склад — это материал для опытов, но опыты
// ставит человек, поэтому доля ремесленников входит множителем.
function knowledgeGain(s) {
  if (!(s.surplusShare > 0)) return 0;
  const hands = KNOW_BASE_SHARE + (1 - KNOW_BASE_SHARE) * s.craftShare;
  return Math.min(KNOW_MAX, KNOW_MAX * s.surplusShare * hands);
}

// Самый заполненный промежуточный склад сверх KNOW_FROM. Излишек нормируем на
// остаток до потолка: «половина склада» — это ещё запас, «полный» — уже избыток.
function surplusOf(prod) {
  let best = null, share = 0;
  for (const it of INTERMEDIATES) {
    const have = Math.max(0, num(prod.stock ? prod.stock[it.id] : 0, 0));
    const fill = it.cap > 0 ? have / it.cap : 0;
    const over = fill > KNOW_FROM ? (fill - KNOW_FROM) / (1 - KNOW_FROM) : 0;
    if (over > share) { share = over; best = { id: it.id, ru: it.ru, icon: it.icon, have: r2(have), fill: r2(fill) }; }
  }
  return { surplus: best, surplusShare: r2(clamp(share, 0, 1)) };
}

function craftGoldOf(sim, buildings) {
  let sum = 0;
  for (const b of buildings) {
    if (!CRAFT_GOLD_IDS.includes(b.id)) continue;
    const def = BUILDINGS[b.id];
    if (!def || !def.out || !def.out.gold) continue;
    // Доход ядра считается по числу занятых рабочих — берём то же число.
    const n = b.workers ? b.workers.length : (def.workers || 0);
    sum += def.out.gold * n;
  }
  return sum * (typeof sim.globalMult === 'function' ? sim.globalMult('gold') : 1);
}

// Ветхость: доля работающих построек, отставших от державы на WEAR_ERA_GAP эпох.
// eraBuilt проставляет ядро при постройке — своего возраста зданий тут не заводим.
function oldShareOf(buildings, era) {
  let old = 0, n = 0;
  for (const b of buildings) {
    const def = BUILDINGS[b.id] || EXTRA_BUILDINGS[b.id];
    if (!def || !(def.out || def.chain)) continue;   // жильё и стены не изнашиваются производством
    n++;
    if (era - num(b.eraBuilt, era) >= WEAR_ERA_GAP) old++;
  }
  return n > 0 ? old / n : 0;
}

// Образованность державы 0..1 и доля ремесленников среди взрослых.
function schoolingOf(sim, buildings) {
  const vs = (sim.villagers || []).filter(v => v && (v.hp == null || v.hp > 0));
  const adults = vs.filter(v => v.age == null || v.age >= ADULT_AGE);
  const ranked = adults.filter(v => (v.rank || 0) >= 1).length;
  const craftShare = adults.length ? ranked / adults.length : 0;

  const seen = new Set();
  let school = 0;
  for (const b of buildings) {
    const def = BUILDINGS[b.id];
    if (!def || !def.out || !def.out.knowledge || seen.has(b.id)) continue;
    seen.add(b.id);
    school += SCHOOL_EACH;      // два университета не учат вдвое лучше одного
  }
  return {
    craftShare: r2(craftShare),
    schooling: r2(clamp(SKILL_WEIGHT * craftShare + Math.min(SCHOOL_CAP, school), 0, 1)),
  };
}

// Звенья цепочек, которые эпоха ещё не открыла: ни один исполнитель стадии не
// доступен по технологиям. Это и есть «эпоха открывает новые звенья», сказанное
// игроку заранее, а не задним числом.
function lockedStages(sim, era) {
  const techs = (sim && sim.techs) || null;
  const known = (id) => !!(techs && techs.has && techs.has(id));
  const out = [];
  for (const chain of CHAINS) {
    for (const st of chain.stages) {
      let open = false, bestEra = 99, bestName = null;
      for (const p of st.by) {
        const def = BUILDINGS[p.b] || EXTRA_BUILDINGS[p.b];
        if (!def) continue;
        if (!def.req || known(def.req)) { open = true; break; }
        const e = unlockEra(def.req);
        if (e < bestEra) { bestEra = e; bestName = def.name; }
      }
      if (open || bestName == null) continue;
      out.push({
        chainId: chain.id, chainRu: chain.ru, stageId: st.id, stageRu: st.ru,
        name: bestName, era: bestEra, eraRu: ERAS[bestEra] ? ERAS[bestEra].ru : '—',
        text: bestEra > era
          ? `«${chain.ru}» → ${st.ru}: звено откроется в ${ERAS[bestEra] ? ERAS[bestEra].ru : 'будущем'} (${bestName}).`
          : `«${chain.ru}» → ${st.ru}: нужна технология для постройки «${bestName}».`,
      });
    }
  }
  return out;
}

// Что открылось при переходе from → to. Смотрим по эпохе технологии-гейта:
// именно смена эпохи и есть событие, о котором игроку стоит сказать.
function openedAt(sim, from, to) {
  const out = [];
  for (const chain of CHAINS) {
    for (const st of chain.stages) {
      for (const p of st.by) {
        const def = BUILDINGS[p.b] || EXTRA_BUILDINGS[p.b];
        if (!def || !def.req) continue;
        const e = unlockEra(def.req);
        if (e > from && e <= to) {
          out.push({ chainId: chain.id, chainRu: chain.ru, stageId: st.id, stageRu: st.ru, name: def.name, era: e });
        }
      }
    }
  }
  return out;
}

// Кого именно ломает авария: самую ветхую работающую постройку цепочек. Выбор
// детерминированный (сначала по отставанию эпох, потом по порядку в списке) —
// иначе один и тот же сейв ломал бы разные здания.
function worstBuilding(sim, era) {
  const ids = new Set();
  for (const chain of CHAINS) for (const st of chain.stages) for (const p of st.by) ids.add(p.b);
  let best = null, bestAge = -1;
  const list = (sim.buildings || []).filter(b => b && b.done && !b.destroyed);
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (!ids.has(b.id)) continue;
    const age = era - num(b.eraBuilt, era);
    if (age > bestAge) {
      bestAge = age;
      const def = BUILDINGS[b.id] || EXTRA_BUILDINGS[b.id];
      best = { id: b.id, name: def ? def.name : b.id, index: i, ref: b };
    }
  }
  return best;
}

// chainTrouble() не всегда ставит точку в конце (там текст оканчивается списком
// зданий), а мы дописываем к нему свой хвост — без этого выходит «Каменоломня
// Строить: Шахта».
function punct(s) { return /[.!?…]$/.test(s) ? s : s + '.'; }

// Хвост к тексту узкого места: во что этот разрыв обходится прямо сейчас.
function idleTail(c) {
  if (!(c.idle > 1 - IDLE_EPS)) return '';
  return ` Простаивает ${Math.round(c.idle * 100)}% зданий цепочки.`;
}
function suggestTail(c) {
  if (!c.suggest || c.kind === 'capacity' || c.kind === 'winter') return '';
  return ` Строить: ${c.suggest.name}.`;
}

function wearText(wear, s) {
  if (wear >= WEAR_WARN[1]) return `Хозяйство изношено (${Math.round(wear)}%): авария близка.`;
  if (wear >= WEAR_WARN[0]) return `Станки и печи потрёпаны (${Math.round(wear)}%).`;
  return `Износ хозяйства ${Math.round(wear)}%.`;
}
function wearCure(s) {
  if (s.arrears > 0) return 'Чинить не на что: жалованье задержано.';
  if (s.oldShare > 0.5) return 'Половина построек отстала от эпохи — их пора обновить.';
  if (s.loadShare > 0.8) return 'Мастерские не остывают — нужны запасные.';
  return 'Ремонт идёт.';
}

// Готовые строки причин для панели: игрок обязан читать причину, а не сводить её сам.
function reasonRows(s, mods, parts) {
  const rows = [];
  if (mods.happy) rows.push({ id: 'idle', ru: 'Простой мастерских', v: r2(mods.happy),
    text: `Без работы ${Math.round(s.idleShare * 100)}% зданий цепочек: ${fmt(mods.happy)} к счастью.` });
  if (mods.gold) rows.push({ id: 'gold', ru: 'Недобор ремесла', v: r2(mods.gold),
    text: `Ремеслу нечего продавать: ${fmt(mods.gold)}🪙 в день.` });
  if (parts.idle) rows.push({ id: 'stab', ru: 'Стабильность', v: r2(parts.idle),
    text: `Хозяйство стоит не первый день: ${fmt(parts.idle)} стабильности в день.` });
  if (mods.knowledge) rows.push({ id: 'know', ru: 'Опыты ремесла', v: r2(mods.knowledge),
    text: `Излишки сырья идут в опыты: +${fmt(mods.knowledge)}📜 в день.` });
  if (mods.speed) rows.push({ id: 'speed', ru: 'Обученные руки', v: r2(mods.speed),
    text: `Мастера и школы ускоряют цепочки на ${Math.round(mods.speed * 100)}%.` });
  return rows;
}

function readMemory(sim) {
  const m = sim && sim.linkIndustry;
  return m && typeof m === 'object' ? restoreIndustryMemory(m) : createIndustryMemory();
}

function zeroEstates() { return Object.fromEntries(ESTATES.map(f => [f, 0])); }
function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function r2(v) { return Math.round(v * 100) / 100; }
function fmt(v) { const r = Math.round(v * 10) / 10; return (r > 0 ? '+' : '') + r; }

/* ПОДКЛЮЧЕНИЕ

   Файл: app/src/core/systems/integrate.js

1) Импорт. ЯКОРЬ (строка уникальна в файле):
     import * as LS from './link_survival.js';
   ДОБАВИТЬ СРАЗУ ПОСЛЕ НЕЁ:
     import * as LIND from './link_industry.js';

2) Память связи, в installSystems(). ЯКОРЬ (строка уникальна в файле; строку
   «sim.linkSurvival = LS.createSurvivalMemory();» брать НЕЛЬЗЯ — она встречается
   в файле дважды):
     sim.sys.borderStats = null;
   ДОБАВИТЬ СРАЗУ ПОСЛЕ НЕЁ:
     // Память связи хозяйства: износ, счётчик простоя, эпоха прошлых суток.
     sim.linkIndustry = LIND.createIndustryMemory();

3) Применение раз в сутки. ЯКОРЬ (строка уникальна в файле):
     applySurvivalLinks(sim);
   ДОБАВИТЬ СРАЗУ ПОСЛЕ НЕЁ:
     applyIndustryLinks(sim);

4) В КОНЕЦ файла добавить функцию-применитель (модуль сам ничего не меняет):

function applyIndustryLinks(sim) {
  if (!sim.industry) return null;
  const L = LIND.industryLinks(sim);
  sim.linkIndustry = L.flags.memory;
  sim.sys.indLinks = L;                   // для HUD: панель читает готовый разбор

  // Обученные руки — прибавка к вчерашнему выпуску цепочек. Множитель внутрь
  // wire_production не подмешать, поэтому прибавка начисляется здесь, с тем же
  // потолком склада, что и у самих цепочек.
  for (const [r, add] of Object.entries(L.mods.output)) {
    if (!(r in sim.res) || !add) continue;
    sim.res[r] = Math.min(sim.resCap[r] ?? 99999, sim.res[r] + add);
  }

  // Недобор ремесла и разбор завала после аварии.
  if (L.mods.gold) sim.res.gold = Math.max(0, sim.res.gold + L.mods.gold);
  // Опыты подмастерьев: избыток сырья превращается в знание.
  if (L.mods.knowledge) sim.res.knowledge += L.mods.knowledge;

  const pst = sim.politics && sim.politics.state;
  if (pst) {
    pst.stability = Math.max(0, Math.min(100, pst.stability + L.mods.stability + L.mods.stabilityShock));
    for (const [fid, d] of Object.entries(L.mods.estates)) {
      if (!d || pst.factions[fid] == null) continue;
      pst.factions[fid] = Math.max(0, Math.min(100, pst.factions[fid] + d));
    }
  }

  // Авария: часть промежуточного склада пропала, пострадавшая постройка побита.
  // Долей, а не числом — плоская потеря добила бы маленькое хозяйство.
  if (L.mods.stockPct && sim.industry.prod) {
    const stock = sim.industry.prod.stock;
    for (const k of Object.keys(stock)) stock[k] = Math.max(0, stock[k] * (1 + L.mods.stockPct));
  }
  const acc = L.flags.accident;
  if (acc && acc.building) {
    const b = sim.buildings.find(x => x.id === acc.building && x.done && !x.destroyed);
    if (b) b.hp = Math.max(1, (b.hp || 100) - acc.hpLoss);
    sim.addChronicle(`Авария на производстве: ${acc.name} (день ${sim.day}).`);
    sim.sfx?.('alarm');
  }

  for (const e of L.events) sim.addLog(e.text, e.type === 'warn' ? 'bad' : e.type);
  return L;
}

5) Счастье. ЯКОРЬ (строка уникальна в файле) — сейчас она такая:
     + LS.survivalHappyMod(sim);
   ЗАМЕНИТЬ НА:
     + LS.survivalHappyMod(sim) + LIND.industryLinkHappyMod(sim);

6) СЕЙВ. Якорь в systemsSerialize():
     link: sim.linkSurvival || null,
   ДОБАВИТЬ строкой ниже:
     linkInd: sim.linkIndustry || null,

   Якорь в systemsRestore():
     sim.linkSurvival = LS.restoreSurvivalMemory(data.link);
   ДОБАВИТЬ строкой ниже:
     sim.linkIndustry = LIND.restoreIndustryMemory(data.linkInd);

7) Для панели «Хозяйство» (по желанию, ничего не меняет):
     LIND.industryBreakdown(sim)      // узкие места словами, износ, что это стоит
     sim.sys.indLinks.flags.bottlenecks  // строка на цепочку: чего не хватает и что стоит
     sim.sys.indLinks.flags.locked       // какие звенья откроет какая эпоха
     sim.sys.indLinks.flags.reasons      // готовые строки причин для сводки
*/
