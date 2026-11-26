/* ===== 导航栏右上角那个登录入口 =====
 *
 * 只负责「点亮图标 / 换文字」，判断逻辑全在 assets/auth-state.js。
 * 账号页和贡品页有自己的账号栏，不引这个文件。
 *
 * 用法（放在页面底部、导航栏 DOM 之后）：
 *   <script src="../assets/auth-state.js"></script>
 *   <script src="../assets/nav-auth.js"></script>
 */
(function () {
  var A = window.XSB_AUTH;
  if (!A) return;

  function paint() {
    var a = document.querySelector('.xsb-auth, .nav-auth');
    if (!a) return;
    var t = a.querySelector('.xsb-auth-txt, .nav-auth-txt');
    var on = A.state() === 'on';
    if (t) t.textContent = on ? '已登录' : '登录';
    a.classList.toggle('is-on', on);
  }

  paint();

  // 续期成功 / 退出登录时重新画一次（save 和 clear 都会触发）
  A.onChange(paint);

  // 令牌过期时先试一次静默续期，成功了 onChange 会自动点亮
  if (A.state() === 'expired') {
    A.refresh().then(function () {}, function () {});
  }
})();
