/* ============================================================
 * 团长结账工具 · 云账单前端模块
 * ------------------------------------------------------------
 * 职责：
 *   1. 编辑页：本地优先（IndexedDB 自动保存）+ 「保存并上传」
 *   2. 查询页：账单列表 / 明细行，公开可查（不用登录）
 *   3. 详情页：完整分配表 + 打勾（团长全队 / 队长凭码本队）
 *   4. 登录注册：复用全站账号（XSB_AUTH）
 *
 * 与 index.html 的关系：
 *   本文件是一个 IIFE，运行在页面最末尾。它能读到 index.html
 *   顶层声明的变量（currentGeneralResult / payMode / itemsCache …），
 *   但自己不外泄任何全局名字，避免冲突。
 * ============================================================ */
(function () {
'use strict';

/* ============================================================
 * 0. 小工具
 * ============================================================ */
const $ = (id) => document.getElementById(id);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const ESC = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
const fmtG = (v) => { const n = num(v); return n > 0.004 ? n.toFixed(2) : '—'; };
const fmtR = (v) => { const n = num(v); return n > 0.004 ? '¥' + n.toFixed(2) : '—'; };
const pad2 = (n) => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); };
const uuid = () => {
  if (window.crypto && crypto.randomUUID) { try { return crypto.randomUUID(); } catch (e) {} }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : ((r & 0x3) | 0x8)).toString(16);
  });
};
const shortTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
         ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
};

let toastTimer = null;
function toast(msg, kind) {
  const el = $('billToast');
  if (!el) { if (kind === 'err') console.warn(msg); return; }
  el.textContent = msg;
  el.className = 'is-show' + (kind === 'err' ? ' is-err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, kind === 'err' ? 4600 : 2600);
}

function busy(btn, on, label) {
  if (!btn) return;
  if (on) {
    btn.dataset.prevText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = label || '处理中…';
  } else {
    btn.disabled = false;
    if (btn.dataset.prevText) { btn.innerHTML = btn.dataset.prevText; delete btn.dataset.prevText; }
  }
}

/* ============================================================
 * 1. 后端接口
 * ============================================================ */
const SB = (function () {
  const A = window.XSB_AUTH || {};
  const url = A.LB_URL || 'https://xjyovpninpfztldqoddj.supabase.co';
  const key = A.LB_KEY || 'sb_publishable_uDRHXpUMaX9Wa2WJrqefrA_cK27Qqxl';

  function headers() {
    const h = { 'apikey': key, 'Content-Type': 'application/json' };
    const t = A.token ? A.token() : '';
    if (t) h['Authorization'] = 'Bearer ' + t;
    return h;
  }

  async function rpc(name, body) {
    let res;
    try {
      res = await fetch(url + '/rest/v1/rpc/' + name, {
        method: 'POST', headers: headers(), body: JSON.stringify(body || {})
      });
    } catch (e) {
      const err = new Error('网络连不上，检查一下网络或稍后再试');
      err.offline = true;
      throw err;
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    if (!res.ok) {
      const msg = (data && (data.message || data.error_description || data.hint)) || ('请求失败（HTTP ' + res.status + '）');
      const err = new Error(msg);
      err.status = res.status;
      err.detail = data;
      throw err;
    }
    return data;
  }

  async function auth(path, body) {
    const res = await fetch(url + path, {
      method: 'POST',
      headers: { 'apikey': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    if (!res.ok) {
      const msg = (data && (data.msg || data.error_description || data.message)) || ('HTTP ' + res.status);
      throw new Error(msg);
    }
    return data;
  }

  return { rpc, auth, headers, url, key };
})();

/* ============================================================
 * 2. 本地存储（IndexedDB，存不进去就退回 localStorage）
 * ============================================================ */
const Store = (function () {
  const DB_NAME = 'xsb_bill_db';
  const DB_VER = 1;
  let dbp = null;
  let broken = false;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('no indexedDB'));
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('bills')) db.createObjectStore('bills', { keyPath: 'localId' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('idb open fail'));
    });
    dbp.catch(() => { broken = true; });
    return dbp;
  }
  function os(store, mode) {
    return open().then(db => db.transaction(store, mode).objectStore(store));
  }
  function wrap(req) {
    return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  }

  // localStorage 兜底（万一浏览器禁用 IndexedDB）
  const LSK = 'xsb_bill_fallback_';
  function lsPut(rec) { try { localStorage.setItem(LSK + rec.localId, JSON.stringify(rec)); } catch (e) {} }
  function lsGet(id) { try { const t = localStorage.getItem(LSK + id); return t ? JSON.parse(t) : null; } catch (e) { return null; } }

  return {
    put(rec) {
      lsPut(rec);
      if (broken) return Promise.resolve(rec);
      return os('bills', 'readwrite').then(st => wrap(st.put(rec))).then(() => rec, () => rec);
    },
    get(id) {
      if (broken) return Promise.resolve(lsGet(id));
      return os('bills', 'readonly').then(st => wrap(st.get(id))).then(r => r || lsGet(id), () => lsGet(id));
    },
    all() {
      if (broken) {
        const out = [];
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.indexOf(LSK) === 0) { try { out.push(JSON.parse(localStorage.getItem(k))); } catch (e) {} }
          }
        } catch (e) {}
        return Promise.resolve(out);
      }
      return os('bills', 'readonly').then(st => wrap(st.getAll())).then(r => r || [], () => []);
    },
    del(id) {
      try { localStorage.removeItem(LSK + id); } catch (e) {}
      if (broken) return Promise.resolve();
      return os('bills', 'readwrite').then(st => wrap(st.delete(id))).catch(() => {});
    },
    metaGet(k) {
      if (broken) { try { return Promise.resolve(JSON.parse(localStorage.getItem('xsb_meta_' + k) || 'null')); } catch (e) { return Promise.resolve(null); } }
      return os('meta', 'readonly').then(st => wrap(st.get(k))).catch(() => null);
    },
    metaPut(k, v) {
      try { localStorage.setItem('xsb_meta_' + k, JSON.stringify(v)); } catch (e) {}
      if (broken) return Promise.resolve(v);
      return os('meta', 'readwrite').then(st => wrap(st.put(v, k))).catch(() => v);
    }
  };
})();

/* ============================================================
 * 3. 全局状态
 * ============================================================ */
const ST = {
  localId: null,        // 当前编辑账单的 id（= public_id）
  cloudId: null,        // 已上传才有
  uploadedAt: null,
  ownerName: '',
  dirty: false,        // 有改动还没存到本地
  cloudDirty: false,   // 本地内容和云端不一致（改过但没上传）
  access: {},           // { billId: { code, team } } —— 手上有哪些队的码
  query: { src: 'cloud', view: 'bill', page: 1, total: 0, loading: false },
  sessCode: null,       // 本次会话用分享码打开的那支队（关掉详情就清空）
  local: { list: [], versions: {} },   // 本地文件夹读出来的账单
  bill: null            // 当前打开的详情
};

const ACCESS_KEY = 'xsb_bill_access_v1';
function loadAccess() { try { ST.access = JSON.parse(localStorage.getItem(ACCESS_KEY) || '{}') || {}; } catch (e) { ST.access = {}; } }
function saveAccess() { try { localStorage.setItem(ACCESS_KEY, JSON.stringify(ST.access)); } catch (e) {} }
loadAccess();

/* ============================================================
 * 4. 登录状态
 * ============================================================ */
const Auth = {
  isOn() { return !!(window.XSB_AUTH && XSB_AUTH.state() === 'on'); },
  email() { return (window.XSB_AUTH && XSB_AUTH.email()) || ''; },
  uid() { return (window.XSB_AUTH && XSB_AUTH.uid()) || ''; },
  refresh() { try { return XSB_AUTH.refresh(); } catch (e) { return Promise.resolve(false); } }
};

let myNick = '';
let myNickFor = '';
let myNickLoading = false;

async function loadMyNick(force) {
  const uid = Auth.uid();
  if (!uid) { myNick = ''; myNickFor = ''; return ''; }
  if (!force && myNickFor === uid) return myNick;
  if (myNickLoading) return myNick;
  myNickLoading = true;
  try {
    const rows = await SB.rpc('my_profile', {});
    const row = (Array.isArray(rows) && rows.length) ? rows[0] : null;
    myNick = (row && row.nickname) ? String(row.nickname) : '';
    myNickFor = uid;
  } catch (e) {
    console.warn('[my_profile]', e);
    myNick = '';
  } finally {
    myNickLoading = false;
  }
  return myNick;
}

function renderAuthBar() {
  const dot = $('authDot'), text = $('authText');
  const inBtn = $('authOpenBtn'), outBtn = $('authOutBtn');
  if (!dot || !text) return;
  const st = window.XSB_AUTH ? XSB_AUTH.state() : 'off';
  if (st === 'on') {
    dot.className = 'auth-dot is-on';
    const who = myNick || '（还没设昵称）';
    const certified = !!(certState && certState.is_certified);
    text.innerHTML = '已登录 <b>' + ESC(who) + '</b>' + certTag(certified) +
      ' · 可以上传账单、生成队长分享码';
    if (!myNick && !myNickLoading) loadMyNick().then(() => { if (Auth.isOn()) renderAuthBar(); });
    if (inBtn) inBtn.style.display = 'none';
    if (outBtn) outBtn.style.display = '';
  } else if (st === 'expired') {
    dot.className = 'auth-dot is-off';
    text.textContent = '登录已过期，重新登录后才能上传';
    if (inBtn) { inBtn.style.display = ''; inBtn.textContent = '重新登录'; }
    if (outBtn) outBtn.style.display = '';
  } else {
    dot.className = 'auth-dot is-off';
    text.textContent = '游客模式 · 编辑的内容只存在这台设备上';
    if (inBtn) { inBtn.style.display = ''; inBtn.textContent = '登录 / 注册'; }
    if (outBtn) outBtn.style.display = 'none';
  }
  renderSaveBtn();
}

function renderSaveBtn() {
  const btn = $('saveAndUploadBtn');
  if (!btn) return;
  btn.classList.remove('is-primary', 'is-offline', 'is-dirty', 'is-synced');
  btn.removeAttribute('title');
  const icon = (name, color) => '<span data-icon="' + name + '" data-color="' + color + '"></span>';

  if (!Auth.isOn()) {
    btn.classList.add('is-offline');
    btn.innerHTML = icon('cloudUp', '#6c5ce7') + '上传云端';
    btn.title = '登录之后才能上传给队友查。没登录时内容会自动存在这台电脑上';
  } else if (!ST.cloudId) {
    btn.classList.add('is-primary');
    btn.innerHTML = icon('cloudUp', '#ffffff') + '保存并上传';
    btn.title = '本地存一份，同时上传到云端，队友立刻能查到';
  } else if (ST.cloudDirty) {
    // 传过云端，但之后又改了 —— 这时必须点一下才会同步，不会自动传
    btn.classList.add('is-dirty');
    btn.innerHTML = icon('cloudUp', '#ffffff') + '上传改动';
    btn.title = '云端还是上一版。点一下把这次改动覆盖上去';
  } else {
    btn.classList.add('is-synced');
    btn.innerHTML = icon('check', '#16a34a') + '云端已是最新';
    btn.title = '本地和云端一致，不需要再点。改了东西才会变回「上传改动」';
  }
  if (window.hydrateIcons) hydrateIcons(btn);
}

/* ============================================================
 * 5. 把当前表单收集成一份账单
 * ============================================================ */
function readPaid(tr) {
  const cbs = tr.querySelectorAll('.paid-check');
  return {
    gold: !!(cbs[0] && cbs[0].checked),
    rmb: !!(cbs[1] && cbs[1].checked)
  };
}

function collectItems() {
  return $$('.item-row', itemsContainer).map((row, i) => {
    const st = row.querySelector('.status-switch');
    const tm = row.querySelector('.taxmode-switch');
    const mk = row.querySelector('.milk-switch');
    return {
      name: (row.querySelector('.item-name-input').value || '').trim(),
      qty: num(row.querySelector('.item-quantity-input').value) || 1,
      price_gold: num(row.querySelector('.item-gold-input').value),
      price_rmb: num(row.querySelector('.item-rmb-input').value),
      tax_mode: tm ? (tm.dataset.taxmode === 'face' ? 'face' : (tm.dataset.taxmode === 'none' ? 'none' : 'free')) : 'none',
      status: st && st.dataset.status === 'sell' ? 'sell' : 'claim',
      pool: mk && mk.dataset.milk === '1' ? 'milk' : 'general',
      sort_no: i
    };
  }).filter(x => x.name || x.price_gold || x.price_rmb);
}

function collectBill() {
  const d = $('missionDate');
  const t = $('missionType');
  const base = {
    bill_date: (d && d.value) || today(),
    raid_type: ((t && t.value) || '').trim(),
    mode: (typeof appMode !== 'undefined') ? appMode : 'general',
    pay_mode: (typeof payMode !== 'undefined') ? payMode : 'direct',
    tax_rate: num($('goldRate') && $('goldRate').value) || null,
    remark: '',
    schema_ver: 1,
    items: collectItems(),
    members: [],
    fixed: [],
    result: {}
  };

  if (base.mode === 'general') {
    if (typeof calculateGeneral !== 'function') return null;
    calculateGeneral();
    const r = (typeof currentGeneralResult !== 'undefined') ? currentGeneralResult : null;
    if (!r) return null;

    const trs = $$('tr.g-person-row', generalPeopleBody);
    base.members = trs.map((tr, i) => {
      const p = r.people[i] || {};
      const paid = readPaid(tr);
      return {
        name: (tr.querySelector('.g-name-input').value || '').trim(),
        job: tr.querySelector('.g-job-select').value || '',
        weight: num(tr.querySelector('.g-weight-input').value),
        team: parseInt(tr.dataset.team, 10) || 1,
        leader: tr.dataset.leader === '1',
        chief: tr.dataset.chief === '1',
        gold_final: num(p.gold),
        rmb_final: num(p.rmb),
        gold_paid: paid.gold,
        rmb_paid: paid.rmb
      };
    });

    base.fixed = $$('tr', fixedPeopleBody).map(tr => {
      const paid = readPaid(tr);
      return {
        job: tr.querySelector('.f-job-select').value || '',
        name: (tr.querySelector('.f-name-input').value || '').trim(),
        gold: num(tr.querySelector('.f-gold-input').value),
        rmb: num(tr.querySelector('.f-rmb-input').value),
        note: (tr.querySelector('.f-note-input').value || '').trim(),
        gold_paid: paid.gold,
        rmb_paid: paid.rmb
      };
    });

    base.total_gold = num(r.totalGold);
    base.total_rmb = num(r.totalRmb);
    base.result = {
      netGold: num(r.netGold), netRmb: num(r.netRmb),
      goldTax: num(r.goldTaxTotal),
      fixedGold: num(r.fixedGold), fixedRmb: num(r.fixedRmb),
      generalPoolGold: num(r.generalPoolGold), milkPoolGold: num(r.milkPoolGold),
      teams: (r.teams || []).map(x => ({
        team: x.team, leader: x.leaderName, count: x.count,
        totalG: num(x.totalG), netG: num(x.netG),
        totalR: num(x.totalR), netR: num(x.netR)
      }))
    };
  } else {
    // 家务模式
    if (typeof calculateDistribution === 'function') calculateDistribution();
    const names = (typeof currentPersonNames !== 'undefined') ? currentPersonNames : [];
    const golds = (typeof currentGoldEarnings !== 'undefined') ? currentGoldEarnings : [];
    const rmbs = (typeof currentRmbEarnings !== 'undefined') ? currentRmbEarnings : [];
    let body = null;
    try { body = resultTableBody; } catch (e) { body = $('resultTableBody'); }
    const trs = body ? $$('tr', body).filter(tr => tr.querySelector('.paid-check')) : [];

    base.members = names.map((nm, i) => {
      const paid = trs[i] ? readPaid(trs[i]) : { gold: false, rmb: false };
      return {
        name: nm || ('第' + (i + 1) + '人'),
        job: '', weight: 0, team: 1, leader: false, chief: false,
        gold_final: num(golds[i]), rmb_final: num(rmbs[i]),
        gold_paid: paid.gold, rmb_paid: paid.rmb
      };
    });
    base.total_gold = num(golds.reduce((s, v) => s + num(v), 0));
    base.total_rmb = num(rmbs.reduce((s, v) => s + num(v), 0));
  }

  base.members = base.members.filter(m => m.name || m.gold_final > 0 || m.rmb_final > 0);
  if (!base.members.length && !base.items.length) return null;
  return base;
}

/* ============================================================
 * 6. 把一份账单回填到表单（详情页「编辑这张账单」）
 * ============================================================ */
function applyBill(p, opts) {
  if (!p || typeof p !== 'object') return false;
  opts = opts || {};

  if (p.mode && typeof appMode !== 'undefined' && appMode !== p.mode && typeof setMode === 'function') {
    setMode(p.mode);
  }

  const d = $('missionDate');
  if (d) d.value = p.bill_date || today();
  const t = $('missionType');
  if (t) t.value = p.raid_type || '';
  const g = $('goldRate');
  if (g) g.value = (p.tax_rate == null ? '' : p.tax_rate);

  // 支付方式
  if (typeof payMode !== 'undefined' && p.pay_mode) {
    payMode = p.pay_mode === 'team' ? 'team' : 'direct';
    $$('#payModeSwitch .pay-opt').forEach(b => b.classList.toggle('active', b.dataset.pay === payMode));
  }

  // 物品
  if (Array.isArray(p.items) && typeof itemsCache !== 'undefined') {
    itemsCache = p.items.map(it => ({
      name: it.name || '',
      qty: it.qty != null ? String(it.qty) : '1',
      gold: it.price_gold ? String(it.price_gold) : '',
      rmb: it.price_rmb ? String(it.price_rmb) : '',
      perUnit: !!it.perUnit,
      status: it.status === 'sell' ? 'sell' : 'claim',
      taxMode: it.tax_mode === 'none' ? 'none' : (it.tax_mode === 'face' ? 'face' : 'free'),
      unionTax: false,
      milk: it.pool === 'milk',
      templateName: ''
    }));
    if (typeof rebuildItems === 'function') rebuildItems();
  }

  // 人员
  if (Array.isArray(p.members) && typeof generalPeopleCache !== 'undefined' && p.mode !== 'house') {
    generalPeopleCache = p.members.map(m => ({
      job: m.job || '',
      name: m.name || '',
      weight: m.weight != null ? m.weight : 1,
      team: m.team || 1,
      leader: !!m.leader,
      chief: !!m.chief
    }));
    // 勾选状态按「名字 + 列」写回本地，让编辑页显示一致
    p.members.forEach(m => {
      const nm = m.name || '';
      try {
        localStorage.setItem('xsb_paid_g0_' + nm, m.gold_paid ? '1' : '0');
        localStorage.setItem('xsb_paid_g1_' + nm, m.rmb_paid ? '1' : '0');
      } catch (e) {}
    });
    if (typeof rebuildGeneralPeople === 'function') rebuildGeneralPeople();
  }

  // 固定工资人员
  if (Array.isArray(p.fixed) && typeof fixedPeopleCache !== 'undefined') {
    fixedPeopleCache = p.fixed.map(f => ({
      job: f.job || '', name: f.name || '',
      gold: f.gold || '', rmb: f.rmb || '', note: f.note || ''
    }));
    p.fixed.forEach(f => {
      const nm = f.name || '';
      try {
        localStorage.setItem('xsb_paid_f0_' + nm, f.gold_paid ? '1' : '0');
        localStorage.setItem('xsb_paid_f1_' + nm, f.rmb_paid ? '1' : '0');
      } catch (e) {}
    });
    if (typeof rebuildGeneralPeople === 'function') rebuildGeneralPeople();
  }

  if (typeof calculateGeneral === 'function') calculateGeneral();
  if (typeof calculateDistribution === 'function') calculateDistribution();

  ST.localId = p.public_id || p.id || ST.localId;
  ST.cloudId = p.public_id || p.id || ST.cloudId;
  ST.uploadedAt = p.updated_at || null;
  ST.ownerName = p.owner_name || '';
  ST.dirty = false;
  // 从云端载入 / 刚上传的才算同步；恢复本地草稿时要由调用方判断
  ST.cloudDirty = !!opts.cloudDirty;
  renderBillState();
  renderSaveBtn();
  return true;
}

/* ============================================================
 * 7. 编辑页状态条
 * ============================================================ */
function renderBillState() {
  const box = $('billState');
  if (!box) return;
  const parts = [];
  if (ST.localId) {
    parts.push('<span class="chip">本地草稿 ' + ESC(ST.localId.slice(0, 8)) + '</span>');
  }
  if (ST.cloudId) {
    if (ST.cloudDirty) {
      parts.push('<span class="chip warn">云端是上一版 · 这次改动还没传</span>');
    } else {
      parts.push('<span class="chip ok">已上传 · ' + ESC(shortTime(ST.uploadedAt)) + '</span>');
    }
    parts.push('<button type="button" class="auth-mini" id="bsOpenBtn" style="padding:4px 11px;">在查询页打开</button>');
    parts.push('<button type="button" class="auth-mini" id="bsNewBtn" style="padding:4px 11px;">新建一张空白账单</button>');
  } else if (ST.localId) {
    parts.push('<span class="chip warn">还没上传 · 队友暂时查不到</span>');
    parts.push('<button type="button" class="auth-mini" id="bsNewBtn" style="padding:4px 11px;">新建一张空白账单</button>');
  }
  if (!parts.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = '';
  box.innerHTML = parts.join('');
  if (window.hydrateIcons) hydrateIcons(box);

  const openBtn = $('bsOpenBtn');
  if (openBtn) openBtn.addEventListener('click', async () => {
    if (ST.cloudDirty) {
      if (!confirm('云端还是上一版，这次的改动还没传上去。\n\n点「确定」先上传再打开；点「取消」只看云端的旧版本。')) {
        switchPane('query');
        openBill(ST.cloudId);
        return;
      }
      await saveAndUpload();
      if (ST.cloudDirty) return;   // 上传失败就别跳了
    }
    switchPane('query');
    openBill(ST.cloudId);
  });
  const newBtn = $('bsNewBtn');
  if (newBtn) newBtn.addEventListener('click', () => newBlankBill());
}

/* 当前这张账单是否「安全」—— 没有没保存的改动
 * 不安全的情况：改了东西但自动保存还没落盘（dirty），或者有内容却从没存过 */
function hasContent() {
  try {
    const anyItem = $$('.item-row', itemsContainer).some(r => {
      const n = r.querySelector('.item-name-input');
      const g = r.querySelector('.item-gold-input');
      const m = r.querySelector('.item-rmb-input');
      return (n && n.value.trim()) || num(g && g.value) || num(m && m.value);
    });
    const anyPerson = $$('tr.g-person-row', generalPeopleBody).some(r => {
      const n = r.querySelector('.g-name-input');
      return n && n.value.trim();
    });
    const anyFixed = $$('tr', fixedPeopleBody).some(r => {
      const n = r.querySelector('.f-name-input');
      return n && n.value.trim();
    });
    return anyItem || anyPerson || anyFixed;
  } catch (e) { return false; }
}

function isWorkSafe() {
  if (ST.dirty) return false;          // 有改动还没保存
  if (!ST.localId) return !hasContent(); // 有内容却没存过
  return true;
}

function queryLink(id) {
  const base = location.origin + location.pathname;
  return base + (id ? ('?bill=' + encodeURIComponent(id)) : '');
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
  return new Promise((res, rej) => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); res();
    } catch (e) { rej(e); }
  });
}

function newBlankBill(skipConfirm) {
  if (!skipConfirm && !isWorkSafe()) {
    const why = ST.dirty
      ? '这张账单刚改过，还没存到本地（大约 1 秒后才会自动存）。'
      : '这张账单还没保存过。';
    if (!confirm(why + '\n\n新建一张空白账单，这些内容就找不回来了。\n\n确定新建吗？')) return;
  }
  ST.localId = null; ST.cloudId = null; ST.uploadedAt = null; ST.dirty = false; ST.cloudDirty = false;
  if (typeof generalPeopleCache !== 'undefined') generalPeopleCache = [];
  if (typeof fixedPeopleCache !== 'undefined') fixedPeopleCache = [];
  if (typeof itemsCache !== 'undefined') itemsCache = [];
  if (typeof rebuildItems === 'function') rebuildItems();
  if (typeof rebuildGeneralPeople === 'function') rebuildGeneralPeople();
  const t = $('missionType'); if (t) t.value = '';
  const g = $('goldRate'); if (g) g.value = '';
  const d = $('missionDate'); if (d) d.value = today();
  if (typeof calculateGeneral === 'function') calculateGeneral();
  renderBillState(); renderSaveBtn();
  toast('已新建空白账单');
}

/* ============================================================
 * 8. 保存 / 上传
 * ============================================================ */
let saveTimer = null;
function markDirty() {
  ST.dirty = true;
  ST.cloudDirty = true;   // 只要改过，云端就跟本地不一样了
  renderSaveBtn();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(autoSaveLocal, 1200);
}

async function autoSaveLocal() {
  const bill = collectBill();
  if (!bill) return;
  if (!ST.localId) ST.localId = uuid();
  const rec = {
    localId: ST.localId,
    cloudId: ST.cloudId,
    uploadedAt: ST.uploadedAt,   // 上次成功上传的时刻，用来判断草稿有没有比云端新
    updatedAt: Date.now(),
    bill
  };
  await Store.put(rec);
  ST.dirty = false;         // 本地存好了
  // cloudDirty 不能清 —— 云端还是旧版
  renderSaveBtn();
  renderBillState();
}

async function saveAndUpload() {
  const btn = $('saveAndUploadBtn');
  if (btn && btn.disabled) return;

  const bill = collectBill();
  if (!bill) { toast('还没有可保存的内容，先填物品和人员', 'err'); return; }

  const online = Auth.isOn();
  if (btn) busy(btn, true, online ? '上传中…' : '保存中…');

  try {
    if (!ST.localId) ST.localId = uuid();

    // 1) 本地一定先存
    const rec = { localId: ST.localId, cloudId: ST.cloudId, uploadedAt: ST.uploadedAt, updatedAt: Date.now(), bill };
    await Store.put(rec);
    ST.dirty = false;

    if (!online) {
      renderBillState(); renderSaveBtn();
      toast('内容已存在本机。登录后才能上传给队友查');
      openAuth('login');
      return;
    }

    // 2) 上传
    const payload = Object.assign({}, bill, { public_id: ST.localId });
    const res = await SB.rpc('bill_save', { p: payload });
    if (!res || !res.ok) throw new Error('上传失败');

    ST.cloudId = res.id;
    ST.uploadedAt = res.updated_at;
    ST.cloudDirty = false;
    await Store.put({ localId: ST.localId, cloudId: res.id, uploadedAt: res.updated_at, updatedAt: Date.now(), bill });
    await Store.metaPut('lastBillId', ST.localId);

    renderBillState(); renderSaveBtn();
    const left = (res.unsettled_gold || 0) + (res.unsettled_rmb || 0);
    toast('已上传。现在队友可以在「查询账单」里查到了' + (left ? '' : '（全部已结清）'));
  } catch (e) {
    console.error('[bill_save]', e);
    toast(e.message || '上传失败，本地已保存', 'err');
    // 401/过期 → 引导重新登录
    if (e.status === 401 || /JWT|jwt|token/i.test(e.message || '')) {
      if (window.XSB_AUTH) XSB_AUTH.dropToken();
      renderAuthBar();
      openAuth('login');
    }
  } finally {
    if (btn) busy(btn, false);
    renderSaveBtn();
  }
}

/* ============================================================
 * 9. 详情页
 * ============================================================ */
function canEditTeam(bill, team) {
  if (!bill) return false;
  if (bill.is_owner) return true;
  // 只有「这一次用分享码打开」才算队长模式；关掉详情就失效
  const sc = ST.sessCode;
  return !!(sc && sc.billId === bill.id && Number(sc.team) === Number(team));
}

function sessCodeOf(billId) {
  const sc = ST.sessCode;
  return (sc && sc.billId === billId) ? sc.code : '';
}

async function openBill(id, opt) {
  opt = opt || {};
  const modal = $('billModal');
  if (!modal) return;
  $('bmBody').innerHTML = '<div class="q-empty">正在打开账单…</div>';
  $('bmBar').innerHTML = '';
  $('bmTitle').textContent = '账单';
  $('bmSub').textContent = '';
  modal.classList.add('is-open');

  try {
    const d = await SB.rpc('bill_detail', { p_bill_id: id });
    ST.bill = d;
    ST.sessCode = opt.code ? { billId: d.id, team: Number(opt.team), code: opt.code } : null;
    renderBillDetail(d);
    if (opt.highlight) flashMemberRow(opt.highlight);
  } catch (e) {
    console.error('[bill_detail]', e);
    $('bmBody').innerHTML = '<div class="q-empty">' + ESC(e.message || '账单打不开') + '</div>';
  }
}

function closeBill() {
  const modal = $('billModal');
  if (modal) modal.classList.remove('is-open');
  ST.bill = null;
  ST.sessCode = null;   // 队长模式只在这一次有效
}

function billLink(id) {
  return location.origin + location.pathname + '?bill=' + encodeURIComponent(id);
}

/* 复制截图：把整张账单截成 PNG 写进剪贴板 */
async function copyBillImage(btn) {
  const box = document.querySelector('#billModal .bill-modal-box');
  if (!box || typeof html2canvas !== 'function') { toast('截图组件没加载出来，刷新一下', 'err'); return; }

  busy(btn, true, '生成中…');
  const clone = box.cloneNode(true);
  try {
    clone.style.maxHeight = 'none';
    clone.style.height = 'auto';
    clone.style.overflow = 'visible';
    clone.style.position = 'fixed';
    clone.style.left = '-20000px';
    clone.style.top = '0';
    clone.style.width = box.offsetWidth + 'px';
    clone.style.boxShadow = 'none';
    // 截图里不要按钮、也不要「生成分享码」那段操作说明
    clone.querySelectorAll('.bm-close, .bm-bar, .bm-danger, .q-page, .bm-hint-share, .bm-sec-teamsum').forEach(el => el.remove());
    document.body.appendChild(clone);

    const canvas = await html2canvas(clone, {
      backgroundColor: '#ffffff',
      scale: Math.min(2, window.devicePixelRatio || 1.5),
      useCORS: true,
      logging: false
    });

    const dataUrl = canvas.toDataURL('image/png');
    let copied = false;
    if (navigator.clipboard && window.ClipboardItem) {
      try {
        const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
        if (blob) {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          copied = true;
        }
      } catch (e1) { copied = false; }
    }

    if (copied) {
      toast('账单截图已复制，直接粘到群里');
    } else {
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = '账单_' + (ST.bill.bill_date || '') + '_' + (ST.bill.raid_type || '') + '.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast('浏览器不让写剪贴板，截图已经下载了');
    }
  } catch (e) {
    console.error('[shot]', e);
    toast('生成截图失败：' + (e.message || ''), 'err');
  } finally {
    if (clone.parentNode) clone.parentNode.removeChild(clone);
    busy(btn, false);
  }
}

function statusPill(bill) {
  if (bill.status === 'pending') return '<span class="bst-pill bst-sell">待售</span>';
  const ms = bill.members || [];
  const needG = ms.filter(m => num(m.gold_final) > 0).length;
  const needR = ms.filter(m => num(m.rmb_final) > 0).length;
  const gotG = ms.filter(m => num(m.gold_final) > 0 && m.gold_paid).length;
  const gotR = ms.filter(m => num(m.rmb_final) > 0 && m.rmb_paid).length;
  if (gotG >= needG && gotR >= needR) return '<span class="bst-pill bst-done">已结清</span>';
  if (gotG === 0 && gotR === 0) return '<span class="bst-pill bst-part">未结清</span>';
  return '<span class="bst-pill bst-part">部分已结</span>';
}

function renderBillDetail(d) {
  $('bmTitle').textContent = (d.bill_date || '') + ' · ' + (d.raid_type || '未填远征类型');
  const contactStr = d.owner_contact
    ? ' · <button type="button" class="bm-contact-btn" id="bmContactBtn" title="点击复制">' +
      (d.owner_contact_type === 'kook' ? 'KOOK' : 'QQ') + ' ' + ESC(d.owner_contact) + '</button>'
    : '';
  $('bmSub').innerHTML =
    '创建人 <b>' + ESC(d.owner_name || '匿名团长') + '</b>' + certTag(d.owner_certified) + contactStr +
    ' · ' + (d.mode === 'house' ? '家务模式' : '通用模式') +
    ' · ' + (d.pay_mode === 'team' ? '团长付队长' : '一人付所有') +
    ' · 上传于 ' + ESC(shortTime(d.updated_at));

  // 状态栏
  const bar = [];
  bar.push(statusPill(d));
  bar.push('<span class="chip">' + d.member_count + ' 人 / ' + d.item_count + ' 项物品</span>');
  bar.push('<span class="chip">总额 <b>' + fmtG(d.total_gold) + '</b> 万 / <b>' + (num(d.total_rmb) ? '¥' + num(d.total_rmb).toFixed(2) : '—') + '</b></span>');
  bar.push('<span class="chip ' + ((d.unsettled_gold || 0) ? 'warn' : 'ok') + '" data-k="ug">金币未结 ' + (d.unsettled_gold || 0) + ' 人</span>');
  if (num(d.total_rmb) > 0) {
    bar.push('<span class="chip ' + ((d.unsettled_rmb || 0) ? 'warn' : 'ok') + '" data-k="ur">人民币未结 ' + (d.unsettled_rmb || 0) + ' 人</span>');
  }

  if (d.is_owner) {
    bar.push('<button type="button" class="auth-mini primary" id="bmEditBtn" style="padding:5px 13px;">编辑这张账单</button>');
    bar.push('<button type="button" class="auth-mini" id="bmDeleteBtn" style="padding:5px 13px;">删除</button>');
  }
  bar.push('<span class="bm-bar-push"></span>');
  bar.push('<button type="button" class="auth-mini bm-share-btn" id="bmShotBtn" title="把整张账单截成图片复制到剪贴板">' +
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>复制截图</button>');
  bar.push('<button type="button" class="auth-mini" id="bmLinkBtn" title="复制这张账单的链接">' +
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>复制链接</button>');
  $('bmBar').innerHTML = bar.join('');

  const editBtn = $('bmEditBtn');
  if (editBtn) editBtn.addEventListener('click', () => {
    closeBill();
    switchPane('edit');
    if (applyBill(Object.assign({ public_id: d.id, updated_at: d.updated_at, owner_name: d.owner_name }, d.payload || {}))) {
      toast('已载入编辑页，改完点「保存并上传」会覆盖原账单');
    } else {
      toast('这份账单的数据格式读不出来，无法编辑', 'err');
    }
  });

  const delBtn = $('bmDeleteBtn');
  if (delBtn) delBtn.addEventListener('click', () => showDeleteConfirm(d));

  const shotBtn = $('bmShotBtn');
  if (shotBtn) shotBtn.addEventListener('click', () => copyBillImage(shotBtn));
  const linkBtn = $('bmLinkBtn');
  if (linkBtn) linkBtn.addEventListener('click', () => {
    const url = billLink(d.id);
    copyText(url).then(() => toast('账单链接已复制'))
      .catch(() => prompt('复制这个链接：', url));
  });

  const cbtn = $('bmContactBtn');
  if (cbtn) cbtn.addEventListener('click', () => {
    const orig = cbtn.innerHTML;
    const done = () => {
      cbtn.classList.add('is-copied');
      cbtn.innerHTML = '已复制 ✓';
      setTimeout(() => {
        cbtn.classList.remove('is-copied');
        cbtn.innerHTML = orig;
      }, 1400);
      toast('联系方式已复制：' + d.owner_contact);
    };
    copyText(d.owner_contact).then(done).catch(() => prompt('联系方式：', d.owner_contact));
  });

  // 主体
  const html = [];
  html.push(renderItemsTable(d));
  html.push(renderTaxChips(d));
  html.push(renderMembersTable(d));
  html.push(renderPayModeHint(d));
  html.push('<p class="bm-hint">打勾表示「这笔钱已经给到对方」。团长可以勾所有人；队长拿着自己队的分享码，只能勾本队的人。</p>');

  $('bmBody').innerHTML = html.join('');
  if (window.hydrateIcons) hydrateIcons($('bmBody'));
  bindDetailEvents(d);
}

/* 删除：三重保险，避免手滑
 *   1) 点「删除」不会立刻删，只弹一条红色警示
 *   2) 确认按钮先灰 3 秒，读完警示才解锁
 *   3) 15 秒内不点就自动收起
 *   中间任何时候点「不删了」或再点一次「删除」都会撤销。 */
function showDeleteConfirm(d) {
  const old = $('bmDanger');
  if (old) { old.remove(); return; }

  const bar = $('bmBar');
  if (!bar) return;
  bar.insertAdjacentHTML('afterend',
    '<div class="bm-danger" id="bmDanger">' +
      '<span class="bm-danger-ico">⚠</span>' +
      '<span class="bm-danger-text">删除后 <b>队友就再也查不到这张账单</b>，也不能再打勾了。' +
      '原始数据仍留在数据库里，万一删错了可以找群主恢复。</span>' +
      '<span class="bm-danger-btns">' +
        '<button type="button" class="auth-mini" id="bmDangerCancel">不删了</button>' +
        '<button type="button" class="auth-mini danger" id="bmDangerOk" disabled>请稍候 3</button>' +
      '</span>' +
    '</div>');

  const okBtn = $('bmDangerOk');
  const cancelBtn = $('bmDangerCancel');
  if (!okBtn || !cancelBtn) return;

  let left = 3;
  const tick = setInterval(() => {
    left--;
    if (!okBtn.isConnected) { clearInterval(tick); return; }
    if (left > 0) { okBtn.textContent = '请稍候 ' + left; return; }
    clearInterval(tick);
    okBtn.disabled = false;
    okBtn.textContent = '确认删除';
    try { okBtn.focus(); } catch (e) {}
    setTimeout(() => {
      const s = $('bmDanger');
      const b = $('bmDangerOk');
      if (s && b && !b.disabled) { s.remove(); }
    }, 15000);
  }, 1000);

  cancelBtn.addEventListener('click', () => {
    clearInterval(tick);
    const s = $('bmDanger');
    if (s) s.remove();
    toast('已取消，什么都没有删');
  });

  okBtn.addEventListener('click', async () => {
    if (okBtn.disabled) return;
    clearInterval(tick);
    busy(okBtn, true, '删除中…');
    try {
      await SB.rpc('bill_delete', { p_bill_id: d.id });
      const s = $('bmDanger');
      if (s) s.remove();
      toast('已删除，队友查不到了');
      closeBill();
      loadCloud(1);
    } catch (e) {
      toast(e.message || '删除失败', 'err');
      busy(okBtn, false);
    }
  });
}

function itemTaxText(it) {
  const price = num(it.price_gold);
  const qty = num(it.qty) || 1;
  if (!price) return '—';
  const tm = it.tax_mode;
  if (tm === 'none') return '免税';
  let rate = 2;
  if (typeof getTaxRateByAmount === 'function') {
    try { rate = getTaxRateByAmount(price); } catch (e) { rate = 2; }
  }
  const tax = price * qty * rate / 100;
  if (tm === 'face') return '当面 · ' + tax.toFixed(2) + '万';
  return '金币 ' + tax.toFixed(2) + '万 (' + rate + '%)';
}

function renderItemsTable(d) {
  if (!d.items || !d.items.length) return '';
  const pills = {
    claim: '<span class="bm-pill bm-pill-claim">可领</span>',
    sell: '<span class="bm-pill bm-pill-sell">待售</span>',
    general: '<span class="bm-pill bm-pill-general">均分</span>',
    milk: '<span class="bm-pill bm-pill-milk">奶补</span>',
    free: '<span class="bm-pill bm-pill-free">摆摊</span>',
    face: '<span class="bm-pill bm-pill-face">当面</span>',
    none: '<span class="bm-pill bm-pill-none">取消</span>'
  };
  const rows = d.items.map(it => {
    const st = it.status === 'sell' ? pills.sell : pills.claim;
    const pool = it.pool === 'milk' ? pills.milk : pills.general;
    const tm = it.tax_mode === 'face' ? pills.face : (it.tax_mode === 'none' ? pills.none : pills.free);
    return '<tr class="item-row bm-item-row">' +
      '<td><span class="bm-item-name">' + ESC(it.name || '—') + '</span></td>' +
      '<td class="num">' + (num(it.qty) || 1) + '</td>' +
      '<td class="num">' + (num(it.price_gold) ? num(it.price_gold).toFixed(2) : '—') + '</td>' +
      '<td class="num">' + (num(it.price_rmb) ? num(it.price_rmb).toFixed(2) : '—') + '</td>' +
      '<td class="th-check">' + st + '</td>' +
      '<td class="th-check">' + pool + '</td>' +
      '<td class="th-check">' + tm + '</td>' +
      '<td class="th-check"><span class="bm-box"></span></td>' +
      '<td class="bm-taxline">' + ESC(itemTaxText(it)) + '</td>' +
      '</tr>';
  }).join('');

  return '<div class="bm-sec bm-items-wrap"><h4>物品（' + d.items.length + ' 项）</h4>' +
    '<div class="items-table-wrap"><table class="items-table bm-items-table">' +
    '<colgroup>' +
    '<col style="width:112px"><col style="width:42px"><col style="width:62px"><col style="width:62px">' +
    '<col style="width:60px"><col style="width:60px"><col style="width:84px"><col style="width:62px"><col style="width:140px">' +
    '</colgroup>' +
    '<thead><tr>' +
    '<th>物品</th><th class="num">数量</th><th class="num">金币（万）</th><th class="num">人民币（元）</th>' +
    '<th class="th-check">状态</th><th class="th-check">类型</th><th class="th-check">交易税</th>' +
    '<th class="th-check">单价计税</th><th>税额明细</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div></div>';
}


/* 税费汇总条（和编辑页那排 chips 一样） */
/* 支付方式说明：团长付队长时，把「队长那行为什么是税前总额」讲清楚 */
function renderPayModeHint(d) {
  if (d.pay_mode !== 'team') {
    return '<p class="bm-hint">一人付所有：团长直接按上表的金额付给每个人，中间不经过队长。</p>';
  }
  return '<p class="bm-hint"><b>团长付队长</b>：团长把<b>整队税前总额</b>一次性交给队长，' +
    '队长在面对面交易时扣掉一次交易税，再按权重分给队里的人。' +
    '所以<b>队长那一行显示的是税前队总额</b>（他要从团长手里接过的钱），' +
    '<b>队员那几行是扣税后各自到手的钱</b>。</p>';
}

function renderTaxChips(d) {
  const r = (d.payload && d.payload.result) || {};
  const nog = (v) => (v === undefined || v === null) ? '—' : (num(v) ? num(v).toFixed(2) : '—');
  const chips = [];
  chips.push('<span class="tax-chip"><span>交易税</span><span class="chip-value">' + nog(r.goldTax) + ' 万</span></span>');
  chips.push('<span class="tax-chip net"><span>净金币</span><span class="chip-value">' + nog(r.netGold) + ' 万</span></span>');
  chips.push('<span class="tax-chip net"><span>净人民币</span><span class="chip-value">' + (num(r.netRmb) ? '¥' + num(r.netRmb).toFixed(2) + ' 元' : '—') + '</span></span>');
  const fixed = (num(r.fixedGold) || num(r.fixedRmb))
    ? num(r.fixedGold).toFixed(2) + ' 万 / ' + num(r.fixedRmb).toFixed(2) + ' 元' : '—';
  chips.push('<span class="tax-chip"><span>固定支出</span><span class="chip-value">' + fixed + '</span></span>');
  chips.push('<span class="tax-chip"><span>均分池</span><span class="chip-value">' + nog(r.generalPoolGold) + ' 万</span></span>');
  chips.push('<span class="tax-chip"><span>奶补池</span><span class="chip-value">' + nog(r.milkPoolGold) + ' 万</span></span>');
  return '<div class="bm-sec bm-chips">' + chips.join('') + '</div>';
}

/* 固定工资人员 */
function renderFixedTable(d) {
  const fixed = (d.payload && Array.isArray(d.payload.fixed)) ? d.payload.fixed : [];
  const rows = fixed.filter(f => f && (f.name || num(f.gold) || num(f.rmb)));
  if (!rows.length) return '';
  return '<div class="bm-sec"><h4>固定工资人员（不参与权重）</h4>' +
    '<table class="bm-table"><thead><tr>' +
    '<th>职业</th><th>游戏角色名</th><th class="num">固定金币（万）</th><th class="num">固定人民币（元）</th><th>备注</th>' +
    '</tr></thead><tbody>' + rows.map(f => '<tr>' +
      '<td>' + ESC(f.job || '—') + '</td>' +
      '<td class="who">' + ESC(f.name || '—') + '</td>' +
      '<td class="num">' + (num(f.gold) ? num(f.gold).toFixed(2) : '—') + '</td>' +
      '<td class="num">' + (num(f.rmb) ? '¥' + num(f.rmb).toFixed(2) : '—') + '</td>' +
      '<td>' + ESC(f.note || '—') + '</td>' +
      '</tr>').join('') + '</tbody></table></div>';
}

function renderMembersTable(d) {
  if (!d.members || !d.members.length) return '';
  const hasRmb = num(d.total_rmb) > 0;
  const editAll = !!d.is_owner;

  const rows = (() => {
    const seen = new Set();
    return d.members.map(m => {
      const isHead = !seen.has(m.team);
      if (isHead) seen.add(m.team);
      const can = canEditTeam(d, m.team);
      const tags = (m.chief ? '<span class="bm-tag chief">团长</span>' : '') +
                   (m.leader ? '<span class="bm-tag leader">队长</span>' : '');
      const dis = can ? '' : ' disabled';
      const ttl = can ? '点一下就记下「已给」' : '没有这一队的权限';
      const rowCls = [isHead ? 'team-start' : '', m.chief ? 'bm-chief-row' : (m.leader ? 'bm-leader-row' : '')]
        .filter(Boolean).join(' ');
      return '<tr' + (rowCls ? ' class="' + rowCls + '"' : '') + '>' +
        '<td class="num bm-team">' + (isHead ? (m.team || 1) + ' 队' : '<span class="bm-dash">└</span>') + '</td>' +
        '<td class="who">' + ESC(m.name || '（未填名字）') + tags + '</td>' +
        '<td>' + ESC(m.job || '—') + '</td>' +
        '<td class="num">' + (num(m.weight) || 0) + '</td>' +
        bmAmountCell(d, m, 'gold') +
        '<td style="text-align:center;"><input type="checkbox" class="bm-check" data-mid="' + m.id + '" data-field="gold" title="' + ttl + '"' +
          (m.gold_paid ? ' checked' : '') + dis + '></td>' +
        (hasRmb ? bmAmountCell(d, m, 'rmb') : '<td class="num">—</td>') +
        '<td style="text-align:center;"><input type="checkbox" class="bm-check" data-mid="' + m.id + '" data-field="rmb" title="' + ttl + '"' +
          (m.rmb_paid ? ' checked' : '') + (hasRmb ? '' : ' disabled') + (can ? '' : ' disabled') + '></td>' +
        '</tr>';
    }).join('');
  })();

  // 队伍小计（分享码直接放在队伍右边，队长左边）
  // 队号来自账单里的成员，队总额按成员金额汇总 —— 不依赖 payload.result，payload 丢了也能显示
  let teamRows = '';
  const teamList = (d.teams && d.teams.length)
    ? d.teams.map(Number).filter(t => t > 0)
    : Array.from(new Set((d.members || []).map(m => Number(m.team) || 1))).sort((a, b) => a - b);

  if (teamList.length) {
    const calc = teamList.map(t => {
      const ms = (d.members || []).filter(m => (Number(m.team) || 1) === t);
      const sumG = ms.reduce((s, m) => s + num(m.gold_final), 0);
      const sumR = ms.reduce((s, m) => s + num(m.rmb_final), 0);
      // 有队汇总就用税前总额（和队长行一致），没有就退回成员汇总
      const tg = teamTotalOf(d, t, 'gold');
      const tr = teamTotalOf(d, t, 'rmb');
      const leader = ms.find(m => m.leader);
      return {
        team: t, count: ms.length,
        totalG: (tg === null ? sumG : tg),
        totalR: (tr === null ? sumR : tr),
        leader: leader ? leader.name : ''
      };
    });

    teamRows = '<div class="bm-sec bm-sec-teamsum"><h4>各队小计</h4><table class="bm-table"><thead><tr>' +
      '<th>队伍</th><th>分享码</th><th>队长</th><th class="num">人数</th><th class="num">队总额（万）</th><th class="num">人民币（元）</th>' +
      '</tr></thead><tbody>' + calc.map(t => '<tr>' +
        '<td class="who">第 ' + t.team + ' 队</td>' +
        '<td>' + teamCodeCell(d, t.team) + '</td>' +
        '<td>' + ESC(t.leader || '—') + '</td>' +
        '<td class="num">' + t.count + '</td>' +
        '<td class="num">' + fmtG(t.totalG) + '</td>' +
        '<td class="num">' + (t.totalR ? '¥' + t.totalR.toFixed(2) : '—') + '</td>' +
        '</tr>').join('') + '</tbody></table>' +
      (d.is_owner
        ? '<p class="bm-hint bm-hint-share" style="margin-top:8px;">生成后点「复制分享码」，会复制一整句话，直接发给该队队长。' +
          '他打开链接粘进查询框，就能给<b>本队</b>打勾，勾不了别的队。重新生成会让旧码立刻失效。</p>'
        : '') + '</div>';
  }

  return '<div class="bm-sec"><h4>分配表（' + d.members.length + ' 人）' +
    (editAll ? '' : '<span class="bm-hint" style="font-weight:400;margin-left:6px;">灰色勾表示你没有这一队的权限</span>') +
    '</h4><table class="bm-table"><thead><tr>' +
    '<th class="num">队</th><th>游戏角色名</th><th>职业</th><th class="num">权重</th>' +
    '<th class="num">金币（万）</th><th style="text-align:center;">已领</th>' +
    '<th class="num">人民币（元）</th><th style="text-align:center;">已领</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>' + renderFixedTable(d) + teamRows;
}

/* 某队当前手上的分享码（自己生成的，或者别人给过的） */
function codeOf(d, team) {
  const a = ST.access[d.id];
  if (!a) return '';
  if (a.codes && a.codes[team]) return a.codes[team];
  if (Number(a.team) === Number(team) && a.code) return a.code;
  return '';
}

function teamCodeCell(d, team) {
  if (!d.is_owner) {
    return '<span class="bm-hint">—</span>';
  }
  const c = codeOf(d, team);
  // 一个按钮搞定：没码就先生成再复制，有码直接复制
  return '<span class="bm-team-code">' +
    '<button type="button" class="bm-mini" data-share-team="' + team + '">复制分享码</button>' +
    (c ? '<button type="button" class="bm-mini ghost" data-issue="' + team + '" title="重新生成，旧码立刻失效">换一个</button>' : '') +
    '</span>';
}

/* 点「复制分享码」：没有就先生成，然后连文案一起复制 */
async function shareTeamToClipboard(d, team, btn) {
  let code = codeOf(d, team);
  try {
    if (!code) {
      busy(btn, true, '生成中…');
      const res = await SB.rpc('bill_issue_code', { p_bill_id: d.id, p_team: team });
      code = res.code;
      const a = ST.access[d.id] || {};
      a.codes = a.codes || {};
      a.codes[team] = code;
      if (!a.team) { a.team = team; a.code = code; }
      ST.access[d.id] = a;
      saveAccess();
    }
    const text = shareCodeText(team, code);
    try {
      await copyText(text);
      toast('已复制第 ' + team + ' 队的分享码，直接发给队长');
    } catch (e) {
      prompt('复制这段话发给第 ' + team + ' 队队长：', text);
    }
    renderBillDetail(d);   // 刷新出「换一个」按钮
  } catch (e) {
    toast(e.message || '生成分享码失败', 'err');
    busy(btn, false);
  }
}

/* 复制出去的那一整句话（队长照着粘贴就能查） */
function shareCodeText(team, code) {
  const d = ST.bill;
  const leader = ((d && d.members) || []).find(m => Number(m.team) === Number(team) && m.leader);
  const name = (leader && leader.name) || '队长';
  const url = location.origin + location.pathname + '?pane=query';
  const tag = (d && d.bill_date ? d.bill_date + ' ' : '') + (d && d.raid_type ? d.raid_type : '');
  return '【账单码】' + url + ' ' + name + '队长，这是你的队伍分享码 ' + code +
         (tag ? '（' + tag + ' · 第 ' + team + ' 队）' : '') +
         '。打开链接后，点页面左下角的「粘贴队长分享码」按钮，把整段话粘进去，就能给本队队友结账。';
}

/* 认证码那一段话 */
function certCodeText(name, code) {
  const url = location.origin + location.pathname;
  return '【认证码】' + url + ' 尊敬的' + name + '团长您好，恭喜通过认证。打开链接后，' +
         '点页面右上角的「兑换认证码」按钮，把整段话粘进去，就成为认证团长。' +
         '您的认证码：' + code + '（仅限本人使用，用一次即失效）';
}

function bindDetailEvents(d) {
  $$('.bm-check', $('bmBody')).forEach(cb => {
    cb.addEventListener('change', async () => {
      const mid = parseInt(cb.dataset.mid, 10);
      const field = cb.dataset.field;
      const want = cb.checked;
      const code = sessCodeOf(d.id);
      cb.disabled = true;
      try {
        const res = await SB.rpc('bill_set_paid', {
          p_bill_id: d.id, p_member_id: mid, p_field: field, p_value: want, p_code: code || ''
        });
        // 更新本地模型
        const m = (d.members || []).find(x => x.id === mid);
        if (m) { if (field === 'gold') m.gold_paid = res.gold_paid; else m.rmb_paid = res.rmb_paid; }
        d.unsettled_gold = res.unsettled_gold;
        d.unsettled_rmb = res.unsettled_rmb;
        // 只刷新状态栏，避免整表重绘
        const bar = $('bmBar');
        if (bar) {
          const ugEl = bar.querySelector('[data-k="ug"]');
          if (ugEl) {
            ugEl.className = 'chip ' + ((d.unsettled_gold || 0) ? 'warn' : 'ok');
            ugEl.textContent = '金币未结 ' + (d.unsettled_gold || 0) + ' 人';
          }
          const urEl = bar.querySelector('[data-k="ur"]');
          if (urEl) {
            urEl.className = 'chip ' + ((d.unsettled_rmb || 0) ? 'warn' : 'ok');
            urEl.textContent = '人民币未结 ' + (d.unsettled_rmb || 0) + ' 人';
          }
          const p = bar.querySelector('.bst-pill');
          if (p && d.status !== 'pending') {
            const ms2 = d.members || [];
            const nG = ms2.filter(x => num(x.gold_final) > 0).length;
            const nR = ms2.filter(x => num(x.rmb_final) > 0).length;
            const gG = ms2.filter(x => num(x.gold_final) > 0 && x.gold_paid).length;
            const gR = ms2.filter(x => num(x.rmb_final) > 0 && x.rmb_paid).length;
            const done = (gG >= nG && gR >= nR);
            const none = (gG === 0 && gR === 0);
            p.className = 'bst-pill ' + (done ? 'bst-done' : 'bst-part');
            p.textContent = done ? '已结清' : (none ? '未结清' : '部分已结');
          }
        }
        toast(want ? '记下了：已给' : '已取消勾选');
        loadCloud(ST.query.page || 1);
      } catch (e) {
        cb.checked = !want;
        toast(e.message || '改不动这个勾', 'err');
      } finally {
        cb.disabled = false;
      }
    });
  });

  $$('[data-issue]', $('bmBody')).forEach(btn => {
    btn.addEventListener('click', async () => {
      const team = parseInt(btn.dataset.issue, 10);
      const has = codeOf(d, team);
      if (has && !confirm('重新生成第 ' + team + ' 队的分享码？\n旧码会立刻失效，已经发出去的链接打不开了。')) return;
      try {
        busy(btn, true, '生成中…');
        const res = await SB.rpc('bill_issue_code', { p_bill_id: d.id, p_team: team });
        const a = ST.access[d.id] || {};
        a.codes = a.codes || {};
        a.codes[team] = res.code;
        if (!a.team) { a.team = team; a.code = res.code; }
        ST.access[d.id] = a;
        saveAccess();
        renderBillDetail(d);
        toast('第 ' + team + ' 队分享码已生成，点「复制分享码」发给队长');
      } catch (e) {
        toast(e.message || '生成失败', 'err');
        busy(btn, false);
      }
    });
  });

  $$('[data-share-team]', $('bmBody')).forEach(btn => {
    btn.addEventListener('click', () => shareTeamToClipboard(d, parseInt(btn.dataset.shareTeam, 10), btn));
  });
}

/* ============================================================
 * 10. 查询页（云端 / 本地文件夹 两个来源）
 * ============================================================ */
const PAGE_SIZE = 20;

let dirHandle = null;          // 当前选中的文件夹（File System Access）
let dirReady = false;          // 本次会话是否已确认过权限

/* ---------- 过滤面板 ---------- */
function currentFilters() {
  return {
    name: ($('qName') && $('qName').value || '').trim(),
    item: ($('qItem') && $('qItem').value || '').trim(),
    date_from: $('qFrom').value || '',
    date_to: $('qTo').value || '',
    raid_type: ($('qRaid').value || '').trim(),
    owner: ($('qOwner').value || '').trim(),
    only_claim: $('qOnlyClaim').checked,
    hide_settled: $('qHideSettled').checked,
    unpaid_only: $('qUnpaidOnly').checked,
    certified_only: $('qCertified') ? $('qCertified').checked : false
  };
}

function anyFilterOn() {
  const f = currentFilters();
  return !!(f.name || f.item || f.date_from || f.date_to || f.raid_type || f.owner ||
            f.only_claim || f.hide_settled || f.unpaid_only || f.certified_only);
}

function toggleFilters(force) {
  const box = $('qFilters');
  const btn = $('qFilterBtn');
  if (!box) return;
  const open = (force !== undefined) ? !!force : (box.style.display === 'none');
  box.style.display = open ? '' : 'none';
  if (btn) btn.classList.toggle('is-active', open);
}

/* ---------- 云端列表 ---------- */
async function loadCloud(page) {
  if (ST.query.loading) return;
  ST.query.loading = true;

  const box = $('qResult');
  const rbtn = $('qRefreshBtn');
  if (box && !box.children.length) box.innerHTML = '<div class="q-empty">加载中…</div>';
  busy(rbtn, true, '刷新中…');

  try {
    const f = currentFilters();
    // 填了「角色名」才按人看明细，否则一律按账单
    ST.query.view = f.name ? 'line' : 'bill';

    const p = Object.assign(f, {
      limit: PAGE_SIZE,
      offset: Math.max(0, (page - 1) * PAGE_SIZE)
    });
    const fn = ST.query.view === 'bill' ? 'bill_search' : 'bill_lines';
    const res = await SB.rpc(fn, { p: p });
    const rows = (res && res.rows) || [];

    ST.query.total = (res && res.total) || 0;
    ST.query.page = page;

    if (!rows.length) {
      box.innerHTML = '<div class="q-empty">' + (page > 1
        ? '这一页没有内容了，回上一页看看。'
        : (anyFilterOn() ? '没有符合条件的账单，换个条件或放宽日期试试。' : '云端还没有账单。'))
        + '</div>';
    } else {
      box.innerHTML = (ST.query.view === 'bill' ? rows.map(billCardHtml) : rows.map(lineCardHtml)).join('');
      bindOpenBtns(box);
    }
    renderPager(ST.query.total, page);

    const cnt = $('qCount');
    if (cnt) cnt.textContent = ST.query.total
      ? ('共 ' + ST.query.total + (ST.query.view === 'line' ? ' 人' : ' 张'))
      : '';
  } catch (e) {
    console.error('[loadCloud]', e);
    if (box) box.innerHTML = '<div class="q-empty">' + ESC(e.message || '加载失败') + '</div>';
  } finally {
    ST.query.loading = false;
    busy(rbtn, false);
  }
}

function bindOpenBtns(root) {
  $$('[data-open-bill]', root).forEach(btn => {
    if (btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => openBill(btn.dataset.openBill, { highlight: currentFilters().name }));
  });
}

function renderPager(total, page) {
  const box = $('qPager');
  if (!box) return;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (total <= PAGE_SIZE) { box.innerHTML = ''; return; }
  box.innerHTML =
    '<button type="button" class="q-page" data-page="' + (page - 1) + '"' + (page <= 1 ? ' disabled' : '') + '>上一页</button>' +
    '<span class="q-page-info">第 ' + page + ' / ' + pages + ' 页</span>' +
    '<button type="button" class="q-page" data-page="' + (page + 1) + '"' + (page >= pages ? ' disabled' : '') + '>下一页</button>';
  $$('.q-page', box).forEach(b => {
    b.addEventListener('click', () => {
      const p = parseInt(b.dataset.page, 10);
      if (p >= 1 && p <= pages) {
        loadCloud(p);
        const card = $('paneQuery');
        if (card) window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  });
}

/* ---------- 本地文件夹 ---------- */
async function pickLocalFolder() {
  if (!window.showDirectoryPicker) {
    toast('这个浏览器不支持选文件夹，请用 Chrome 或 Edge', 'err');
    return null;
  }
  try {
    const h = await window.showDirectoryPicker({ mode: 'readwrite', id: 'xsb-bill-folder' });
    dirHandle = h;
    dirReady = true;
    await Store.metaPut('dirName', h.name);
    savedDirName = h.name;
    try { await Store.metaPut('dirHandle', h); } catch (e) { /* 有些浏览器不能存 handle */ }
    renderFolderName();
    updateFolderBtn();
    return h;
  } catch (e) {
    if (e && e.name === 'AbortError') return null;
    throw e;
  }
}

function renderFolderName() {
  const el = $('qFolderName');
  if (!el) return;
  el.textContent = dirHandle ? dirHandle.name : '还没选';
}

async function ensureFolder(interactive) {
  if (dirHandle && dirReady) return dirHandle;

  if (dirHandle) {
    const perm = await dirHandle.queryPermission({ mode: 'readwrite' }).catch(() => 'prompt');
    if (perm === 'granted') { dirReady = true; renderFolderName(); return dirHandle; }
  }

  if (!dirHandle) {
    const saved = await Store.metaGet('dirHandle');
    if (saved) {
      const perm = await saved.queryPermission({ mode: 'readwrite' }).catch(() => 'prompt');
      dirHandle = saved;
      if (perm === 'granted') { dirReady = true; renderFolderName(); return dirHandle; }
    }
  }

  if (!interactive) return null;

  // 需要用户点一下授权（浏览器要求手势）
  if (dirHandle) {
    const r = await dirHandle.requestPermission({ mode: 'readwrite' }).catch(() => 'denied');
    if (r === 'granted') { dirReady = true; renderFolderName(); return dirHandle; }
  }
  return pickLocalFolder();
}

async function readLocalBills() {
  const h = await ensureFolder(false);
  if (!h) return null;

  const out = [];
  try {
    for await (const entry of h.values()) {
      if (!entry || entry.kind !== 'file') continue;
      if (!/\.json$/i.test(entry.name)) continue;
      try {
        const file = await entry.getFile();
        const txt = await file.text();
        const data = JSON.parse(txt);
        const bill = data.bill || data;
        if (!bill || typeof bill !== 'object') continue;
        out.push({
          fileName: entry.name,
          savedAt: Number(data.savedAt) || file.lastModified || 0,
          localId: data.localId || bill.public_id || '',
          cloudId: data.cloudId || bill.public_id || null,
          bill: bill
        });
      } catch (e) { /* 坏文件跳过 */ }
    }
  } catch (e) {
    console.warn('[readLocalBills]', e);
    toast('读文件夹失败：' + (e.message || e.name), 'err');
    return null;
  }

  out.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  return out;
}

async function fetchCloudVersions(ids) {
  const clean = Array.from(new Set(ids.filter(x => /^[0-9a-f-]{36}$/i.test(x || ''))));
  if (!clean.length) return {};
  try {
    const res = await SB.rpc('bill_versions', { p_ids: clean });
    return res || {};
  } catch (e) {
    console.warn('[bill_versions]', e);
    return {};
  }
}

async function loadLocal() {
  const box = $('qLocalResult');
  const rbtn = $('qLocalRefreshBtn');
  if (box) box.innerHTML = '<div class="q-empty">正在读文件夹…</div>';
  busy(rbtn, true, '读取中…');

  try {
    const list = await readLocalBills();
    if (!list) {
      if (box) {
        box.innerHTML = '<div class="q-empty">还没有选文件夹，或者还没给文件夹授权。<br>' +
          '点上面的「选择文件夹」挑一个存账单的目录；下次打开点「重新读取」会再问一次权限。</div>';
      }
      ST.local.list = [];
      return;
    }
    ST.local.list = list;
    ST.local.versions = await fetchCloudVersions(list.map(x => x.localId));
    renderLocalRows();
  } catch (e) {
    console.error('[loadLocal]', e);
    if (box) box.innerHTML = '<div class="q-empty">' + ESC(e.message || '读取失败') + '</div>';
  } finally {
    busy(rbtn, false);
  }
}

function localBillState(rec) {
  const v = ST.local.versions[rec.localId];
  if (!v) return 'green';          // 云端还没有
  const cloudTs = new Date(v).getTime();
  const localTs = Number(rec.savedAt) || 0;
  return cloudTs > localTs + 1000 ? 'cloud' : 'gray';
}

function renderLocalRows() {
  const box = $('qLocalResult');
  if (!box) return;
  const list = ST.local.list || [];
  if (!list.length) {
    box.innerHTML = '<div class="q-empty">这个文件夹里还没有账单文件（`*.json`）。<br>' +
      '在编辑页点「本地保存」就会写进来。</div>';
    return;
  }

  const f = currentFilters();
  const qName = (f.name || '').toLowerCase();
  const qItem = (f.item || '').toLowerCase();
  const rows = list.filter(rec => {
    const b = rec.bill || {};
    if (f.date_from && String(b.bill_date || '') < f.date_from) return false;
    if (f.date_to && String(b.bill_date || '') > f.date_to) return false;
    if (f.raid_type && String(b.raid_type || '').toLowerCase().indexOf(f.raid_type.toLowerCase()) < 0) return false;
    if (f.owner && String(b.owner_name || '').toLowerCase().indexOf(f.owner.toLowerCase()) < 0) return false;
    if (f.only_claim) {
      const hasSell = (b.items || []).some(i => i.status === 'sell');
      if (hasSell) return false;
    }
    if (f.hide_settled || f.unpaid_only) {
      const anyUnpaid = (b.members || []).some(m => (num(m.gold_final) > 0 && !m.gold_paid) || (num(m.rmb_final) > 0 && !m.rmb_paid));
      if (!anyUnpaid) return false;
    }
    if (qName && !(b.members || []).some(m => String(m.name || '').toLowerCase().indexOf(qName) >= 0)) return false;
    if (qItem && !(b.items || []).some(i => String(i.name || '').toLowerCase().indexOf(qItem) >= 0)) return false;
    return true;
  });

  const cnt = $('qCount');
  if (cnt) cnt.textContent = rows.length ? ('本地 ' + rows.length + ' 份') : '';

  if (!rows.length) {
    box.innerHTML = '<div class="q-empty">文件夹里没有符合当前过滤条件的账单。</div>';
    return;
  }
  box.innerHTML = rows.map(localCardHtml).join('');
  bindOpenBtns(box);

  $$('[data-local-import]', box).forEach(btn => {
    btn.addEventListener('click', () => importLocal(btn.dataset.localImport));
  });
}

function localCardHtml(rec) {
  const b = rec.bill || {};
  const state = localBillState(rec);
  const idx = (ST.local.list || []).indexOf(rec);
  const hasCloud = state !== 'green';

  let badge = '';
  const dotCls = state === 'cloud' ? 'dot-cloud' : (state === 'green' ? 'dot-green' : 'dot-gray');
  if (state === 'cloud') badge = '<span class="q-state q-state-cloud">云端有更新</span>';
  else if (state === 'green') badge = '<span class="q-state q-state-green">云端还没有</span>';
  else badge = '<span class="q-state q-state-gray">两边一致</span>';
  badge = '<span class="q-dot ' + dotCls + '"></span>' + badge;

  const anySell = (b.items || []).some(i => i.status === 'sell');
  const st = anySell ? '<span class="bst-pill bst-sell">待售</span>' : '<span class="bst-pill bst-claim">可领</span>';

  const totalG = (b.members || []).reduce((s, m) => s + num(m.gold_final), 0);
  const totalR = (b.members || []).reduce((s, m) => s + num(m.rmb_final), 0);

  return '<div class="q-bill q-bill--local">' +
    '<div class="q-bill-main">' +
      '<div class="q-bill-top">' +
        '<span class="q-bill-date">' + ESC(b.bill_date || '—') + '</span>' +
        '<span class="q-bill-raid">' + ESC(b.raid_type || '未填远征类型') + '</span>' +
        st + badge +
      '</div>' +
      '<div class="q-bill-meta">' +
        '<span>' + (b.members || []).length + ' 人</span>' +
        '<span>金币 <b>' + (totalG ? totalG.toFixed(2) : '—') + '</b></span>' +
        '<span>人民币 <b>' + (totalR ? '¥' + totalR.toFixed(2) : '—') + '</b></span>' +
        '<span>存于 ' + ESC(shortTime(rec.savedAt ? new Date(rec.savedAt).toISOString() : '')) + '</span>' +
        '<span class="q-file">' + ESC(rec.fileName) + '</span>' +
      '</div>' +
    '</div>' +
    '<div class="q-bill-right">' +
      (hasCloud ? '<button type="button" class="q-bill-open" data-open-bill="' + ESC(rec.localId) + '">看云端</button>' : '') +
      '<button type="button" class="q-bill-open" data-local-import="' + idx + '">导入编辑</button>' +
    '</div>' +
  '</div>';
}

function importLocal(idx) {
  const rec = (ST.local.list || [])[Number(idx)];
  if (!rec) return;
  const id = rec.localId || uuid();
  ST.localId = id;
  ST.cloudId = rec.cloudId || null;
  const ok = applyBill(Object.assign({ public_id: id }, rec.bill), { cloudDirty: !!rec.cloudId });
  if (!ok) { toast('这份文件的格式读不出来', 'err'); return; }
  switchPane('edit');
  toast('已从本地导入，改完点「保存并上传」');
}

/* ---------- 来源切换 / 刷新 ---------- */
function switchQSource(src) {
  ST.query.src = src === 'local' ? 'local' : 'cloud';
  $$('.q-src-btn').forEach(b => b.classList.toggle('is-active', b.dataset.src === ST.query.src));
  const cv = $('qCloudView'), lv = $('qLocalView');
  if (cv) cv.style.display = ST.query.src === 'cloud' ? '' : 'none';
  if (lv) lv.style.display = ST.query.src === 'local' ? '' : 'none';
  if (ST.query.src === 'local') {
    renderFolderName();
    const hasList = (ST.local.list || []).length > 0;
    if (hasList) renderLocalRows();
    else loadLocal();
  } else {
    loadCloud(ST.query.page || 1);
  }
}

function refreshQuery() {
  if (ST.query.src === 'local') loadLocal();
  else loadCloud(ST.query.page || 1);
}

/* ---------- 卡片渲染 ---------- */
/* 团长付队长模式下，队长那行要显示「整队税前总额」（和编辑页一致），
   队员显示扣税后各自到手的。队总额存在 payload.result.teams 里。 */
function teamTotalOf(d, team, which) {
  const teams = (d.payload && d.payload.result && Array.isArray(d.payload.result.teams))
    ? d.payload.result.teams : [];
  const t = teams.find(x => Number(x.team) === Number(team));
  if (!t) return null;
  const v = which === 'gold' ? t.totalG : t.totalR;
  if (v === undefined || v === null) return null;
  return num(v);
}

function bmAmountCell(d, m, which) {
  let val = which === 'gold' ? num(m.gold_final) : num(m.rmb_final);
  if (d.pay_mode === 'team' && m.leader) {
    const t = teamTotalOf(d, m.team, which);
    if (t !== null) val = t;
  }
  if (val <= 0.004) return '<td class="num">—</td>';
  const isTeam = d.pay_mode === 'team';
  const payFrom = isTeam ? (m.leader ? '找团长' : '找队长') : '找团长';
  const payCls = (isTeam && !m.leader) ? 'pay-member' : 'pay-leader';
  const amt = d.status === 'pending' ? '待售' : '可领';
  const tagCls = amt === '待售' ? 'tag-sell' : 'tag-claim';
  const txt = which === 'gold' ? fmtG(val) : '¥' + val.toFixed(2);
  return '<td class="num"><span class="bm-amt">' +
    '<span class="bm-amt-top"><span class="pay-from ' + payCls + '">' + payFrom + '</span>' +
    '<span class="amt-tag ' + tagCls + '">' + amt + '</span></span>' +
    '<span class="bm-amt-val">' + txt + '</span></span></td>';
}

function flashMemberRow(name) {
  const key = String(name || '').toLowerCase().trim();
  if (!key) return;
  const rows = $$('#bmBody .bm-table tbody tr');
  const hit = rows.find(tr => {
    const cell = tr.querySelector('.who');
    return cell && cell.textContent.toLowerCase().indexOf(key) >= 0;
  });
  if (!hit) return;
  hit.classList.add('bm-found');
  try { hit.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
}

function certTag(on) {
  return on ? '<span class="vtag">认证团长</span>' : '';
}

function billCardHtml(r) {
  const st = r.status === 'pending'
    ? '<span class="bst-pill bst-sell">待售</span>'
    : (r.settled ? '<span class="bst-pill bst-done">已结清</span>' : '<span class="bst-pill bst-part">未结清</span>');
  return '<div class="q-bill' + (r.owner_certified ? ' is-leader' : '') + '">' +
    '<div class="q-bill-main">' +
      '<div class="q-bill-top">' +
        '<span class="q-bill-date">' + ESC(r.bill_date) + '</span>' +
        '<span class="q-bill-raid">' + ESC(r.raid_type || '未填远征类型') + '</span>' +
        st +
      '</div>' +
      '<div class="q-bill-meta">' +
        '<span>创建人 <b>' + ESC(r.owner_name || '—') + '</b>' + certTag(r.owner_certified) + '</span>' +
        '<span>' + r.member_count + ' 人</span>' +
        '<span>金币 <b>' + fmtG(r.total_gold) + '</b> 万</span>' +
        '<span>人民币 <b>' + (num(r.total_rmb) ? '¥' + num(r.total_rmb).toFixed(2) : '—') + '</b></span>' +
        '<span>未结 ' + (r.unsettled_gold || 0) + ' / ' + (r.unsettled_rmb || 0) + '</span>' +
      '</div>' +
    '</div>' +
    '<div class="q-bill-right">' +
      '<button type="button" class="q-bill-open" data-open-bill="' + ESC(r.id) + '">查看账单</button>' +
    '</div>' +
  '</div>';
}

function lineCardHtml(r) {
  const st = r.bill_status === 'pending'
    ? '<span class="bst-pill bst-sell">待售</span>'
    : '<span class="bst-pill bst-claim">可领</span>';
  const paid = (r.gold_paid || r.rmb_paid)
    ? '<span class="bst-pill bst-done">' + (r.gold_paid && r.rmb_paid ? '已结' : '部分已结') + '</span>'
    : '';
  const tags = (r.is_chief ? '<span class="bm-tag chief">团长</span>' : '') +
               (r.is_leader ? '<span class="bm-tag leader">队长</span>' : '');
  return '<div class="q-line">' +
    '<div class="q-line-main">' +
      '<div class="q-line-top">' +
        '<span class="q-line-name">' + ESC(r.name || '（未填名字）') + '</span>' + tags +
        '<span class="q-line-sub">第 ' + (r.team_no || 1) + ' 队 · ' + ESC(r.job || '—') + '</span>' +
        paid + st +
      '</div>' +
      '<div class="q-line-sub">' +
        '<span>' + ESC(r.bill_date) + '</span>' +
        '<span>' + ESC(r.raid_type || '未填远征类型') + '</span>' +
        '<span>找 <b>' + ESC(r.payee || r.owner_name || '—') + '</b> 结' + certTag(r.owner_certified) + '</span>' +
      '</div>' +
    '</div>' +
    '<div class="q-line-amt">' +
      '<span class="g">' + (num(r.gold_final) ? num(r.gold_final).toFixed(2) + ' 万' : '—') + '</span>' +
      '<span class="r">' + (num(r.rmb_final) ? '¥' + num(r.rmb_final).toFixed(2) : '—') + '</span>' +
    '</div>' +
    '<button type="button" class="q-bill-open" data-open-bill="' + ESC(r.bill_id) + '">查看</button>' +
  '</div>';
}

/* ============================================================
 * 11. 登录 / 注册
 * ============================================================ *//* ============================================================
 * 11. 登录 / 注册
 * ============================================================ */
let authMode = 'login';

function pwCheck(pw) {
  pw = pw || '';
  const rules = {
    len: pw.length >= 10,
    upper: /[A-Z]/.test(pw),
    digit: /[0-9]/.test(pw),
    symbol: /[^A-Za-z0-9]/.test(pw)
  };
  return { ok: rules.len && rules.upper && rules.digit && rules.symbol, rules: rules };
}

function updatePwHint() {
  const pass = $('auPass');
  const bars = $('auBars');
  const hint = $('auHint');
  if (!pass) return;
  if (authMode !== 'signup') {
    if (bars) bars.style.display = 'none';
    if (hint) hint.style.display = 'none';
    return;
  }
  if (bars) bars.style.display = '';
  if (hint) hint.style.display = '';
  const r = pwCheck(pass.value).rules;
  if (bars) {
    const arr = Array.from(bars.children);
    const states = [r.len, r.upper, r.digit, r.symbol];
    arr.forEach((el, i) => el.className = states[i] ? 'ok' : '');
  }
}

function openAuth(mode) {
  authMode = mode === 'signup' ? 'signup' : 'login';
  const modal = $('authModal');
  if (!modal) return;
  $('authTitle').textContent = authMode === 'signup' ? '注册' : '登录';
  $$('.auth-mode', modal).forEach(b => b.classList.toggle('is-active', b.dataset.amode === authMode));
  $('auNick').hidden = authMode !== 'signup';
  $('auEmail2').hidden = authMode !== 'signup';
  $('auPass').setAttribute('autocomplete', authMode === 'signup' ? 'new-password' : 'current-password');
  $('auSubmit').textContent = authMode === 'signup' ? '注册' : '登录';
  $('auMsg').textContent = '';
  $('auMsg').className = 'auth-msg';
  updatePwHint();
  modal.classList.add('is-open');
  setTimeout(() => { try { $('auEmail').focus(); } catch (e) {} }, 60);
}

function closeAuth() {
  const modal = $('authModal');
  if (modal) modal.classList.remove('is-open');
}

function setAuthMode(m) {
  authMode = m === 'signup' ? 'signup' : 'login';
  openAuth(authMode);
}

function getPlayerId() {
  const K = 'xsbhxh_player_id_v1';
  let v = '';
  try { v = localStorage.getItem(K) || ''; } catch (e) {}
  if (/^[0-9a-f-]{36}$/i.test(v)) return v;
  const id = uuid();
  try { localStorage.setItem(K, id); } catch (e) {}
  return id;
}

async function submitAuth() {
  const email = ($('auEmail').value || '').trim();
  const email2 = ($('auEmail2').value || '').trim();
  const pass = $('auPass').value || '';
  const nick = ($('auNick').value || '').trim();
  const msg = $('auMsg');
  const btn = $('auSubmit');

  const fail = (m) => { msg.textContent = m; msg.className = 'auth-msg is-err'; };

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('邮箱格式不对');
  if (authMode === 'signup') {
    if (email2 !== email) return fail('两次输入的邮箱不一致');
    if (!nick) return fail('请填一个昵称，账单上会显示这个名字');
    if (Array.from(nick).length > 12) return fail('昵称最多 12 个字');
    const pc = pwCheck(pass);
    if (!pc.ok) {
      return fail('密码要至少 10 位，并且同时有大写字母、数字和符号');
    }
  } else {
    if (!pass) return fail('请输入密码');
  }

  busy(btn, true, '处理中…');
  try {
    const path = authMode === 'signup' ? '/auth/v1/signup' : '/auth/v1/token?grant_type=password';
    const data = await SB.auth(path, { email: email, password: pass });
    if (!data || !data.access_token) throw new Error('这个邮箱可能已经注册过了，切到「登录」再试');
    window.XSB_AUTH.save(data);

    if (authMode === 'signup') {
      try {
        await SB.rpc('create_profile', { p_nick: nick, p_player: getPlayerId() });
      } catch (e) {
        msg.textContent = '账号建好了，但昵称没写进去（' + (e.message || '') + '），可以稍后在账号页补';
        msg.className = 'auth-msg is-err';
      }
    }

    renderAuthBar();
    closeAuth();
    loadCertState(true).then(() => renderCertBtn());
    toast(authMode === 'signup' ? '注册成功，可以上传账单了' : '登录成功');
  } catch (e) {
    const m = e.message || '';
    if (/already registered|already been registered/i.test(m)) fail('这个邮箱已经注册过了，切到「登录」');
    else if (/Invalid login credentials/i.test(m)) fail('邮箱或密码不对');
    else if (/Password/i.test(m)) fail(m + '（如果后台开了强密码策略，请按提示改）');
    else fail(m || '操作失败');
  } finally {
    busy(btn, false);
  }
}

/* ============================================================
 * 12. 分享码入口 / URL 参数
 * ============================================================ */
/* ---------- 口令（仿淘宝）：从一整段话里抠出 8 位码 ---------- */
let clipChecked = false;

function parseShareCode(text) {
  const t = String(text || '');
  if (t.indexOf('账单码') < 0) return '';
  const m = t.match(/分享码\s*([2-9A-HJKMNP-Za-hjkmnp-z]{8})/);
  return m ? m[1].toUpperCase() : '';
}

function showCodeBanner(code) {
  if ($('codeBanner')) return;
  const el = document.createElement('div');
  el.className = 'code-banner';
  el.id = 'codeBanner';
  el.innerHTML = '<span>检测到分享码 <b>' + ESC(code) + '</b>，要打开这张账单吗？</span>' +
    '<button type="button" id="cbOpen">打开</button>' +
    '<button type="button" class="ghost" id="cbClose">忽略</button>';
  document.body.appendChild(el);
  $('cbOpen').addEventListener('click', () => { el.remove(); useCode(code); });
  $('cbClose').addEventListener('click', () => el.remove());
}

async function tryClipboardCode() {
  if (clipChecked) return;
  clipChecked = true;
  if (!navigator.clipboard || !navigator.clipboard.readText) return;
  try {
    const txt = await navigator.clipboard.readText();
    const code = parseShareCode(txt);
    if (code) showCodeBanner(code);
  } catch (e) { /* 用户没给剪贴板权限，正常 */ }
}

async function pasteFromClipboard() {
  if (!navigator.clipboard || !navigator.clipboard.readText) {
    toast('这个浏览器不支持读剪贴板，手动把整段话粘到框里', 'err');
    return;
  }
  try {
    const txt = await navigator.clipboard.readText();
    let code = parseShareCode(txt);
    if (!code) {
      const m = String(txt || '').trim().match(/^[2-9A-HJKMNP-Za-hjkmnp-z]{8}$/);
      if (m) code = m[0].toUpperCase();
    }
    if (!code) { toast('剪贴板里没找到分享码', 'err'); return; }
    const inp = $('qCodeInput');
    if (inp) inp.value = code;
    useCode(code);
  } catch (e) {
    toast('读不了剪贴板（浏览器拦了），手动粘到框里吧', 'err');
  }
}

async function useCode(raw) {
  const code = String(raw || '').trim().toUpperCase();
  if (code.length !== 8) { toast('分享码是 8 位', 'err'); return; }
  const btn = $('qCodeBtn');
  busy(btn, true, '查找…');
  try {
    const res = await SB.rpc('bill_by_code', { p_code: code });
    if (!res || !res.ok) { toast('这个分享码不对，或者已经被团长重新生成了', 'err'); return; }
    switchPane('query');
    openBill(res.id, { code: code, team: res.team });
    toast('已打开账单，你可以给第 ' + res.team + ' 队打勾了');
  } catch (e) {
    toast(e.message || '查不到这个码', 'err');
  } finally {
    busy(btn, false);
  }
}

/* ============================================================
 * 13. 页面切换
 * ============================================================ */
function switchPane(pane) {
  $$('.page-tab').forEach(b => b.classList.toggle('is-active', b.dataset.pane === pane));
  const e = $('paneEdit'), q = $('paneQuery');
  if (e) e.style.display = pane === 'edit' ? '' : 'none';
  if (q) q.style.display = pane === 'query' ? '' : 'none';
  // 切页时收掉编辑页残留的下拉浮层，免得它飘在查询页上面
  $$('.combo-panel').forEach(el => el.classList.remove('show'));
  if (pane === 'query') {
    renderAuthBar();
    if (!$('qResult').dataset.loaded) {
      $('qResult').dataset.loaded = '1';
      loadCloud(1);
    }
  }
}

/* ============================================================
 * 14. 本地保存到文件夹（File System Access）
 * ============================================================ */
function safeName(s) {
  const t = String(s || '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim();
  return t.slice(0, 40) || '账单';
}

function billFileName(bill, id) {
  const d = bill.bill_date || today();
  const raid = safeName(bill.raid_type);
  const uid8 = String(id || uuid()).replace(/[^0-9a-zA-Z]/g, '').slice(0, 8);
  return d + '_' + raid + '_' + uid8 + '.json';
}

async function exportToFolder(forcePick) {
  const bill = collectBill();
  if (!bill) { toast('还没有可导出的内容，先填物品和人员', 'err'); return; }

  let h = null;
  if (!forcePick) h = await ensureFolder(true);
  if (!h) h = await pickLocalFolder();
  if (!h) return;

  if (!ST.localId) ST.localId = uuid();
  const name = billFileName(bill, ST.localId);
  const payload = {
    schema: 1,
    localId: ST.localId,
    cloudId: ST.cloudId || null,
    savedAt: Date.now(),
    bill: Object.assign({ public_id: ST.localId }, bill)
  };

  try {
    const fh = await h.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify(payload, null, 2));
    await w.close();
    await Store.put({ localId: ST.localId, cloudId: ST.cloudId, updatedAt: Date.now(), bill: payload.bill });
    renderFolderName();
    toast('已存进「' + h.name + '」：' + name);
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    dirReady = false;
    toast('保存失败：' + (e.message || e.name || '未知错误'), 'err');
  }
}

let savedDirName = '';

function updateFolderBtn() {
  const btn = $('exportFolderBtn');
  if (!btn) return;
  const name = dirHandle ? dirHandle.name : savedDirName;
  btn.innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>' +
    (name ? '本地保存「' + ESC(name) + '」' : '选择保存文件夹');
  btn.title = name ? ('当前保存位置：' + name + '（点一下就存一份进去）') : '第一次点会让你选一个文件夹';
}

async function switchFolder() {
  dirReady = false;
  dirHandle = null;
  renderFolderName();
  const h = await pickLocalFolder().catch(e => { toast('选文件夹失败：' + (e.message || e.name), 'err'); return null; });
  if (h) {
    toast('已切换到「' + h.name + '」');
    if (ST.query.src === 'local') loadLocal();
  }
}

function initFolderExport() {
  if (!window.showDirectoryPicker) return;

  const group = $('folderGroup');
  if (group) group.style.display = '';
  const btn = $('exportFolderBtn');
  if (btn) btn.addEventListener('click', () => exportToFolder(false));
  const sw = $('switchFolderBtn');
  if (sw) sw.addEventListener('click', switchFolder);
  updateFolderBtn();

  // 恢复上次文件夹的名字（权限要用户点一下才给，这里只显示名字）
  Store.metaGet('dirName').then(n => {
    if (!n) return;
    savedDirName = n;
    updateFolderBtn();
    const el = $('qFolderName');
    if (el && !dirHandle) el.textContent = n + '（需重新授权）';
  });
}

/* ============================================================
 * 16. 认证团长
 * ============================================================ */
let certState = null;
let certListRows = [];
let certModalMode = '';   // admin 看列表 / self 走自己的流程

async function loadCertState(force) {
  if (!Auth.isOn()) { certState = null; return null; }
  if (certState && !force) return certState;
  try {
    certState = await SB.rpc('leader_my_status', {});
  } catch (e) {
    console.warn('[leader_my_status]', e);
    certState = null;
  }
  return certState;
}

function renderCertBtn() {
  const openBtn = $('certOpenBtn');
  const adminBtn = $('certAdminBtn');
  if (!openBtn) return;
  openBtn.classList.remove('is-certified');
  if (adminBtn) { adminBtn.style.display = 'none'; adminBtn.classList.remove('is-admin'); }

  if (!Auth.isOn()) { openBtn.textContent = '申请认证团长'; return; }

  const st = certState || {};
  if (st.is_admin && adminBtn) {
    adminBtn.style.display = '';
    adminBtn.classList.add('is-admin');
    adminBtn.textContent = '管理认证团长';
    adminBtn.classList.toggle('has-dot', (st.pending_count || 0) > 0);
    adminBtn.title = (st.pending_count || 0) > 0 ? ('有 ' + st.pending_count + ' 条新申请待处理') : '管理认证团长';
  }
  openBtn.classList.toggle('has-dot', !!(st.is_admin && (st.pending_count || 0) > 0));
  if (st.is_certified) {
    openBtn.classList.add('is-certified');
    openBtn.textContent = '设置团长信息';
  } else if (st.apply && st.apply.has_code) {
    openBtn.textContent = '兑换认证码';
  } else if (st.apply && st.apply.status === 'pending') {
    openBtn.textContent = '审核中…';
  } else {
    openBtn.textContent = '申请认证团长';
  }
}

function renderCertIntro(title) {
  return '<div class="cert-card">' +
    '<h4>' + ESC(title || '成为认证团长有什么不一样') + '</h4>' +
    '<ul>' +
    '<li>上传账单 <b>不限量</b>（普通登录用户每天最多 10 张）</li>' +
    '<li>账单上会带 <b>认证团长</b> 徽章，队友一眼认得是谁的账</li>' +
    '</ul></div>';
}

function openCertModal(mode) {
  const modal = $('certModal');
  if (!modal) return;
  certModalMode = (mode === 'admin') ? 'admin' : 'self';
  modal.classList.add('is-open');
  $('certTitle').textContent = '认证团长';
  $('certBody').innerHTML = '<div class="cert-empty">加载中…</div>';
  renderCertBody();
}

function closeCertModal() {
  const modal = $('certModal');
  if (modal) modal.classList.remove('is-open');
}

async function renderCertBody() {
  const body = $('certBody');
  if (!body) return;

  if (!Auth.isOn()) {
    $('certTitle').textContent = '申请认证团长';
    body.innerHTML = renderCertIntro('先登录，再申请') +
      '<p class="cert-tip">你还没登录。游客只能把账单存在本地，不能上传，也就谈不上认证。</p>' +
      '<div class="cert-actions"><button type="button" class="btn" id="certGoLogin">登录 / 注册</button></div>';
    const b = $('certGoLogin');
    if (b) b.addEventListener('click', () => { closeCertModal(); openAuth('login'); });
    return;
  }

  await loadCertState(true);
  renderCertBtn();
  renderAuthBar();

  const st = certState || {};

  // 管理员：看申请列表
  if (st.is_admin && certModalMode === 'admin') {
    $('certTitle').textContent = '管理认证团长';
    body.innerHTML = '<div class="cert-empty">正在读认证团长列表…</div>';
    setCertFooter(true);
    loadCertList();
    return;
  }

  // 已认证：设置团长信息
  if (st.is_certified) {
    $('certTitle').textContent = '设置团长信息';
    const ct = st.contact_type || 'qq';
    const cc = st.contact || '';
    body.innerHTML =
      '<div class="cert-badge-row"><span class="vtag">认证团长</span><b>' + ESC(st.nickname || '') + '</b> 已通过认证</div>' +
      '<div class="cert-field">' +
        '<label>联系方式 <em>队友靠它找你结账，会显示在账单上</em></label>' +
        '<div class="cert-contact-row">' +
          '<select id="setContactType" class="cert-select">' +
            '<option value="qq"' + (ct === 'qq' ? ' selected' : '') + '>QQ 号</option>' +
            '<option value="kook"' + (ct === 'kook' ? ' selected' : '') + '>KOOK 用户名</option>' +
          '</select>' +
          '<input type="text" id="setContact" class="cert-textarea cert-input" maxlength="60" value="' + ESC(cc) + '" placeholder="例如 420488038 或 刀个刀#1234" autocomplete="off">' +
        '</div>' +
      '</div>' +
      '<div class="cert-actions"><button type="button" class="btn" id="certSaveContact">保存</button></div>' +
      '<div class="cert-card" style="margin-top:14px;"><h4>想改昵称？</h4><p class="cert-tip" style="margin:0;">去「账号」页改，一个月能改一次。</p></div>';
    const b = $('certSaveContact');
    if (b) b.addEventListener('click', saveContact);
    return;
  }

  // 有码没兑换
  if (st.apply && st.apply.has_code) {
    $('certTitle').textContent = '兑换认证码';
    body.innerHTML =
      '<p class="cert-tip">管理员已经通过了你的申请。<br>把收到的那一整段话粘到下面，就能正式成为认证团长。</p>' +
      '<textarea id="certCodeArea" rows="4" class="cert-textarea" placeholder="【认证码】http://… 请打开链接，复制整段话粘贴进认证码框…"></textarea>' +
      '<div class="cert-actions"><button type="button" class="btn" id="certRedeemBtn">兑换</button></div>';
    const b = $('certRedeemBtn');
    if (b) b.addEventListener('click', redeemCertCode);
    return;
  }

  // 审核中
  if (st.apply && st.apply.status === 'pending') {
    $('certTitle').textContent = '审核中';
    body.innerHTML =
      '<div class="cert-card"><h4>申请已经提交</h4>' +
      '<p class="cert-tip" style="margin:0;">管理员审核后会把认证码发给你，到时候再回到这里兑换。</p></div>' +
      renderCertIntro('审核期间');
    return;
  }

  // 被拒过或没申请过：给申请表单
  $('certTitle').textContent = '申请认证团长';
  body.innerHTML = renderCertIntro() +
    (st.apply && st.apply.status === 'rejected'
      ? '<p class="cert-tip" style="color:#b91c1c;">上次的申请没通过，可以重新申请一次。</p>' : '') +
    '<div class="cert-field">' +
      '<label>联系方式 <em>必填，二选一</em></label>' +
      '<div class="cert-contact-row">' +
        '<select id="certContactType" class="cert-select">' +
          '<option value="qq">QQ 号</option>' +
          '<option value="kook">KOOK 用户名</option>' +
        '</select>' +
        '<input type="text" id="certContact" class="cert-textarea cert-input" maxlength="60" placeholder="例如 420488038 或 刀个刀#1234" autocomplete="off">' +
      '</div>' +
      '<p class="cert-tip" style="margin:6px 0 0;">账单上会显示这个联系方式，队友靠它找你结账。</p>' +
    '</div>' +
    '<textarea id="certNote" rows="3" class="cert-textarea" placeholder="备注（选填）：游戏 ID、常带的队、谁推荐的…"></textarea>' +
    '<div class="cert-actions"><button type="button" class="btn" id="certSubmitBtn">提交申请</button></div>';
  const b = $('certSubmitBtn');
  if (b) b.addEventListener('click', submitCertApply);
}

function setCertFooter(show) {
  const old = $('certFooter');
  if (old) old.remove();
  if (!show) return;
  const box = $('certModal') ? $('certModal').querySelector('.cert-box') : null;
  if (!box) return;
  const foot = document.createElement('div');
  foot.className = 'cert-foot';
  foot.id = 'certFooter';
  foot.innerHTML = '<button type="button" class="cert-mini" id="certShowApply">管理认证申请</button>';
  box.appendChild(foot);
  $('certShowApply').addEventListener('click', () => {
    $('certTitle').textContent = '管理认证申请';
    $('certBody').innerHTML = '<div class="cert-empty">正在读申请列表…</div>';
    loadApplyList();
    const f = $('certFooter');
    if (f) {
      f.innerHTML = '<button type="button" class="cert-mini" id="certBackList">返回认证团长列表</button>';
      const bb = $('certBackList');
      if (bb) bb.addEventListener('click', () => {
        $('certTitle').textContent = '管理认证团长';
        $('certBody').innerHTML = '<div class="cert-empty">正在读认证团长列表…</div>';
        setCertFooter(true);
        loadCertList();
      });
    }
  });
}

async function saveContact() {
  const btn = $('certSaveContact');
  const ctype = ($('setContactType') && $('setContactType').value) || '';
  const contact = (($('setContact') && $('setContact').value) || '').trim();
  if (!contact) { toast(ctype === 'qq' ? '请填 QQ 号' : '请填 KOOK 用户名', 'err'); return; }
  busy(btn, true, '保存中…');
  try {
    await SB.rpc('leader_set_contact', { p_type: ctype, p_contact: contact });
    toast('联系方式已保存，账单上立刻生效');
    await loadCertState(true);
    renderCertBtn();
    renderCertBody();
  } catch (e) {
    toast(e.message || '保存失败', 'err');
    busy(btn, false);
  }
}

async function loadCertList() {
  const body = $('certBody');
  if (!body) return;
  try {
    const res = await SB.rpc('leader_cert_list', {});
    const rows = (res && res.rows) || [];
    if (!rows.length) {
      body.innerHTML = '<div class="cert-empty">还没有认证团长。</div>';
      return;
    }
    body.innerHTML = '<div class="cert-list">' + rows.map(r => {
      const ct = r.contact_type === 'kook' ? 'KOOK' : (r.contact_type === 'qq' ? 'QQ' : '');
      return '<div class="cert-item">' +
        '<div class="who"><b>' + ESC(r.nickname) + '</b><span class="vtag">认证团长</span>' +
          '<span>' + ESC(r.email) + '</span>' +
          '<div class="note">' + (ct ? ct + '：<b>' + ESC(r.contact || '') + '</b>' : '还没填联系方式') +
            ' · 账单 ' + (r.bill_count || 0) + ' 张</div>' +
        '</div>' +
        '<div class="ops">' +
          '<button type="button" class="cert-danger-btn" data-revoke="' + r.user_id + '" data-nick="' + ESC(r.nickname) + '">取消认证</button>' +
        '</div>' +
      '</div>';
    }).join('') + '</div>';

    $$('[data-revoke]', body).forEach(b => {
      b.addEventListener('click', () => {
        if (b.dataset.armed === '1') {
          revokeCert(b.dataset.revoke, b.dataset.nick, b);
          return;
        }
        b.dataset.armed = '1';
        b.classList.add('armed');
        b.textContent = '再点一次取消认证';
        setTimeout(() => {
          if (!b.isConnected) return;
          b.dataset.armed = '0';
          b.classList.remove('armed');
          b.textContent = '取消认证';
        }, 5000);
      });
    });
  } catch (e) {
    body.innerHTML = '<div class="cert-empty">' + ESC(e.message || '读不到列表') + '</div>';
  }
}

async function revokeCert(userId, nick, btn) {
  busy(btn, true, '处理中…');
  try {
    await SB.rpc('leader_cert_revoke', { p_user_id: userId });
    toast('已取消 ' + nick + ' 的认证团长');
    await loadCertList();
  } catch (e) {
    toast(e.message || '操作失败', 'err');
    busy(btn, false);
  }
}

async function submitCertApply() {
  const btn = $('certSubmitBtn');
  const note = ($('certNote') && $('certNote').value) || '';
  const ctype = ($('certContactType') && $('certContactType').value) || '';
  const contact = (($('certContact') && $('certContact').value) || '').trim();

  if (!contact) {
    toast(ctype === 'qq' ? '请填 QQ 号' : '请填 KOOK 用户名', 'err');
    if ($('certContact')) $('certContact').focus();
    return;
  }
  if (ctype === 'qq' && !/^\d{5,12}$/.test(contact)) {
    toast('QQ 号应该是 5~12 位数字', 'err');
    if ($('certContact')) $('certContact').focus();
    return;
  }

  busy(btn, true, '提交中…');
  try {
    await SB.rpc('leader_apply_submit', { p_note: note, p_contact_type: ctype, p_contact: contact });
    toast('申请已提交，等管理员审核');
    closeCertModal();
    await loadCertState(true);
    renderCertBtn();
  } catch (e) {
    toast(e.message || '提交失败', 'err');
    busy(btn, false);
  }
}

async function loadApplyList() {
  const body = $('certBody');
  if (!body) return;
  try {
    const res = await SB.rpc('leader_apply_list', {});
    certListRows = (res && res.rows) || [];
    if (!certListRows.length) {
      body.innerHTML = '<div class="cert-empty">还没有人申请认证团长。</div>';
      return;
    }
    body.innerHTML = '<div class="cert-list">' + certListRows.map(r => {
      const badge = r.is_certified
        ? '<span class="vtag">已认证</span>'
        : (r.status === 'pending'
            ? '<span class="bst-pill bst-part">待审核</span>'
            : (r.status === 'approved'
                ? '<span class="bst-pill bst-done">已通过</span>'
                : '<span class="bst-pill bst-done" style="background:#fee2e2;color:#b91c1c;">已拒绝</span>'));
      return '<div class="cert-item">' +
        '<div class="who"><b>' + ESC(r.nickname) + '</b>' + badge +
          '<span>' + ESC(r.email) + '</span>' +
          (r.contact ? '<div class="note">' + (r.contact_type === 'kook' ? 'KOOK' : 'QQ') + '：<b>' + ESC(r.contact) + '</b></div>' : '') +
          (r.note ? '<div class="note">' + ESC(r.note) + '</div>' : '') +
        '</div>' +
        '<div class="ops">' +
          '<button type="button" class="cert-mini primary" data-cert-issue="' + r.user_id + '">通过并复制认证码</button>' +
          (r.status === 'pending'
            ? '<button type="button" class="cert-mini danger" data-cert-reject="' + r.user_id + '">拒绝</button>' : '') +
          '<button type="button" class="cert-mini" data-apply-del="' + r.apply_id + '" title="从列表里删掉这条旧记录">删除</button>' +
        '</div>' +
      '</div>';
    }).join('') + '</div>';

    $$('[data-cert-issue]', body).forEach(b => {
      b.addEventListener('click', () => issueCertCode(b.dataset.certIssue, b));
    });
    $$('[data-apply-del]', body).forEach(b => {
      b.addEventListener('click', async () => {
        if (!confirm('从列表里删掉这条申请记录？\n（不影响对方账号和认证状态，只是不再显示）')) return;
        try {
          await SB.rpc('leader_apply_delete', { p_id: parseInt(b.dataset.applyDel, 10) });
          toast('已删除这条记录');
          await loadApplyList();
          await loadCertState(true);
          renderCertBtn();
        } catch (e) {
          toast(e.message || '删除失败', 'err');
        }
      });
    });

    $$('[data-cert-reject]', body).forEach(b => {
      b.addEventListener('click', () => rejectCert(b.dataset.certReject, b));
    });
  } catch (e) {
    body.innerHTML = '<div class="cert-empty">' + ESC(e.message || '读不到申请列表') + '</div>';
  }
}

async function issueCertCode(userId, btn) {
  const row = certListRows.find(r => r.user_id === userId) || {};
  const name = row.nickname || '团长';
  try {
    busy(btn, true, '生成中…');
    const res = await SB.rpc('leader_cert_issue', { p_user_id: userId });
    const text = certCodeText(name, res.code);
    try {
      await copyText(text);
      toast('已复制给 ' + name + ' 的认证码');
    } catch (e) {
      prompt('复制这段话发给 ' + name + '：', text);
    }
    await loadApplyList();
  } catch (e) {
    toast(e.message || '生成失败', 'err');
    busy(btn, false);
  }
}

async function rejectCert(userId, btn) {
  if (!confirm('确定拒绝这个申请吗？对方可以重新申请。')) return;
  try {
    busy(btn, true, '处理中…');
    await SB.rpc('leader_apply_reject', { p_user_id: userId });
    toast('已拒绝');
    await loadApplyList();
  } catch (e) {
    toast(e.message || '操作失败', 'err');
    busy(btn, false);
  }
}

/* 从一大段话里挑出 8 位码（分享码 / 认证码都能认） */
function pickCode(text) {
  const t = String(text || '');
  let m = t.match(/(?:队伍分享码|分享码|认证码)[:：\s]*([2-9A-HJKMNP-Za-hjkmnp-z]{8})/);
  if (m) return m[1].toUpperCase();
  m = t.trim().match(/^[2-9A-HJKMNP-Za-hjkmnp-z]{8}$/);
  if (m) return m[0].toUpperCase();
  return '';
}

async function redeemCertCode() {
  const btn = $('certRedeemBtn');
  const raw = ($('certCodeArea') && $('certCodeArea').value) || '';
  const code = pickCode(raw);
  if (!code) { toast('没认出认证码，把整段话粘进来试试', 'err'); return; }
  busy(btn, true, '兑换中…');
  try {
    await SB.rpc('leader_cert_redeem', { p_code: code });
    toast('恭喜，你现在是认证团长');
    closeCertModal();
    await loadCertState(true);
    renderCertBtn();
    renderAuthBar();
  } catch (e) {
    toast(e.message || '兑换失败', 'err');
    busy(btn, false);
  }
}

/* ---------- 粘贴分享码窗口 ---------- */
function openPasteModal() {
  const m = $('pasteModal');
  if (!m) return;
  if ($('pasteArea')) $('pasteArea').value = '';
  m.classList.add('is-open');
  setTimeout(() => { try { $('pasteArea').focus(); } catch (e) {} }, 60);
}

function closePasteModal() {
  const m = $('pasteModal');
  if (m) m.classList.remove('is-open');
}

function confirmPaste() {
  const raw = ($('pasteArea') && $('pasteArea').value) || '';
  const code = pickCode(raw);
  if (!code) { toast('没认出分享码，把整段话粘进来试试', 'err'); return; }
  closePasteModal();
  useCode(code);
}

/* ============================================================
 * 15. 事件绑定 & 启动
 * ============================================================ */
function bindEvents() {
  // 标签页
  $$('.page-tab').forEach(b => b.addEventListener('click', () => switchPane(b.dataset.pane)));

  // 登录
  const openBtn = $('authOpenBtn');
  if (openBtn) openBtn.addEventListener('click', () => openAuth('login'));
  const outBtn = $('authOutBtn');
  if (outBtn) outBtn.addEventListener('click', () => {
    if (!confirm('退出登录？已经上传的账单不受影响。')) return;
    if (window.XSB_AUTH) XSB_AUTH.clear();
    renderAuthBar();
    toast('已退出登录');
  });
  $$('.auth-mode').forEach(b => b.addEventListener('click', () => setAuthMode(b.dataset.amode)));
  const auSubmit = $('auSubmit');
  if (auSubmit) auSubmit.addEventListener('click', submitAuth);
  const auCancel = $('auCancel');
  if (auCancel) auCancel.addEventListener('click', closeAuth);
  const auPass = $('auPass');
  if (auPass) auPass.addEventListener('input', updatePwHint);
  ['auEmail', 'auPass', 'auNick', 'auEmail2'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); submitAuth(); } });
  });

  // 保存并上传
  const saveBtn = $('saveAndUploadBtn');
  if (saveBtn) saveBtn.addEventListener('click', saveAndUpload);

  // 编辑页任何输入都标记「有改动」，顺手自动存本地
  const paneEdit = $('paneEdit');
  if (paneEdit) {
    paneEdit.addEventListener('input', (ev) => {
      const t = ev.target;
      if (!t) return;
      if (t.closest('#actionButtons')) return;
      markDirty();
    });
    paneEdit.addEventListener('change', (ev) => {
      const t = ev.target;
      if (!t) return;
      if (t.closest('#actionButtons')) return;
      markDirty();
    });
  }

  // 查询：来源切换 / 过滤 / 刷新 / 文件夹
  $$('.q-src-btn').forEach(b => b.addEventListener('click', () => switchQSource(b.dataset.src)));
  const qfBtn = $('qFilterBtn');
  if (qfBtn) qfBtn.addEventListener('click', () => toggleFilters());
  const qpBtn = $('qPasteBtn');
  if (qpBtn) qpBtn.addEventListener('click', openPasteModal);
  const pasteOk = $('pasteOk');
  if (pasteOk) pasteOk.addEventListener('click', confirmPaste);
  const pasteCancel = $('pasteCancel');
  if (pasteCancel) pasteCancel.addEventListener('click', closePasteModal);
  const pasteClose = $('pasteClose');
  if (pasteClose) pasteClose.addEventListener('click', closePasteModal);
  const certOpen = $('certOpenBtn');
  if (certOpen) certOpen.addEventListener('click', () => openCertModal('self'));
  const certAdmin = $('certAdminBtn');
  if (certAdmin) certAdmin.addEventListener('click', () => openCertModal('admin'));
  const certClose = $('certClose');
  if (certClose) certClose.addEventListener('click', closeCertModal);
  const pasteModalEl = $('pasteModal');
  if (pasteModalEl) pasteModalEl.addEventListener('click', ev => { if (ev.target === pasteModalEl) closePasteModal(); });
  const certModalEl = $('certModal');
  if (certModalEl) certModalEl.addEventListener('click', ev => { if (ev.target === certModalEl) closeCertModal(); });
  const qrBtn = $('qRefreshBtn');
  if (qrBtn) qrBtn.addEventListener('click', refreshQuery);
  const pickBtn = $('qPickFolderBtn');
  if (pickBtn) pickBtn.addEventListener('click', async () => {
    try { const h = await pickLocalFolder(); if (h) loadLocal(); }
    catch (e) { toast('选文件夹失败：' + (e.message || e.name), 'err'); }
  });
  const lrBtn = $('qLocalRefreshBtn');
  if (lrBtn) lrBtn.addEventListener('click', () => loadLocal());

  const applyFilterNow = () => {
    if (ST.query.src === 'local' && (ST.local.list || []).length) renderLocalRows();
    else if (ST.query.src === 'local') loadLocal();
    else loadCloud(1);
  };
  const sBtn = $('qSearchBtn');
  if (sBtn) sBtn.addEventListener('click', () => { loadCloud(1); });
  const rBtn = $('qResetBtn');
  if (rBtn) rBtn.addEventListener('click', () => {
    ['qName', 'qItem', 'qFrom', 'qTo', 'qRaid', 'qOwner'].forEach(id => { const el = $(id); if (el) el.value = ''; });
    if ($('qCertified')) $('qCertified').checked = false;
    $('qOnlyClaim').checked = false;
    $('qHideSettled').checked = false;
    $('qUnpaidOnly').checked = false;
    applyFilterNow();
  });
  ['qName', 'qRaid', 'qItem', 'qOwner'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); applyFilterNow(); } });
  });
  ['qFrom', 'qTo', 'qOnlyClaim', 'qHideSettled', 'qUnpaidOnly', 'qCertified'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('change', applyFilterNow);
  });
  // 填了「角色名」自动切到按人看明细，清空就回到按账单
  const qn = $('qName');
  if (qn) qn.addEventListener('input', () => {
    clearTimeout(window.__qnT);
    window.__qnT = setTimeout(() => {
      const hasName = !!(qn.value || '').trim();
      if (hasName !== (ST.query.view === 'line')) loadCloud(1);
    }, 500);
  });

  // 分享码


  // 详情弹层关闭
  const closeBtn = $('bmClose');
  if (closeBtn) closeBtn.addEventListener('click', closeBill);
  const modal = $('billModal');
  if (modal) modal.addEventListener('click', ev => { if (ev.target === modal) closeBill(); });
  document.addEventListener('keydown', ev => {
    if (ev.key !== 'Escape') return;
    const am = $('authModal');
    if (am && am.classList.contains('is-open')) { closeAuth(); return; }
    const bm = $('billModal');
    if (bm && bm.classList.contains('is-open')) closeBill();
  });

  // 登录状态变化
  if (window.XSB_AUTH) XSB_AUTH.onChange(() => {
    renderAuthBar();
    if (Auth.isOn()) loadCertState(true).then(() => { renderCertBtn(); renderAuthBar(); });
    else { certState = null; renderCertBtn(); }
  });
}

async function boot() {
  renderAuthBar();
  switchPane('query');
  bindEvents();
  initFolderExport();
  if (Auth.isOn()) {
    loadMyNick().then(() => renderAuthBar());
    loadCertState(true).then(() => { renderCertBtn(); renderAuthBar(); });
  } else {
    renderCertBtn();
  }

  // URL 参数优先处理：分享链接 / 分享码要能直接打开
  const sp = new URLSearchParams(location.search);
  const urlCode = sp.get('code');
  const urlBill = sp.get('bill');
  if (urlCode) {
    setTimeout(() => useCode(urlCode), 300);
  } else if (urlBill) {
    switchPane('query');
    setTimeout(() => openBill(urlBill), 300);
  } else if (sp.get('pane') === 'query') {
    switchPane('query');
  }

  // 再提示上有上次没清空的本地草稿
  await offerRestoreDraft();

}

async function verifyDraftAgainstCloud(rec) {
  if (!rec.cloudId) return;
  try {
    const v = await SB.rpc('bill_versions', { p_ids: [rec.cloudId] });
    const iso = v && v[rec.cloudId];
    if (!iso) return;
    const cloudTs = new Date(iso).getTime();
    const localTs = rec.updatedAt || 0;
    if (cloudTs + 1000 >= localTs) {
      // 云端反而更新，说明本地这份其实不新
      if (ST.cloudDirty) {
        ST.cloudDirty = false;
        ST.uploadedAt = iso;
        renderSaveBtn();
        renderBillState();
      }
    }
  } catch (e) { /* 网络问题就算了 */ }
}

async function offerRestoreDraft() {
  try {
    const lastId = await Store.metaGet('lastBillId');
    if (!lastId) return;
    const rec = await Store.get(lastId);
    if (!rec || !rec.bill) return;
    const b = rec.bill;
    if (!b.members || !b.members.length) return;

    ST.localId = rec.localId;
    ST.cloudId = rec.cloudId || null;
    const p = $('billState');
    if (!p) return;
    p.style.display = '';
    p.innerHTML = '<span class="chip">有上次没清空的本地草稿</span>' +
      '<button type="button" class="auth-mini" id="bsRestoreBtn" style="padding:4px 11px;">继续编辑上次的账单</button>' +
      '<button type="button" class="auth-mini" id="bsDiscardBtn" style="padding:4px 11px;">丢弃它</button>';
    const rb = $('bsRestoreBtn');
    if (rb) rb.addEventListener('click', () => {
      // 草稿保存时间晚于上次上传时间 → 云端还是旧版，需要重新上传
      const upTs = rec.uploadedAt ? new Date(rec.uploadedAt).getTime() : 0;
      const needUpload = !!rec.cloudId && (!upTs || (rec.updatedAt || 0) > upTs + 1000);
      applyBill(Object.assign({ public_id: rec.cloudId || rec.localId, updated_at: rec.uploadedAt }, b),
        { cloudDirty: needUpload });
      toast(needUpload ? '已恢复草稿 · 这份改动还没传上去' : '已恢复上次的草稿');
      if (needUpload && rec.cloudId) verifyDraftAgainstCloud(rec);
    });
    const db = $('bsDiscardBtn');
    if (db) db.addEventListener('click', async () => {
      await Store.del(rec.localId);
      ST.localId = null; ST.cloudId = null;
      renderBillState(); renderSaveBtn();
      toast('已丢弃');
    });
  } catch (e) { /* 恢复失败不影响使用 */ }
}

window.addEventListener('beforeunload', (ev) => {
  if (location.search.indexOf('noblock') >= 0) return;
  if (isWorkSafe()) return;
  ev.preventDefault();
  ev.returnValue = '';
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

// 供 index.html 内部或控制台调试用
window.BillApp = {
  collectBill, applyBill, saveAndUpload, loadCloud, loadLocal, openBill, switchPane,
  importLocal, exportToFolder, switchFolder, billFileName, shareCodeText, certCodeText, pickCode,
  isWorkSafe, loadCertState, openCertModal, openPasteModal, shareTeamToClipboard,
  loadCertList, saveContact, flashMemberRow,
  state: ST, Store,
  // 测试钩子：headless 里没法弹系统选文件夹对话框，直接注入数据测渲染
  _setLocalForTest(list, versions) {
    ST.local.list = list || [];
    ST.local.versions = versions || {};
    switchQSource('local');
    renderLocalRows();
  }
};

})();
