/* ══════════════════════════════════════════════════════════════
   ФАСАДЫ — закрашивание выполненных работ по видам.
   Кистью «мажешь» по фасаду — закрашиваются целиком элементы чертежа АР,
   которых коснулась кисть: панели облицовки, окна (противопожарная отсечка),
   откосы и отливы. На каждый вид работ — свой слой. Геометрия корпуса
   грузится только при открытии и только после входа. Закраска хранится
   на сервере журналом событий, общая для всех устройств.
══════════════════════════════════════════════════════════════ */
'use strict';

const WORK_TYPES = [
  {id:'brackets',    label:'Монтаж кронштейнов', unit:'м²'},
  {id:'insul1',      label:'Утеплитель 1 слой',  unit:'м²'},
  {id:'insul2',      label:'Утеплитель 2 слой',  unit:'м²'},
  {id:'rails',       label:'Монтаж направляющих',unit:'м²'},
  {id:'fc_adj',      label:'Примыкание (4 стороны)', short:'Примыкание', group:'fc', unit:'п.м'},
  {id:'fc_box',      label:'Короб (П-образный)',     short:'Короб',      group:'fc', unit:'п.м'},
  {id:'fc_strip',    label:'Нащельники (2 стороны)', short:'Нащельники', group:'fc', unit:'п.м'},
  {id:'akp',         label:'Монтаж АКП',         unit:'м²'},
  {id:'sfb',         label:'СФБ',                unit:'м²'},
  {id:'keramogranit',label:'Керамогранит',       unit:'м²'},
  {id:'terracotta',  label:'Терракотовая плитка',unit:'м²'},
  {id:'reveals',     label:'Откосы',             unit:'п.м'},
  {id:'flashings',   label:'Отливы',             unit:'п.м'},
];
const GROUPS = { fc:'Противопожарная отсечка' };
const CLADDING = new Set(['akp','sfb','keramogranit','terracotta']); // проектный объём не считали — показываем м² по чертежу
const LINEAR = new Set(['fc_adj','fc_box','fc_strip','reveals','flashings']);   // считаются в п.м по элементам чертежа
let activeWorkType = WORK_TYPES[0].id;

const LS = {
  get(k, d){ try { const v = localStorage.getItem(k); return v===null ? d : v; } catch(e){ return d; } },
  set(k, v){ try { localStorage.setItem(k, v); } catch(e){} },
  del(k){ try { localStorage.removeItem(k); } catch(e){} },
};

/* ── режимы: «только просмотр» — у наблюдателя, на телефоне или по ссылке ?view=1 ── */
const urlParams = new URLSearchParams(location.search);
const FORCE_VIEW = urlParams.get('view') === '1' || urlParams.get('mode') === 'view';
function isMobileViewport(){
  return window.innerWidth <= 820 || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}
const SLUG = (location.pathname.match(/^\/p\/([a-z0-9_-]{1,40})/) || [])[1] || '';
const API = '/api/p/' + SLUG + '/';
let PROJECT = null, ROLE = 'viewer';
function computeReadOnly(){ return FORCE_VIEW || isMobileViewport() || ROLE !== 'editor'; }
let READ_ONLY = true;

/* все запросы — со своим заголовком (сервер так отличает страницы сайта от чужих), сессия — в cookie */
async function apiFetch(path, opts){
  opts = opts || {};
  const init = { method: opts.method || 'GET', credentials:'same-origin', cache:'no-store', headers:{'X-Requested-With':'fasady'} };
  if (opts.body !== undefined){ init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
  const r = await fetch(API + path, init);
  if (r.status === 401){ location.href = '/?next=' + encodeURIComponent(SLUG); throw new Error('Нужно войти'); }
  return r;
}

function applyReadOnlyUI(){
  READ_ONLY = computeReadOnly();
  const paintTools = document.getElementById('paintTools');
  if (paintTools) paintTools.style.display = READ_ONLY ? 'none' : 'flex';
  const hint = document.getElementById('zoomHint');
  if (hint) hint.textContent = READ_ONLY
    ? 'Колесо — зум, перетаскивание — панорама'
    : 'Колесо — зум, пробел или средняя кнопка — панорама, B — кисть, E — ластик, Z — показать всё';
  wrap.classList.toggle('readonly', READ_ONLY);
  const badge = document.getElementById('viewOnlyBadge');
  if (badge) badge.style.display = READ_ONLY ? 'inline-flex' : 'none';
  renderWorkTypeList();
}
window.addEventListener('resize', ()=>{
  const now = computeReadOnly();
  if (now !== READ_ONLY){ applyReadOnlyUI(); draw(); }
});

const canvas = document.getElementById('cv');
const ctx = canvas.getContext('2d');
const wrap = document.getElementById('canvas-wrap');

/* ── корпуса: геометрия грузится по требованию и кешируется в памяти ── */
let CORPUS_LABEL = {};      // из описания объекта
const CORPUS = {};   // id -> {data, geo:{...}, layers, lastId, epoch, ksAreas}
let activeCorpus = null;
let C = null;        // текущий корпус

/* геометрия: панель = четырёхугольник; hidden — артефакт чертежа (спецификации, планы, выноски), не рисуется и не красится */
function buildGeoFlat(flat, facArr, visArr){
  const n = Math.floor((flat||[]).length / 8), arr = new Array(n);
  for (let k=0; k<n; k++){
    const o = k*8, pts = [];
    let bx0=Infinity, by0=Infinity, bx1=-Infinity, by1=-Infinity;
    for (let i=0;i<8;i+=2){
      const x = flat[o+i], y = -flat[o+i+1];
      pts.push([x,y]);
      if (x<bx0) bx0=x; if (x>bx1) bx1=x; if (y<by0) by0=y; if (y>by1) by1=y;
    }
    let a = 0;
    for (let i=0;i<4;i++){ const p=pts[i], q=pts[(i+1)%4]; a += p[0]*q[1]-q[0]*p[1]; }
    const fac = facArr ? facArr[k] : -1;               // ≥0 — фасад журнала, −1 — вид/терраса, −2 — скрыто
    const hidden = facArr ? fac === -2 : (visArr ? !visArr[k] : false);
    arr[k] = { pts, bx0, by0, bx1, by1, area: Math.abs(a)/2, fac, hidden };
  }
  return arr;
}
function buildPath(geo, onlyIdx){
  // строка SVG-пути и один разбор — в разы быстрее тысяч вызовов moveTo/lineTo
  const parts = [];
  const add = g=>{ const t = g.pts; parts.push('M' + t[0][0] + ' ' + t[0][1] + 'L' + t[1][0] + ' ' + t[1][1] + 'L' + t[2][0] + ' ' + t[2][1] + 'L' + t[3][0] + ' ' + t[3][1] + 'Z'); };
  if (onlyIdx){ for (const i of onlyIdx){ const g = geo[i]; if (g && !g.hidden) add(g); } }
  else for (const g of geo) if (!g.hidden) add(g);
  return new Path2D(parts.join(''));
}
/* пространственный индекс для кисти: ячейки 2×2 м */
const CELL = 2000;
function buildIndex(geo){
  const m = new Map();
  geo.forEach((g, idx)=>{
    if (g.hidden) return;
    for (let cx = Math.floor(g.bx0/CELL); cx <= Math.floor(g.bx1/CELL); cx++)
      for (let cy = Math.floor(g.by0/CELL); cy <= Math.floor(g.by1/CELL); cy++){
        const key = cx*100003 + cy; let l = m.get(key); if (!l){ l = []; m.set(key, l); } l.push(idx);
      }
  });
  return m;
}

async function ensureCorpus(id){
  if (CORPUS[id]) return CORPUS[id];
  showLoading('Загружаю ' + CORPUS_LABEL[id] + '…');
  const r = await apiFetch('data/' + id + '.json');
  if (!r.ok) throw new Error('Не удалось загрузить геометрию ' + id);
  const d = await r.json();
  // подложка — чертёж АР (цвета слоёв и штриховки как в проекте)
  let ar = [];
  if (d.ar){
    try {
      const rb = await apiFetch('data/' + id + '.ar.bin');
      if (rb.ok) ar = decodeAR(new Int32Array(await rb.arrayBuffer()), d.ar.groups);
    } catch(e){ console.warn('AR underlay failed', e); }
  }
  const geo = {
    panel: buildGeoFlat(d.panels, d.panelsFac), akp: buildGeoFlat(d.akp, d.akpFac),
    sfb: buildGeoFlat(d.sfb, d.sfbFac), keramogranit: buildGeoFlat(d.keramogranit, d.keramogranitFac),
    brackets: buildGeoFlat(d.brackets, null, d.bracketsVis), rails: buildGeoFlat(d.rails, null, d.railsVis),
    monolith: buildGeoFlat(d.monolith, null, d.monolithVis), insulGrid: buildGeoFlat(d.insulGrid, null, d.insulGridVis),
    windows: buildGeoFlat(d.windows, d.windowsFac), reveals: buildGeoFlat(d.reveals, d.revealsFac),
    flashings: buildGeoFlat(d.flashings, d.flashingsFac),
  };
  // длины, п.м: окно 2×2 → примыкание 8, короб 6, нащельники 4; откос/отлив — длина элемента по проекту
  geo.windows.forEach(g=>{ const w = (g.bx1-g.bx0)/1000, h = (g.by1-g.by0)/1000; g.len = {fc_adj:2*(w+h), fc_box:w+2*h, fc_strip:2*h}; });
  for (const k of ['reveals','flashings']) geo[k].forEach((g, i)=>{ const L = ((d[k+'Len']||[])[i] || 0)/1000; g.len = {[k]:L}; g.mark = (d[k+'Mark']||[])[i] || ''; });
  // контуры сторон окна, которые входят в каждый вид отсечки (для подсветки и закраски)
  const sidesPath = (lst, which)=>{
    const parts = [];
    for (const g of lst){ if (g.hidden) continue;
      const L = g.bx0, R = g.bx1, T = g.by0, B = g.by1;
      if (which === 'fc_adj') parts.push('M'+L+' '+T+'L'+R+' '+T+'L'+R+' '+B+'L'+L+' '+B+'Z');
      else if (which === 'fc_box') parts.push('M'+L+' '+B+'L'+L+' '+T+'L'+R+' '+T+'L'+R+' '+B);
      else parts.push('M'+L+' '+T+'L'+L+' '+B+'M'+R+' '+T+'L'+R+' '+B);
    }
    return new Path2D(parts.join(''));
  };
  // основа фасада для кронштейнов, утеплителя и направляющих: сетка панелей + облицовка (АКП, СФБ, керамогранит)
  // там, где сетки нет. Панели сетки идут первыми с прежними номерами — уже накрашенное не сдвигается.
  const panelIdx = buildIndex(geo.panel);
  const coveredByPanel = g=>{
    const cx = (g.bx0+g.bx1)/2, cy = (g.by0+g.by1)/2, l = panelIdx.get(Math.floor(cx/CELL)*100003 + Math.floor(cy/CELL)) || [];
    return l.some(i=>{ const p = geo.panel[i]; return cx >= p.bx0 && cx <= p.bx1 && cy >= p.by0 && cy <= p.by1; });
  };
  geo.base = geo.panel.slice();
  for (const k of ['akp','sfb','keramogranit']) for (const g of geo[k]) if (!g.hidden && !coveredByPanel(g)) geo.base.push(g);
  // статичные слои — один Path2D на слой (рисуется одним вызовом вместо тысяч)
  const paths = {}; for (const k in geo) paths[k] = buildPath(geo[k]);
  const index = {}; for (const k of ['panel','base','akp','sfb','keramogranit','windows','reveals','flashings']) index[k] = k === 'panel' ? panelIdx : buildIndex(geo[k]);
  const sides = {}; for (const t of ['fc_adj','fc_box','fc_strip']) sides[t] = sidesPath(geo.windows, t);
  const ws = geo.panel.filter(g=>!g.hidden).map(g=>g.bx1-g.bx0).sort((a,b)=>a-b);
  const tileMm = ws.length ? ws[Math.floor(ws.length/2)] : 1000;
  const layers = {}, ver = {}; WORK_TYPES.forEach(w=>{ layers[w.id] = new Set(); ver[w.id] = 0; });
  let fullBox;
  const vis = geo.panel.filter(g=>!g.hidden).concat(geo.akp.filter(g=>!g.hidden));
  if (vis.length){
    let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
    vis.forEach(g=>{ if (g.bx0<minX) minX=g.bx0; if (g.bx1>maxX) maxX=g.bx1; if (g.by0<minY) minY=g.by0; if (g.by1>maxY) maxY=g.by1; });
    const pad = Math.max(maxX-minX, maxY-minY) * 0.03;
    fullBox = { x:minX-pad, y:minY-pad, w:(maxX-minX)+pad*2, h:(maxY-minY)+pad*2+3000 };
  } else fullBox = { x:-1000, y:-1000, w:2000, h:2000 };
  CORPUS[id] = { id, data:d, ar, geo, paths, index, sides, sidesPath, tileMm, layers, ver, fillCache:{}, lastId:0, epoch:null, ksAreas:[], fullBox };
  return CORPUS[id];
}
function decodeAR(buf, groups){
  // на группу: n длин полилиний, затем 2m координат приращениями (Y уже вниз)
  const out = []; let o = 0;
  for (const g of groups){
    const lens = buf.subarray(o, o + g.n); o += g.n;
    const parts = new Array(g.n); let p = o;
    for (let i = 0; i < g.n; i++){
      const L = lens[i]; let x = 0, y = 0, str = '';
      for (let j = 0; j < L; j++){ x += buf[p++]; y += buf[p++]; str += (j ? 'L' : 'M') + x + ' ' + y; }
      if (g.k === 'f') str += 'Z';
      parts[i] = str;
    }
    o = p;
    out.push({ kind: g.k, layer: g.layer, color: g.c, pat: g.p, ang: g.a || 0, path: new Path2D(parts.join('')) });
  }
  return out;
}
function touchLayer(corp, id, addedIdx){
  // addedIdx — только добавленные панели (кисть): тогда кадр дорисовывается, а не перерисовывается целиком
  corp.ver[id] = (corp.ver[id]||0) + 1;
  const d = corp.delta || (corp.delta = {});
  const e = d[id] || (d[id] = {add:[], all:false});
  if (addedIdx) e.add.push(...addedIdx); else e.all = true;
}

function geoKey(id){
  if (id==='akp'||id==='sfb'||id==='keramogranit'||id==='reveals'||id==='flashings') return id;
  if (id==='fc_adj'||id==='fc_box'||id==='fc_strip') return 'windows';
  if (id==='brackets'||id==='insul1'||id==='insul2'||id==='rails') return 'base';   // подсистема — везде, где есть облицовка
  return 'panel';                       // терракота — по сетке панелей
}
function geoForType(id){ return C.geo[geoKey(id)]; }
/* «вес» элемента в объёме: м² для панелей, п.м для окон, откосов и отливов */
function measure(g, id){ return LINEAR.has(id) ? ((g.len && g.len[id]) || 0) : g.area; }

/* ── камера ── */
let viewCenterX=0, viewCenterY=0, viewWidth=1000;
let view = {x:0,y:0,w:0,h:0};
function paletteInsets(){
  // на широком экране чертёж вписывается между палитрами, а не под них
  if (window.innerWidth <= 820) return {l:0, r:0};
  const w = id=>{ const el = document.getElementById(id); return (el && !el.classList.contains('collapsed')) ? el.getBoundingClientRect().width + 20 : 0; };
  return {l:w('layerPal'), r:w('volCard')};
}
function fitToBox(box){
  box = box || C.fullBox;
  const rect = wrap.getBoundingClientRect();
  const ins = paletteInsets();
  const inner = Math.max(200, rect.width - ins.l - ins.r);
  viewWidth = Math.max(box.w * rect.width / inner, box.h * rect.width / rect.height);
  const mmPerPx = viewWidth / rect.width;
  viewCenterX = box.x + box.w/2 - (ins.l - ins.r)/2 * mmPerPx;
  viewCenterY = box.y + box.h/2;
}
function syncView(){
  const rect = wrap.getBoundingClientRect();
  view.w = viewWidth; view.h = viewWidth * (rect.height / rect.width);
  view.x = viewCenterX - view.w/2; view.y = viewCenterY - view.h/2;
}

/* ══ синхронизация со своим сервером ══ */
let syncBusy = false;
function updateSyncStatus(text, ok){
  const dot = document.getElementById('syncDot'), label = document.getElementById('syncStatusText');
  if (!dot || !label) return;
  label.textContent = text;
  dot.style.background = ok===false ? '#C0392B' : ok===true ? '#188A55' : '#B9B9B4';
}

function applyEvents(corp, events){
  events.forEach(ev=>{
    const set = corp.layers[ev.workType]; if (!set) return;
    touchLayer(corp, ev.workType);
    if (ev.action === 'clear') set.clear();
    (ev.add || []).forEach(i=>set.add(i));
    (ev.remove || []).forEach(i=>set.delete(i));
  });
}
async function pullEvents(){
  if (!C || syncBusy) return;
  const corp = C; syncBusy = true;
  try {
    const r = await apiFetch('events?corpus=' + corp.id + '&after=' + corp.lastId);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    if (corp.epoch !== null && d.epoch !== corp.epoch){
      // журнал на сервере перестроен (например, импорт из Google) — перечитываем корпус целиком
      corp.lastId = 0; corp.epoch = d.epoch;
      WORK_TYPES.forEach(w=>{ corp.layers[w.id] = new Set(); touchLayer(corp, w.id); });
      syncBusy = false; return pullEvents();
    }
    corp.epoch = d.epoch;
    if (d.events && d.events.length){
      applyEvents(corp, d.events); corp.lastId = d.last;
      if (corp === C && !isDrawing){ renderWorkTypeList(); renderVolumes(); draw(); }
      if (d.more){ syncBusy = false; return pullEvents(); }
    }
    updateSyncStatus(outbox.length ? 'Сохраняю… (' + outbox.length + ')' : 'Синхронизировано', true);
  } catch(e){
    console.warn('pull failed', e); updateSyncStatus('Нет связи с сервером', false);
  } finally { syncBusy = false; }
}

/* очередь отправки: если сервер недоступен, мазки не теряются и уйдут позже */
let outbox = [];
const OUTBOX_KEY = 'ft_outbox_' + SLUG;
try { outbox = JSON.parse(LS.get(OUTBOX_KEY, '[]')).filter(e=>e && e.project === SLUG); } catch(e){ outbox = []; }
function saveOutbox(){ LS.set(OUTBOX_KEY, JSON.stringify(outbox)); }
function pushEvent(workType, action, addArr, remArr){
  outbox.push({ project: SLUG, corpus: C.id, workType, action,
    add: addArr ? Array.from(addArr) : [], remove: remArr ? Array.from(remArr) : [] });
  saveOutbox(); flushOutbox();
}
let flushing = false;
async function flushOutbox(){
  if (flushing || !outbox.length) return;
  flushing = true;
  try {
    while (outbox.length){
      const ev = outbox[0];
      const r = await apiFetch('events', { method:'POST', body: ev });
      if (r.status === 403){ ROLE = 'viewer'; applyReadOnlyUI(); updateSyncStatus('Нет прав на редактирование', false); outbox = []; saveOutbox(); break; }
      if (r.status === 400){ outbox.shift(); saveOutbox(); continue; }     // устаревшее событие (вид работ больше не существует)
      if (!r.ok) throw new Error('HTTP ' + r.status);
      outbox.shift(); saveOutbox();
    }
    if (!outbox.length) updateSyncStatus('Синхронизировано', true);
  } catch(e){
    console.warn('push failed', e); updateSyncStatus('Нет связи — ' + outbox.length + ' изм. ждут отправки', false);
  } finally { flushing = false; }
}

/* ── участки КС (карточка скрыта, как в исходной версии; данные хранятся на сервере) ── */
let activeKsId = null, ksMode = false, ksDragStart = null, ksDragCurrent = null;
async function loadKsAreas(){
  try {
    const r = await apiFetch('ks?corpus=' + C.id);
    C.ksAreas = (await r.json()).areas || [];
  } catch(e){ C.ksAreas = []; }
  activeKsId = C.ksAreas.length ? C.ksAreas[0].id : null;
  renderKsPanel(); draw();
}
window.toggleKsMode = function(forceState){
  ksMode = (forceState !== undefined) ? forceState : !ksMode;
  const btn = document.getElementById('ksNewBtn');
  btn.classList.toggle('active', ksMode);
  btn.textContent = ksMode ? 'Тяните прямоугольник…' : '+ Выделить участок';
  draw();
};
function computeKsStats(area){
  return WORK_TYPES.map(w=>{
    const geo = geoForType(w.id), filled = C.layers[w.id];
    let total=0, done=0;
    geo.forEach((g, idx)=>{
      if (g.hidden) return;
      const cx=(g.bx0+g.bx1)/2, cy=(g.by0+g.by1)/2;
      if (cx>=area.x0 && cx<=area.x1 && cy>=area.y0 && cy<=area.y1){ total++; if (filled.has(idx)) done++; }
    });
    return {label:w.label, total, done};
  });
}
function renderKsPanel(){
  const list = document.getElementById('ksList'); if (!list || !C) return;
  list.innerHTML = C.ksAreas.map(a=>`
    <div class="ks-item ${activeKsId===a.id?'active':''}" data-ks="${escapeHtml(a.id)}">
      <div style="flex:1">${escapeHtml(a.name)}</div>
      <span class="del" data-ks-del="${escapeHtml(a.id)}">✕</span>
    </div>`).join('');
  const statsEl = document.getElementById('ksStats');
  const area = C.ksAreas.find(a=>a.id===activeKsId);
  if (!area){ statsEl.innerHTML = ''; return; }
  statsEl.innerHTML = '<div class="ks-stats-table">' + computeKsStats(area).map(s=>{
    const pct = s.total ? Math.round(s.done/s.total*100) : 0;
    return `<div class="ks-stats-row"><span class="name">${escapeHtml(s.label)}</span><span class="val">${s.done}/${s.total} (${pct}%)</span></div>`;
  }).join('') + '</div>';
}
window.selectKsArea = function(id){ activeKsId = id; renderKsPanel(); draw(); };
window.deleteKsArea = async function(id){
  if (!confirm('Удалить этот участок КС?')) return;
  await apiFetch('ks/' + encodeURIComponent(id), {method:'DELETE'});
  loadKsAreas();
};
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

/* ── переключение корпуса ── */
function showLoading(t){ document.getElementById('loadingText').textContent = t; document.getElementById('loadingVeil').classList.add('show'); }
function hideLoading(){ document.getElementById('loadingVeil').classList.remove('show'); }
function updateCorpusTabsUI(){
  document.querySelectorAll('.corpus-tab').forEach(el=>el.classList.toggle('active', el.dataset.corpus === activeCorpus));
  const empty = document.getElementById('emptyCorpusMsg');
  if (empty) empty.hidden = !!(C && C.geo.panel.length) || !C;
}
window.switchCorpus = async function(id, force){
  if ((!force && id === activeCorpus && C) || !CORPUS_LABEL[id]) return;
  activeCorpus = id; LS.set('ft_active_corpus_' + SLUG, id);
  updateCorpusTabsUI();
  try { C = await ensureCorpus(id); }
  catch(e){ hideLoading(); updateSyncStatus(e.message, false); return; }
  if (activeCorpus !== id) return;
  hoverFacade = -1;
  fitToBox();
  if (!visibleWorkTypes().some(w=>w.id === activeWorkType)) activeWorkType = visibleWorkTypes()[0].id;
  renderWorkTypeList(); updateCorpusTabsUI(); resizeCanvas();
  hideLoading();
  await pullEvents();
  renderVolumes(); draw();
  loadKsAreas();
};

let tool = 'brush';
let brushRadius = 400;

function resizeCanvas(){
  const rect = wrap.getBoundingClientRect();
  canvas.width = rect.width * devicePixelRatio; canvas.height = rect.height * devicePixelRatio;
  canvas.style.width = rect.width+'px'; canvas.style.height = rect.height+'px';
  syncView(); draw();
}
window.addEventListener('resize', resizeCanvas);

function worldToScreen(x,y){
  const rect = wrap.getBoundingClientRect();
  return [ (x-view.x)/view.w*rect.width, (y-view.y)/view.h*rect.height ];
}
function screenToWorld(sx,sy){
  const rect = wrap.getBoundingClientRect();
  return [ view.x + sx/rect.width*view.w, view.y + sy/rect.height*view.h ];
}
const CAD_FONT = 'ISOCPEUR, "GOST type A", "GOST 2.304", "Arial Narrow", Arial, sans-serif';
const RED = '#FF2A2A';            // выполнено — насыщенный красный, как «предъявляемый участок» на исполнительных схемах

/* штриховки ANSI31 (45°) с постоянным шагом на экране */
const hatchCache = {};
function hatchPattern(g, color, stepPx, lw, kind){
  const dpr = devicePixelRatio || 1; kind = kind || 'diag';
  const key = color + stepPx + lw + dpr + kind;
  if (!hatchCache[key]){
    const n = Math.max(2, Math.round(stepPx*dpr)), c = document.createElement('canvas');
    c.width = c.height = n; const x = c.getContext('2d');
    x.strokeStyle = color; x.fillStyle = color; x.lineWidth = lw*dpr; x.beginPath();
    if (kind === 'dots'){ x.fillRect(n/2-dpr*.6, n/2-dpr*.6, dpr*1.2, dpr*1.2); }
    else {
      for (const k of [-1,0,1]){ x.moveTo(k*n, n); x.lineTo(k*n+n, 0); }
      if (kind === 'cross') for (const k of [-1,0,1]){ x.moveTo(k*n, 0); x.lineTo(k*n+n, n); }
      if (kind === 'diag2') for (const k of [-1,0,1]){ x.moveTo(k*n, 0); x.lineTo(k*n+n, n); }
      x.stroke();
    }
    hatchCache[key] = c;
  }
  return g.createPattern(hatchCache[key], 'repeat');
}
function drawGridTo(ctx, rect){
  // сетка модели: шаг 1·10ⁿ мм, чтобы между линиями было не меньше ~14 px; каждая пятая — ярче
  const pxPerMm = rect.width / view.w;
  let step = 1000; while (step * pxPerMm < 14) step *= 10; while (step * pxPerMm > 140) step /= 10;
  ctx.lineWidth = 1;
  for (const major of [false, true]){
    const st = major ? step*5 : step;
    ctx.strokeStyle = major ? 'rgba(255,255,255,.06)' : 'rgba(255,255,255,.025)';
    ctx.beginPath();
    for (let x = Math.ceil(view.x/st)*st; x <= view.x+view.w; x += st){ const sx = Math.round((x-view.x)*pxPerMm)+.5; ctx.moveTo(sx,0); ctx.lineTo(sx,rect.height); }
    for (let y = Math.ceil(view.y/st)*st; y <= view.y+view.h; y += st){ const sy = Math.round((y-view.y)*pxPerMm)+.5; ctx.moveTo(0,sy); ctx.lineTo(rect.width,sy); }
    ctx.stroke();
  }
}
function updateCoords(){
  const el = document.getElementById('coordReadout'); if (!el) return;
  if (!hoverScreen || !C){ el.textContent = ''; return; }
  const [wx, wy] = screenToWorld(hoverScreen[0], hoverScreen[1]);
  const f = v=>Math.round(v).toLocaleString('ru-RU');
  el.textContent = 'X ' + f(wx) + '   Y ' + f(-wy) + '   мм';
}
function filledPath(id){
  // путь закрашенных элементов кешируется и пересобирается только когда слой изменился
  const key = geoKey(id), c = C.fillCache[id];
  if (c && c.ver === C.ver[id]) return c;
  const path = buildPath(C.geo[key], C.layers[id]);
  const sides = key === 'windows' ? C.sidesPath(Array.from(C.layers[id], i=>C.geo.windows[i]).filter(Boolean), id) : null;
  C.fillCache[id] = { ver: C.ver[id], path, sides };
  return C.fillCache[id];
}
let drawQueued = false, lastFrameMs = 0;
function draw(){
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(()=>{ drawQueued = false; const t0 = performance.now(); drawNow(); updateCoords(); lastFrameMs = performance.now() - t0; });
}
/* какой слой чертежа показываем на вкладке вида работ — как основной вид на исполнительной схеме */
function workLayerFor(id){
  if (id === 'brackets') return 'brackets';
  if (id === 'rails') return 'rails';
  if ((id === 'insul1' || id === 'insul2') && C.geo.insulGrid.some(g=>!g.hidden)) return 'insulGrid';
  if (id === 'akp' || id === 'sfb' || id === 'keramogranit' || id === 'reveals' || id === 'flashings') return id;
  if (id === 'fc_adj' || id === 'fc_box' || id === 'fc_strip') return id;
  return null;
}
/* ── кэш отрисовки: статичные слои и закраска рисуются в отдельные холсты и перерисовываются только при
   изменении вида, вкладки или закраски; при панораме/зуме кадр собирается сдвигом готовой картинки ── */
const cache = { base:{cv:document.createElement('canvas'), key:'', view:null}, full:{cv:document.createElement('canvas'), key:'', view:null, fillVer:-1} };
let interactUntil = 0, regenTimer = null;
function noteInteract(){
  interactUntil = performance.now() + 140;
  clearTimeout(regenTimer); regenTimer = setTimeout(()=>draw(), 170);
}
function sameView(v){ return v && v.x===view.x && v.y===view.y && v.w===view.w && v.h===view.h; }
function sizeCache(c, W, H){ if (c.cv.width !== W || c.cv.height !== H){ c.cv.width = W; c.cv.height = H; c.view = null; } }
/* подсветка слоя вида работ: свой цвет, остальное приглушено */
const HL = {
  akp:{fill:'rgba(0,229,255,.30)', line:'#00E5FF', label:'Кассеты АКП'},
  sfb:{fill:'rgba(255,176,0,.30)', line:'#FFB000', label:'Панели СФБ'},
  keramogranit:{fill:'rgba(124,252,0,.26)', line:'#7CFC00', label:'Плиты керамогранита'},
  brackets:{line:'#4DA3FF', label:'Кронштейны'},
  rails:{line:'#FF5CFF', label:'Направляющие'},
  insulGrid:{line:'#FFD60A', label:'Плиты утеплителя'},
  reveals:{fill:'rgba(0,229,255,.55)', line:'#00E5FF', label:'Откосы (марки О-…)'},
  flashings:{fill:'rgba(255,92,255,.6)', line:'#FF5CFF', label:'Отливы (марки ОТ-…)'},
  fc_adj:{line:'#FFB000', sides:true, label:'Окна: примыкание по 4 сторонам'},
  fc_box:{line:'#FFB000', sides:true, label:'Окна: короб — верх и боковины'},
  fc_strip:{line:'#FFB000', sides:true, label:'Окна: нащельники — боковины'},
  grid:{line:'rgba(255,214,10,.65)', label:'Сетка панелей фасада'},
};
function hlFor(id){
  const w = workLayerFor(id);
  if (w) return {key:w, ...HL[w]};
  if (id === 'terracotta') return {key:'panel', ...HL.grid};
  if (id === 'insul1' || id === 'insul2') return {key:'base', ...HL.grid};
  return null;
}
function patKind(p){
  if (!p) return 'diag';
  if (/DOTS|SAND|CONC/.test(p)) return 'dots';
  if (/ANSI37|CROSS|ANGLE|NET|GRID|SQUARE|BRSTONE|BRICK|HONEY/.test(p)) return 'cross';
  return 'diag';
}
function drawStatic(g, s, dpr){
  const px = v=>v/s, hl = hlFor(activeWorkType);
  g.setTransform(dpr*s, 0, 0, dpr*s, -view.x*s*dpr, -view.y*s*dpr);
  // 1. чертёж АР: заливки и штриховки, затем линии — цвета как в проекте
  g.globalAlpha = hl ? .42 : 1;
  for (const a of C.ar){
    if (a.kind !== 'f') continue;
    if (a.pat === 'SOLID'){ g.fillStyle = a.color; g.fill(a.path); }
    else { const hp = hatchPattern(g, a.color, 6, .9, patKind(a.pat)); hp.setTransform(new DOMMatrix().scale(1/(s*dpr))); g.fillStyle = hp; g.fill(a.path); }
  }
  g.lineWidth = px(1);
  for (const a of C.ar){ if (a.kind === 'l'){ g.strokeStyle = a.color; g.stroke(a.path); } }
  g.globalAlpha = 1;
  if (!C.ar.length){ g.strokeStyle = 'rgba(176,184,196,.3)'; g.stroke(C.paths.panel); g.strokeStyle = 'rgba(255,255,255,.85)'; g.stroke(C.paths.monolith); }
  // 2. слой текущего вида работ — ярко
  if (hl){
    // издалека тонкие элементы (кронштейны, направляющие) сливаются — делаем их полупрозрачными
    const detail = Math.max(.35, Math.min(1, C.tileMm * s / 10));
    if (hl.sides){
      // окна: тонкий контур проёма и яркие стороны, которые входят в этот вид отсечки
      g.lineWidth = px(1); g.strokeStyle = 'rgba(255,176,0,.35)'; g.stroke(C.paths.windows);
      g.lineWidth = px(2.2); g.strokeStyle = hl.line; g.stroke(C.sides[hl.key]);
    } else {
      const path = hl.key === 'panel' ? C.paths.panel : C.paths[hl.key];
      if (hl.fill){ g.fillStyle = hl.fill; g.fill(path); }
      g.globalAlpha = hl.fill ? 1 : .85 * detail;
      g.lineWidth = px(hl.fill ? 1.6 : 1.1); g.strokeStyle = hl.line; g.stroke(path);
      g.globalAlpha = 1;
    }
  }
}
function drawPainted(g, s, dpr, subset){
  const key = geoKey(activeWorkType);
  let fp, sides;
  if (subset){
    fp = buildPath(C.geo[key], subset);
    if (key === 'windows') sides = C.sidesPath(subset.map(i=>C.geo.windows[i]).filter(Boolean), activeWorkType);
  } else { const c = filledPath(activeWorkType); fp = c.path; sides = c.sides; }
  g.setTransform(dpr*s, 0, 0, dpr*s, -view.x*s*dpr, -view.y*s*dpr);
  if (key === 'windows'){
    // окно с выполненной отсечкой: лёгкая красная заливка проёма и толстые красные стороны этого вида работ
    g.fillStyle = 'rgba(255,42,42,.28)'; g.fill(fp);
    g.lineWidth = Math.max(3/s, 60); g.strokeStyle = RED; g.lineCap = 'square'; g.stroke(sides);
    return;
  }
  if (key === 'reveals' || key === 'flashings'){
    g.fillStyle = RED; g.fill(fp);
    g.lineWidth = 2.5/s; g.strokeStyle = RED; g.stroke(fp);       // тонкие элементы — с обводкой, чтобы были видны издалека
    return;
  }
  if (C.tileMm * s < 4){
    // издалека штриховка сливается — показываем выполненное сплошной заливкой
    g.fillStyle = 'rgba(255,42,42,.85)'; g.fill(fp);
  } else {
    const hp = hatchPattern(g, '#FFD0D0', 7, 1.1); hp.setTransform(new DOMMatrix().scale(1/(s*dpr)));
    g.fillStyle = 'rgba(255,42,42,.66)'; g.fill(fp);           // насыщенная красная заливка
    g.fillStyle = hp; g.globalAlpha = .55; g.fill(fp); g.globalAlpha = 1;   // и светлая штриховка ANSI31 поверх
  }
  if (C.tileMm * s > 5){ g.lineWidth = 1.6/s; g.strokeStyle = '#FF5A5A'; g.stroke(fp); }   // контуры — когда панели крупные
}
function drawNow(){
  syncView();
  const rect = wrap.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  const W = Math.round(rect.width*dpr), H = Math.round(rect.height*dpr);
  ctx.setTransform(1,0,0,1,0,0);
  ctx.fillStyle = '#212830'; ctx.fillRect(0,0,W,H);
  if (!C) return;
  const s = rect.width / view.w;
  const key = C.id + '|' + activeWorkType + '|' + W + 'x' + H;
  const full = cache.full, base = cache.base;
  sizeCache(full, W, H); sizeCache(base, W, H);
  if (performance.now() < interactUntil && full.key === key && full.view){
    // идёт панорама/зум: сдвигаем и масштабируем готовый кадр, полная перерисовка — когда движение закончится
    const v = full.view, k = s*dpr;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(full.cv, (v.x-view.x)*k, (v.y-view.y)*k, v.w*k, v.h*k);
  } else {
    if (!(base.key === key && sameView(base.view))){
      const g = base.cv.getContext('2d'); g.setTransform(1,0,0,1,0,0); g.clearRect(0,0,W,H);
      g.setTransform(dpr,0,0,dpr,0,0); drawGridTo(g, rect);
      drawStatic(g, s, dpr); base.key = key; base.view = {...view};
    }
    const dl = (C.delta || {})[activeWorkType];
    const fresh = full.key === key && sameView(full.view);
    if (fresh && full.fillVer !== C.ver[activeWorkType] && dl && !dl.all && dl.add.length){
      drawPainted(full.cv.getContext('2d'), s, dpr, dl.add);          // дорисовать только новые панели мазка
      full.fillVer = C.ver[activeWorkType]; dl.add = [];
    } else if (!(fresh && full.fillVer === C.ver[activeWorkType])){
      const g = full.cv.getContext('2d'); g.setTransform(1,0,0,1,0,0); g.clearRect(0,0,W,H);
      g.drawImage(base.cv, 0, 0); drawPainted(g, s, dpr);
      full.key = key; full.view = {...view}; full.fillVer = C.ver[activeWorkType];
      if (dl){ dl.add = []; dl.all = false; }
    }
    ctx.drawImage(full.cv, 0, 0);
  }
  ctx.setTransform(dpr,0,0,dpr,0,0);

  // подсветка фасада, на который навели в панели «Объёмы по осям»
  if (hoverFacade >= 0){
    ctx.save(); ctx.setLineDash([10,5]); ctx.strokeStyle = 'rgba(26,130,214,1)'; ctx.lineWidth = 2;
    ctx.fillStyle = 'rgba(26,130,214,.12)';
    facadeBoxes(hoverFacade).forEach(b=>{
      const [sx0,sy0] = worldToScreen(b.x, b.y), [sx1,sy1] = worldToScreen(b.x+b.w, b.y+b.h);
      ctx.fillRect(sx0,sy0,sx1-sx0,sy1-sy0); ctx.strokeRect(sx0,sy0,sx1-sx0,sy1-sy0);
    });
    ctx.restore();
  }

  // оси и отметки — размер в мм чертежа
  const markPxScale = s, MIN_MARK_PX = 1.6;
  const AXIS_R_MM = 440, AXIS_STUB_MM = 1000, AXIS_FONT_MM = 380;
  C.data.axes.forEach(ax=>{
    const [sx, sy] = worldToScreen(ax.x, -ax.y);
    const r = AXIS_R_MM * markPxScale;
    if (r < MIN_MARK_PX || sx < -50 || sx > rect.width+50 || sy < -50 || sy > rect.height+50) return;
    const stubPx = AXIS_STUB_MM * markPxScale;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,82,82,.75)'; ctx.lineWidth = 1;   // осевая — штрихпунктирная
    ctx.setLineDash([Math.max(4,stubPx*.3), Math.max(2,stubPx*.08), Math.max(1,stubPx*.03), Math.max(2,stubPx*.08)]);
    ctx.beginPath(); ctx.moveTo(sx, sy-stubPx); ctx.lineTo(sx, sy); ctx.stroke(); ctx.restore();
    const cy = sy + r + stubPx*.15;
    ctx.beginPath(); ctx.arc(sx, cy, r, 0, Math.PI*2);
    ctx.fillStyle = '#212830'; ctx.fill(); ctx.strokeStyle = '#E8EAED'; ctx.lineWidth = 1.1; ctx.stroke();
    if (r > 5){
      const fontPx = Math.min(AXIS_FONT_MM * markPxScale, r*1.15);
      ctx.fillStyle = '#E8EAED'; ctx.font = 'italic ' + fontPx.toFixed(1) + 'px ' + CAD_FONT;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(ax.label, sx, cy+1);
    }
  });
  const ELEV_STUB_MM = 700, ELEV_FONT_MM = 220, ELEV_BOXH_MM = 320;
  C.data.elevations.forEach(el=>{
    const [sx, sy] = worldToScreen(el.x, -el.y);
    const boxH = ELEV_BOXH_MM * markPxScale;
    if (boxH < MIN_MARK_PX || sx < -200 || sx > rect.width+50 || sy < -50 || sy > rect.height+50) return;
    const stubPx = ELEV_STUB_MM * markPxScale;
    ctx.save(); ctx.setLineDash([Math.max(2,stubPx*.2), Math.max(2,stubPx*.16)]);
    ctx.strokeStyle = 'rgba(110,230,120,.55)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(sx-stubPx, sy); ctx.lineTo(sx, sy); ctx.stroke(); ctx.restore();
    if (boxH > 5){
      const fontPx = Math.min(ELEV_FONT_MM * markPxScale, boxH*.62);
      ctx.font = 'italic ' + fontPx.toFixed(1) + 'px ' + CAD_FONT;
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      const label = (el.label.charAt(0)==='-' ? '' : '+') + el.label;
      const tw = ctx.measureText(label).width, padX = boxH*.35, boxW = tw+padX*2;
      ctx.fillStyle = 'rgba(33,40,48,.9)'; ctx.fillRect(sx, sy-boxH/2, boxW, boxH);
      ctx.fillStyle = '#7EE787'; ctx.fillText(label, sx+padX, sy);
    }
  });

  if (hoverScreen && !isPanning){
    const [hx, hy] = hoverScreen, pb = 5;
    ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, hy+.5); ctx.lineTo(hx-pb, hy+.5); ctx.moveTo(hx+pb, hy+.5); ctx.lineTo(rect.width, hy+.5);
    ctx.moveTo(hx+.5, 0); ctx.lineTo(hx+.5, hy-pb); ctx.moveTo(hx+.5, hy+pb); ctx.lineTo(hx+.5, rect.height);
    ctx.stroke();
    ctx.strokeRect(hx-pb+.5, hy-pb+.5, pb*2, pb*2);
    if (!ksMode && !READ_ONLY){
      ctx.beginPath(); ctx.arc(hx, hy, brushRadius*s, 0, Math.PI*2);
      ctx.strokeStyle = tool==='eraser' ? 'rgba(255,110,110,.9)' : 'rgba(255,255,255,.55)'; ctx.setLineDash([4,3]); ctx.stroke();
    }
    ctx.restore();
  }
  C.ksAreas.forEach(a=>{
    const [sx0,sy0] = worldToScreen(a.x0, a.y0), [sx1,sy1] = worldToScreen(a.x1, a.y1);
    const isActive = a.id === activeKsId;
    ctx.save(); ctx.setLineDash([10,6]);
    ctx.strokeStyle = isActive ? 'rgba(217,127,17,.9)' : 'rgba(217,127,17,.4)'; ctx.lineWidth = isActive ? 2 : 1.2;
    ctx.strokeRect(sx0, sy0, sx1-sx0, sy1-sy0); ctx.restore();
  });
  if (ksMode && ksDragStart && ksDragCurrent){
    const [sx0,sy0] = worldToScreen(ksDragStart[0], ksDragStart[1]), [sx1,sy1] = worldToScreen(ksDragCurrent[0], ksDragCurrent[1]);
    ctx.save(); ctx.setLineDash([6,4]); ctx.strokeStyle = 'rgba(217,127,17,.9)'; ctx.fillStyle = 'rgba(217,127,17,.12)';
    ctx.lineWidth = 1.5; ctx.fillRect(sx0, sy0, sx1-sx0, sy1-sy0); ctx.strokeRect(sx0, sy0, sx1-sx0, sy1-sy0); ctx.restore();
  }
}

/* ══ Объёмы по осям: проект (расчёт по исполнительным схемам) × доля закрашенного ══ */
let hoverFacade = -1;
let volCollapsed = LS.get('ft_vol_collapsed', isMobileViewport() ? '1' : '0') === '1';
window.toggleVolCard = function(){
  volCollapsed = !volCollapsed; LS.set('ft_vol_collapsed', volCollapsed ? '1' : '0'); renderVolumes();
};
function facadeBoxes(fi){
  // фактические границы панелей фасада (а не рамки отбора) — для подсветки и зума
  const geo = geoForType(activeWorkType).length ? geoForType(activeWorkType) : C.geo.panel;
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  geo.forEach(g=>{ if (g.fac===fi){ if(g.bx0<x0)x0=g.bx0; if(g.by0<y0)y0=g.by0; if(g.bx1>x1)x1=g.bx1; if(g.by1>y1)y1=g.by1; } });
  if (x0===Infinity) return [];
  return [{x:x0, y:y0, w:x1-x0, h:y1-y0}];
}
function facadeStats(id){
  id = id || activeWorkType;
  const geo = geoForType(id), filled = C.layers[id];
  const F = C.data.facades || [];
  const st = F.map(()=>({tot:0, done:0})), views = {tot:0, done:0};
  geo.forEach((g, idx)=>{
    if (g.hidden) return;
    const s = g.fac >= 0 ? st[g.fac] : views, m = measure(g, id);
    s.tot += m; if (filled.has(idx)) s.done += m;
  });
  return {st, views};
}
const fmt = (v, d=1)=> v.toLocaleString('ru-RU', {minimumFractionDigits:d, maximumFractionDigits:d});
function renderVolumes(){
  const card = document.getElementById('volCard'); if (!card) return;
  card.classList.toggle('collapsed', volCollapsed);
  const w = WORK_TYPES.find(x=>x.id===activeWorkType);
  document.getElementById('volWt').textContent = (C ? CORPUS_LABEL[C.id] + ' · ' : '') + w.label;
  if (!C || volCollapsed){ return; }
  const F = C.data.facades || [];
  const {st, views} = facadeStats();
  const clad = CLADDING.has(activeWorkType), lin = LINEAR.has(activeWorkType);
  let html = '<table class="vol-table"><tr><th>Оси</th><th>' + (clad ? 'По чертежу' : 'Проект') +
             '</th><th>%</th><th>' + (clad || lin ? 'Выполнено' : '≈ Выполнено') + '</th></tr>';
  let sumP = 0, sumD = 0, sumTot = 0, sumDone = 0;
  F.forEach((f, i)=>{
    const s = st[i]; if (!s.tot && !(f.design||{})[activeWorkType]) return;
    const pct = s.tot ? s.done / s.tot : 0;
    let proj, done;
    if (clad){ proj = s.tot/1e6; done = s.done/1e6; }
    else if (lin){ proj = s.tot; done = s.done; }
    else { proj = (f.design||{})[activeWorkType] || 0; done = proj * pct; }
    sumP += proj; sumD += done; sumTot += s.tot; sumDone += s.done;
    html += `<tr class="row" data-fac="${i}">
      <td>${escapeHtml(f.name)}<div class="vol-bar"><i style="width:${(pct*100).toFixed(1)}%;background:${RED}"></i></div></td>
      <td>${proj ? fmt(proj) : '—'}</td><td class="pct">${Math.round(pct*100)}%</td><td>${proj ? fmt(done) : '—'}</td></tr>`;
  });
  const pctAll = sumP ? sumD / sumP : (sumTot ? sumDone / sumTot : 0);
  html += `<tr class="total"><td>Итого по осям</td><td>${fmt(sumP)}</td><td>${Math.round(pctAll*100)}%</td><td>${fmt(sumD)}</td></tr></table>`;
  let note = '';
  if (views.tot){
    const vv = clad ? ' (' + fmt(views.done/1e6) + ' из ' + fmt(views.tot/1e6) + ' м²)' : lin ? ' (' + fmt(views.done) + ' из ' + fmt(views.tot) + ' п.м)' : '';
    note += `<div class="vol-note">Виды, террасы и кровля вне основных фасадов: выполнено <b>${Math.round(views.done/views.tot*100)}%</b>${vv} — в таблицу не входит.</div>`;
  }
  const ext = lin ? null : (C.data.designOther || {})[activeWorkType];
  if (ext && ext.length){
    note += '<div class="vol-note">Вне осей по проекту: ' + ext.map(e=>`${escapeHtml(e.name)} <b>${fmt(e.value)} ${w.unit}</b>`).join('; ') + '.</div>';
  }
  if (w.group === 'fc'){
    // итог по всей противопожарной отсечке: примыкание + короб + нащельники
    let tp = 0, td = 0;
    WORK_TYPES.filter(x=>x.group === 'fc').forEach(x=>{ const r = facadeStats(x.id); r.st.forEach(a=>{ tp += a.tot; td += a.done; }); });
    note += `<div class="vol-note">Итого противопожарная отсечка по осям: <b>${fmt(td)} из ${fmt(tp)} п.м</b> (${tp ? Math.round(td/tp*100) : 0}%). На окно 2×2 м: примыкание 8 + короб 6 + нащельники 4 = 18 п.м.</div>`;
  }
  note += clad
    ? '<div class="vol-note">Проектный объём облицовки не считался — показана площадь панелей по чертежу, м².</div>'
    : lin
    ? (w.group === 'fc'
        ? '<div class="vol-note">Проект — по проёмам СПК чертежа АР, п.м. Выполнено — по отмеченным окнам.</div>'
        : '<div class="vol-note">Проект — длины элементов по маркам чертежа АР (без крышек парапетов), п.м. Выполнено — по отмеченным элементам.</div>')
    : `<div class="vol-note">Проект — расчёт по исполнительным схемам (13.10.26), ${w.unit}. ≈ Выполнено = проект × доля закрашенной площади фасада.</div>`;
  document.getElementById('volBody').innerHTML = html + note;
}
function hoverFac(i){ if (hoverFacade !== i){ hoverFacade = i; draw(); } }
function zoomFac(i){
  const b = facadeBoxes(i)[0]; if (!b) return;
  const pad = Math.max(b.w, b.h) * 0.06;
  fitToBox({x:b.x-pad, y:b.y-pad, w:b.w+pad*2, h:b.h+pad*2}); draw();
}
let volTimer = null;
function renderVolumesSoon(){ clearTimeout(volTimer); volTimer = setTimeout(renderVolumes, 120); }

/* ── легенда видов работ ── */
function visibleWorkTypes(){
  const hidden = new Set(((PROJECT && PROJECT.hiddenWorkTypes) || {})[activeCorpus] || []);
  return WORK_TYPES.filter(w=>!hidden.has(w.id));
}
function layerPct(id){
  if (!C) return null;
  const geo = geoForType(id), filled = C.layers[id];
  let tot = 0, done = 0;
  for (let i=0;i<geo.length;i++){ const g = geo[i]; if (g.hidden) continue; const m = measure(g, id); tot += m; if (filled.has(i)) done += m; }
  return tot ? done/tot : null;
}
function renderWorkTypeList(){
  const el = document.getElementById('workTypeList');
  const sub = document.getElementById('layerSub'), cur = WORK_TYPES.find(x=>x.id===activeWorkType);
  if (sub) sub.textContent = cur.group ? GROUPS[cur.group] + ': ' + cur.short : cur.label;
  let lastGroup = null, html = '<div class="layer-cols"><span>Вид работ</span><span>Вып.</span></div>';
  visibleWorkTypes().forEach(w=>{
    if (w.group && w.group !== lastGroup) html += `<div class="layer-group">${escapeHtml(GROUPS[w.group])}</div>`;
    lastGroup = w.group || null;
    const p = layerPct(w.id);
    html += `<div class="legend-item ${w.group ? 'sub' : ''} ${activeWorkType===w.id?'active':''}" data-wt="${w.id}" title="${escapeHtml(w.label)}">
      <div>${escapeHtml(w.group ? w.short : w.label)}</div><div class="lp">${p===null ? '—' : Math.round(p*100)+'%'}</div></div>`;
  });
  el.innerHTML = html + `<div class="legend-block">
      <div class="lg"><i class="lg-done"></i>Выполнено</div>
      ${workLegendHtml()}
      <div class="lg"><i class="lg-ar"></i>Чертёж АР${C && hlFor(activeWorkType) ? ' (приглушён)' : ''}</div>
      <div class="lg"><i class="lg-axis"></i>Оси</div></div>`;
}
function workLegendHtml(){
  const hl = C ? hlFor(activeWorkType) : null;
  if (!hl) return '';
  return `<div class="lg"><i style="border:1.5px solid ${hl.line};background:${hl.fill || 'transparent'}"></i>${escapeHtml(hl.label)}</div>`;
}
function togglePal(id){
  const el = document.getElementById(id); el.classList.toggle('collapsed');
  LS.set('ft_pal_' + id, el.classList.contains('collapsed') ? '1' : '0');
}
window.setWorkType = function(id){ activeWorkType = id; renderWorkTypeList(); renderVolumes(); draw(); };

window.setTool = function(t){
  tool = t;
  document.getElementById('brushBtn').classList.toggle('active', t==='brush');
  document.getElementById('eraserBtn').classList.toggle('active', t==='eraser');
};
window.onBrushSize = function(v){
  brushRadius = Number(v) * 40;
  const d = document.getElementById('brushDot');
  d.style.width = (8+Number(v)/2)+'px'; d.style.height = d.style.width; draw();
};
window.clearLayer = function(){
  if (READ_ONLY || !C) return;
  const w = WORK_TYPES.find(x=>x.id===activeWorkType);
  if (!confirm('Очистить закраску по позиции «'+w.label+'» на ' + CORPUS_LABEL[C.id] + '? Это увидят все.')) return;
  C.layers[activeWorkType].clear(); touchLayer(C, activeWorkType);
  pushEvent(activeWorkType, 'clear', [], []);
  renderVolumes(); renderWorkTypeList(); draw();
};
window.resetView = function(){ if (C){ fitToBox(); draw(); } };

/* ── кисть: попадание по bbox панели, расширенному на радиус ── */
function hitPanelsAt(wx, wy, radius){
  const key = geoKey(activeWorkType), geo = C.geo[key], idx = C.index[key], hits = new Set();
  for (let cx = Math.floor((wx-radius)/CELL); cx <= Math.floor((wx+radius)/CELL); cx++)
    for (let cy = Math.floor((wy-radius)/CELL); cy <= Math.floor((wy+radius)/CELL); cy++){
      const l = idx.get(cx*100003 + cy); if (!l) continue;
      for (const i of l){ const g = geo[i];
        if (wx > g.bx0-radius && wx < g.bx1+radius && wy > g.by0-radius && wy < g.by1+radius) hits.add(i); }
    }
  return hits;
}
let strokeAdded = null, strokeRemoved = null;
function applyBrush(wx, wy){
  if (READ_ONLY) return;
  const set = C.layers[activeWorkType], added = []; let removed = false;
  hitPanelsAt(wx, wy, brushRadius).forEach(idx=>{
    if (tool==='brush'){
      if (!set.has(idx)){ set.add(idx); strokeAdded.add(idx); strokeRemoved.delete(idx); added.push(idx); }
    } else if (set.has(idx)){ set.delete(idx); strokeRemoved.add(idx); strokeAdded.delete(idx); removed = true; }
  });
  if (removed) touchLayer(C, activeWorkType);
  else if (added.length) touchLayer(C, activeWorkType, added);
}

let isDrawing = false, isPanning = false, panStart=null, centerStart=null, lastWorld = null, hoverScreen = null, spaceDown = false;
window.addEventListener('keydown', e=>{
  if (e.code==='Space'){ spaceDown=true; if (e.target === document.body) e.preventDefault(); }
  if (e.target !== document.body || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.code==='KeyB' && !READ_ONLY) setTool('brush');
  else if (e.code==='KeyE' && !READ_ONLY) setTool('eraser');
  else if (e.code==='KeyZ') resetView();
});
window.addEventListener('keyup', e=>{ if (e.code==='Space') spaceDown=false; });
function strokeTo(wx, wy){
  if (lastWorld){
    const dist = Math.hypot(wx-lastWorld[0], wy-lastWorld[1]);
    const step = Math.max(brushRadius*0.4, 20), n = Math.max(1, Math.ceil(dist/step));
    for (let i=1;i<=n;i++){ const t=i/n; applyBrush(lastWorld[0]+(wx-lastWorld[0])*t, lastWorld[1]+(wy-lastWorld[1])*t); }
  } else applyBrush(wx, wy);
  lastWorld = [wx, wy];
}
function startPan(e){ isPanning=true; wrap.classList.add('panning'); panStart={x:e.clientX,y:e.clientY}; centerStart={x:viewCenterX,y:viewCenterY}; }
function pointerDown(e){
  if (!C) return;
  const rect = wrap.getBoundingClientRect(), sx=e.clientX-rect.left, sy=e.clientY-rect.top;
  if (ksMode){ ksDragStart = screenToWorld(sx,sy); ksDragCurrent = ksDragStart; draw(); return; }
  if (READ_ONLY || e.button===1 || e.button===2 || spaceDown){ startPan(e); return; }
  isDrawing = true; lastWorld = null; strokeAdded = new Set(); strokeRemoved = new Set();
  const [wx,wy] = screenToWorld(sx,sy); strokeTo(wx,wy); draw();
}
function pointerMove(e){
  const rect = wrap.getBoundingClientRect(), sx=e.clientX-rect.left, sy=e.clientY-rect.top;
  hoverScreen = [sx,sy];
  if (ksMode && ksDragStart){ ksDragCurrent = screenToWorld(sx,sy); draw(); return; }
  if (isPanning){
    viewCenterX = centerStart.x - (e.clientX-panStart.x)/rect.width*view.w;
    viewCenterY = centerStart.y - (e.clientY-panStart.y)/rect.height*view.h;
    noteInteract(); draw(); return;
  }
  if (isDrawing){ const [wx,wy] = screenToWorld(sx,sy); strokeTo(wx,wy); }
  draw();
}
async function pointerUp(){
  if (ksMode){
    if (ksDragStart && ksDragCurrent){
      const x0 = Math.min(ksDragStart[0], ksDragCurrent[0]), x1 = Math.max(ksDragStart[0], ksDragCurrent[0]);
      const y0 = Math.min(ksDragStart[1], ksDragCurrent[1]), y1 = Math.max(ksDragStart[1], ksDragCurrent[1]);
      if (x1-x0 > 50 && y1-y0 > 50){
        const name = prompt('Название участка (например «КС №1 от 15.07»):', 'КС №' + (C.ksAreas.length+1));
        if (name){
          const area = { id:'ks' + Date.now(), corpus:C.id, name, x0, y0, x1, y1 };
          try { await apiFetch('ks', {method:'POST', body:area}); } catch(e){}
          await loadKsAreas(); activeKsId = area.id; renderKsPanel();
        }
      }
    }
    ksDragStart = null; ksDragCurrent = null; toggleKsMode(false); draw(); return;
  }
  if (isPanning){ isPanning=false; wrap.classList.remove('panning'); return; }
  if (isDrawing){
    isDrawing=false; lastWorld=null;
    if (strokeAdded && (strokeAdded.size || strokeRemoved.size)) pushEvent(activeWorkType, 'paint', strokeAdded, strokeRemoved);
    strokeAdded = null; strokeRemoved = null;
    renderVolumes(); renderWorkTypeList();
  }
  draw();
}

wrap.addEventListener('mousedown', pointerDown);
window.addEventListener('mousemove', pointerMove);
window.addEventListener('mouseup', pointerUp);
wrap.addEventListener('mouseleave', ()=>{ hoverScreen=null; draw(); });
wrap.addEventListener('contextmenu', e=>e.preventDefault());

let touchPinch = null;
wrap.addEventListener('touchstart', e=>{
  if (e.touches.length===1){ const t=e.touches[0]; pointerDown({clientX:t.clientX, clientY:t.clientY, button:0}); }
  else if (e.touches.length===2){
    isDrawing=false; isPanning=false; lastWorld=null;
    const [a,b]=e.touches;
    touchPinch = { dist:Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY), width:viewWidth };
  }
  e.preventDefault();
}, {passive:false});
wrap.addEventListener('touchmove', e=>{
  if (e.touches.length===1 && !touchPinch){ const t=e.touches[0]; pointerMove({clientX:t.clientX, clientY:t.clientY}); }
  else if (e.touches.length===2 && touchPinch){
    const [a,b]=e.touches, dist = Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);
    viewWidth = Math.min(C.fullBox.w*3, Math.max(C.fullBox.w*0.008, touchPinch.width*touchPinch.dist/Math.max(1,dist)));
    noteInteract(); draw();
  }
  e.preventDefault();
}, {passive:false});
wrap.addEventListener('touchend', ()=>{ touchPinch=null; pointerUp(); }, {passive:true});

wrap.addEventListener('wheel', e=>{
  e.preventDefault(); if (!C) return;
  const rect = wrap.getBoundingClientRect(), sx = e.clientX-rect.left, sy = e.clientY-rect.top;
  const mx = sx/rect.width, my = sy/rect.height, [worldX, worldY] = screenToWorld(sx, sy);
  viewWidth = Math.min(C.fullBox.w*3, Math.max(C.fullBox.w*0.008, viewWidth*(e.deltaY>0 ? 1.12 : 1/1.12)));
  syncView();
  viewCenterX = worldX - mx*view.w + view.w/2; viewCenterY = worldY - my*view.h + view.h/2;
  noteInteract(); draw(); showZoomHint();
}, {passive:false});

let zoomHintTimer=null;
function showZoomHint(){
  const el = document.getElementById('zoomHint'); el.classList.add('show');
  clearTimeout(zoomHintTimer); zoomHintTimer = setTimeout(()=>el.classList.remove('show'), 1800);
}

/* ── кнопки и списки: обработчики навешиваются здесь (на странице нет встроенных скриптов — так требует политика безопасности) ── */
function bindUI(){
  document.addEventListener('click', e=>{
    const a = e.target.closest('[data-act]');
    if (a){
      const act = a.dataset.act;
      if (act === 'brush') setTool('brush');
      else if (act === 'eraser') setTool('eraser');
      else if (act === 'clear') clearLayer();
      else if (act === 'fit') resetView();
      else if (act === 'toggle-layers') togglePal('layerPal');
      else if (act === 'toggle-vol') toggleVolCard();
      else if (act === 'ks-new') toggleKsMode();
      return;
    }
    const wt = e.target.closest('[data-wt]'); if (wt){ setWorkType(wt.dataset.wt); return; }
    const tab = e.target.closest('[data-corpus]'); if (tab){ switchCorpus(tab.dataset.corpus); return; }
    const fr = e.target.closest('tr[data-fac]'); if (fr){ zoomFac(Number(fr.dataset.fac)); return; }
    const kd = e.target.closest('[data-ks-del]'); if (kd){ deleteKsArea(kd.dataset.ksDel); return; }
    const ks = e.target.closest('[data-ks]'); if (ks){ selectKsArea(ks.dataset.ks); return; }
  });
  const vb = document.getElementById('volBody');
  vb.addEventListener('mouseover', e=>{ const r = e.target.closest('tr[data-fac]'); hoverFac(r ? Number(r.dataset.fac) : -1); });
  vb.addEventListener('mouseleave', ()=>hoverFac(-1));
  document.getElementById('brushRange').addEventListener('input', e=>onBrushSize(e.target.value));
}

/* ── старт ── */
(async function init(){
  bindUI();
  if (!SLUG){ location.href = '/'; return; }
  try {
    const r = await apiFetch('info');
    if (!r.ok){ location.href = '/'; return; }
    const info = await r.json();
    PROJECT = info.project; ROLE = PROJECT.role;
    document.title = (PROJECT.short || PROJECT.name) + ' — Фасады';
    document.getElementById('projName').textContent = PROJECT.short || PROJECT.name;
    document.getElementById('projName').title = PROJECT.name;
    document.getElementById('userChip').textContent = info.user.name || info.user.login;
  } catch(e){ updateSyncStatus('Нет связи с сервером', false); return; }
  CORPUS_LABEL = {};
  const tabs = document.getElementById('corpusTabs'); tabs.replaceChildren();
  PROJECT.corpora.forEach(c=>{
    CORPUS_LABEL[c.id] = c.label;
    const b = document.createElement('button'); b.className = 'corpus-tab'; b.dataset.corpus = c.id; b.textContent = c.label;
    tabs.append(b);
  });
  const saved = LS.get('ft_active_corpus_' + SLUG, '');
  const first = CORPUS_LABEL[saved] ? saved : (PROJECT.corpora[0] || {}).id;
  if (LS.get('ft_pal_layerPal', isMobileViewport() ? '1' : '0') === '1') document.getElementById('layerPal').classList.add('collapsed');
  applyReadOnlyUI();
  renderVolumes();
  resizeCanvas();
  if (!first){ hideLoading(); return; }
  await switchCorpus(first, true);
  showZoomHint();
  flushOutbox();
  setInterval(()=>{ if (!isDrawing && !document.hidden){ pullEvents(); flushOutbox(); } }, 4000);
  document.addEventListener('visibilitychange', ()=>{ if (!document.hidden) pullEvents(); });
})();
