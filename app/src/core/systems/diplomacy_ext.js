// core/systems/diplomacy_ext.js — надстройка дипломатии (U26–U28).
// Право прохода и casus belli (U26), союзы и совместные войны (U27),
// осознанный обмен технологиями (U28). Civilization + EU4.
//
// Чистый модуль: ни одной ссылки на Simulation, ни одного обращения к DOM.
// Всё состояние — простой JSON-объект, вся случайность — только через ctx.rng.
//
// ЧТО ЗДЕСЬ ЧЬЁ. Отношения «игрок ↔ фракция» живут в ядре (sim.relations) и
// остаются его собственностью: модуль их НЕ пишет, а возвращает дельты в
// out.playerRel, которые ядро проводит своим adjustRel. Отношения
// «фракция ↔ фракция» ядру неизвестны вовсе — эту матрицу ведёт модуль
// (state.rel) и сам держит её в [-100, 100]. Двух источников правды на одну
// величину нет нигде: иначе сейв и HUD показывали бы разные числа.
//
// ═══════════════ INTEGRATION ═══════════════
// В simulation.js (файл я НЕ редактировал — вставку делает интегратор):
//
// 1) import {
//      createDiplomacy, tickDiplomacy, applyPlayerRel, serializeDiplomacy,
//      deserializeDiplomacy, grantPassage, revokePassage, hasPassage,
//      warLegitimacy, consumeCasusBelli, openWar, closeWar, isAllied,
//      formAlliance, breakAlliance, answerCall, buildTechOffer, applyTechTrade,
//      trespassScan, attritionMult, passageList, allianceList, warStats,
//    } from './systems/diplomacy_ext.js';
//
// 2) В конструкторе Simulation, ПОСЛЕ this.spawnFactions():
//      this.diplo = createDiplomacy();
//
// 3) В onNewDay(), после tickFactions() (границы к этому моменту уже посчитаны
//    модулем borders — из них берётся нарушение рубежей):
//
//      const armies = [];
//      // Рейдовый отряд по определению идёт по земле игрока: пока он в пути,
//      // фракция нарушает рубеж, и это ровно то, что карает U26.
//      if (this.raids.warning && this.raids.from) {
//        const camp = this.buildings.find(b => b.id === 'campfire' && !b.destroyed);
//        if (camp) armies.push({ side: this.raids.from, x: camp.x, y: camp.y });
//      }
//      const out = tickDiplomacy(this.diplo, {
//        day: this.day, rng: this.rng, difficulty: this.difficulty,
//        factions: this.factions, relations: this.relations,
//        playerWars: this.wars.map(w => w.fid), treaties: this.treaties,
//        player: { armyPower: this.armyPower(), era: this.eraIndex,
//                  techs: this.techs, gold: this.res.gold },
//        trespass: trespassScan(this.diplo, this.borders, armies, { day: this.day }),
//      });
//      applyPlayerRel(this.relations, out.playerRel, (fid, dR, why) => this.adjustRel(fid, dR, why));
//      for (const t of out.logs) this.addLog(t);
//      for (const w of out.warsOpened) if (w.a !== 'player' && w.b !== 'player')
//        this.aiWars.push({ a: w.a, b: w.b, ws: 0 });
//      for (const w of out.warsEnded) {
//        if (w.a === 'player' || w.b === 'player') this.endWar(w.a === 'player' ? w.b : w.a, true);
//        else this.aiWars = this.aiWars.filter(x => !((x.a === w.a && x.b === w.b) || (x.a === w.b && x.b === w.a)));
//      }
//      // Призывы к оружию и предложения — в окно события (out.calls, out.offers).
//      // Ответ игрока: answerCall(this.diplo, call.id, accept, { day: this.day,
//      //   relations: this.relations }) — вернёт playerRel, logs и joinWar
//      //   (по нему ядро объявляет войну через свой declareWar/wars.push).
//      // Обмен технологиями: applyTechTrade(this.diplo, ctx, offer, this.day) —
//      //   вернёт playerTech (выдать через this.techs.add) и factionTechDelta
//      //   (f.techCount += delta).
//
// 4) U26 в diploAction('war'): вместо строки
//        const hasCB = this.wars.length || this.relations[fid] <= -40;
//    поставить
//        const cb = warLegitimacy(this.diplo, 'player', fid, this.day);
//        const hasCB = cb.legal || this.wars.length || this.relations[fid] <= -40;
//        if (cb.legal) consumeCasusBelli(this.diplo, 'player', fid, this.day);
//    и добавить cb.ru в лог: игрок должен видеть, каким поводом воспользовался.
//    Симметрично declareWarOnPlayer(f) зовёт
//        openWar(this.diplo, f.id, 'player', this.day, 'ядро')
//    а endWar(fid) — closeWar(this.diplo, fid, 'player', this.day, 'договор').
//    (Даже без этих двух вызовов модуль не рассинхронизируется: список войн
//     игрока он ежедневно сверяет с sim.wars — см. _syncPlayerWars.)
//
// 5) U26 + истощение (borders.js). Урон отряду стороны side в точке (x,y):
//      const own = ownerSide(ownerAt(this.borders, x, y));
//      const dmg = attritionPerDay(this.borders, x, y, side)
//                * attritionMult(this.diplo, side, own, this.day) * dtDays;
//    С правом прохода множитель 0 — марш идёт по договорным путям снабжения;
//    без договора 1; после того как нарушение переросло в casus belli — 1.5:
//    к тому дню местные уже перекрыли дороги и засыпали колодцы.
//
// 6) Сейв: в serialize() — `diplo: serializeDiplomacy(this.diplo)`,
//    в deserialize() — `sim.diplo = deserializeDiplomacy(data.diplo);`
//    Старые сейвы без поля грузятся: получится чистое состояние без договоров.
//
// 7) HUD (hud.js): passageList(state, day) — действующие права прохода,
//    allianceList(state) — союзы, warStats(state, day) — длительности войн для
//    хроники. Все строки уже по-русски.
// ═══════════════════════════════════════════

import { TECHS, FACTIONS, DIPLO_FACTORS } from '../data.js';
import { ownerAt, ownerSide } from './borders.js';

// ---------- Настройки (экспортируются: на них опирается тест) ----------

export const REL_MIN = -100;
export const REL_MAX = 100;

// U26. Право прохода даётся на срок: бессрочный пропуск чужой армии по своей
// земле — это уже не договор, а капитуляция.
export const PASSAGE_DAYS = 120;
// Сколько дней вторжения прощается, прежде чем оно станет поводом к войне.
// Ноль был бы издевательством: заблудившийся разъезд — ещё не вторжение.
export const TRESPASS_GRACE = 3;
export const TRESPASS_REL_PER_DAY = -0.5; // пока чужие сапоги на земле
export const TRESPASS_CB_REL = -8;        // разово, когда терпение кончилось
export const TRESPASS_FORGET = 20;        // за столько дней нарушение забывается

// Casus belli живёт ограниченно: припомнить соседу поход десятилетней давности
// нельзя — законным поводом это уже не считает никто.
export const CB_LIFETIME = 240;

// U27. Союз возможен только с настоящим другом, распадается ниже второго
// порога: гистерезис, иначе союз мигал бы каждый день у отметки 45.
export const ALLY_MIN_REL = 45;
export const ALLY_BREAK_REL = 10;
export const ALLY_UTILITY = 0.35;         // порог полезности союза для ИИ
export const CALL_TTL = 10;               // дней на ответ по призыву к оружию
export const CALL_REFUSE_REL = -25;       // отказ портит отношения с зовущим
export const CALL_ACCEPT_ENEMY_REL = -35; // согласие — с его противником
export const JOINT_WAR_REL = DIPLO_FACTORS.jointWar.dR; // +15 за общую войну

// Войны кончаются всегда. Усталость копится каждый день, при 100 стороны
// подписывают белый мир; жёсткий потолок в днях страхует от любых комбинаций
// черт — «вечная война» невозможна конструктивно, а не по везению.
export const WAR_MAX_DAYS = 360;
export const TRUCE_DAYS = 60;             // перемирие после мира
// Запас терпения конкретной войны разыгрывается при её первом тике: короткая
// пограничная свара и затяжная кампания должны выглядеть по-разному.
export const WEARY_MIN = 45;
export const WEARY_MAX = 170;

// U28. Технологиями меняются только с теми, кому доверяют.
export const TECH_TRADE_MIN_REL = 30;
export const TECH_TRADE_COOLDOWN = 30;

// Трение границ: чем ближе чужие поселения, тем хуже отношения — и тем скорее
// появится повод к войне. Дистанция считается по видимым поселениям.
export const FRICTION_RANGE = 22;
export const FRICTION_PER_TILE = 1.8;
export const CLAIM_RANGE = 24;            // дальность, на которой сосед вообще интересен
export const RIVAL_RATIO = 1.4;           // во столько раз сильнее — и объявляет соперником

const DECISION_PERIOD = 5;                // ИИ думает раз в 5 дней
// Смещение фаз: ядро крутит свой utilityAI на day % 5 === 0, и совпадать с ним
// нельзя — игрок получал бы по два окна дипломатии в один день.
const AI_WAR_PHASE = 2;
const AI_PACT_PHASE = 3;
const AI_TRADE_PHASE = 4;

const TECH_BY_ID = Object.fromEntries(TECHS.map((t, i) => [t.id, { ...t, idx: i }]));
const FACTION_BY_ID = Object.fromEntries(FACTIONS.map(f => [f.id, f]));

// Категория технологии решает, кто как её ценит. Военные переплачивают за
// оружие и жадничают, отдавая его; торговцы — за экономику, и так далее.
const TECH_CATEGORY = (() => {
  const map = {};
  const put = (ids, cat) => { for (const id of ids) map[id] = cat; };
  put(['warfare', 'iron', 'steel_tech', 'castles', 'gunpowder', 'industrialization', 'robotics', 'rocketry', 'nuclear'], 'war');
  put(['trade', 'currency', 'banking', 'guilds', 'economics', 'corporations', 'sailing', 'navigation'], 'gold');
  put(['writing', 'philosophy', 'mathematics', 'education', 'printing', 'optics', 'chemistry', 'computing', 'internet', 'quantum', 'ai'], 'science');
  put(['theology', 'aesthetics', 'laws'], 'faith');
  return map;
})();

// ---------- Ключи и состояние ----------

// Симметричные сущности (война, союз, отношения ИИ-ИИ) хранятся под
// отсортированным ключом: 'wolves|guild' и 'guild|wolves' — одна пара.
export function pairKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }
// Направленные (право прохода, нарушение рубежа): кто идёт по чьей земле.
export function dirKey(who, whose) { return `${who}>${whose}`; }

export function clampRel(v) {
  if (!Number.isFinite(v)) return 0; // NaN в отношениях — тихая порча сейва
  return v < REL_MIN ? REL_MIN : v > REL_MAX ? REL_MAX : v;
}

export function createDiplomacy() {
  return {
    v: 1,
    rel: {},        // 'a|b' -> отношения между двумя ИИ-фракциями
    passage: {},    // 'кто>чья земля' -> { since, until }
    trespass: {},   // 'кто>чья земля' -> { days, lastDay, cbDay }
    cb: [],         // [{ holder, target, kind, day }] — казусы белли
    alliances: [],  // [{ a, b, since }]
    calls: [],      // [{ id, caller, target, enemy, day, expires }]
    wars: [],       // [{ a, b, start, cause, weary }]
    truce: {},      // 'a|b' -> день, до которого война запрещена
    prox: {},       // 'a|b' -> расстояние между ближайшими поселениями
    history: [],    // завершённые войны [{ a, b, start, end, days, reason }]
    trades: [],     // совершённые обмены технологиями
    nextId: 1,
    lastDay: -1,
  };
}

export function serializeDiplomacy(state) {
  // История войн растёт вечно — в сейв идёт только хвост: остальное нужно
  // лишь статистике текущей сессии.
  return {
    v: 1, rel: state.rel, passage: state.passage, trespass: state.trespass,
    cb: state.cb, alliances: state.alliances, calls: state.calls, wars: state.wars,
    truce: state.truce, prox: state.prox,
    history: state.history.slice(-100), trades: state.trades.slice(-40),
    nextId: state.nextId, lastDay: state.lastDay,
  };
}

export function deserializeDiplomacy(data) {
  const s = createDiplomacy();
  if (!data) return s;
  s.rel = data.rel || {}; s.passage = data.passage || {}; s.trespass = data.trespass || {};
  s.cb = data.cb || []; s.alliances = data.alliances || []; s.calls = data.calls || [];
  s.wars = data.wars || []; s.truce = data.truce || {}; s.prox = data.prox || {};
  s.history = data.history || []; s.trades = data.trades || [];
  s.nextId = data.nextId || 1; s.lastDay = data.lastDay ?? -1;
  for (const k of Object.keys(s.rel)) s.rel[k] = clampRel(s.rel[k]);
  return s;
}

// ---------- Отношения ----------

export function aiRel(state, a, b) { return state.rel[pairKey(a, b)] || 0; }

export function adjustAiRel(state, a, b, dR) {
  const k = pairKey(a, b);
  state.rel[k] = clampRel((state.rel[k] || 0) + dR);
  return state.rel[k];
}

// Проведение дельт по игроку. Если ядро передало свой adjustRel — зовём его
// (там лог и затухающие факторы), иначе правим карту сами, но с тем же клампом.
export function applyPlayerRel(relations, deltas, adjust) {
  for (const d of deltas || []) {
    if (adjust) adjust(d.fid, d.dR, d.why);
    else relations[d.fid] = clampRel((relations[d.fid] || 0) + d.dR);
  }
  return relations;
}

// Отношения к стороне независимо от того, игрок это или фракция.
function relTo(state, ctx, a, b) {
  if (a === 'player') return clampRel(((ctx.relations || {})[b]) || 0);
  if (b === 'player') return clampRel(((ctx.relations || {})[a]) || 0);
  return aiRel(state, a, b);
}

// ---------- U26. Право прохода ----------

export function grantPassage(state, who, whose, day, days = PASSAGE_DAYS) {
  if (who === whose) return { ok: false, reason: 'Своя земля и так открыта' };
  state.passage[dirKey(who, whose)] = { since: day, until: day + days };
  // Договор снимает накопленное раздражение: рубеж больше не нарушают.
  delete state.trespass[dirKey(who, whose)];
  return { ok: true, until: day + days };
}

export function revokePassage(state, who, whose) {
  delete state.passage[dirKey(who, whose)];
  return { ok: true };
}

export function hasPassage(state, who, whose, day) {
  const p = state.passage[dirKey(who, whose)];
  return !!p && p.until > day;
}

// Право прохода даёт и союз: у союзников границы открыты по умолчанию.
export function mayEnter(state, who, whose, day) {
  return hasPassage(state, who, whose, day) || isAllied(state, who, whose);
}

export function passageList(state, day) {
  const out = [];
  for (const [k, p] of Object.entries(state.passage)) {
    if (p.until <= day) continue;
    const [who, whose] = k.split('>');
    out.push({
      who, whose, until: p.until, daysLeft: p.until - day,
      ru: `${sideName(who)} → земли ${sideName(whose)}: ещё ${p.until - day} дн.`,
    });
  }
  return out;
}

// Множитель истощения из borders.js. Договор превращает вторжение в марш по
// дружественной территории (снабжение хозяина, урона нет); нарушение после
// объявленного повода — наоборот, дороже обычного.
export function attritionMult(state, who, whose, day) {
  if (!whose || who === whose) return 1;
  if (mayEnter(state, who, whose, day)) return 0;
  const t = state.trespass[dirKey(who, whose)];
  return (t && t.cbDay >= 0) ? 1.5 : 1;
}

// Кто на чьей земле стоит. armies: [{ side, x, y }] в клеточных координатах.
// Отдаёт только настоящие нарушения — свои и ничьи клетки отсеиваются.
export function trespassScan(state, borders, armies, ctx = {}) {
  const day = ctx.day || 0;
  const out = [];
  if (!borders || !armies) return out;
  for (const a of armies) {
    const owner = ownerSide(ownerAt(borders, a.x, a.y));
    if (!owner || owner === a.side) continue;
    out.push({
      intruder: a.side, owner, x: a.x, y: a.y,
      legal: mayEnter(state, a.side, owner, day),
      attrition: attritionMult(state, a.side, owner, day),
    });
  }
  return out;
}

// ---------- U26. Casus belli ----------

export const CB_RU = {
  trespass: 'нарушение рубежей',
  border: 'давление на границе',
  claim: 'притязания на земли',
  rivalry: 'объявленное соперничество',
  raid: 'разорение земель',
  ally: 'долг союзника',
  broken: 'разрыв союза',
};

export function addCasusBelli(state, holder, target, kind, day) {
  // Повторный повод той же природы не копится: два нарушения рубежа — всё ещё
  // одно нарушение рубежа, а не двойное право на войну.
  const same = state.cb.find(c => c.holder === holder && c.target === target && c.kind === kind);
  if (same) { same.day = day; return same; }
  const c = { holder, target, kind, day };
  state.cb.push(c);
  return c;
}

export function casusBelliList(state, holder, target, day) {
  return state.cb.filter(c => c.holder === holder && c.target === target && day - c.day < CB_LIFETIME);
}

export function hasCasusBelli(state, holder, target, day) {
  return casusBelliList(state, holder, target, day).length > 0;
}

// То, что ядро подставляет вместо своей проверки hasCB.
export function warLegitimacy(state, holder, target, day) {
  const list = casusBelliList(state, holder, target, day);
  if (!list.length) return { legal: false, kind: null, ru: 'война без повода' };
  const c = list[0];
  return { legal: true, kind: c.kind, ru: `законный повод: ${CB_RU[c.kind] || c.kind}` };
}

// Повод одноразовый: использовал — потерял. Иначе одно нарушение рубежа
// оправдывало бы все войны следующих двухсот дней.
export function consumeCasusBelli(state, holder, target, day) {
  const list = casusBelliList(state, holder, target, day);
  if (!list.length) return null;
  const c = list[0];
  state.cb = state.cb.filter(x => x !== c);
  return c;
}

// ---------- U27. Союзы ----------

export function isAllied(state, a, b) {
  const k = pairKey(a, b);
  return state.alliances.some(al => pairKey(al.a, al.b) === k);
}

export function alliesOf(state, side) {
  const out = [];
  for (const al of state.alliances) {
    if (al.a === side) out.push(al.b);
    else if (al.b === side) out.push(al.a);
  }
  return out;
}

export function formAlliance(state, a, b, day) {
  if (a === b || isAllied(state, a, b)) return { ok: false, reason: 'Союз уже есть' };
  if (isAtWar(state, a, b)) return { ok: false, reason: 'Идёт война' };
  state.alliances.push({ a, b, since: day });
  return { ok: true };
}

export function breakAlliance(state, a, b, day) {
  const k = pairKey(a, b);
  const before = state.alliances.length;
  state.alliances = state.alliances.filter(al => pairKey(al.a, al.b) !== k);
  if (state.alliances.length === before) return { ok: false, reason: 'Союза нет' };
  // Предательство помнят: разрыв — законный повод для брошенной стороны.
  addCasusBelli(state, b, a, 'broken', day);
  return { ok: true };
}

export function allianceList(state) {
  return state.alliances.map(al => ({
    a: al.a, b: al.b, since: al.since, ru: `${sideName(al.a)} и ${sideName(al.b)}`,
  }));
}

// Оценка предложения союза глазами фракции f. Только видимое: черты (они
// публичны — это агенда), текущие отношения, оценка армий с шумом, общий враг.
export function evaluateAllianceOffer(state, f, other, ctx) {
  const tr = traitsOf(f);
  if (!tr) return 0;
  const R = relTo(state, ctx, f.id, other);
  if (R < ALLY_MIN_REL) return 0;
  const mine = Math.max(1, f.armyPts || 1);
  const theirs = Math.max(1, estimateArmy(ctx, other));
  let u = 0.5 * (R / 100);
  u += 0.25 * (tr.defense / 10);            // осторожные ищут щит
  u -= 0.20 * (tr.aggression / 10);         // задиры не любят обязательств
  u += 0.10 * Math.min(1.5, theirs / mine); // сильный союзник ценнее слабого
  // Общий враг — главный клей союзов: в EU4 это половина всей дипломатии.
  const foes = warEnemies(state, f.id), theirFoes = warEnemies(state, other);
  if (foes.length && foes.some(x => theirFoes.includes(x))) u += 0.3;
  return u;
}

// ---------- U27. Призывы к оружию ----------

export function callToArms(state, caller, target, enemy, day) {
  if (!isAllied(state, caller, target)) return null;
  const dup = state.calls.find(c => c.caller === caller && c.target === target && c.enemy === enemy);
  if (dup) return dup;
  const call = { id: state.nextId++, caller, target, enemy, day, expires: day + CALL_TTL };
  state.calls.push(call);
  return call;
}

export function pendingCallsFor(state, side) {
  return state.calls.filter(c => c.target === side);
}

// Ответ на призыв. Отказ портит отношения с зовущим, согласие — с его
// противником: цена есть у обоих решений, поэтому выбор действительно выбор.
export function answerCall(state, callId, accept, ctx = {}) {
  const call = state.calls.find(c => c.id === callId);
  const res = { ok: false, playerRel: [], logs: [], joinWar: null, brokeAlliance: false };
  if (!call) { res.reason = 'Призыв уже неактуален'; return res; }
  state.calls = state.calls.filter(c => c !== call);
  const day = ctx.day || 0;
  res.ok = true;
  if (accept) {
    openWar(state, call.target, call.enemy, day, 'ally');
    res.joinWar = { side: call.target, enemy: call.enemy };
    _relPair(state, res.playerRel, call.target, call.caller, JOINT_WAR_REL, 'Совместная война');
    _relPair(state, res.playerRel, call.target, call.enemy, CALL_ACCEPT_ENEMY_REL, 'Вступление в войну против нас');
    res.logs.push(`${sideName(call.target)} отвечает на призыв ${sideName(call.caller)}: война против ${sideName(call.enemy)}.`);
  } else {
    _relPair(state, res.playerRel, call.target, call.caller, CALL_REFUSE_REL, 'Отказ союзнику');
    // Считаем по уже известной величине плюс наша дельта: ядро проведёт её
    // позже, а решать о судьбе союза надо сейчас.
    const after = relTo(state, ctx, call.target, call.caller) + CALL_REFUSE_REL;
    if (after < ALLY_BREAK_REL) {
      breakAlliance(state, call.caller, call.target, day);
      res.brokeAlliance = true;
      res.logs.push(`Союз ${sideName(call.caller)} и ${sideName(call.target)} распался: на призыв не ответили.`);
    } else {
      res.logs.push(`${sideName(call.target)} уклонился от призыва ${sideName(call.caller)}.`);
    }
  }
  return res;
}

// ---------- Войны ----------

export function isAtWar(state, a, b) {
  const k = pairKey(a, b);
  return state.wars.some(w => pairKey(w.a, w.b) === k);
}

export function warEnemies(state, side) {
  const out = [];
  for (const w of state.wars) {
    if (w.a === side) out.push(w.b);
    else if (w.b === side) out.push(w.a);
  }
  return out;
}

export function openWar(state, a, b, day, cause = null) {
  if (a === b || isAtWar(state, a, b)) return null;
  const w = { a, b, start: day, cause, weary: 0 };
  state.wars.push(w);
  // Война рвёт союз воюющих: нельзя быть союзником и противником разом.
  if (isAllied(state, a, b)) breakAlliance(state, a, b, day);
  return w;
}

export function closeWar(state, a, b, day, reason = 'мир') {
  const k = pairKey(a, b);
  const w = state.wars.find(x => pairKey(x.a, x.b) === k);
  if (!w) return null;
  state.wars = state.wars.filter(x => x !== w);
  state.truce[k] = day + TRUCE_DAYS;
  const rec = { a: w.a, b: w.b, start: w.start, end: day, days: Math.max(1, day - w.start), reason };
  state.history.push(rec);
  return rec;
}

export function inTruce(state, a, b, day) { return (state.truce[pairKey(a, b)] || -1) > day; }

// Длительности завершённых войн — для хроники и для проверки «вечных войн нет».
export function warDurations(state) { return state.history.map(h => h.days); }

export function warStats(state, day = 0) {
  const d = warDurations(state).slice().sort((x, y) => x - y);
  const q = (p) => (d.length ? d[Math.min(d.length - 1, Math.floor(p * d.length))] : 0);
  let longest = 0;
  for (const w of state.wars) longest = Math.max(longest, day - w.start);
  return {
    finished: d.length, min: d[0] || 0, median: q(0.5), p90: q(0.9), max: d[d.length - 1] || 0,
    avg: d.length ? d.reduce((s, x) => s + x, 0) / d.length : 0,
    active: state.wars.length, longestActive: longest,
  };
}

// ---------- U28. Обмен технологиями ----------

// Знания фракции ядро моделирует счётчиком techCount: ей известен префикс
// таблицы TECHS. Отсюда «знает» и «может получить» считаются без выдумок.
export function factionKnows(f, techId) {
  const t = TECH_BY_ID[techId];
  return !!t && t.idx < (f.techCount || 0);
}

export function playerKnows(ctx, techId) {
  const T = ctx.player && ctx.player.techs;
  if (!T) return false;
  return typeof T.has === 'function' ? T.has(techId) : T.indexOf(techId) >= 0;
}

// Ценность технологии для стороны с чертами traits. Стоимость из таблицы —
// объективная база; черты решают, насколько сторона за неё держится.
export function techValueFor(techId, traits) {
  const t = TECH_BY_ID[techId];
  if (!t || !traits) return 0;
  const cat = TECH_CATEGORY[techId];
  let k = 1 + traits.science / 20; // учёные ценят любое знание выше среднего
  if (cat === 'war') k *= 0.6 + traits.aggression / 10;
  else if (cat === 'gold') k *= 0.6 + traits.trade / 10;
  else if (cat === 'science') k *= 0.6 + traits.science / 10;
  else if (cat === 'faith') k *= 0.6 + traits.faith / 10;
  return (t.cost || 20) * k;
}

// Оценка сделки глазами фракции: give — что она отдаёт, take — что получает.
// Отдавать больно тем сильнее, чем военнее технология и чем хуже отношения:
// вооружать завтрашнего противника не хочет никто.
export function evaluateTechTrade(state, ctx, fid, give, take, gold = 0) {
  const f = findFaction(ctx, fid);
  const tr = traitsOf(f) || (FACTION_BY_ID[fid] || {}).traits;
  if (!tr) return { accept: false, gain: 0, reason: 'Фракция недоступна' };
  const R = relTo(state, ctx, fid, 'player');
  const trust = Math.max(0, Math.min(1, (R + 20) / 120));
  const gainSide = take ? techValueFor(take, tr) : 0;
  const cat = give ? TECH_CATEGORY[give] : null;
  const leak = (cat === 'war' ? 1.1 : 0.7) * (1.3 - 0.6 * trust);
  const costSide = give ? techValueFor(give, tr) * leak : 0;
  const goldWorth = gold * (0.5 + tr.trade / 10) * 2;
  const gain = gainSide + goldWorth - costSide;
  return {
    accept: R >= TECH_TRADE_MIN_REL && gain > 0 && !isAtWar(state, fid, 'player'),
    gain, gainSide, costSide, goldWorth, rel: R,
  };
}

// Что фракция готова предложить игроку: свою технологию за ту, которой у неё
// нет. Пара выбирается жадно и только по видимым данным.
export function buildTechOffer(state, ctx, fid) {
  const f = findFaction(ctx, fid);
  if (!f) return null;
  const tr = traitsOf(f);
  if (!tr) return null;
  let give = null, giveV = Infinity;
  let want = null, wantV = 0;
  for (const t of TECHS) {
    const fKnows = factionKnows(f, t.id), pKnows = playerKnows(ctx, t.id);
    if (fKnows && !pKnows) {
      // Отдаёт то, что ей самой дешевле: торгуются излишками, не сокровищами.
      const v = techValueFor(t.id, tr);
      if (v < giveV) { giveV = v; give = t.id; }
    } else if (!fKnows && pKnows) {
      const v = techValueFor(t.id, tr);
      if (v > wantV) { wantV = v; want = t.id; }
    }
  }
  if (!give || !want) return null;
  const ev = evaluateTechTrade(state, ctx, fid, give, want, 0);
  if (!ev.accept) return null;
  return {
    fid, give, want, gold: 0, gain: ev.gain,
    ru: `${sideName(fid)} предлагает обменять «${TECH_BY_ID[give].name}» на «${TECH_BY_ID[want].name}»`,
  };
}

// Проведение обмена. Ядру возвращается, какую технологию выдать игроку и что
// сделать с фракцией: её techCount растёт на 1 — в префиксной модели знаний
// это и означает «усвоила чужое открытие».
export function applyTechTrade(state, ctx, offer, day) {
  if (!offer) return { ok: false, reason: 'Нет предложения' };
  const key = `${offer.fid}:${offer.give}:${offer.want}`;
  const last = state.trades.find(t => t.key === key);
  if (last && day - last.day < TECH_TRADE_COOLDOWN) return { ok: false, reason: 'Такой обмен уже был недавно' };
  const ev = evaluateTechTrade(state, ctx, offer.fid, offer.give, offer.want, offer.gold || 0);
  if (!ev.accept) return { ok: false, reason: 'Фракция отказалась от обмена' };
  state.trades.push({ key, fid: offer.fid, give: offer.give, want: offer.want, day });
  if (state.trades.length > 40) state.trades.shift();
  const dR = 6 + Math.round(Math.min(8, Math.max(0, ev.gain) / 200));
  return {
    ok: true,
    playerTech: offer.give,   // что получает игрок
    factionTech: offer.want,  // что усваивает фракция
    factionTechDelta: 1,      // f.techCount += 1
    playerRel: [{ fid: offer.fid, dR, why: 'Обмен технологиями' }],
    logs: [`Обмен знаниями с ${sideName(offer.fid)}: получена технология «${TECH_BY_ID[offer.give].name}».`],
  };
}

// ---------- Главный тик ----------

// ctx: { day, rng, factions, relations, playerWars, difficulty,
//        player: { armyPower, era, techs, gold }, trespass: [...] }
export function tickDiplomacy(state, ctx) {
  const out = { playerRel: [], logs: [], warsOpened: [], warsEnded: [], offers: [], calls: [] };
  const day = ctx.day || 0;
  if (day === state.lastDay) return out; // тик строго раз в игровой день
  state.lastDay = day;
  const rng = ctx.rng;
  const live = (ctx.factions || []).filter(f => f.alive);

  _syncPlayerWars(state, ctx, out, day);
  _expire(state, day);
  _trespass(state, ctx, out, day);
  _proximity(state, live, day);
  _drift(state, live);
  _wars(state, ctx, out, day, live);
  _calls(state, ctx, out, day);
  if (rng) {
    if (day % DECISION_PERIOD === AI_WAR_PHASE) _aiWarDecisions(state, ctx, out, day, live);
    if (day % DECISION_PERIOD === AI_PACT_PHASE) _aiPacts(state, ctx, out, day, live);
    if (day % DECISION_PERIOD === AI_TRADE_PHASE) _aiTrades(state, ctx, out, day, live);
  }
  return out;
}

// Войны игроку объявляет ядро (declareWarOnPlayer), мир заключает тоже оно.
// Чтобы списки не разошлись, они сверяются каждый день. Днём отсрочки для
// только что открытой войны страхуемся от гонки: ядро применяет out.warsOpened
// уже после возврата из tickDiplomacy.
function _syncPlayerWars(state, ctx, out, day) {
  const now = new Set(ctx.playerWars || []);
  for (const fid of now) {
    if (!isAtWar(state, 'player', fid)) openWar(state, 'player', fid, day, 'ядро');
  }
  for (const w of state.wars.slice()) {
    const other = w.a === 'player' ? w.b : (w.b === 'player' ? w.a : null);
    if (!other || now.has(other) || day - w.start <= 1) continue;
    const rec = closeWar(state, 'player', other, day, 'мир');
    if (rec) out.logs.push(`Война с ${sideName(other)} окончена, ${rec.days} дн.`);
  }
}

function _expire(state, day) {
  for (const [k, p] of Object.entries(state.passage)) if (p.until <= day) delete state.passage[k];
  for (const [k, t] of Object.entries(state.truce)) if (t <= day) delete state.truce[k];
  state.cb = state.cb.filter(c => day - c.day < CB_LIFETIME);
  if (state.history.length > 400) state.history.splice(0, state.history.length - 400);
}

function _trespass(state, ctx, out, day) {
  const seen = new Set();
  for (const e of ctx.trespass || []) {
    const k = dirKey(e.intruder, e.owner);
    seen.add(k);
    if (mayEnter(state, e.intruder, e.owner, day)) continue; // договор — не нарушение
    const rec = state.trespass[k] || (state.trespass[k] = { days: 0, lastDay: day, cbDay: -1 });
    rec.days++; rec.lastDay = day;
    _rel(state, ctx, out, e.owner, e.intruder, TRESPASS_REL_PER_DAY, 'Чужая армия на нашей земле');
    if (rec.days > TRESPASS_GRACE && rec.cbDay < 0) {
      rec.cbDay = day;
      addCasusBelli(state, e.owner, e.intruder, 'trespass', day);
      _rel(state, ctx, out, e.owner, e.intruder, TRESPASS_CB_REL, 'Нарушение рубежей');
      out.logs.push(`Армия ${sideName(e.intruder)} стоит на землях ${sideName(e.owner)} без права прохода — законный повод к войне.`);
    }
  }
  // Ушли — обида тает. Иначе один давний марш висел бы поводом вечно.
  for (const [k, rec] of Object.entries(state.trespass)) {
    if (seen.has(k)) continue;
    if (day - rec.lastDay >= TRESPASS_FORGET) delete state.trespass[k];
  }
}

// Расстояние между ближайшими поселениями пар фракций. Считается раз в
// DECISION_PERIOD: поселения основываются раз в сотни дней, чаще незачем.
function _proximity(state, live, day) {
  if (day % DECISION_PERIOD !== 0 && Object.keys(state.prox).length) return;
  const prox = {};
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const A = live[i].settlements || [], B = live[j].settlements || [];
      let best = Infinity;
      for (const a of A) for (const b of B) {
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < best) best = d;
      }
      if (best < Infinity) prox[pairKey(live[i].id, live[j].id)] = best;
    }
  }
  state.prox = prox;
}

// Медленный дрейф отношений ИИ-ИИ к «естественной» точке: схожесть черт плюс
// трение границ. Без дрейфа матрица стояла бы нулевой — не сложился бы ни один
// союз и не вспыхнула бы ни одна война между фракциями.
function _drift(state, live) {
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i], b = live[j];
      const ta = traitsOf(a), tb = traitsOf(b);
      if (!ta || !tb) continue;
      const k = pairKey(a.id, b.id);
      let base = 30
        + (ta.trade + tb.trade) * 2.2          // торговля мирит
        - (ta.aggression + tb.aggression) * 2.0 // задиры раздражают всех
        - Math.abs(ta.faith - tb.faith) * 1.8   // разная вера разводит
        - (ta.expansion + tb.expansion) * 0.8   // спор за землю
        + (ta.defense + tb.defense) * 0.8;      // «черепахи» никому не угроза
      const d = state.prox[k];
      if (d !== undefined && d < FRICTION_RANGE) base -= (FRICTION_RANGE - d) * FRICTION_PER_TILE;
      base = clampRel(base);
      if (isAtWar(state, a.id, b.id)) base = Math.min(base, -50);
      if (isAllied(state, a.id, b.id)) base = Math.max(base, 55);
      const cur = state.rel[k] || 0;
      state.rel[k] = clampRel(cur < base ? Math.min(base, cur + 0.15) : Math.max(base, cur - 0.15));
    }
  }
}

// Усталость от войны: растёт каждый день тем медленнее, чем агрессивнее
// стороны; при 100 подписывается белый мир. Плюс жёсткий потолок в днях — он
// и есть гарантия, что вечных войн не бывает ни при какой комбинации черт.
function _wars(state, ctx, out, day, live) {
  for (const w of state.wars.slice()) {
    // Свой запас терпения у каждой войны. Общий порог на все войны сразу
    // означал бы, что они кончаются день в день на одной и той же отметке.
    if (w.limit === undefined) w.limit = ctx.rng ? ctx.rng.range(WEARY_MIN, WEARY_MAX) : 100;
    w.weary += (_wearGrowth(ctx, w.a) + _wearGrowth(ctx, w.b)) / 2;
    // Ранний мир по переговорам: силы ещё есть, смысла уже нет.
    const early = w.weary >= w.limit * 0.4 && ctx.rng && ctx.rng.chance(0.012);
    if (w.weary < w.limit && !early && day - w.start < WAR_MAX_DAYS) continue;
    const why = early ? 'переговоры' : (w.weary >= w.limit ? 'истощение' : 'предел');
    // Свою запись модуль закрывает сам, а ядру отдаёт событие: у него свой WS
    // и свои условия мира, и дублировать их здесь нельзя.
    const rec = closeWar(state, w.a, w.b, day, why);
    out.warsEnded.push({ a: w.a, b: w.b, days: rec.days, reason: rec.reason });
    out.logs.push(`Война ${sideName(w.a)} и ${sideName(w.b)} окончена (${rec.reason}), ${rec.days} дн.`);
    if (w.a !== 'player' && w.b !== 'player') adjustAiRel(state, w.a, w.b, 20);
  }
  // Совместная война сближает — раз в 20 дней, иначе месяц общей кампании
  // давал бы +100 и союз «за просто так».
  if (day % 20 !== 0) return;
  for (const f of live) {
    const foes = warEnemies(state, f.id);
    if (!foes.length) continue;
    for (const o of live) {
      if (o.id === f.id || isAtWar(state, f.id, o.id)) continue;
      if (warEnemies(state, o.id).some(x => foes.includes(x))) adjustAiRel(state, f.id, o.id, 0.5);
    }
    if ((ctx.playerWars || []).some(x => foes.includes(x))) {
      _rel(state, ctx, out, 'player', f.id, JOINT_WAR_REL / 5, 'Общий враг');
    }
  }
}

function _wearGrowth(ctx, side) {
  if (side === 'player') return 1.0;
  const tr = traitsOf(findFaction(ctx, side)) || (FACTION_BY_ID[side] || {}).traits;
  if (!tr) return 1.0;
  return 1.2 - (tr.aggression / 10) * 0.5; // 0.75 у самых воинственных
}

function _calls(state, ctx, out, day) {
  for (const c of state.calls.slice()) {
    if (c.expires > day) continue;
    // Молчание — тот же отказ, только без объяснений.
    state.calls = state.calls.filter(x => x !== c);
    _rel(state, ctx, out, c.target, c.caller, CALL_REFUSE_REL, 'Молчание на призыв союзника');
    if (relTo(state, ctx, c.caller, c.target) + CALL_REFUSE_REL < ALLY_BREAK_REL) {
      breakAlliance(state, c.caller, c.target, day);
      out.logs.push(`Союз ${sideName(c.caller)} и ${sideName(c.target)} распался: призыв остался без ответа.`);
    }
  }
  // Призывы игроку выносим наружу — ядро покажет их окном события.
  out.calls = state.calls.filter(c => c.target === 'player');
}

// Решения ИИ о войне. Ничего скрытого: черты (публичная агенда), отношения,
// расстояние до чужих поселений и оценка армий с шумом — ровно то, что видит
// в панели дипломатии и сам игрок.
function _aiWarDecisions(state, ctx, out, day, live) {
  const rng = ctx.rng;
  const noise = ctx.difficulty === 'easy' ? 0.5 : ctx.difficulty === 'hard' ? 0.1 : 0.25;
  for (let i = 0; i < live.length; i++) {
    for (let j = 0; j < live.length; j++) {
      if (i === j) continue;
      const a = live[i], b = live[j];
      if (isAtWar(state, a.id, b.id) || isAllied(state, a.id, b.id)) continue;
      if (inTruce(state, a.id, b.id, day)) continue;
      const tr = traitsOf(a);
      if (!tr) continue;
      const mine = Math.max(1, a.armyPts || 1);
      const theirs = Math.max(1, (b.armyPts || 1) * (1 + rng.range(-noise, noise)));
      // Поводы, которые сторона наживает сама. Экспансионист у чужой межи
      // заявляет притязания, прижатый сосед получает своё «давление на
      // границе», а сильный задира просто объявляет соперничество — всё это
      // публичные вещи, никакого заглядывания в чужие карманы.
      const d = state.prox[pairKey(a.id, b.id)];
      if (d !== undefined && d < CLAIM_RANGE) {
        if (tr.expansion >= 7) addCasusBelli(state, a.id, b.id, 'claim', day);
        else if (d < CLAIM_RANGE / 2) addCasusBelli(state, a.id, b.id, 'border', day);
      }
      if (tr.aggression >= 7 && mine > theirs * RIVAL_RATIO) addCasusBelli(state, a.id, b.id, 'rivalry', day);
      const R = aiRel(state, a.id, b.id);
      const cb = hasCasusBelli(state, a.id, b.id, day);
      // Без повода и без вражды войну не начинают: в этом весь смысл CB.
      if (!cb && R > -35) continue;
      let u = 0.5 * (tr.aggression / 10) - R / 100 - 0.7 * (theirs / mine) + (cb ? 0.35 : 0);
      u -= 0.15 * warEnemies(state, a.id).length; // на два фронта не лезут
      if (u < 0.2 || !rng.chance(Math.min(0.6, u))) continue;
      if (cb) consumeCasusBelli(state, a.id, b.id, day);
      openWar(state, a.id, b.id, day, cb ? 'cb' : 'вражда');
      adjustAiRel(state, a.id, b.id, DIPLO_FACTORS.declaredWar.dR);
      out.warsOpened.push({ a: a.id, b: b.id, cause: cb ? 'cb' : 'вражда' });
      out.logs.push(`${sideName(a.id)} объявляет войну ${sideName(b.id)}${cb ? ' по законному поводу' : ' без повода'}.`);
      // Союзников зовут воевать вместе — это и есть U27 в действии.
      for (const ally of alliesOf(state, a.id)) {
        if (ally === b.id || isAtWar(state, ally, b.id)) continue;
        const call = callToArms(state, a.id, ally, b.id, day);
        if (!call) continue;
        if (ally === 'player') out.logs.push(`${sideName(a.id)} зовёт вас на войну против ${sideName(b.id)}.`);
        else _aiAnswerCall(state, ctx, out, call, day);
      }
    }
  }
}

// Как ИИ отвечает на призыв союзника: верность против трезвого расчёта сил.
function _aiAnswerCall(state, ctx, out, call, day) {
  const f = findFaction(ctx, call.target);
  const tr = traitsOf(f);
  if (!tr) return;
  const R = relTo(state, ctx, call.target, call.caller);
  const mine = Math.max(1, f.armyPts || 1);
  const theirs = Math.max(1, estimateArmy(ctx, call.enemy));
  const u = 0.45 * (R / 100) + 0.35 * (tr.aggression / 10) - 0.5 * (theirs / mine) + 0.2;
  const res = answerCall(state, call.id, u > 0.15, { day, relations: ctx.relations });
  for (const dlt of res.playerRel) out.playerRel.push(dlt);
  for (const t of res.logs) out.logs.push(t);
  if (res.joinWar) out.warsOpened.push({ a: res.joinWar.side, b: res.joinWar.enemy, cause: 'ally' });
}

// Союзы и право прохода: и между ИИ, и предложениями игроку.
function _aiPacts(state, ctx, out, day, live) {
  const rng = ctx.rng;
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i], b = live[j];
      if (isAllied(state, a.id, b.id) || isAtWar(state, a.id, b.id)) continue;
      const ua = evaluateAllianceOffer(state, a, b.id, ctx);
      const ub = evaluateAllianceOffer(state, b, a.id, ctx);
      if (ua <= ALLY_UTILITY || ub <= ALLY_UTILITY || !rng.chance(0.5)) continue;
      formAlliance(state, a.id, b.id, day);
      // Союз автоматически открывает границы — иначе союзники немедленно
      // получили бы друг к другу casus belli за первый же марш.
      grantPassage(state, a.id, b.id, day, PASSAGE_DAYS);
      grantPassage(state, b.id, a.id, day, PASSAGE_DAYS);
      out.logs.push(`${sideName(a.id)} и ${sideName(b.id)} заключили союз.`);
    }
  }
  // Распад союзов по остывшим отношениям — с гистерезисом ALLY_BREAK_REL.
  for (const al of state.alliances.slice()) {
    const withPlayer = al.a === 'player' || al.b === 'player';
    const other = al.a === 'player' ? al.b : al.a;
    const R = withPlayer ? clampRel(((ctx.relations || {})[other]) || 0) : aiRel(state, al.a, al.b);
    if (R >= ALLY_BREAK_REL) continue;
    breakAlliance(state, al.a, al.b, day);
    out.logs.push(withPlayer
      ? `Союз с ${sideName(other)} распался: отношения остыли.`
      : `Союз ${sideName(al.a)} и ${sideName(al.b)} распался.`);
  }
  // Предложения игроку: союз — настоящему другу, право прохода — соседу,
  // с которым отношения хотя бы тёплые.
  for (const f of live) {
    if (isAtWar(state, 'player', f.id)) continue;
    const R = clampRel(((ctx.relations || {})[f.id]) || 0);
    if (R >= ALLY_MIN_REL && !isAllied(state, 'player', f.id) && rng.chance(0.25)) {
      out.offers.push({ kind: 'alliance', fid: f.id, ru: `${sideName(f.id)} предлагает союз.` });
    } else if (R >= 20 && !hasPassage(state, f.id, 'player', day) && rng.chance(0.15)) {
      out.offers.push({ kind: 'passage', fid: f.id, ru: `${sideName(f.id)} просит право прохода через ваши земли.` });
    }
  }
}

// U28: осознанные обмены. С игроком — предложением, между ИИ — сразу сделкой
// (их переговоры игрок видит только строкой в логе).
function _aiTrades(state, ctx, out, day, live) {
  const rng = ctx.rng;
  for (const f of live) {
    if (isAtWar(state, 'player', f.id)) continue;
    if (clampRel(((ctx.relations || {})[f.id]) || 0) < TECH_TRADE_MIN_REL) continue;
    const tr = traitsOf(f);
    if (!tr || !rng.chance(0.1 + tr.science / 100)) continue; // учёные торгуют знанием чаще
    const offer = buildTechOffer(state, ctx, f.id);
    if (offer) out.offers.push({ kind: 'tech', fid: f.id, offer, ru: offer.ru });
  }
  // Между собой фракции меняются, когда дружат: отстающий союзник получает
  // ровно одно открытие — это «диффузия по договору», а не подарок движка.
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i], b = live[j];
      if (isAtWar(state, a.id, b.id)) continue;
      if (aiRel(state, a.id, b.id) < TECH_TRADE_MIN_REL) continue;
      const lag = (a.techCount || 0) - (b.techCount || 0);
      if (Math.abs(lag) < 2 || !rng.chance(0.15)) continue;
      const behind = lag > 0 ? b : a, ahead = lag > 0 ? a : b;
      behind.techCount = (behind.techCount || 0) + 1;
      adjustAiRel(state, a.id, b.id, 3);
      out.logs.push(`${sideName(ahead.id)} делится открытием с ${sideName(behind.id)}.`);
    }
  }
}

// ---------- Вспомогательное ----------

function findFaction(ctx, fid) { return (ctx.factions || []).find(f => f.id === fid) || null; }

// Черты фракции: у объекта ядра они в def, у «голого» id — из таблицы.
function traitsOf(f) {
  if (!f) return null;
  if (f.def && f.def.traits) return f.def.traits;
  const d = FACTION_BY_ID[f.id];
  return d ? d.traits : null;
}

// Оценка чужой армии с шумом: точных чисел ИИ не знает — как и игрок.
function estimateArmy(ctx, side) {
  const noise = ctx.difficulty === 'hard' ? 0.1 : 0.25;
  const base = side === 'player'
    ? ((ctx.player && ctx.player.armyPower) || 0)
    : ((findFaction(ctx, side) || {}).armyPts || 0);
  const k = ctx.rng ? (1 + ctx.rng.range(-noise, noise)) : 1;
  return Math.max(0, base * k);
}

export function sideName(side) {
  if (side === 'player') return 'Ваше поселение';
  const f = FACTION_BY_ID[side];
  return f ? f.name : String(side);
}

// Пары с игроком уходят наружу дельтой (их проводит ядро), пары ИИ-ИИ
// применяются на месте. Клампы стоят на обоих путях.
function _rel(state, ctx, out, a, b, dR, why) {
  _relPair(state, out.playerRel, a, b, dR, why);
}

function _relPair(state, playerRel, a, b, dR, why) {
  if (a === 'player') playerRel.push({ fid: b, dR, why });
  else if (b === 'player') playerRel.push({ fid: a, dR, why });
  else adjustAiRel(state, a, b, dR);
}
