// Тест подключения подсистем к ядру.
//
// Модуль может быть сколь угодно хорош сам по себе — если ядро его не зовёт,
// в игре его нет. Здесь проверяется именно факт работы В ИГРЕ: через публичное
// API Simulation, без прямых вызовов внутренностей модулей.
import { Simulation } from '../src/core/simulation.js';
import { DAYS_PER_SEASON } from '../src/core/data.js';
import { systemsWorkMult } from '../src/core/systems/integrate.js';

let ok = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { ok++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// Прогон игры без вмешательства: подсистемы обязаны пережить долгую партию.
function run(sim, days) {
  for (let i = 0; i < days * 4; i++) sim.tick(0.25);
  return sim;
}

// Зимний день с заданным запасом дров. Сезон приходится держать вручную:
// ядро крутит его само, а нам нужен именно мороз.
function winterDay(sim, wood) {
  sim.res.wood = wood;
  sim.res.food = 500;          // голод не должен подменять причину смертей
  sim.day++;
  // onNewDay сам прокручивает сезон на границе суток. Если просто выставить
  // зиму, на каждый 25-й день она провернётся в весну и мороза не будет —
  // подставляем осень, чтобы после прокрутки оказалась именно зима.
  sim.seasonIdx = (sim.day % DAYS_PER_SEASON === 0) ? 2 : 3;
  sim.onNewDay();
}

console.log('\n--- Подсистемы установлены ---');
{
  const s = new Simulation(11);
  t('sim.sys существует после конструктора', !!s.sys);
  t('состояние зимы создано', !!s.sys && !!s.sys.winter);
  t('карта границ создана по размеру мира',
    !!s.sys && s.sys.borders.w === s.world.w && s.sys.borders.h === s.world.h,
    s.sys ? `${s.sys.borders.w}x${s.sys.borders.h} против ${s.world.w}x${s.world.h}` : '');
}

console.log('\n--- Зима реально жжёт дрова ---');
{
  const s = run(new Simulation(11), 120);   // больше четырёх сезонов: зима точно была
  t('за партию сожжено дерево', s.sys.winter.totals.burned > 0,
    `сожжено ${s.sys.winter.totals.burned.toFixed(1)}`);
  t('история зим ведётся', s.sys.winter.history.length >= 1,
    `зим в истории: ${s.sys.winter.history.length}`);

  // Дрова должны уходить со склада, а не списываться в пустоту.
  const s2 = new Simulation(11);
  run(s2, 24);
  s2.res.wood = 200;
  const before = s2.res.wood;
  winterDay(s2, 200);
  t('запас дерева уменьшился в зимний день', s2.res.wood < before,
    `${before} -> ${s2.res.wood.toFixed(2)}`);
  t('сожжено ровно столько, сколько списано',
    near(before - s2.res.wood, s2.sys.winterReport.burned, 0.01),
    `списано ${(before - s2.res.wood).toFixed(2)}, в отчёте ${s2.sys.winterReport.burned}`);
}

console.log('\n--- Мороз без дров бьёт по поселению ---');
{
  const s = run(new Simulation(11), 100);
  const pop0 = s.villagers.length;
  const happy0 = s.happiness();
  for (let d = 0; d < 25; d++) winterDay(s, 0);

  t('холод накопился', s.sys.winter.cold > 1, `холод ${s.sys.winter.cold.toFixed(2)}`);
  t('счастье просело от мороза', s.happiness() < happy0,
    `${happy0} -> ${s.happiness()}`);
  t('штраф к счастью отрицательный', s.sys.winter.happy < 0,
    `${s.sys.winter.happy.toFixed(1)}`);
  t('поселение потеряло людей', s.villagers.length < pop0,
    `${pop0} -> ${s.villagers.length}`);
  t('в живых кто-то остался (пол не пробит)', s.villagers.length >= 1);
  t('замёрзшие вычищены из списка', s.villagers.every(v => v.hp > 0));
  t('о смертях сказано в журнале',
    s.log.some(l => (l.text || '').includes('замёрз')));
  t('каждая смерть записана один раз',
    s.log.filter(l => (l.text || '').includes('замёрз')).length === s.sys.winter.totals.deaths,
    `строк ${s.log.filter(l => (l.text || '').includes('замёрз')).length}, смертей ${s.sys.winter.totals.deaths}`);
}

console.log('\n--- Тёплой зимой ничего не ломается ---');
{
  const s = run(new Simulation(5), 100);
  const pop0 = s.villagers.length;
  for (let d = 0; d < 25; d++) winterDay(s, 9999);
  t('при полном складе холода нет', s.sys.winter.cold === 0,
    `холод ${s.sys.winter.cold}`);
  t('при полном складе никто не умер от мороза', s.sys.winter.totals.deaths === 0);
  t('население не сократилось', s.villagers.length >= pop0, `${pop0} -> ${s.villagers.length}`);
}

console.log('\n--- Больные снижают выработку ---');
{
  // Сквозной замер добычи тут невозможен: в партии без вмешательства игрока все
  // жители простаивают, а болезнь вне зимы вылечивается за те же дни. Поэтому
  // проверяем сам множитель — ту величину, на которую ядро умножает выработку.
  const s = run(new Simulation(9), 60);
  const pop = s.villagers.length;

  s.sys.winter.sick = 0;
  const healthy = systemsWorkMult(s);
  t('здоровое поселение работает в полную силу', near(healthy, 1, 1e-9), `${healthy}`);

  s.sys.winter.sick = Math.floor(pop / 2);
  const half = systemsWorkMult(s);
  t('половина слегла — множитель упал', half < healthy, `${healthy} -> ${half}`);

  s.sys.winter.sick = pop;
  const all = systemsWorkMult(s);
  t('поголовная болезнь — множитель ещё ниже', all < half, `${half} -> ${all}`);

  s.sys.winter.sick = pop * 10;   // больных больше, чем людей: защита от мусора в сейве
  t('множитель не проваливается ниже пола 0.4', systemsWorkMult(s) >= 0.4,
    `${systemsWorkMult(s)}`);
  t('множитель никогда не больше единицы', systemsWorkMult(s) <= 1);
  s.sys.winter.sick = 0;
}

console.log('\n--- Границы считаются и приносят налог ---');
{
  const s = run(new Simulation(11), 60);
  const stats = s.sys.borderStats;
  t('статистика территорий получена', Array.isArray(stats) && stats.length > 0);
  const me = stats.find(x => x.side === 'player');
  t('у игрока есть своя земля', !!me && me.tiles > 0, me ? `клеток ${me.tiles}` : 'нет записи');
  t('земля даёт налог', !!me && me.tax > 0, me ? `налог ${me.tax}` : '');
  t('соседи тоже владеют землёй', stats.filter(x => x.side !== 'player').length > 0);

  // Налог должен доходить до казны, а не оставаться числом в отчёте.
  const gold0 = s.res.gold;
  s.day++; s.onNewDay();
  t('золото прибавилось за день с землёй', s.res.gold > gold0,
    `${gold0.toFixed(2)} -> ${s.res.gold.toFixed(2)}`);
}

console.log('\n--- Сейв переносит состояние подсистем ---');
{
  const s = run(new Simulation(11), 80);
  for (let d = 0; d < 12; d++) winterDay(s, 0);
  const cold = s.sys.winter.cold, sick = s.sys.winter.sick, burned = s.sys.winter.totals.burned;

  const json = JSON.stringify(s.serialize());
  const r = Simulation.deserialize(json);
  t('сейв загрузился', r.ok, r.ok ? '' : r.reason);
  if (r.ok) {
    t('холод восстановлен', near(r.sim.sys.winter.cold, cold, 1e-9),
      `${cold} -> ${r.sim.sys.winter.cold}`);
    t('число больных восстановлено', r.sim.sys.winter.sick === sick,
      `${sick} -> ${r.sim.sys.winter.sick}`);
    t('счётчик сожжённого восстановлен', near(r.sim.sys.winter.totals.burned, burned, 1e-6),
      `${burned} -> ${r.sim.sys.winter.totals.burned}`);
    t('карта границ восстановлена по размеру',
      r.sim.sys.borders.w === s.sys.borders.w && r.sim.sys.borders.h === s.sys.borders.h);
  }
}

console.log('\n--- Старый сейв без подсистем не роняет игру ---');
{
  const s = run(new Simulation(11), 40);
  const data = s.serialize();
  delete data.sys;                       // так выглядит сейв, сделанный до этой правки
  let r;
  try { r = Simulation.deserialize(JSON.stringify(data)); }
  catch (e) { r = { ok: false, reason: e.message }; }
  t('сейв без поля sys грузится', !!r && r.ok, r ? r.reason : 'исключение');
  if (r && r.ok) {
    t('подсистемы созданы заново', !!r.sim.sys && !!r.sim.sys.winter);
    let crashed = false;
    try { run(r.sim, 30); } catch (e) { crashed = true; console.log('   ' + e.message); }
    t('игра продолжается после загрузки', !crashed);
  }
}

console.log('\n--- Детерминизм не сломан ---');
{
  const a = run(new Simulation(1234), 90);
  const b = run(new Simulation(1234), 90);
  t('два прогона с одним сидом дают одинаковое население',
    a.villagers.length === b.villagers.length, `${a.villagers.length} против ${b.villagers.length}`);
  t('одинаковый расход дров', near(a.sys.winter.totals.burned, b.sys.winter.totals.burned, 1e-9),
    `${a.sys.winter.totals.burned} против ${b.sys.winter.totals.burned}`);
  t('одинаковое состояние ГПСЧ', a.rng.getState() === b.rng.getState());
}

console.log(`\n=== ${ok} OK / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
