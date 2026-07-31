// Headless-тесты модуля worldsites (U33 туман, U34 руины/лагеря, U36 выселки).
// Запуск: node app/tests/test-worldsites.mjs
import { WorldSites, FOG, SITE_DEFS, OUTPOST, SIGHT, BANDIT } from '../src/core/systems/worldsites.js';
import { Simulation } from '../src/core/simulation.js';
import { generateWorld } from '../src/core/world.js';
import { createRng, makeNoise2D } from '../src/core/rng.js';
import { WALKABLE, TILE } from '../src/core/data.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('OK', name); } catch (e) { fail++; console.log('FAIL', name, '—', e.message); } };

// Мир и модуль создаются ровно так же, как это сделает ядро: rng симуляции +
// noise от клона сида. Никакого Math.random в тестах.
function makeWorld(seed) {
  const rng = createRng(seed);
  rng.noise = makeNoise2D(createRng((seed ^ 0x9e3779b9) >>> 0));
  return { world: generateWorld(seed, rng), rng };
}
function makeSites(seed, opts = {}) {
  const { world, rng } = makeWorld(seed);
  return new WorldSites(world, rng, { seed, ...opts });
}

// ---------------------------------------------------------------- U34
t('расстановка детерминирована от сида', () => {
  const a = makeSites(42), b = makeSites(42);
  const sa = JSON.stringify(a.sites), sb = JSON.stringify(b.sites);
  if (sa !== sb) throw new Error('один сид — разные карты');
  const c = makeSites(43);
  if (JSON.stringify(c.sites) === sa) throw new Error('разные сиды дали одинаковую карту');
  console.log(`   сид 42: ${a.sites.length} точек (${a.sites.filter(s => s.kind === 'camp').length} лагерей), сид 43: ${c.sites.length}`);
});

t('расстановка не зависит от состояния rng симуляции', () => {
  // Ядро может дёрнуть rng сколько угодно раз до создания модуля — карта
  // обязана остаться той же, иначе «сид → мир» перестаёт выполняться.
  const { world, rng } = makeWorld(7);
  const clean = new WorldSites(world, rng, { seed: 7 });
  const { world: w2, rng: r2 } = makeWorld(7);
  for (let i = 0; i < 1000; i++) r2.next();
  const dirty = new WorldSites(w2, r2, { seed: 7 });
  if (JSON.stringify(clean.sites) !== JSON.stringify(dirty.sites)) throw new Error('карта поехала от чужих вызовов rng');
});

t('точки стоят корректно: проходимо, не в стартовой зоне, не слипаются', () => {
  for (const seed of [1, 7, 13, 42, 99, 2024]) {
    const s = makeSites(seed);
    if (s.sites.length < 8) throw new Error(`сид ${seed}: всего ${s.sites.length} точек`);
    const sx = Math.round(s.world.startX), sy = Math.round(s.world.startY);
    for (const p of s.sites) {
      const tile = s.world.tiles[p.y * s.world.w + p.x];
      if (!WALKABLE.has(tile)) throw new Error(`сид ${seed}: точка ${p.def} на непроходимой клетке`);
      const dStart = Math.hypot(p.x - sx, p.y - sy);
      if (p.kind === 'camp' && dStart < 20) throw new Error(`сид ${seed}: лагерь в ${dStart.toFixed(1)} от старта`);
      if (dStart < 9) throw new Error(`сид ${seed}: точка прямо на стартовой поляне`);
      for (const q of s.sites) {
        if (q === p) continue;
        if (Math.hypot(p.x - q.x, p.y - q.y) < 7) throw new Error(`сид ${seed}: точки слиплись`);
      }
      if (!SITE_DEFS[p.def]) throw new Error('неизвестный тип точки: ' + p.def);
    }
    if (!s.sites.some(p => p.kind === 'camp')) throw new Error(`сид ${seed}: нет ни одного лагеря`);
    if (!s.sites.some(p => p.kind === 'ruin')) throw new Error(`сид ${seed}: нет ни одной руины`);
  }
});

t('руины: добыча выдаётся один раз', () => {
  const s = makeSites(42);
  const ruin = s.sites.find(p => p.kind === 'ruin');
  s.revealCircle(ruin.x, ruin.y, 3);
  const first = s.claimRuin(ruin.id);
  if (!first.ok) throw new Error(first.reason);
  const sum = Object.values(first.loot).reduce((a, b) => a + b, 0);
  if (sum <= 0) throw new Error('пустая руина');
  const second = s.claimRuin(ruin.id);
  if (second.ok) throw new Error('руина разграблена дважды');
  if (!/вынесли/.test(second.reason)) throw new Error('нет русской причины отказа: ' + second.reason);
});

t('руины видны только после разведки', () => {
  const s = makeSites(42);
  const far = s.sites.find(p => p.kind === 'ruin' && !s.isExplored(p.x, p.y));
  if (!far) throw new Error('все руины сразу разведаны — туман не работает');
  if (s.nearestUnclaimedRuin(far.x, far.y, 2)) throw new Error('неразведанная руина попала в задания');
  s.revealCircle(far.x, far.y, 2);
  if (!s.nearestUnclaimedRuin(far.x, far.y, 2)) throw new Error('разведанная руина не попала в задания');
});

t('лагерь: слабый штурм отбит, сильный уничтожает лагерь', () => {
  const s = makeSites(42);
  const camp = s.sites.find(p => p.kind === 'camp');
  const weak = s.assaultCamp(camp.id, 1);
  if (!weak.ok || weak.win) throw new Error('лагерь пал от одного бойца');
  if (camp.destroyed) throw new Error('проигранный штурм уничтожил лагерь');
  const strong = s.assaultCamp(camp.id, 10000);
  if (!strong.win) throw new Error('лагерь выстоял против 10000 силы');
  if (!camp.destroyed) throw new Error('лагерь не помечен разорённым');
  if (s.assaultCamp(camp.id, 10000).ok) throw new Error('разорённый лагерь штурмуется повторно');
  console.log(`   гарнизон эпохи 0: ${s.campPower(camp, 0)}, эпохи 5: ${s.campPower(camp, 5)}`);
});

t('лагеря шлют налёты, разорённые — молчат', () => {
  const s = makeSites(42);
  let raids = 0, firstDay = 0;
  for (let day = 1; day <= 400; day++) {
    for (const ev of s.tickDay({ day, eraIndex: 2 })) {
      if (ev.type !== 'banditRaid') continue;
      raids++; if (!firstDay) firstDay = day;
      if (!ev.textLose || !ev.textWin) throw new Error('нет русских строк события');
    }
  }
  if (raids < 3) throw new Error('налётов почти нет: ' + raids);
  if (firstDay < BANDIT.firstRaidDay) throw new Error('налёт до конца форы: день ' + firstDay);
  for (const c of s.liveCamps()) c.destroyed = true;
  let after = 0;
  for (let day = 401; day <= 800; day++) {
    for (const ev of s.tickDay({ day, eraIndex: 2 })) if (ev.type === 'banditRaid') after++;
  }
  if (after !== 0) throw new Error('разорённые лагеря продолжают налёты: ' + after);
  console.log(`   за 400 дней: ${raids} налётов от ${s.sites.filter(p => p.kind === 'camp').length} лагерей, первый на день ${firstDay}`);
});

t('пресс разбойников ограничен СУММАРНО, а не на лагерь', () => {
  // Регрессия на реальную поломку: восемь лагерей с независимыми таймерами
  // давали налёт раз в восемь дней и выкашивали племя. Проверяем на сидах,
  // где лагерей больше всего, что суммарная частота держится в рамках.
  for (const seed of [1, 7, 13, 42, 99, 2024]) {
    const s = makeSites(seed);
    const camps = s.sites.filter(p => p.kind === 'camp').length;
    if (camps > 6) throw new Error(`сид ${seed}: ${camps} лагерей — слишком много`);
    const days = [];
    for (let day = 1; day <= 1000; day++) {
      for (const ev of s.tickDay({ day, eraIndex: 4 })) if (ev.type === 'banditRaid') days.push(day);
    }
    for (let i = 1; i < days.length; i++) {
      if (days[i] - days[i - 1] < BANDIT.globalGap) {
        throw new Error(`сид ${seed}: два налёта подряд через ${days[i] - days[i - 1]} дн.`);
      }
    }
    const maxRaids = Math.ceil((1000 - BANDIT.firstRaidDay) / BANDIT.globalGap);
    if (days.length > maxRaids) throw new Error(`сид ${seed}: ${days.length} налётов при потолке ${maxRaids}`);
  }
});

t('кража ограничена долей запасов — малое племя не добивается', () => {
  const s = makeSites(42);
  let ev = null;
  for (let day = 1; day <= 400 && !ev; day++) {
    ev = s.tickDay({ day, eraIndex: 2 }).find(e => e.type === 'banditRaid') || null;
  }
  if (!ev) throw new Error('за 400 дней ни одного налёта');
  if (!(ev.stealPct > 0 && ev.stealPct < 1)) throw new Error('нет доли кражи');
  // Формула из блока INTEGRATION: у нищего племени уносят копейки, у богатого — потолок.
  const poor = Math.min(ev.steal, 20 * ev.stealPct);
  const rich = Math.min(ev.steal, 5000 * ev.stealPct);
  if (poor > 5) throw new Error('у голодающих отбирают слишком много: ' + poor);
  if (rich !== ev.steal) throw new Error('у богатых кража не упирается в потолок');
});

// ---------------------------------------------------------------- U33
t('туман: три состояния и память карты', () => {
  const s = makeSites(42, { capital: false });
  const cx = 40, cy = 40;
  if (s.fogAt(cx, cy) !== FOG.UNSEEN) throw new Error('карта не закрыта на старте');
  s.updateFog([{ x: cx, y: cy, r: 5 }]);
  if (s.fogAt(cx, cy) !== FOG.VISIBLE) throw new Error('наблюдатель не открыл клетку');
  if (s.fogAt(cx + 20, cy) !== FOG.UNSEEN) throw new Error('открылось лишнее');
  // Отряд ушёл: клетка обязана помнить увиденное, а не чернеть заново.
  s.updateFog([{ x: cx + 30, y: cy, r: 5 }]);
  if (s.fogAt(cx, cy) !== FOG.SEEN) throw new Error('карта забыла разведанное: ' + s.fogAt(cx, cy));
  if (s.fogAt(cx + 30, cy) !== FOG.VISIBLE) throw new Error('новая позиция не видна');
  s.updateFog([]);
  if (s.fogAt(cx + 30, cy) !== FOG.SEEN) throw new Error('видимость не гаснет без наблюдателей');
});

t('туман: круг обзора круглый и не течёт за край карты', () => {
  const s = makeSites(42, { capital: false });
  s.updateFog([{ x: 50, y: 50, r: 6 }]);
  if (s.isVisible(50 + 7, 50)) throw new Error('видно дальше радиуса');
  if (!s.isVisible(50 + 6, 50)) throw new Error('не видно на границе радиуса');
  if (s.isVisible(50 + 5, 50 + 5)) throw new Error('круг оказался квадратом');
  // У края массив не должен «заворачиваться» на соседнюю строку.
  s.updateFog([{ x: 1, y: 40, r: 5 }]);
  if (s.isVisible(s.w - 2, 40)) throw new Error('обзор перетёк через край карты');
});

t('туман: обновление дешевле 3 мс', () => {
  const s = makeSites(42, { capital: false });
  // Реалистичный поздний состав: 60 жителей + 60 зданий + 4 поселения.
  const villagers = [], buildings = [];
  const rng = createRng(1);
  for (let i = 0; i < 60; i++) villagers.push({ x: rng.range(10, 85), y: rng.range(10, 85), hp: 100 });
  for (let i = 0; i < 60; i++) buildings.push({ x: rng.int(10, 85), y: rng.int(10, 85), id: 'hut', done: true });
  buildings.push({ x: 48, y: 48, id: 'observatory', done: true });
  for (let i = 0; i < 3; i++) s._addSettlement(20 + i * 15, 30, 'В' + i, false, 0);
  const techs = new Set(['optics']);
  // Массив наблюдателей собирается ОДИН раз и дальше правится на месте: иначе
  // замер ловит не стоимость тумана, а паузы сборщика мусора на 124 объекта
  // в кадр — на этой машине они дают выбросы до 5 мс при реальной работе 0.1 мс.
  const obs = s.observers(buildings, villagers, techs);
  const N = 300;
  const samples = new Float64Array(N);
  for (let i = 0; i < 40; i++) s.updateFog(obs); // прогрев кэша дисков и JIT
  const t00 = performance.now();
  for (let i = 0; i < N; i++) {
    for (let k = 0; k < obs.length; k++) { obs[k].x += 0.31; obs[k].y += 0.17; }
    const t0 = performance.now();
    s.updateFog(obs);
    samples[i] = performance.now() - t0;
  }
  const wall = (performance.now() - t00) / N;
  const sorted = Array.from(samples).sort((a, b) => a - b);
  const median = sorted[N >> 1], p95 = sorted[Math.floor(N * 0.95)], worst = sorted[N - 1];
  console.log(`   ${obs.length} наблюдателей: медиана ${median.toFixed(3)} мс, p95 ${p95.toFixed(3)} мс, `
    + `амортизированно ${wall.toFixed(3)} мс/кадр, худший кадр ${worst.toFixed(3)} мс`);
  if (wall > 3) throw new Error(`амортизированная стоимость ${wall.toFixed(2)} мс > 3 мс`);
  if (median > 3) throw new Error(`медиана ${median.toFixed(2)} мс > 3 мс`);
  if (p95 > 3) throw new Error(`p95 ${p95.toFixed(2)} мс > 3 мс`);
});

t('туман: доля разведанного растёт и считается верно', () => {
  const s = makeSites(42, { capital: false });
  if (s.exploredFraction() !== 0) throw new Error('на старте что-то разведано');
  s.revealCircle(48, 48, 10);
  const f1 = s.exploredFraction();
  if (f1 <= 0 || f1 > 0.05) throw new Error('доля разведанного неправдоподобна: ' + f1);
  s.revealCircle(20, 20, 10);
  if (s.exploredFraction() <= f1) throw new Error('доля не выросла');
  let manual = 0;
  for (const v of s.fog) if (v !== FOG.UNSEEN) manual++;
  if (Math.abs(manual / s.fog.length - s.exploredFraction()) > 1e-12) throw new Error('кэш доли разошёлся с реальностью');
});

// ---------------------------------------------------------------- U36
t('одно поселение — прежний частный случай', () => {
  const s = makeSites(42);
  if (s.settlements.length !== 1) throw new Error('поселений не одно: ' + s.settlements.length);
  const cap = s.capital();
  if (!cap.capital || cap.store !== null) throw new Error('у столицы завёлся отдельный склад — экономика раздвоится');
  if (cap.x !== Math.round(s.world.startX)) throw new Error('столица не на стартовой точке');
  // Ни одного обоза, пока выселков нет.
  let convoys = 0;
  for (let day = 1; day <= 200; day++) {
    for (const ev of s.tickDay({ day, eraIndex: 0 })) if (ev.type !== 'banditRaid') convoys++;
  }
  if (convoys !== 0) throw new Error('одинокая столица гоняет обозы: ' + convoys);
  // Добыча идёт ровно в общую казну ядра и уважает её потолок.
  const res = { food: 0, wood: 390, stone: 0, steel: 0, gold: 0, knowledge: 0 };
  const cap0 = { food: 200, wood: 400, stone: 400, steel: 500, gold: 99999, knowledge: 99999 };
  const r = s.deposit(cap.id, 'wood', 25, res, cap0);
  if (r.to !== 'main') throw new Error('склад столицы не общий');
  if (res.wood !== 400) throw new Error('потолок казны нарушен: ' + res.wood);
  if (r.spill !== 15) throw new Error('перелив посчитан неверно: ' + r.spill);
  // Радиус застройки столицы остался прежним (26).
  if (!s.inAnySettlementRange(cap.x + 26, cap.y)) throw new Error('радиус столицы сжался');
  if (s.inAnySettlementRange(cap.x + 27, cap.y)) throw new Error('радиус столицы разъехался');
});

t('структура выдерживает N поселений', () => {
  const s = makeSites(42);
  s.revealCircle(48, 48, 45); // разведываем всё, чтобы проверять именно структуру
  const cap = s.capital();
  let founded = 0;
  for (let a = 0; a < 24 && founded < 8; a++) {
    const ang = a * Math.PI / 12;
    for (const rad of [12, 18, 24, 30, 36]) {
      const x = Math.round(cap.x + Math.cos(ang) * rad), y = Math.round(cap.y + Math.sin(ang) * rad);
      const r = s.foundSettlement(x, y, { day: 10 });
      if (r.ok) { founded++; break; }
    }
  }
  if (founded < 8) throw new Error('удалось основать только ' + founded + ' выселков');
  if (s.settlements.length !== 9) throw new Error('поселений ' + s.settlements.length);
  if (new Set(s.settlements.map(v => v.id)).size !== 9) throw new Error('id поселений не уникальны');
  if (s.settlements.filter(v => v.capital).length !== 1) throw new Error('столица не одна');
  // Каждый выселок имеет свой склад, столица — нет.
  for (const v of s.outposts()) {
    if (!v.store) throw new Error('у выселка нет склада');
    if (v.linkDays < 1) throw new Error('связь без времени доставки');
  }
  // Добыча роутится по адресам, не сваливаясь в общий котёл.
  const res = { food: 0, wood: 0, stone: 0, steel: 0, gold: 0, knowledge: 0 };
  const caps = { food: 9999, wood: 9999, stone: 9999, steel: 9999, gold: 99999, knowledge: 99999 };
  s.deposit(cap.id, 'wood', 50, res, caps);
  for (const v of s.outposts()) s.deposit(v.id, 'wood', 10, res, caps);
  if (res.wood !== 50) throw new Error('склад выселка протёк в казну: ' + res.wood);
  for (const v of s.outposts()) if (v.store.wood !== 10) throw new Error('выселок не принял добычу');
  const total = s.totalStock(res);
  if (total.wood !== 50 + 8 * 10) throw new Error('сводный остаток неверен: ' + total.wood);
  // Радиус застройки расширился на выселки.
  const far = s.outposts()[0];
  if (!s.inAnySettlementRange(far.x + OUTPOST.buildRange, far.y)) throw new Error('вокруг выселка строить нельзя');
});

t('отказы в основании выселка объяснены по-русски', () => {
  const s = makeSites(42);
  const cap = s.capital();
  const close = s.foundSettlement(cap.x + 2, cap.y, {});
  if (close.ok || !/близко/i.test(close.reason)) throw new Error('нет отказа по дистанции: ' + close.reason);
  const dark = s.foundSettlement(cap.x + 20, cap.y + 20, {});
  if (dark.ok || !/разведан/i.test(dark.reason)) throw new Error('нет отказа по туману: ' + dark.reason);
  s.revealCircle(48, 48, 60);
  const noTech = s.foundSettlement(cap.x + 14, cap.y, { techs: new Set(['fire']) });
  if (noTech.ok || !/технолог/i.test(noTech.reason)) throw new Error('нет отказа по технологии: ' + noTech.reason);
  const poor = s.foundSettlement(cap.x + 14, cap.y, { techs: new Set(['masonry']), res: { wood: 0, stone: 0, food: 0 } });
  if (poor.ok || !/хватает/i.test(poor.reason)) throw new Error('нет отказа по ресурсам: ' + poor.reason);
  const farAway = s.foundSettlement(cap.x + 60, cap.y, {});
  if (farAway.ok || !/обозы|Край/i.test(farAway.reason)) throw new Error('нет отказа по дальности: ' + farAway.reason);
});

t('обоз довозит груз в столицу за linkDays', () => {
  const s = makeSites(42);
  s.revealCircle(48, 48, 45);
  const cap = s.capital();
  // Разбойников убираем: здесь проверяется доставка, а не перехват обозов.
  for (const c of s.liveCamps()) c.destroyed = true;
  let out = null;
  for (let rad = 14; rad <= 30 && !out; rad += 2) {
    for (let a = 0; a < 16 && !out; a++) {
      const ang = a * Math.PI / 8;
      const x = Math.round(cap.x + Math.cos(ang) * rad), y = Math.round(cap.y + Math.sin(ang) * rad);
      const r = s.foundSettlement(x, y, { day: 1 });
      if (r.ok) out = r.settlement;
    }
  }
  if (!out) throw new Error('не нашлось места под выселок');
  out.store.wood = 120; out.store.food = 100;
  let cargo = null, arrivedDay = 0;
  for (let day = 2; day <= 60 && !cargo; day++) {
    for (const ev of s.tickDay({ day, eraIndex: 0 })) {
      if (ev.type === 'convoyArrived') { cargo = ev.cargo; arrivedDay = day; }
    }
  }
  if (!cargo) throw new Error('обоз не дошёл');
  if (cargo.wood !== 120) throw new Error('дерево доехало не всё: ' + cargo.wood);
  // Еду выселок частично оставляет себе — иначе он вымрет сам.
  if (cargo.food !== 100 - OUTPOST.keep.food) throw new Error('выселок не оставил себе еды: ' + cargo.food);
  if (out.store.food !== OUTPOST.keep.food) throw new Error('остаток на складе неверен: ' + out.store.food);
  console.log(`   «${out.name}»: путь ${out.linkDays} дн., обоз пришёл на день ${arrivedDay}`);
});

// ---------------------------------------------------------------- сейв
t('сериализация круговая и байт-в-байт', () => {
  const s = makeSites(42);
  s.revealCircle(48, 48, 40);
  s.updateFog([{ x: 30, y: 30, r: 8 }, { x: 60, y: 55, r: 6 }]);
  const cap = s.capital();
  const f = s.foundSettlement(cap.x + 14, cap.y + 2, { day: 20 });
  if (!f.ok) throw new Error('выселок не основан: ' + f.reason);
  const ruin = s.sites.find(p => p.kind === 'ruin');
  s.claimRuin(ruin.id);
  // Сначала крутим дни (обозы, таймеры лагерей), и лишь потом кладём метку на
  // склад: иначе ушедший обоз честно увёз бы её и проверка стала бы ложной.
  for (let day = 21; day <= 30; day++) s.tickDay({ day, eraIndex: 1 });
  f.settlement.store.stone = 77;

  const json = JSON.stringify(s.serialize());
  const { world, rng } = makeWorld(42);
  const s2 = new WorldSites(world, rng, { seed: 42 });
  s2.deserialize(JSON.parse(json));
  if (JSON.stringify(s2.serialize()) !== json) throw new Error('сейв не идентичен после круга');
  // Содержательные проверки, а не только совпадение строк.
  if (s2.settlements.length !== s.settlements.length) throw new Error('потеряны поселения');
  if (s2.outposts()[0].store.stone !== 77) throw new Error('склад выселка не восстановлен');
  if (!s2.site(ruin.id).claimed) throw new Error('разграбленная руина снова полна');
  if (s2.capital().store !== null) throw new Error('у столицы после загрузки появился склад');
  console.log(`   размер JSON: ${(json.length / 1024).toFixed(1)} КБ (туман RLE: ${s.serialize().fog.length} чисел)`);
});

t('после загрузки туман помнит разведанное, но не текущую видимость', () => {
  const s = makeSites(42, { capital: false });
  s.updateFog([{ x: 40, y: 40, r: 6 }]);
  if (s.fogAt(40, 40) !== FOG.VISIBLE) throw new Error('нет видимости до сохранения');
  const data = JSON.parse(JSON.stringify(s.serialize()));
  const { world, rng } = makeWorld(42);
  const s2 = new WorldSites(world, rng, { seed: 42, capital: false });
  s2.deserialize(data);
  if (s2.fogAt(40, 40) !== FOG.SEEN) throw new Error('загруженный туман не в состоянии «видел раньше»');
  if (s2.fogAt(80, 10) !== FOG.UNSEEN) throw new Error('загрузка открыла лишнее');
  s2.updateFog([{ x: 40, y: 40, r: 6 }]);
  if (s2.fogAt(40, 40) !== FOG.VISIBLE) throw new Error('видимость не восстанавливается первым же тиком');
});

t('старые сейвы не ломаются от правки SITE_DEFS', () => {
  const s = makeSites(42);
  const data = JSON.parse(JSON.stringify(s.serialize()));
  data.sites.push({ id: 9999, def: 'ruin_of_removed_dlc', kind: 'ruin', x: 5, y: 5, claimed: false, destroyed: false, rich: 1 });
  const { world, rng } = makeWorld(42);
  const s2 = new WorldSites(world, rng, { seed: 42 });
  s2.deserialize(data);
  if (s2.site(9999)) throw new Error('точка с неизвестным типом попала в игру');
  if (s2.sites.length !== s.sites.length) throw new Error('живые точки потерялись при чистке');
});

t('детерминизм дня: одинаковые сиды — одинаковые события', () => {
  const a = makeSites(77), b = makeSites(77);
  const ea = [], eb = [];
  for (let day = 1; day <= 300; day++) {
    ea.push(...a.tickDay({ day, eraIndex: 3 }).map(e => `${day}:${e.type}:${e.siteId || e.from || 0}:${e.power || 0}`));
    eb.push(...b.tickDay({ day, eraIndex: 3 }).map(e => `${day}:${e.type}:${e.siteId || e.from || 0}:${e.power || 0}`));
  }
  if (ea.join('|') !== eb.join('|')) throw new Error('поток событий разошёлся');
  if (!ea.length) throw new Error('за 300 дней не случилось ничего');
  console.log(`   ${ea.length} событий за 300 дней, поток совпал`);
});

t('таблица обзора покрывает здания и не даёт нулевых радиусов', () => {
  const s = makeSites(42, { capital: false });
  const obs = s.observers([{ x: 10, y: 10, id: 'observatory', done: true }, { x: 12, y: 12, id: 'hut', done: true },
    { x: 14, y: 14, id: 'hut', done: false }, { x: 16, y: 16, id: 'hut', done: true, destroyed: true }],
  [{ x: 20, y: 20, hp: 100 }, { x: 21, y: 21, hp: 0 }], new Set());
  if (obs.length !== 3) throw new Error('недостроенные/разрушенные здания или мёртвые жители смотрят: ' + obs.length);
  for (const o of obs) if (!(o.r > 0)) throw new Error('нулевой радиус обзора');
  const withOptics = s.observers([{ x: 10, y: 10, id: 'hut', done: true }], [], new Set(['optics']));
  if (withOptics[0].r !== SIGHT.building + SIGHT.opticsBonus) throw new Error('оптика не расширяет обзор');
});

// ------------------------------------------------- интеграция с ядром
// Модуль подмешивается к настоящей Simulation ровно теми вызовами, что описаны
// в блоке INTEGRATION. Чужие файлы при этом не правятся — обёртки живут в тесте.
function wire(seed) {
  const s = new Simulation(seed);
  s.sites = new WorldSites(s.world, s.rng, { seed: s.seed });
  const origDay = s.onNewDay.bind(s);
  s.onNewDay = () => {
    for (const ev of s.sites.tickDay({ day: s.day, eraIndex: s.eraIndex })) {
      if (ev.type === 'banditRaid') {
        const mine = s.armyPower() + s.defensePower();
        if (mine >= ev.power) { s.repelled++; s.res.gold += ev.power; }
        else s.res.food = Math.max(0, s.res.food - Math.min(ev.steal, s.res.food * ev.stealPct));
      } else if (ev.type === 'convoyArrived') {
        for (const [r, v] of Object.entries(ev.cargo)) s.res[r] = Math.min(s.resCap[r] || 99999, s.res[r] + v);
      }
    }
    origDay();
  };
  const origStep = s.tickStep.bind(s);
  s.tickStep = (dt) => { origStep(dt); s.sites.updateFog(s.sites.observers(s.buildings, s.villagers, s.techs)); };
  return s;
}

t('баланс не поехал: партия с модулем живёт не хуже базовой', () => {
  // Именно этот тест поймал реальную поломку — первая версия налётов вымаривала
  // племя, которое без модуля доживало до 400-го дня вдесятером.
  const open = (s) => {
    s.execCommand('give wood 200'); s.execCommand('give food 300');
    s.placeBuilding('hut', 44, 44); s.placeBuilding('lumber', 46, 42);
    for (let i = 0; i < 800; i++) s.tick(0.5);
  };
  for (const seed of [42, 7]) {
    const base = new Simulation(seed); open(base);
    const mod = wire(seed); open(mod);
    if (mod.villagers.length < 3) throw new Error(`сид ${seed}: с модулем племя вымерло (${mod.villagers.length})`);
    // Небольшая просадка — это и есть цена новой угрозы; обвал вдвое — поломка.
    if (mod.villagers.length < Math.ceil(base.villagers.length / 2)) {
      throw new Error(`сид ${seed}: население ${mod.villagers.length} против базовых ${base.villagers.length}`);
    }
    console.log(`   сид ${seed}: база ${base.villagers.length} жит. / с модулем ${mod.villagers.length} жит., `
      + `разведано ${(mod.sites.exploredFraction() * 100).toFixed(0)}%`);
  }
});

t('интеграция: туман открывается по ходу игры, сейв ядра остаётся круговым', () => {
  const s = wire(42);
  s.execCommand('give wood 200'); s.execCommand('give food 300');
  for (let i = 0; i < 400; i++) s.tick(0.5);
  const explored = s.sites.exploredFraction();
  if (explored <= 0.01) throw new Error('туман не открывается игрой: ' + explored);
  if (explored > 0.6) throw new Error('карта открылась сама собой: ' + explored);
  if (s.sites.knownSites().length === 0) throw new Error('игрок не нашёл ни одной точки за 200 дней');
  if (s.sites.knownSites().length === s.sites.sites.length) throw new Error('видны все точки сразу — туман не фильтрует');
  // Поле sites кладётся в обычный сейв ядра и переживает круг целиком.
  const save = { ...s.serialize(), sites: s.sites.serialize() };
  const json = JSON.stringify(save);
  const r = Simulation.deserialize(JSON.parse(json));
  if (!r.ok) throw new Error(r.reason);
  r.sim.sites = new WorldSites(r.sim.world, r.sim.rng, { seed: r.sim.seed });
  r.sim.sites.deserialize(JSON.parse(json).sites);
  const again = JSON.stringify({ ...r.sim.serialize(), sites: r.sim.sites.serialize() });
  if (again !== json) throw new Error('сейв ядра вместе с модулем не круговой');
  console.log(`   день ${s.day}: разведано ${(explored * 100).toFixed(1)}%, найдено точек `
    + `${s.sites.knownSites().length}/${s.sites.sites.length}, сейв ${(json.length / 1024).toFixed(1)} КБ`);
});

console.log(`\n=== ${pass} OK / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
