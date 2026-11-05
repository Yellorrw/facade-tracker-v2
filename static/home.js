/* Фасады — вход, список объектов, управление пользователями (для администратора).
   Все данные пользователей выводятся через textContent — никакого HTML из базы на странице. */
'use strict';
const $ = id => document.getElementById(id);

async function api(path, opts){
  opts = opts || {};
  const init = { method: opts.method || 'GET', credentials: 'same-origin', cache: 'no-store',
                 headers: { 'X-Requested-With': 'fasady' } };
  if (opts.body !== undefined){ init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
  const r = await fetch(path, init);
  let d = {}; try { d = await r.json(); } catch(e){}
  if (!r.ok){ const e = new Error(d.error || ('Ошибка ' + r.status)); e.status = r.status; throw e; }
  return d;
}
function el(tag, attrs, ...kids){
  const e = document.createElement(tag);
  for (const k in (attrs || {})){
    if (k === 'class') e.className = attrs[k];
    else if (k === 'text') e.textContent = attrs[k];
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
    else e.setAttribute(k, attrs[k]);
  }
  for (const c of kids) if (c !== null && c !== undefined) e.append(c);
  return e;
}
const ROLE_LABEL = { editor:'редактор', viewer:'наблюдатель' };

let ME = null;

async function boot(){
  try {
    ME = await api('/api/me');
  } catch(e){
    if (e.status === 401) return showLogin();
    $('loginView').hidden = false; $('loginErr').textContent = 'Нет связи с сервером'; return;
  }
  // пришли по ссылке на объект до входа — после входа сразу туда
  const next = new URLSearchParams(location.search).get('next');
  if (next && /^[a-z0-9_-]{1,40}$/.test(next) && ME.projects.some(p => p.slug === next)){ location.replace('/p/' + next); return; }
  showHome();
}

function showLogin(){
  $('who').hidden = true; $('projectsView').hidden = true; $('adminView').hidden = true;
  $('loginView').hidden = false; $('loginInput').focus();
}
$('loginForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  const f = ev.target, btn = f.querySelector('button'); $('loginErr').textContent = ''; btn.disabled = true;
  try {
    await api('/api/login', { method:'POST', body:{ login:f.login.value.trim(), password:f.password.value } });
    f.password.value = '';
    $('loginView').hidden = true; await boot();
  } catch(e){ $('loginErr').textContent = e.message; f.password.select(); }
  finally { btn.disabled = false; }
});

function showHome(){
  $('loginView').hidden = true;
  $('who').hidden = false; $('whoName').textContent = ME.user.name || ME.user.login;
  document.title = 'Объекты — Фасады';
  const list = $('projectList'); list.replaceChildren();
  ME.projects.forEach(p => {
    list.append(el('a', { class:'proj', href:'/p/' + encodeURIComponent(p.slug) },
      el('span', { class:'code', text:p.short || p.slug }),
      el('span', { class:'name', text:p.name }),
      p.description ? el('span', { class:'desc', text:p.description }) : null,
      el('span', { class:'meta' },
        el('span', { text:(p.corpora || []).length ? (p.corpora.length + ' корп.') : '' }),
        el('span', { class:'role ' + p.role, text: ME.user.admin ? 'администратор' : ROLE_LABEL[p.role] || p.role }))));
  });
  $('noProjects').hidden = ME.projects.length > 0;
  $('projectsView').hidden = false;
  if (ME.user.admin) loadUsers(); else $('adminView').hidden = true;
}

$('logoutBtn').addEventListener('click', async () => {
  try { await api('/api/logout', { method:'POST' }); } catch(e){}
  ME = null; history.replaceState(null, '', '/'); showLogin();
});

/* ── смена своего пароля ── */
$('pwBtn').addEventListener('click', () => { $('pwForm').reset(); $('pwErr').textContent = ''; $('pwDialog').showModal(); });
$('pwCancel').addEventListener('click', () => $('pwDialog').close());
$('pwForm').addEventListener('submit', async ev => {
  ev.preventDefault(); const f = ev.target;
  if (f.new.value !== f.new2.value){ $('pwErr').textContent = 'Новые пароли не совпадают'; return; }
  try { await api('/api/me/password', { method:'POST', body:{ old:f.old.value, new:f.new.value } }); $('pwDialog').close(); }
  catch(e){ $('pwErr').textContent = e.message; }
});

/* ── пользователи ── */
let ADMIN = { users:[], projects:[] };
async function loadUsers(){
  try { ADMIN = await api('/api/admin/users'); } catch(e){ return; }
  $('adminView').hidden = false;
  const t = $('userTable'); t.replaceChildren();
  t.append(el('tr', null, el('th', { text:'Логин' }), el('th', { text:'Имя' }),
    ...ADMIN.projects.map(p => el('th', { text:p.name.length > 26 ? p.slug.toUpperCase() : p.name, title:p.name })), el('th')));
  ADMIN.users.forEach(u => {
    const me = u.login.toLowerCase() === ME.user.login.toLowerCase();
    const tr = el('tr', { class: u.active ? '' : 'off' },
      el('td', { class:'login', text:u.login + (u.is_admin ? ' ★' : '') , title: u.is_admin ? 'администратор' : '' }),
      el('td', { text:u.name || '' }));
    ADMIN.projects.forEach(p => {
      if (u.is_admin){ tr.append(el('td', { class:'muted', text:'все права' })); return; }
      const s = el('select', { 'aria-label':'Доступ к ' + p.name });
      [['', 'нет доступа'], ['viewer', 'наблюдатель'], ['editor', 'редактор']].forEach(([v, l]) => {
        const o = el('option', { value:v, text:l }); if ((u.access[p.slug] || '') === v) o.selected = true; s.append(o);
      });
      s.addEventListener('change', async () => {
        try { await api('/api/admin/users/' + u.id, { method:'POST', body:{ access:{ [p.slug]: s.value || null } } }); }
        catch(e){ alert(e.message); }
        loadUsers();
      });
      tr.append(el('td', null, s));
    });
    tr.append(el('td', { class:'acts' },
      el('button', { class:'ghost sm', type:'button', text:'Логин', onclick: async () => {
        const nl = prompt('Новый логин для ' + u.login + ' (латиница, цифры, . _ - @):', u.login);
        if (!nl || nl.trim() === u.login) return;
        try { await api('/api/admin/users/' + u.id, { method:'POST', body:{ login:nl.trim() } }); } catch(e){ alert(e.message); return; }
        if (me){ ME.user.login = nl.trim(); }
        loadUsers();
      } }),
      el('button', { class:'ghost sm', type:'button', text:'Пароль', onclick:() => openReset(u) }),
      me ? null : el('button', { class:'ghost sm', type:'button', text: u.active ? 'Отключить' : 'Включить',
        onclick: async () => {
          if (u.active && !confirm('Отключить ' + u.login + '? Он сразу потеряет доступ.')) return;
          try { await api('/api/admin/users/' + u.id, { method:'POST', body:{ active: !u.active } }); } catch(e){ alert(e.message); }
          loadUsers();
        } })));
    t.append(tr);
  });
  // доступы для нового пользователя
  const box = $('addAccess'); box.replaceChildren();
  ADMIN.projects.forEach(p => {
    const s = el('select', { name:'acc_' + p.slug });
    [['', 'нет доступа'], ['viewer', 'наблюдатель'], ['editor', 'редактор']].forEach(([v, l]) => s.append(el('option', { value:v, text:l })));
    box.append(el('label', null, p.name, s));
  });
}

function genPassword(){
  const a = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const r = new Uint32Array(12); crypto.getRandomValues(r);
  return Array.from(r, x => a[x % a.length]).join('');
}
$('genPw').addEventListener('click', () => { $('addUserForm').password.value = genPassword(); });
$('addUserForm').addEventListener('submit', async ev => {
  ev.preventDefault(); const f = ev.target; $('addErr').textContent = '';
  try {
    const { id } = await api('/api/admin/users', { method:'POST', body:{
      login:f.login.value.trim(), name:f.name.value.trim(), password:f.password.value, admin:f.admin.checked } });
    const access = {};
    ADMIN.projects.forEach(p => { const v = f['acc_' + p.slug].value; if (v) access[p.slug] = v; });
    if (Object.keys(access).length) await api('/api/admin/users/' + id, { method:'POST', body:{ access } });
    alert('Пользователь создан.\nЛогин: ' + f.login.value.trim() + '\nПароль: ' + f.password.value + '\n\nПередайте их лично; пароль можно сменить после входа.');
    f.reset(); loadUsers();
  } catch(e){ $('addErr').textContent = e.message; }
});

let resetUser = null;
function openReset(u){
  resetUser = u; $('resetForm').reset(); $('resetErr').textContent = '';
  $('resetTitle').textContent = 'Новый пароль: ' + u.login;
  $('resetForm').password.value = genPassword();
  $('resetDialog').showModal();
}
$('resetCancel').addEventListener('click', () => $('resetDialog').close());
$('resetForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  const pw = ev.target.password.value;
  try {
    await api('/api/admin/users/' + resetUser.id, { method:'POST', body:{ password:pw } });
    $('resetDialog').close();
    alert('Пароль для ' + resetUser.login + ': ' + pw + '\nВсе его входы сброшены.');
  } catch(e){ $('resetErr').textContent = e.message; }
});

boot();
