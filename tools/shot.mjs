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
  page.on('console', m => { if (m.type() === 'error') { log.push(m.text()); errors++; } });
  page.on('pageerror', e => { log.push('PAGEERROR ' + e.message); errors++; });

  await page.goto(`http://127.0.0.1:${PORT}/app/index.html${cfg.hash}`, { waitUntil: 'load' });
  await page.waitForTimeout(cfg.wait);
  if (cfg.build) {
    await page.evaluate(BUILD_CITY, cfg.build === 'noon');
    await page.waitForTimeout(900);
  }
  const file = join(OUTDIR, `${name}.png`);
  await page.screenshot({ path: file });

  const fps = await page.evaluate(() => new Promise(res => {
    let n = 0; const t0 = performance.now();
    const step = () => { n++; performance.now() - t0 < 1000 ? requestAnimationFrame(step) : res(n); };
    requestAnimationFrame(step);
  })).catch(() => -1);

  console.log(`${name.padEnd(12)} → shots/${name}.png   FPS≈${fps}   ошибок консоли: ${log.length}`);
  for (const l of log.slice(0, 6)) console.log('    ! ' + l.slice(0, 200));
  await ctx.close();
}

await browser.close();
server.close();
console.log(errors ? `\n=== ВСЕГО ОШИБОК КОНСОЛИ: ${errors} ===` : '\n=== КОНСОЛЬ ЧИСТАЯ ===');
process.exit(errors ? 1 : 0);
