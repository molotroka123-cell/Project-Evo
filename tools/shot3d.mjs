// tools/shot3d.mjs — приёмка трёхмерной сцены: скриншот + счётчики + ошибки.
// Запуск: node tools/shot3d.mjs [имя ...]
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'shots');
const PORT = 8788;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json' };

const SHOTS = {
  // Полдень: видно материалы и форму, тень короткая.
  d3_noon:  { day: 0.50, dist: 34, tilt: 0.92, turn: -0.60 },
  // Вечер: длинные тени — главное доказательство, что свет настоящий.
  d3_eve:   { day: 0.74, dist: 34, tilt: 0.92, turn: -0.60 },
  // Низкая камера: проверяем, что у построек есть объём, а не силуэт.
  d3_low:   { day: 0.62, dist: 22, tilt: 0.42, turn: -1.10 },
  // Общий вид: рельеф, берег, вода.
  d3_wide:  { day: 0.58, dist: 78, tilt: 1.05, turn: -0.60 },
};

const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const p = join(ROOT, url === '/' ? '/app/scene3d.html' : url);
    const b = await readFile(p);
    res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(b);
  } catch { res.writeHead(404); res.end('404'); }
});
await new Promise(r => server.listen(PORT, r));
await mkdir(OUT, { recursive: true });

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SHOTS);
// SwiftShader — программный растеризатор. Числа FPS отсюда говорят про то,
// как сцена ведёт себя БЕЗ видеокарты вообще; на настоящем железе они не
// имеют смысла и в выводе помечены явно.
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--enable-gpu', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
let errors = 0;

for (const name of names) {
  const cfg = SHOTS[name];
  if (!cfg) { console.log(`пропуск: нет пресета "${name}"`); continue; }
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 800 } });
  const page = await ctx.newPage();
  const log = [];
  page.on('console', m => { if (m.type() === 'error') log.push(m.text()); });
  page.on('pageerror', e => { log.push('PAGEERROR ' + e.message); });

  await page.goto(`http://127.0.0.1:${PORT}/app/scene3d.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__scene3d, null, { timeout: 30000 }).catch(() => {});
  // Через setDay/setView, а не напрямую в сцену: иначе подпись на кадре
  // остаётся от прежних значений и снимок врёт про то, что на нём снято.
  await page.evaluate(c => {
    const a = window.__scene3d;
    a.setDay(c.day);
    a.setView(c.dist, c.tilt, c.turn);
  }, cfg);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(OUT, `${name}.png`) });

  const info = await page.evaluate(() => ({
    stats: window.__scene3d.scene.stats(),
    counts: window.__scene3d.counts,
    fps: window.__scene3d.fps(),
  })).catch(() => null);

  errors += log.length;
  const s = info ? info.stats : {};
  console.log(`${name.padEnd(9)} → shots/${name}.png   построек ${info ? info.counts.buildings : '?'}`
    + `  жителей ${info ? info.counts.people : '?'}  вызовов ${s.вызововОтрисовки ?? '?'}`
    + `  треугольников ${(s.треугольников ?? 0).toLocaleString('ru')}`
    + `  FPS≈${info ? info.fps : '?'} (SwiftShader, без видеокарты)  ошибок ${log.length}`);
  for (const l of log.slice(0, 5)) console.log('    ! ' + l.slice(0, 200));
  await ctx.close();
}
await browser.close();
server.close();
console.log(errors ? `\n=== ОШИБОК: ${errors} ===` : '\n=== КОНСОЛЬ ЧИСТАЯ ===');
