/* ===== 全站登录状态：唯一一份判断逻辑 =====
 *
 * 这个文件只负责「读本地状态 / 判断令牌 / 续期 / 存删」，
 * 不碰任何页面的 DOM。页面长什么样，由各页面自己的脚本决定。
 *
 * 用法：
 *   XSB_AUTH.state()        'off' | 'on' | 'expired'
 *   XSB_AUTH.token()        access_token（没有就是 ''）
 *   XSB_AUTH.refreshToken() refresh_token
 *   XSB_AUTH.email()        登录邮箱（没登录就是 ''）
 *   XSB_AUTH.uid()          user id（以 token 里的 sub 为准）
 *   XSB_AUTH.expAt()        令牌过期时刻，毫秒；0 表示解不出来
 *   XSB_AUTH.tokenAlive()   令牌是否还在有效期内
 *   XSB_AUTH.refresh()      Promise<boolean>，用 refresh_token 续期
 *   XSB_AUTH.save(data)     把登录/续期接口返回的 data 写进本地
 *   XSB_AUTH.clear()        退出登录
 *   XSB_AUTH.onChange(fn)   状态变化时回调（save / refresh / clear 都会触发）
 *
 * 以前这套判断在 8 个页面里各抄了一份，只看「本地有没有邮箱」，
 * 令牌过期后仍然显示「已登录」。现在只有这里一份，改存储方式只改这里。
 */
window.XSB_AUTH = (function () {
  var K_TOKEN = 'xsbhxh_token';
  var K_REFRESH = 'xsbhxh_refresh';
  var K_EMAIL = 'xsbhxh_email';
  var K_UID = 'xsbhxh_uid';
  var K_DEVICE = 'xsbhxh_device_key';

  var LB_URL = 'https://xjyovpninpfztldqoddj.supabase.co';
  var LB_KEY = 'sb_publishable_uDRHXpUMaX9Wa2WJrqefrA_cK27Qqxl';

  var listeners = [];
  var refreshing = null;

  function get(k) {
    try { return localStorage.getItem(k) || ''; } catch (e) { return ''; }
  }
  function set(k, v) {
    try { localStorage.setItem(k, v); } catch (e) {}
  }
  function del(k) {
    try { localStorage.removeItem(k); } catch (e) {}
  }

  // 解 JWT 的 payload。解不出来返回 null（不是合法令牌就当没登录）。
  function payload(tok) {
    var part = String(tok || '').split('.')[1];
    if (!part) return null;
    try {
      var b64 = part.replace(/-/g, '+').replace(/_/g, '/');
      var pad = b64.length % 4 ? new Array(5 - (b64.length % 4)).join('=') : '';
      return JSON.parse(atob(b64 + pad)) || null;
    } catch (e) {
      return null;
    }
  }

  function token() { return get(K_TOKEN); }
  function refreshToken() { return get(K_REFRESH); }
  function email() { return get(K_EMAIL); }

  // 这台设备的密钥：第一次生成后固定不变，换浏览器才变。
  // 服务端用它证明「认领/查询的确实是这台设备」，光知道 player_id 不够。
  function deviceKey() {
    var k = get(K_DEVICE);
    if (k && /^[0-9a-f]{32}$/.test(k)) return k;
    var b = new Uint8Array(16);
    try {
      crypto.getRandomValues(b);
    } catch (e) {
      for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    }
    var s = '';
    for (var j = 0; j < 16; j++) s += ('0' + b[j].toString(16)).slice(-2);
    set(K_DEVICE, s);
    return s;
  }

  // 过期时刻（毫秒）。没有 exp 的令牌返回 0，按「不会过期」处理，和旧逻辑一致。
  function expAt() {
    var p = payload(token());
    return (p && p.exp) ? p.exp * 1000 : 0;
  }

  // 光有邮箱不够：令牌过期了它还在本地，会把「登录已过期」错显示成「已登录」。
  function tokenAlive() {
    var tok = token();
    if (!tok) return false;
    var p = payload(tok);
    if (!p) return false;
    var exp = p.exp ? p.exp * 1000 : 0;
    return !exp || exp > Date.now();
  }

  // 三种状态：未登录 / 已登录 / 登录已过期（令牌失效又续不上）
  function state() {
    if (!email()) return 'off';
    return tokenAlive() ? 'on' : 'expired';
  }

  // user id 以 token 里的 sub 为准：有时候本地 uid 丢了但 token 还在，
  // 这时候提交会把成绩记成匿名，排行榜上裂成两条。
  function uid() {
    var p = payload(token());
    var fromTok = (p && p.sub) || '';
    if (fromTok) {
      if (fromTok !== get(K_UID)) set(K_UID, fromTok);
      return fromTok;
    }
    return get(K_UID);
  }

  function notify() {
    var st = state();
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](st); } catch (e) {}
    }
  }

  function onChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
  }

  // 登录 / 续期接口返回的数据写进本地
  function save(data) {
    if (!data) return;
    if (data.access_token) set(K_TOKEN, data.access_token);
    if (data.refresh_token) set(K_REFRESH, data.refresh_token);
    var u = data.user || {};
    if (u.id) set(K_UID, u.id);
    if (u.email) set(K_EMAIL, u.email);
    notify();
  }

  function clear() {
    del(K_TOKEN);
    del(K_REFRESH);
    del(K_EMAIL);
    del(K_UID);
    notify();
  }

  // 只扔掉令牌、保留邮箱：界面会变成「登录已过期」，玩家还知道该重新登一次。
  // 用在「续期也续不上、只能先以匿名身份用」的场景。
  function dropToken() {
    del(K_TOKEN);
    del(K_REFRESH);
    notify();
  }

  // 用 refresh_token 换一个新的 access_token。
  // 令牌 1 小时就过期，不续期玩家会被静默踢下线；同一时刻只发一个请求，
  // 免得几个模块同时续期、把一次性轮换的 refresh_token 用废。
  function refresh() {
    if (refreshing) return refreshing;
    var rt = refreshToken();
    if (!rt) return Promise.resolve(false);

    refreshing = fetch(LB_URL + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: { 'apikey': LB_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: rt })
    }).then(function (res) {
      if (!res.ok) return false;
      return res.json().then(function (data) {
        if (!data || !data.access_token) return false;
        save(data);
        return true;
      }, function () { return false; });
    }).then(function (ok) {
      refreshing = null;
      return ok;
    }, function () {
      refreshing = null;
      return false;
    });

    return refreshing;
  }

  return {
    token: token,
    refreshToken: refreshToken,
    email: email,
    uid: uid,
    deviceKey: deviceKey,
    expAt: expAt,
    tokenAlive: tokenAlive,
    state: state,
    refresh: refresh,
    save: save,
    clear: clear,
    dropToken: dropToken,
    onChange: onChange,
    LB_URL: LB_URL,
    LB_KEY: LB_KEY,
    K_TOKEN: K_TOKEN,
    K_REFRESH: K_REFRESH,
    K_EMAIL: K_EMAIL,
    K_UID: K_UID,
    K_DEVICE: K_DEVICE
  };
})();
