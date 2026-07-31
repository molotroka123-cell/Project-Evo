// render/artpack.js — подмена процедурных спрайтов настоящим нарисованным артом.
//
// Идея: рендер НЕ должен знать, откуда взялась картинка. Если для здания есть
// готовый спрайт из art/raw (прогнанный через tools/art/cutout.mjs), берём его;
// если нет — рисуем процедурно, как и раньше. Поэтому арт можно подвозить
// по частям: наполовину нарисованный город работает и выглядит нормально.
//
// Файлы лежат в app/assets/sprites/buildings_<id>.png. MANIFEST ниже — это
// список ОЖИДАЕМОГО арта, а грузим мы только то, что реально лежит на диске:
// перечень собирается сборщиком в artpack_list.js. Грузить наугад нельзя —
// на каждый недостающий файл браузер печатает красную 404, а приёмка требует
// нулевого числа ошибок в консоли.
import { AVAILABLE } from './artpack_list.js';

// 42 здания, для которых заказчик сгенерировал арт (см. tools/art/raw_map.tsv).
// Остальные 16 (campfire, quarry, story_fire, склады, shipyard, sewers, lab,
// apartment, airport, npp, robo_factory, biolab, skyscraper, ai_core) рисуются
// процедурно, пока не появится их арт — тогда просто дописать id сюда.
export const MANIFEST = [
  'academy', 'amphitheater', 'aqueduct', 'armory', 'bank', 'barracks', 'castle',
  'clinic', 'datacenter', 'factory', 'farm', 'forager', 'foundry', 'fusion_reactor',
  'granary', 'guild_hall', 'hospital', 'hunter_lodge', 'hut', 'lumber', 'market',
  'media_tower', 'mill', 'mine', 'observatory', 'palisade', 'pasture', 'port',
  'power_plant', 'press', 'smithy', 'solar', 'spaceport', 'spire', 'stock_exchange',
  'stone_house', 'stone_walls', 'temple', 'train_station', 'treasury', 'university',
  'workshop',
];

const BASE = 'assets/sprites/';

export class ArtPack {
  constructor() {
    this.img = new Map();       // id → HTMLImageElement (только загруженные)
    this.pending = new Set();
    this.enabled = true;
  }

  // Пытается начать загрузку всего, что реально есть в папке спрайтов.
  preload() {
    if (!this.enabled) return;
    for (const id of AVAILABLE) this.request(id);
  }

  request(id) {
    if (!this.enabled || this.img.has(id) || this.pending.has(id)) return;
    if (!AVAILABLE.includes(id)) return;
    this.pending.add(id);
    const im = new Image();
    im.onload = () => { this.img.set(id, im); this.pending.delete(id); };
    // Битый или недокачанный файл не должен ронять кадр: просто останемся
    // на процедурной отрисовке этого здания.
    im.onerror = () => { this.pending.delete(id); };
    // Сборка с ключом --embed-art кладёт картинки прямо в файл. Тогда игра
    // рисует настоящий арт и в одиночном frontier.html без интернета, а не
    // только на сайте, где спрайты лежат отдельными файлами рядом.
    const baked = typeof window !== 'undefined' && window.__FRONTIER_ART__;
    im.src = (baked && baked[id]) || `${BASE}buildings_${id}.png`;
  }

  // Возвращает картинку здания либо null, если её нет — тогда рисуем кодом.
  building(id) {
    if (!this.enabled) return null;
    const im = this.img.get(id);
    return im && im.complete && im.naturalWidth ? im : null;
  }

  get ready() { return this.img.size; }
  get total() { return AVAILABLE.length; }
}
