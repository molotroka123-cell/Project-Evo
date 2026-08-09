// Тесты связи «выживание → держава» (link_survival.js).
// Запуск: node app/tests/test-link-survival.mjs
//
// Проверяем не «функция не упала», а числа: направление связи, точные величины,
// потолки петель и молчание при спокойном ходе дел.
import { Simulation } from '../src/core/simulation.js';
import {
  survivalLinks, survivalBreakdown, survivalState, survivalHappyMod,
  createSurvivalMemory, restoreSurvivalMemory,
  EAT, FOOD_ALARM, FOOD_PLENTY, HUNGER_STAB, HUNGER_FATIGUE, COLD_STAB,
  SICK_STAB, DEATH_STAB, DEATH_STAB_CAP, STAB_DROP_FLOOR,
  CALM_STAB_GAIN, CALM_STAB_MIN, CALM_STAB_CEILING, CALM_COLD_CAP,
  PANIC_STAB, PANIC_HAPPY_MAX, RIOT_DAYS, REVOLT_DAYS, REVOLT_STAB,
  RIOT_COOLDOWN, RIOT_STAB_SHOCK, REVOLT_STAB_SHOCK, RIOT_FOOD_LOSS,
  ESTATE_HUNGER, ESTATE_DROP_CAP, CITY_UNREST_PER_DAY,
} from '../src/core/systems/link_survival.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('OK', name); } catch (e) { fail++; console.log('FAIL', name, '—', e.message); } };
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const near = (a, b, eps, msg) => ok(Math.abs(a - b) <= eps, `${msg}: ${a} ≠ ${b}`);
const f1 = (v) => (Math.round(v * 10) / 10).toFixed(1);

// ---------------------------------------------------------------- вспомогательное

// Поддельный sim: связь читает только эти поля, и подделка позволяет ставить
// ровно то состояние, которое проверяется, без прогона тысячи игровых дней.
function makeSim(o = {}) {
  const pop = o.pop ?? 20;
  const days = o.foodDays ?? 7;                  // запас еды именно в днях
  return {
    day: o.day ?? 100,
    villagers: Array.from({ length: pop }, (_, i) => ({ name: `Житель ${i}`, hp: 100 })),
    res: { food: o.food != null ? o.food : pop * EAT * days, wood: 100, gold: 50 },
    buildings: (o.buildings || []).map(id => ({ id, done: true, destroyed: false })),
    techs: new Set(o.techs || []),
    world: { startX: 50, startY: 50 },
    sys: {
      winter: { cold: o.cold ?? 0, sick: o.sick ?? 0, happy: o.winterHappy ?? 0 },
      winterReport: { deathCount: o.deaths ?? 0 },
    },
    politics: {
      state: {
        stability: o.stability ?? 60,
        factions: { nobles: 55, clergy: 55, merchants: 55, commons: 55, military: 55 },
      },
    },
    empire: o.cities ? { state: { cities: o.cities, lost: [] } } : null,
    linkSurvival: o.mem || null,
  };
}

// Тот же день, что уже записан в памяти: счётчики не двигаются, и видно чистую
// формулу без надбавки за усталость от голода.
function frozenDay(o = {}) {
  const sim = makeSim(o);
  sim.linkSurvival = { ...createSurvivalMemory(), day: sim.day, ...(o.mem || {}) };
  return sim;
}

function city(id, name, x, y, unrest = 0) {
  return { id, name, x, y, pop: 10, unrest, happy: 40, local: { food: 20, wood: 10 }, buildings: [], spec: null };
}

// Прогон N суток подряд: связь применяется как в integrate.js — новая память
// возвращается наружу, мир при этом не меняется (проверяем связь, не ядро).
function runDays(sim, n, onDay = null) {
  const out = [];
  for (let i = 0; i < n; i++) {
    sim.day++;
    if (onDay) onDay(sim, i);
    const r = survivalLinks(sim);
    sim.linkSurvival = r.flags.memory;
    out.push(r);
  }
  return out;
}

// ---------------------------------------------------------------- 1. молчание

t('спокойный день не даёт ни одной поправки', () => {
  const r = survivalLinks(makeSim({ foodDays: 7, cold: 0, sick: 0, stability: 60 }));
  ok(r.mods.stability === 0, `спокойный день двигает стабильность: ${r.mods.stability}`);
  ok(r.mods.happy === 0, `спокойный день двигает счастье: ${r.mods.happy}`);
  ok(r.mods.stabilityShock === 0 && r.mods.foodPct === 0, 'разовые удары на ровном месте');
  ok(r.mods.cityUnrest === 0, 'колонии волнуются без причины');
  for (const [fid, v] of Object.entries(r.mods.estates)) ok(v === 0, `сословие ${fid} двинулось без повода: ${v}`);
  ok(r.events.length === 0, `лишние сообщения: ${r.events.map(e => e.text).join(' | ')}`);
  ok(r.flags.stage === 'ok' && !r.flags.starving, 'ступень не «ok» при полных амбарах');
  ok(survivalBreakdown(makeSim({})).rows.length === 0, 'разбор придумал строки на пустом месте');
});

// ---------------------------------------------------------------- 2. голод → стабильность

t('голод валит стабильность, и тем сильнее, чем меньше еды', () => {
  const at = (d) => survivalLinks(frozenDay({ foodDays: d })).mods.stability;
  const d6 = at(6), d5 = at(FOOD_ALARM), d25 = at(2.5), d0 = at(0);
  ok(d6 === 0 && d5 === 0, `запас в ${FOOD_ALARM} дн. уже наказывается: ${d5}`);
  // Формула: −HUNGER_STAB × доля недостачи. Половина порога — половина удара.
  near(d25, -HUNGER_STAB / 2, 0.01, 'половина порога даёт не половину удара');
  near(d0, -HUNGER_STAB, 0.01, 'пустой склад даёт не полный удар');
  ok(d0 < d25 && d25 < d5, `монотонность нарушена: ${d0} / ${d25} / ${d5}`);
  console.log(`   запас 6/5/2.5/0 дн. → ${f1(d6)} / ${f1(d5)} / ${f1(d25)} / ${f1(d0)} стабильности в день`);
});

t('затянувшийся голод бьёт больнее свежего, но надбавка имеет потолок', () => {
  const fresh = survivalLinks(frozenDay({ foodDays: 0, mem: { hungerDays: 0 } })).mods.stability;
  const week = survivalLinks(frozenDay({ foodDays: 0, mem: { hungerDays: RIOT_DAYS } })).mods.stability;
  const month = survivalLinks(frozenDay({ foodDays: 0, mem: { hungerDays: 90 } })).mods.stability;
  near(fresh, -HUNGER_STAB, 0.01, 'первый голодный день считается с надбавкой');
  near(week, -HUNGER_STAB * (1 + HUNGER_FATIGUE), 0.01, 'к бунту усталость не набрала полной силы');
  ok(month === week, `надбавка за усталость растёт без потолка: ${month} против ${week}`);
});

// ---------------------------------------------------------------- 3. мороз и болезни

t('мороз валит стабильность и упирается в потолок на пороге смертей', () => {
  const at = (c) => survivalLinks(frozenDay({ cold: c })).mods.stability;
  ok(at(0) === 0, 'тёплая зима что-то отнимает');
  near(at(2.5), -COLD_STAB / 2, 0.01, 'половина пути до смертей — не половина штрафа');
  near(at(5), -COLD_STAB, 0.01, 'порог смертей даёт не полный штраф');
  ok(at(12) === at(5), `штраф от мороза растёт выше потолка: ${at(12)}`);
});

t('болезни и похороны считаются отдельно, лечебница смягчает оба', () => {
  const bare = survivalLinks(frozenDay({ pop: 20, sick: 5, deaths: 2 })).mods.stability;
  const cured = survivalLinks(frozenDay({ pop: 20, sick: 5, deaths: 2, buildings: ['clinic'] })).mods.stability;
  // Четверть слегла = полный SICK_STAB; двое похорон = 2 × DEATH_STAB под потолком.
  near(bare, -(SICK_STAB + Math.min(DEATH_STAB_CAP, 2 * DEATH_STAB)), 0.01, 'без лечебницы счёт неверен');
  ok(cured > bare, `лечебница не смягчила: ${cured} против ${bare}`);
  ok(cured < 0, 'лечебница отменила беду целиком — так нельзя');
  // Смягчение ровно половинное от careMult лечебницы (0.5): careSoft = 0.75.
  // Полный careMult обнулил бы тревогу от мора, и механика исчезла бы из игры.
  near(cured, bare * 0.75, 0.01, 'смягчение лечебницей посчитано не по careSoft');
  console.log(`   мор 5/20 + двое похорон: без лечебницы ${f1(bare)}, с лечебницей ${f1(cured)}`);
});

t('беды складываются, но дневное падение ограничено потолком', () => {
  const r = survivalLinks(frozenDay({
    pop: 20, foodDays: 0, cold: 12, sick: 20, deaths: 2, mem: { hungerDays: 90 },
  }));
  ok(r.mods.stability === STAB_DROP_FLOOR, `нет потолка падения: ${r.mods.stability}`);
  ok(r.flags.stage === 'crisis', 'при полном развале ступень не «crisis»');
  // Сумма без потолка заведомо глубже — иначе проверка потолка ничего не значит.
  const raw = -HUNGER_STAB * 1.5 - COLD_STAB - SICK_STAB - DEATH_STAB_CAP;
  ok(raw < STAB_DROP_FLOOR, `потолок не срабатывает: сырая сумма ${f1(raw)}`);
});

// ---------------------------------------------------------------- 4. сословия

t('голод и стужа бьют по сословиям по-разному и в минус', () => {
  const e = survivalLinks(frozenDay({ foodDays: 0 })).mods.estates;
  near(e.commons, -ESTATE_HUNGER.commons, 0.01, 'простолюдины недооценены');
  near(e.nobles, -ESTATE_HUNGER.nobles, 0.01, 'знать недооценена');
  ok(e.commons < e.military && e.military < e.nobles, `порядок страданий неверен: ${JSON.stringify(e)}`);
  ok(e.clergy === 0, 'жрецы страдают от голода, хотя таблица этого не велит');
  const cold = survivalLinks(frozenDay({ cold: 5 })).mods.estates;
  ok(cold.commons < 0 && cold.merchants === 0, `стужа задела не тех: ${JSON.stringify(cold)}`);
});

t('падение одобрения за сутки имеет потолок', () => {
  const e = survivalLinks(frozenDay({ pop: 20, foodDays: 0, cold: 12, sick: 20 })).mods.estates;
  ok(e.commons === -ESTATE_DROP_CAP, `нет потолка у сословий: ${e.commons}`);
  for (const v of Object.values(e)) ok(v >= -ESTATE_DROP_CAP, `сословие пробило потолок: ${v}`);
});

// ---------------------------------------------------------------- 5. обратная связь

t('изобилие и порядок дают порядок обратно, но не выше потолка', () => {
  const rich = survivalLinks(frozenDay({ foodDays: FOOD_PLENTY * 2, stability: 80 }));
  // ease = 0.6 × доверие(0.333) + 0.4 × амбары(1.0) = 0.6
  near(rich.mods.stability, CALM_STAB_GAIN * 0.6, 0.01, 'сытая держава не успокаивается');
  const low = survivalLinks(frozenDay({ foodDays: FOOD_PLENTY * 2, stability: CALM_STAB_MIN - 1 }));
  ok(low.mods.stability === 0, `бонус выдан ниже порога доверия: ${low.mods.stability}`);
  const top = survivalLinks(frozenDay({ foodDays: FOOD_PLENTY * 2, stability: CALM_STAB_CEILING + 2 }));
  ok(top.mods.stability === 0, `бонус не выключается у потолка: ${top.mods.stability}`);
  const hungryButCalm = survivalLinks(frozenDay({ foodDays: FOOD_PLENTY - 1, stability: 85 }));
  ok(hungryButCalm.mods.stability === 0, 'бонус выдан без запасов');
});

t('сытые и уверенные легче переносят мороз, но подарков без мороза нет', () => {
  const cold = survivalLinks(frozenDay({ foodDays: 24, stability: 80, winterHappy: -20, cold: 3 }));
  near(cold.mods.happy, 20 * 0.4 * 0.6, 0.01, 'смягчение мороза посчитано неверно');
  const capped = survivalLinks(frozenDay({ foodDays: 24, stability: 100, winterHappy: -30, cold: 3 }));
  ok(capped.mods.happy <= CALM_COLD_CAP, `смягчение пробило потолок: ${capped.mods.happy}`);
  const summer = survivalLinks(frozenDay({ foodDays: 24, stability: 80, winterHappy: 0 }));
  ok(summer.mods.happy === 0, `счастье выдано без мороза: ${summer.mods.happy}`);
});

t('шатающаяся власть делает тот же мороз тяжелее', () => {
  const panic = survivalLinks(frozenDay({ cold: 5, stability: 10 }));
  near(panic.mods.happy, -PANIC_HAPPY_MAX * ((PANIC_STAB - 10) / PANIC_STAB), 0.01, 'паника посчитана неверно');
  const steady = survivalLinks(frozenDay({ cold: 5, stability: 60 }));
  ok(steady.mods.happy === 0, `паника при твёрдой власти: ${steady.mods.happy}`);
  const noWinter = survivalLinks(frozenDay({ cold: 0, stability: 5 }));
  ok(noWinter.mods.happy === 0, `паника без мороза: ${noWinter.mods.happy}`);
  // Поправка доезжает до happiness() через память, а не пересчётом каждый кадр.
  const sim = frozenDay({ cold: 5, stability: 10 });
  sim.linkSurvival = survivalLinks(sim).flags.memory;
  ok(survivalHappyMod(sim) === Math.round(panic.mods.happy), 'happiness() получит не ту поправку');
});

// ---------------------------------------------------------------- 6. лестница волнений

t('неделя без хлеба поднимает хлебный бунт ровно на своих сутках', () => {
  const sim = makeSim({ foodDays: 0, stability: 40, day: 0 });
  const days = runDays(sim, RIOT_DAYS + 2);
  const riots = days.map((r, i) => (r.flags.riot ? i + 1 : 0)).filter(Boolean);
  ok(riots.length === 1 && riots[0] === RIOT_DAYS, `бунт не на ${RIOT_DAYS}-е сутки: ${riots.join(',')}`);
  const r = days[RIOT_DAYS - 1];
  ok(r.mods.stabilityShock === RIOT_STAB_SHOCK, `разовый удар не тот: ${r.mods.stabilityShock}`);
  ok(r.mods.foodPct === RIOT_FOOD_LOSS, `амбары не пострадали: ${r.mods.foodPct}`);
  ok(r.events.some(e => /бунт/i.test(e.text)), 'бунт молчит в журнале');
  // Предупреждение приходит РАНЬШЕ бунта — иначе игроку нечего успеть.
  const warnAt = days.findIndex(d => d.events.some(e => /ропот/i.test(e.text)));
  ok(warnAt >= 0 && warnAt < RIOT_DAYS - 1, `предупреждение не опередило бунт: ${warnAt}`);
});

t('после бунта есть откат: второй бунт подряд невозможен', () => {
  const sim = makeSim({ foodDays: 0, stability: 40, day: 0 });
  const days = runDays(sim, RIOT_DAYS + RIOT_COOLDOWN - 1);
  const count = days.filter(r => r.flags.riot || r.flags.revolt).length;
  ok(count === 1, `за откат случилось ${count} волнений вместо одного`);
  // Счётчик после бунта уполовинен: пар выпущен, но голод остался.
  ok(days[RIOT_DAYS - 1].flags.hungerDays === Math.floor(RIOT_DAYS / 2),
    `счётчик после бунта: ${days[RIOT_DAYS - 1].flags.hungerDays}`);
  // Второй бунт приходит ровно по выходе отката, и счётчик к тому времени давно
  // за порогом — обратный отсчёт «сколько ещё дней терпеть» ушёл бы в минус.
  const more = runDays(sim, 4);
  ok(more[0].flags.riot, `второй бунт не на ${RIOT_COOLDOWN}-е сутки отката`);
  const all = [...days, ...more].flatMap(r => r.events);
  const bad = all.filter(e => /Ещё -/.test(e.text));
  ok(bad.length === 0, `отрицательный отсчёт в тексте: ${bad.map(e => e.text).join(' | ')}`);
  ok(all.some(e => /затишья/.test(e.text)), 'на откате игроку не сказано, почему бунта нет');
});

t('долгий голод при шаткой власти поднимает восстание и отнимает город', () => {
  const cities = [city(1, 'Ближний', 55, 50, 0), city(2, 'Дальний', 90, 90, 4)];
  const sim = makeSim({ foodDays: 0, stability: REVOLT_STAB - 5, day: 0, cities });
  const days = runDays(sim, 60);
  const rev = days.find(r => r.flags.revolt);
  ok(rev, 'восстание не случилось за 60 суток голода при стабильности ниже порога');
  ok(rev.flags.cityLost && rev.flags.cityLost.name === 'Дальний',
    `отпал не тот город: ${rev.flags.cityLost && rev.flags.cityLost.name}`);
  ok(rev.mods.stabilityShock === REVOLT_STAB_SHOCK, `удар восстания не тот: ${rev.mods.stabilityShock}`);
  ok(rev.flags.hungerDays === 0, 'счётчик голода не сброшен — из петли нет выхода');
  ok(rev.events.some(e => /ВОССТАНИЕ/.test(e.text) && /Дальний/.test(e.text)), 'восстание не названо словами');
  const revolts = days.filter(r => r.flags.revolt).length;
  ok(revolts === 1, `за 60 суток ${revolts} восстаний — откат не работает`);
});

t('крепкая власть не даёт восстания даже при том же голоде', () => {
  const sim = makeSim({ foodDays: 0, stability: REVOLT_STAB + 20, day: 0, cities: [city(1, 'Дальний', 90, 90, 4)] });
  const days = runDays(sim, REVOLT_DAYS + 20);
  ok(!days.some(r => r.flags.revolt), 'восстание при стабильности выше порога');
  ok(days.some(r => r.flags.riot), 'бунта нет вовсе — связь не работает');
});

// ---------------------------------------------------------------- 7. колонии

t('голод в столице разгоняет сепаратизм колоний', () => {
  const calm = survivalLinks(frozenDay({ foodDays: 4 }));           // недостача 0.2 — колонии не в счёт
  ok(calm.mods.cityUnrest === 0, `колонии волнуются от лёгкой недостачи: ${calm.mods.cityUnrest}`);
  const hard = survivalLinks(frozenDay({ foodDays: 0 }));
  near(hard.mods.cityUnrest, CITY_UNREST_PER_DAY, 0.01, 'полный голод не разгоняет сепаратизм');
  const half = survivalLinks(frozenDay({ foodDays: FOOD_ALARM / 2 }));
  near(half.mods.cityUnrest, CITY_UNREST_PER_DAY / 2, 0.01, 'половина голода — не половина сепаратизма');
});

// ---------------------------------------------------------------- 8. чистота и текст

t('связь ничего не меняет в мире и не считает один день дважды', () => {
  const sim = makeSim({ foodDays: 0, cold: 6, sick: 4, deaths: 1, stability: 30, cities: [city(1, 'Даль', 80, 80, 3)] });
  const before = JSON.stringify({ res: sim.res, pol: sim.politics.state, win: sim.sys.winter, cities: sim.empire.state });
  const a = survivalLinks(sim);
  const after = JSON.stringify({ res: sim.res, pol: sim.politics.state, win: sim.sys.winter, cities: sim.empire.state });
  ok(before === after, 'связь мутировала состояние — это запрещено');
  ok(sim.linkSurvival == null, 'связь записала память сама, а должна вернуть её наружу');
  // Второй вызов в тот же день: счётчик стоит, разовых ударов нет.
  sim.linkSurvival = a.flags.memory;
  const b = survivalLinks(sim);
  ok(b.flags.hungerDays === a.flags.hungerDays, `счётчик крутится дважды за день: ${a.flags.hungerDays} → ${b.flags.hungerDays}`);
  ok(b.mods.stabilityShock === 0 && b.events.length === 0, 'повторный вызов сказал всё второй раз');
});

t('игрок читает причину словами и числами', () => {
  const sim = frozenDay({ pop: 20, foodDays: 2, cold: 6, sick: 5, deaths: 1 });
  const br = survivalBreakdown(sim);
  ok(br.rows.length === 4, `в разборе ${br.rows.length} строк вместо четырёх`);
  ok(/Голод/.test(br.text) && /Стужа/.test(br.text) && /Больные/.test(br.text) && /Похороны/.test(br.text),
    `в тексте не все причины: ${br.text}`);
  ok(/2\.0 дн/.test(br.text), `в тексте нет запаса в днях: ${br.text}`);
  near(br.total, br.rows.reduce((a, r) => a + r.v, 0), 0.02, 'итог не равен сумме строк');
  ok(br.total < 0 && br.stage === 'crisis', `ступень не та: ${br.stage}`);
  // Сработавший потолок не прячется, а показывается отдельной строкой — и итог
  // по-прежнему сходится с суммой строк.
  const worst = survivalBreakdown(frozenDay({ pop: 20, foodDays: 0, cold: 12, sick: 20, deaths: 2, mem: { hungerDays: 90 } }));
  ok(worst.rows.some(r => /Предел/.test(r.ru)), `потолок сработал молча: ${worst.text}`);
  near(worst.total, worst.rows.reduce((a, r) => a + r.v, 0), 0.02, 'при потолке итог не равен сумме строк');
  ok(worst.total === STAB_DROP_FLOOR, `итог при потолке не равен пределу: ${worst.total}`);
  // Разбор для HUD память не двигает — его зовут каждый кадр.
  const memBefore = JSON.stringify(sim.linkSurvival);
  survivalBreakdown(sim); survivalBreakdown(sim);
  ok(JSON.stringify(sim.linkSurvival) === memBefore, 'разбор для HUD двигает память');
  ok(/спокойна/.test(survivalBreakdown(makeSim({})).text), 'на спокойный день нет внятной строки');
});

t('сообщение о смене ступени приходит один раз, а не каждый день', () => {
  const sim = makeSim({ foodDays: 1, stability: 60, day: 0 });
  const days = runDays(sim, 6);
  const shouts = days.filter(r => r.events.some(e => /в день/.test(e.text))).length;
  ok(shouts === 1, `о падении порядка сказано ${shouts} раз вместо одного`);
  // Голод кончился — приходит ровно одно сообщение об облегчении.
  const relief = runDays(sim, 5, (s) => { s.res.food = s.villagers.length * EAT * 20; });
  const good = relief.filter(r => r.events.some(e => e.type === 'good')).length;
  ok(good === 1, `об облегчении сказано ${good} раз вместо одного`);
});

// ---------------------------------------------------------------- 9. края и сейв

t('крайние случаи не роняют связь', () => {
  ok(survivalLinks({}).mods.stability === 0, 'пустой sim роняет связь');
  const empty = survivalLinks(makeSim({ pop: 0, food: 0 }));
  ok(empty.mods.stability === 0 && empty.mods.estates.commons === 0, 'вымершее поселение всё ещё бунтует');
  const noEmpire = survivalLinks(frozenDay({ foodDays: 0, stability: 5, mem: { hungerDays: 90, day: 0 }, day: 1 }));
  ok(noEmpire.flags.cityLost === null, 'без колоний нашёлся город к потере');
  const st = survivalState(makeSim({ pop: 0 }));
  ok(st.foodDays === Infinity && st.hunger === 0, 'запас на нулевом населении посчитан неверно');
});

t('память связи переживает сейв', () => {
  const m = createSurvivalMemory();
  m.hungerDays = 7; m.riotCd = 12; m.stage = 'crisis'; m.warned = true; m.riots = 2; m.happyMod = -3;
  const back = restoreSurvivalMemory(JSON.parse(JSON.stringify(m)));
  ok(back.hungerDays === 7 && back.riotCd === 12 && back.stage === 'crisis' && back.riots === 2,
    'память не восстановилась');
  ok(restoreSurvivalMemory(null).hungerDays === 0, 'старый сейв без поля не грузится');
  ok(restoreSurvivalMemory({ hungerDays: -5, stage: 'мусор' }).stage === 'ok', 'мусор из сейва прошёл насквозь');
});

t('связь работает на настоящей Simulation', () => {
  const sim = new Simulation(4242);
  const r = survivalLinks(sim);
  ok(r.flags.stage === 'ok', `свежая партия сразу в кризисе: ${r.flags.stage}`);
  ok(r.mods.stability === 0, `свежая партия что-то теряет: ${r.mods.stability}`);
  ok(Object.keys(r.mods.estates).length === 5, 'сословия не совпали с politics.js');
  // Отнимаем еду — связь обязана это увидеть на реальном объекте.
  sim.res.food = 0;
  const hungry = survivalLinks(sim);
  ok(hungry.mods.stability < 0 && hungry.mods.estates.commons < 0,
    `пустой склад на настоящей Simulation не заметен: ${JSON.stringify(hungry.mods)}`);
  ok(/Голод/.test(survivalBreakdown(sim).text), 'причина на настоящей Simulation не названа');
  console.log(`   настоящая партия без еды: ${f1(hungry.mods.stability)} стабильности в день, простолюдины ${hungry.mods.estates.commons}`);
});

console.log(`\n=== ${pass} OK / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
