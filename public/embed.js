'use strict';
// Vložení AI poradce na web: <script src="https://<adresa-aplikace>/widget-assets/embed.js" defer></script>
(function () {
  var s = document.currentScript; if (!s || !s.src) return;
  var origin = new URL(s.src).origin;
  var btn = document.createElement('button');
  btn.type = 'button'; btn.textContent = 'Online poradce'; btn.setAttribute('aria-label', 'Otevřít online poradce');
  btn.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483000;padding:12px 18px;border:0;border-radius:24px;background:#9a3b1e;color:#fff;font:600 15px system-ui,sans-serif;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.3)';
  var frame = document.createElement('iframe');
  frame.title = 'Online poradce'; frame.hidden = true; frame.loading = 'lazy';
  frame.style.cssText = 'position:fixed;right:16px;bottom:70px;z-index:2147483000;width:min(380px,calc(100vw - 32px));height:min(560px,calc(100vh - 100px));border:1px solid #ccc;border-radius:12px;background:#fff;box-shadow:0 4px 24px rgba(0,0,0,.3)';
  btn.addEventListener('click', function () {
    if (frame.hidden) { if (!frame.src) frame.src = origin + '/widget'; frame.hidden = false; btn.textContent = 'Zavřít poradce'; }
    else { frame.hidden = true; btn.textContent = 'Online poradce'; }
  });
  document.body.append(frame, btn);
})();
