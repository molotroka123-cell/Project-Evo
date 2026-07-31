// Тесты надстройки дипломатии (U26–U28). Запуск: node app/tests/test-diplomacy.mjs
import { Simulation } from '../src/core/simulation.js';
import { createRng } from '../src/core/rng.js';
import { FACTIONS, TECHS } from '../src/core/data.js';
import { createBorders, updateBorders, attritionPerDay } from '../src/core/systems/borders.js';
import {
  createDiplomacy, tickDiplomacy, applyPlayerRel, serializeDiplomacy, deserializeDiplomacy,
  grantPassage, revokePassage, hasPassage, mayEnter, passageList, attritionMult, trespassScan,
  addCasusBelli, hasCasusBelli, casusBelliList, consumeCasusBelli, warLegitimacy,
  formAlliance, breakAlliance, isAllied, alliesOf, allianceList, evaluateAllianceOffer,
  callToArms, answerCall, pendingCallsFor,
  openWar, closeWar, isAtWar, inTruce, warDurations, warStats,
  techValueFor, evaluateTechTrade, buildTechOffer, applyTechTrade, factionKnows,
  aiRel, adjustAiRel, clampRel, pairKey, dirKey,
  REL_MIN, REL_MAX, PASSAGE_DAYS, TRESPASS_GRACE, TRESPASS_CB_REL, CB_LIFETIME,
  ALLY_BREAK_REL, CALL_REFUSE_REL, CALL_ACCEPT_ENEMY_REL, CALL_TTL,
  JOINT_WAR_REL, WAR_MAX_DAYS, TECH_TRADE_MIN_REL, TECH_TRADE_COOLDOWN,
} from '../src/core/systems/diplomacy_ext.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('OK', name); } catch (e) { fail++; console.log('FAIL', name, '—', e.message); } };
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };

const DEF = Object.fromEntries(FACTIONS.map(f => [f.id, f]));
const fac = (id, extra = {}) => ({
  id, def: DEF[id], alive: true, P: 20, era: 0, techCount: 10, armyPts: 20, wallPts: 0, goldPts: 0,
  settlements: [{ x: 20, y: 20, capital: true }], ...extra,
});

// ---------------------------------------------------------------- U26
t('U26 право прохода: выдаётся на срок, истекает, снимается вручную', () => {
  const s = createDiplomacy();
  ok(!hasPassage(s, 'wolves', 'player', 0), 'проход есть без договора');
  grantPassage(s, 'wolves', 'player', 100);
  ok(hasPassage(s, 'wolves', 'player', 150), 'договор не действует внутри срока');
  ok(!hasPassage(s, 'wolves', 'player', 100 + PASSAGE_DAYS), 'договор не истёк по сроку');
  ok(!hasPassage(s, 'player', 'wolves', 150), 'проход оказался двусторонним');
  ok(passageList(s, 150).length === 1, 'список договоров пуст');
  revokePassage(s, 'wolves', 'player');
  ok(!hasPassage(s, 'wolves', 'player', 150), 'отзыв договора не сработал');
});

t('U26 нарушение рубежей: после отсрочки — casus belli и падение отношений', () => {
  const s = createDiplomacy();
  const rng = createRng(1);
  const relations = { wolves: 0 };
  const factions = [fac('wolves')];
  let gotCB = -1;
  for (let day = 0; day < 10; day++) {
    const out = tickDiplomacy(s, {
      day, rng, factions, relations, playerWars: [], player: { armyPower: 30, techs: new Set() },
      trespass: [{ intruder: 'wolves', owner: 'player' }],
    });
    applyPlayerRel(relations, out.playerRel);
    if (gotCB < 0 && hasCasusBelli(s, 'player', 'wolves', day)) gotCB = day;
  }
  // День 0 — первый день вторжения, значит повод не раньше дня TRESPASS_GRACE.
  ok(gotCB >= TRESPASS_GRACE, `повод появился слишком рано: день ${gotCB}`);
  ok(gotCB <= TRESPASS_GRACE + 1, `повод не появился вовремя: день ${gotCB}`);
  ok(relations.wolves < TRESPASS_CB_REL, `отношения почти не пострадали: ${relations.wolves}`);
  const leg = warLegitimacy(s, 'player', 'wolves', 9);
  ok(leg.legal && leg.kind === 'trespass', 'повод не признан законным');
  console.log(`   повод к войне на день ${gotCB}, отношения ${relations.wolves.toFixed(1)}, «${leg.ru}»`);
});

t('U26 с договором прохода нарушения нет вовсе', () => {
  const s = createDiplomacy();
  const rng = createRng(2);
  const relations = { wolves: 0 };
  grantPassage(s, 'wolves', 'player', 0);
  for (let day = 0; day < 30; day++) {
    const out = tickDiplomacy(s, {
      day, rng, factions: [fac('wolves')], relations, playerWars: [], player: { armyPower: 30, techs: new Set() },
      trespass: [{ intruder: 'wolves', owner: 'player' }],
    });
    applyPlayerRel(relations, out.playerRel);
  }
  ok(!hasCasusBelli(s, 'player', 'wolves', 30), 'договорный марш стал поводом к войне');
  ok(relations.wolves === 0, `договорный марш испортил отношения: ${relations.wolves}`);
});

t('U26 повод одноразовый и не вечный', () => {
  const s = createDiplomacy();
  addCasusBelli(s, 'player', 'guild', 'trespass', 10);
  addCasusBelli(s, 'player', 'guild', 'trespass', 12); // тот же по природе — не копится
  ok(casusBelliList(s, 'player', 'guild', 12).length === 1, 'поводы копятся дублями');
  ok(consumeCasusBelli(s, 'player', 'guild', 12), 'повод не израсходовался');
  ok(!hasCasusBelli(s, 'player', 'guild', 12), 'повод пережил использование');
  addCasusBelli(s, 'player', 'guild', 'raid', 100);
  ok(!hasCasusBelli(s, 'player', 'guild', 100 + CB_LIFETIME), 'повод не протух по сроку');
});

t('U26 истощение из borders: договор его снимает, объявленный повод усиливает', () => {
  const s = createDiplomacy();
  ok(attritionMult(s, 'wolves', 'player', 0) === 1, 'без договора множитель не 1');
  grantPassage(s, 'wolves', 'player', 0);
  ok(attritionMult(s, 'wolves', 'player', 5) === 0, 'договор не снял истощение');
  const s2 = createDiplomacy();
  s2.trespass[dirKey('wolves', 'player')] = { days: 9, lastDay: 5, cbDay: 5 };
  ok(attritionMult(s2, 'wolves', 'player', 6) === 1.5, 'после повода истощение не выросло');
  ok(attritionMult(s2, 'wolves', null, 6) === 1, 'на ничьей земле множитель не нейтральный');
});

t('U26 trespassScan на настоящих границах', () => {
  const sim = new Simulation(7, { factions: 3 });
  sim.execCommand('give wood 400'); sim.execCommand('give food 400');
  for (let i = 0; i < 60; i++) sim.tick(1);
  const b = createBorders(sim.world.w, sim.world.h);
  updateBorders(b, { world: sim.world, day: sim.day, version: 1, buildings: sim.buildings, factions: sim.factions, force: true });
  const s = createDiplomacy();
  const f = sim.factions[0];
  // Отряд фракции у кострища игрока — по определению на чужой земле.
  const army = { side: f.id, x: sim.world.startX, y: sim.world.startY };
  const hit = trespassScan(s, b, [army], { day: sim.day });
  ok(hit.length === 1 && hit[0].owner === 'player', 'нарушение на земле игрока не замечено');
  ok(attritionPerDay(b, army.x, army.y, f.id) > 0, 'borders не даёт истощения на чужой земле');
  // Свой отряд на своей земле — не нарушение.
  ok(trespassScan(s, b, [{ side: 'player', x: army.x, y: army.y }], { day: sim.day }).length === 0, 'свой отряд объявлен нарушителем');
  grantPassage(s, f.id, 'player', sim.day);
  const legal = trespassScan(s, b, [army], { day: sim.day });
  ok(legal[0].legal && legal[0].attrition === 0, 'договор не сделал марш законным');
  console.log(`   ${sideOf(f)} у кострища: истощение ${attritionPerDay(b, army.x, army.y, f.id).toFixed(2)}/день, с договором ×0`);
});

function sideOf(f) { return f.def.name; }

// ---------------------------------------------------------------- U27
t('U27 союз: заключение, взаимное право прохода, разрыв даёт повод', () => {
  const s = createDiplomacy();
  ok(formAlliance(s, 'player', 'grove', 10).ok, 'союз не заключился');
  ok(isAllied(s, 'grove', 'player'), 'союз не симметричен');
  ok(mayEnter(s, 'player', 'grove', 11) && mayEnter(s, 'grove', 'player', 11), 'союзники не пускают друг друга');
  ok(!formAlliance(s, 'player', 'grove', 11).ok, 'союз задвоился');
  ok(alliesOf(s, 'player').includes('grove'), 'список союзников пуст');
  ok(allianceList(s)[0].ru.length > 0, 'у союза нет русского описания');
  breakAlliance(s, 'player', 'grove', 20);
  ok(!isAllied(s, 'player', 'grove'), 'союз пережил разрыв');
  ok(hasCasusBelli(s, 'grove', 'player', 20), 'брошенный союзник не получил повода');
});

t('U27 призыв к оружию: согласие и отказ бьют по разным отношениям', () => {
  const s = createDiplomacy();
  formAlliance(s, 'player', 'wolves', 0);
  const relations = { wolves: 60, guild: 20 };
  const call = callToArms(s, 'wolves', 'player', 'guild', 5);
  ok(call && pendingCallsFor(s, 'player').length === 1, 'призыв не создан');
  const yes = answerCall(s, call.id, true, { day: 5, relations });
  ok(yes.joinWar && yes.joinWar.enemy === 'guild', 'согласие не привело к войне');
  const dW = yes.playerRel.find(d => d.fid === 'wolves').dR;
  const dG = yes.playerRel.find(d => d.fid === 'guild').dR;
  ok(dW === JOINT_WAR_REL && dG === CALL_ACCEPT_ENEMY_REL, `дельты не те: ${dW} / ${dG}`);
  ok(isAtWar(s, 'player', 'guild'), 'война с противником союзника не открыта');

  const s2 = createDiplomacy();
  formAlliance(s2, 'player', 'wolves', 0);
  const c2 = callToArms(s2, 'wolves', 'player', 'guild', 5);
  const no = answerCall(s2, c2.id, false, { day: 5, relations: { wolves: 60 } });
  ok(no.playerRel[0].dR === CALL_REFUSE_REL, 'отказ ничего не стоил');
  ok(!no.joinWar && !isAtWar(s2, 'player', 'guild'), 'отказ всё равно втянул в войну');
  ok(isAllied(s2, 'player', 'wolves'), 'тёплый союз развалился от одного отказа');

  const s3 = createDiplomacy();
  formAlliance(s3, 'player', 'wolves', 0);
  const c3 = callToArms(s3, 'wolves', 'player', 'guild', 5);
  const no3 = answerCall(s3, c3.id, false, { day: 5, relations: { wolves: ALLY_BREAK_REL + 10 } });
  ok(no3.brokeAlliance && !isAllied(s3, 'player', 'wolves'), 'холодный союз пережил отказ');
  console.log(`   согласие: ${dW} к зовущему и ${dG} к его врагу; отказ: ${CALL_REFUSE_REL}`);
});

t('U27 молчание на призыв равно отказу', () => {
  const s = createDiplomacy();
  const rng = createRng(3);
  const relations = { wolves: 30 };
  formAlliance(s, 'player', 'wolves', 0);
  callToArms(s, 'wolves', 'player', 'guild', 0);
  let penalty = 0;
  for (let day = 1; day <= CALL_TTL + 2; day++) {
    const out = tickDiplomacy(s, { day, rng, factions: [fac('wolves')], relations, playerWars: [], player: { armyPower: 10, techs: new Set() } });
    for (const d of out.playerRel) if (d.dR === CALL_REFUSE_REL) penalty++;
    applyPlayerRel(relations, out.playerRel);
  }
  ok(penalty === 1, `штраф за молчание сработал ${penalty} раз`);
  ok(pendingCallsFor(s, 'player').length === 0, 'просроченный призыв висит');
});

t('U27 ИИ оценивает союз по видимым данным: другу да, чужому нет', () => {
  const s = createDiplomacy();
  const ctx = { rng: createRng(4), factions: [fac('grove'), fac('guild')], relations: {} };
  adjustAiRel(s, 'grove', 'guild', 60);
  const u = evaluateAllianceOffer(s, ctx.factions[0], 'guild', ctx);
  ok(u > 0, 'дружественный союз оценён в ноль');
  adjustAiRel(s, 'grove', 'guild', -120);
  ok(evaluateAllianceOffer(s, ctx.factions[0], 'guild', ctx) === 0, 'враг всё ещё годится в союзники');
  ok(aiRel(s, 'grove', 'guild') >= REL_MIN, 'отношения пробили нижнюю границу');
});

t('U27 совместная война: ИИ откликается на призыв союзника', () => {
  // Волки (агрессия 9) и Орда (7) в союзе против слабой Гильдии — обе должны
  // идти воевать: расчёт сил в их пользу, отношения тёплые.
  const s = createDiplomacy();
  const factions = [fac('wolves', { armyPts: 60 }), fac('horde', { armyPts: 55 }), fac('guild', { armyPts: 8 })];
  formAlliance(s, 'wolves', 'horde', 0);
  adjustAiRel(s, 'wolves', 'horde', 70);
  adjustAiRel(s, 'wolves', 'guild', -70);
  adjustAiRel(s, 'horde', 'guild', -50);
  const rng = createRng(5);
  const relations = {};
  let joined = false;
  for (let day = 1; day < 60 && !joined; day++) {
    tickDiplomacy(s, { day, rng, factions, relations, playerWars: [], player: { armyPower: 10, techs: new Set() } });
    joined = isAtWar(s, 'horde', 'guild') && isAtWar(s, 'wolves', 'guild');
  }
  ok(joined, 'союзник не поддержал войну');
  console.log('   союзник вступил в войну по призыву');
});

// ---------------------------------------------------------------- U28
t('U28 ценность технологии считается по чертам фракции', () => {
  const wolves = DEF.wolves.traits, cog = DEF.cog.traits, guild = DEF.guild.traits;
  ok(techValueFor('warfare', wolves) > techValueFor('warfare', guild), 'воины не ценят военное дело выше торговцев');
  ok(techValueFor('philosophy', cog) > techValueFor('philosophy', wolves), 'механики не ценят науку выше волков');
  ok(techValueFor('trade', guild) > techValueFor('trade', wolves), 'гильдия не ценит торговлю выше волков');
  ok(techValueFor('нет-такой', cog) === 0, 'несуществующая технология чего-то стоит');
  console.log(`   «Военное дело»: волки ${techValueFor('warfare', wolves).toFixed(0)} против гильдии ${techValueFor('warfare', guild).toFixed(0)}`);
});

t('U28 обмен: предложение строится, проводится и меняет обе стороны', () => {
  const s = createDiplomacy();
  const f = fac('cog', { techCount: 12 });
  // Игрок обогнал фракцию по «законам» и «мореходству», но отстал по ранним
  // технологиям — есть чем меняться в обе стороны.
  const techs = new Set(['fire', 'tools', 'hunting', 'language', 'farming', 'trade', 'laws', 'sailing']);
  const ctx = { day: 10, factions: [f], relations: { cog: 55 }, player: { techs, armyPower: 20 } };
  const offer = buildTechOffer(s, ctx, 'cog');
  ok(offer, 'предложение не построено');
  ok(factionKnows(f, offer.give) && !techs.has(offer.give), 'фракция отдаёт то, чего не знает, или уже известное игроку');
  ok(!factionKnows(f, offer.want) && techs.has(offer.want), 'фракция просит то, что у неё есть');
  const res = applyTechTrade(s, ctx, offer, 10);
  ok(res.ok && res.playerTech === offer.give && res.factionTechDelta === 1, 'обмен не проведён');
  ok(res.playerRel[0].dR > 0, 'обмен не улучшил отношения');
  ok(!applyTechTrade(s, ctx, offer, 10 + TECH_TRADE_COOLDOWN - 1).ok, 'кулдаун обмена не работает');
  console.log(`   ${offer.ru} → +${res.playerRel[0].dR} отношений`);
});

t('U28 без доверия и на войне обмена нет', () => {
  const s = createDiplomacy();
  const f = fac('cog', { techCount: 12 });
  const techs = new Set(['fire', 'tools', 'trade', 'laws', 'sailing']);
  const cold = { day: 1, factions: [f], relations: { cog: TECH_TRADE_MIN_REL - 5 }, player: { techs } };
  ok(!buildTechOffer(s, cold, 'cog'), 'холодная фракция предложила обмен');
  const warm = { day: 1, factions: [f], relations: { cog: 60 }, player: { techs } };
  ok(buildTechOffer(s, warm, 'cog'), 'тёплая фракция не предложила обмен');
  openWar(s, 'player', 'cog', 1);
  ok(!buildTechOffer(s, warm, 'cog'), 'воюющая фракция делится технологиями');
});

t('U28 военную технологию отдают неохотнее мирной', () => {
  const s = createDiplomacy();
  const f = fac('wolves', { techCount: 20 });
  const ctx = { day: 1, factions: [f], relations: { wolves: 60 }, player: { techs: new Set(['philosophy']) } };
  const war = evaluateTechTrade(s, ctx, 'wolves', 'warfare', 'philosophy');
  const civil = evaluateTechTrade(s, ctx, 'wolves', 'pottery', 'philosophy');
  ok(civil.costSide < war.costSide, 'гончарство отдают тяжелее военного дела');
  console.log(`   цена отдачи: «Военное дело» ${war.costSide.toFixed(0)} против «Гончарства» ${civil.costSide.toFixed(0)}`);
});

// ---------------------------------------------------------------- Общее
t('детерминизм: один сид — один и тот же результат', () => {
  const run = () => {
    const s = createDiplomacy();
    const rng = createRng(99);
    const factions = FACTIONS.slice(0, 6).map(d => fac(d.id, { settlements: [{ x: 10 + d.name.length, y: 20, capital: true }] }));
    const relations = {};
    for (let day = 1; day <= 300; day++) {
      for (const f of factions) f.armyPts += 0.4;
      const out = tickDiplomacy(s, { day, rng, factions, relations, playerWars: [], player: { armyPower: 40, techs: new Set() } });
      applyPlayerRel(relations, out.playerRel);
    }
    return JSON.stringify({ st: serializeDiplomacy(s), relations });
  };
  ok(run() === run(), 'два прогона с одним сидом разошлись');
});

t('сейв: serialize → deserialize восстанавливает состояние', () => {
  const s = createDiplomacy();
  grantPassage(s, 'wolves', 'player', 5);
  formAlliance(s, 'player', 'grove', 6);
  addCasusBelli(s, 'player', 'wolves', 'trespass', 7);
  openWar(s, 'wolves', 'guild', 8);
  adjustAiRel(s, 'wolves', 'guild', -80);
  closeWar(s, 'wolves', 'guild', 40);
  const json = JSON.parse(JSON.stringify(serializeDiplomacy(s)));
  const back = deserializeDiplomacy(json);
  ok(hasPassage(back, 'wolves', 'player', 10), 'право прохода не пережило сейв');
  ok(isAllied(back, 'player', 'grove'), 'союз не пережил сейв');
  ok(hasCasusBelli(back, 'player', 'wolves', 10), 'повод не пережил сейв');
  ok(inTruce(back, 'wolves', 'guild', 41), 'перемирие не пережило сейв');
  ok(warDurations(back).length === 1 && warDurations(back)[0] === 32, 'история войн потерялась');
  ok(Math.abs(aiRel(back, 'wolves', 'guild') - aiRel(s, 'wolves', 'guild')) < 1e-9, 'отношения ИИ потерялись');
  ok(deserializeDiplomacy(null).wars.length === 0, 'пустой сейв не грузится');
});

t('кламп отношений устойчив к мусору', () => {
  ok(clampRel(1e9) === REL_MAX && clampRel(-1e9) === REL_MIN, 'кламп не держит границы');
  ok(clampRel(NaN) === 0 && clampRel(undefined) === 0, 'NaN просочился в отношения');
  const s = createDiplomacy();
  for (let i = 0; i < 100; i++) adjustAiRel(s, 'a', 'b', 50);
  ok(aiRel(s, 'a', 'b') === REL_MAX, 'верхняя граница пробита');
  for (let i = 0; i < 100; i++) adjustAiRel(s, 'a', 'b', -50);
  ok(aiRel(s, 'a', 'b') === REL_MIN, 'нижняя граница пробита');
  ok(pairKey('b', 'a') === pairKey('a', 'b'), 'ключ пары не симметричен');
});

// ---------------------------------------------------------------- Стресс
t('20 сидов × 2000 дней: отношения в [-100, 100], войны конечны', () => {
  const buckets = new Array(16).fill(0);
  const all = [];
  let minR = 0, maxR = 0, checks = 0, wars = 0, alliances = 0, trades = 0, cbs = 0, longestActive = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const rng = createRng(seed * 7919);
    // Все восемь фракций на карте 96×96: чем теснее, тем острее дипломатия.
    const factions = FACTIONS.map((d, i) => fac(d.id, {
      armyPts: 10 + rng.range(0, 20), techCount: rng.int(1, 20),
      settlements: [{ x: rng.int(6, 90), y: rng.int(6, 90), capital: true }],
    }));
    const relations = {};
    for (const f of factions) relations[f.id] = rng.range(-40, 40);
    const s = createDiplomacy();
    // Дерево знаний игрока с дырами: часть технологий у него есть, часть нет —
    // только на таком раскладе обмен вообще имеет смысл для обеих сторон.
    const playerTechs = new Set(TECHS.filter((_, i) => i < 36 && i % 3 === 0).map(x => x.id));
    let playerWars = [];
    for (let day = 1; day <= 2000; day++) {
      for (const f of factions) f.armyPts += rng.range(0.1, 0.6);
      // Игрок время от времени задабривает соседей — иначе ветки союзов и
      // обменов технологиями просто не включились бы ни разу.
      if (rng.chance(0.02)) applyPlayerRel(relations, [{ fid: rng.pick(factions).id, dR: 12, why: 'Подарок' }]);
      // Ядро иногда само объявляет войну игроку и само же мирится — модуль
      // обязан пережить обе ситуации, не рассинхронизировавшись.
      for (const f of factions) {
        if (playerWars.includes(f.id)) continue;
        if (relations[f.id] < -50 && rng.chance(0.004)) playerWars.push(f.id);
      }
      const trespass = [];
      if (rng.chance(0.05)) trespass.push({ intruder: rng.pick(factions).id, owner: 'player' });
      if (rng.chance(0.05)) trespass.push({ intruder: 'player', owner: rng.pick(factions).id });
      const ctx = {
        day, rng, factions, relations, playerWars, trespass,
        player: { armyPower: 20 + day * 0.05, era: Math.floor(day / 220), techs: playerTechs },
      };
      const out = tickDiplomacy(s, ctx);
      applyPlayerRel(relations, out.playerRel);
      // Игрок за рулём: союзы принимает, право прохода выдаёт, технологиями
      // меняется, на призывы отвечает то согласием, то отказом.
      for (const of of out.offers) {
        if (of.kind === 'alliance') formAlliance(s, 'player', of.fid, day);
        else if (of.kind === 'passage') grantPassage(s, of.fid, 'player', day);
        else if (of.kind === 'tech') {
          const res = applyTechTrade(s, ctx, of.offer, day);
          if (!res.ok) continue;
          playerTechs.add(res.playerTech);
          const f = factions.find(x => x.id === of.fid);
          if (f) f.techCount += res.factionTechDelta;
          applyPlayerRel(relations, res.playerRel);
        }
      }
      for (const c of out.calls) {
        const res = answerCall(s, c.id, rng.chance(0.5), { day, relations });
        applyPlayerRel(relations, res.playerRel);
        if (res.joinWar && !playerWars.includes(res.joinWar.enemy)) playerWars.push(res.joinWar.enemy);
      }
      for (const w of out.warsEnded) if (w.a === 'player' || w.b === 'player') {
        playerWars = playerWars.filter(x => x !== (w.a === 'player' ? w.b : w.a));
      }
      // Проверка границ — каждый день, по всем отношениям сразу.
      for (const f of factions) {
        const R = relations[f.id];
        ok(Number.isFinite(R) && R >= REL_MIN && R <= REL_MAX, `отношения игрока с ${f.id} вышли за предел: ${R} (сид ${seed}, день ${day})`);
        minR = Math.min(minR, R); maxR = Math.max(maxR, R); checks++;
      }
      for (const [k, R] of Object.entries(s.rel)) {
        ok(Number.isFinite(R) && R >= REL_MIN && R <= REL_MAX, `отношения ${k} вышли за предел: ${R} (сид ${seed}, день ${day})`);
        minR = Math.min(minR, R); maxR = Math.max(maxR, R); checks++;
      }
      for (const w of s.wars) {
        ok(day - w.start <= WAR_MAX_DAYS, `война ${w.a}/${w.b} идёт ${day - w.start} дн. — дольше потолка`);
        longestActive = Math.max(longestActive, day - w.start);
      }
    }
    alliances += s.alliances.length; trades += s.trades.length; cbs += s.cb.length;
    for (const d of warDurations(s)) {
      all.push(d); wars++;
      buckets[Math.min(buckets.length - 1, Math.floor(d / 25))]++;
    }
  }
  ok(wars > 50, `войн почти не было (${wars}) — дипломатия не работает`);
  all.sort((a, b) => a - b);
  const med = all[Math.floor(all.length / 2)];
  console.log(`   проверок отношений: ${checks}, размах [${minR.toFixed(1)}; ${maxR.toFixed(1)}]`);
  console.log(`   войн завершено: ${wars}, медиана ${med} дн., максимум ${all[all.length - 1]} дн., самая долгая незавершённая ${longestActive} дн.`);
  console.log('   распределение длительности войн (по 25 дней):');
  for (let i = 0; i < buckets.length; i++) {
    if (!buckets[i]) continue;
    const label = `${i * 25}–${i * 25 + 24}`.padStart(9);
    console.log(`     ${label} дн: ${'#'.repeat(Math.max(1, Math.round(buckets[i] / Math.max(1, wars) * 60)))} ${buckets[i]}`);
  }
  console.log(`   на 20 сидов: союзов к финалу ${alliances}, обменов ${trades}, живых поводов к войне ${cbs}`);
});

t('никаких вечных войн: каждая война в истории конечна', () => {
  const rng = createRng(2024);
  const s = createDiplomacy();
  const factions = FACTIONS.map(d => fac(d.id, { settlements: [{ x: 40 + rng.int(-6, 6), y: 40 + rng.int(-6, 6), capital: true }] }));
  const relations = {};
  for (let day = 1; day <= 3000; day++) {
    tickDiplomacy(s, { day, rng, factions, relations, playerWars: [], player: { armyPower: 30, techs: new Set() } });
  }
  const d = warDurations(s);
  ok(d.length > 20, `войн слишком мало для вывода: ${d.length}`);
  ok(Math.max(...d) <= WAR_MAX_DAYS, `нашлась война длиной ${Math.max(...d)} дн.`);
  const st = warStats(s, 3000);
  ok(st.longestActive <= WAR_MAX_DAYS, 'незавершённая война переросла потолок');
  console.log(`   тесная карта: ${st.finished} войн, min ${st.min} · медиана ${st.median} · p90 ${st.p90} · max ${st.max} дн.`);
  console.log(`   среднее ${st.avg.toFixed(1)} дн., активных на день 3000: ${st.active}`);
});

// ---------------------------------------------------------------- Интеграция
t('интеграция: живая Simulation + границы, 500 дней дипломатии', () => {
  const sim = new Simulation(1234, { factions: 5 });
  sim.execCommand('give wood 600'); sim.execCommand('give food 600'); sim.execCommand('give stone 400');
  const s = createDiplomacy();
  const borders = createBorders(sim.world.w, sim.world.h);
  let offers = 0, calls = 0, logs = 0;
  for (let i = 0; i < 500; i++) {
    sim.tick(1);
    // Игрок ухаживает за первым соседом штатным подарком — так включаются
    // ветки союза, права прохода и обмена технологиями.
    if (i % 40 === 0) sim.adjustRel(sim.factions[0].id, 12, 'Подарок');
    updateBorders(borders, { world: sim.world, day: sim.day, version: sim.buildings.length + sim.day, buildings: sim.buildings, factions: sim.factions });
    const armies = [];
    if (sim.raids.warning && sim.raids.from) {
      const camp = sim.buildings.find(b => b.id === 'campfire' && !b.destroyed);
      if (camp) armies.push({ side: sim.raids.from, x: camp.x, y: camp.y });
    }
    const out = tickDiplomacy(s, {
      day: sim.day, rng: sim.rng, difficulty: sim.difficulty,
      factions: sim.factions, relations: sim.relations, playerWars: sim.wars.map(w => w.fid),
      treaties: sim.treaties,
      player: { armyPower: sim.armyPower(), era: sim.eraIndex, techs: sim.techs, gold: sim.res.gold },
      trespass: trespassScan(s, borders, armies, { day: sim.day }),
    });
    applyPlayerRel(sim.relations, out.playerRel, (fid, dR, why) => sim.adjustRel(fid, dR, why));
    offers += out.offers.length; calls += out.calls.length; logs += out.logs.length;
    for (const w of out.warsEnded) {
      if (w.a === 'player' || w.b === 'player') sim.endWar(w.a === 'player' ? w.b : w.a, true);
    }
    for (const f of sim.factions) {
      const R = sim.relations[f.id];
      ok(R >= REL_MIN && R <= REL_MAX, `ядро вышло за предел отношений: ${f.id} = ${R}`);
    }
  }
  ok(sim.villagers.length > 0, 'поселение вымерло — тест не о том');
  const st = warStats(s, sim.day);
  console.log(`   день ${sim.day}: событий дипломатии ${logs}, предложений ${offers}, призывов ${calls}`);
  console.log(`   войн ИИ завершено ${st.finished} (медиана ${st.median} дн.), активных ${st.active}, союзов ${s.alliances.length}`);
  console.log(`   отношения игрока: ${sim.factions.map(f => `${f.def.name.split(' ')[0]} ${Math.round(sim.relations[f.id])}`).join(' · ')}`);
});

console.log(`\n=== ${pass} OK / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
