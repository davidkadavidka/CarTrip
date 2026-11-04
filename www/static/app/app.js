/* יומן נסיעות - אפליקציית הנהג
   אותו קוד רץ בשני מקומות:
   1. בדפדפן, בכתובת /app (למשל באייפון, כאייקון במסך הבית)
   2. בתוך אפליקציית האנדרואיד (Capacitor) - עם סורק QR חי ועבודה בלי קליטה
   כשאין חיבור לשרת, פעולות נשמרות בטלפון ונשלחות לבד כשהחיבור חוזר. */
(function () {
  'use strict';

  var NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  var DEFAULT_SERVER = 'http://10.8.0.106:8090';
  var APP_VERSION = '1.0';
  var app = document.getElementById('app');

  // ------------------------------------------------------------------ אחסון מקומי
  function store(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
    } catch (e) { return null; }
  }
  function loadJSON(k, d) { try { var v = store(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function saveJSON(k, v) { store(k, JSON.stringify(v)); }

  var H = loadJSON('tl_home', null);          // מטמון: רכבים, עובדים ומצב (לעבודה בלי קליטה)
  var Q = loadJSON('tl_queue', []);           // פעולות שממתינות לשליחה
  var TRIPMAP = loadJSON('tl_tripmap', {});   // מזהה מקומי -> מזהה נסיעה בשרת
  var ONLINE = null, SYNCING = null, APK_AVAILABLE = false;
  var endForm = null;

  function saveQ() { saveJSON('tl_queue', Q); }

  // ------------------------------------------------------------------ עזר
  function $(id) { return document.getElementById(id); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function today() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function nowTime() { var d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function nowStamp() { return today() + ' ' + nowTime(); }
  function fmtDate(s) { if (!s) return ''; var p = s.split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
  function fmtKm(n) { return (n === null || n === undefined || n === '') ? '' : Number(n).toLocaleString('he-IL'); }
  function parseKm(v) { v = String(v || '').replace(/[,\s]/g, ''); return /^\d+$/.test(v) ? parseInt(v, 10) : NaN; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function hoursSince(d, t) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || ''), n = /^(\d{2}):(\d{2})$/.exec(t || '');
    if (!m || !n) return 0;
    var start = new Date(+m[1], +m[2] - 1, +m[3], +n[1], +n[2]);
    return Math.max(0, (Date.now() - start.getTime()) / 3600000);
  }
  function fmtDur(h) {
    h = Number(h) || 0;
    if (h < 1) return 'פחות משעה';
    if (h < 2) return 'שעה';
    if (h < 48) return Math.floor(h) + ' שעות';
    var d = Math.floor(h / 24); return d === 2 ? 'יומיים' : d + ' ימים';
  }
  function overdueLimit() { return (H && H.overdue_hours) || 8; }
  function waNum(p) {
    p = String(p || '').replace(/[^\d+]/g, '');
    if (!p) return '';
    if (p.charAt(0) === '+') p = p.slice(1); else if (p.charAt(0) === '0') p = '972' + p.slice(1);
    return p;
  }
  function waLink(phone, text) { var n = waNum(phone); return n ? 'https://wa.me/' + n + '?text=' + encodeURIComponent(text) : ''; }
  function showError(id, msg) { var b = $(id); if (b) { b.textContent = msg; b.hidden = false; b.scrollIntoView({ block: 'center', behavior: 'smooth' }); } }
  function clearError(id) { var b = $(id); if (b) b.hidden = true; }
  function busy(btn, on, label) { btn.disabled = on; if (on) { btn.dataset.l = btn.textContent; btn.textContent = label || 'שומר…'; } else if (btn.dataset.l) btn.textContent = btn.dataset.l; }
  function toast(msg) {
    var t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, 3000);
  }
  function uid() { return 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  // ------------------------------------------------------------------ תקשורת עם השרת
  function server() { return NATIVE ? (store('tl_server') || DEFAULT_SERVER).replace(/\/$/, '') : ''; }

  function api(path, body, timeout) {
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, timeout || 9000);
    var opt = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
    if (ctl) opt.signal = ctl.signal;
    return fetch(server() + path, opt).then(function (r) {
      clearTimeout(timer);
      setOnline(true);
      return r.json().catch(function () { return { error: 'תשובה לא תקינה מהשרת' }; }).then(function (d) {
        if (!r.ok) { var e = new Error(d.error || 'שגיאה'); e.status = r.status; e.data = d; throw e; }
        return d;
      });
    }, function () {
      clearTimeout(timer);
      setOnline(false);
      var e = new Error('אין חיבור לשרת'); e.offline = true; throw e;
    });
  }

  function setOnline(v) {
    ONLINE = v;
    var c = $('conn');
    c.hidden = false;
    c.className = 'conn ' + (v ? 'on' : 'off');
    c.textContent = v ? '● מחובר' : '● אין חיבור - עובדים מהטלפון';
  }

  // ------------------------------------------------------------------ מצב משוקלל: מטמון + פעולות שממתינות
  function me() {
    var id = parseInt(store('tl_driver') || '', 10);
    if (!id || !H) return null;
    for (var i = 0; i < H.employees.length; i++) if (H.employees[i].id === id) return H.employees[i];
    return null;
  }

  function effectiveCars() {
    if (!H) return [];
    var cars = H.cars.map(function (c) { return Object.assign({}, c, { open_trip: c.open_trip ? Object.assign({}, c.open_trip) : null }); });
    var byCode = {}; cars.forEach(function (c) { byCode[c.code] = c; });
    Q.forEach(function (q) {
      if (q.status === 'failed') return;
      var c = byCode[q.car_code]; if (!c) return;
      if (q.type === 'start') {
        c.open_trip = { local: true, start_qid: q.qid, driver_id: q.body.driver_id, driver_name: q.driver_name,
          trip_date: q.body.trip_date, start_time: q.body.start_time, start_km: q.body.start_km, pending: true };
      } else if (q.type === 'end') {
        c.open_trip = null; c.last_km = q.body.end_km;
      }
    });
    cars.forEach(function (c) { if (c.open_trip) c.open_trip.hours_open = hoursSince(c.open_trip.trip_date, c.open_trip.start_time); });
    return cars;
  }
  function findCar(code) { var cs = effectiveCars(); for (var i = 0; i < cs.length; i++) if (cs[i].code === code) return cs[i]; return null; }
  function myOpenTrip() {
    var m = me(); if (!m) return null;
    var cs = effectiveCars();
    for (var i = 0; i < cs.length; i++) if (cs[i].open_trip && cs[i].open_trip.driver_id === m.id) return { car: cs[i], trip: cs[i].open_trip };
    return null;
  }

  function refreshHome() {
    var m = parseInt(store('tl_driver') || '', 10) || '';
    return api('/api/app/home?driver=' + m).then(function (d) {
      d.saved_at = nowStamp();
      H = d; saveJSON('tl_home', H);
      return H;
    });
  }

  // ------------------------------------------------------------------ סנכרון התור לשרת
  function sync() {
    if (SYNCING) return SYNCING;
    var pending = Q.filter(function (q) { return q.status !== 'failed'; });
    if (!pending.length) return Promise.resolve(false);
    var res = { sent: 0, failed: 0 };
    SYNCING = (function next() {
      var q = Q.filter(function (x) { return x.status !== 'failed'; })[0];
      if (!q) return Promise.resolve(res);
      var p;
      if (q.type === 'start') {
        p = api('/api/car/' + encodeURIComponent(q.car_code) + '/start', q.body).then(function (r) {
          TRIPMAP[q.qid] = r.trip.id; saveJSON('tl_tripmap', TRIPMAP);
        });
      } else {
        var id = q.trip_id || TRIPMAP[q.start_qid];
        if (!id) {
          var e = new Error('פתיחת הנסיעה לא נקלטה בשרת, ולכן גם הסגירה לא נשלחה'); e.status = 409;
          p = Promise.reject(e);
        } else {
          p = api('/api/car/' + encodeURIComponent(q.car_code) + '/trip/' + id + '/end', q.body);
        }
      }
      return p.then(function () {
        Q = Q.filter(function (x) { return x.qid !== q.qid; }); saveQ(); res.sent++;
        return next();
      }, function (e) {
        if (e.offline) throw e;
        q.status = 'failed'; q.error = String(e.message || '').replace(/\s*רענן\/י את הדף\.?/, ''); saveQ(); res.failed++;
        return next();
      });
    })().then(function () {
      SYNCING = null;
      if (res.sent) toast('הפעולות ששמרת נשלחו לשרת ✓');
      if (res.failed) toast('פעולה שמורה לא נקלטה בשרת - פרטים במסך הראשי');
      var changed = res.sent + res.failed > 0;
      return refreshHome().then(function () { return changed; }, function () { return changed; });
    }, function () { SYNCING = null; return res.sent + res.failed > 0; });
    return SYNCING;
  }

  function enqueue(item) {
    item.qid = uid(); item.created = nowStamp(); item.status = 'pending';
    Q.push(item); saveQ();
    return item;
  }

  // ------------------------------------------------------------------ ניווט
  function route() {
    var h = location.hash || '';
    var m = /^#car=([A-Za-z0-9]+)/.exec(h);
    if (m) return carView(m[1]);
    if (h === '#settings') return settingsView();
    homeView();
  }
  window.addEventListener('hashchange', function () { endForm = null; route(); });
  function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }

  function setHeader(car) {
    $('org').textContent = H && H.org_name ? H.org_name : 'יומן נסיעות';
    if (car) {
      $('title').hidden = true; $('plate').hidden = false;
      $('plate').textContent = car.plate; $('desc').textContent = car.description || '';
    } else {
      $('title').hidden = false; $('plate').hidden = true; $('desc').textContent = '';
    }
  }

  // ------------------------------------------------------------------ זיהוי נהג
  function renderWho(next) {
    var list = H ? H.employees : [];
    setHeader(null);
    app.innerHTML =
      '<section class="card"><h2>מי את/ה?</h2>' +
      '<p class="hint" style="margin:-6px 0 14px">בוחרים פעם אחת - הטלפון יזכור אותך.</p>' +
      (list.length > 8 ? '<label class="field"><input id="q" placeholder="חיפוש שם…" autocomplete="off"></label>' : '') +
      '<div id="names" class="chips" style="flex-direction:column;align-items:stretch"></div>' +
      (list.length ? '' : '<div class="warn-box">עדיין לא הוגדרו עובדים במערכת. פנה/י למנהל הרכבים.</div>') +
      '</section>';
    function draw(f) {
      f = (f || '').trim();
      $('names').innerHTML = list.filter(function (e) { return !f || e.name.indexOf(f) >= 0; }).map(function (e) {
        return '<button class="chip" style="text-align:right;padding:13px 16px;font-size:1.05rem;border-radius:12px" data-id="' + e.id + '">' + esc(e.name) + '</button>';
      }).join('') || '<p class="hint">לא נמצא שם תואם</p>';
    }
    draw('');
    if ($('q')) $('q').oninput = function () { draw(this.value); };
    $('names').onclick = function (ev) {
      var b = ev.target.closest('[data-id]'); if (!b) return;
      store('tl_driver', b.dataset.id);
      next();
    };
  }
  function whoBar() {
    var d = me();
    return '<div class="who"><div><div class="lbl">נהג/ת</div><div class="name">' + esc(d ? d.name : '') + '</div></div>' +
      '<button class="btn ghost small" id="switchWho">לא את/ה? החלף</button></div>';
  }
  function bindWho(next) { var b = $('switchWho'); if (b) b.onclick = function () { renderWho(next || route); }; }

  // ------------------------------------------------------------------ מסך הבית
  function homeView() {
    setHeader(null);
    if (!H) {
      app.innerHTML = '<div class="card center-msg"><div class="spinner"></div>מתחבר לשרת…</div>';
      refreshHome().then(homeView, function (e) {
        app.innerHTML = '<section class="card center-msg"><p style="font-size:1.05rem;color:var(--bad);font-weight:700">' +
          (e.offline ? 'אין חיבור לשרת. בפעם הראשונה צריך להיות מחובר ל-WiFi של המשרד.' : esc(e.message)) + '</p>' +
          '<button class="btn primary" id="retry">נסה/י שוב</button>' +
          (NATIVE ? '<p class="foot-line"><a href="#settings">הגדרות חיבור</a></p>' : '') + '</section>';
        $('retry').onclick = homeView;
      });
      return;
    }
    if (!me()) return renderWho(homeView);
    var mine = myOpenTrip();
    var cars = effectiveCars();
    var failed = Q.filter(function (q) { return q.status === 'failed'; });
    var waiting = Q.length - failed.length;
    var m = me();

    var html = installTip() + whoBar();
    if (mine) {
      var late = mine.trip.hours_open >= overdueLimit();
      html += '<section class="card mine-card' + (late ? ' active-trip late' : '') + '">' +
        '<div class="status-line" style="margin-bottom:8px"><span class="badge ' + (late ? 'late' : 'open') + '">יש לך נסיעה פתוחה</span>' +
        (mine.trip.pending ? ' <span class="badge cancelled" style="text-decoration:none">שמורה בטלפון</span>' : '') + '</div>' +
        '<div style="font-size:1.05rem">רכב <b class="num">' + esc(mine.car.plate) + '</b> · מ-' + fmtDate(mine.trip.trip_date) + ' ' + esc(mine.trip.start_time) +
        ' (' + fmtDur(mine.trip.hours_open) + ')</div>' +
        '<a class="btn primary big" style="margin-top:12px" href="#car=' + esc(mine.car.code) + '">לסגירת הנסיעה</a></section>';
    }
    html += '<button class="btn go big scan-btn" id="scanBtn">סריקת קוד הרכב<small>' +
      (canLiveScan() ? 'כוונו את המצלמה לקוד שברכב' : 'צלמו את קוד ה-QR שברכב') + '</small></button>';

    if (Q.length) {
      html += '<section class="card queue-card" style="margin-top:14px"><h2 style="font-size:1.05rem;margin-bottom:6px">שמור בטלפון</h2>' +
        (waiting ? '<p class="hint" style="margin:0 0 6px">' + waiting + (waiting === 1 ? ' פעולה ממתינה' : ' פעולות ממתינות') + ' לשליחה. היא תישלח לבד כשיהיה חיבור לשרת.</p>' : '') +
        Q.map(function (q) {
          return '<div class="queue-item"><div class="what"><b>' + (q.type === 'start' ? 'פתיחת נסיעה' : 'סגירת נסיעה') + '</b> · רכב <span class="num">' + esc(q.plate) + '</span>' +
            ' · ' + esc(q.created.slice(11)) +
            (q.status === 'failed' ? '<div class="err">לא נקלט: ' + esc(q.error) + '</div>' : '') + '</div>' +
            (q.status === 'failed' ? '<button class="btn small danger" data-dropq="' + q.qid + '">הסרה</button>' : '<span class="badge open">ממתין</span>') + '</div>';
        }).join('') +
        (waiting ? '<button class="btn small" id="syncNow" style="margin-top:8px">שליחה עכשיו</button>' : '') +
        '</section>';
    }

    html += '<section class="card car-list" style="margin-top:14px"><h2 style="font-size:1.05rem;margin-bottom:4px">רכבים</h2>' +
      (cars.length ? cars.map(function (c) {
        var o = c.open_trip, st;
        if (!o) st = '<span class="badge closed">פנוי</span>';
        else if (o.driver_id === m.id) st = '<span class="badge open">שלך</span>';
        else st = '<span class="badge ' + (o.hours_open >= overdueLimit() ? 'late' : 'open') + '">' + esc(o.driver_name) + '</span>';
        return '<a class="car-item" href="#car=' + esc(c.code) + '"><span class="p">' + esc(c.plate) + '</span><span class="d">' + esc(c.description || '') + '</span>' + st + '<span class="chev">‹</span></a>';
      }).join('') : '<p class="hint">אין רכבים במערכת</p>') + '</section>';

    html += '<p class="foot-line">' + (H.saved_at ? 'מעודכן ל-' + esc(H.saved_at.slice(11, 16)) + ' · ' : '') +
      '<a href="#" id="refresh">רענון</a>' + (NATIVE ? ' · <a href="#settings">הגדרות</a>' : '') + '</p>';
    app.innerHTML = html;

    bindWho(homeView);
    $('scanBtn').onclick = scan;
    if ($('syncNow')) $('syncNow').onclick = function () { this.disabled = true; sync().then(homeView); };
    app.querySelectorAll('[data-dropq]').forEach(function (b) {
      b.onclick = function () {
        if (!confirm('להסיר את הפעולה הזו מהטלפון? היא לא תישלח לשרת.')) return;
        var qid = b.dataset.dropq;
        Q = Q.filter(function (x) { return x.qid !== qid && x.start_qid !== qid; }); saveQ(); homeView();
      };
    });
    $('refresh').onclick = function (e) { e.preventDefault(); sync().then(function () { return refreshHome(); }).then(homeView, homeView); };
    var tipX = $('tipX'); if (tipX) tipX.onclick = function () { store('tl_tip_closed', '1'); $('tip').remove(); };
  }

  function installTip() {
    if (NATIVE || store('tl_tip_closed')) return '';
    var standalone = window.navigator.standalone || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    if (standalone) return '';
    var ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    var android = /Android/.test(navigator.userAgent);
    if (!ios && !android) return '';
    if (android && APK_AVAILABLE) {
      return '<div class="install-tip" id="tip"><button class="x" id="tipX">✕</button><b>יש אפליקציה לאנדרואיד!</b> עם סורק מובנה ועבודה גם בלי קליטה בחניה.' +
        '<a class="btn primary" style="display:flex;margin-top:10px" href="/static/download/TripLog.apk" download>הורדה והתקנה</a></div>';
    }
    return '<div class="install-tip" id="tip"><button class="x" id="tipX">✕</button><b>טיפ:</b> אפשר לשים את יומן הנסיעות כאייקון במסך הבית - ' +
      (ios ? 'לוחצים על כפתור השיתוף <b>⬆</b> בתחתית ספארי, ואז <b>"הוספה למסך הבית"</b>.' : 'לוחצים על <b>⋮</b> בכרום, ואז <b>"הוספה למסך הבית"</b>.') + '</div>';
  }

  // ------------------------------------------------------------------ מסך רכב
  function carView(code) {
    var m = me();
    if (!H) { refreshHome().then(function () { carView(code); }, function () { homeView(); }); return; }
    if (!m) return renderWho(function () { carView(code); });
    var cached = findCar(code);
    setHeader(cached || { plate: '…' });
    app.innerHTML = '<div class="card center-msg"><div class="spinner"></div>טוען…</div>';
    var hasPending = Q.some(function (q) { return q.car_code === code && q.status !== 'failed'; });
    (hasPending ? sync() : Promise.resolve()).then(function () {
      return api('/api/car/' + encodeURIComponent(code) + '?driver=' + m.id);
    }).then(function (d) {
      // עדכון המטמון לפי המידע הטרי מהשרת
      var c = H.cars.filter(function (x) { return x.code === code; })[0];
      if (c) { c.open_trip = d.open_trip; c.last_km = d.last_km; c.plate = d.car.plate; c.description = d.car.description; saveJSON('tl_home', H); }
      d.offline = false;
      decide(code, d);
    }, function (e) {
      if (!e.offline) {
        setHeader(null);
        app.innerHTML = '<section class="card center-msg"><p style="color:var(--bad);font-weight:700">' + esc(e.message) + '</p><a class="btn primary" href="#">חזרה</a></section>';
        return;
      }
      var car = findCar(code);
      if (!car) {
        setHeader(null);
        app.innerHTML = '<section class="card center-msg"><p style="font-weight:700">אין חיבור לשרת, והרכב הזה עדיין לא שמור בטלפון.</p><p class="hint">התחברו ל-WiFi של המשרד ונסו שוב.</p><a class="btn primary" href="#">חזרה</a></section>';
        return;
      }
      var mo = myOpenTrip();
      decide(code, {
        offline: true, car: { code: car.code, plate: car.plate, description: car.description },
        open_trip: car.open_trip, last_km: car.last_km, employees: H.employees,
        driver_open_trip: mo && mo.car.code !== code ? { plate: mo.car.plate, code: mo.car.code, trip_date: mo.trip.trip_date, start_time: mo.trip.start_time, start_km: mo.trip.start_km, hours_open: mo.trip.hours_open } : null,
        overdue_hours: overdueLimit()
      });
    });
  }

  function decide(code, D) {
    var m = me();
    setHeader(D.car);
    if (D.open_trip && D.open_trip.hours_open == null) D.open_trip.hours_open = hoursSince(D.open_trip.trip_date, D.open_trip.start_time);
    if (D.open_trip) {
      if (D.open_trip.driver_id === m.id) renderEnd(code, D); else renderCarBusy(code, D);
    } else if (D.driver_open_trip) renderDriverBusy(code, D);
    else renderStart(code, D);
  }

  function offlineNote(D) {
    return D.offline ? '<div class="offline-note">אין חיבור לשרת. אפשר להמשיך כרגיל - הפרטים יישמרו בטלפון וישלחו לבד כשיחזור החיבור' +
      (H && H.saved_at ? ' (מידע הרכבים מעודכן ל-' + esc(fmtDate(H.saved_at.slice(0, 10))) + ' ' + esc(H.saved_at.slice(11, 16)) + ')' : '') + '.</div>' : '';
  }
  function backLink() { return '<a class="back-link" href="#">→ לכל הרכבים</a>'; }

  // ---------- פתיחת נסיעה
  function renderStart(code, D) {
    var last = D.last_km;
    app.innerHTML = backLink() + offlineNote(D) +
      '<section class="card">' +
      '<div class="steps"><i class="on"></i><i></i><i></i></div>' +
      '<h2>פתיחת נסיעה</h2>' + whoBar() +
      '<div class="row2">' +
      '<label class="field"><span>תאריך</span><input type="date" id="date" value="' + today() + '"></label>' +
      '<label class="field"><span>שעת יציאה</span><input type="time" id="time" value="' + nowTime() + '"></label>' +
      '</div>' +
      '<label class="field"><span>מד קילומטראז\' ביציאה</span>' +
      '<input id="km" inputmode="numeric" pattern="[0-9]*" autocomplete="off" placeholder="המספר שמופיע בלוח המחוונים">' +
      (last != null ? '<p class="hint">בסיום הנסיעה הקודמת נרשם: <b class="num">' + fmtKm(last) + '</b> ק"מ</p>' : '') +
      '</label>' +
      '<div class="err-box" id="err" hidden></div>' +
      '<button class="btn go big" id="go">פתיחת נסיעה</button>' +
      '</section>';
    bindWho(function () { carView(code); });
    $('go').onclick = function () {
      clearError('err');
      var km = parseKm($('km').value);
      if (!$('date').value) return showError('err', 'יש לבחור תאריך');
      if (!$('time').value) return showError('err', 'יש להזין שעת יציאה');
      if (isNaN(km)) return showError('err', 'יש להזין את מד הקילומטראז\' (מספרים בלבד)');
      if (last != null && km < last &&
        !confirm('המספר שהזנת (' + fmtKm(km) + ') נמוך מהקילומטראז\' שנרשם בסוף הנסיעה הקודמת (' + fmtKm(last) + ').\nהאם המספר נכון?')) return;
      if (last != null && km - last > 50 &&
        !confirm('יש פער של ' + fmtKm(km - last) + ' ק"מ מסוף הנסיעה הקודמת.\nהאם המספר נכון?')) return;
      var body = { driver_id: me().id, trip_date: $('date').value, start_time: $('time').value, start_km: km };
      var btn = this;
      function saveLocal() {
        enqueue({ type: 'start', car_code: code, plate: D.car.plate, driver_name: me().name, body: body });
        renderDone('הנסיעה נפתחה', 'הפרטים נשמרו בטלפון ויישלחו לשרת לבד כשיחזור החיבור.', true,
          'בסיום הנסיעה פתחו שוב את האפליקציה (או סרקו את הקוד) כדי לסגור אותה.');
      }
      if (D.offline) return saveLocal();
      busy(btn, true, 'פותח נסיעה…');
      api('/api/car/' + encodeURIComponent(code) + '/start', body).then(function (r) {
        var c = H.cars.filter(function (x) { return x.code === code; })[0];
        if (c) { c.open_trip = r.trip; saveJSON('tl_home', H); }
        renderDone('הנסיעה נפתחה', me().name + ' · ' + fmtDate(r.trip.trip_date) + ' · ' + r.trip.start_time + ' · ק"מ ' + fmtKm(r.trip.start_km), false,
          'בסיום הנסיעה סרקו שוב את הקוד, או פתחו את האפליקציה ולחצו "לסגירת הנסיעה".');
        refreshHome().catch(function () {});
      }, function (e) {
        busy(btn, false);
        if (e.offline) return saveLocal();
        showError('err', e.message); if (e.status === 409) setTimeout(function () { carView(code); }, 2500);
      });
    };
  }

  function renderDone(title, line, pending, help) {
    app.innerHTML = '<section class="card done"><div class="tick">✓</div><h2>' + esc(title) + '</h2>' +
      '<p>' + esc(line) + '</p>' +
      (pending ? '<div class="warn-box" style="margin-top:14px">אין חיבור כרגע - ' + esc('הפרטים שמורים בטלפון ויישלחו אוטומטית.') + '</div>' : '') +
      (help ? '<div class="ok-box" style="margin-top:14px">' + esc(help) + '</div>' : '') +
      '<a class="btn primary big" style="margin-top:16px" href="#">למסך הראשי</a></section>';
  }

  // ---------- הרכב תפוס ע"י נהג אחר
  function renderCarBusy(code, D) {
    var t = D.open_trip, m = me();
    var late = t.hours_open >= (D.overdue_hours || overdueLimit());
    var when = fmtDate(t.trip_date) + ' בשעה ' + t.start_time;
    var toDriver = !D.offline && waLink(t.driver_phone, 'היי ' + t.driver_name + ', הרכב ' + D.car.plate + ' עדיין רשום אצלך בנסיעה פתוחה (מ-' + when + ') ביומן הנסיעות. ' +
      'אני צריך/ה את הרכב - אפשר לסגור את הנסיעה? תודה! ' + m.name);
    app.innerHTML = backLink() + offlineNote(D) +
      '<section class="card active-trip' + (late ? ' late' : '') + '">' +
      '<div class="status-line"><span class="badge ' + (late ? 'late' : 'open') + '">' + (late ? 'נסיעה פתוחה ' + fmtDur(t.hours_open) : 'הרכב בנסיעה') + '</span></div>' +
      '<p style="margin:0 0 12px;font-size:1.05rem">הרכב ' + (D.offline ? 'רשום (לפי המידע האחרון) ' : 'נמצא כרגע ') + 'בנסיעה של <b>' + esc(t.driver_name) + '</b>, ולכן אי אפשר לפתוח בו נסיעה חדשה.</p>' +
      '<dl class="kv"><dt>יציאה</dt><dd>' + fmtDate(t.trip_date) + ' · ' + esc(t.start_time) + '</dd>' +
      '<dt>פתוחה כבר</dt><dd>' + fmtDur(t.hours_open) + '</dd>' +
      '<dt>ק"מ ביציאה</dt><dd class="num" style="text-align:right">' + fmtKm(t.start_km) + '</dd></dl>' +
      (late ? '<div class="err-box" style="margin-top:14px">הנסיעה פתוחה הרבה יותר מהרגיל - כנראה שכחו לסגור אותה.</div>' : '') +
      '<div class="warn-box" style="margin-top:14px">רק ' + esc(t.driver_name) + ' יכול/ה לסגור את הנסיעה.</div>' +
      (late && !D.offline && D.wa_auto ?
        (t.driver_phone ? '<button class="btn wa big" id="nudgeDriver">שליחת הודעה ל' + esc(t.driver_name) + '</button>' : '') +
        (D.manager_phone ? '<button class="btn big" style="margin-top:8px" id="nudgeMgr">דיווח למנהל הרכבים</button>' : '') +
        '<div class="ok-box" id="nudgeOk" hidden></div><div class="err-box" id="nudgeErr" hidden></div>'
        : (toDriver ? '<a class="btn wa big" target="_blank" rel="noopener" href="' + esc(toDriver) + '">הודעה בוואטסאפ ל' + esc(t.driver_name) + '</a>' : '')) +
      '</section>' + whoBar();
    bindWho(function () { carView(code); });
    function nudge(to, btn) {
      clearError('nudgeErr'); $('nudgeOk').hidden = true; busy(btn, true, 'שולח…');
      api('/api/car/' + encodeURIComponent(code) + '/nudge', { to: to, driver_id: m.id }).then(function (r) {
        btn.textContent = '✓ נשלח'; $('nudgeOk').textContent = r.message; $('nudgeOk').hidden = false;
      }, function (e) { busy(btn, false); showError('nudgeErr', e.message); });
    }
    if ($('nudgeDriver')) $('nudgeDriver').onclick = function () { nudge('driver', this); };
    if ($('nudgeMgr')) $('nudgeMgr').onclick = function () { nudge('manager', this); };
  }

  // ---------- לנהג יש נסיעה פתוחה ברכב אחר
  function renderDriverBusy(code, D) {
    var o = D.driver_open_trip;
    if (o.hours_open == null) o.hours_open = hoursSince(o.trip_date, o.start_time);
    app.innerHTML = backLink() + offlineNote(D) +
      '<section class="card active-trip">' +
      '<div class="status-line"><span class="badge open">יש לך נסיעה פתוחה</span></div>' +
      '<p style="margin:0 0 12px;font-size:1.05rem">כבר יש לך נסיעה פתוחה ב<b>רכב <span class="num">' + esc(o.plate) + '</span></b>. ' +
      'אי אפשר להחזיק שתי נסיעות פתוחות בו-זמנית.</p>' +
      '<dl class="kv"><dt>יציאה</dt><dd>' + fmtDate(o.trip_date) + ' · ' + esc(o.start_time) + '</dd>' +
      '<dt>פתוחה כבר</dt><dd>' + fmtDur(o.hours_open) + '</dd>' +
      '<dt>ק"מ ביציאה</dt><dd class="num" style="text-align:right">' + fmtKm(o.start_km) + '</dd></dl>' +
      '<a class="btn primary big" style="margin-top:16px" href="#car=' + esc(o.code) + '">לסגירת הנסיעה ברכב ' + esc(o.plate) + '</a>' +
      '</section>' + whoBar();
    bindWho(function () { carView(code); });
  }

  // ---------- סיום נסיעה: פרטים
  function renderEnd(code, D) {
    var t = D.open_trip;
    var late = t.hours_open >= (D.overdue_hours || overdueLimit());
    if (!endForm || endForm.code !== code) endForm = { code: code, destinations: '', selected: [], extra: [], end_date: late ? '' : today(), end_time: late ? '' : nowTime(), end_km: '' };
    var f = endForm;
    var emps = D.employees || H.employees;
    app.innerHTML = backLink() + offlineNote(D) +
      '<section class="card active-trip' + (late ? ' late' : '') + '">' +
      '<div class="status-line"><span class="badge ' + (late ? 'late">נסיעה פתוחה ' + fmtDur(t.hours_open) : 'open">נסיעה פעילה') + '</span>' +
      (t.pending ? ' <span class="badge cancelled" style="text-decoration:none">שמורה בטלפון</span>' : '') + '</div>' +
      '<dl class="kv"><dt>נהג/ת</dt><dd>' + esc(t.driver_name) + '</dd>' +
      '<dt>יציאה</dt><dd>' + fmtDate(t.trip_date) + ' · ' + esc(t.start_time) + '</dd>' +
      '<dt>ק"מ ביציאה</dt><dd class="num" style="text-align:right">' + fmtKm(t.start_km) + '</dd></dl>' +
      (late ? '<div class="err-box" style="margin-top:12px">הנסיעה פתוחה כבר ' + fmtDur(t.hours_open) + '. כנראה שכחת לסגור אותה - ' +
        'מלא/י בבקשה את <u>תאריך ושעת החזרה האמיתיים</u>, ולא את השעה הנוכחית.</div>' : '') +
      '</section>' +
      '<section class="card">' +
      '<div class="steps"><i class="on"></i><i class="on"></i><i></i></div>' +
      '<h2>סיום נסיעה</h2>' +
      '<label class="field"><span>יעדי הנסיעה</span><textarea id="dest" placeholder="לדוגמה: לשכת ירושלים, משרד הפנים - בית שאן">' + esc(f.destinations) + '</textarea></label>' +
      '<div class="field" style="margin-bottom:14px"><span style="display:block;font-weight:600;margin-bottom:6px">נוסעים <span class="hint" style="display:inline">(אפשר לבחור כמה, או להשאיר ריק)</span></span>' +
      (emps.length > 12 ? '<input id="pq" placeholder="חיפוש נוסע…" autocomplete="off" style="margin-bottom:8px">' : '') +
      '<div class="chips" id="pax"></div>' +
      '<div class="add-row"><input id="extra" placeholder="נוסע/ת שלא ברשימה"><button class="btn" id="addExtra">הוספה</button></div></div>' +
      '<div class="row2">' +
      '<label class="field"><span>תאריך חזרה</span><input type="date" id="edate" value="' + esc(f.end_date) + '"></label>' +
      '<label class="field"><span>שעת חזרה</span><input type="time" id="etime" value="' + esc(f.end_time) + '"></label>' +
      '</div>' +
      '<label class="field"><span>מד קילומטראז\' בחזרה</span>' +
      '<input id="ekm" inputmode="numeric" pattern="[0-9]*" autocomplete="off" value="' + esc(f.end_km) + '" placeholder="המספר שמופיע בלוח המחוונים">' +
      '<div class="dist" id="dist" hidden><span>סה"כ נסיעה</span><span class="num" id="distv"></span></div></label>' +
      '<div class="err-box" id="err" hidden></div>' +
      '<button class="btn primary big" id="next">המשך לחתימה</button>' +
      '</section>';

    function drawPax() {
      var q = $('pq') ? $('pq').value.trim() : '';
      var html = emps.filter(function (e) { return e.id !== t.driver_id; }).filter(function (e) {
        return !q || e.name.indexOf(q) >= 0 || f.selected.indexOf(e.name) >= 0;
      }).map(function (e) {
        var on = f.selected.indexOf(e.name) >= 0;
        return '<span class="chip' + (on ? ' on' : '') + '" data-n="' + esc(e.name) + '">' + (on ? '✓ ' : '') + esc(e.name) + '</span>';
      }).join('');
      html += f.extra.map(function (n) { return '<span class="chip on" data-x="' + esc(n) + '">' + esc(n) + '<span class="x">✕</span></span>'; }).join('');
      $('pax').innerHTML = html;
    }
    drawPax();
    if ($('pq')) $('pq').oninput = drawPax;
    $('pax').onclick = function (ev) {
      var c = ev.target.closest('.chip'); if (!c) return;
      if (c.dataset.x) { f.extra = f.extra.filter(function (n) { return n !== c.dataset.x; }); }
      else { var n = c.dataset.n, i = f.selected.indexOf(n); if (i >= 0) f.selected.splice(i, 1); else f.selected.push(n); }
      drawPax();
    };
    $('addExtra').onclick = function () {
      var v = $('extra').value.trim(); if (!v) return;
      if (f.extra.indexOf(v) < 0 && f.selected.indexOf(v) < 0) f.extra.push(v);
      $('extra').value = ''; drawPax();
    };
    $('extra').onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); $('addExtra').click(); } };
    function updDist() {
      var km = parseKm($('ekm').value);
      if (isNaN(km)) { $('dist').hidden = true; return; }
      var d = km - t.start_km;
      $('dist').hidden = false;
      $('distv').textContent = (d < 0 ? '⚠ ' : '') + fmtKm(d) + ' ק"מ';
      $('dist').style.color = d < 0 ? 'var(--bad)' : '';
    }
    $('ekm').oninput = updDist; updDist();
    $('next').onclick = function () {
      clearError('err');
      f.destinations = $('dest').value.trim();
      f.end_date = $('edate').value; f.end_time = $('etime').value; f.end_km = $('ekm').value;
      var km = parseKm(f.end_km);
      if (!f.destinations) return showError('err', 'יש למלא את יעדי הנסיעה');
      if (!f.end_date || !f.end_time) return showError('err', 'יש למלא תאריך ושעת חזרה');
      if (isNaN(km)) return showError('err', 'יש להזין את מד הקילומטראז\' בחזרה (מספרים בלבד)');
      if (km < t.start_km) return showError('err', 'הקילומטראז\' בחזרה נמוך מהקילומטראז\' ביציאה (' + fmtKm(t.start_km) + ')');
      if (f.end_date + f.end_time < t.trip_date + t.start_time) return showError('err', 'מועד החזרה מוקדם ממועד היציאה');
      if (km - t.start_km > 1000 && !confirm('נרשמה נסיעה של ' + fmtKm(km - t.start_km) + ' ק"מ. האם המספר נכון?')) return;
      renderSign(code, D);
    };
  }

  // ---------- סיום נסיעה: חתימה
  function renderSign(code, D) {
    var t = D.open_trip, f = endForm;
    var dist = parseKm(f.end_km) - t.start_km;
    var pax = f.selected.concat(f.extra);
    app.innerHTML = offlineNote(D) +
      '<section class="card">' +
      '<div class="steps"><i class="on"></i><i class="on"></i><i class="on"></i></div>' +
      '<h2>חתימת הנהג/ת</h2>' +
      '<dl class="kv" style="margin-bottom:14px">' +
      '<dt>נהג/ת</dt><dd>' + esc(t.driver_name) + '</dd>' +
      '<dt>יעדים</dt><dd>' + esc(f.destinations) + '</dd>' +
      (pax.length ? '<dt>נוסעים</dt><dd>' + esc(pax.join(', ')) + '</dd>' : '') +
      '<dt>זמנים</dt><dd>' + esc(t.start_time) + ' – ' + esc(f.end_time) + (f.end_date !== t.trip_date ? ' (' + fmtDate(f.end_date) + ')' : '') + '</dd>' +
      '<dt>ק"מ</dt><dd><span class="num">' + fmtKm(t.start_km) + ' → ' + fmtKm(parseKm(f.end_km)) + '</span> (' + fmtKm(dist) + ' ק"מ)</dd>' +
      '</dl>' +
      '<p class="hint" style="margin:0 0 8px">חתום/י עם האצבע בתוך המסגרת:</p>' +
      '<div class="sig-wrap"><canvas class="sig" id="sig"></canvas><div class="sig-line"></div><div class="sig-ph" id="ph">חתימה</div></div>' +
      '<div class="sig-actions"><button class="btn" id="back">חזרה לעריכה</button><button class="btn" id="clr">ניקוי חתימה</button></div>' +
      '<div class="err-box" id="err" hidden></div>' +
      '<button class="btn go big" id="save">סיום ושמירת הנסיעה</button>' +
      '</section>';
    var padSig = signaturePad($('sig'), function () { $('ph').hidden = true; });
    $('clr').onclick = function () { padSig.clear(); $('ph').hidden = false; };
    $('back').onclick = function () { renderEnd(code, D); };
    $('save').onclick = function () {
      clearError('err');
      if (padSig.isEmpty()) return showError('err', 'יש לחתום לפני השמירה');
      var body = { driver_id: me().id, destinations: f.destinations, passengers: pax, end_date: f.end_date, end_time: f.end_time,
        end_km: parseKm(f.end_km), signature: padSig.toDataURL() };
      var btn = this;
      function saveLocal() {
        var item = { type: 'end', car_code: code, plate: D.car.plate, body: body };
        if (t.local) item.start_qid = t.start_qid; else item.trip_id = t.id;
        enqueue(item);
        endForm = null;
        renderDone('הנסיעה נסגרה ונחתמה', fmtKm(dist) + ' ק"מ · ' + t.start_time + '–' + f.end_time, true, 'תודה! אפשר לסגור את האפליקציה.');
      }
      if (D.offline || t.local) return saveLocal();
      busy(btn, true, 'שומר…');
      api('/api/car/' + encodeURIComponent(code) + '/trip/' + t.id + '/end', body).then(function (r) {
        var c = H.cars.filter(function (x) { return x.code === code; })[0];
        if (c) { c.open_trip = null; c.last_km = r.trip.end_km; saveJSON('tl_home', H); }
        endForm = null;
        renderDone('הנסיעה נסגרה ונחתמה', fmtKm(r.trip.end_km - r.trip.start_km) + ' ק"מ · ' + r.trip.start_time + '–' + r.trip.end_time + ' · ' + r.trip.destinations, false, 'תודה! אפשר לסגור את האפליקציה.');
        refreshHome().catch(function () {});
      }, function (e) {
        busy(btn, false);
        if (e.offline) return saveLocal();
        showError('err', e.message); if (e.status === 409) setTimeout(function () { carView(code); }, 2500);
      });
    };
  }

  function signaturePad(canvas, onInk) {
    var ctx = canvas.getContext('2d');
    var ratio = Math.min(window.devicePixelRatio || 1, 2);
    var drawing = false, last = null, ink = 0;
    var r0 = canvas.getBoundingClientRect();
    canvas.width = Math.round(r0.width * ratio); canvas.height = Math.round(r0.height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.lineWidth = 2.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#0b1f3a'; ctx.fillStyle = '#0b1f3a';
    function pos(e) { var r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    canvas.addEventListener('pointerdown', function (e) {
      e.preventDefault(); drawing = true; last = pos(e);
      try { canvas.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
      ctx.beginPath(); ctx.arc(last.x, last.y, 1.3, 0, Math.PI * 2); ctx.fill(); ink += 1; if (onInk) onInk();
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!drawing) return; e.preventDefault();
      var evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e]; if (!evs.length) evs = [e];
      for (var i = 0; i < evs.length; i++) {
        var p = pos(evs[i]);
        ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
        ink += Math.hypot(p.x - last.x, p.y - last.y); last = p;
      }
    });
    function up() { drawing = false; }
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up); canvas.addEventListener('pointerleave', up);
    return {
      clear: function () { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.restore(); ink = 0; },
      isEmpty: function () { return ink < 25; },
      toDataURL: function () { return canvas.toDataURL('image/png'); }
    };
  }

  // ------------------------------------------------------------------ סריקת QR
  function canLiveScan() { return !!(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia); }

  function handleCode(text) {
    var m = /\/c\/([A-Za-z0-9]+)/.exec(text || '');
    if (!m) { toast('זה לא קוד של רכב ממערכת יומן הנסיעות'); return false; }
    go('#car=' + m[1]);
    return true;
  }

  function decodeCanvas(canvas, ctx) {
    var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    var r = window.jsQR ? jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' }) : null;
    return r ? r.data : null;
  }

  var scanStream = null, scanRaf = 0;
  function stopScan() {
    cancelAnimationFrame(scanRaf);
    if (scanStream) { scanStream.getTracks().forEach(function (t) { t.stop(); }); scanStream = null; }
    $('scanner').hidden = true;
  }
  $('scanCancel').onclick = stopScan;

  function scan() {
    if (!canLiveScan()) { $('photoInput').value = ''; $('photoInput').click(); return; }
    var video = $('scanVideo');
    var canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false }).then(function (stream) {
      scanStream = stream; video.srcObject = stream; $('scanner').hidden = false;
      return video.play();
    }).then(function () {
      var lastTry = 0;
      (function tick(ts) {
        if (!scanStream) return;
        if (video.readyState >= 2 && ts - lastTry > 180) {
          lastTry = ts;
          var w = Math.min(720, video.videoWidth), h = Math.round(video.videoHeight * (w / video.videoWidth));
          canvas.width = w; canvas.height = h; ctx.drawImage(video, 0, 0, w, h);
          var txt = decodeCanvas(canvas, ctx);
          if (txt) {
            if (/\/c\/[A-Za-z0-9]+/.test(txt)) { stopScan(); if (navigator.vibrate) navigator.vibrate(60); handleCode(txt); return; }
          }
        }
        scanRaf = requestAnimationFrame(tick);
      })(0);
    }).catch(function () {
      stopScan();
      toast('אין גישה למצלמה - אפשר לצלם תמונה של הקוד');
      $('photoInput').value = ''; $('photoInput').click();
    });
  }

  $('photoInput').onchange = function () {
    var file = this.files && this.files[0]; if (!file) return;
    var img = new Image(), url = URL.createObjectURL(file);
    img.onload = function () {
      var tries = [1600, 1000, 700], txt = null;
      for (var i = 0; i < tries.length && !txt; i++) {
        var s = Math.min(1, tries[i] / Math.max(img.width, img.height));
        var c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        var cx = c.getContext('2d'); cx.drawImage(img, 0, 0, c.width, c.height);
        txt = decodeCanvas(c, cx);
      }
      URL.revokeObjectURL(url);
      if (!txt) { toast('לא זוהה קוד בתמונה - נסו לצלם מקרוב ובאור טוב'); return; }
      handleCode(txt);
    };
    img.onerror = function () { toast('לא ניתן לקרוא את התמונה'); };
    img.src = url;
  };

  // ------------------------------------------------------------------ הגדרות (באפליקציה)
  function settingsView() {
    setHeader(null);
    app.innerHTML = backLink() +
      '<section class="card"><h2>הגדרות חיבור</h2>' +
      '<label class="field"><span>כתובת השרת</span><input id="srv" dir="ltr" value="' + esc(server()) + '" placeholder="' + DEFAULT_SERVER + '"></label>' +
      '<p class="hint" style="margin-top:-6px">הכתובת שבה רצה מערכת יומן הנסיעות במשרד, כולל הפורט. מקבלים אותה ממנהל המערכת.</p>' +
      '<div class="err-box" id="err" hidden></div><div class="ok-box" id="ok" hidden></div>' +
      '<button class="btn primary big" id="saveSrv">שמירה ובדיקת חיבור</button>' +
      '<p class="foot-line" style="margin-top:16px">גרסה ' + APP_VERSION + '</p></section>';
    $('saveSrv').onclick = function () {
      clearError('err'); $('ok').hidden = true;
      var v = $('srv').value.trim().replace(/\/$/, '');
      if (v && !/^https?:\/\//.test(v)) v = 'http://' + v;
      store('tl_server', v || null);
      var btn = this; busy(btn, true, 'בודק…');
      refreshHome().then(function () {
        busy(btn, false); $('ok').textContent = 'החיבור תקין ✓ (' + H.cars.length + ' רכבים)'; $('ok').hidden = false;
      }, function (e) { busy(btn, false); showError('err', e.offline ? 'אין חיבור לכתובת הזו. ודאו שהטלפון ב-WiFi של המשרד ושהכתובת נכונה.' : e.message); });
    };
  }

  // ------------------------------------------------------------------ הפעלה
  // כשהחיבור חוזר - שולחים את מה שנשמר בטלפון
  function onBack() { sync().then(function (sent) { if (sent && !location.hash) homeView(); }); }
  window.addEventListener('online', onBack);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) onBack(); });
  setInterval(function () { if (Q.some(function (q) { return q.status !== 'failed'; })) onBack(); }, 20000);

  // באפליקציית האנדרואיד: כפתור "חזרה" של הטלפון, וסנכרון כשחוזרים לאפליקציה
  var CapApp = NATIVE && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (CapApp) {
    CapApp.addListener('backButton', function () {
      if (!$('scanner').hidden) return stopScan();
      if (location.hash && location.hash !== '#') history.back(); else CapApp.exitApp();
    });
    CapApp.addListener('resume', onBack);
  }

  // פתיחה מתוך קישור /c/קוד (למשל אם נפתח מסריקה במצלמה הרגילה)
  var deep = /[?&]car=([A-Za-z0-9]+)/.exec(location.search);
  if (deep && !location.hash) location.hash = '#car=' + deep[1];
  route();
  if (Q.length) onBack();
  if (!NATIVE && /Android/.test(navigator.userAgent)) {
    fetch('/static/download/TripLog.apk', { method: 'HEAD' }).then(function (r) {
      if (r.ok) { APK_AVAILABLE = true; if (!location.hash && $('scanBtn')) homeView(); }
    }).catch(function () {});
  }
})();
