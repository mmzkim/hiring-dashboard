// 채용현황 탭 + 로그인 (온보딩캘린더 계정 재사용)
// 데이터: Supabase recruit_* 표(로그인한 사람만 읽기). 지원자 개인정보는 없음.
(function () {
  var CFG = window.HR_CONFIG;
  var sb = window.supabase.createClient(CFG.url, CFG.anon, { auth: { persistSession: true, autoRefreshToken: true } });
  var STAGES = ["모집", "1차 면접", "직무과제", "2차 면접", "처우협의", "최종합격"];
  var CO = { "GC케어": "care", "GC메디아이": "medi" };
  var OWNERS = ["김무준", "김진"];
  var state = { co: "all", st: "all", team: "", owner: "", year: null, chart: "open" };
  var data = { postings: [], manual: {}, logs: {}, sync: null, hires: [] };
  var page, tip;

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function d8(d) { return d ? d.slice(2, 10).replace(/-/g, ".") : ""; }
  function fmtTime(iso) {
    var d = new Date(iso), p = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "." + p(d.getMonth() + 1) + "." + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  // ── 로그인 ─────────────────────────────────────────────────────
  function showLogin() {
    var box = document.createElement("div");
    box.className = "r-login";
    box.innerHTML = '<form id="rLoginForm"><h2>HR Board 로그인</h2><p>온보딩캘린더 아이디와 비밀번호로 로그인하세요. 한 번 로그인하면 이 브라우저에서 계속 유지됩니다.</p>' +
      '<label for="rId">아이디<input id="rId" autocomplete="username" required></label>' +
      '<label for="rPw">비밀번호<input id="rPw" type="password" autocomplete="current-password" required></label>' +
      '<div class="err" id="rErr"></div><button type="submit">로그인</button></form>';
    document.body.appendChild(box);
    box.querySelector("form").addEventListener("submit", function (e) {
      e.preventDefault();
      var err = box.querySelector("#rErr");
      err.textContent = "";
      sb.auth.signInWithPassword({ email: box.querySelector("#rId").value.trim().toLowerCase() + "@example.com", password: box.querySelector("#rPw").value })
        .then(function (r) {
          if (r.error) { err.textContent = "아이디 또는 비밀번호가 맞지 않습니다."; return; }
          box.remove();
          start(r.data.session);
        });
    });
  }

  var started = false;
  function start(session) {
    window.HR_TOKEN = session.access_token;
    if (started) return;
    started = true;
    if (window.__startHire) window.__startHire();
    initRecruit();
  }

  sb.auth.onAuthStateChange(function (_e, session) { if (session) window.HR_TOKEN = session.access_token; });
  sb.auth.getSession().then(function (r) { r.data.session ? start(r.data.session) : showLogin(); });
  window.HR_LOGOUT = function () { sb.auth.signOut().then(function () { location.reload(); }); };

  // ── 데이터 ─────────────────────────────────────────────────────
  function loadData() {
    return Promise.all([
      sb.from("recruit_postings").select("*"),
      sb.from("recruit_manual").select("*"),
      sb.from("recruit_edit_log").select("key,field,old_value,new_value,username,edited_at").order("edited_at", { ascending: false }).limit(1000),
      sb.from("recruit_sync_log").select("run_at,ok,kind").eq("ok", true).neq("kind", "excel").order("run_at", { ascending: false }).limit(1),
      sb.from("hire_stats").select("name,company,hire_date,department")
    ]).then(function (res) {
      var bad = res.find(function (r) { return r.error; });
      if (bad) throw bad.error;
      data.postings = res[0].data;
      data.manual = {};
      res[1].data.forEach(function (m) { data.manual[m.key] = m; });
      data.logs = {};
      res[2].data.forEach(function (l) { (data.logs[l.key + "|" + l.field] = data.logs[l.key + "|" + l.field] || []).push(l); });
      data.sync = res[3].data[0] || null;
      data.hires = res[4].data || [];
      matchHires();
    });
  }

  // ── 화면 뼈대 ──────────────────────────────────────────────────
  function initRecruit() {
    page = document.getElementById("recruitPage");
    tip = document.createElement("div");
    tip.className = "r-tip";
    tip.hidden = true;
    document.body.appendChild(tip);
    window.addEventListener("scroll", function () { tip.hidden = true; }, true);
    page.innerHTML =
      '<div class="r-head"><h1>GC케어/GC메디아이 채용 현황</h1><span class="r-sync" id="rSync">그리팅 연동 · 자동 갱신</span>' +
      '<span class="r-spacer"></span><span class="r-time" id="rTime"></span>' +
      '<select class="r-sel" id="rYear" aria-label="연도"></select><button type="button" class="r-sel" id="rRefresh">새로고침</button></div>' +
      '<div class="r-top">' +
        '<div class="r-panel"><div class="r-panel-head"><span class="t">포지션 현황</span><span class="s" id="rPosSub"></span></div><table class="r-pos" id="rPos"></table></div>' +
        '<div class="r-panel"><div class="r-panel-head"><span class="t">월별 채용현황</span><div class="r-ctab" role="tablist">' +
          '<button type="button" role="tab" data-c="open" class="on">포지션 오픈 현황</button><button type="button" role="tab" data-c="done">채용 완료 현황</button></div></div>' +
          '<div class="r-legend" id="rLegend"></div><svg id="rChart" role="img" aria-label="월별 채용현황 그래프"></svg></div>' +
      '</div>' +
      '<div class="r-filters">' +
        '<div class="r-seg" id="rCo"><button type="button" data-v="all" class="on">전체</button><button type="button" data-v="GC케어" class="care">GC케어</button><button type="button" data-v="GC메디아이" class="medi">GC메디아이</button></div>' +
        '<div class="r-seg" id="rSt"><button type="button" data-v="all" class="on">전체</button><button type="button" data-v="open">진행 중</button><button type="button" data-v="done">완료</button></div>' +
        '<select class="r-sel" id="rTeam" aria-label="팀"><option value="">전체 팀</option></select>' +
        '<select class="r-sel" id="rOwner" aria-label="담당자"><option value="">전체 담당자</option><option>김무준</option><option>김진</option><option value="-">미지정</option></select>' +
        '<span class="r-count" id="rCount"></span></div>' +
      '<div class="r-tbl-wrap"><table class="r-data" id="rTable"></table></div>' +
      '<div class="r-tbl-legend"><span><i style="background:var(--r-care-bg); box-shadow: inset 0 0 0 2px var(--r-care)"></i><i style="background:var(--r-medi-bg); box-shadow: inset 0 0 0 2px var(--r-medi)"></i>현재 진행 단계</span>' +
        '<span><i style="background:#F3F4F6"></i>해당 공고에 없는 전형</span><span><i style="background:#F3F4F6; border:1px solid #D1D5DB"></i>완료 포지션</span>' +
        '<span>비고: 증원 · 충원(퇴사자 입력) · 기타(직접 입력)</span></div>';

    function seg(id, k) {
      page.querySelectorAll("#" + id + " button").forEach(function (b) {
        b.addEventListener("click", function () {
          state[k] = b.dataset.v;
          page.querySelectorAll("#" + id + " button").forEach(function (x) { x.classList.toggle("on", x === b); });
          renderAll(true);
        });
      });
    }
    seg("rCo", "co"); seg("rSt", "st");
    page.querySelectorAll(".r-ctab button").forEach(function (b) {
      b.addEventListener("click", function () {
        state.chart = b.dataset.c;
        page.querySelectorAll(".r-ctab button").forEach(function (x) { x.classList.toggle("on", x === b); });
        drawChart(true);
      });
    });
    page.querySelector("#rTeam").addEventListener("change", function (e) { state.team = e.target.value; renderTable(); });
    page.querySelector("#rOwner").addEventListener("change", function (e) { state.owner = e.target.value; renderTable(); });
    page.querySelector("#rYear").addEventListener("change", function (e) { state.year = +e.target.value; renderAll(true); });
    page.querySelector("#rRefresh").addEventListener("click", function () { refresh(false); });
    if (window.ResizeObserver) new ResizeObserver(function () { drawChart(false); }).observe(page.querySelector("#rChart"));
    refresh(true);
    setInterval(function () { refresh(false); }, 10 * 60 * 1000);
  }

  function refresh(animate) {
    return loadData().then(function () {
      var years = data.postings.map(function (p) { return p.year; }).filter(function (y, i, a) { return a.indexOf(y) === i; }).sort().reverse();
      var thisYear = new Date().getFullYear();
      if (years.indexOf(thisYear) < 0) years.unshift(thisYear);
      if (!state.year) state.year = thisYear;
      page.querySelector("#rYear").innerHTML = years.map(function (y) { return "<option" + (y === state.year ? " selected" : "") + ' value="' + y + '">' + y + "년" + (y < thisYear ? " (지난 연도)" : "") + "</option>"; }).join("");
      var s = data.sync;
      var el = page.querySelector("#rSync");
      el.classList.toggle("stale", !s || Date.now() - new Date(s.run_at) > 2 * 3600 * 1000);
      page.querySelector("#rTime").textContent = s ? "마지막 동기화 " + fmtTime(s.run_at) : "동기화 기록 없음";
      renderAll(animate === true);
    }).catch(function (e) {
      page.querySelector("#rTime").textContent = "불러오지 못했습니다: " + (e.message || e);
    });
  }

  // ── 계산 ───────────────────────────────────────────────────────
  function m(p) { return data.manual[p.key] || {}; }
  // 같은 포지션이 엑셀(과거 기록)과 그리팅(마감 공고)에 모두 있으면 엑셀 행만 보여준다
  function normPos(x) { return String(x || "").replace(/\(.*?\)|\s/g, "").toLowerCase(); }
  function isDupOfExcel(p) {
    if (p.source !== "greeting" || p.status !== "done") return false;
    return data.postings.some(function (x) {
      if (x.source !== "excel" || x.company !== p.company || (x.team || "") !== (p.team || "")) return false;
      if (normPos(x.position) !== normPos(p.position)) return false;
      return !x.done_date || !p.done_date || Math.abs(new Date(x.done_date) - new Date(p.done_date)) <= 60 * 86400000;
    });
  }
  function yearRows() { return data.postings.filter(function (p) { return p.year === state.year && !p.excluded && !isDupOfExcel(p); }); }
  function isOpen(p) { return p.status === "open"; }

  function renderAll(animate) { renderPos(); drawChart(animate !== false); renderFilters(); renderTable(); }

  function renderPos() {
    var rows = yearRows();
    function line(label, cls, c) {
      var sub = rows.filter(function (p) { return !c || p.company === c; });
      var o = sub.filter(isOpen).length, t = sub.length, d = t - o;
      var lv = "";
      if (!c) lv = o > 20 ? '<span class="r-lv over">알림</span>' : o > 15 ? '<span class="r-lv many">많음</span>' : o >= 10 ? '<span class="r-lv ok">적정</span>' : "";
      return '<tr class="' + (c ? "" : "total") + '"><td class="lbl ' + cls + '">' + label + '</td><td><span class="v">' + o + "개</span>" + lv +
        '</td><td><span class="v">' + t + '개</span></td><td><span class="v">' + (t ? (d / t * 100).toFixed(1) : "0.0") + "%</span></td></tr>";
    }
    page.querySelector("#rPosSub").textContent = String(state.year).slice(2) + "Y · 그리팅 기준";
    page.querySelector("#rPos").innerHTML = '<thead><tr><th>구분</th><th>현재 진행 포지션<small>적정 10~15 · 20 초과 시 알림</small></th><th>' +
      String(state.year).slice(2) + "Y 전체<br>채용 포지션</th><th>완료율</th></tr></thead><tbody>" +
      line("전체", "", null) + line("GC케어", "care", "GC케어") + line("GC메디아이", "medi", "GC메디아이") + "</tbody>";
  }

  function drawChart(animate) {
    var svg = page && page.querySelector("#rChart");
    if (!svg) return;
    var kind = state.chart, Y = state.year, rows = yearRows();
    var C = { care: "#16A34A", medi: "#EA580C", rate: "#E11D48", grid2: "#D1D5DB", axis: "#9CA3AF", label: "#6B7280", ink: "#111827", future: "#C0C4CC" };
    var M = ["1월", "2월", "3월", "4월", "5월", "6월", "7월", "8월", "9월", "10월", "11월", "12월"];
    var now = new Date(), NOW = Y === now.getFullYear() ? now.getMonth() : Y < now.getFullYear() ? 11 : -1;
    function cnt(field, co, i) {
      var mm = Y + "-" + String(i + 1).padStart(2, "0");
      return rows.filter(function (p) { return p.company === co && p[field] && p[field].slice(0, 7) === mm; }).length;
    }
    var field = kind === "open" ? "open_date" : "done_date";
    var d = { care: M.map(function (_, i) { return cnt(field, "GC케어", i); }), medi: M.map(function (_, i) { return cnt(field, "GC메디아이", i); }) };
    var has = function (i) { return i <= NOW; };
    var W = Math.max(300, svg.clientWidth || 560), H = Math.max(180, svg.clientHeight || 200), L = 26, R = kind === "done" ? 40 : 12, T = 18, B = 36;
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    var sums = M.map(function (_, i) { return d.care[i] + d.medi[i]; });
    var peak = Math.max.apply(null, M.map(function (_, i) { return Math.max(d.care[i], d.medi[i]); }));
    var max = Math.max(10, Math.ceil(peak / 5) * 5), lab = max <= 10 ? 1 : max / 5;
    var cw = (W - L - R) / 12, bw = Math.max(5, Math.min(10, cw * 0.22)), gap = 2;
    var y = function (v) { return T + (H - T - B) * (1 - v / max); };
    var o = "", lbl = "";
    for (var g = 0; g <= max; g++) {
      o += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(g) + '" y2="' + y(g) + '" stroke="' + (g === 0 ? C.axis : C.grid2) + '" stroke-width="' + (g === 0 ? 1.2 : 0.8) + '"/>';
      if (g % lab === 0) o += '<text x="' + (L - 6) + '" y="' + (y(g) + 3.5) + '" font-size="10" font-weight="600" fill="' + C.label + '" text-anchor="end">' + g + "</text>";
    }
    M.forEach(function (mo, i) {
      var cx = L + cw * i + cw / 2, seg = "";
      if (has(i)) {
        [["care", d.care[i], cx - gap / 2 - bw], ["medi", d.medi[i], cx + gap / 2]].forEach(function (s) {
          if (!s[1]) return;
          var y0 = y(s[1]);
          seg += '<rect x="' + s[2] + '" y="' + y0 + '" width="' + bw + '" height="' + (y(0) - y0) + '" rx="1.5" fill="' + C[s[0]] + '"><title>' + mo + " " + (s[0] === "care" ? "GC케어" : "GC메디아이") + " " + s[1] + "건</title></rect>";
          lbl += '<text x="' + (s[2] + bw / 2) + '" y="' + (y0 - 4) + '" font-size="10" font-weight="800" fill="' + C.ink + '" text-anchor="middle">' + s[1] + "</text>";
        });
        lbl += '<text x="' + cx + '" y="' + (H - 3) + '" font-size="12" font-weight="800" fill="' + C.ink + '" text-anchor="middle">' + sums[i] + "</text>";
      }
      seg += '<text x="' + cx + '" y="' + (H - 19) + '" font-size="10.5" font-weight="' + (i === NOW ? 800 : 500) + '" fill="' + (i === NOW ? C.ink : has(i) ? C.label : C.future) + '" text-anchor="middle">' + mo + "</text>";
      o += '<g class="col" style="animation-delay:' + i * 25 + 'ms">' + seg + "</g>";
    });
    o += '<g class="lbls">' + lbl;
    if (kind === "done") {
      var co = 0, cd = 0, pts = [];
      var yr = function (p) { return T + (H - T - B) * (1 - p); };
      M.forEach(function (_, i) {
        if (!has(i)) return;
        co += cnt("open_date", "GC케어", i) + cnt("open_date", "GC메디아이", i);
        cd += sums[i];
        var r = co ? Math.min(1, cd / co) : 0;
        pts.push([L + cw * i + cw / 2, yr(r), r]);
      });
      if (pts.length) {
        o += '<polyline points="' + pts.map(function (p) { return p[0] + "," + p[1]; }).join(" ") + '" fill="none" stroke="' + C.rate + '" stroke-width="1.8" stroke-dasharray="4 3"/>';
        pts.forEach(function (p, i) { o += '<rect x="' + (p[0] - 2.6) + '" y="' + (p[1] - 2.6) + '" width="5.2" height="5.2" transform="rotate(45 ' + p[0] + " " + p[1] + ')" fill="' + C.rate + '"><title>' + M[i] + " 누적 완료율 " + (p[2] * 100).toFixed(1) + "%</title></rect>"; });
        var last = pts[pts.length - 1];
        o += '<text x="' + (last[0] + 6) + '" y="' + (last[1] - 6) + '" font-size="10" font-weight="800" fill="' + C.rate + '">' + (last[2] * 100).toFixed(1) + "%</text>";
      }
      o += "</g>";
      [0, .2, .4, .6, .8, 1].forEach(function (p) { o += '<text x="' + (W - R + 6) + '" y="' + (yr(p) + 3.5) + '" font-size="9.5" fill="' + C.rate + '">' + Math.round(p * 100) + "%</text>"; });
    } else {
      o += "</g>";
    }
    svg.innerHTML = o;
    if (animate) { svg.classList.remove("anim"); void svg.getBoundingClientRect(); svg.classList.add("anim"); }
    page.querySelector("#rLegend").innerHTML = '<span><span class="sw" style="background:var(--r-care)"></span>GC케어</span><span><span class="sw" style="background:var(--r-medi)"></span>GC메디아이</span>' +
      "<span>막대 위 숫자 = 건수</span><span>월 아래 숫자 = 그 달 합계</span>" +
      (kind === "done" ? '<span><span class="sw" style="background:#E11D48; transform:rotate(45deg) scale(.7)"></span>누적 완료율</span>' : "");
  }

  function renderFilters() {
    var teams = yearRows().map(function (p) { return p.team; }).filter(function (t, i, a) { return t && a.indexOf(t) === i; }).sort();
    var sel = page.querySelector("#rTeam");
    sel.innerHTML = '<option value="">전체 팀</option>' + teams.map(function (t) { return "<option" + (t === state.team ? " selected" : "") + ">" + esc(t) + "</option>"; }).join("");
  }

  // ── 표 ─────────────────────────────────────────────────────────
  var COLS = [24, 38, 76, 44, 50, 60, 84, 40, 28, 72, 56, 56, 32, 34, 34, 34, 34, 38, 52, 62, 22, 56];
  function histAttr(key, field) {
    return "";  // 수정 이력은 화면에 표시하지 않음(기록은 DB에만 남음)
    var l = data.logs[key + "|" + field];
    return l ? ' class="r-hist" data-hist="' + esc(key + "|" + field) + '"' : "";
  }
  function stageCells(p) {
    var cls = CO[p.company] || "care";
    return STAGES.map(function (s) {
      if (p.status !== "open") {
        var dv = (p.stage_counts || {})[s];
        return '<td class="nw">' + (dv == null ? "" : dv) + "</td>";
      }
      if (s !== "최종합격" && (p.stages || []).indexOf(s) < 0) return '<td class="na"></td>';
      var v = (p.stage_counts || {})[s] || 0;
      return '<td class="nw num' + (s === p.current_stage ? " cur " + cls : "") + '">' + v + "</td>";
    }).join("");
  }
  function chCell(p, i) {
    var ch = p.channels || {}, ks = Object.keys(ch).sort(function (a, b) { return ch[b] - ch[a]; });
    if (!ks.length) return "미확인";
    return '<span class="r-ch" tabindex="0" data-ch="' + i + '">' + esc(ks[0]) + (ks.length > 1 ? " 외 " + (ks.length - 1) : "") + "</span>";
  }
  function row(p, seq, idx) {
    var mm = m(p), open = isOpen(p), emp = mm.employment || p.employment || "";
    var head = '<td class="nw num">' + seq + '</td><td><span class="r-pill ' + (open ? "ing" : "done") + '">' + (open ? "진행" : "완료") + "</span></td>" +
      '<td><span class="r-badge ' + (CO[p.company] || "none") + '">' + esc(p.company || "표기 없음") + "</span></td>" +
      "<td>" + (open ? "" : esc(p.hire_names || (p._hires || []).map(function (h) { return h.name; }).join(", "))) + '</td><td class="nw">' + (open ? "" : d8(p.hire_date || ((p._hires || [])[0] && p._hires[0].hire_date))) + "</td>" +
      "<td>" + esc(p.team || "") + '</td><td class="pos">' + esc(p.position) + "</td>";
    if (!open) {
      return '<tr class="done">' + head + "<td>" + esc(emp) + '</td><td class="nw num">' + (mm.headcount || p.pass_count || 1) + "</td><td>" + esc(mm.note || "") +
        '</td><td class="nw">' + d8(p.open_date) + '</td><td class="nw">' + d8(p.done_date) + "</td>" + stageCells(p) +
        "<td>최종합격</td><td>" + chCell(p, idx) + "</td><td>" + (mm.important ? "★" : "") + "</td><td>" + esc(mm.owner || "") + "</td></tr>";
    }
    var k = esc(p.key);
    return "<tr>" + head +
      "<td" + histAttr(p.key, "employment") + '><select class="r-cell" data-k="' + k + '" data-f="employment" aria-label="채용형태">' +
        ["정규직", "계약직", "인턴"].concat(emp && ["정규직", "계약직", "인턴"].indexOf(emp) < 0 ? [emp] : []).map(function (x) { return "<option" + (x === emp ? " selected" : "") + ">" + x + "</option>"; }).join("") + "</select></td>" +
      "<td" + histAttr(p.key, "headcount") + '><input class="r-cell" type="number" min="1" value="' + (mm.headcount || 1) + '" data-k="' + k + '" data-f="headcount" aria-label="채용 인원"></td>' +
      "<td" + histAttr(p.key, "note") + ">" + noteCell(p.key, mm.note) + "</td>" +
      '<td class="nw">' + d8(p.open_date) + '</td><td class="nw"></td>' + stageCells(p) +
      "<td><b>" + esc(p.current_stage || "지원자 없음") + "</b></td><td>" + chCell(p, idx) + "</td>" +
      "<td" + histAttr(p.key, "important") + '><button type="button" class="r-star' + (mm.important ? " on" : "") + '" data-k="' + k + '" aria-label="중요 포지션">★</button></td>' +
      "<td" + histAttr(p.key, "owner") + '><select class="r-cell' + (mm.owner ? "" : " unset") + '" data-k="' + k + '" data-f="owner" aria-label="담당자"><option value="">미지정</option>' +
        OWNERS.map(function (x) { return "<option" + (x === mm.owner ? " selected" : "") + ">" + x + "</option>"; }).join("") + "</select></td></tr>";
  }

  function noteCell(key, note) {
    note = note || "";
    if (note) return '<span class="r-note-view" tabindex="0" role="button" title="클릭해서 수정" data-k="' + esc(key) + '" data-note="' + esc(note) + '">' + esc(note) + "</span>";
    return noteEditor(key, note);
  }
  function noteEditor(key, note) {
    note = note || "";
    var kind = !note ? "" : note === "증원" ? "증원" : /^충원/.test(note) ? "충원" : "기타";
    var extra = kind === "충원" ? (note.match(/^충원\((.*)\)$/) || [])[1] || "" : kind === "기타" ? note : "";
    var k = esc(key);
    return '<div class="r-note"><select class="r-cell r-note-sel" data-k="' + k + '" aria-label="비고">' +
      [["", "-"], ["증원", "증원"], ["충원", "충원"], ["기타", "기타"]].map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === kind ? " selected" : "") + ">" + o[1] + "</option>"; }).join("") +
      "</select>" + (kind === "충원" || kind === "기타" ? '<input class="r-cell r-note-txt" data-k="' + k + '" data-kind="' + kind + '" value="' + esc(extra) + '" placeholder="' + (kind === "충원" ? "퇴사자" : "직접 입력") + '" aria-label="비고 내용">' : "") + "</div>";
  }

  // 완료 건 ↔ 입사현황(온보딩캘린더) 연결: 같은 회사·팀, 완료일 전후 입사일. 저장하지 않고 화면에서만 맞춤
  function matchHires() {
    var used = {};
    var done = data.postings.filter(function (p) { return p.status === "done" && p.done_date && !p.hire_names && !isDupOfExcel(p); })
      .sort(function (a, b) { return a.done_date.localeCompare(b.done_date); });
    done.forEach(function (p) {
      var team = (p.team || "").replace(/\s/g, ""), dd = new Date(p.done_date), need = (data.manual[p.key] || {}).headcount || p.pass_count || 1;
      var cands = data.hires.map(function (h, i) { return { h: h, i: i }; }).filter(function (c) {
        var dept = (c.h.department || "").replace(/\s/g, "");
        var gap = (new Date(c.h.hire_date) - dd) / 86400000;
        return !used[c.i] && c.h.company === p.company && team && dept && (dept === team || dept.indexOf(team) >= 0 || team.indexOf(dept) >= 0) && gap >= -14 && gap <= 120;
      }).sort(function (a, b) { return Math.abs(new Date(a.h.hire_date) - dd) - Math.abs(new Date(b.h.hire_date) - dd); }).slice(0, need);
      cands.forEach(function (c) { used[c.i] = true; });
      p._hires = cands.map(function (c) { return c.h; });
    });
  }

  var shown = [];
  function renderTable() {
    var rows = yearRows().filter(function (p) {
      var mm = m(p);
      return (state.co === "all" || p.company === state.co) && (!state.team || p.team === state.team) &&
        (!state.owner || (state.owner === "-" ? !mm.owner : mm.owner === state.owner)) &&
        (state.st === "all" || (state.st === "open") === isOpen(p));
    });
    var byStart = function (a, b) { return (a.open_date || "").localeCompare(b.open_date || ""); };
    var html = "<colgroup>" + COLS.map(function (w) { return '<col style="width:' + (w / COLS.reduce(function (a, b) { return a + b; }, 0) * 100).toFixed(2) + '%">'; }).join("") + "</colgroup>" +
      "<thead><tr><th>순번</th><th>완료<br>여부</th><th>회사</th><th>성명</th><th>입사일</th><th>팀</th><th>포지션</th><th>채용<br>형태</th><th>인원</th><th>비고</th>" +
      "<th>시작일</th><th>완료일</th><th>모집</th><th>1차<br>면접</th><th>직무<br>과제</th><th>2차<br>면접</th><th>처우<br>협의</th><th>최종<br>합격</th>" +
      "<th>진행<br>단계</th><th>이용채널</th><th>중요</th><th>담당자</th></tr></thead><tbody>";
    var seq = 0, nOpen = 0, nDone = 0;
    shown = [];
    ["GC케어", "GC메디아이", null].forEach(function (c) {
      var list = rows.filter(function (p) { return isOpen(p) && (p.company || null) === c; }).sort(byStart);
      if (!list.length) return;
      nOpen += list.length;
      html += '<tr class="group open ' + (CO[c] || "") + '"><td colspan="22"><span class="sq" style="background:' + (c === "GC케어" ? "var(--r-care)" : c ? "var(--r-medi)" : "#9CA3AF") + '"></span>' +
        esc(c || "표기 없음") + " · 진행 " + list.length + "건 (시작일 순)</td></tr>";
      list.forEach(function (p) { shown.push(p); html += row(p, ++seq, shown.length - 1); });
    });
    // 완료: 입사일이 이른 순(입사일 없으면 완료일, 그래도 없으면 맨 뒤)
    var hd = function (p) { return p.hire_date || ((p._hires || [])[0] && p._hires[0].hire_date) || p.done_date || "9999"; };
    var done = rows.filter(function (p) { return !isOpen(p); }).sort(function (a, b) { return hd(a).localeCompare(hd(b)); });
    nDone = done.length;
    if (done.length) {
      html += '<tr class="group fin"><td colspan="22"><span class="sq" style="background:#9CA3AF"></span>완료 · ' + done.length + "건 (입사일 순)</td></tr>";
      ["GC케어", "GC메디아이", null].forEach(function (c) {
        var list = done.filter(function (p) { return (p.company || null) === c; });
        if (!list.length) return;
        html += '<tr class="group sub ' + (CO[c] || "") + '"><td colspan="22">' + esc(c || "표기 없음") + " · 완료 " + list.length + "건</td></tr>";
        list.forEach(function (p) { shown.push(p); html += row(p, ++seq, shown.length - 1); });
      });
    }
    if (!seq) html += '<tr><td colspan="22" class="r-empty">조건에 맞는 포지션이 없습니다.</td></tr>';
    page.querySelector("#rTable").innerHTML = html + "</tbody>";
    page.querySelector("#rCount").textContent = "진행 중 " + nOpen + " · 완료 " + nDone;
    bindTable();
  }

  function save(key, field, value, el, quiet) {
    el && (el.disabled = true);
    return sb.rpc("recruit_update_manual", { p_key: key, p_field: field, p_value: value }).then(function (r) {
      if (r.error) { window.alert("저장하지 못했습니다: " + r.error.message); }
      return quiet ? loadData() : refresh(false);
    });
  }
  function bindNote(inp) {
    function commit() {
      var t = inp.value.trim();
      var v = inp.dataset.kind === "충원" ? (t ? "충원(" + t + ")" : "충원") : t;
      save(inp.dataset.k, "note", v, inp);
    }
    inp.addEventListener("change", commit);
    inp.addEventListener("keydown", function (e) { if (e.key === "Enter") inp.blur(); });
  }

  function showTip(el, html) {
    tip.innerHTML = html;
    tip.hidden = false;
    var r = el.getBoundingClientRect(), tw = tip.offsetWidth;
    tip.style.left = Math.max(8, Math.min(window.innerWidth - tw - 8, r.left + r.width / 2 - tw / 2)) + "px";
    tip.style.top = (r.bottom + 6) + "px";
  }
  function hideTip() { tip.hidden = true; }

  function bindTable() {
    var t = page.querySelector("#rTable");
    t.querySelectorAll(".r-note-view").forEach(function (v) {
      function edit() {
        var td = v.parentNode;
        td.innerHTML = noteEditor(v.dataset.k, v.dataset.note);
        td.querySelectorAll(".r-note-sel").forEach(bindNoteSel);
        td.querySelectorAll(".r-note-txt").forEach(bindNote);
        var f = td.querySelector(".r-note-txt") || td.querySelector(".r-note-sel");
        if (f) f.focus();
      }
      v.addEventListener("click", edit);
      v.addEventListener("keydown", function (e) { if (e.key === "Enter") edit(); });
    });
    t.querySelectorAll(".r-note-sel").forEach(bindNoteSel);
    function bindNoteSel(el) {
      el.addEventListener("change", function () {
        var v = el.value;
        if (v === "충원" || v === "기타") {
          var wrap = el.parentNode, inp = document.createElement("input");
          inp.className = "r-cell r-note-txt"; inp.dataset.k = el.dataset.k; inp.dataset.kind = v;
          inp.placeholder = v === "충원" ? "퇴사자" : "직접 입력";
          var old = wrap.querySelector(".r-note-txt"); if (old) old.remove();
          wrap.appendChild(inp); bindNote(inp); inp.focus();
          if (v === "충원") save(el.dataset.k, "note", "충원", null, true);
          return;
        }
        save(el.dataset.k, "note", v, el);
      });
    }
    t.querySelectorAll(".r-note-txt").forEach(bindNote);
    t.querySelectorAll(".r-cell[data-f]").forEach(function (el) {
      el.addEventListener("change", function () {
        var v = el.value;
        if (el.dataset.f === "headcount" && !(+v >= 1)) { el.value = 1; v = "1"; }
        save(el.dataset.k, el.dataset.f, v, el);
      });
    });
    t.querySelectorAll(".r-star").forEach(function (el) {
      el.addEventListener("click", function () { save(el.dataset.k, "important", String(!el.classList.contains("on")), el); });
    });
    t.querySelectorAll(".r-ch").forEach(function (el) {
      var p = shown[+el.dataset.ch], ch = p.channels || {};
      var html = Object.keys(ch).sort(function (a, b) { return ch[b] - ch[a]; }).map(function (k) { return "<div><b>" + esc(k) + "</b><span>" + ch[k] + "명</span></div>"; }).join("");
      el.addEventListener("mouseenter", function () { showTip(el, html); });
      el.addEventListener("focus", function () { showTip(el, html); });
      el.addEventListener("mouseleave", hideTip);
      el.addEventListener("blur", hideTip);
    });
    t.querySelectorAll(".r-hist").forEach(function (el) {
      var l = (data.logs[el.dataset.hist] || []).slice(0, 5);
      var html = "<div><b>수정 이력</b></div>" + l.map(function (x) {
        return "<div>" + fmtTime(x.edited_at).slice(5) + " " + esc(x.username || "") + " : " + esc(x.old_value == null ? "-" : x.old_value) + " → " + esc(x.new_value == null ? "-" : x.new_value) + "</div>";
      }).join("");
      el.addEventListener("mouseenter", function () { showTip(el, html); });
      el.addEventListener("mouseleave", hideTip);
    });
  }
})();
