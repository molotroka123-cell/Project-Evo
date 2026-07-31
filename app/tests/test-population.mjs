// Тесты модуля населения (U05/U06/U09/U10). Node, без DOM.
// Запуск: node app/tests/test-population.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as Pop from '../src/core/systems/population.js';
import { createRng } from '../src/core/rng.js';
import { Simulation } from '../src/core/simulation.js';
import { NAMES } from '../src/core/data.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('OK', name); } catch (e) { fail++; console.log('FAIL', name, '—', e.message); } };
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

const MODULE_PATH = fileURLToPath(new URL('../src/core/systems/population.js', import.meta.url));

// ---------- испытательный стенд: массив жителей без всякой симуляции ----------
function makeVillage(rng, state, n, minAge = 1700, maxAge = 4500) {
  const arr = [];
  for (let i = 0; i < n; i++) {
    arr.push({
      name: rng.pick(NAMES) + ' ' + rng.pick(['св', 'мд', 'дн', 'гл']),
      x: 0, y: 0, tx: 0, ty: 0, age: rng.int(minAge, maxAge),
      job: 'idle', target: null, path: null, busy: 0, hp: 100, home: null,
    });
  }
  Pop.syncVillagers(state, arr, rng);
  return arr;
}

// Прогон N дней. opts.famine = [from, to) — окно голода и уныния.
function runYears(seed, days, cap, opts = {}) {
  const rng = createRng(seed);
  const state = Pop.createPopulation(rng);
  let vs = makeVillage(rng, state, opts.start ?? 20);
  let minPop = Infinity, maxPop = 0, births = 0, deaths = 0;
  const byYear = [];
  for (let d = 1; d <= days; d++) {
    for (const v of vs) v.age++; // возраст двигает ядро — здесь имитируем его
    const bad = opts.famine && d >= opts.famine[0] && d < opts.famine[1];
    const rep = Pop.tickDay(state, vs, {
      day: d, housingCap: cap, pop: vs.length,
      happiness: bad ? 28 : 62, foodDays: bad ? 3 : 14,
      builtIds: [], buildable: [],
    }, rng);
    births += rep.born.length; deaths += rep.died.length;
    vs = vs.filter(v => v.hp > 0);
    minPop = Math.min(minPop, vs.length); maxPop = Math.max(maxPop, vs.length);
    if (d % 100 === 0) byYear.push({ year: d / 100, pop: vs.length, born: rep.born.length });
  }
  return { state, vs, pop: vs.length, minPop, maxPop, births, deaths, byYear };
}

function birthsBetween(state, y0, y1) {
  return state.yearBirths.filter(r => r.year >= y0 && r.year < y1).reduce((a, r) => a + r.born, 0);
}

// ================== U05: демография ==================

t('нет Math.random в модуле', () => {
  // комментарии отбрасываем: слово Math.random встречается в шапке модуля
  const src = readFileSync(MODULE_PATH, 'utf8').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  must(!/Math\.random/.test(src), 'найден Math.random — детерминизм сломан');
});

t('детерминизм: два прогона на одном сиде совпадают', () => {
  const a = runYears(777, 800, 60);
  const b = runYears(777, 800, 60);
  const snap = (r) => r.vs.map(v => `${v.pid}|${v.name}|${v.age}|${v.sex}|${v.trait}`).join(';');
  must(snap(a) === snap(b), 'популяции разошлись');
  must(a.births === b.births && a.deaths === b.deaths, 'рождения/смерти разошлись');
});

t('3000 дней на 5 сидах: не вымирает и не взрывается', () => {
  console.log('   сид   старт  итог  мин  макс  рожд  смерт  дети/взр/стар');
  for (const seed of [1, 7, 42, 1234, 99991]) {
    const r = runYears(seed, 3000, 80);
    const p = Pop.pyramid(r.vs);
    console.log(`   ${String(seed).padStart(5)}     20   ${String(r.pop).padStart(3)}  ${String(r.minPop).padStart(3)}  ${String(r.maxPop).padStart(4)}  ${String(r.births).padStart(4)}   ${String(r.deaths).padStart(4)}   ${p.children}/${p.adults}/${p.elders}`);
    must(r.minPop > 0, `сид ${seed}: поселение вымерло`);
    must(r.pop >= 10, `сид ${seed}: осталось ${r.pop} — вырождение`);
    must(r.maxPop <= 80, `сид ${seed}: пробит потолок жилья (${r.maxPop})`);
    must(r.pop > 20, `сид ${seed}: за 30 лет не выросло (${r.pop})`);
    must(p.children >= 1, `сид ${seed}: детей не осталось — следующего поколения не будет`);
  }
});

t('без потолка жилья рост остаётся человеческим (60 лет)', () => {
  for (const seed of [1, 42, 99991]) {
    const r = runYears(seed, 6000, 100000);
    must(r.pop > 25, `сид ${seed}: спад до ${r.pop}`);
    must(r.pop < 20 * 8, `сид ${seed}: демографический взрыв ${r.pop}`);
  }
});

t('демографическая яма: голод вырезает поколение', () => {
  for (const seed of [1, 42]) {
    const ctrl = runYears(seed, 3000, 100000);
    const pit = runYears(seed, 3000, 100000, { famine: [500, 1100] });
    const bornInPit = birthsBetween(pit.state, 5, 11);
    const bornCtrl = birthsBetween(ctrl.state, 5, 11);
    // Через 18 лет после голода недорождённые дети не становятся родителями.
    const echoPit = birthsBetween(pit.state, 23, 30);
    const echoCtrl = birthsBetween(ctrl.state, 23, 30);
    console.log(`   сид ${seed}: рождений в голод ${bornInPit} против ${bornCtrl}; ` +
      `эхо через поколение ${echoPit} против ${echoCtrl}; население ${pit.pop} против ${ctrl.pop}`);
    must(bornInPit < bornCtrl, `сид ${seed}: голод не снизил рождаемость`);
    must(echoPit < echoCtrl, `сид ${seed}: нет отложенного спада через поколение`);
    must(pit.pop < ctrl.pop, `сид ${seed}: население не пострадало`);
  }
});

t('поколения: дети рождаются младенцами и наследуют род', () => {
  const rng = createRng(5);
  const state = Pop.createPopulation(rng);
  let vs = makeVillage(rng, state, 24, 1800, 2600);
  let baby = null;
  for (let d = 1; d <= 1500 && !baby; d++) {
    for (const v of vs) v.age++;
    const rep = Pop.tickDay(state, vs, { day: d, housingCap: 60, pop: vs.length, happiness: 70, foodDays: 20, builtIds: [], buildable: [] }, rng);
    vs = vs.filter(v => v.hp > 0);
    if (rep.born.length) baby = rep.born[0];
  }
  must(baby, 'за 15 лет никто не родился');
  must(baby.age === 0, 'младенец родился не младенцем: ' + baby.age);
  must(baby.hp === 100 && baby.job === 'idle' && 'target' in baby, 'форма жителя несовместима с ядром');
  must(baby.trait && baby.pid && (baby.sex === 'м' || baby.sex === 'ж'), 'у ребёнка нет черты/пола/номера');
  const father = vs.find(v => v.pid === baby.parents[1]);
  must(father && baby.fam === father.fam, 'родовое прозвище не унаследовано');
  must(vs.includes(baby), 'ребёнок не попал в массив жителей');
});

// ================== U06: профессии и ранги ==================

t('ранги: 3 ранг даёт +45% и теряется не сразу', () => {
  const rng = createRng(11);
  const state = Pop.createPopulation(rng);
  const vs = makeVillage(rng, state, 1, 2500, 2500);
  const v = vs[0];
  v.trait = 'diligent'; // фиксируем черту, чтобы проверять чистую арифметику ранга
  const noDeath = { housingCap: 10, pop: 1, happiness: 60, foodDays: 20, mortalityMult: 0, builtIds: [], buildable: [] };
  const ranks = [];
  for (let d = 1; d <= 1200; d++) {
    Pop.registerWork(state, v, 'stone', 1);
    Pop.tickDay(state, vs, { ...noDeath, day: d }, rng);
    if (d === 150 || d === 450 || d === 1100) ranks.push(v.rank);
  }
  must(ranks.join(',') === '1,2,3', 'ранги растут неправильно: ' + ranks.join(','));
  must(v.prof === 'stone', 'профессия определилась неверно: ' + v.prof);
  const m = Pop.workMult(v, 'stone');
  must(Math.abs(m - 1.45 * 1.1) < 1e-9, 'множитель добычи ' + m.toFixed(3) + ' вместо 1.595');
  must(Math.abs(Pop.workMult(v, 'wood') - 1.1) < 1e-9, 'ранг ошибочно работает в чужой отрасли');
  must(v.deeds.some(s => /мастер/.test(s)), 'подвиг «мастер» не записан');

  // уходит в лесорубы: мастерство рудокопа тает медленно
  for (let d = 1201; d <= 1230; d++) {
    Pop.registerWork(state, v, 'wood', 1);
    Pop.tickDay(state, vs, { ...noDeath, day: d }, rng);
  }
  must(Pop.expToRank(v.exp.stone) === 3, 'ранг слетел через месяц — слишком быстро');
  for (let d = 1231; d <= 1500; d++) {
    Pop.registerWork(state, v, 'wood', 1);
    Pop.tickDay(state, vs, { ...noDeath, day: d }, rng);
  }
  must(Pop.expToRank(v.exp.stone) === 2, 'через год ранг рудокопа должен просесть до 2');
  must(v.prof === 'stone', 'профессия сменилась раньше, чем новое ремесло переросло старое');
  console.log(`   после года на лесопилке: рудокоп ${Pop.expToRank(v.exp.stone)} ранга, лесоруб ${Pop.expToRank(v.exp.wood)} ранга`);
});

t('отрасль здания определяется по таблице', () => {
  must(Pop.industryOfBuilding('farm') === 'food', 'ферма');
  must(Pop.industryOfBuilding('lumber') === 'wood', 'лесопилка');
  must(Pop.industryOfBuilding('mine') === 'stone', 'шахта');
  must(Pop.industryOfBuilding('university') === 'science', 'университет');
  must(Pop.industryOfBuilding('market') === 'gold', 'рынок');
  must(Pop.industryOfBuilding('granary') === null, 'амбар не отрасль');
});

// ================== U09: запросы ==================

t('запрос: просят доступное, награда за срок и штраф за провал', () => {
  const rng = createRng(3);
  const state = Pop.createPopulation(rng);
  const vs = makeVillage(rng, state, 14, 1800, 3200);
  const ctx = (day, built) => ({
    day, housingCap: 40, pop: vs.length, happiness: 40, foodDays: 12,
    mortalityMult: 0, builtIds: built, buildable: ['temple', 'clinic', 'market'],
  });
  let day = 0, issued = null;
  while (!issued && day < 300) { day++; for (const v of vs) v.age++; Pop.tickDay(state, vs, ctx(day, []), rng); issued = state.request; }
  must(issued, 'за 300 дней поселение ничего не попросило');
  must(['temple', 'clinic', 'market'].includes(issued.building), 'просят недоступное: ' + issued.building);
  const card = Pop.activeRequest(state);
  must(/просят/.test(card.text) && card.daysLeft > 0, 'карточка запроса пуста');
  console.log(`   день ${day}: ${card.text} (срок ${card.daysLeft} дн.)`);

  // выполняем вовремя
  day++;
  const rep = Pop.tickDay(state, vs, ctx(day, [issued.building]), rng);
  must(state.request === null && state.stats.requestsDone === 1, 'исполнение не засчитано');
  must(Pop.happyMod(state) > 5, 'счастье не выросло: ' + Pop.happyMod(state));
  must(rep.events.some(e => /исполнена/.test(e.text)), 'нет строки в журнале');

  // следующий запрос игнорируем до конца срока
  const moodAfterWin = Pop.happyMod(state);
  let failed = false, next = null;
  const built = [issued.building];
  while (!failed && day < 900) {
    day++;
    const r = Pop.tickDay(state, vs, ctx(day, built), rng);
    if (state.request) next = state.request;
    if (r.events.some(e => /так и не дождались/.test(e.text))) failed = true;
  }
  must(next && failed, 'провал срока не наступил');
  must(state.stats.requestsFailed === 1, 'провал не учтён');
  must(Pop.happyMod(state) < 0 && Pop.happyMod(state) < moodAfterWin, 'штрафа за игнор нет');
  console.log(`   провалена просьба о «${next.building}», настроение ${Pop.happyMod(state)}`);
});

// ================== U10: именные жители ==================

t('именной житель: имя, черта, история, некролог', () => {
  const rng = createRng(21);
  const state = Pop.createPopulation(rng);
  const vs = makeVillage(rng, state, 1, 6800, 6800);
  const v = vs[0];
  v.children = 3;
  for (let d = 1; d <= 500; d++) { Pop.registerWork(state, v, 'wood', 1); Pop.tickDay(state, vs, { day: d, housingCap: 5, pop: 1, happiness: 60, foodDays: 20, mortalityMult: 0, builtIds: [], buildable: [] }, rng); }
  Pop.recordDeed(v, 'отбил рейд у частокола');
  const card = Pop.villagerCard(v);
  must(card.title === v.name && card.lines.length >= 5, 'карточка жителя неполна');
  must(card.lines.some(l => /лесоруб/.test(l)), 'ремесло не показано');
  must(card.lines.some(l => /Характер/.test(l)), 'черта не показана');
  const text = Pop.obituary(v, 'age');
  must(text.includes(v.name), 'в некрологе нет имени');
  must(text.includes(`${Pop.ageYears(v)} `), 'в некрологе нет возраста: ' + text);
  must(/лесоруб/.test(text), 'в некрологе нет ремесла');
  must(/(вырастил|вырастила) 3 ребёнка/.test(text), 'в некрологе нет детей');
  must(/рейд/.test(text), 'в некрологе нет подвига');
  console.log('   ' + text);
  console.log('   ' + card.lines.join(' · '));
  must(Pop.plural(1, 'год', 'года', 'лет') === 'год' && Pop.plural(3, 'год', 'года', 'лет') === 'года' && Pop.plural(11, 'год', 'года', 'лет') === 'лет', 'склонение лет сломано');
});

t('смерть от старости попадает в журнал осмысленной строкой', () => {
  const rng = createRng(4);
  const state = Pop.createPopulation(rng);
  let vs = makeVillage(rng, state, 30, 8000, 9500);
  let line = null;
  for (let d = 1; d <= 600 && !line; d++) {
    for (const v of vs) v.age++;
    const rep = Pop.tickDay(state, vs, { day: d, housingCap: 40, pop: vs.length, happiness: 60, foodDays: 15, builtIds: [], buildable: [] }, rng);
    vs = vs.filter(v => v.hp > 0);
    const bad = rep.events.find(e => e.type === 'bad');
    if (bad) line = bad.text;
  }
  must(line, 'за 6 лет ни один старик не умер');
  must(/☠/.test(line) && /(год|года|лет)/.test(line), 'строка журнала не осмысленна: ' + line);
  console.log('   ' + line);
});

// ================== Сохранение ==================

t('сериализация переживает JSON и продолжается один в один', () => {
  const rng = createRng(88);
  const state = Pop.createPopulation(rng);
  let vs = makeVillage(rng, state, 18);
  const ctx = (d, pop) => ({ day: d, housingCap: 50, pop, happiness: 60, foodDays: 14, builtIds: [], buildable: ['temple'] });
  for (let d = 1; d <= 700; d++) { for (const v of vs) v.age++; Pop.tickDay(state, vs, ctx(d, vs.length), rng); vs = vs.filter(v => v.hp > 0); }

  const dump = JSON.parse(JSON.stringify(Pop.serialize(state, vs)));
  const clones = vs.map(v => ({ name: v.name, x: v.x, y: v.y, tx: v.x, ty: v.y, age: v.age, hp: v.hp, job: 'idle', target: null, path: null, busy: 0 }));
  const rngA = createRng(1000), rngB = createRng(1000);
  const restored = Pop.deserialize(dump, clones, rngB);
  must(restored.nextPid === state.nextPid, 'счётчик номеров потерян');
  must(clones[0].pid === vs[0].pid && clones[0].trait === vs[0].trait, 'поля жителя не восстановлены');
  must(JSON.stringify(clones[0].exp) === JSON.stringify(vs[0].exp), 'опыт ремесла потерян');
  must(clones.filter(v => v.partner).length === vs.filter(v => v.partner).length, 'пары потеряны');

  let a = vs, b = clones;
  for (let d = 701; d <= 900; d++) {
    for (const v of a) v.age++; for (const v of b) v.age++;
    Pop.tickDay(state, a, ctx(d, a.length), rngA);
    Pop.tickDay(restored, b, ctx(d, b.length), rngB);
    a = a.filter(v => v.hp > 0); b = b.filter(v => v.hp > 0);
  }
  must(a.length === b.length, `после загрузки разошлось: ${a.length} против ${b.length}`);
  must(a.map(v => v.pid).join() === b.map(v => v.pid).join(), 'состав жителей разошёлся');
});

// ================== Совместимость с ядром ==================

t('работает поверх живой Simulation, не ломая ядро', () => {
  const drive = (seed) => {
    const sim = new Simulation(seed);
    sim.execCommand('give wood 300'); sim.execCommand('give food 400');
    sim.placeBuilding('hut', 44, 44); sim.placeBuilding('forager', 45, 45);
    const state = Pop.createPopulation(sim.rng);
    Pop.syncVillagers(state, sim.villagers, sim.rng);
    let last = sim.day;
    for (let i = 0; i < 800; i++) {
      sim.tick(0.5);
      if (sim.day === last) continue;
      last = sim.day;
      Pop.tickDay(state, sim.villagers, {
        day: sim.day, housingCap: sim.housingCap(), pop: sim.villagers.length,
        happiness: sim.happiness(), foodDays: sim.res.food / Math.max(1, sim.villagers.length * 0.7),
        builtIds: sim.doneBuildings().map(b => b.id), buildable: ['hut', 'granary', 'story_fire'],
        homeX: sim.world.startX, homeY: sim.world.startY,
      }, sim.rng);
      sim.villagers = sim.villagers.filter(v => v.hp > 0);
    }
    return { sim, state };
  };
  const a = drive(2026), b = drive(2026);
  must(a.sim.villagers.length > 0, 'ядро осталось без жителей');
  must(a.sim.villagers.every(v => typeof v.age === 'number' && v.age >= 0), 'поле v.age испорчено');
  must(a.sim.villagers.every(v => v.pid && v.trait), 'не все жители получили карточку модуля');
  must(a.sim.villagers.length === b.sim.villagers.length, 'детерминизм ядра с модулем нарушен');
  must(Math.abs(a.sim.res.food - b.sim.res.food) < 1e-9, 'ресурсы разошлись');
  console.log(`   день ${a.sim.day}: жителей ${a.sim.villagers.length}, рождений ${a.state.stats.births}, смертей ${a.state.stats.deaths}`);
});

console.log(`\nИтого: ${pass} прошло, ${fail} упало`);
process.exit(fail ? 1 : 0);
