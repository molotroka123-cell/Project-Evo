// tools/shot.mjs — снимает скриншоты игры в настоящем Chromium (Playwright).
// Заодно ловит любые красные ошибки консоли — это приёмочный критерий §11.1.
// Запуск: node tools/shot.mjs [имя-пресета ...]
// Пресеты описаны в SHOTS ниже. Без аргументов — снимает все.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTDIR = join(ROOT, 'shots');
const PORT = 8791;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.json': 'application/json',
};

// Строит настоящий город вокруг старта: без этого на скриншотах пустая карта
// и оценить отрисовку зданий невозможно. Гоняется в контексте страницы.
const BUILD_CITY = (noon) => {
  const F = window.__frontier;
  const s = F.sim;
  s.execCommand('godmode');
  s.execCommand('unlockall');
  s.execCommand('give wood 99999'); s.execCommand('give stone 99999');
  s.execCommand('give gold 99999'); s.execCommand('give steel 99999');
  s.execCommand('give food 99999');
  const plan = [
    'campfire', 'hut', 'stone_house', 'granary', 'smithy', 'market', 'barracks',
    'temple', 'academy', 'castle', 'university', 'mill', 'bank', 'observatory',
    'factory', 'apartment', 'skyscraper', 'hospital', 'datacenter', 'solar',
    'lumber', 'quarry', 'farm', 'pasture', 'palisade', 'stone_walls', 'mine',
    'port', 'aqueduct', 'guild_hall', 'workshop', 'foundry', 'power_plant',
  ];
  const cx = Math.round(s.world.startX), cy = Math.round(s.world.startY);
  let i = 0;
  for (const id of plan) {
    let placed = false;
    for (let r = 1; r < 16 && !placed; r++) {
      for (let dy = -r; dy <= r && !placed; dy++) {
        for (let dx = -r; dx <= r && !placed; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = cx + dx, y = cy + dy;
          if (s.canPlace(id, x, y).ok && s.placeBuilding(id, x, y)) placed = true;
        }
      }
    }
    i++;
  }
  for (const b of s.buildings) { b.done = true; b.progress = b.buildDays; }
  s.execCommand('spawn 30');
  s.eraIndex = 8;
  if (noon) s.dayTime = 0.5;          // полдень: видно материалы, а не ночной тон
  else s.dayTime = 0.86;              // вечер: видно свечение окон
  F.renderer.cam.zoom = 1.6;
  s.paused = true;                    // фиксируем кадр, чтобы снимок был стабильным
};

// Крупный план жителей: город строить не нужно, нужны люди в кадре и зум.
// Без этого пресета человечков на скриншотах видно как две точки.
const BUILD_PEOPLE = (era) => {
  const F = window.__frontier;
  const s = F.sim;
  s.execCommand('godmode');
  s.execCommand('unlockall');
  s.execCommand('give wood 99999'); s.execCommand('give stone 99999');
  s.execCommand('give gold 99999'); s.execCommand('give food 99999');
  const cx = Math.round(s.world.startX), cy = Math.round(s.world.startY);
  for (const id of ['campfire', 'hut', 'lumber', 'farm', 'mine', 'barracks', 'academy', 'market', 'smithy']) {
    for (let r = 1; r < 10; r++) {
      let done = false;
      for (let dy = -r; dy <= r && !done; dy++) for (let dx = -r; dx <= r && !done; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (s.canPlace(id, cx + dx, cy + dy).ok && s.placeBuilding(id, cx + dx, cy + dy)) done = true;
      }
      if (done) break;
    }
  }
  for (const b of s.buildings) { b.done = true; b.progress = b.buildDays; }
  s.execCommand('spawn 24');
  s.eraIndex = era;
  s.dayTime = 0.5;
  F.renderer.cam.x = cx; F.renderer.cam.y = cy;
  F.renderer.cam.zoom = 3.0;
};

// имя → { hash, wait (мс после загрузки), viewport, actions }
const SHOTS = {
  start:      { hash: '', wait: 900, vp: { width: 1600, height: 900 } },
  early:      { hash: '#autostart', wait: 2500, vp: { width: 1600, height: 900 } },
  city:       { hash: '#autostart-era8', wait: 3500, vp: { width: 1600, height: 900 } },
  win:        { hash: '#autostart-win', wait: 2500, vp: { width: 1600, height: 900 } },
  placing:    { hash: '#autostart-placing', wait: 2000, vp: { width: 1600, height: 900 } },
  phone:      { hash: '#autostart-era8', wait: 3500, vp: { width: 390, height: 844 }, mobile: true },
  phone_early:{ hash: '#autostart', wait: 2200, vp: { width: 390, height: 844 }, mobile: true },
  // Главные кадры для оценки отрисовки построек.
  town:       { hash: '#autostart-seed=4242', wait: 1800, vp: { width: 1600, height: 900 }, build: 'noon' },
  town_night: { hash: '#autostart-seed=4242', wait: 1800, vp: { width: 1600, height: 900 }, build: 'night' },
  town_phone: { hash: '#autostart-seed=4242', wait: 1800, vp: { width: 390, height: 844 }, mobile: true, build: 'noon' },
  // Чистая карта в полдень: кадр для приёмки местности. Время суток фиксируем,
  // иначе снимки отличаются тоном заката и сравнивать их бесполезно.
  map:        { hash: '#autostart-seed=4242', wait: 1800, vp: { width: 1600, height: 900 }, noon: true, zoom: 1.1 },
  map_far:    { hash: '#autostart-seed=4242', wait: 1800, vp: { width: 1600, height: 900 }, noon: true, zoom: 0.6 },
  // Крупный план жителей — главный кадр для приёмки человечков.
  people:     { hash: '#autostart-seed=4242', wait: 1800, vp: { width: 1600, height: 900 }, people: 0 },
  people_mid: { hash: '#autostart-seed=4242', wait: 1800, vp: { width: 1600, height: 900 }, people: 4 },
  people_late:{ hash: '#autostart-seed=4242', wait: 1800, vp: { width: 1600, height: 900 }, people: 8 },
};

const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const path = join(ROOT, url === '/' ? '/app/index.html' : url);
    const buf = await readFile(path);
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404); res.end('404');
  }
});
await new Promise(r => server.listen(PORT, r));
await mkdir(OUTDIR, { recursive: true });

const want = process.argv.slice(2);
const names = want.length ? want : Object.keys(SHOTS);
// Хром в этом окружении предустановлен по фиксированному пути; версия пакета
// playwright может с ним расходиться, поэтому путь задаём явно.
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--enable-gpu', '--use-gl=swiftshader'] });
let errors = 0;

for (const name of names) {
  const cfg = SHOTS[name];
  if (!cfg) { console.log(`пропуск: нет пресета "${name}"`); continue; }
  const ctx = await browser.newContext({
    viewport: cfg.vp,
    deviceScaleFactor: cfg.mobile ? 2 : 1,
    isMobile: !!cfg.mobile,
    hasTouch: !!cfg.mobile,
    userAgent: cfg.mobile
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      : undefined,
  });
  const page = await ctx.newPage();
  const log = [];
  // Нарисованный арт (23 МБ) лежит рядом с опубликованной страницей, а не в
  // репозитории: локально эти 42 файла честно отдают 404, и рендер штатно
  // откатывается на процедурные спрайты. Такие 404 считаем отдельно — иначе
  // они топят в шуме настоящие ошибки, ради которых эта проверка и заведена.
  let artMiss = 0;
  page.on('response', r => { if (r.status() === 404 && /assets\/sprites\/buildings_/.test(r.url())) artMiss++; });
  page.on('console', m => { if (m.type() === 'error') { log.push(m.text()); } });
  page.on('pageerror', e => { log.push('PAGEERROR ' + e.message); errors++; });

  await page.goto(`http://127.0.0.1:${PORT}/app/index.html${cfg.hash}`, { waitUntil: 'load' });
  await page.waitForTimeout(cfg.wait);
  if (cfg.build) {
    await page.evaluate(BUILD_CITY, cfg.build === 'noon');
    await page.waitForTimeout(900);
  }
  if (cfg.people !== undefined) {
    await page.evaluate(BUILD_PEOPLE, cfg.people);
    await page.waitForTimeout(2500);   // дать жителям разойтись по работам
    // День успевает утечь в ночь — возвращаем полдень уже перед самым кадром.
    await page.evaluate(() => { window.__frontier.sim.dayTime = 0.5; });
    await page.waitForTimeout(120);
  }
  if (cfg.noon) {
    await page.evaluate((z) => {
      const F = window.__frontier;
      F.sim.dayTime = 0.5;
      F.sim.paused = true;
      if (z) F.renderer.cam.zoom = z;
    }, cfg.zoom);
    await page.waitForTimeout(500);
  }
  const file = join(OUTDIR, `${name}.png`);
  await page.screenshot({ path: file });

  const fps = await page.evaluate(() => new Promise(res => {
    let n = 0; const t0 = performance.now();
    const step = () => { n++; performance.now() - t0 < 1000 ? requestAnimationFrame(step) : res(n); };
    requestAnimationFrame(step);
  })).catch(() => -1);

  // «Failed to load resource» без адреса — это как раз ненайденные картинки
  // арта, их уже посчитал artMiss. Остальное — настоящие ошибки.
  const real = log.filter(l => !(artMiss > 0 && /Failed to load resource/.test(l)));
  errors += real.length;
  const art = artMiss ? `   нет файлов арта: ${artMiss} (норма вне публикации)` : '';
  console.log(`${name.padEnd(12)} → shots/${name}.png   FPS≈${fps}   ошибок консоли: ${real.length}${art}`);
  for (const l of real.slice(0, 6)) console.log('    ! ' + l.slice(0, 200));
  await ctx.close();
}

await browser.close();
server.close();
console.log(errors ? `\n=== ВСЕГО ОШИБОК КОНСОЛИ: ${errors} ===` : '\n=== КОНСОЛЬ ЧИСТАЯ ===');
process.exit(errors ? 1 : 0);
