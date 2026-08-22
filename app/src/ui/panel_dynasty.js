// ui/panel_dynasty.js — экран «Род»: древо, законность, претенденты, решения.
//
// ЗАЧЕМ ЭТОТ ФАЙЛ. До рода власть была погодой: правитель умирал, и
// createRuler(rng) подставлял незнакомца. Привязаться не к кому, ненавидеть
// некого, вмешаться нельзя. Модель рода (systems/dynasty.js) это чинит, но
// модель без экрана — это скрытая механика: игрок увидит только «стабильность
// упала» и не поймёт, что у него третий год нет наследника. Панель существует
// ради одной строки — «что будет, если правитель умрёт сегодня», — и всё
// остальное на ней объясняет, как эту строку изменить.
//
// ЧТО ЗДЕСЬ ЕСТЬ И ЧЕГО НЕТ. Панель НИЧЕГО НЕ СЧИТАЕТ САМА. Все числа —
// из dynasty.js (это его константы и его функции can*), все изменения мира —
// через integrate.js. Второй копии правил здесь нет намеренно: панель, которая
// сама решает, «можно ли», рано или поздно расходится с моделью, и игрок жмёт
// живую кнопку, получая отказ.
//
// ═══════════════ ИНТЕРФЕЙС, ОТ КОТОРОГО Я РАБОТАЮ ═══════════════
//
// От core/systems/dynasty.js (уже написан, читаю его как есть):
//   state = sim.dynasty — простой объект:
//     { fam, founder, foundedDay, generations, members[], graves[], rulerId,
//       namedHeirId, legitimacy, court, patronCd, claimants[], ties[],
//       interregnum, stats:{rulers,births,deaths,coups,interregnums,houses} }
//     member = { id, name, fam, sex:'м'|'ж', age (В ДНЯХ), born, gen, blood,
//                origin:'blood'|'married'|'foreign', fid, traits[], father,
//                mother, spouse, since }
//   Чистые чтения (rng не берут, состояние не трогают — можно звать из рендера
//   каждый кадр): ruler, memberOf, bloodMembers, ageYearsOf, powerOf, heirOf,
//   legitimacy, baseLegitimacy, legitimacyWord, dynastyCard, dynastyRows.
//   Проверки действий: canPatronize, patronCost, canSetCourt, canNameHeir,
//   canMarryHeir, canOverthrow — каждая возвращает { ok, reason }. Именно
//   reason печатается под серой кнопкой.
//   Константы, которые панель показывает числом: PATRON_LEG, PATRON_CD,
//   COURT[], COURT_PER_POP, CLAIM_BELOW, CLAIM_CLEAR, CLAIM_STAB, COUP_*,
//   MARRY_REL, MARRY_LEG, FOREIGN_CLAIM, NAME_HEIR_*, LEG_*, SUCCESSION_LAW,
//   TRAIT_POWER, YEAR, ADULT_YEARS, MARRY_MIN, MAX_MEMBERS.
//
// От core/systems/integrate.js (пишет интегратор, блок ПОДКЛЮЧЕНИЕ ниже) —
// ровно те применители, которые описал сам dynasty.js в своей шапке:
//   dynastyPatronize(sim)            → { ok, reason }
//   dynastySetCourt(sim, level)      → { ok, reason }
//   dynastyNameHeir(sim, id)         → { ok, reason }
//   dynastyMarry(sim, fid, house)    → { ok, reason }
//   dynastyOverthrow(sim, claimIdx)  → { ok, reason }
//   dynastyClearHeir(sim)            → { ok, reason }   (см. п.3 ПОДКЛЮЧЕНИЯ)
//   dynastyCtx(sim)                  → ctx              (не обязателен)
// Ни одного из них может ещё не быть: тогда кнопка гаснет и НАЗЫВАЕТ ПРИЧИНУ
// («применитель не подключён»), а не молчит и не падает. Панель обязана
// пережить полусобранную игру — её включают раньше, чем связь.
//
// Дневной отчёт рода (если связь уже ведёт день) лежит в sim.sys.dynastyReport
// и даёт разбор законности словами: flags.legParts[], flags.legDelta, reasons[].
// Без него панель показывает те же рычаги, но без сегодняшних чисел.
//
// DOM здесь не трогается: renderDynastyPanel() возвращает строку, корневой узел
// всегда приходит доводом. К глобальному генератору случайных чисел файл не
// обращается ни разу — панель случайность вообще не берёт, весь случай остаётся
// внутри действий рода, где им распоряжается sim.rng.
//
// ═══════════════ ПОДКЛЮЧЕНИЕ ═══════════════  (в конце файла, с якорями)

import * as DYN from '../core/systems/dynasty.js';
import * as INT from '../core/systems/integrate.js';
import { RULER_TRAITS, SUCCESSION } from '../core/systems/politics.js';

const TRAIT_BY_ID = Object.fromEntries(RULER_TRAITS.map(t => [t.id, t]));

// Сколько дней держится «нажмите ещё раз». Гейт стоит только на необратимом:
// переворот обнуляет род, брак навсегда отдаёт чужому дому право на трон.
// Остальные кнопки отменяются сами (двор — в любой день, наследник — clearHeir),
// и второй тычок там был бы просто издевательством.
const CONFIRM_DAYS = 2;

// Подтверждение — состояние ЭКРАНА, а не мира: в сейв оно не идёт, на rng не
// влияет, при перезагрузке просто исчезает. Поэтому WeakMap на sim, а не поле
// в sim: панель не имеет права дописывать миру свои поля, иначе слепок партии
// начнёт зависеть от того, на какую кнопку игрок навёл мышь.
const CONFIRM = new WeakMap();

// Порог «пора тревожиться» для риска пережить год. 20% — это в среднем один
// раз в пять лет; при пустой скамье наследников этого достаточно, чтобы партия
// кончилась междуцарствием.
const RISK_ALARM = 0.20;

// Не подключённая связь — это не ошибка игрока, и текст должен об этом сказать.
const NOT_WIRED = 'Применитель не подключён: добавьте вызов в integrate.js (см. шапку panel_dynasty.js)';

// ════════════════════════ ДОСТУП К СОСТОЯНИЮ ════════════════════════

// Род живёт в sim.dynasty (так его кладёт applyDynasty). Запасные места — на
// случай, если связь положит его иначе: панель не должна умирать от переезда.
//
// Проверяем ВСЕ четыре списка, а не один members. Битый сейв, обрезанный
// сохранением старой версии, приходит с members: [] и без graves — и первое же
// state.graves.length роняло бы панель, а с ней и весь экран. Лучше честная
// карточка «род не подключён», чем белое окно: restoreDynasty всё равно
// восстановит списки к ближайшему дню.
function dynState(sim) {
  if (!sim) return null;
  const st = sim.dynasty || (sim.sys && sim.sys.dynasty) || null;
  if (!st || typeof st !== 'object') return null;
  const ok = Array.isArray(st.members) && Array.isArray(st.graves)
    && Array.isArray(st.claimants) && Array.isArray(st.ties);
  return ok ? st : null;
}

function dynReport(sim) {
  return (sim && sim.sys && sim.sys.dynastyReport) || null;
}

// Обстановка для рода. Если интегратор вывел свой dynastyCtx наружу — берём
// ЕГО: две копии одного ctx неминуемо разъедутся, и панель начнёт показывать
// одну цену, а модель брать другую. Пока не вывел — считаем те же поля здесь.
// events всегда пусто: разовые удары считает дневной ход, а не экран.
function dynCtx(sim) {
  if (typeof INT.dynastyCtx === 'function') {
    try { return INT.dynastyCtx(sim); } catch { /* считаем сами */ }
  }
  const st = sim.politics && sim.politics.state;
  const pop = Array.isArray(sim.villagers) ? sim.villagers.length : 0;
  return {
    day: sim.day || 0,
    gov: st ? st.gov : 'chiefdom',
    era: sim.eraIndex || 0,
    pop,
    gold: sim.res ? sim.res.gold : 0,
    foodDays: sim.res ? sim.res.food / Math.max(1, pop * 0.7) : 99,
    wars: Array.isArray(sim.wars) ? sim.wars.length : 0,
    stability: st ? st.stability : 50,
    happy: sim._happy != null ? sim._happy : 50,
    mortalityMult: typeof sim.plagueMult === 'function' ? sim.plagueMult() : 1,
    nobles: st ? st.factions.nobles : 50,
    military: st ? st.factions.military : 50,
    events: [],
  };
}

// Дневной шанс смерти считает politics.js по возрасту; для панели он бесполезен
// (0.0004 ни о чём не говорит), поэтому переводим в годовой. Год = 100 дней —
// та же мера, что во всей игре.
function yearRisk(years) {
  const d = years < 50 ? 0.0001 : Math.min(0.02, 0.0004 * Math.pow(2, (years - 50) / 8));
  return 1 - Math.pow(1 - d, DYN.YEAR);
}

function courtGold(st, c) {
  const lvl = DYN.COURT[_clampInt(st.court, 0, DYN.COURT.length - 1)];
  return lvl.gold * (1 + (c.pop || 0) * DYN.COURT_PER_POP);
}

// ════════════════════════ ЭКРАН ════════════════════════

export function renderDynastyPanel(sim) {
  const st = dynState(sim);
  if (!st) {
    return `<div class="card"><div class="ttl"><span>Род</span></div>
      <div class="desc">Род ещё не подключён к ядру: модель dynasty.js написана, но день рода никто не ведёт.
      Пока её не позовут, власть остаётся прежней — сменой случайного человека на случайного.</div></div>`;
  }
  const c = dynCtx(sim);
  const heir = DYN.heirOf(st, c);
  const card = DYN.dynastyCard(st, c);
  return _alarm(sim, st, c, heir, card)
    + _head(sim, st, c, card)
    + _legitimacy(sim, st, c, heir)
    + _tree(sim, st, c, heir)
    + _claimants(sim, st, c)
    + _traits(sim, st, c)
    + _actions(sim, st, c, heir)
    + _graves(st, c)
    + _stats(st, c);
}

// ---------- Тревога: главная опасность стоит первой ----------
//
// Пресечение рода нельзя показывать «где-то ниже»: игрок листает панель ровно
// до первой понятной строки. Поэтому всё, что грозит междуцарствием, собрано
// наверх одной карточкой, и в ней сразу написано, чем это лечится.

function _alarm(sim, st, c, heir, card) {
  const law = DYN.SUCCESSION_LAW[c.gov] || DYN.SUCCESSION_LAW.chiefdom;
  const rl = DYN.ruler(st);
  const years = rl ? DYN.ageYearsOf(rl) : 0;
  const risk = rl ? yearRisk(years) : 1;
  const bench = DYN.bloodMembers(st).filter(m => m.id !== st.rulerId);
  const adults = bench.filter(m => DYN.ageYearsOf(m) >= DYN.ADULT_YEARS);
  const rows = [];
  let crit = false;

  if (st.interregnum > 0) {
    crit = true;
    rows.push(`Трон пуст ещё ${Math.ceil(st.interregnum)} ${_pl(Math.ceil(st.interregnum), 'день', 'дня', 'дней')}: стабильность
      −${DYN.INTERREGNUM_STAB} и законность −${DYN.LEG_INTERREGNUM} каждые сутки, пока никто не сел на трон.`);
  }
  if (!rl && st.interregnum <= 0) {
    crit = true;
    rows.push('Правителя нет, а междуцарствие не объявлено: власть повисла. Ближайший день рода это разрешит.');
  }
  if (!heir && law.law !== 'election') {
    crit = true;
    rows.push(`НАСЛЕДНИКА НЕТ. Умрёт правитель — род пресечётся, и начнётся междуцарствие на ${DYN.INTERREGNUM_DAYS} дней.
      Законность уже тает на ${DYN.LEG_NO_HEIR} в сутки.`);
    rows.push(bench.length
      ? 'В роду есть кровные, но по закону строя никто не наследует: назначьте наследника вручную — это ниже, в древе.'
      : 'Кровных в роду не осталось: женить некого и родить некому. Спасает только чужой род — то есть переворот.');
  }
  if (heir && !crit && adults.length === 0) {
    rows.push(`Наследник один и не дорос (${DYN.ageYearsOf(heir.member)} лет): при регентстве стабильность
      −${DYN.REGENCY_STAB} в сутки, пока ему не исполнится ${DYN.ADULT_YEARS}.`);
  }
  if (rl && risk >= RISK_ALARM && adults.length <= 1) {
    rows.push(`Правителю ${years} ${_pl(years, 'год', 'года', 'лет')}: не пережить год он может с вероятностью
      ${Math.round(risk * 100)}%, а взрослых сменщиков в роду ${adults.length}. Женить наследника — сейчас, а не потом.`);
  }
  if (st.legitimacy < DYN.CLAIM_BELOW && !st.claimants.length) {
    rows.push(`Законность ${Math.round(st.legitimacy)} — ниже ${DYN.CLAIM_BELOW}: со дня на день объявится претендент из чужого рода.`);
  }
  if (!rows.length) return '';

  const col = crit ? 'var(--bad)' : 'var(--warn)';
  return `<div class="card" style="border-color:${col}">
    <div class="ttl"><span style="color:${col}">${crit ? '⚠ РОД НА ГРАНИ ПРЕСЕЧЕНИЯ' : '⚠ Власть держится на одном человеке'}</span>
      <span class="cost" style="color:${col}">${_esc(card ? card.risk : '')}</span></div>
    ${rows.map(r => `<div class="reason">${r}</div>`).join('')}</div>`;
}

// ---------- Голова ----------

function _head(sim, st, c, card) {
  const rl = DYN.ruler(st);
  const law = DYN.SUCCESSION_LAW[c.gov] || DYN.SUCCESSION_LAW.chiefdom;
  const suc = SUCCESSION[c.gov] || SUCCESSION.chiefdom;
  const leg = Math.round(st.legitimacy);
  const col = _legColor(leg);
  const reign = rl ? Math.max(0, Math.floor((c.day - (rl.since || 0)) / DYN.YEAR)) : 0;
  const age = rl ? DYN.ageYearsOf(rl) : 0;
  const risk = rl ? Math.round(yearRisk(age) * 100) : 100;

  return `<div class="card"><div class="ttl"><span>Род ${_esc(st.fam)}</span>
      <span class="cost" style="color:${col}">законность ${leg}</span></div>
    <div class="desc">Основал ${_esc(st.founder)} на ${Math.round(st.foundedDay)}-й день.
      У власти ${st.generations} ${_pl(st.generations, 'поколение', 'поколения', 'поколений')},
      в роду ${st.members.length} ${_pl(st.members.length, 'человек', 'человека', 'человек')}.</div>
    <div class="relbar"><div style="width:${leg}%;background:${col}"></div></div>
    ${st.interregnum > 0
      ? `<div class="kv"><span>Трон</span><span style="color:var(--bad)">пуст ещё ${Math.ceil(st.interregnum)} дн.</span></div>`
      : rl
        ? `<div class="kv"><span>${rl.sex === 'ж' ? 'Правительница' : 'Правитель'}</span>
             <span>${_esc(rl.name)}, ${age} ${_pl(age, 'год', 'года', 'лет')}</span></div>
           <div class="kv"><span>На троне</span><span>${reign} ${_pl(reign, 'год', 'года', 'лет')}</span></div>
           <div class="kv"><span>Риск не пережить год</span>
             <span style="color:${risk >= 20 ? 'var(--bad)' : risk >= 5 ? 'var(--warn)' : 'var(--good)'}">${risk}%</span></div>`
        : `<div class="kv"><span>Правитель</span><span style="color:var(--bad)">никого</span></div>`}
    <div class="kv"><span>Закон наследования</span><span>${_esc(law.ru)}</span></div>
    <div class="kv"><span>Если правитель умрёт сегодня</span>
      <span style="color:${card && card.heir ? 'var(--good)' : 'var(--bad)'}">${_esc(card ? card.risk : '—')}</span></div>
    <div class="desc">Смена власти при этом строе стоит ${suc.stab} стабильности${suc.turmoil ? ` и ${suc.turmoil} дн. смуты` : ' и обходится без смуты'};
      законность просядет на ${(suc.stab * DYN.LEG_PER_STAB).toFixed(1)} — ${_esc(suc.ru)}.</div></div>`;
}

// ---------- Законность ----------
//
// Полоса без разбора — это украшение. Здесь три слоя: сколько есть, что с ней
// сделал ВЧЕРАШНИЙ день (числа из отчёта модели, а не пересчёт), и полный
// список рычагов — чем поднять и чем уронить.

function _legitimacy(sim, st, c, heir) {
  const leg = Math.round(st.legitimacy);
  const col = _legColor(leg);
  const base = Math.round(DYN.baseLegitimacy(st, c.day));
  const rep = dynReport(sim);
  const delta = rep && rep.flags && rep.flags.legDelta != null ? rep.flags.legDelta : null;
  const parts = rep && rep.flags && Array.isArray(rep.flags.legParts) ? rep.flags.legParts : [];
  const said = rep && Array.isArray(rep.reasons) ? rep.reasons.slice(0, 6) : [];

  let html = `<h4 class="group">Законность</h4>
    <div class="card"><div class="ttl"><span>${leg} из 100 — ${_esc(DYN.legitimacyWord(st.legitimacy))}</span>
      ${delta != null ? `<span class="cost" style="color:${delta > 0 ? 'var(--good)' : delta < 0 ? 'var(--bad)' : 'var(--dim)'}">${_sign(delta, 2)} за сутки</span>` : ''}</div>
    <div class="relbar"><div style="width:${leg}%;background:${col}"></div></div>
    <div class="desc">Законность — это не уважение, а право сидеть на троне. От неё зависит,
      придут ли претенденты (ниже ${DYN.CLAIM_BELOW}), разойдутся ли они сами (выше ${DYN.CLAIM_CLEAR})
      и можно ли вообще свергнуть род заговором (выше 75 — нельзя, заговорщиков выдадут).</div>
    <div class="kv"><span>Свой уровень рода</span><span>${base}</span></div>
    <div class="desc">К своему уровню законность тянется сама, по ${DYN.LEG_DRIFT} в сутки — это и есть выход из любой ямы:
      после провала род отлежится, если не наделает новых. Выше ${DYN.LEG_BASE_CAP} сама не растёт — только делами.
      Уровень поднимают поколения на троне (+6 за каждое) и годы (+0.15 в год).</div>`;

  if (parts.length) {
    html += `<div class="kv"><span>Сегодня сложилось из</span><span></span></div>`;
    for (const p of parts) html += `<div class="desc" style="color:var(--dim)">· ${_esc(p)}</div>`;
  }
  html += `</div>`;

  if (said.length) {
    html += `<div class="card"><div class="ttl"><span>Что сказал последний день</span></div>
      ${said.map(r => `<div class="desc">${_esc(r)}</div>`).join('')}</div>`;
  }

  // Рычаги. Все числа — константы dynasty.js, поэтому таблица не соврёт даже
  // после правки баланса: поменяются они — поменяется и текст.
  const lvl = DYN.COURT[_clampInt(st.court, 0, DYN.COURT.length - 1)];
  html += `<div class="card"><div class="ttl"><span style="color:var(--good)">Поднимает</span></div>
    <div class="kv"><span>Триумф, взятый город</span><span style="color:var(--good)">${_sign(DYN.LEG_EVENT.triumph)} / ${_sign(DYN.LEG_EVENT.city_won)}</span></div>
    <div class="kv"><span>Победа в поле</span><span style="color:var(--good)">${_sign(DYN.LEG_EVENT.victory)}</span></div>
    <div class="kv"><span>Подношение двору</span><span style="color:var(--good)">${_sign(DYN.PATRON_LEG)}, раз в ${DYN.PATRON_CD} дн.</span></div>
    <div class="kv"><span>Содержание двора «${_esc(lvl.ru)}»</span><span style="color:${lvl.leg > 0 ? 'var(--good)' : 'var(--bad)'}">${_sign(lvl.leg, 2)} в сутки</span></div>
    <div class="kv"><span>Брак с родом соседа</span><span style="color:var(--good)">${_sign(DYN.MARRY_LEG)}</span></div>
    <div class="desc">Одна и та же беда или победа считается ОДИН раз за ${DYN.SEEN_WINDOW} дней: месяц голода — это один голод,
      иначе законность стояла бы на нуле, пока тянется несчастье.</div></div>`;

  html += `<div class="card"><div class="ttl"><span style="color:var(--bad)">Роняет</span></div>
    <div class="kv"><span>Потеряна провинция</span><span style="color:var(--bad)">${_sign(DYN.LEG_EVENT.city_lost)}</span></div>
    <div class="kv"><span>Восстание · поражение</span><span style="color:var(--bad)">${_sign(DYN.LEG_EVENT.revolt)} · ${_sign(DYN.LEG_EVENT.defeat)}</span></div>
    <div class="kv"><span>Голод · мор</span><span style="color:var(--bad)">${_sign(DYN.LEG_EVENT.famine)} · ${_sign(DYN.LEG_EVENT.plague)}</span></div>
    <div class="kv"><span>Наследника нет</span><span style="color:${!heir ? 'var(--bad)' : 'var(--dim)'}">−${DYN.LEG_NO_HEIR} в сутки</span></div>
    <div class="kv"><span>Преемник назначен вопреки обычаю</span><span style="color:${heir && heir.odd ? 'var(--bad)' : 'var(--dim)'}">−${DYN.LEG_ODD_HEIR} в сутки</span></div>
    <div class="kv"><span>Междуцарствие</span><span style="color:${st.interregnum > 0 ? 'var(--bad)' : 'var(--dim)'}">−${DYN.LEG_INTERREGNUM} в сутки</span></div>
    <div class="kv"><span>Двору не заплатили</span><span style="color:var(--bad)">−${DYN.COURT_UNPAID_LEG} в сутки</span></div>
    <div class="kv"><span>Смена правителя</span><span style="color:var(--bad)">−${((SUCCESSION[c.gov] || SUCCESSION.chiefdom).stab * DYN.LEG_PER_STAB).toFixed(1)}</span></div>
    <div class="desc">У каждой из этих строк есть выход, и он назван там же, где беда: наследника — назначить или родить,
      сомнительное назначение — отменить, двор — понизить. Спирали без выхода здесь нет.</div></div>`;

  html += `<div class="card"><div class="ttl"><span>Что законность даёт державе</span></div>
    <div class="kv"><span>Стабильность</span><span style="color:${leg >= 50 ? 'var(--good)' : 'var(--bad)'}">${_sign((leg - 50) / 50 * 0.3, 2)} в сутки</span></div>
    <div class="kv"><span>Знать</span><span>${_sign((leg - 50) / 50 * 0.04, 2)} в сутки</span></div>
    <div class="kv"><span>Войско</span><span>${_sign((leg - 50) / 50 * 0.02, 2)} в сутки</span></div>
    <div class="kv"><span>Претенденты стоят</span><span style="color:${st.claimants.length ? 'var(--bad)' : 'var(--dim)'}">−${(st.claimants.length * DYN.CLAIM_STAB).toFixed(2)} стабильности в сутки</span></div></div>`;
  return html;
}

// ---------- Древо рода ----------

function _tree(sim, st, c, heir) {
  const rl = DYN.ruler(st);
  const spouse = rl && rl.spouse != null ? DYN.memberOf(st, rl.spouse) : null;
  let html = `<h4 class="group">Древо рода</h4>`;

  // Правитель и его супруг — одной карточкой: это одна семья, а не два списка.
  if (rl) {
    const age = DYN.ageYearsOf(rl);
    html += `<div class="card"><div class="ttl"><span>♛ ${_esc(rl.name)} ${_esc(st.fam)}</span>
        <span class="cost">${age} ${_pl(age, 'год', 'года', 'лет')}</span></div>
      <div class="desc">${rl.sex === 'ж' ? 'Правительница' : 'Правитель'} · сила в глазах дружины ${DYN.powerOf(rl)}
        · ${rl.traits.length ? rl.traits.map(t => _esc(_traitRu(t))).join(', ') : 'без ярких черт'}</div>
      ${spouse
        ? `<div class="kv"><span>⚭ Супруг${spouse.sex === 'ж' ? 'а' : ''}</span>
             <span>${_esc(spouse.name)} ${_esc(spouse.fam)}, ${DYN.ageYearsOf(spouse)} ${_pl(DYN.ageYearsOf(spouse), 'год', 'года', 'лет')}${spouse.origin === 'foreign' ? ' (чужой род)' : ''}</span></div>`
        : `<div class="kv"><span>⚭ Супруг</span><span style="color:var(--warn)">нет — детей не будет</span></div>`}</div>`;
  } else {
    html += `<div class="card"><div class="ttl"><span style="color:var(--bad)">Трон пуст</span></div>
      <div class="desc">Междуцарствие. Пока никто не сел на трон, род не правит, а держава расплачивается стабильностью.</div></div>`;
  }

  // Наследник отдельной карточкой и явной пометкой: это первое, что игрок ищет.
  if (heir) {
    const y = DYN.ageYearsOf(heir.member);
    const col = heir.odd ? 'var(--warn)' : 'var(--accent)';
    html += `<div class="card" style="border-color:${col}"><div class="ttl">
        <span style="color:${col}">★ НАСЛЕДНИК: ${_esc(heir.name)}</span>
        <span class="cost">${y} ${_pl(y, 'год', 'года', 'лет')}</span></div>
      <div class="desc">${_esc(heir.why)}${heir.minor ? ' · не дорос: сядет под регентство' : ''}</div>
      ${heir.odd ? `<div class="reason">Обычай обойдён: законность −${DYN.LEG_ODD_HEIR} в сутки, пока назначение стоит. Выход — отменить его.</div>` : ''}</div>`;
  } else {
    html += `<div class="card" style="border-color:var(--bad)"><div class="ttl"><span style="color:var(--bad)">★ Наследника нет</span></div>
      <div class="desc">${(DYN.SUCCESSION_LAW[c.gov] || {}).law === 'election'
        ? 'При республике наследников не бывает: власть решают выборы, и род удержит её только высокой законностью (от 60).'
        : 'Никто не подходит под закон строя. Назначьте наследника вручную — кнопка стоит у каждого кровного ниже.'}</div></div>`;
  }

  // Кровные — те, кто может наследовать. Именно у них стоит кнопка назначения.
  const blood = st.members.filter(m => m.blood && m.id !== st.rulerId);
  const kids = rl ? blood.filter(m => m.father === rl.id || m.mother === rl.id) : [];
  const kin = blood.filter(m => !kids.includes(m));
  html += _kinGroup(sim, st, c, heir, kids, 'Дети правителя',
    'Дети — единственный способ продлить род без переворота. Без супруга их не будет.');
  html += _kinGroup(sim, st, c, heir, kin, 'Прочая кровь рода',
    'Братья, племянники, внуки. При вождестве трон берёт сильнейший из них, при монархии — старший, если детей нет.');

  // Вошедшие через брак не наследуют — но их видно, иначе непонятно, откуда
  // в роду люди с чужой фамилией и почему у соседа права на трон.
  const married = st.members.filter(m => !m.blood);
  if (married.length) {
    html += `<div class="card"><div class="ttl"><span>Вошли в род через брак</span><span class="cost">${married.length}</span></div>
      <div class="desc">Наследовать не могут: иначе трон уходил бы к вдове чужого рода, и женитьба означала бы подарить державу.</div>
      ${married.map(m => {
        const y = DYN.ageYearsOf(m);
        const sp = m.spouse != null ? DYN.memberOf(st, m.spouse) : null;
        return `<div class="kv"><span>${_esc(m.name)} ${_esc(m.fam)}${m.origin === 'foreign' ? ' · чужой род' : ''}</span>
          <span>${y} ${_pl(y, 'год', 'года', 'лет')}${sp ? ` · ⚭ ${_esc(sp.name)}` : ''}</span></div>`;
      }).join('')}</div>`;
  }
  if (st.members.length >= DYN.MAX_MEMBERS) {
    html += `<div class="card"><div class="desc">Род упёрся в потолок ${DYN.MAX_MEMBERS} человек: самые дальние от трона
      перестают считаться роднёй. Правитель, наследник и супруг не выбывают никогда.</div></div>`;
  }
  return html;
}

function _kinGroup(sim, st, c, heir, list, title, note) {
  if (!list.length) {
    return `<div class="card"><div class="ttl"><span>${title}</span><span class="cost" style="color:var(--warn)">никого</span></div>
      <div class="desc">${note}</div></div>`;
  }
  const sorted = list.slice().sort((a, b) => (b.id === (heir && heir.id) ? 1 : 0) - (a.id === (heir && heir.id) ? 1 : 0) || b.age - a.age);
  let html = `<div class="card"><div class="ttl"><span>${title}</span><span class="cost">${list.length}</span></div>
    <div class="desc">${note}</div></div>`;
  for (const m of sorted) html += _kinCard(sim, st, c, heir, m);
  return html;
}

function _kinCard(sim, st, c, heir, m) {
  const y = DYN.ageYearsOf(m);
  const isHeir = !!heir && heir.id === m.id;
  const named = st.namedHeirId === m.id;
  const sp = m.spouse != null ? DYN.memberOf(st, m.spouse) : null;
  const chk = DYN.canNameHeir(st, m.id, c);
  const spec = `heir:${m.id}`;
  const odd = chk.ok && chk.odd;

  let html = `<div class="card"${isHeir ? ' style="border-color:var(--accent)"' : ''}>
    <div class="ttl"><span${isHeir ? ' style="color:var(--accent)"' : ''}>${isHeir ? '★ ' : ''}${_esc(m.name)}${m.sex === 'ж' ? ' (дочь рода)' : ''}</span>
      <span class="cost">${y} ${_pl(y, 'год', 'года', 'лет')}</span></div>
    <div class="kv"><span>Сила в глазах дружины</span><span>${DYN.powerOf(m)}</span></div>
    ${m.traits.length ? `<div class="kv"><span>Черты</span><span>${m.traits.map(t => _esc(_traitRu(t))).join(', ')}</span></div>` : ''}
    ${sp ? `<div class="kv"><span>⚭ В браке</span><span>${_esc(sp.name)} ${_esc(sp.fam)}</span></div>`
        : y >= DYN.MARRY_MIN ? `<div class="kv"><span>⚭ Не женат</span><span style="color:var(--dim)">можно женить на роде соседа</span></div>` : ''}
    ${named ? `<div class="desc" style="color:var(--accent)">Назначен волей правителя.</div>` : ''}`;

  if (named) {
    html += _btn('heir:clear', 'Отменить назначение — трон снова по обычаю, шёпот знати стихнет',
      _actReady('dynastyClearHeir') ? { ok: true } : { ok: false, reason: NOT_WIRED }, sim, false);
  } else if (chk.ok) {
    html += _btn(spec, odd
      ? `Назначить наследником — законность ${DYN.NAME_HEIR_LEG}, знать ${DYN.NAME_HEIR_NOBLES}, и −${DYN.LEG_ODD_HEIR}/сут, пока стоит`
      : 'Назначить наследником — при этом строе назначение и есть закон, цены нет',
      _actReady('dynastyNameHeir') ? { ok: true } : { ok: false, reason: NOT_WIRED }, sim, false);
  } else {
    html += _btn(spec, 'Назначить наследником', chk, sim, false);
  }
  return html + `</div>`;
}

// ---------- Претенденты ----------

function _claimants(sim, st, c) {
  let html = `<h4 class="group">Претенденты</h4>`;
  if (!st.claimants.length) {
    return html + `<div class="card"><div class="desc">Чужих рук на троне нет. Претендент объявляется, пока законность ниже
      ${DYN.CLAIM_BELOW} (шанс ${(DYN.CLAIM_CHANCE * 100).toFixed(1)}% в сутки), и расходится сам, когда она поднимется выше
      ${DYN.CLAIM_CLEAR}. Больше ${DYN.MAX_CLAIMANTS} их не бывает — иначе это была бы спираль без выхода:
      претенденты роняли бы законность, а та плодила бы новых.</div></div>`;
  }
  html += `<div class="card"><div class="desc">Каждый претендент стоит ${DYN.CLAIM_STAB} стабильности в сутки.
    Законности они НЕ роняют — только стабильность: иначе яма стала бы бездонной. Уйдут сами,
    когда законность перевалит за ${DYN.CLAIM_CLEAR}.</div></div>`;

  st.claimants.forEach((cl, i) => {
    const y = Math.floor(cl.age / DYN.YEAR);
    const s = cl.strength;
    const word = s >= 70 ? 'смертельно опасен' : s >= 50 ? 'опасен' : s >= 30 ? 'заметен' : 'слаб';
    const col = s >= 70 ? 'var(--bad)' : s >= 50 ? 'var(--warn)' : 'var(--dim)';
    const f = cl.fid && typeof sim.faction === 'function' ? sim.faction(cl.fid) : null;
    html += `<div class="card"><div class="ttl"><span>${_esc(cl.name)} из рода ${_esc(cl.fam)}</span>
        <span class="cost" style="color:${col}">${word} · ${s}</span></div>
      <div class="relbar"><div style="width:${s}%;background:${col}"></div></div>
      <div class="kv"><span>Возраст</span><span>${y} ${_pl(y, 'год', 'года', 'лет')}</span></div>
      <div class="kv"><span>Объявился</span><span>день ${Math.round(cl.since)}</span></div>
      ${f ? `<div class="kv"><span>За спиной</span><span style="color:${f.color || 'var(--accent)'}">${_esc(f.name)}</span></div>`
          : cl.fid ? `<div class="kv"><span>За спиной</span><span>род соседа</span></div>` : ''}
      ${_coupBtn(sim, st, c, i, cl)}</div>`;
  });
  return html;
}

// ---------- Черты правителя ----------

function _traits(sim, st, c) {
  const rl = DYN.ruler(st);
  let html = `<h4 class="group">Черты правителя</h4>`;
  if (!rl) return html + `<div class="card"><div class="desc">Трон пуст — черт нет и множителей тоже.</div></div>`;
  if (!rl.traits.length) {
    return html + `<div class="card"><div class="desc">${_esc(rl.name)} ничем не выделяется: держава живёт на своих числах,
      без надбавок и без потерь. Это лучше, чем слабоволие, и хуже, чем полководец.</div></div>`;
  }
  html += `<div class="card"><div class="desc">Черты наследуются с вероятностью ${Math.round(DYN.TRAIT_INHERIT * 100)}%:
    у сына полководца больше шансов стать полководцем. Поэтому выбор наследника — это выбор множителей на десятилетия,
    а не только имени.</div></div>`;
  for (const id of rl.traits) {
    const def = TRAIT_BY_ID[id];
    if (!def) continue;
    const eff = [];
    for (const [kind, v] of Object.entries(def.mult || {})) {
      const pct = Math.round((v - 1) * 100);
      if (pct) eff.push(`${_kindRu(kind)} ${_sign(pct)}%`);
    }
    if (def.happy) eff.push(`счастье ${_sign(def.happy)}`);
    if (def.stabPerDay) eff.push(`стабильность ${_sign(def.stabPerDay, 1)} в сутки`);
    const w = DYN.TRAIT_POWER[id] || 0;
    html += `<div class="card"><div class="ttl"><span>${_esc(def.ru)}</span>
        <span class="cost" style="color:${w > 0 ? 'var(--good)' : w < 0 ? 'var(--bad)' : 'var(--dim)'}">вес в роду ${_sign(w)}</span></div>
      <div class="desc">${eff.length ? eff.join(' · ') : 'прямых множителей нет'}</div>
      <div class="desc" style="color:var(--dim)">Вес в роду — это сила в глазах дружины: по ней вождество выбирает
        сильнейшего наследника, по ней же претендент считает свои шансы.</div></div>`;
  }
  return html;
}

// ---------- Действия ----------
//
// Цена и последствия — НА КНОПКЕ, а не в подсказке: подсказку на телефоне
// не наведёшь, а необратимое решение принимается пальцем. Недоступная кнопка
// остаётся на месте серой и с причиной: спрятанная кнопка — это загадка, а не
// интерфейс, и игрок не узнает, что переворот вообще возможен.

function _actions(sim, st, c, heir) {
  let html = `<h4 class="group">Решения</h4>`;
  html += _courtSection(sim, st, c);
  html += _marrySection(sim, st, c, heir);
  html += _coupSection(sim, st, c);
  return html;
}

function _courtSection(sim, st, c) {
  const lvl = DYN.COURT[_clampInt(st.court, 0, DYN.COURT.length - 1)];
  const gold = courtGold(st, c);
  const chk = DYN.canPatronize(st, c);
  const cost = DYN.patronCost(c);
  const cash = Math.round(c.gold);

  let html = `<div class="card"><div class="ttl"><span>Двор: ${_esc(lvl.ru)}</span>
      <span class="cost">${gold.toFixed(1)} 🪙 в сутки</span></div>
    <div class="desc">Двор — это то, что видят знать и послы. Содержание переключается в любой день в любую сторону:
      это и есть выход из петли «двор дорог» — не влезайте в долги, понижайте ступень.</div>
    <div class="kv"><span>Законность</span><span style="color:${lvl.leg > 0 ? 'var(--good)' : 'var(--bad)'}">${_sign(lvl.leg, 2)} в сутки</span></div>
    <div class="kv"><span>Знать · простолюдины</span><span>${_sign(lvl.nobles, 2)} · ${_sign(lvl.commons, 2)}</span></div>
    ${lvl.happy ? `<div class="kv"><span>Счастье</span><span style="color:var(--bad)">${_sign(lvl.happy)}</span></div>` : ''}
    ${gold > cash ? `<div class="reason">Казны (${cash} 🪙) не хватает на двор: законность −${DYN.COURT_UNPAID_LEG} в сутки и обида знати. Понизьте содержание.</div>` : ''}</div>`;

  for (const lv of DYN.COURT) {
    if (lv.id === st.court) continue;
    const g = lv.gold * (1 + (c.pop || 0) * DYN.COURT_PER_POP);
    const can = DYN.canSetCourt(st, lv.id);
    const label = `${lv.ru} — ${g.toFixed(1)} 🪙/сут, законность ${_sign(lv.leg, 2)}/сут, знать ${_sign(lv.nobles, 2)}, простолюдины ${_sign(lv.commons, 2)}`;
    html += `<div class="card"><div class="ttl"><span>${_esc(lv.ru)}</span><span class="cost">${g.toFixed(1)} 🪙 в сутки</span></div>
      ${_btn(`court:${lv.id}`, label, can.ok && _actReady('dynastySetCourt') ? { ok: true } : (can.ok ? { ok: false, reason: NOT_WIRED } : can), sim, false)}</div>`;
  }

  const patronLabel = `Поддержать двор — ${cost} 🪙 → законность +${DYN.PATRON_LEG}, знать +4, простолюдины −3`;
  html += `<div class="card"><div class="ttl"><span>Поддержать двор</span><span class="cost">${cost} 🪙</span></div>
    <div class="desc">Пиры, дары, послы. Цена растёт с державой: ${DYN.PATRON_COST} + ${DYN.PATRON_PER_POP} 🪙 за жителя (сейчас ${c.pop}).
      Повторить можно через ${DYN.PATRON_CD} дней — иначе законность покупалась бы кнопкой, а не делами.</div>
    ${_btn('patron', patronLabel, chk.ok && _actReady('dynastyPatronize') ? { ok: true } : (chk.ok ? { ok: false, reason: NOT_WIRED } : chk), sim, false)}</div>`;
  return html;
}

function _marrySection(sim, st, c, heir) {
  const who = heir ? heir.member : DYN.bloodMembers(st)
    .filter(x => x.id !== st.rulerId && x.spouse == null)
    .sort((a, b) => b.age - a.age)[0] || null;

  let html = `<div class="card"><div class="ttl"><span>Женить наследника</span>
      <span class="cost">отношения +${DYN.MARRY_REL}</span></div>
    <div class="desc">Брак с родом соседа — это союз и права на трон В ОБЕ СТОРОНЫ. Мы получаем право на их трон,
      они — на наш: именно из этих браков потом приходят претенденты, когда законность падает ниже ${DYN.CLAIM_BELOW}.
      Сила чужого права — ${DYN.FOREIGN_CLAIM}.</div>
    <div class="kv"><span>Кого женим</span><span>${who ? `${_esc(who.name)}, ${DYN.ageYearsOf(who)} ${_pl(DYN.ageYearsOf(who), 'год', 'года', 'лет')}` : '—'}</span></div></div>`;

  if (st.ties.length) {
    html += `<div class="card done-card"><div class="ttl"><span>Уже породнились</span><span class="cost">${st.ties.length}</span></div>
      ${st.ties.map(t => {
        const f = typeof sim.faction === 'function' ? sim.faction(t.fid) : null;
        return `<div class="kv"><span>род ${_esc(t.house)}${f ? ` (${_esc(f.name)})` : ''}</span>
          <span>с дня ${Math.round(t.since)} · право на наш трон ${Math.round(t.claim)}</span></div>`;
      }).join('')}</div>`;
  }

  const list = Array.isArray(sim.factions) ? sim.factions : [];
  if (!list.length) {
    return html + `<div class="card"><div class="desc">Соседей ещё не встретили: роднить не с кем.</div></div>`;
  }
  for (const f of list) {
    const rel = _rel(sim, f.id);
    const chk = DYN.canMarryHeir(st, c, { fid: f.id, rel });
    const ready = _actReady('dynastyMarry');
    const label = `Женить на роде ${f.name} — отношения ${_sign(DYN.MARRY_REL)}, законность ${_sign(DYN.MARRY_LEG)}; цена: их право на наш трон ${DYN.FOREIGN_CLAIM}`;
    html += `<div class="card${chk.ok ? '' : ' disabled'}">
      <div class="ttl"><span><span style="color:${f.color || 'var(--accent)'}">⬤</span> ${_esc(f.name)}</span>
        <span class="cost" style="color:${rel >= 0 ? 'var(--good)' : 'var(--bad)'}">отношения ${Math.round(rel)}</span></div>
      ${f.leader ? `<div class="desc">${_esc(f.leader)}</div>` : ''}
      ${_btn(`marry:${f.id}`, label, chk.ok && ready ? { ok: true } : (chk.ok ? { ok: false, reason: NOT_WIRED } : chk), sim, true)}</div>`;
  }
  return html;
}

function _coupSection(sim, st, c) {
  const chk = DYN.canOverthrow(st, c, {});
  return `<div class="card"><div class="ttl"><span>Свергнуть правителя</span>
      <span class="cost" style="color:var(--bad)">−${DYN.COUP_STAB} стабильности</span></div>
    <div class="desc">Заговор ставит НОВЫЙ род: прежний уходит целиком, вместе с наследниками, браками и чужими правами.
      Законность нового дома — ${DYN.COUP_LEG}, её придётся заслуживать заново, и первые годы он будет уязвим для таких же заговорщиков.</div>
    <div class="kv"><span>Нужна знать</span><span style="color:${c.nobles >= DYN.COUP_NEED_NOBLES ? 'var(--good)' : 'var(--bad)'}">${DYN.COUP_NEED_NOBLES} (есть ${Math.round(c.nobles)})</span></div>
    <div class="kv"><span>Нужно войско</span><span style="color:${c.military >= DYN.COUP_NEED_MILITARY ? 'var(--good)' : 'var(--bad)'}">${DYN.COUP_NEED_MILITARY} (есть ${Math.round(c.military)})</span></div>
    <div class="kv"><span>Нужна стабильность</span><span style="color:${c.stability >= DYN.COUP_STAB ? 'var(--good)' : 'var(--bad)'}">${DYN.COUP_STAB} (есть ${Math.round(c.stability)})</span></div>
    <div class="kv"><span>Законность рода</span><span style="color:${st.legitimacy < 75 ? 'var(--good)' : 'var(--bad)'}">ниже 75 (сейчас ${Math.round(st.legitimacy)})</span></div>
    ${_btn('coup', `Переворот — −${DYN.COUP_STAB} стабильности, знать −5, простолюдины −5, войско +3; новый род с законностью ${DYN.COUP_LEG}`,
      chk.ok && _actReady('dynastyOverthrow') ? { ok: true } : (chk.ok ? { ok: false, reason: NOT_WIRED } : chk), sim, true)}</div>`;
}

// Кнопка переворота в пользу конкретного претендента: то же действие, но трон
// берёт названный человек, а не безымянный узурпатор.
function _coupBtn(sim, st, c, i, cl) {
  const chk = DYN.canOverthrow(st, c, { claimant: i });
  const label = `Возвести ${cl.name} — −${DYN.COUP_STAB} стабильности; род ${cl.fam} садится на трон с законностью ${DYN.COUP_LEG}`;
  return _btn(`coup:${i}`, label,
    chk.ok && _actReady('dynastyOverthrow') ? { ok: true } : (chk.ok ? { ok: false, reason: NOT_WIRED } : chk), sim, true);
}

// ---------- Погост и счёт ----------

function _graves(st, c) {
  if (!st.graves.length) return '';
  // Умершие бледнее живых — намеренно: это память, а не действующие лица.
  // Глубина списка ограничена самим родом (GRAVE_KEEP), панель ничего не режет.
  return `<h4 class="group">Погост</h4>
    <div class="card" style="opacity:0.55"><div class="ttl"><span style="color:var(--dim)">Кого помнит род</span>
        <span class="cost" style="color:var(--dim)">последние ${st.graves.length}</span></div>
      ${st.graves.slice().reverse().map(g => `<div class="kv">
        <span style="color:var(--dim)">✝ ${_esc(g.name)}</span>
        <span style="color:var(--dim)">${g.years} ${_pl(g.years, 'год', 'года', 'лет')} · день ${Math.round(g.day)}${c.day - g.day < DYN.YEAR ? ' · в этом году' : ''}</span></div>`).join('')}</div>`;
}

function _stats(st, c) {
  const s = st.stats || {};
  const years = Math.floor(Math.max(0, c.day - st.foundedDay) / DYN.YEAR);
  return `<h4 class="group">Счёт рода</h4>
    <div class="card">
      <div class="kv"><span>Дом стоит</span><span>${years} ${_pl(years, 'год', 'года', 'лет')}</span></div>
      <div class="kv"><span>Правителей сменилось</span><span>${s.rulers || 0}</span></div>
      <div class="kv"><span>Родилось · умерло</span><span>${s.births || 0} · ${s.deaths || 0}</span></div>
      <div class="kv"><span>Переворотов</span><span style="color:${s.coups ? 'var(--bad)' : 'var(--dim)'}">${s.coups || 0}</span></div>
      <div class="kv"><span>Междуцарствий</span><span style="color:${s.interregnums ? 'var(--bad)' : 'var(--dim)'}">${s.interregnums || 0}</span></div>
      <div class="kv"><span>Домов на троне</span><span>${s.houses || 1}</span></div></div>`;
}

// ════════════════════════ ДЕЙСТВИЯ ════════════════════════

// Разбор строки вида 'marry:wolves'. Вся проверка доступна без DOM — и тесту,
// и консоли. Возвращает { ok, text|reason, sound, confirm }.
export function handleDynastyAction(sim, spec) {
  const st = dynState(sim);
  if (!st) return { ok: false, reason: 'Род не подключён к ядру' };
  const parts = String(spec || '').split(':');
  const kind = parts[0];
  const c = dynCtx(sim);

  if (kind === 'patron') {
    const chk = DYN.canPatronize(st, c);
    if (!chk.ok) return { ok: false, reason: chk.reason };
    return _run(sim, 'dynastyPatronize', [], `Двору поднесены дары: законность +${DYN.PATRON_LEG}`, 'coin');
  }

  if (kind === 'court') {
    const lvl = Number(parts[1]);
    const chk = DYN.canSetCourt(st, lvl);
    if (!chk.ok) return { ok: false, reason: chk.reason };
    return _run(sim, 'dynastySetCourt', [lvl], `Двор: ${DYN.COURT[lvl].ru}`, 'click');
  }

  if (kind === 'heir') {
    if (parts[1] === 'clear') {
      if (st.namedHeirId == null) return { ok: false, reason: 'Наследник и не назначался' };
      return _run(sim, 'dynastyClearHeir', [], 'Назначение отменено: трон снова по обычаю', 'click');
    }
    const id = Number(parts[1]);
    const chk = DYN.canNameHeir(st, id, c);
    if (!chk.ok) return { ok: false, reason: chk.reason };
    return _run(sim, 'dynastyNameHeir', [id], `Наследником объявлен ${chk.member.name}`, 'click');
  }

  if (kind === 'marry') {
    const fid = parts.slice(1).join(':');   // на случай, если в id соседа окажется двоеточие
    const chk = DYN.canMarryHeir(st, c, { fid, rel: _rel(sim, fid) });
    if (!chk.ok) return { ok: false, reason: chk.reason };
    const f = typeof sim.faction === 'function' ? sim.faction(fid) : null;
    const need = _confirm(sim, spec, `Брак навсегда отдаёт роду ${f ? f.name : 'соседа'} право на наш трон (${DYN.FOREIGN_CLAIM}). Нажмите ещё раз.`);
    if (need) return need;
    return _run(sim, 'dynastyMarry', [fid, f ? f.name : undefined],
      `${chk.member.name} женится: отношения +${DYN.MARRY_REL}`, 'era');
  }

  if (kind === 'coup') {
    const idx = parts[1] != null && parts[1] !== '' ? Number(parts[1]) : null;
    const chk = DYN.canOverthrow(st, c, idx != null ? { claimant: idx } : {});
    if (!chk.ok) return { ok: false, reason: chk.reason };
    const need = _confirm(sim, spec, `Переворот сметёт род ${st.fam} целиком — с наследниками и союзами. Нажмите ещё раз.`);
    if (need) return need;
    return _run(sim, 'dynastyOverthrow', [idx], `Род ${st.fam} низложен`, 'alarm');
  }

  return { ok: false, reason: 'Неизвестная операция' };
}

// Есть ли применитель. Панель включают раньше связи — это норма, а не сбой.
function _actReady(name) { return typeof INT[name] === 'function'; }

function _run(sim, name, args, text, sound) {
  const fn = INT[name];
  if (typeof fn !== 'function') return { ok: false, reason: NOT_WIRED };
  const r = fn(sim, ...args) || {};
  if (r.ok === false) return { ok: false, reason: r.reason || 'Отказано' };
  return { ok: true, text, sound };
}

// Первое нажатие только просит подтверждения, второе — совершает. Возвращает
// готовый ответ, если подтверждение ещё нужно, и null, если можно действовать.
// Срок в игровых днях, а не в секундах: на паузе игрок читает сколько хочет.
function _confirm(sim, spec, text) {
  const cur = CONFIRM.get(sim);
  const day = sim.day || 0;
  if (cur && cur.spec === spec && Math.abs(day - cur.day) <= CONFIRM_DAYS) {
    CONFIRM.delete(sim);
    return null;
  }
  CONFIRM.set(sim, { spec, day });
  return { ok: true, text, sound: 'click', confirm: true };
}

function _awaiting(sim, spec) {
  const cur = CONFIRM.get(sim);
  return !!cur && cur.spec === spec && Math.abs((sim.day || 0) - cur.day) <= CONFIRM_DAYS;
}

// ════════════════════════ ПРИВЯЗКА ════════════════════════

// Порядок доводов терпим намеренно. В hud.js панели зовутся как
// bind(root, sim, opts) — так их дёргает общий цикл по PANELS; в задании на эту
// панель контракт записан как bind(sim, root, hud). Определять «кто есть кто»
// по типу дешевле, чем ловить панель, которая молча не привязалась: у корня
// есть querySelectorAll, у sim его нет.
export function bindDynastyPanel(a, b, opts = {}) {
  const root = _isRoot(a) ? a : _isRoot(b) ? b : null;
  const sim = _isSim(a) ? a : _isSim(b) ? b : null;
  if (!root || !sim) return 0;
  const o = _opts(opts);
  let bound = 0;
  for (const el of Array.from(root.querySelectorAll('[data-dyn]'))) {
    const spec = (el.dataset && el.dataset.dyn) ||
      (typeof el.getAttribute === 'function' ? el.getAttribute('data-dyn') : '');
    el.onclick = () => {
      const r = handleDynastyAction(sim, spec);
      if (!r.ok) {
        o.toast(r.reason, 'warn');
        o.play('deny');
      } else {
        if (r.text) o.toast(r.text, r.confirm ? 'warn' : 'good');
        o.play(r.sound || 'click');
      }
      o.refresh();
      return r;
    };
    bound++;
  }
  return bound;
}

function _isRoot(x) { return !!x && typeof x.querySelectorAll === 'function'; }
function _isSim(x) { return !!x && !_isRoot(x) && (x.dynasty !== undefined || x.res !== undefined || x.day !== undefined); }

// Третьим доводом может прийти и ctx панелей { toast, audio, refresh }, и сам
// Hud: у него те же toast/audio, только перерисовка зовётся renderPanel.
function _opts(o) {
  o = o || {};
  return {
    toast: typeof o.toast === 'function' ? (t, k) => o.toast(t, k) : () => {},
    play: o.audio && typeof o.audio.play === 'function' ? (n) => o.audio.play(n) : () => {},
    refresh: typeof o.refresh === 'function' ? () => o.refresh()
      : typeof o.renderPanel === 'function' ? () => o.renderPanel() : () => {},
  };
}

// Короткие имена под общий контракт панелей (как в wire_empire.js).
export { renderDynastyPanel as renderPanel, bindDynastyPanel as bindPanel };

// ════════════════════════ МЕЛОЧИ ════════════════════════

// Кнопка с ценой на самой кнопке. chk — результат can*(): { ok } или
// { ok:false, reason }. Недоступная НЕ ПРЯЧЕТСЯ: серая, с причиной под ней.
function _btn(spec, label, chk, sim, danger) {
  if (!chk.ok) {
    return `<button class="btn" style="width:100%;margin-top:8px" disabled>${_esc(label)}</button>
      <div class="reason">${_esc(chk.reason || 'Недоступно')}</div>`;
  }
  const wait = _awaiting(sim, spec);
  const cls = wait ? 'btn danger' : danger ? 'btn danger' : 'btn';
  return `<button class="${cls}" style="width:100%;margin-top:8px" data-dyn="${_esc(spec)}">${
    wait ? 'Подтвердить: назад пути нет' : _esc(label)}</button>`;
}

function _legColor(v) { return v >= 60 ? 'var(--good)' : v >= DYN.CLAIM_BELOW ? 'var(--warn)' : 'var(--bad)'; }

function _traitRu(id) { const t = TRAIT_BY_ID[id]; return t ? t.ru : id; }

// Названия видов деятельности — те же слова, что на других панелях: игрок не
// должен догадываться, что «army» в одном месте и «армия» в другом — одно и то же.
function _kindRu(kind) {
  return { army: 'армия', build: 'стройка', knowledge: 'знание', gold: 'золото',
    gather: 'добыча', industry: 'промышленность', unrest: 'беспорядки' }[kind] || kind;
}

function _rel(sim, fid) {
  const r = sim && sim.relations ? sim.relations[fid] : 0;
  if (typeof r === 'number') return r;
  if (r && typeof r.v === 'number') return r.v;
  return 0;
}

// Знак пишем типографским минусом: «-5» в интерфейсе читается как дефис.
function _sign(v, digits = 0) {
  const n = Number(v) || 0;
  const a = Math.abs(n).toFixed(digits);
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${a}`;
}

function _pl(n, one, few, many) {
  const a = Math.abs(Math.round(n)) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

function _clampInt(v, lo, hi) { return Math.max(lo, Math.min(hi, Math.round(Number(v) || 0))); }

// Имена приходят из data.js и из рода — там только кириллица. Экранирование
// стоит не от них, а от чужого сейва: битый файл не должен уметь класть разметку
// в панель. Дёшево и раз навсегда.
function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ═════════════════════════════════════════════════════════════════════════════
// ПОДКЛЮЧЕНИЕ
//
// Все якоря проверены grep-ом, счётчик совпадений указан у каждого.
// Я не редактировал ни одного существующего файла.
//
// ── 1. ВКЛАДКА И ЭКРАН: app/src/ui/hud.js ───────────────────────────────────
//
// 1.1 Импорт. Якорь (1 совпадение):
//
// import { renderMarketPanel, bindMarketPanel, createMarketPanelState } from './panel_market.js';
//
//     ПОСЛЕ него добавить:
//
// import { renderDynastyPanel, bindDynastyPanel } from './panel_dynasty.js';
//
// 1.2 Вкладка. Якорь в массиве TABS (1 совпадение):
//
//   { id: 'empire', ru: 'Города', ic: '🏛' },
//
//     ПОСЛЕ него добавить (род стоит сразу за «Державой» и «Городами» —
//     это тот же куст власти, и игрок ищет его там):
//
//   { id: 'dynasty', ru: 'Род', ic: '♛' },
//
// 1.3 Метод панели. renderPanel() зовёт this['panel_' + this.tab](), больше
//     ничего не нужно. Якорь (1 совпадение):
//
//   panel_empire()   { return PANELS.empire.render(this.sim); }
//
//     ПОСЛЕ него добавить:
//
//   panel_dynasty()  { return renderDynastyPanel(this.sim); }
//
// 1.4 Привязка. Если вы делаете шаг 2 (запись в PANELS), НИЧЕГО ДЕЛАТЬ НЕ НАДО:
//     в конце bindPanel уже стоит цикл `for (const p of Object.values(PANELS))`,
//     он и привяжет. Если шаг 2 пропущен — добавьте явную привязку. Якорь в
//     bindPanel (1 совпадение):
//
//     bindMarketPanel(root, this.sim, {
//
//     ...найдя весь этот вызов, ПОСЛЕ его закрывающей строки `});` добавить:
//
//     bindDynastyPanel(root, this.sim, {
//       toast: (t, k) => this.toast(t, k),
//       audio: this.audio,
//       refresh: () => this.renderPanel(),
//     });
//
//     Свой атрибут data-dyn взят намеренно: с data-build/data-tech он не
//     пересекается, поэтому чужой `c.onclick = ...` его не затрёт.
//
// ── 2. ЗАПИСЬ В PANELS: app/src/core/systems/integrate.js ────────────────────
//
// 2.1 Импорт. Якорь (1 совпадение):
//
// import { createRng } from '../rng.js';
//
//     ПОСЛЕ него добавить:
//
// import * as DPAN from '../../ui/panel_dynasty.js';
//
//     ОГОВОРКА, которую надо прочитать до вставки. Правило «ядро не знает про
//     экран» здесь формально нарушается: core импортирует файл из ui/. Сам файл
//     безопасен — DOM он не трогает, render возвращает строку, корень приходит
//     доводом, в node он грузится, — но направление зависимости неприятное.
//     Если вы это направление бережёте, ПРОПУСТИТЕ весь шаг 2 и оставьте
//     подключение из hud.js (шаги 1.1–1.4): панель полностью работоспособна
//     без записи в PANELS. Шаг 2 нужен только тем, кто хочет держать все новые
//     экраны в одном реестре.
//
// 2.2 Реестр. Якорь (1 совпадение):
//
//   empire:   { render: EMP.renderEmpirePanel,     bind: EMP.bindEmpirePanel },
//
//     ПОСЛЕ него добавить:
//
//   dynasty:  { render: DPAN.renderDynastyPanel,   bind: DPAN.bindDynastyPanel },
//
//     Если шаг 2 сделан, метод из 1.3 можно записать через реестр —
//     panel_dynasty()  { return PANELS.dynasty.render(this.sim); } — и тогда
//     импорт из 1.1 не нужен. Одно из двух, не оба сразу.
//
// ── 3. ПРИМЕНИТЕЛИ ДЕЙСТВИЙ: app/src/core/systems/integrate.js ───────────────
//
// Кнопки зовут ровно те функции, которые описал в своей шапке dynasty.js:
// dynastyPatronize, dynastySetCourt, dynastyNameHeir, dynastyMarry,
// dynastyOverthrow. Их вставку описывает сам dynasty.js (его блок ПОДКЛЮЧЕНИЕ,
// раздел 5) — повторять её здесь я не стал, чтобы не разошлись две копии.
//
// Мне нужна ОДНА функция сверх того списка — отмена назначения наследника.
// Без неё назначение вопреки обычаю становится ловушкой: −0.10 законности в
// сутки навсегда, и выхода из петли нет (правило «у каждой петли есть выход»).
// В dynasty.js всё уже есть, применителя нет. Якорь (1 совпадение — ПОСЛЕ того
// как интегратор вставит блок из dynasty.js; до этого якоря в файле нет):
//
// export function dynastyNameHeir(sim, id) {
//
//     ПЕРЕД этой строкой добавить:
//
// export function dynastyClearHeir(sim) {
//   const r = DYN.clearHeir(sim.dynasty);
//   if (r.ok) { sim.dynasty = r.state; for (const e of r.events) sim.addLog(e.text, e.type); }
//   else if (typeof sim.toast === 'function') sim.toast(r.reason);
//   return r;
// }
//
// Пока этой функции нет, кнопка «Отменить назначение» стоит серой и говорит,
// чего не хватает. Панель от отсутствия любого применителя не падает.
//
// ── 4. ЧЕГО ДЕЛАТЬ НЕ НАДО ──────────────────────────────────────────────────
//
// · Не заводить панели своё состояние в sim. Подтверждение необратимых кнопок
//   живёт в WeakMap внутри файла: оно не идёт в сейв и не может сдвинуть rng.
// · Не звать renderDynastyPanel из дневного хода. Она чистая, но зовёт heirOf
//   и can* на каждом кадре — это чтение, и место ему в кадре, а не в сутках.
// · Не подключать панель дважды (шаг 1.4 и шаг 2 одновременно): вреда не будет,
//   onclick просто переназначится, но разбираться потом придётся дольше.
// ═════════════════════════════════════════════════════════════════════════════
