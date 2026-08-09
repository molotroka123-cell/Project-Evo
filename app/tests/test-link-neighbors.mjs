// tests/test-link-neighbors.mjs — проверки связей «соседи ↔ держава»
// (systems/link_neighbors.js). Запуск: node app/tests/test-link-neighbors.mjs
//
// Что здесь важно проверить и почему именно это:
//  * связь тянет в НУЖНУЮ сторону: война рядом делает дороги опаснее, договор
//    приносит золото, сильный сосед — страх, чужая война — беженцев;
//  * у каждой петли есть ПОТОЛОК: опасность не выше RISK_CAP, страх не выше
//    FEAR_CAP, охрана границ не дороже GUARD_CAP, шаг одобрения не больше
//    STEP_CAP, отношения двигаются не быстрее REL_STEP_CAP;
//  * есть ВЫХОД: построил войско — наглость сменилась уважением;
//  * в СПОКОЙНОМ состоянии (соседи далеко, войны нет, договоров нет) нет ни
//    одной поправки — иначе игрок наказан просто за то, что играет;
//  * ЧИСЛА считаются из состояния: расстояние, войско, казна, число войн —
//    проверяем точные значения, а не «функция не упала»;
//  * функция ЧИСТАЯ: sim после вызова байт в байт тот же.
import {
  neighborLinks, neighborReport, neighborBreakdown,
  readNeighbors, routeDanger, fearFrom, greedOf, temptation, ourStrength, proximity,
  NEAR, REACH, RISK_AI_WAR, RISK_OUR_WAR, RISK_CAP, PRICE_PER_RISK,
  TREATY_GOLD, DISCOUNT_EACH, DISCOUNT_CAP, TREATY_REL_FLOOR,
  FEAR_CAP, GUARD_GOLD, GUARD_CAP, GUARD_PER_SOLDIER, BASE_DEFENCE, MILITIA_PER_POP,
  STEP_CAP, STAB_FLOOR, STAB_CALM, HAPPY_FLOOR,
  REFUGEE_PERIOD, REFUGEE_MAX, REFUGEE_KNOW, EAT, REFUGEE_FOOD_DAYS,
  COPY_GAP, COPY_PERIOD, KNOW_CAP, KNOW_FLOW,
  GREED_MIN, GREED_REL, RESPECT_REL, REL_STEP_CAP, ARMY_FLOOR,
} from '../src/core/systems/link_neighbors.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let ok = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { ok++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ─────────────── Поддельный мир ───────────────
// Ровно те поля, которые модуль читает у настоящего Simulation. Соседей задаём
// координатой: расстояние от столицы (50,50) — главный вход всех формул.
const HOME = { startX: 50, startY: 50 };

function mkFaction(o = {}) {
  return {
    id: o.id || 'wolves',
    alive: o.alive !== false,
    def: { name: o.name || 'Волчий Предел', traits: { aggression: 5, expansion: 5, trade: 5, science: 5, faith: 5, defense: 5, ...(o.traits || {}) } },
    P: o.pop ?? 40,
    armyPts: o.army ?? 0,
    techCount: o.techs ?? 5,
    era: o.era ?? 0,
    settlements: [{ x: 50 + (o.dist ?? 40), y: 50 }],
  };
}

function makeSim(o = {}) {
  const facs = (o.factions || []).map(mkFaction);
  const relations = {};
  for (const f of facs) relations[f.id] = 0;
  Object.assign(relations, o.relations || {});
  const pop = o.pop ?? 10;
  return {
    day: o.day ?? 1,
    eraIndex: o.eraIndex ?? 0,
    res: { gold: o.gold ?? 100, food: o.food ?? 500, knowledge: 0 },
    world: { ...HOME, w: 128, h: 128 },
    villagers: new Array(pop).fill(0).map((_, i) => ({ name: 'v' + i })),
    army: { soldiers: o.soldiers ?? 0 },
    techs: new Set(o.ourTechs || ['fire', 'tools', 'farming', 'pottery', 'writing']),
    factions: facs,
    relations,
    treaties: (o.treaties || []).map(fid => ({ b: fid, type: 'trade' })),
    wars: (o.warsWithUs || []).map(fid => ({ fid, ws: 0 })),
    diplo: { wars: o.aiWars || [] },
    faction: (fid) => facs.find(f => f.id === fid) || null,
    armyPower: () => o.armyPower ?? 0,
    defensePower: () => o.walls ?? 0,
    wealth: () => o.wealth ?? 0,
    housingCap: () => o.housing ?? 40,
    countBuilding: (id) => (id === 'market' ? (o.markets ?? 0) : 0),
    globalMult: () => 1,
    politics: {
      state: {
        factions: { nobles: 55, clergy: 55, merchants: 55, commons: 55, military: 55, ...(o.approval || {}) },
        stability: o.stability ?? 60,
      },
    },
  };
}
const L = (o) => neighborLinks(makeSim(o));

// ─────────────── 1. Спокойное состояние ───────────────
console.log('\n--- Спокойное состояние: поправок нет ---');
{
  const q = L({ factions: [{ id: 'grove', dist: 40, army: 20 }] });
  t('спокойно: золото не тронуто', q.mods.gold === 0, String(q.mods.gold));
  t('спокойно: знание не тронуто', q.mods.knowledge === 0, String(q.mods.knowledge));
  t('спокойно: счастье и стабильность нули',
    q.mods.happy === 0 && q.mods.stability === 0, `${q.mods.happy} / ${q.mods.stability}`);
  t('спокойно: ни одно сословие не сдвинуто',
    Object.values(q.mods.approval).every(v => v === 0), JSON.stringify(q.mods.approval));
  t('спокойно: отношения не двигаются, журнал молчит, флаг quiet',
    q.flags.relations.length === 0 && q.events.length === 0 && q.flags.quiet === true);
  t('спокойно: цены и караваны нетронуты',
    q.mods.priceMult === 1 && q.mods.caravanMult === 1 && q.mods.routeRisk === 0);
  // Мир без соседей вообще — тоже спокойствие, а не падение.
  const empty = neighborLinks({ day: 5, factions: [], res: { gold: 0 } });
  t('мир без соседей: пустой отчёт, quiet', empty.flags.quiet === true && empty.mods.gold === 0);
}

// ─────────────── 2. Близость решает всё ───────────────
console.log('\n--- Расстояние: близость решает ---');
{
  t(`вплотную (${NEAR} кл.) вес полный`, proximity(NEAR) === 1, String(proximity(NEAR)));
  t(`за ${REACH} кл. вес ноль`, proximity(REACH) === 0 && proximity(REACH + 5) === 0);
  t('на полпути вес около половины', near(proximity((NEAR + REACH) / 2), 0.5, 1e-9));
  const nb = readNeighbors(makeSim({ factions: [{ id: 'cog', dist: 20 }] }));
  t('расстояние до соседа считается от столицы', nb[0].dist === 20, String(nb[0].dist));
}

// ─────────────── 3. Война соседа → опасность маршрутов и цены ───────────────
console.log('\n--- Война соседа → дороги, цены, караваны ---');
{
  // armyPower повыше — чтобы в этом разделе работала только связь «война →
  // дороги», а не страх перед соседом: его проверяет раздел 5.
  const warNear = { factions: [{ id: 'wolves', dist: 10, army: 20 }], aiWars: [{ a: 'wolves', b: 'horde' }], armyPower: 50 };
  const a = L(warNear);
  t(`война соседа в ${NEAR} кл.: опасность ровно ${RISK_AI_WAR}`,
    a.mods.routeRisk === RISK_AI_WAR, String(a.mods.routeRisk));
  t('цены на привозное выросли ровно на PRICE_PER_RISK×risk',
    near(a.mods.priceMult, 1 + PRICE_PER_RISK * RISK_AI_WAR, 1e-9), String(a.mods.priceMult));
  t('доля дошедших караванов = 1 − опасность',
    near(a.mods.caravanMult, 1 - RISK_AI_WAR, 1e-9), String(a.mods.caravanMult));
  t('причина названа словами и с расстоянием',
    a.reasons.risk.length === 1 && /воюет/.test(a.reasons.risk[0].ru) && /10 кл/.test(a.reasons.risk[0].ru),
    JSON.stringify(a.reasons.risk));

  const far = L({ factions: [{ id: 'wolves', dist: 40, army: 20 }], aiWars: [{ a: 'wolves', b: 'horde' }] });
  t('та же война за 40 клеток нас не касается', far.mods.routeRisk === 0, String(far.mods.routeRisk));

  const onUs = L({ factions: [{ id: 'wolves', dist: 10, army: 20 }], warsWithUs: ['wolves'] });
  t(`война против нас опаснее чужой (${RISK_OUR_WAR} > ${RISK_AI_WAR})`,
    onUs.mods.routeRisk === RISK_OUR_WAR && onUs.mods.routeRisk > a.mods.routeRisk,
    String(onUs.mods.routeRisk));

  // Потолок: сколько бы войн ни шло, четверть караванов доходит.
  const many = L({
    factions: [1, 2, 3, 4, 5].map(i => ({ id: 'f' + i, dist: 10, army: 20 })),
    aiWars: [1, 2, 3, 4, 5].map(i => ({ a: 'f' + i, b: 'x' })),
  });
  t(`потолок опасности: ${RISK_CAP} даже при пяти войнах у ворот`,
    many.mods.routeRisk === RISK_CAP, `${many.mods.routeRisk} (сырое ${routeDanger(readNeighbors(makeSim({ factions: [1, 2, 3, 4, 5].map(i => ({ id: 'f' + i, dist: 10, army: 20 })), aiWars: [1, 2, 3, 4, 5].map(i => ({ a: 'f' + i, b: 'x' })) }))).raw})`);

  // Недошедшие караваны — настоящие деньги: 0.6🪙 за рынок раз в 15 дней.
  const withMarkets = L({ ...warNear, markets: 5, ourTechs: ['fire', 'trade'] });
  const expectLost = (0.6 * 5 / 15) * RISK_AI_WAR;
  t('опасность отнимает ровно долю караванного дохода',
    near(withMarkets.flags.caravanLost, Math.round(expectLost * 1000) / 1000, 1e-9)
    && near(withMarkets.mods.gold, -Math.round(expectLost * 1000) / 1000, 1e-9),
    `${withMarkets.flags.caravanLost} / ${withMarkets.mods.gold}`);
  t('без технологии торговли караванам нечего терять',
    L({ ...warNear, markets: 5 }).flags.caravanLost === 0);
  t('опасные дороги бьют по купцам и простолюдинам, но в пределах шага',
    withMarkets.mods.approval.merchants < 0 && withMarkets.mods.approval.commons < 0
    && Math.abs(withMarkets.mods.approval.merchants) <= STEP_CAP,
    JSON.stringify(withMarkets.mods.approval));
}

// ─────────────── 4. Торговый договор → золото и скидка ───────────────
console.log('\n--- Торговый договор → приток золота и скидка ---');
{
  // Войско сильнее соседского — страха нет, и в золоте видна только торговля.
  // Купцы начинают с 45: с 55 договор ровно на своём уровне и шага бы не было.
  const o = {
    factions: [{ id: 'guild', dist: 15, army: 10, traits: { trade: 9 } }],
    treaties: ['guild'], armyPower: 50, approval: { merchants: 45 },
  };
  const a = L(o);
  const expect = TREATY_GOLD * (0.4 + 0.9) * 1 * 1 * TREATY_REL_FLOOR;   // rel = 0 → пол дружбы
  t('договор даёт золото по черте торговли партнёра',
    near(a.mods.gold, Math.round(expect * 1000) / 1000, 1e-9), `${a.mods.gold} ожидалось ${expect}`);
  t('скидка на привозное появилась',
    near(a.mods.marketDiscount, Math.round(DISCOUNT_EACH * 1.3 * 1000) / 1000, 1e-9),
    String(a.mods.marketDiscount));
  t('купцы одобряют договор', a.mods.approval.merchants > 0, String(a.mods.approval.merchants));

  const friendly = L({ ...o, relations: { guild: 100 } });
  t('добрые отношения увеличивают оборот', friendly.mods.gold > a.mods.gold,
    `${friendly.mods.gold} vs ${a.mods.gold}`);

  // Война на маршруте партнёра гасит и доход, и скидку — это та же связь.
  const atWar = L({ ...o, aiWars: [{ a: 'guild', b: 'horde' }] });
  t('война партнёра режет доход по договору', atWar.mods.gold < a.mods.gold && atWar.mods.gold > 0,
    `${atWar.mods.gold} vs ${a.mods.gold}`);
  t('и скидку тоже', atWar.mods.marketDiscount < a.mods.marketDiscount);

  const five = L({
    factions: [1, 2, 3, 4, 5].map(i => ({ id: 'g' + i, dist: 15, army: 10, traits: { trade: 9 } })),
    treaties: ['g1', 'g2', 'g3', 'g4', 'g5'],
  });
  t(`потолок скидки: ${DISCOUNT_CAP}`, five.mods.marketDiscount === DISCOUNT_CAP, String(five.mods.marketDiscount));
  t('пять договоров дают впятеро больше золота, а не в пять раз больше скидки',
    near(five.flags.tradeGold, Math.round(5 * expect * 1000) / 1000, 1e-3), String(five.flags.tradeGold));
}

// ─────────────── 5. Сильный сосед рядом → страх ───────────────
console.log('\n--- Сильный сосед → страх, расходы, одобрение военных ---');
{
  const base = { factions: [{ id: 'wolves', dist: 10, army: 100 }], armyPower: 10, pop: 0, gold: 100 };
  const a = L(base);
  const mine = ourStrength(makeSim(base));
  t('наша сила = войско + стены + ополчение + база',
    near(mine, 10 + 0 + 0 * MILITIA_PER_POP + BASE_DEFENCE, 1e-9), String(mine));
  // разрыв 100/16 → полный (потолок 2), враждебность (30−0)/80 = 0.375
  t('страх считается из разрыва в силе и отношений', near(a.flags.fear, 0.375, 1e-9), String(a.flags.fear));
  t('казна платит за охрану границ ровно GUARD_GOLD×страх',
    near(a.flags.guardGold, Math.round(GUARD_GOLD * 0.375 * 1000) / 1000, 1e-9)
    && near(a.mods.gold, -a.flags.guardGold, 1e-9), `${a.flags.guardGold} / ${a.mods.gold}`);
  t('военные одобряют внимание к границе', a.mods.approval.military > 0, String(a.mods.approval.military));
  t('страх портит настроение и стабильность',
    a.mods.happy < 0 && a.mods.stability < 0, `${a.mods.happy} / ${a.mods.stability}`);
  t('причина угрозы названа числами',
    /войско 100 против нашего 16/.test(a.reasons.threat[0].ru), JSON.stringify(a.reasons.threat));

  const friendly = L({ ...base, relations: { wolves: 40 } });
  t('дружелюбного соседа не боятся даже сильного', friendly.flags.fear === 0, String(friendly.flags.fear));
  const equal = L({ ...base, armyPower: 100 });
  t('при равных силах страха нет', equal.flags.fear === 0, String(equal.flags.fear));
  const weakling = L({ factions: [{ id: 'wolves', dist: 10, army: ARMY_FLOOR - 1 }], armyPower: 0 });
  t('сосед без войска не пугает', weakling.flags.fear === 0, String(weakling.flags.fear));

  // Потолок страха и потолок расхода.
  const nightmare = L({
    factions: [1, 2, 3].map(i => ({ id: 'f' + i, dist: 10, army: 10000 })),
    relations: { f1: -100, f2: -100, f3: -100 }, armyPower: 1, soldiers: 60, gold: 9999,
  });
  t(`потолок страха ${FEAR_CAP}`, nightmare.flags.fear === FEAR_CAP, String(nightmare.flags.fear));
  t(`потолок расхода на охрану ${GUARD_CAP}🪙/день`,
    nightmare.flags.guardGold === GUARD_CAP, String(nightmare.flags.guardGold));
  t('шаг одобрения не больше STEP_CAP даже в кошмаре',
    Object.values(nightmare.mods.approval).every(v => Math.abs(v) <= STEP_CAP + 1e-9),
    JSON.stringify(nightmare.mods.approval));
  t(`пол стабильности ${STAB_FLOOR}`, nightmare.mods.stability >= STAB_FLOOR, String(nightmare.mods.stability));
  t(`пол счастья ${HAPPY_FLOOR}`, nightmare.mods.happy >= HAPPY_FLOOR, String(nightmare.mods.happy));

  // ОБРАТНАЯ СВЯЗЬ: платить нечем — гарнизоны без жалования, военные отвернулись.
  const broke = L({ ...base, gold: 0 });
  t('пустая казна: гарнизоны не оплачены', broke.flags.garrisonUnpaid === true && broke.flags.guardGold === 0);
  t('и военные отворачиваются вместо одобрения',
    broke.mods.approval.military < 0, String(broke.mods.approval.military));
  t('золото при пустой казне не уходит в минус', broke.mods.gold === 0, String(broke.mods.gold));
}

// ─────────────── 6. Беженцы ───────────────
console.log('\n--- Беженцы из воюющих земель ---');
{
  const o = {
    day: REFUGEE_PERIOD, pop: 5, housing: 40, food: 500,
    factions: [{ id: 'horde', dist: 10, army: 20, pop: 60, era: 2 }],
    aiWars: [{ a: 'horde', b: 'wolves' }],
  };
  const a = L(o);
  t(`волна беженцев на день ${REFUGEE_PERIOD}: ${REFUGEE_MAX} чел.`,
    a.flags.refugees === REFUGEE_MAX, String(a.flags.refugees));
  t('сказано, откуда они', a.flags.refugeeFrom && a.flags.refugeeFrom.fid === 'horde');
  t('мастера из более развитой земли принесли ремесло',
    near(a.mods.knowledge, REFUGEE_KNOW * REFUGEE_MAX, 1e-9), String(a.mods.knowledge));
  t('в другой день беженцев нет', L({ ...o, day: REFUGEE_PERIOD + 1 }).flags.refugees === 0);

  const full = L({ ...o, housing: 5 });
  t('негде селить — беженцев не берём и говорим почему',
    full.flags.refugees === 0 && full.flags.refugeeBlocked === 'негде селить', String(full.flags.refugeeBlocked));
  const hungry = L({ ...o, food: (5 + 1) * EAT * REFUGEE_FOOD_DAYS - 1 });
  t('нечем кормить — беженцев не берём и говорим почему',
    hungry.flags.refugees === 0 && hungry.flags.refugeeBlocked === 'нечем кормить', String(hungry.flags.refugeeBlocked));
  t('еды ровно впритык — принимаем',
    L({ ...o, food: (5 + 1) * EAT * REFUGEE_FOOD_DAYS }).flags.refugees > 0);
  t('из мирных земель не бегут', L({ ...o, aiWars: [] }).flags.refugees === 0);
  t('через враждебную межу не бегут',
    L({ ...o, warsWithUs: ['horde'] }).flags.refugees === 0);
  t('из земли не выше нашей ремесла не приносят',
    L({ ...o, eraIndex: 2 }).mods.knowledge === 0);
}

// ─────────────── 7. Технологический разрыв ───────────────
console.log('\n--- Технологический разрыв: копируют или отстают ---');
{
  // 'cog'.length × 3 = 9 → копирование приходится на день 9 из каждых 15.
  const copyDay = ('cog'.length * 3) % COPY_PERIOD;
  const o = {
    day: copyDay, ourTechs: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
    factions: [{ id: 'cog', dist: 15, army: 10, techs: 10 - COPY_GAP }], treaties: ['cog'],
  };
  const a = L(o);
  t(`отстающий на ${COPY_GAP} партнёр перенимает наше ремесло`,
    a.flags.copycats.length === 1 && a.flags.copycats[0].fid === 'cog', JSON.stringify(a.flags.copycats));
  t('и игроку сказано, почему именно он смог',
    /договор/.test(a.flags.copycats[0].why) && a.events.some(e => /перенимает/.test(e.text)));
  t('разрыв меньше порога — копировать нечего',
    L({ ...o, factions: [{ id: 'cog', dist: 15, army: 10, techs: 10 - COPY_GAP + 1 }] }).flags.copycats.length === 0);
  t('в другой день не копируют', L({ ...o, day: copyDay + 1 }).flags.copycats.length === 0);
  t('без связи (далеко, врозь, без договора) не копируют',
    L({ ...o, treaties: [], factions: [{ id: 'cog', dist: 25, army: 10, techs: 10 - COPY_GAP }] }).flags.copycats.length === 0);

  // Далеко отставший и отрезанный сосед копит обиду.
  const envy = L({
    day: 3, ourTechs: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
    factions: [{ id: 'cog', dist: 25, army: 10, techs: 1 }],
  });
  t('отставшие без связи завидуют: отношения падают',
    envy.flags.relations.length === 1 && envy.flags.relations[0].dRel < 0
    && /отстали/.test(envy.flags.relations[0].why), JSON.stringify(envy.flags.relations));

  // Отстали МЫ — знание течёт от партнёра, но не рекой.
  const behind = L({
    ourTechs: ['a', 'b'], treaties: ['cog'],
    factions: [{ id: 'cog', dist: 15, army: 10, techs: 10, traits: { science: 9 } }],
  });
  t(`наше отставание даёт приток знания, потолок ${KNOW_CAP}📜`,
    behind.mods.knowledge === KNOW_CAP, String(behind.mods.knowledge));
  const behindSmall = L({
    ourTechs: ['a', 'b'], treaties: ['cog'],
    factions: [{ id: 'cog', dist: 15, army: 10, techs: 5, traits: { science: 5 } }],
  });
  t('поток считается из разрыва и учёности партнёра',
    near(behindSmall.mods.knowledge, Math.round(KNOW_FLOW * 3 * 1 * 1000) / 1000, 1e-9),
    String(behindSmall.mods.knowledge));
  t('без договора знание не течёт',
    L({ ourTechs: ['a', 'b'], factions: [{ id: 'cog', dist: 15, army: 10, techs: 10 }] }).mods.knowledge === 0);
}

// ─────────────── 8. ОБРАТНО: богатство + слабая армия → наглость ───────────────
console.log('\n--- Соседи наглеют от нашего богатства и слабости ---');
{
  const rich = {
    factions: [{ id: 'horde', dist: 10, army: 100, traits: { aggression: 9 } }],
    armyPower: 10, pop: 0, gold: 600, wealth: 3000,
  };
  const a = L(rich);
  const tempt = temptation(makeSim(rich));
  t('соблазн взят с потолка казны и богатства', tempt.value === 1, String(tempt.value));
  const g = greedOf(readNeighbors(makeSim(rich))[0], ourStrength(makeSim(rich)), 1);
  t('наглость считается из слабости, добычи и характера', g > GREED_MIN, String(g));
  t('отношения падают ровно на GREED_REL×наглость',
    a.flags.relations.length === 1 && near(a.flags.relations[0].dRel, Math.round(GREED_REL * g * 1000) / 1000, 1e-3),
    JSON.stringify(a.flags.relations));
  t('и падают медленнее дипломатического дрейфа ядра (0.2/день) — выход есть',
    Math.abs(a.flags.relations[0].dRel) < 0.2 && Math.abs(a.flags.relations[0].dRel) <= REL_STEP_CAP);
  t('игроку сказано, ПОЧЕМУ сосед наглеет: войско, казна, расстояние',
    a.flags.eyeingUs.length === 1 && /войско 100 против нашего 16/.test(a.flags.eyeingUs[0].text)
    && /600🪙/.test(a.flags.eyeingUs[0].text) && /10 кл/.test(a.flags.eyeingUs[0].text),
    a.flags.eyeingUs[0] && a.flags.eyeingUs[0].text);

  const poor = L({ ...rich, gold: 0, wealth: 0 });
  t('нищий, но беззащитный всё равно интересен — просто меньше',
    poor.flags.relations[0].dRel > a.flags.relations[0].dRel && poor.flags.relations[0].dRel < 0,
    `${poor.flags.relations[0].dRel} vs ${a.flags.relations[0].dRel}`);

  // ВЫХОД: построили войско — наглость сменилась уважением.
  const armed = L({ ...rich, armyPower: 200 });
  t('сильная армия убирает наглость', armed.flags.eyeingUs.length === 0);
  t('и воинственный сосед начинает уважать (отношения растут)',
    armed.flags.relations.length === 1 && near(armed.flags.relations[0].dRel, RESPECT_REL, 1e-9)
    && /уважают силу/.test(armed.flags.relations[0].why), JSON.stringify(armed.flags.relations));
  const armedMild = L({ ...rich, armyPower: 200, factions: [{ id: 'grove', dist: 10, army: 100, traits: { aggression: 2 } }] });
  t('миролюбивый сосед силу не «уважает» — прибавки нет',
    armedMild.flags.relations.length === 0, JSON.stringify(armedMild.flags.relations));

  // Общий потолок дневного сдвига по одному соседу.
  const worst = L({
    factions: [{ id: 'horde', dist: 5, army: 5000, traits: { aggression: 10 } }],
    armyPower: 0, gold: 99999, wealth: 99999,
  });
  t(`сдвиг отношений за день не больше ${REL_STEP_CAP}`,
    Math.abs(worst.flags.relations[0].dRel) <= REL_STEP_CAP, String(worst.flags.relations[0].dRel));
}

// ─────────────── 9. Награда за спокойные границы ───────────────
console.log('\n--- Спокойные границы: награда только за настоящее достижение ---');
{
  const calm = L({
    factions: [{ id: 'guild', dist: 15, army: 10, traits: { trade: 9 } }],
    treaties: ['guild'], armyPower: 50,
  });
  t('нет войн, есть договор, войско не слабее — стабильность растёт',
    calm.flags.calmBorders === true && calm.mods.stability === STAB_CALM, String(calm.mods.stability));
  const noTreaty = L({ factions: [{ id: 'guild', dist: 15, army: 10 }], armyPower: 50 });
  t('без договоров награды нет — это не «+5 просто так»',
    noTreaty.flags.calmBorders === false && noTreaty.mods.stability === 0, String(noTreaty.mods.stability));
  const weak = L({
    factions: [{ id: 'guild', dist: 15, army: 300, traits: { trade: 9 } }],
    treaties: ['guild'], armyPower: 0, relations: { guild: 60 },
  });
  t('сосед сильнее нас — границы уже не «спокойные»', weak.flags.calmBorders === false);
}

// ─────────────── 10. Чистота функции и отчёты ───────────────
console.log('\n--- Чистота, повторяемость, отчёты ---');
{
  const sim = makeSim({
    day: REFUGEE_PERIOD, gold: 400, wealth: 2000, armyPower: 5, markets: 3,
    ourTechs: ['fire', 'trade'],
    factions: [
      { id: 'horde', dist: 8, army: 200, traits: { aggression: 9 }, pop: 80 },
      { id: 'guild', dist: 14, army: 10, traits: { trade: 9 } },
    ],
    treaties: ['guild'], aiWars: [{ a: 'horde', b: 'wolves' }],
  });
  const before = JSON.stringify({ res: sim.res, rel: sim.relations, pol: sim.politics, v: sim.villagers.length });
  const r1 = neighborLinks(sim);
  const after = JSON.stringify({ res: sim.res, rel: sim.relations, pol: sim.politics, v: sim.villagers.length });
  t('функция ничего не мутирует', before === after);
  const r2 = neighborLinks(sim);
  t('второй вызов даёт тот же результат (детерминизм)', JSON.stringify(r1) === JSON.stringify(r2));
  t('в сложном мире связь работает во все стороны сразу',
    r1.mods.gold !== 0 && r1.flags.fear > 0 && r1.flags.refugees > 0 && r1.flags.relations.length > 0,
    JSON.stringify({ gold: r1.mods.gold, fear: r1.flags.fear, ref: r1.flags.refugees }));

  const rep = neighborReport(sim);
  t('отчёт даёт по строке на соседа с числами',
    rep.length === 2 && /войско 200 против нашего/.test(rep[0].text), JSON.stringify(rep.map(r => r.text)));
  t('настроение соседа названо словом', rep[0].mood === 'Видят добычу' && rep[1].mood === 'Торгуют',
    `${rep[0].mood} / ${rep[1].mood}`);
  const br = neighborBreakdown(sim);
  t('строка для HUD собрана', /Соседи:/.test(br.text) && br.rows.length > 0, br.text);
  t('в тихом мире строка HUD так и говорит',
    neighborBreakdown(makeSim({ factions: [{ id: 'grove', dist: 40 }] })).text === 'Соседи: тихо');
}

// ─────────────── 11. Дисциплина исходника и якоря подключения ───────────────
console.log('\n--- Исходник: без случайностей, якоря на месте ---');
{
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '../src/core/systems/link_neighbors.js'), 'utf8');
  t('Math.random не вызывается (иначе ломаются сейвы)', !/Math\.random\s*\(/.test(src));
  t('модуль не пишет в sim (нет присваиваний sim.*)',
    !/(^|[^.\w])sim\.[a-zA-Z_.]+\s*=[^=]/m.test(src.split('/* ПОДКЛЮЧЕНИЕ')[0]));
  t('в конце файла есть блок ПОДКЛЮЧЕНИЕ', /\/\* ПОДКЛЮЧЕНИЕ/.test(src));

  const integ = readFileSync(join(here, '../src/core/systems/integrate.js'), 'utf8');
  const count = (s, sub) => s.split(sub).length - 1;
  t('якорь 1 (импорт link_survival) существует и уникален',
    count(integ, "import * as LS from './link_survival.js';") === 1);
  t('якорь 2 (вызов applySurvivalLinks) существует и уникален',
    count(integ, 'applySurvivalLinks(sim);') === 1);
  t('якорь 3 (счастье выживания) существует и уникален',
    count(integ, '+ LS.survivalHappyMod(sim)') === 1);
}

console.log(`\n=== ${ok} OK / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
