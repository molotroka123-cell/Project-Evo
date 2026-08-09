// core/systems/wire_politics.js — оживление politics.js и laws.js.
//
// ЗАЧЕМ ЭТОТ ФАЙЛ. Обе системы написаны, покрыты тестами (18 + 19) и мертвы:
// игра их не зовёт ни разу. Здесь тот же принцип, что в systems/integrate.js:
// модуль НЕ трогает sim, он получает ctx и возвращает отчёт, а применяет отчёт
// к миру этот слой. Поэтому politics.js и laws.js остаются тестируемыми в
// одиночку, а ядро не знает про их внутренности.
//
// ЧТО ИМЕННО ОЖИВАЕТ:
//   politics.js — пять форм правления с числовыми множителями, смена строя
//     через смуту, стабильность как медленный ресурс с восстанием на нуле,
//     пять сословий с одобрением, правитель с чертами и кризисом преемственности,
//     три ветки доктрин по четыре необратимые ступени;
//   laws.js — один закон на эпоху (две двери, обе закрываются за спиной),
//     цепочки событий с памятью и хроника, которая ведётся сама.
//
// ПОЧЕМУ НЕ createPoliticsSystem. В politics.js есть готовая обёртка
// createPoliticsSystem(rng), но она лезет в sim напрямую (sim.addLog, sim.res,
// sim.toast) — то есть ровно то, чего архитектура не велит. Здесь взяты чистые
// функции модуля (dailyPolitics, applyLawFlags, politicsMult...), а всё
// применение к миру собрано в этом файле. Механика при этом та же самая, включая
// грабёж складов на восстании: она не переписана, а перенесена в слой интеграции.
//
// ГЛАВНОЕ ПРАВИЛО, КОТОРОЕ ЗДЕСЬ ЗАЩИЩЕНО. Угодить всем сословиям разом нельзя:
// в таблице LAW_STANCES у каждого варианта закона есть и плюсы, и минусы, у
// каждой формы правления — свои любимцы и свои обиженные. Панель не прячет эту
// цену, а показывает её до нажатия: под каждой кнопкой написано, кто обрадуется
// и кто разозлится. Новых «бесплатных» источников одобрения этот файл не вводит.
//
// DOM здесь не трогается: renderPoliticsPanel() возвращает строку, а
// bindPoliticsPanel() получает корневой узел снаружи. Math.random не
// используется — весь случай идёт через sim.rng.

import { ERAS } from '../data.js';
import * as P from './politics.js';
import * as L from './laws.js';

// Черты правителя таблицей по id: politics.js держит её приватной, а панели
// нужно показать, что именно даёт каждая черта. Это чтение готовых данных,
// а не вторая копия механики.
const TRAIT_BY_ID = Object.fromEntries(P.RULER_TRAITS.map(t => [t.id, t]));
const GOV_BY_ID = Object.fromEntries(P.GOVERNMENTS.map(g => [g.id, g]));

// Флаг закона → откуда он взялся. Нужно, чтобы сказать сословию, какого
// именно закона оно ждёт, и назвать закон по-человечески.
const FLAG_SOURCE = (() => {
  const map = {};
  for (const law of L.LAWS) {
    for (const o of law.options) {
      for (const f of (o.flags || [])) {
        map[f] = { lawId: law.id, lawRu: law.ru, era: law.era, key: o.key, optRu: o.ru };
      }
    }
  }
  return map;
})();

// Сколько дней подтверждение «нажмите ещё раз» остаётся в силе. Все три решения
// панели необратимы, поэтому одиночный тычок по кнопке их не совершает.
const CONFIRM_DAYS = 2;

// Порог, ниже которого стабильность считается предаварийной: до восстания
// (ноль) остаётся меньше недели даже при небольшом минусе в день.
const STAB_ALARM = 20;

// ════════════════════════ АДАПТЕР ════════════════════════

export function installPolitics(sim) {
  sim.laws = L.createLaws();
  // Имя sim.politics — из «родной» инструкции politics.js: чужой код ждёт
  // именно sim.politics.state. Поле pol — короткий синоним для этого файла.
  const pol = {
    state: P.createPolitics(sim.rng),
    ui: { confirm: null, confirmDay: -99 },   // подтверждение необратимого выбора
    lastStab: null,                            // разбор дневного прироста для панели
  };
  sim.politics = pol;
  sim.pol = pol;
  sim.pendingLaw = null;
  return pol;
}

// Раз в игровые сутки. Порядок важен: сперва сословия узнают о вчерашних
// законах, потом идёт день политики (стабильность, восстание, смерть правителя),
// и только затем на стол ложится новый закон — иначе сословия отреагировали бы
// на него раньше, чем игрок его принял.
export function politicsNewDay(sim) {
  const pol = sim.politics;
  if (!pol) return null;
  const ctx = politicsCtx(sim);

  // 1. Новые флаги законов → сдвиг одобрения сословий. seenFlags в модуле
  //    гарантирует, что каждый закон учтётся ровно один раз.
  for (const e of P.applyLawFlags(pol.state, L.lawFlags(sim.laws))) sim.addLog(e.text);

  // 2. День политики. Модуль ничего не пишет в мир — применяем отчёт здесь.
  for (const e of P.dailyPolitics(pol.state, ctx, sim.rng)) {
    sim.addLog(e.text, e.type);
    if (e.revolt) {
      if (typeof sim.toast === 'function') sim.toast('Восстание! Стабильность рухнула до нуля.', 'bad');
      // Бунт грабит склады: пятая часть еды и золота — цена нуля стабильности.
      sim.res.food = Math.max(0, sim.res.food * 0.8);
      sim.res.gold = Math.max(0, sim.res.gold * 0.8);
      sim.addChronicle(`Восстание: толпа взяла площади, склады разграблены (день ${sim.day}).`);
      sim.sfx?.('alarm');
    }
    if (e.succession) {
      sim.addChronicle(`${e.succession.dead} умер. Власть принял ${e.succession.heir}.`);
    }
  }
  pol.lastStab = stabilityBreakdown(sim);

  // 3. Свод законов: закон эпохи ложится на стол и ждёт решения игрока.
  //    Показывает его панель «Держава», поэтому модальное окно событий не занято.
  if (!sim.pendingLaw) {
    const off = L.openLaw(sim.laws, ctx);
    if (off) {
      sim.pendingLaw = off;
      sim.addLog(`§ Свод законов: ${off.ru}. Решение — на вкладке «Держава».`, 'warn');
      if (typeof sim.toast === 'function') sim.toast(`Свод законов: ${off.ru}`, 'warn');
    }
  }

  // 4. Цепочки событий. takeDueChain снимает звено с очереди, поэтому звать её
  //    можно только когда ядру есть куда показать событие.
  if (!sim.pendingEvent) {
    const ev = L.takeDueChain(sim.laws, ctx, sim.rng) || L.rollChainStart(sim.laws, ctx, sim.rng);
    if (ev) {
      sim.fireEvent(ev);
      if (!ev.choice) for (const t of L.applyExtras(ev.extra, sim)) sim.addLog(t.text, t.type);
      for (const c of (ev.chronicle || [])) sim.addChronicle(c.text);
    }
  }

  // 5. Летопись ведётся сама: сравнивает срез мира со вчерашним.
  for (const e of L.observe(sim.laws, ctx)) sim.addChronicle(e.text);
  return pol;
}

// Вызывается ядром после того, как игрок разрешил событие: планирует
// продолжение цепочки и дописывает летопись. Для обычных событий — пустышка.
export function politicsAfterEvent(sim, ev, key) {
  if (!sim.laws || !ev || !ev.chain) return null;
  const opt = ev.choice ? ev.choice[key] : null;
  const r = L.afterChoice(sim.laws, ev, key, politicsCtx(sim), sim.rng);
  if (opt) for (const t of L.applyExtras(opt.extra, sim)) sim.addLog(t.text, t.type);
  for (const c of r.chronicle) sim.addChronicle(c.text);
  if (r.log) sim.addLog(r.log);
  return r;
}

// Один множитель на всё политическое: законы × строй × смута × черты правителя ×
// доктрины × саботаж злых сословий. Неизвестный kind всегда даёт 1.
export function politicsKindMult(sim, kind) {
  if (!sim || !sim.politics) return 1;
  return L.lawMult(sim.laws, kind) * P.politicsMult(sim.politics.state, kind);
}

// Плоская добавка к счастью: законы + строй + черты + доктрины + смута/бунт.
export function politicsHappyMod(sim) {
  if (!sim || !sim.politics) return 0;
  return L.lawHappy(sim.laws) + P.politicsHappy(sim.politics.state);
}

export function politicsSerialize(sim) {
  if (!sim || !sim.politics) return null;
  return {
    laws: L.serializeLaws(sim.laws),
    politics: P.serializePolitics(sim.politics.state),
  };
}

export function politicsRestore(sim, data) {
  if (!sim || !sim.politics || !data) return;
  if (data.laws) sim.laws = L.deserializeLaws(data.laws);
  // rng трогаем только если правителя в сейве нет: лишний бросок сдвинул бы
  // поток случайностей относительно непрерывной партии.
  if (data.politics) sim.politics.state = P.deserializePolitics(data.politics, sim.rng);
  sim.politics.ui = { confirm: null, confirmDay: -99 };
  sim.politics.lastStab = null;
  sim.pol = sim.politics;
  refreshPendingLaw(sim);
}

// Предложенный, но не принятый закон живёт в состоянии laws.js (laws.offered).
// После загрузки сейва восстанавливаем по нему карточку для панели.
export function refreshPendingLaw(sim) {
  sim.pendingLaw = null;
  const off = sim.laws && sim.laws.laws ? sim.laws.laws.offered : null;
  if (!off) return null;
  const law = L.LAWS.find(l => l.id === off.id);
  if (!law || sim.laws.laws.adopted[law.id]) return null;
  sim.pendingLaw = L.presentLaw(law);
  return sim.pendingLaw;
}

// Единый ctx: politics.js берёт из него пять чисел, laws.js — весь срез мира.
// Две сборки не нужны, лишние поля модули игнорируют.
export function politicsCtx(sim) {
  return {
    day: sim.day, era: sim.eraIndex, eraDay: sim.eraDay,
    pop: sim.villagers.length,
    housingCap: typeof sim.housingCap === 'function' ? sim.housingCap() : 0,
    happy: sim._happy != null ? sim._happy : (typeof sim.happiness === 'function' ? sim.happiness() : 50),
    res: sim.res, buildings: sim.buildings, techs: sim.techs,
    wars: Array.isArray(sim.wars) ? sim.wars : [],
    repelled: sim.repelled || 0,
    soldiers: sim.army ? sim.army.soldiers : 0,
    spireStage: sim.spire ? sim.spire.stage : 0,
    factionName: (fid) => {
      const f = typeof sim.faction === 'function' ? sim.faction(fid) : null;
      return f && f.def ? f.def.name : String(fid);
    },
  };
}

// ════════════════════════ РАСЧЁТЫ ДЛЯ ПАНЕЛИ ════════════════════════

// Разбор дневного прироста стабильности. Формула повторена ТОЛЬКО для показа:
// сама стабильность считается в dailyPolitics. Смысл в том, чтобы игрок видел
// не «−0.7 в день», а из чего эти −0.7 складываются и что из них можно убрать.
// Если числа в politics.js поправят, здесь нужно поправить вместе с ними —
// поэтому слагаемые названы теми же словами, что и в модуле.
export function stabilityBreakdown(sim) {
  const st = sim.politics.state;
  const c = politicsCtx(sim);
  const gov = P.government(st);
  const rows = [];
  rows.push({ ru: 'Обычный ход дел', v: 0.2 });
  rows.push({ ru: `Строй: ${gov.ru}`, v: gov.stabPerDay });
  if (st.ruler) {
    for (const tid of st.ruler.traits) {
      const t = TRAIT_BY_ID[tid];
      if (t && t.stabPerDay) rows.push({ ru: `Правитель: ${t.ru}`, v: t.stabPerDay });
    }
  }
  if (c.happy >= 60) rows.push({ ru: 'Народ доволен', v: 0.3 });
  else if (c.happy < 35) rows.push({ ru: 'Народ несчастен', v: -0.5 });
  const wars = Math.min(c.wars.length, 3);
  if (wars > 0) rows.push({ ru: `Войны (${c.wars.length})`, v: -0.4 * wars });
  const avg = P.avgApproval(st);
  if (avg >= P.FACTION_HAPPY) rows.push({ ru: 'Сословия за власть', v: 0.3 });
  else if (avg <= 35) rows.push({ ru: 'Сословия против власти', v: -0.5 });
  const angry = P.angryFactions(st);
  if (angry.length) {
    rows.push({ ru: `Злых сословий: ${angry.map(id => P.SOCIAL_FACTIONS[id].ru).join(', ')}`, v: -0.2 * angry.length });
  }
  if (st.turmoil > 0) rows.push({ ru: `Смута (ещё ${Math.ceil(st.turmoil)} дн.)`, v: -1.0 });
  const total = rows.reduce((a, r) => a + r.v, 0);
  // Прогноз честный: считаем по сегодняшнему темпу, а он завтра изменится.
  const days = Math.abs(total) < 0.01 ? null
    : Math.ceil((total > 0 ? 100 - st.stability : st.stability) / Math.abs(total));
  return { rows, total, days, up: total > 0, stability: st.stability };
}

// Сдвиги одобрения от одного варианта закона: собираем по всем его флагам.
export function optionStance(opt) {
  const out = {};
  for (const f of (opt.flags || [])) {
    const st = P.LAW_STANCES[f];
    if (!st) continue;
    for (const [fid, d] of Object.entries(st)) out[fid] = (out[fid] || 0) + d;
  }
  return out;
}

// Кто обрадуется и кто разозлится — готовыми строками. Именно этот текст и
// делает выбор выбором: бесплатных вариантов в таблице нет.
export function stanceText(stance) {
  const good = [], bad = [];
  for (const [fid, d] of Object.entries(stance)) {
    const ru = P.SOCIAL_FACTIONS[fid] ? P.SOCIAL_FACTIONS[fid].ru : fid;
    if (d > 0) good.push(`${ru} +${d}`); else if (d < 0) bad.push(`${ru} −${Math.abs(d)}`);
  }
  return { good, bad };
}

// Чего ждёт сословие: ближайший непринятый закон, который его порадует, и формы
// правления, при которых оно чувствует себя хозяином. Ничего не выдумано —
// всё вычитано из LAW_STANCES и GOVERNMENTS.
export function factionWants(sim, fid) {
  const st = sim.politics.state;
  const adopted = sim.laws.laws.adopted;
  const out = [];
  // Только законы нынешней и будущих эпох: свод открывается по одному на эпоху,
  // и обещать сословию закон, который уже не выпадет, — обман.
  const laws = L.LAWS.filter(l => !adopted[l.id] && l.era >= (sim.eraIndex || 0)).sort((a, b) => a.era - b.era);
  for (const law of laws) {
    const opt = law.options.find(o => (optionStance(o)[fid] || 0) > 0);
    if (!opt) continue;
    const eraRu = ERAS[law.era] ? ERAS[law.era].ru : `эпоха ${law.era}`;
    out.push(`закон «${law.ru}»: ${opt.ru} (${eraRu})`);
    if (out.length >= 2) break;
  }
  const govs = P.GOVERNMENTS.filter(g => g.id !== st.gov && (g.stances[fid] || 0) > 0).map(g => g.ru);
  if (govs.length) out.push(`строй: ${govs.join(', ')}`);
  if (fid === 'military') out.push('война: каждый день войны прибавляет им веса');
  if (fid === 'merchants') out.push('мир: война отнимает у них торговлю каждый день');
  return out;
}

// За что сословие любит и не любит нынешнюю власть: только уже принятые законы.
export function factionMemory(sim, fid) {
  const flags = L.lawFlags(sim.laws);
  const good = [], bad = [];
  for (const f of flags) {
    const d = (P.LAW_STANCES[f] || {})[fid] || 0;
    if (!d) continue;
    const src = FLAG_SOURCE[f];
    const name = src ? `${src.optRu}` : f;
    (d > 0 ? good : bad).push(`${name} ${d > 0 ? '+' : '−'}${Math.abs(d)}`);
  }
  return { good, bad };
}

// Полная карточка сословия для панели.
export function factionCard(sim, fid) {
  const st = sim.politics.state;
  const v = st.factions[fid];
  const dom = P.FACTION_DOMAIN[fid];
  const kind = dom ? L.LAW_KINDS[dom.kind] : null;
  const angry = v < P.FACTION_ANGRY;
  return {
    id: fid, ru: P.SOCIAL_FACTIONS[fid].ru, value: v, angry,
    happy: v >= P.FACTION_HAPPY,
    status: angry ? 'саботирует' : v < 40 ? 'ропщет' : v < P.FACTION_HAPPY ? 'терпит' : 'опора власти',
    domainRu: kind ? kind.ru : null,
    domainMult: dom ? dom.mult : 1,
    memory: factionMemory(sim, fid),
    wants: factionWants(sim, fid),
  };
}

// Насколько правитель близок к смерти. deathChance даёт дневной шанс — для
// панели он бесполезен, поэтому переводим в годовой (год = 100 дней).
export function rulerRisk(state) {
  if (!state.ruler) return null;
  const d = P.deathChance(state.ruler.age);
  const year = 1 - Math.pow(1 - d, 100);
  return { day: d, year, pct: Math.round(year * 100) };
}

// ════════════════════════ ДЕЙСТВИЯ ════════════════════════

// Разбор строки вида 'gov:monarchy'. Вся проверка доступна без DOM — и тесту,
// и консоли. Три решения необратимы, поэтому каждое требует второго нажатия.
export function handlePoliticsAction(sim, spec) {
  const parts = String(spec || '').split(':');
  const kind = parts[0];
  if (!sim || !sim.politics) return { ok: false, reason: 'Политика не подключена' };
  const pol = sim.politics;
  const ctx = politicsCtx(sim);

  if (kind === 'gov') {
    const id = parts[1];
    const chk = P.canChangeGovernment(pol.state, id, ctx);
    if (!chk.ok) return { ok: false, reason: chk.reason };
    const need = confirmGate(sim, spec, `Реформа необратима: ${GOV_BY_ID[id] ? GOV_BY_ID[id].ru : id}. Нажмите ещё раз.`);
    if (need) return need;
    const r = P.changeGovernment(pol.state, id, ctx);
    if (!r.ok) return { ok: false, reason: r.reason };
    sim.addLog(r.log, 'warn');
    sim.addChronicle(`Смена строя: установлена ${r.ru}.`);
    return { ok: true, text: `${r.ru}: смута на ${r.turmoil} дн.`, sound: 'era' };
  }

  if (kind === 'doc') {
    const branch = parts[1];
    const chk = P.canPickDoctrine(pol.state, branch, ctx);
    if (!chk.ok) return { ok: false, reason: chk.reason };
    const need = confirmGate(sim, spec, `Доктрина «${chk.next.ru}» берётся навсегда. Нажмите ещё раз.`);
    if (need) return need;
    const r = P.pickDoctrine(pol.state, branch, ctx);
    if (!r.ok) return { ok: false, reason: r.reason };
    sim.addLog(r.log, 'good');
    sim.addChronicle(r.log.replace(/^✦\s*/, ''));
    return { ok: true, text: 'Доктрина принята.', sound: 'tech' };
  }

  if (kind === 'law') {
    const key = parts[1];
    if (!sim.pendingLaw) return { ok: false, reason: 'Сейчас нечего принимать' };
    const opt = sim.pendingLaw.options.find(o => o.key === key);
    if (!opt) return { ok: false, reason: 'Такого варианта нет' };
    const need = confirmGate(sim, spec, `«${opt.ru}» — закон не переписывают. Нажмите ещё раз.`);
    if (need) return need;
    const r = L.adoptLaw(sim.laws, key, ctx);
    if (!r.ok) return { ok: false, reason: r.reason };
    sim.pendingLaw = null;
    // Отношения с соседями меняет ядро: только оно знает про затухание факторов.
    if (r.rel && typeof sim.adjustRel === 'function') {
      for (const f of sim.factions) sim.adjustRel(f.id, r.rel, 'Новый закон');
    }
    for (const c of r.chronicle) if (c) sim.addChronicle(c.text);
    sim.addLog(r.log, 'good');
    // Сословия узнают о законе в тот же день, а не завтра: иначе игрок нажимает
    // кнопку и не видит последствий, ради которых её нажимал.
    for (const e of P.applyLawFlags(pol.state, L.lawFlags(sim.laws))) sim.addLog(e.text);
    return { ok: true, text: `Закон принят: ${r.optionRu}`, sound: 'tech' };
  }

  return { ok: false, reason: 'Неизвестная операция' };
}

// Первое нажатие только просит подтверждения, второе — совершает. Возвращает
// готовый ответ, если подтверждение ещё нужно, и null, если можно действовать.
function confirmGate(sim, spec, text) {
  const ui = sim.politics.ui;
  if (ui.confirm === spec && Math.abs(sim.day - ui.confirmDay) <= CONFIRM_DAYS) {
    ui.confirm = null;
    return null;
  }
  ui.confirm = spec;
  ui.confirmDay = sim.day;
  return { ok: true, text, sound: 'click', confirm: true };
}

function awaitingConfirm(sim, spec) {
  const ui = sim.politics.ui;
  return ui.confirm === spec && Math.abs(sim.day - ui.confirmDay) <= CONFIRM_DAYS;
}

// Привязка обработчиков — по образцу bindMarketPanel: свои data-атрибуты в
// переданном корне, никаких обращений к document.
// opts: { toast(text,type), audio.play(name), refresh() }
export function bindPoliticsPanel(root, sim, opts = {}) {
  if (!root || typeof root.querySelectorAll !== 'function' || !sim) return 0;
  let bound = 0;
  for (const el of Array.from(root.querySelectorAll('[data-pol]'))) {
    const spec = (el.dataset && el.dataset.pol) ||
      (typeof el.getAttribute === 'function' ? el.getAttribute('data-pol') : '');
    el.onclick = () => {
      const r = handlePoliticsAction(sim, spec);
      if (!r.ok) {
        if (opts.toast) opts.toast(r.reason, 'warn');
        if (opts.audio) opts.audio.play('deny');
      } else {
        if (opts.toast && r.text) opts.toast(r.text, r.confirm ? 'warn' : 'good');
        if (opts.audio) opts.audio.play(r.sound || 'click');
      }
      if (opts.refresh) opts.refresh();
      return r;
    };
    bound++;
  }
  return bound;
}

// ════════════════════════ ЭКРАН ════════════════════════

export function renderPoliticsPanel(sim) {
  if (!sim || !sim.politics) {
    return `<div class="card"><div class="ttl"><span>Держава</span></div>
      <div class="desc">Политика ещё не подключена к ядру.</div></div>`;
  }
  return _head(sim) + _lawOffer(sim) + _govSection(sim) + _stabSection(sim)
    + _factionsSection(sim) + _rulerSection(sim) + _doctrineSection(sim)
    + _lawsSection(sim) + _chainsSection(sim);
}

function _head(sim) {
  const st = sim.politics.state;
  const gov = P.government(st);
  const stab = Math.round(st.stability);
  const col = stab >= 60 ? 'var(--good)' : stab >= STAB_ALARM ? 'var(--warn)' : 'var(--bad)';
  const angry = P.angryFactions(st);
  return `<div class="card"><div class="ttl"><span>${gov.ru}</span>
      <span class="cost" style="color:${col}">стабильность ${stab}</span></div>
    <div class="desc">${gov.text}</div>
    <div class="relbar"><div style="width:${stab}%;background:${col}"></div></div>
    <div class="kv"><span>Правитель</span><span>${P.rulerTitle(st)}</span></div>
    <div class="kv"><span>Сословия</span><span>средне ${Math.round(P.avgApproval(st))} · злых ${angry.length}</span></div>
    ${st.turmoil > 0 ? `<div class="reason">Смута: ещё ${Math.ceil(st.turmoil)} дн. Хозяйство −15%, беспорядки ×1.5.</div>` : ''}
    ${st.revoltShock > 0 ? `<div class="reason">После восстания: счастье ${P.REVOLT_SHOCK_HAPPY} ещё ${Math.ceil(st.revoltShock)} дн.</div>` : ''}
    ${stab < STAB_ALARM ? '<div class="reason">На нуле начнётся восстание: склады теряют пятую часть еды и золота.</div>' : ''}</div>`;
}

// ---------- Закон на столе ----------

function _lawOffer(sim) {
  const off = sim.pendingLaw;
  if (!off) return '';
  let html = `<h4 class="group">§ Свод законов: ${off.ru}</h4>
    <div class="card"><div class="ttl"><span>${off.eraRu}</span><span class="cost">выбор навсегда</span></div>
    <div class="desc">${off.text}</div>
    <div class="desc">Закон не отменяется и не переписывается. Второй вариант закрывается вместе с первым.</div></div>`;
  const law = L.LAWS.find(l => l.id === off.id);
  for (const o of off.options) {
    const src = law ? law.options.find(x => x.key === o.key) : null;
    const stance = src ? optionStance(src) : {};
    const t = stanceText(stance);
    const spec = `law:${o.key}`;
    const wait = awaitingConfirm(sim, spec);
    html += `<div class="card"><div class="ttl"><span>${o.ru}</span></div>
      <div class="desc">${o.text}</div>
      <div class="kv"><span>Действие</span><span>${o.summary}</span></div>
      <div class="kv"><span>Обрадуются</span><span style="color:var(--good)">${t.good.length ? t.good.join(', ') : 'никто'}</span></div>
      <div class="kv"><span>Разозлятся</span><span style="color:var(--bad)">${t.bad.length ? t.bad.join(', ') : 'никто'}</span></div>
      <button class="btn ${wait ? 'danger' : 'primary'}" style="width:100%;margin-top:8px" data-pol="${spec}">
        ${wait ? 'Подтвердить: назад пути нет' : `Принять: ${o.ru}`}</button></div>`;
  }
  return html;
}

// ---------- Строй ----------

function _govSection(sim) {
  const st = sim.politics.state;
  const ctx = politicsCtx(sim);
  const gov = P.government(st);
  let html = `<h4 class="group">Форма правления</h4>`;
  html += `<div class="card"><div class="ttl"><span>Сейчас: ${gov.ru}</span>
      <span class="cost">с дня ${Math.round(st.govSince)}</span></div>
    <div class="desc">Что даёт: ${_multStr(gov.mult)} · счастье ${_sign(gov.happy)} · стабильность ${_sign(gov.stabPerDay, 1)}/день</div>
    <div class="desc">Опора строя: ${_stanceLine(gov.stances)}</div></div>`;

  for (const g of P.GOVERNMENTS) {
    if (g.id === gov.id) continue;
    const locked = ctx.era < g.era;
    const chk = P.canChangeGovernment(st, g.id, ctx);
    const spec = `gov:${g.id}`;
    const wait = awaitingConfirm(sim, spec);
    const eraRu = ERAS[g.era] ? ERAS[g.era].ru : `эпоха ${g.era}`;
    html += `<div class="card ${chk.ok ? '' : 'disabled'}">
      <div class="ttl"><span>${g.ru}</span><span class="cost">${locked ? eraRu : `−${P.GOV_CHANGE_COST} стабильности`}</span></div>
      <div class="desc">${g.text}</div>
      <div class="kv"><span>Даст</span><span>${_multStr(g.mult)} · счастье ${_sign(g.happy)}</span></div>
      <div class="kv"><span>Стабильность</span><span>${_sign(g.stabPerDay, 1)}/день</span></div>
      <div class="kv"><span>Сословия</span><span>${_stanceLine(g.stances)}</span></div>
      ${chk.ok
        ? `<button class="btn ${wait ? 'danger' : ''}" style="width:100%;margin-top:8px" data-pol="${spec}">
             ${wait ? `Подтвердить: смута ${P.TURMOIL_DAYS} дн.` : `Провести реформу (смута ${P.TURMOIL_DAYS} дн.)`}</button>`
        : `<div class="reason">${chk.reason}</div>`}</div>`;
  }
  html += `<div class="card"><div class="desc">Реформа стоит ${P.GOV_CHANGE_COST} стабильности и требует не меньше
    ${P.GOV_CHANGE_MIN_STAB}: в кризис строй не меняют — некому. Смута на ${P.TURMOIL_DAYS} дней режет добычу,
    золото, промышленность, знания и стройку на 15% и полуторно поднимает риск беспорядков.</div></div>`;
  return html;
}

// ---------- Стабильность ----------

function _stabSection(sim) {
  const st = sim.politics.state;
  const b = sim.politics.lastStab || stabilityBreakdown(sim);
  const col = b.up ? 'var(--good)' : 'var(--bad)';
  let html = `<h4 class="group">Стабильность</h4>
    <div class="card"><div class="ttl"><span>${Math.round(st.stability)} из 100</span>
      <span class="cost" style="color:${col}">${_sign(b.total, 1)} в день</span></div>
    <div class="desc">${b.days == null ? 'Держится на месте.'
      : b.up ? `При таком темпе потолок через ${b.days} дн.` : `При таком темпе ноль через ${b.days} дн. — это восстание.`}</div>`;
  for (const r of b.rows) {
    const c = r.v > 0 ? 'var(--good)' : r.v < 0 ? 'var(--bad)' : 'var(--dim)';
    html += `<div class="kv"><span>${r.ru}</span><span style="color:${c}">${_sign(r.v, 1)}</span></div>`;
  }
  html += `</div>`;
  if (st.revolts > 0) {
    html += `<div class="card"><div class="ttl"><span>Восстаний пережито</span><span class="cost">${st.revolts}</span></div>
      <div class="desc">После бунта порядок наводят силой: стабильность возвращается к ${P.REVOLT_FLOOR},
      простолюдины отходят, знать пугается. Второе восстание невозможно ещё
      ${Math.max(0, Math.ceil(st.revoltCd))} дн.</div></div>`;
  }
  return html;
}

// ---------- Сословия ----------

function _factionsSection(sim) {
  const st = sim.politics.state;
  let html = `<h4 class="group">Сословия</h4>
    <div class="card"><div class="desc">Угодить всем пятерым разом нельзя: каждый закон и каждый строй
      кого-то поднимает за счёт другого. Ниже ${P.FACTION_ANGRY} сословие начинает саботировать своё ремесло,
      выше ${P.FACTION_HAPPY} — работает на власть. Без новых поводов одобрение медленно сползает к 50.</div></div>`;
  for (const fid of Object.keys(P.SOCIAL_FACTIONS)) {
    const c = factionCard(sim, fid);
    const col = c.angry ? 'var(--bad)' : c.happy ? 'var(--good)' : 'var(--warn)';
    const pen = c.domainRu
      ? (c.angry
        ? `Саботаж идёт сейчас: ${c.domainRu} ×${c.domainMult}`
        : `Если разозлятся: ${c.domainRu} ×${c.domainMult}`)
      : '';
    html += `<div class="card"><div class="ttl"><span>${c.ru}</span>
        <span class="cost" style="color:${col}">${Math.round(c.value)} · ${c.status}</span></div>
      <div class="relbar"><div style="width:${Math.round(c.value)}%;background:${col}"></div></div>
      ${pen ? `<div class="desc" style="color:${c.angry ? 'var(--bad)' : 'var(--dim)'}">${pen}</div>` : ''}
      ${c.memory.good.length ? `<div class="kv"><span>Помнят добро</span><span style="color:var(--good)">${c.memory.good.join(', ')}</span></div>` : ''}
      ${c.memory.bad.length ? `<div class="kv"><span>Помнят обиды</span><span style="color:var(--bad)">${c.memory.bad.join(', ')}</span></div>` : ''}
      ${c.wants.length ? `<div class="kv"><span>Требуют</span><span>${c.wants.join(' · ')}</span></div>` : ''}</div>`;
  }
  return html;
}

// ---------- Правитель ----------

function _rulerSection(sim) {
  const st = sim.politics.state;
  const card = P.rulerCard(st);
  let html = `<h4 class="group">Правитель</h4>`;
  if (!card) return html + `<div class="card"><div class="desc">Трон пуст.</div></div>`;
  const risk = rulerRisk(st);
  const years = Math.max(0, Math.floor((sim.day - (st.ruler.since || 0)) / 100));
  html += `<div class="card"><div class="ttl"><span>${card.title}</span><span class="cost">${card.age} лет</span></div>
    <div class="desc">Правит ${years} ${_plural(years, 'год', 'года', 'лет')} · всего правителей сменилось: ${st.rulersCount}</div>`;
  for (const t of card.traits) {
    const def = TRAIT_BY_ID[t.id] || {};
    const eff = [];
    if (def.mult) eff.push(_multStr(def.mult));
    if (def.happy) eff.push(`счастье ${_sign(def.happy)}`);
    if (def.stabPerDay) eff.push(`стабильность ${_sign(def.stabPerDay, 1)}/день`);
    html += `<div class="kv"><span>${t.ru}</span><span>${eff.join(' · ') || '—'}</span></div>`;
  }
  html += `<div class="kv"><span>Риск не пережить год</span>
      <span style="color:${risk.pct >= 20 ? 'var(--bad)' : risk.pct >= 5 ? 'var(--warn)' : 'var(--good)'}">${risk.pct}%</span></div></div>`;

  const suc = P.SUCCESSION[st.gov] || P.SUCCESSION.chiefdom;
  html += `<div class="card"><div class="ttl"><span>Преемник</span><span class="cost">−${suc.stab} стабильности</span></div>
    <div class="desc">Наследника заранее нет: кто сядет на место — решает строй. При нынешнем — ${suc.ru}.</div>
    <div class="kv"><span>Смута после смерти</span><span>${suc.turmoil ? `${suc.turmoil} дн.` : 'не будет'}</span></div>
    <div class="desc">Республике и федерации кризис почти не страшен, вождеству — страшнее всего.
      Это одна из причин менять строй, пока правитель ещё жив.</div></div>`;
  return html;
}

// ---------- Доктрины ----------

function _doctrineSection(sim) {
  const st = sim.politics.state;
  const ctx = politicsCtx(sim);
  let html = `<h4 class="group">Доктрины</h4>
    <div class="card"><div class="desc">Три ветки по четыре ступени. Ступень открывается только после предыдущей
      и не раньше своей эпохи, стоит ${P.DOCTRINE_STAB_COST} стабильности и требует не меньше ${P.DOCTRINE_MIN_STAB}.
      Отката нет: взятое остаётся навсегда.</div></div>`;
  for (const d of P.DOCTRINES) {
    const tier = st.doctrines[d.id] || 0;
    const chk = P.canPickDoctrine(st, d.id, ctx);
    const nx = P.doctrineNext(st, d.id);
    const spec = `doc:${d.id}`;
    const wait = awaitingConfirm(sim, spec);
    html += `<div class="card"><div class="ttl"><span>${d.ru}</span>
        <span class="cost">${tier} / ${d.tiers.length}</span></div>`;
    d.tiers.forEach((t, i) => {
      const taken = i < tier;
      const isNext = i === tier;
      const eraNeed = P.DOCTRINE_ERA_GATE[i];
      const eraRu = ERAS[eraNeed] ? ERAS[eraNeed].ru : `эпоха ${eraNeed}`;
      const eff = [_multStr(t.mult), t.happy ? `счастье ${_sign(t.happy)}` : ''].filter(Boolean).join(' · ');
      const mark = taken ? '✦' : isNext ? '▶' : '○';
      const col = taken ? 'var(--good)' : isNext ? 'var(--warn)' : 'var(--dim)';
      html += `<div class="kv"><span style="color:${col}">${mark} ${t.ru}${taken ? '' : ` · ${eraRu}`}</span><span>${eff}</span></div>`;
    });
    if (!nx) {
      html += `<div class="desc">Ветка пройдена до конца.</div>`;
    } else if (chk.ok) {
      html += `<button class="btn ${wait ? 'danger' : ''}" style="width:100%;margin-top:8px" data-pol="${spec}">
        ${wait ? 'Подтвердить: навсегда' : `Принять «${nx.ru}» (−${P.DOCTRINE_STAB_COST} стабильности)`}</button>`;
    } else {
      html += `<div class="reason">${chk.reason}</div>`;
    }
    html += `</div>`;
  }
  return html;
}

// ---------- Принятые законы ----------

function _lawsSection(sim) {
  const order = (sim.laws.laws.order || []);
  let html = `<h4 class="group">Свод законов</h4>`;
  if (!sim.pendingLaw) html += `<div class="card"><div class="desc">${_nextLawText(sim)}</div></div>`;
  if (!order.length) {
    return html + `<div class="card"><div class="desc">Пока не принято ни одного закона.</div></div>`;
  }
  for (const o of [...order].reverse()) {
    const law = L.LAWS.find(l => l.id === o.id);
    if (!law) continue;
    const opt = law.options.find(x => x.key === o.key);
    if (!opt) continue;
    const other = law.options.find(x => x.key !== o.key);
    const t = stanceText(optionStance(opt));
    const eraRu = ERAS[o.era] ? ERAS[o.era].ru : `эпоха ${o.era}`;
    html += `<div class="card done-card"><div class="ttl"><span>${law.ru}: ${opt.ru}</span>
        <span class="cost">д.${o.day} · ${eraRu}</span></div>
      <div class="desc">${L.describeEffects(opt)}</div>
      ${t.good.length ? `<div class="kv"><span>Довольны</span><span style="color:var(--good)">${t.good.join(', ')}</span></div>` : ''}
      ${t.bad.length ? `<div class="kv"><span>Обижены</span><span style="color:var(--bad)">${t.bad.join(', ')}</span></div>` : ''}
      ${other ? `<div class="desc">Закрытая дверь: ${other.ru}.</div>` : ''}</div>`;
  }
  return html;
}

// Когда ждать следующий закон. Числа — из laws.js, чтобы игрок не гадал.
function _nextLawText(sim) {
  const ctx = politicsCtx(sim);
  const s = sim.laws;
  if (L.eraLawAdopted(s, ctx.era)) return 'Закон этой эпохи принят. Следующий свод откроется в новой эпохе.';
  if (ctx.day < L.LAW_FIRST_DAY) return `Первый свод соберут на ${L.LAW_FIRST_DAY}-й день — осталось ${L.LAW_FIRST_DAY - ctx.day} дн.`;
  if (ctx.eraDay < L.LAW_DELAY_DAYS) {
    return `Свод соберут через ${L.LAW_DELAY_DAYS - ctx.eraDay} дн.: сперва людям надо освоиться в новой эпохе.`;
  }
  return L.lawForEra(ctx.era, ctx)
    ? 'Свод собирается — закон ляжет на стол в ближайший день.'
    : 'Для этой эпохи закон не написан либо ждёт условий (нужной постройки, населения).';
}

// ---------- Цепочки ----------

function _chainsSection(sim) {
  const list = L.chainStatus(sim.laws);
  if (!list.length) return '';
  let html = `<h4 class="group">Незаконченные истории</h4>`;
  for (const c of list) {
    const wait = c.waitingUntil != null ? Math.max(0, c.waitingUntil - sim.day) : null;
    html += `<div class="card"><div class="ttl"><span>${c.ru}</span>
        <span class="cost">${wait != null ? `через ~${wait} дн.` : 'сейчас'}</span></div>
      <div class="desc">${c.text}</div></div>`;
  }
  return html;
}

// ════════════════════════ ФОРМАТИРОВАНИЕ ════════════════════════

// Названия видов деятельности берём из LAW_KINDS — там же лежит и направление
// «хорошо/плохо», поэтому цвет не приходится задавать руками для каждой строки.
function _multStr(mult) {
  const parts = [];
  for (const [kind, v] of Object.entries(mult || {})) {
    const k = L.LAW_KINDS[kind];
    const pct = Math.round((v - 1) * 100);
    if (!pct) continue;
    const ru = k ? k.ru : kind;
    const good = k ? ((pct > 0) === (k.good === 'up')) : pct > 0;
    parts.push(`<span style="color:${good ? 'var(--good)' : 'var(--bad)'}">${ru} ${_sign(pct)}%</span>`);
  }
  return parts.length ? parts.join(', ') : 'без прямых последствий';
}

function _stanceLine(stances) {
  const t = stanceText(stances || {});
  const good = t.good.length ? `<span style="color:var(--good)">${t.good.join(', ')}</span>` : '';
  const bad = t.bad.length ? `<span style="color:var(--bad)">${t.bad.join(', ')}</span>` : '';
  return [good, bad].filter(Boolean).join(' · ') || 'никого не трогает';
}

// Знак пишем типографским минусом: «-5» в интерфейсе читается как дефис.
function _sign(v, digits = 0) {
  const n = Number(v) || 0;
  const a = Math.abs(n).toFixed(digits);
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${a}`;
}

function _plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

// Короткие имена под сигнатуру из задания: install/onNewDay/serialize/restore.
export {
  installPolitics as install,
  politicsNewDay as onNewDay,
  politicsSerialize as serialize,
  politicsRestore as restore,
  renderPoliticsPanel as renderPanel,
  bindPoliticsPanel as bindPanel,
};

/* ПОДКЛЮЧЕНИЕ

   Девять правок в двух файлах, все — вставка после существующей строки.
   Ничего не удаляется: ядро сейчас не зовёт ни politics.js, ни laws.js, так что
   дублировать нечего.

   ─────────────────────── app/src/core/simulation.js ───────────────────────

1) ИМПОРТ. ЯКОРЬ (строка 7, единственная в файле):

import { installSystems, systemsNewDay, systemsFactions, systemsHappyMod, systemsWorkMult, systemsSerialize, systemsRestore } from './systems/integrate.js';

   ВСТАВИТЬ СРАЗУ ПОСЛЕ:

import { installPolitics, politicsNewDay, politicsAfterEvent, politicsKindMult, politicsHappyMod, politicsSerialize, politicsRestore } from './systems/wire_politics.js';

2) УСТАНОВКА. ЯКОРЬ (в конструкторе, единственная в файле):

    installSystems(this);

   ВСТАВИТЬ СРАЗУ ПОСЛЕ:

    // Строй, стабильность, сословия, правитель, доктрины и свод законов.
    installPolitics(this);

3) ДЕНЬ. ЯКОРЬ (в onNewDay, единственная в файле):

    systemsNewDay(this);

   ВСТАВИТЬ СРАЗУ ПОСЛЕ:

    politicsNewDay(this);

4) МНОЖИТЕЛИ. ЯКОРЬ — две последние строки globalMult перед `return mult;`
   (сочетание единственное в файле):

      if (this.techs.has('chemistry')) mult *= 1.25;
    }

   ВСТАВИТЬ СРАЗУ ПОСЛЕ (то есть непосредственно перед `return mult;`):

    // Законы, строй, черты правителя, доктрины и саботаж злых сословий.
    mult *= politicsKindMult(this, kind);

   Это покрывает gather / gold / knowledge / industry / army — те виды, ради
   которых ядро зовёт globalMult. Остальные множители подключаются в п. 9.

5) СЧАСТЬЕ. ЯКОРЬ (в happiness, единственная в файле):

    h += systemsHappyMod(this);

   ВСТАВИТЬ СРАЗУ ПОСЛЕ:

    h += politicsHappyMod(this);

6) ЦЕПОЧКИ СОБЫТИЙ. ЯКОРЬ (последняя строка resolveEvent, единственная в файле):

    this.addLog(`Решение по событию «${e.ru}»: ${opt.ru}.`);

   ВСТАВИТЬ СРАЗУ ПОСЛЕ:

    // Продолжение цепочки планируется по сделанному выбору; для обычных
    // событий вызов не делает ничего.
    politicsAfterEvent(this, e, opt.key || choiceKey);

   Без этой правки цепочки laws.js будут показываться, но не будут иметь
   продолжения: беженец не вернётся с караваном и не обчистит амбар.

7) СЕЙВ. ЯКОРЬ (в serialize, единственная в файле):

      sys: systemsSerialize(this),

   ВСТАВИТЬ СРАЗУ ПОСЛЕ:

      politics: politicsSerialize(this),

8) ЗАГРУЗКА. ЯКОРЬ (в static deserialize, единственная в файле):

    systemsRestore(sim, data.sys);

   ВСТАВИТЬ СРАЗУ ПОСЛЕ:

    politicsRestore(sim, data.politics);

   Старый сейв без поля грузится: вернётся чистое состояние с вождеством,
   стабильностью 60 и пустым сводом законов.

   ─────────────────────── app/src/ui/hud.js ────────────────────────────────

9) ИМПОРТ. ЯКОРЬ (строка 6, единственная в файле):

import { renderMarketPanel, bindMarketPanel, createMarketPanelState } from './panel_market.js';

   ВСТАВИТЬ СРАЗУ ПОСЛЕ:

import { renderPoliticsPanel, bindPoliticsPanel } from '../core/systems/wire_politics.js';

10) ВКЛАДКА. ЯКОРЬ (в массиве TABS, единственная в файле):

  { id: 'market', ru: 'Рынок', ic: '⚖️' },

   ВСТАВИТЬ СРАЗУ ПОСЛЕ:

  { id: 'gov', ru: 'Держава', ic: '⚖' },

11) ПАНЕЛЬ. ЯКОРЬ (метод рынка, единственная строка в файле):

  panel_market() { return renderMarketPanel(this.sim, this.marketState); }

   ВСТАВИТЬ СРАЗУ ПОСЛЕ:

  panel_gov() { return renderPoliticsPanel(this.sim); }

12) ОБРАБОТЧИКИ. ЯКОРЬ (конец bindPanel, единственный такой блок в файле):

    bindMarketPanel(root, this.sim, {
      toast: (t, k) => this.toast(t, k),
      audio: this.audio,
      refresh: () => this.renderPanel(),
    });

   ВСТАВИТЬ СРАЗУ ПОСЛЕ:

    bindPoliticsPanel(root, this.sim, {
      toast: (t, k) => this.toast(t, k),
      audio: this.audio,
      refresh: () => this.renderPanel(),
    });

   ───────────────── НЕОБЯЗАТЕЛЬНО: остальные множители ─────────────────────

   Законы и доктрины умеют влиять ещё на десяток сторон жизни, но ядро зовёт
   globalMult не везде. Каждая правка самостоятельна: без неё этот множитель
   просто не работает, ничего не ломается.

13) СКОРОСТЬ СТРОЙКИ (build). ЯКОРЬ в buildDays (единственная в файле):

    if (this.techs.has('nanotech')) days /= 3;

   ВСТАВИТЬ СРАЗУ ПОСЛЕ:

    days /= politicsKindMult(this, 'build');

14) ЦЕНА ИССЛЕДОВАНИЙ (techCost). ЗАМЕНИТЬ строку в techCost
    (единственная такая строка в файле):

    return cost;

   НА:

    return Math.ceil(cost * politicsKindMult(this, 'techCost'));

15) СМЕРТНОСТЬ ОТ БОЛЕЗНЕЙ (medicine). ЯКОРЬ в medicineMult (единственная):

    if (this.hasBuilding('hospital')) m *= 0.5;

   ВСТАВИТЬ СРАЗУ ПОСЛЕ:

    m *= politicsKindMult(this, 'medicine');

16) ВЫРУЧКА РЫНКА (market). ЯКОРЬ в marketRate (единственная):

    if (this.hasBuilding('treasury')) price *= 1.2;

   ВСТАВИТЬ СРАЗУ ПОСЛЕ:

    price *= politicsKindMult(this, 'market');

17) РОЖДАЕМОСТЬ (growth). ЯКОРЬ в onNewDay, блок рождений (единственная):

      let chance = 0.1;

   ВСТАВИТЬ СРАЗУ ПОСЛЕ:

      chance *= politicsKindMult(this, 'growth');

    ВНИМАНИЕ: если в игру подключается wire_population.js, этот блок ядра он
    удаляет целиком — тогда правку 17 делать НЕ надо, а множитель 'growth'
    следует передать в его расчёт рождаемости.

   ─────────────────────────── ВНИМАНИЕ ─────────────────────────────────────

   installPolitics ставит sim.laws и sim.politics. Если параллельный модуль
   подключит laws.js своим кодом, закон будет предлагаться дважды, а цепочки
   пойдут по два звена в день. Подключать что-то одно.

   Множители 'unrest', 'raid', 'trainCost', 'upkeep', 'caravan', 'farm' здесь
   намеренно не расписаны: ядро считает эти места по-своему (const-переменные,
   готовые формулы), и вставкой одной строки они не подключаются. Всё, что они
   дают, честно показано в панели как эффект закона или доктрины — но в мире
   заработает только после того, как соответствующие места ядра будут
   переписаны под множитель.
*/
