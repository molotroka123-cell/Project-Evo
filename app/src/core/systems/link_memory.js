// core/systems/link_memory.js — СВЯЗЬ: что записано в летописи → как живут люди.
//
// ЗАЧЕМ ЭТОТ ФАЙЛ. sim.chronicle пишется с первого дня: голод, морозы, взятые
// города, отпавшие провинции. И не значит ровно ничего — это архив, который
// игрок открывает раз в партию из любопытства. Здесь летопись перестаёт быть
// украшением и становится причиной: пережитое МЕНЯЕТ поведение державы.
//
// ГЛАВНАЯ МЫСЛЬ. Народ, переживший голод, ведёт себя не так, как народ, его не
// знавший. Он прячет зерно — склад полнее, но обороту от этого хуже. Он не
// верит короне, потому что корона однажды не смогла его прокормить. И это
// проходит не тогда, когда наладилось хозяйство, а тогда, когда сменяется
// поколение, которое помнит.
//
// ЧТО ИМЕННО СВЯЗАНО (в обе стороны):
//   голод в летописи      ──▶ бережливость (меньше едят) + недоверие к власти
//   мор в летописи        ──▶ народ идёт к жрецам: одобрение духовенства растёт
//   стужа в летописи      ──▶ дрова запасают впрок: горит меньше, но и радости меньше
//   потеря провинции      ──▶ позор: военные требуют войны, мир их злит
//   победы и взятые города──▶ гордость: стабильность выше, соседи наглеют реже
//   предательство соседа  ──▶ этому соседу не верят: отношения тянет вниз
//   ОБРАТНО: сытые и спокойные годы стирают шрам быстрее голодных
//   ОБРАТНО: свежая беда той же породы поднимает старый шрам обратно
//
// ПОЧЕМУ ПАМЯТЬ ЗАТУХАЕТ ПО ВРЕМЕНИ, А НЕ ПО СМЕНЕ ПОКОЛЕНИЙ. Правильно было бы
// считать долю живых, заставших событие: у жителей есть имена, но нет возраста,
// и «поколение» в модели пока не существует. Поэтому здесь честное приближение —
// затухание по годам (год = 100 дней, DAYS_PER_SEASON × 4). Когда у жителей
// появится возраст, весенний коэффициент FADE заменится на долю помнящих, и
// больше в этом файле менять будет нечего: всё остальное считается от strength.
//
// СЛУЧАЙНОСТИ ЗДЕСЬ НЕТ ВООБЩЕ — ни Math.random, ни sim.rng. Память обязана
// быть одинаковой до и после загрузки сейва, а событие обязано оставлять след
// всегда, а не выпадать по броску.
import { DAYS_PER_SEASON } from '../data.js';

// ---------- Единицы времени ----------

export const YEAR = DAYS_PER_SEASON * 4;      // 100 дней

// Через столько лет след слабеет вдвое. Шесть лет — это заметная часть партии
// (обычная партия идёт 5–20 лет) и при этом не «навсегда»: игрок, наладивший
// дела, должен увидеть, как страна отходит от беды, а не тащить её до конца.
export const HALF_LIFE_YEARS = 6;

// Ниже этого след считается стёртым и выбрасывается из памяти: держать список,
// который растёт всю партию, незачем — он попадает в каждый сейв.
export const FORGET_BELOW = 0.04;

// Слияние повторов. События одной породы в пределах сезона — это одна беда,
// а не тридцать (подробности в комментарии к remember()). MERGE_ADD — какая
// доля повтора идёт в усиление, MERGE_CAP — во сколько раз одна беда может
// перерасти вес одиночного события.
export const MERGE_DAYS = DAYS_PER_SEASON;   // 25
export const MERGE_ADD = 0.18;
export const MERGE_CAP = 2.2;

// ---------- Породы шрамов ----------
//
// weight — насколько сильным становится след от ОДНОГО события. Числа разной
// величины намеренно: потеря провинции запоминается сильнее одной голодной
// зимы, и это должно быть видно прямо в таблице, а не выводиться из формул.
export const KIND = {
  famine:   { ru: 'Голод',            weight: 0.55, cap: 1.6 },
  frost:    { ru: 'Стужа',            weight: 0.40, cap: 1.4 },
  plague:   { ru: 'Мор',              weight: 0.50, cap: 1.5 },
  shame:    { ru: 'Позор',            weight: 0.85, cap: 2.0 },
  triumph:  { ru: 'Победа',           weight: 0.60, cap: 1.8 },
  betrayal: { ru: 'Предательство',    weight: 0.70, cap: 1.8 },
};

// ---------- Во что обходится память ----------
// Все числа — на единицу силы следа (strength = 1.0, то есть свежая крупная
// беда). Потолки заданы через cap выше, поэтому даже десять голодных лет подряд
// не уводят державу в бесконечный минус.

// Голод. Бережливость реальна и полезна: люди едят меньше. Цена — недоверие.
export const FAMINE_EAT_CUT = 0.10;       // до −10% расхода еды
export const FAMINE_STAB = 0.22;          // до −0.22 стабильности в день
export const FAMINE_HAPPY = 3.5;          // до −3.5 счастья

// Мор. Народ идёт к жрецам — это единственный шрам, который кому-то выгоден.
export const PLAGUE_CLERGY = 0.10;        // до +0.10 одобрения духовенства в день
export const PLAGUE_CLERGY_CAP = 78;      // выше этого память их уже не поднимает
export const PLAGUE_HAPPY = 2.0;

// Стужа. Дрова запасают впрок: сгорает меньше, но живут скупее.
export const FROST_WOOD_CUT = 0.12;       // до −12% сжигаемых дров
export const FROST_HAPPY = 2.0;

// Позор потерянной провинции. Военные требуют похода; мир их злит.
export const SHAME_MIL_WAR = 0.14;        // до +0.14 в день, ПОКА идёт война
export const SHAME_MIL_PEACE = 0.10;      // до −0.10 в день в мирное время
export const SHAME_STAB = 0.18;

// Гордость. Единственный источник прибавки к стабильности в этом файле.
export const PRIDE_STAB = 0.20;
export const PRIDE_HAPPY = 2.5;
export const PRIDE_STAB_CEILING = 85;     // выше этого гордость уже не поднимает

// Предательство. Отношения тянет вниз, но не бесконечно: ядро само их
// восстанавливает, и наша тяга лишь замедляет примирение.
export const BETRAYAL_REL = 0.35;         // до −0.35 отношений в день
export const BETRAYAL_REL_FLOOR = -40;    // ниже этого память уже не давит

// Сытые годы стирают шрам быстрее. Множитель к скорости забывания, когда в
// державе спокойно и сыто — иначе игрок, наладивший дела, не видит награды.
export const HEAL_BONUS = 0.6;            // до +60% к скорости забывания

// ---------- Память ----------

export function createMemory() {
  return {
    v: 1,
    day: -1,          // защита от двойного применения в одни сутки
    scars: [],        // [{kind, day, w, fid?, note}] — w это накопленный вес
    lastSaid: {},     // kind → день последнего рассказа, чтобы не бубнить
  };
}

export function restoreMemory(data) {
  const m = createMemory();
  if (!data || typeof data !== 'object') return m;
  m.day = num(data.day, -1);
  m.lastSaid = (data.lastSaid && typeof data.lastSaid === 'object') ? { ...data.lastSaid } : {};
  if (Array.isArray(data.scars)) {
    for (const s of data.scars) {
      if (!s || !KIND[s.kind]) continue;
      m.scars.push({
        kind: s.kind,
        day: num(s.day, 0),
        w: Math.max(0, num(s.w, 0)),
        fid: s.fid || null,
        note: typeof s.note === 'string' ? s.note : '',
      });
    }
  }
  return m;
}

// Сила следа сегодня: накопленный вес, ослабленный временем. Экспонента, а не
// прямая: беда забывается быстро в первые годы и потом долго тлеет — так это и
// устроено у людей.
export function strengthOf(scar, day, healK = 1) {
  const years = Math.max(0, (day - scar.day) / YEAR) * healK;
  return scar.w * Math.pow(0.5, years / HALF_LIFE_YEARS);
}

// Суммарная сила по породе, с потолком из таблицы KIND.
export function forceOf(mem, kind, day, healK = 1) {
  const cap = KIND[kind] ? KIND[kind].cap : 1;
  let sum = 0;
  for (const s of mem.scars) {
    if (s.kind !== kind) continue;
    sum += strengthOf(s, day, healK);
  }
  return Math.min(cap, sum);
}

// ---------- Чтение мира ----------
// Единственное место, где ядро переводится на язык этой связи.

export function memoryState(sim) {
  const day = sim && typeof sim.day === 'number' ? sim.day : 0;
  const pol = (sim && sim.politics && sim.politics.state) || null;
  const stability = pol ? clamp(num(pol.stability, 60), 0, 100) : 60;
  const pop = aliveCount(sim);
  const food = Math.max(0, num(sim && sim.res && sim.res.food, 0));
  // Запас в днях — та же мера, что в link_survival: две оценки сытости
  // разошлись бы, и игрок читал бы в двух панелях разные числа.
  const foodDays = pop > 0 ? food / (pop * 0.7) : Infinity;
  const atWar = Array.isArray(sim && sim.wars) ? sim.wars.length > 0 : false;
  return { day, stability, pop, foodDays, atWar };
}

// Насколько быстро сегодня забывается. Сытость и порядок лечат; беда и смута —
// нет. Это и есть обратная связь: наладил дела — страна отходит быстрее.
export function healRate(st) {
  const fed = clamp((st.foodDays - 6) / 8, 0, 1);
  const calm = clamp((st.stability - 45) / 40, 0, 1);
  return 1 + HEAL_BONUS * Math.min(fed, calm);
}

// ---------- Запись новых шрамов ----------
//
// Модуль НЕ читает текст летописи и не разбирает строки: строка — это то, что
// показывают игроку, и привязываться к её словам значит ломать связь каждый
// раз, когда кто-то поправит формулировку. Вместо этого события приходят
// отдельным списком — их подаёт integrate.js из отчётов других связей.
export function remember(mem, kind, day, opts = {}) {
  if (!KIND[kind]) return mem;
  const w = (opts.weight != null ? opts.weight : KIND[kind].weight) * (opts.scale != null ? opts.scale : 1);
  if (!(w > 0)) return mem;

  // ПАМЯТЬ ХРАНИТ СОБЫТИЯ, А НЕ СОСТОЯНИЯ. Беда длится не один день: мор
  // держится неделями, голодная зима — месяц. Если писать шрам каждые сутки,
  // пока держится причина, память намертво упирается в потолок породы и НЕ
  // ТАЕТ НИКОГДА: свежая запись всё время перебивает затухание старых.
  //
  // Так и вышло на первом прогоне: после лютой зимы «Мор» стоял ровно на своём
  // потолке 1.50 двенадцать лет подряд, в списке скопилось 32 шрама, а
  // «Стужа» рядом честно истаяла с 1.40 до нуля — потому что морозные смерти
  // случались считаные дни, а больные лежали постоянно.
  //
  // Поэтому события одной породы, случившиеся в пределах сезона, — это ОДНА
  // беда. Новая запись не появляется: усиливается существующая, и тоже не
  // безгранично (вдвое против одиночного веса), а день её остаётся первым —
  // забывание считается от начала беды, а не от её последнего дня.
  const recent = lastOf(mem, kind, opts.fid || null);
  if (recent && day - recent.day < MERGE_DAYS) {
    recent.w = Math.min(recent.w + w * MERGE_ADD, KIND[kind].weight * MERGE_CAP);
    return mem;
  }
  mem.scars.push({ kind, day, w, fid: opts.fid || null, note: opts.note || '' });
  return mem;
}

function lastOf(mem, kind, fid) {
  let best = null;
  for (const s of mem.scars) {
    if (s.kind !== kind || (s.fid || null) !== fid) continue;
    if (!best || s.day > best.day) best = s;
  }
  return best;
}

// ---------- Главная функция ----------

export function memoryLinks(sim, incoming = []) {
  const st = memoryState(sim);
  const day = st.day;
  const M = sim && sim.linkMemory ? sim.linkMemory : createMemory();

  const out = {
    mods: {
      stability: 0, happy: 0, eatMult: 1, woodBurnMult: 1,
      estates: { nobles: 0, clergy: 0, merchants: 0, commons: 0, military: 0 },
      relations: {},                 // fid → сдвиг отношений за сутки
    },
    reasons: { stability: [], happy: [], estates: [], other: [] },
    events: [],
    flags: { memory: M, forces: {}, healRate: 1, forgotten: 0 },
  };

  // Один день считается один раз. Повторный вызов в те же сутки не должен
  // записывать шрамы второй раз и не должен двигать одобрение дважды.
  const sameDay = M.day === day;
  const N = { ...M, scars: M.scars.slice(), lastSaid: { ...M.lastSaid } };

  if (!sameDay) {
    N.day = day;
    for (const ev of incoming) {
      if (!ev || !KIND[ev.kind]) continue;
      remember(N, ev.kind, day, ev);
    }
  }

  const healK = healRate(st);
  out.flags.healRate = round2(healK);

  // Забытое выбрасываем: список шрамов не должен расти всю партию.
  if (!sameDay) {
    const before = N.scars.length;
    N.scars = N.scars.filter(s => strengthOf(s, day, healK) >= FORGET_BELOW);
    out.flags.forgotten = before - N.scars.length;
  }

  const F = {
    famine: forceOf(N, 'famine', day, healK),
    frost: forceOf(N, 'frost', day, healK),
    plague: forceOf(N, 'plague', day, healK),
    shame: forceOf(N, 'shame', day, healK),
    triumph: forceOf(N, 'triumph', day, healK),
    betrayal: forceOf(N, 'betrayal', day, healK),
  };
  for (const k of Object.keys(F)) out.flags.forces[k] = round2(F[k]);

  const addS = (v, ru) => { if (Math.abs(v) > 0.0005) { out.mods.stability += v; out.reasons.stability.push({ ru, v: round2(v) }); } };
  const addH = (v, ru) => { if (Math.abs(v) > 0.005) { out.mods.happy += v; out.reasons.happy.push({ ru, v: round2(v) }); } };
  const addE = (fid, v, ru) => { if (Math.abs(v) > 0.0005) { out.mods.estates[fid] += v; out.reasons.estates.push({ fid, ru, v: round2(v) }); } };

  const pol = sim && sim.politics && sim.politics.state;

  // --- Голод: бережливость и недоверие --------------------------------------
  if (F.famine > 0.01) {
    out.mods.eatMult = 1 - FAMINE_EAT_CUT * Math.min(1, F.famine);
    addS(-FAMINE_STAB * F.famine, 'Народ помнит голод и не верит казне');
    addH(-FAMINE_HAPPY * F.famine, 'Память о голоде');
    out.reasons.other.push({
      ru: `Бережливость: расход еды ниже на ${Math.round((1 - out.mods.eatMult) * 100)}%`,
      v: round2(out.mods.eatMult),
    });
  }

  // --- Стужа: дрова впрок ---------------------------------------------------
  if (F.frost > 0.01) {
    out.mods.woodBurnMult = 1 - FROST_WOOD_CUT * Math.min(1, F.frost);
    addH(-FROST_HAPPY * F.frost, 'Память о студёных зимах');
    out.reasons.other.push({
      ru: `Дрова запасают впрок: горит меньше на ${Math.round((1 - out.mods.woodBurnMult) * 100)}%`,
      v: round2(out.mods.woodBurnMult),
    });
  }

  // --- Мор: народ идёт к жрецам --------------------------------------------
  if (F.plague > 0.01) {
    const cur = pol && typeof pol.factions.clergy === 'number' ? pol.factions.clergy : 50;
    // Потолок: вера поднимает духовенство до предела и не выше — иначе один
    // давний мор навсегда делал бы жрецов сильнейшим сословием.
    if (cur < PLAGUE_CLERGY_CAP) addE('clergy', PLAGUE_CLERGY * F.plague, 'Народ помнит мор и держится храма');
    addH(-PLAGUE_HAPPY * F.plague, 'Память о море');
  }

  // --- Позор: военные требуют похода ---------------------------------------
  if (F.shame > 0.01) {
    addS(-SHAME_STAB * F.shame, 'Позор потерянной провинции ещё не смыт');
    if (st.atWar) addE('military', SHAME_MIL_WAR * F.shame, 'Военные видят случай смыть позор');
    else addE('military', -SHAME_MIL_PEACE * F.shame, 'Военные не простили потери провинции');
  }

  // --- Гордость: единственная прибавка -------------------------------------
  if (F.triumph > 0.01 && st.stability < PRIDE_STAB_CEILING) {
    addS(PRIDE_STAB * F.triumph, 'Народ помнит победы');
    addH(PRIDE_HAPPY * F.triumph, 'Гордость за прошлые победы');
    addE('military', 0.06 * F.triumph, 'Военные помнят славу');
  }

  // --- Предательство: этому соседу не верят --------------------------------
  if (F.betrayal > 0.01) {
    // Тяга поимённая: помним не «соседей вообще», а того, кто ударил в спину.
    const byFid = new Map();
    for (const s of N.scars) {
      if (s.kind !== 'betrayal' || !s.fid) continue;
      byFid.set(s.fid, (byFid.get(s.fid) || 0) + strengthOf(s, day, healK));
    }
    for (const [fid, f] of byFid) {
      const rel = relOf(sim, fid);
      // Пол: ниже него память уже не давит, дальше портить отношения должны
      // поступки, а не воспоминание. Без пола любой давний удар в спину
      // означал бы вечную войну без всякой возможности помириться.
      if (rel <= BETRAYAL_REL_FLOOR) continue;
      out.mods.relations[fid] = -BETRAYAL_REL * Math.min(1.5, f);
    }
  }

  // --- Слова: игрок должен прочитать, что именно помнит его народ -----------
  if (!sameDay) {
    for (const kind of Object.keys(KIND)) {
      const f = F[kind];
      if (f < 0.5) continue;                                  // слабый след молчит
      if (day - (N.lastSaid[kind] || -9999) < YEAR * 2) continue;  // не чаще раза в два года
      N.lastSaid[kind] = day;
      out.events.push({ text: sayFor(kind, f), type: kind === 'triumph' ? 'good' : 'warn' });
    }
  }

  out.flags.memory = N;
  return out;
}

function sayFor(kind, f) {
  const strong = f >= 1.0;
  switch (kind) {
    case 'famine': return strong
      ? '📜 Старики всё ещё считают мешки: голод не забыт. Едят скупо, казне не верят.'
      : '📜 О голодных годах ещё помнят — зерно берегут.';
    case 'frost': return '📜 Память о студёных зимах: дрова запасают вдвое против нужды.';
    case 'plague': return '📜 После мора храмы полны: народ ищет заступничества.';
    case 'shame': return strong
      ? '📜 Потерю провинции не простили. Военные ждут похода, чтобы смыть позор.'
      : '📜 О потерянной земле ещё говорят вполголоса.';
    case 'triumph': return '📜 Победы отцов помнят: держава держится этой памятью.';
    case 'betrayal': return '📜 Удар в спину не забыт — этому соседу веры нет.';
    default: return '📜 Летопись помнит.';
  }
}

// ---------- Для ядра и HUD ----------

// Множитель расхода еды. Ядро умножает на него дневную потребность.
export function memoryEatMult(sim) {
  const L = sim && sim.sys && sim.sys.memLinks;
  return L ? L.mods.eatMult : 1;
}

// Множитель сжигаемых дров. Зима умножает на него свой расход.
export function memoryWoodMult(sim) {
  const L = sim && sim.sys && sim.sys.memLinks;
  return L ? L.mods.woodBurnMult : 1;
}

export function memoryHappyMod(sim) {
  const L = sim && sim.sys && sim.sys.memLinks;
  return L ? L.mods.happy : 0;
}

// Готовые строки для панели «Летопись»: что помнит народ и во что это обходится.
// Память НЕ двигает — звать из рендера безопасно.
export function memoryBreakdown(sim) {
  const M = sim && sim.linkMemory ? sim.linkMemory : createMemory();
  const st = memoryState(sim);
  const healK = healRate(st);
  const rows = [];
  for (const kind of Object.keys(KIND)) {
    const f = forceOf(M, kind, st.day, healK);
    if (f < 0.02) continue;
    rows.push({
      kind, ru: KIND[kind].ru, v: round2(f),
      // Сколько лет назад случилось последнее событие этой породы: игрок
      // должен видеть не только «помнят», но и «насколько давно».
      years: round2(yearsSinceLast(M, kind, st.day)),
      text: sayFor(kind, f),
    });
  }
  rows.sort((a, b) => b.v - a.v);
  const text = rows.length
    ? rows.map(r => `${r.ru} ${r.v.toFixed(2)}`).join(', ')
    : 'Народ не помнит ни бед, ни побед — летопись пуста.';
  return { rows, text, healRate: round2(healK) };
}

function yearsSinceLast(mem, kind, day) {
  let last = null;
  for (const s of mem.scars) if (s.kind === kind && (last === null || s.day > last)) last = s.day;
  return last === null ? 0 : (day - last) / YEAR;
}

// ---------- Мелочи ----------

function relOf(sim, fid) {
  if (!sim || !sim.relations) return 0;
  const r = sim.relations[fid];
  return typeof r === 'number' ? r : (r && typeof r.v === 'number' ? r.v : 0);
}

function aliveCount(sim) {
  const list = sim && sim.villagers;
  if (!Array.isArray(list)) return 0;
  let n = 0;
  for (const v of list) if (!v || v.hp === undefined || v.hp > 0) n++;
  return n;
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function num(v, def) { return Number.isFinite(v) ? v : def; }
function round2(v) { return Math.round(v * 100) / 100; }

/* ПОДКЛЮЧЕНИЕ ─────────────────────────────────────────────────────────────────

Правки в app/src/core/systems/integrate.js плюс две строки в simulation.js и
одна в winter.js — там, где память обязана дотянуться до расхода.

1) ИМПОРТ и ПАМЯТЬ в installSystems():
     import * as MEM from './link_memory.js';
     sim.linkMemory = MEM.createMemory();

2) ДЕНЬ. Вызывать ПОСЛЕДНЕЙ из всех связей: она собирает события, которые
   породили остальные, и записывает их в летопись за те же сутки.
     applyMemoryLinks(sim, harvest);
   где harvest — список {kind, fid?, scale?}, собранный из отчётов других связей.

3) РАСХОД ЕДЫ. simulation.js, строка расчёта eat:
     const eat = pop * EAT_PER_DAY * (this.weather === 'snow' ? 1.25 : 1);
   домножить на memoryEatMult(this).

4) ДРОВА. integrate.js, tickWinterFor: rep.burned домножается на
   MEM.memoryWoodMult(sim) перед списанием.

5) СЧАСТЬЕ: + MEM.memoryHappyMod(sim) в systemsHappyMod.

6) СЕЙВ: mem: sim.linkMemory / sim.linkMemory = MEM.restoreMemory(data.mem).

────────────────────────────────────────────────────────────────────────────── */
