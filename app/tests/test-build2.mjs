// Тесты строительства (build2.js). Запуск: node app/tests/test-build2.mjs
//
// Три поколения улучшений проверяются по отдельности: чертежи и очередь,
// разум при постановке, улучшение и износ.
import { readFileSync } from 'node:fs';
import { Simulation } from '../src/core/simulation.js';
import { BUILDINGS, TILE } from '../src/core/data.js';
import {
  createBuild, restoreBuild, serializeBuild,
  canPlan, plan, planArea, cancelPlan, movePlan, queueReport,
  scoreSpot, bestSpots,
  UPGRADE, upgradeTarget, upgradeCost, canUpgrade, upgrade,
  wearPerDay, wearWorkMult, repairList, repairCost, repair, repairAll,
  buildNewDay,
  QUEUE_MAX, SCAN_R, REPAIR_THRESHOLD, REPAIR_CRITICAL, UPGRADE_OVERHEAD,
} from '../src/core/systems/build2.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('OK ', name); } catch (e) { fail++; console.log('FAIL', name, '—', e.message); } };
const ok = (c, m) => { if (!c) throw new Error(m); };
const near = (a, b, eps, m) => ok(Math.abs(a - b) <= eps, `${m}: ${a} ≠ ${b}`);

// Настоящая партия: подделка тут не годится, потому что модуль опирается на
// canPlace, lackCost и payCost ядра, и подменять их значило бы проверять не то.
function game(seed = 4242, era = 0) {
  const s = new Simulation(seed, { startEra: era });
  s.execCommand('godmode');
  s.execCommand('unlockall');
  for (const r of ['wood', 'stone', 'gold', 'steel', 'food']) s.execCommand(`give ${r} 99999`);
  s.godmode = false;                 // цены снова настоящие, технологии открыты
  return s;
}
// Свободная клетка рядом со стартом, куда точно можно поставить хижину.
function freeSpot(sim, id = 'hut') {
  const cx = Math.round(sim.world.startX), cy = Math.round(sim.world.startY);
  for (let r = 2; r < 20; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      if (sim.canPlace(id, cx + dx, cy + dy).ok) return { x: cx + dx, y: cy + dy };
    }
  }
  return null;
}

console.log('--- Таблица улучшений ведёт в существующие здания ---');
{
  // Первая версия таблицы содержала путь lumber → sawmill, а такого здания в
  // игре нет: улучшение молча ничего не делало бы. Эта проверка ловит опечатку
  // и выдуманное здание раньше, чем игрок.
  t('все пути улучшения существуют', () => {
    const bad = Object.entries(UPGRADE).filter(([f, to]) => !BUILDINGS[f] || !BUILDINGS[to]);
    ok(bad.length === 0, `битые пути: ${JSON.stringify(bad)}`);
  });
  t('улучшение не ведёт само в себя', () => {
    const loop = Object.entries(UPGRADE).filter(([f, to]) => f === to);
    ok(loop.length === 0, JSON.stringify(loop));
  });
  t('цепочка жилья идёт вверх по вместимости', () => {
    let id = 'hut', prev = BUILDINGS.hut.housing;
    while (UPGRADE[id]) {
      id = UPGRADE[id];
      const h = BUILDINGS[id].housing;
      ok(h > prev, `${id}: вместимость ${h} не больше прежней ${prev}`);
      prev = h;
    }
  });
}

console.log('\n--- Поколение 1: чертёж не требует денег ---');
{
  const sim = game();
  const st = createBuild();
  // Место ищем ПОКА СКЛАД ПОЛОН: canPlace проверяет и ресурсы тоже, и на
  // пустом складе он не одобрит ни одной клетки — искать было бы негде.
  const p = freeSpot(sim);
  ok(p, 'не нашлось свободного места');
  sim.res.wood = 0; sim.res.stone = 0; sim.res.gold = 0; sim.res.steel = 0;

  t('поставить здание при пустом складе НЕЛЬЗЯ',
    () => ok(!sim.canPlace('hut', p.x, p.y).ok, 'ядро разрешило стройку без ресурсов'));
  t('а чертёж — можно: он для того и нужен', () => {
    const r = plan(st, sim, 'hut', p.x, p.y);
    ok(r.ok, r.reason);
  });
  t('чертёж помнит, чего ждёт',
    () => ok(/Не хватает/.test(queueReport(st, sim).rows[0].why), queueReport(st, sim).rows[0].why));
  t('склад не тронут', () => near(sim.res.wood, 0, 1e-9, 'дерево'));
}

console.log('\n--- Очередь: потолок, отмена, порядок ---');
{
  const sim = game();
  const st = createBuild();
  const cx = Math.round(sim.world.startX), cy = Math.round(sim.world.startY);
  let put = 0;
  for (let r = 2; r < 22 && put < QUEUE_MAX + 4; r++) {
    for (let dy = -r; dy <= r && put < QUEUE_MAX + 4; dy++) {
      for (let dx = -r; dx <= r && put < QUEUE_MAX + 4; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (plan(st, sim, 'hut', cx + dx, cy + dy).ok) put++;
      }
    }
  }
  t(`очередь не растёт выше потолка ${QUEUE_MAX}`,
    () => ok(st.queue.length === QUEUE_MAX, `в очереди ${st.queue.length}`));
  t('лишний чертёж отвергнут со внятной причиной', () => {
    const p = freeSpot(sim);
    const r = plan(st, sim, 'hut', p.x, p.y);
    ok(!r.ok && /очереди/.test(r.reason), JSON.stringify(r));
  });

  const firstKey = st.queue[0].key, secondKey = st.queue[1].key;
  t('перестановка меняет порядок', () => {
    ok(movePlan(st, secondKey, -1), 'не переставилось');
    ok(st.queue[0].key === secondKey && st.queue[1].key === firstKey,
      `порядок ${st.queue[0].key}, ${st.queue[1].key}`);
  });
  t('отмена чертежа бесплатна и убирает его', () => {
    const before = st.queue.length;
    const wood = sim.res.wood;
    ok(cancelPlan(st, secondKey).ok, 'не отменилось');
    ok(st.queue.length === before - 1, `осталось ${st.queue.length}`);
    near(sim.res.wood, wood, 1e-9, 'склад изменился при отмене чертежа');
  });
  t('чертежи не налезают друг на друга', () => {
    const seen = new Set();
    for (const q of st.queue) {
      const k = `${q.x},${q.y}`;
      ok(!seen.has(k), `две разметки в одной клетке ${k}`);
      seen.add(k);
    }
  });
}

console.log('\n--- Протяжка: ряд одним движением ---');
{
  const sim = game();
  const st = createBuild();
  const cx = Math.round(sim.world.startX), cy = Math.round(sim.world.startY);
  const r = planArea(st, sim, 'hut', cx - 4, cy - 4, cx + 4, cy - 4);
  t('поставилось несколько чертежей сразу', () => ok(r.placed >= 2, `поставлено ${r.placed}`));
  t('все в очереди', () => ok(st.queue.length === r.placed, `${st.queue.length} против ${r.placed}`));
  t('непригодные клетки пропущены с объяснением',
    () => ok(Array.isArray(r.skipped), JSON.stringify(r)));
}

console.log('\n--- Поколение 2: место имеет цену ---');
{
  const sim = game();
  // Ищем клетку с лесом вокруг и клетку без леса — лесопилке они не равны.
  const cx = Math.round(sim.world.startX), cy = Math.round(sim.world.startY);
  let rich = null, poor = null;
  for (let r = 2; r < 22 && (!rich || !poor); r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x = cx + dx, y = cy + dy;
      const s = scoreSpot(sim, 'lumber', x, y);
      if (!s.ok) continue;
      const forest = s.reasons.find(z => /лес/.test(z.ru));
      if (!forest) continue;
      const n = parseInt(forest.ru.match(/\d+/)[0], 10);
      if (n >= 20 && !rich) rich = { x, y, n, s };
      if (n <= 8 && !poor) poor = { x, y, n, s };
    }
  }
  t('нашлись богатое и бедное лесом места',
    () => ok(rich && poor, `богатое ${!!rich}, бедное ${!!poor}`));
  if (rich && poor) {
    t('лесопилка в чаще оценена выше, чем в редколесье',
      () => ok(rich.s.score > poor.s.score,
        `${rich.n} клеток леса → ${rich.s.score}, ${poor.n} → ${poor.s.score}`));
    t('причина названа словами и числом', () => {
      const r0 = rich.s.reasons[0];
      ok(r0 && typeof r0.ru === 'string' && Number.isFinite(r0.v), JSON.stringify(r0));
    });
  }

  t('оценка держится в пределах 0…100', () => {
    for (let i = 0; i < 40; i++) {
      const x = cx + (i % 9) - 4, y = cy + Math.floor(i / 9) - 2;
      const s = scoreSpot(sim, 'hut', x, y);
      ok(s.score >= 0 && s.score <= 100, `${s.score} в (${x},${y})`);
    }
  });
  t('оценка ничего не меняет в мире', () => {
    const before = JSON.stringify({ res: sim.res, n: sim.buildings.length });
    for (let i = 0; i < 20; i++) scoreSpot(sim, 'lumber', cx + i - 10, cy);
    ok(before === JSON.stringify({ res: sim.res, n: sim.buildings.length }), 'мир изменился');
  });
  t('далёкое место штрафуется за дорогу', () => {
    const near0 = scoreSpot(sim, 'hut', cx + 2, cy + 2);
    const far = scoreSpot(sim, 'hut', cx + 20, cy);
    const hasFar = far.reasons.some(r => /кострища/.test(r.ru));
    ok(hasFar || far.score <= near0.score,
      `близко ${near0.score}, далеко ${far.score}`);
  });
}

console.log('\n--- Подсказка «где лучше» ---');
{
  const sim = game();
  const spots = bestSpots(sim, 'lumber', 5);
  t('подсказки нашлись', () => ok(spots.length > 0, `их ${spots.length}`));
  t('не больше запрошенного', () => ok(spots.length <= 5, `${spots.length}`));
  t('отсортированы по убыванию оценки', () => {
    for (let i = 1; i < spots.length; i++) {
      ok(spots[i - 1].score >= spots[i].score, `${spots[i-1].score} < ${spots[i].score}`);
    }
  });
  t('подсказки разнесены, а не кучей в одном углу', () => {
    for (let i = 0; i < spots.length; i++) {
      for (let j = i + 1; j < spots.length; j++) {
        const d = Math.hypot(spots[i].x - spots[j].x, spots[i].y - spots[j].y);
        ok(d >= 4, `две подсказки в ${d.toFixed(1)} клетках друг от друга`);
      }
    }
  });
  t('в каждой подсказке есть причины', () => ok(spots.every(s => Array.isArray(s.reasons)), ''));
  t('все подсказки реально пригодны для стройки',
    () => ok(spots.every(s => sim.canPlace('lumber', s.x, s.y).ok), 'подсказали место, где строить нельзя'));
}

console.log('\n--- Поколение 3: улучшение на месте ---');
{
  const sim = game();
  const p = freeSpot(sim);
  sim.placeBuilding('hut', p.x, p.y);
  const b = sim.buildings.find(x => x.id === 'hut' && x.x === p.x);
  b.done = true; b.progress = b.buildDays;

  t('цель улучшения известна', () => ok(upgradeTarget('hut') === 'stone_house', upgradeTarget('hut')));
  t('платится РАЗНИЦА, а не полная цена', () => {
    const c = upgradeCost('hut');
    // Дерево: у хижины 6, у каменного дома 10 → разница 4, плюс накладные.
    near(c.wood, Math.ceil(4 * UPGRADE_OVERHEAD), 0.01, 'дерево');
    ok(c.wood < BUILDINGS.stone_house.cost.wood, `дерево ${c.wood}`);
  });
  t('улучшение НИКОГДА не дороже постройки заново', () => {
    // Иначе оно бессмысленно: игрок снесёт и построит. Проверяем всю таблицу,
    // а не один путь — накладные считаются от разницы, и по редкому материалу
    // она может почти совпасть с полной ценой.
    for (const from of Object.keys(UPGRADE)) {
      const c = upgradeCost(from), full = BUILDINGS[UPGRADE[from]].cost || {};
      for (const [r, v] of Object.entries(c)) {
        ok(v <= (full[r] || 0), `${from}→${UPGRADE[from]}: ${r} ${v} против полной ${full[r] || 0}`);
      }
    }
  });

  sim.res.wood = 0; sim.res.stone = 0;
  t('без материалов улучшить нельзя, и сказано чего не хватает', () => {
    const r = canUpgrade(sim, b);
    ok(!r.ok && /Не хватает/.test(r.reason), JSON.stringify(r));
  });

  sim.res.wood = 999; sim.res.stone = 999;
  const woodBefore = sim.res.wood, nBefore = sim.buildings.length;
  t('улучшение проходит', () => ok(upgrade(sim, b).ok, 'не улучшилось'));
  t('здание сменило род прямо на месте',
    () => ok(b.id === 'stone_house' && b.x === p.x && b.y === p.y, `${b.id} в (${b.x},${b.y})`));
  t('второго здания не появилось',
    () => ok(sim.buildings.length === nBefore, `было ${nBefore}, стало ${sim.buildings.length}`));
  t('за улучшение заплачено', () => ok(sim.res.wood < woodBefore, `${woodBefore} → ${sim.res.wood}`));
  t('дальше по цепочке путь есть', () => ok(upgradeTarget('stone_house') === 'apartment', ''));
  t('неулучшаемое здание честно об этом говорит', () => {
    const camp = sim.buildings.find(x => x.id === 'campfire');
    const r = canUpgrade(sim, camp);
    ok(!r.ok && /не улучшается/.test(r.reason), JSON.stringify(r));
  });
}

console.log('\n--- Износ и ремонт ---');
{
  const sim = game();
  const p = freeSpot(sim);
  sim.placeBuilding('hut', p.x, p.y);
  const b = sim.buildings.find(x => x.id === 'hut' && x.x === p.x);
  b.done = true; b.progress = b.buildDays;
  const max = BUILDINGS.hut.wall || 100;

  t('целое здание работает в полную силу', () => near(wearWorkMult(sim, b), 1, 1e-9, ''));
  t('износ за сутки положительный', () => ok(wearPerDay(sim, b) > 0, `${wearPerDay(sim, b)}`));
  t('зимой ветшает быстрее', () => {
    const was = sim.seasonIdx;
    sim.seasonIdx = 1; const summer = wearPerDay(sim, b);
    sim.seasonIdx = 3; const winter = wearPerDay(sim, b);
    sim.seasonIdx = was;
    ok(winter > summer, `лето ${summer}, зима ${winter}`);
  });

  b.hp = max * 0.5;
  t('ветхое работает хуже целого', () => ok(wearWorkMult(sim, b) < 1, `${wearWorkMult(sim, b)}`));
  t('множитель не падает ниже половины', () => {
    b.hp = 1;
    ok(wearWorkMult(sim, b) >= 0.5 - 1e-9, `${wearWorkMult(sim, b)}`);
  });

  b.hp = max * 0.4;
  t('попало в список на ремонт', () => {
    const list = repairList(sim);
    ok(list.some(r => r.x === b.x && r.y === b.y), JSON.stringify(list));
  });
  t('цена ремонта пропорциональна утраченному', () => {
    b.hp = max * 0.9; const light = repairCost(b);
    b.hp = max * 0.2; const heavy = repairCost(b);
    ok((heavy.wood || 0) > (light.wood || 0), JSON.stringify({ light, heavy }));
  });
  t('ремонт восстанавливает прочность и берёт плату', () => {
    b.hp = max * 0.3;
    sim.res.wood = 999;
    const before = sim.res.wood;
    ok(repair(sim, b).ok, 'не отремонтировалось');
    ok(b.hp === max, `прочность ${b.hp} из ${max}`);
    ok(sim.res.wood < before, 'ремонт оказался бесплатным');
  });
  t('общий ремонт чинит всё, на что хватает денег', () => {
    // Ставим три ветхих здания и чиним одним действием.
    for (let i = 0; i < 3; i++) {
      const q = freeSpot(sim);
      if (!q) break;
      sim.placeBuilding('hut', q.x, q.y);
      const nb = sim.buildings.find(x => x.id === 'hut' && x.x === q.x && x.y === q.y);
      nb.done = true; nb.progress = nb.buildDays; nb.hp = (BUILDINGS.hut.wall || 100) * 0.3;
    }
    const before = repairList(sim).length;
    ok(before >= 2, `ветхих зданий всего ${before}`);
    sim.res.wood = 9999; sim.res.stone = 9999;
    const r = repairAll(sim);
    ok(r.ok && r.count >= 2, JSON.stringify(r));
    ok(repairList(sim).length === 0, `осталось ветхих: ${repairList(sim).length}`);
  });
  t('общий ремонт при пустом складе ничего не ломает', () => {
    const q = freeSpot(sim);
    if (q) {
      sim.placeBuilding('hut', q.x, q.y);
      const nb = sim.buildings.find(x => x.id === 'hut' && x.x === q.x && x.y === q.y);
      nb.done = true; nb.progress = nb.buildDays; nb.hp = 20;
    }
    sim.res.wood = 0; sim.res.stone = 0;
    const r = repairAll(sim);
    ok(!r.ok || r.count === 0, JSON.stringify(r));
  });
  t('целое здание чинить не дают', () => {
    const r = repair(sim, b);
    ok(!r.ok && /целое/.test(r.reason), JSON.stringify(r));
  });
}

console.log('\n--- Дневной ход ---');
{
  const sim = game();
  const st = createBuild();
  const p = freeSpot(sim);
  plan(st, sim, 'hut', p.x, p.y);
  sim.day = 1;
  const out = buildNewDay(st, sim);
  t('чертёж превратился в стройку, когда ресурсы есть',
    () => ok(out.flags.started.length === 1, JSON.stringify(out.flags)));
  t('очередь опустела', () => ok(st.queue.length === 0, `${st.queue.length}`));
  t('об этом сказано игроку',
    () => ok(out.events.some(e => /Заложено по чертежам/.test(e.text)), JSON.stringify(out.events)));
  t('один день считается один раз', () => {
    const again = buildNewDay(st, sim);
    ok(again.flags.started.length === 0, JSON.stringify(again.flags));
  });
  t('износ посчитан для готовых зданий', () => {
    sim.day = 2;
    for (const b of sim.buildings) { b.done = true; b.progress = b.buildDays; }
    const o = buildNewDay(st, sim);
    ok(o.mods.wear.length > 0, `записей износа ${o.mods.wear.length}`);
    ok(o.mods.wear.every(w => w.w > 0), 'нулевой износ в списке');
  });
}

console.log('\n--- Круг сохранения ---');
{
  const sim = game();
  const st = createBuild();
  const p = freeSpot(sim);
  plan(st, sim, 'hut', p.x, p.y);
  const back = restoreBuild(JSON.parse(JSON.stringify(serializeBuild(st))));
  t('очередь пережила сейв', () => ok(back.queue.length === 1, `${back.queue.length}`));
  t('координаты сохранились',
    () => ok(back.queue[0].x === p.x && back.queue[0].y === p.y, JSON.stringify(back.queue[0])));
  t('битый сейв не роняет модуль', () => {
    const junk = restoreBuild({ queue: [null, 5, { id: 'нет-такого' }], day: 'ерунда', reserved: { wood: 'много' } });
    ok(Array.isArray(junk.queue) && junk.queue.length === 0, JSON.stringify(junk.queue));
  });
  t('пустой сейв даёт пустое состояние',
    () => ok(restoreBuild(null).queue.length === 0, ''));
}

console.log('\n--- Чистота ---');
{
  t('Math.random в модуле не вызывается', () => {
    const src = readFileSync(new URL('../src/core/systems/build2.js', import.meta.url), 'utf8');
    ok(!/Math\.random\s*\(/.test(src), 'найден вызов Math.random');
  });
  t('модуль не обращается к экрану', () => {
    const src = readFileSync(new URL('../src/core/systems/build2.js', import.meta.url), 'utf8');
    ok(!/\b(document|window|canvas)\b/.test(src.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')),
      'найдено обращение к DOM');
  });
}

console.log(`\n=== ${pass} OK / ${fail} FAIL ===`);
if (fail) process.exit(1);
