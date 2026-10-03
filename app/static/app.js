"use strict";

const paths = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  book: '<path d="M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H3V4Zm16 0h-4a3 3 0 0 0-3 3v14a4 4 0 0 1 4-2h4V4Z"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.9M15 3.1a4 4 0 0 1 0 7.8"/><circle cx="9" cy="7" r="4"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18m-13 4h2m4 0h2"/>',
  chart: '<path d="M4 3v18h17M9 16v-4m5 4V8m5 8V5"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  alert: '<path d="m10.3 4-8 14a2 2 0 0 0 1.7 3h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4m0 4h.01"/>',
  qr: '<path d="M3 3h6v6H3zm12 0h6v6h-6zM3 15h6v6H3zm12 0h2v2h-2zm4 0h2v6h-6v-2m-3-7h2m-2 5v4m5-9h4M3 12h5m4-9v4m0 3v2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  logout: '<path d="M9 4H4v16h5m5-12 4 4-4 4m-5-4h12"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5m10-4a8 8 0 0 0-13-3L4 8m16 8-2 3a8 8 0 0 1-13-3"/>',
  edit: '<path d="m16 3 5 5-12 12-6 1 1-6L16 3Zm-2 2 5 5"/>',
  camera: '<path d="M4 7h4l2-3h4l2 3h4v14H4Z"/><circle cx="12" cy="13" r="4"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  activity: '<path d="M2 12h5l3-9 4 18 3-9h5"/>',
};
const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.grid}</svg>`;
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const initials = (name) => name.split(/\s+/).slice(0, 2).map(n => n[0]).join("").toUpperCase();
const dateText = value => new Date(value).toLocaleDateString(undefined, {month:"short",day:"numeric",year:"numeric"});
const timeText = value => new Date(value).toLocaleTimeString(undefined, {hour:"2-digit",minute:"2-digit"});
const brand = `<span class="brand-mark">a<span>•</span></span>attendly<span class="sr-only"> Student attendance</span>`;
const app = document.querySelector("#app");
const modal = document.querySelector("#modal");
const state = {user:null,page:"overview",sessions:[],courses:[],users:[],logs:[],history:[],selected:null,detail:null,query:"",filter:"ALL",report:null,reportPeriod:"daily",reportDay:new Date().toISOString().slice(0,10),activityTab:"fraud"};
let toastTimer, qrTimer, cameraStream, scanTimer, refreshBusy = false;
let pendingScan = null;
try {
  const fragment = new URLSearchParams(location.hash.slice(1));
  if (fragment.has("session") && fragment.has("token")) pendingScan = {session_id:Number(fragment.get("session")),token:fragment.get("token")};
  if (location.hash) history.replaceState(null, "", location.pathname);
} catch { /* Invalid URL fragments are ignored. */ }

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {credentials:"same-origin", ...options, headers:{...(options.body ? {"Content-Type":"application/json"} : {}),...options.headers}});
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && state.user) {state.user = null; closeModal(); renderLogin();}
    const detail = Array.isArray(result.detail) ? result.detail.map(x => `${x.loc?.slice(1).join(".")}: ${x.msg}`).join("; ") : result.detail;
    throw new Error(detail || "The request could not be completed");
  }
  return result;
}
const write = (path, data = {}, method = "POST") => api(path, {method, body:JSON.stringify(data)});
function toast(message, error = false) {
  const el = document.querySelector("#toast");
  clearTimeout(toastTimer); el.textContent = message; el.className = `toast${error ? " error" : ""}`; el.hidden = false;
  toastTimer = setTimeout(() => {el.hidden = true;}, 5500);
}
function badge(status) {
  const colors = {PRESENT:"",UNDER_REVIEW:"orange",ABSENT:"gray",BLOCKED:"red",INVALID_QR:"red",DUPLICATE:"orange"};
  return `<span class="badge ${colors[status] || ""}"><span class="dot"></span>${esc(status.replaceAll("_", " ").toLowerCase().replace(/^./, c => c.toUpperCase()))}</span>`;
}
function empty(title, description, action = "") {return `<div class="empty">${icon("book")}<h3>${esc(title)}</h3><p>${esc(description)}</p>${action}</div>`;}
function button(label, action, kind="primary", extra="", symbol="plus") {return `<button type="button" class="btn btn-${kind}" data-action="${action}" ${extra}>${icon(symbol)}${esc(label)}</button>`;}
function modalOpen(title, subtitle, body) {
  closeModal();
  modal.innerHTML = `<div class="modal-head"><div><h2 id="modal-title">${esc(title)}</h2><p>${esc(subtitle)}</p></div><button data-action="close-modal" aria-label="Close dialog">${icon("close")}</button></div>${body}`;
  modal.showModal();
}
function stopCamera() {clearTimeout(scanTimer); cameraStream?.getTracks().forEach(track => track.stop()); cameraStream = null;}
function closeModal() {clearInterval(qrTimer); if (modal.open) modal.close();}
modal.addEventListener("close", () => clearInterval(qrTimer));
function field(label, name, type="text", value="", extra="") {return `<label class="field">${esc(label)}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;}
function selectField(label, name, options, value="") {return `<label class="field">${esc(label)}<select name="${name}">${options.map(([id,text]) => `<option value="${esc(id)}" ${String(id) === String(value) ? "selected" : ""}>${esc(text)}</option>`).join("")}</select></label>`;}
function formEnd(label) {return `<p class="form-error" role="alert"></p><div class="form-actions">${button("Cancel","close-modal","secondary","","close")}<button type="submit" class="btn btn-primary">${esc(label)}${icon("arrow")}</button></div></form>`;}

function renderLogin() {
  stopCamera();
  app.innerHTML = `<main class="login-page"><section class="login-story"><div class="brand">${brand}</div><div class="story-content"><p class="eyebrow">Less paperwork. More possibility.</p><h1>A clearer view of<br>every <em>classroom.</em></h1><p>Make attendance effortless. Connect every check-in to a classroom you can trust.</p><div class="story-features"><div>${icon("qr")}Secure, time-limited QR check-ins</div><div>${icon("shield")}Real headcounts. Verified attendance.</div><div>${icon("chart")}Meaningful insights, all in one place</div></div></div><small>Built for better learning experiences.</small></section><section class="login-panel"><div class="login-box"><div class="brand mobile-brand">${brand}</div><p class="eyebrow">Your campus, connected</p><h2>Welcome back.</h2><p>Sign in to your attendance workspace.</p><form id="login-form">${field("Email address","email","email","","required autocomplete=\"username\" placeholder=\"you@university.edu\"")}${field("Password","password","password","","required autocomplete=\"current-password\" placeholder=\"Enter your password\"")}<p class="form-error" role="alert"></p><button class="btn btn-primary btn-wide" type="submit">Sign in to workspace${icon("arrow")}</button></form><div class="login-note">${icon("lock")}<span>Access is managed by your institution.<br>Contact your administrator if you need an account.</span></div>${pendingScan ? '<div class="notice">Your classroom QR is ready. Sign in as a student to check in.</div>' : ""}</div></section></main>`;
}

function navItems() {
  if (state.user.role === "student") return [["overview","grid","Overview"],["checkin","qr","Check in"],["history","calendar","My attendance"]];
  return [["overview","grid","Overview"],["sessions","calendar","Class sessions"],...(state.user.role === "admin" ? [["students","users","Students"]] : []),["courses","book","Courses"],["reports","chart","Reports"],["activity","shield","Activity & review"]];
}
function renderShell() {
  const nav = navItems(); const title = nav.find(n => n[0] === state.page)?.[2] || "Overview";
  const totalReview = state.sessions.reduce((sum,s) => sum+s.suspicious,0);
  app.innerHTML = `<div class="shell"><aside class="sidebar"><div class="brand">${brand}</div><p class="nav-label">WORKSPACE</p><nav class="navigation" aria-label="Main navigation">${nav.map(([id,symbol,label]) => `<button class="nav-item ${state.page===id?"active":""}" data-action="navigate" data-page="${id}" ${state.page===id?'aria-current="page"':""}>${icon(symbol)}${label}${id==="activity"&&totalReview?`<span class="nav-count">${totalReview}</span>`:""}</button>`).join("")}</nav><div class="sidebar-bottom"><div class="trust-card">${icon("shield")}<strong>Every check-in counts.</strong><p>Secure attendance.<br>Confident decisions.</p></div><div class="profile"><span class="avatar">${esc(initials(state.user.name))}</span><div><strong>${esc(state.user.name)}</strong><small>${esc(state.user.role)} workspace</small></div><button data-action="logout" title="Sign out" aria-label="Sign out">${icon("logout")}</button></div></div></aside><main class="main"><header class="topbar"><div class="breadcrumb">Workspace<span>/</span><strong>${title}</strong></div><div class="topbar-right"><label class="search">${icon("search")}<input id="search-input" aria-label="Search current view" placeholder="Search this view…" value="${esc(state.query)}"></label><span class="top-date">${icon("calendar")}${dateText(new Date())}</span><button class="icon-btn mobile-logout" hidden data-action="logout" aria-label="Sign out">${icon("logout")}</button></div></header><div class="content" id="content"></div></main></div>`;
  renderContent();
}
function pageHead(title, subtitle, actions="", eyebrow="") {return `<div class="page-head"><div>${eyebrow?`<p class="eyebrow">${esc(eyebrow)}</p>`:""}<h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div><div class="actions">${actions}</div></div>`;}
function renderContent() {
  const el = document.querySelector("#content"); if (!el) return;
  const views = {overview:overviewView,sessions:sessionsView,students:studentsView,courses:coursesView,reports:reportsView,activity:activityView,checkin:checkinView,history:historyView};
  el.innerHTML = (views[state.page] || overviewView)() + `<footer class="footer"><span>Attendly · A little less admin. A lot more learning.</span><span>${icon("lock")}Your classroom, securely connected</span></footer>`;
}
async function loadData() {
  const [sessions,courses] = await Promise.all([api("/sessions"),api("/courses")]); state.sessions=sessions;state.courses=courses;
  if (!sessions.some(s => s.id===state.selected)) state.selected=sessions[0]?.id || null;
  if (state.user.role==="admin") state.users=await api("/users");
  if (state.user.role==="student") state.history=await api("/history");
  else state.logs=await api("/fraud-logs");
  state.detail=state.selected ? await api(`/sessions/${state.selected}`) : null;
}
async function navigate(page) {
  stopCamera(); state.page=page;state.query="";state.filter="ALL";
  if (page==="reports") await loadReport();
  if (page==="activity" && state.activityTab==="audit") state.audit=await api("/audit-logs");
  renderShell(); window.scrollTo({top:0});
}
function stats(session) {
  const cards=[["Class strength",session?.class_strength??0,"users","Enrolled in this session",""],["Head count",session?.headcount??"—","users","Verified by faculty",""],["QR responses",session?.responses??0,"qr","Unique student check-ins",""],["Valid attendance",session?.valid??0,"check","Within verified capacity","positive"],["Under review",session?.suspicious??0,"alert","Needs a closer look","warning"],["Absent students",session?.absent??0,"calendar","No accepted check-in",""]];
  return `<div class="stats">${cards.map(([label,value,symbol,foot,cls])=>`<article class="stat ${cls}"><div class="stat-top">${label}${icon(symbol)}</div><div class="stat-value">${value}</div><div class="stat-foot">${foot}</div></article>`).join("")}</div>`;
}
function sessionBadge(s) {return s.closed?'<span class="badge gray"><span class="dot"></span>Closed</span>':new Date(s.ends_at)<new Date()?'<span class="badge gray">Ended</span>':new Date(s.starts_at)>new Date()?'<span class="badge blue">Upcoming</span>':'<span class="badge"><span class="dot"></span>Live session</span>';}
function sessionCard(s) {
  const percent = s.class_strength ? Math.round(s.valid/s.class_strength*100) : 0;
  return `<section class="card card-pad"><div class="section-head"><h2>Classroom at a glance</h2>${sessionBadge(s)}</div><div class="course-heading"><span class="course-symbol">${icon("book")}</span><div><h3>${esc(s.subject)}</h3><p>${esc(s.course_code)} · ${esc(s.faculty_name)}</p></div></div><div class="session-meta"><span>${icon("calendar")}${dateText(s.starts_at)}</span><span>${icon("clock")}${timeText(s.starts_at)} – ${timeText(s.ends_at)}</span></div><div class="session-body"><div><div class="progress-head"><span>Validated attendance</span><strong>${percent}<small>%</small></strong></div><progress class="progress-track" max="100" value="${percent}" aria-label="Validated attendance percentage"></progress><div class="progress-legend"><span><i class="legend-dot"></i>${s.valid} present</span><span><i class="legend-dot orange"></i>${s.suspicious} review</span><span><i class="legend-dot gray"></i>${s.absent} absent</span></div><div class="session-controls">${button("Set headcount","headcount","secondary",`data-id="${s.id}"`,"users")}${button("View class","detail","ghost",`data-id="${s.id}"`,"arrow")}</div></div><div class="qr-preview">${icon("qr")}<p>One scan. Checked in.</p>${button("Generate QR","qr","primary",`data-id="${s.id}" ${s.closed?"disabled":""}`,"qr")}</div></div>${s.suspicious?`<div class="notice">${icon("alert")}<span><strong>${s.suspicious} check-ins need review.</strong> ${s.excess?`${s.excess} responses exceed the actual headcount.`:"Check the validation signals before approval."}</span></div>`:'<div class="notice">'+icon("shield")+'<span>QR codes expire after 5 minutes. Each student can check in once.</span></div>'}</section>`;
}
function breakdown(s) {
  const total=s?.class_strength||0,valid=s?.valid||0,review=s?.suspicious||0,absent=s?.absent||0,pct=total?Math.round(valid/total*100):0;
  return `<section class="card card-pad"><div class="section-head"><div><h2>Attendance breakdown</h2><p>A real-time view of your selected class</p></div>${icon("chart")}</div><div class="ring-layout"><div class="ring"><svg viewBox="0 0 160 160" aria-hidden="true"><circle class="track" cx="80" cy="80" r="65"/><circle class="value" cx="80" cy="80" r="65" stroke-dasharray="${pct*4.084} 408.4"/></svg><div class="ring-text"><strong>${pct}%</strong><small>validated attendance</small></div></div><div class="ring-legend"><div><i class="legend-dot"></i>Present <b>${valid}</b></div><div><i class="legend-dot orange"></i>Review <b>${review}</b></div><div><i class="legend-dot gray"></i>Absent <b>${absent}</b></div></div></div><div class="card-bottom"><span>Class strength</span><strong>${total} students</strong></div></section>`;
}
function attendanceTable(rows, title="Student attendance", limit=0) {
  const filtered=rows.filter(r => (state.filter==="ALL"||r.status===state.filter)&&`${r.name} ${r.roll_number}`.toLowerCase().includes(state.query.toLowerCase()));
  const displayed=limit?filtered.slice(0,limit):filtered;
  return `<section class="card table-card"><div class="section-head"><div><h2>${esc(title)}</h2><p>Check-ins, validation signals, and review decisions</p></div><div class="filters"><label><span class="sr-only">Attendance status</span><select id="status-filter">${["ALL","PRESENT","UNDER_REVIEW","ABSENT","BLOCKED"].map(s=>`<option value="${s}" ${state.filter===s?"selected":""}>${s==="ALL"?"All statuses":s.replaceAll("_"," ").toLowerCase()}</option>`).join("")}</select></label></div></div><div class="table-scroll"><table><thead><tr><th>STUDENT</th><th>ROLL NUMBER</th><th>CHECK-IN TIME</th><th>STATUS</th><th>VALIDATION</th><th>ACTION</th></tr></thead><tbody>${displayed.map(r=>`<tr><td><span class="person"><span class="avatar">${esc(initials(r.name))}</span><strong>${esc(r.name)}</strong></span></td><td>${esc(r.roll_number)}</td><td>${r.timestamp?timeText(r.timestamp):"—"}</td><td>${badge(r.status)}</td><td class="row-reason">${esc(r.reason || (r.status==="PRESENT"?"Validated":"—"))}</td><td>${r.id&&r.status!=="BLOCKED"?button(r.status==="UNDER_REVIEW"?"Review":"Manage","review","secondary",`data-id="${r.id}"`,"edit"):"—"}</td></tr>`).join("")}</tbody></table></div>${!displayed.length?empty("No matching students","Try a different search or attendance filter."):""}<div class="table-footer"><span>Showing ${displayed.length} of ${filtered.length} students</span>${limit?button("View all attendance","detail","ghost",`data-id="${state.selected}"`,"arrow"):'<span>Signals indicate risk, not proof of misconduct.</span>'}</div></section>`;
}
function overviewView() {
  if (state.user.role==="student") return studentOverview();
  const s=state.detail;
  return pageHead("Attendance overview","A clearer picture of your classroom, all in one place.",button("Export report","export-daily","secondary","","download")+button("New session","new-session"),"YOUR CLASSROOM, AT A GLANCE")+`<div class="welcome-banner"><span class="welcome-icon">${icon("shield")}</span><div><strong>Welcome back, ${esc(state.user.name.split(" ")[0])}.</strong><p>${s?"Your attendance workspace is up to date. Here’s how your class is doing.":"Create your first class session to start collecting secure attendance."}</p></div><span class="badge"><span class="dot"></span>Live workspace</span></div>${s?`<div class="section-head"><h2>Session snapshot</h2><label><span class="sr-only">Selected session</span><select id="session-select" class="session-select">${state.sessions.map(x=>`<option value="${x.id}" ${x.id===state.selected?"selected":""}>${esc(x.course_code)} · ${dateText(x.starts_at)} · #${x.id}</option>`).join("")}</select></label></div>`:""}`+stats(s)+(s?`<div class="overview-grid">${sessionCard(s)}${breakdown(s)}</div>${attendanceTable(s.attendance,"Recent classroom activity",6)}`:`<div class="card">${empty("Your next class starts here","Add a course and students, then create a class session. Your attendance data will appear here.",button("Create a session","new-session"))}</div>`);
}
function sessionsView() {
  if (state.showDetail && state.detail) {
    const s=state.detail;
    return `<div class="detail-head"><div>${button("All sessions","all-sessions","ghost","","arrow")}<h1>${esc(s.subject)}</h1><p class="details-sub">${esc(s.faculty_name)} · ${dateText(s.starts_at)} · ${timeText(s.starts_at)} – ${timeText(s.ends_at)}</p></div><div class="actions">${button("Headcount","headcount","secondary",`data-id="${s.id}"`,"users")}${button("Generate QR","qr","primary",`data-id="${s.id}" ${s.closed?"disabled":""}`,"qr")}${!s.closed?button("Close class","close-session","secondary",`data-id="${s.id}"`,"lock"):sessionBadge(s)}</div></div>${stats(s)}${attendanceTable(s.attendance)}`;
  }
  const rows=state.sessions.filter(s=>`${s.subject} ${s.faculty_name}`.toLowerCase().includes(state.query.toLowerCase()));
  return pageHead("Class sessions","Create a classroom, share its QR, and track every check-in.",button("New session","new-session"))+`<section class="card table-card"><div class="table-scroll"><table><thead><tr><th>CLASS SESSION</th><th>DATE & TIME</th><th>HEADCOUNT</th><th>RESPONSES</th><th>STATUS</th><th></th></tr></thead><tbody>${rows.map(s=>`<tr><td><div class="person"><span class="avatar">${icon("book")}</span><span><strong>${esc(s.subject)}</strong><small>${esc(s.course_code)} · ${esc(s.faculty_name)}</small></span></div></td><td>${dateText(s.starts_at)}<br><span class="tiny muted">${timeText(s.starts_at)} – ${timeText(s.ends_at)}</span></td><td>${s.headcount??"Not entered"} / ${s.class_strength}</td><td>${s.responses}${s.suspicious?` <span class="badge orange">${s.suspicious} review</span>`:""}</td><td>${sessionBadge(s)}</td><td>${button("Open class","detail","secondary",`data-id="${s.id}"`,"arrow")}</td></tr>`).join("")}</tbody></table></div>${!rows.length?empty("No sessions yet","Create a session for an active course to get started."):""}</section>`;
}
function studentsView() {
  const rows=state.users.filter(u=>u.role==="student"&&`${u.name} ${u.email} ${u.roll_number} ${u.department}`.toLowerCase().includes(state.query.toLowerCase()));
  return pageHead("Student directory","Keep your classroom roster organized and up to date.",button("Add student","new-user"))+`<section class="card table-card"><div class="section-head"><h2>All students <span class="badge gray">${rows.length}</span></h2><span class="tiny muted">Enrollment follows department and semester</span></div><div class="table-scroll"><table><thead><tr><th>STUDENT</th><th>ROLL NUMBER</th><th>DEPARTMENT</th><th>SEMESTER</th><th>ACCOUNT</th><th></th></tr></thead><tbody>${rows.map(u=>`<tr><td><span class="person"><span class="avatar">${esc(initials(u.name))}</span><span><strong>${esc(u.name)}</strong><small>${esc(u.email)}</small></span></span></td><td>${esc(u.roll_number)}</td><td>${esc(u.department)}</td><td>Semester ${u.semester}</td><td><span class="badge ${u.active?"":"gray"}">${u.active?"Active":"Inactive"}</span></td><td>${button("Edit","edit-student","secondary",`data-id="${u.id}"`,"edit")}</td></tr>`).join("")}</tbody></table></div>${!rows.length?empty("No students found","Add students to build your classroom roster."):""}<div class="table-footer"><span>${rows.length} student accounts</span><span>Existing session rosters are preserved when profiles change.</span></div></section>`;
}
function coursesView() {
  const rows=state.courses.filter(c=>`${c.name} ${c.code}`.toLowerCase().includes(state.query.toLowerCase()));
  return pageHead("Your courses","The foundation for every well-connected classroom.",state.user.role==="admin"?button("Add faculty","new-faculty","secondary","","users")+button("Add course","new-course"):"")+`<div class="course-grid">${rows.map(c=>`<article class="card card-pad course-card"><span class="course-symbol">${icon("book")}</span><p class="eyebrow">${esc(c.code)}</p><h2>${esc(c.name)}</h2><p>${esc(c.department)} · Semester ${c.semester}<br>${esc(c.faculty_name)}</p><div class="course-foot"><span class="badge ${c.active?"":"gray"}">${c.active?"Active course":"Archived"}</span>${state.user.role==="admin"?button("Edit course","edit-course","ghost",`data-id="${c.id}"`,"edit"):button("New session","new-session","ghost",`data-id="${c.id}"`,"plus")}</div></article>`).join("")}</div>${!rows.length?`<div class="card">${empty("No courses yet","An administrator can add courses and assign faculty members.")}</div>`:""}`;
}
async function loadReport() {state.report=await api(`/reports?period=${state.reportPeriod}&day=${state.reportDay}`);}
function reportsView() {
  const rows=(state.report?.rows||[]).filter(r=>`${r.student} ${r.roll_number} ${r.subject}`.toLowerCase().includes(state.query.toLowerCase()));
  return pageHead("Attendance reports","From daily check-ins to the bigger picture. Reporting dates use UTC.",button("Download CSV","export-report","primary","","download"))+`<section class="card table-card"><div class="section-head"><h2>Attendance register</h2><div class="filters"><label><span class="sr-only">Report period</span><select id="report-period">${[["daily","Daily attendance"],["monthly","Monthly attendance"],["suspicious","Suspicious attendance"]].map(([v,l])=>`<option value="${v}" ${v===state.reportPeriod?"selected":""}>${l}</option>`).join("")}</select></label><label><span class="sr-only">Report date</span><input id="report-day" type="date" value="${state.reportDay}" required></label></div></div><div class="table-scroll"><table><thead><tr><th>DATE</th><th>STUDENT</th><th>ROLL NUMBER</th><th>SUBJECT</th><th>STATUS</th><th>VALIDATION</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r.date)}</td><td>${esc(r.student)}</td><td>${esc(r.roll_number)}</td><td>${esc(r.subject)}</td><td>${badge(r.status)}</td><td class="row-reason">${esc(r.reason||"—")}</td></tr>`).join("")}</tbody></table></div>${!rows.length?empty("No records for this period","Try another date or report type."):""}<div class="table-footer"><span>${rows.length} attendance records</span><span>CSV export includes the full selected report.</span></div></section>`;
}
function activityView() {
  const audit=state.activityTab==="audit";
  const logs=(audit?state.audit||[]:state.logs).filter(l=>JSON.stringify(l).toLowerCase().includes(state.query.toLowerCase()));
  return pageHead("Activity & review","A transparent record of validation signals and decisions.",button("Refresh","refresh","secondary","","refresh"))+`<div class="welcome-banner"><span class="welcome-icon">${icon("shield")}</span><div><strong>Signals are a starting point, not a verdict.</strong><p>Shared devices and reported locations need human judgment. Review the class before making a decision.</p></div></div>${state.user.role==="admin"?`<div class="tabs"><button data-action="activity-tab" data-tab="fraud" class="${!audit?"active":""}">Validation signals</button><button data-action="activity-tab" data-tab="audit" class="${audit?"active":""}">Audit trail</button></div>`:""}<section class="card activity-list">${logs.map(l=>`<article class="activity-item">${icon(audit?"activity":"alert")}<div><h3>${esc((l.kind||l.action).replaceAll("_"," "))}${l.student_name?` · ${esc(l.student_name)}`:""}</h3><p>${esc(l.detail)}</p>${l.session_id?`<button class="btn btn-ghost btn-small" data-action="detail" data-id="${l.session_id}">${esc(l.subject)} · Review class ${icon("arrow")}</button>`:""}</div><time>${dateText(l.timestamp)}<br>${timeText(l.timestamp)}</time></article>`).join("")||empty("All clear for now","Validation signals and audit events will appear here.")}</section><p class="form-note">Showing the latest ${logs.length} matching events (up to 500). Invalid QR and duplicate attempts are logged, never counted as attendance.</p>`;
}
function studentSummary() {
  const complete=state.history.filter(h=>h.closed||new Date(h.ends_at)<new Date());
  const present=complete.filter(h=>h.record.status==="PRESENT").length;
  const review=state.history.filter(h=>h.record.status==="UNDER_REVIEW").length;
  return `<div class="stats student-stats">${[["Completed classes",complete.length,"Your enrolled sessions"],["Attendance rate",`${complete.length?Math.round(present/complete.length*100):0}%`,"Present / completed classes"],["Under review",review,"Awaiting faculty decision"]].map(([label,value,foot])=>`<div class="stat"><div class="stat-top">${label}${icon("calendar")}</div><div class="stat-value">${value}</div><div class="stat-foot">${foot}</div></div>`).join("")}</div>`;
}
function studentOverview() {
  return pageHead(`Hello, ${state.user.name.split(" ")[0]}.`,"Your classes, check-ins, and progress — together in one place.",button("Check in to class","go-checkin","primary","","qr"),"MAKE EVERY CLASS COUNT")+studentSummary()+`<div class="welcome-banner"><span class="welcome-icon">${icon("qr")}</span><div><strong>Ready for your next class?</strong><p>Scan your faculty’s QR with your phone camera, or open the check-in page. Stay signed in for a faster check-in.</p></div></div>`+historyTable();
}
function historyTable() {
  const rows=state.history.filter(h=>h.subject.toLowerCase().includes(state.query.toLowerCase()));
  return `<section class="card table-card"><div class="section-head"><h2>My class history</h2><span class="tiny muted">Your records only</span></div><div class="table-scroll"><table><thead><tr><th>CLASS</th><th>DATE</th><th>CHECK-IN</th><th>STATUS</th><th>NOTE</th></tr></thead><tbody>${rows.map(h=>`<tr><td>${esc(h.subject)}<br><span class="tiny muted">${esc(h.course_code)}</span></td><td>${dateText(h.starts_at)}<br><span class="tiny muted">${timeText(h.starts_at)}</span></td><td>${h.record.timestamp?timeText(h.record.timestamp):"—"}</td><td>${h.record.status==="ABSENT"&&!h.closed&&new Date(h.ends_at)>new Date()?'<span class="badge gray">Not checked in</span>':badge(h.record.status)}</td><td class="row-reason">${esc(h.record.reason||"—")}</td></tr>`).join("")}</tbody></table></div>${!rows.length?empty("No classes yet","Your enrolled class sessions will appear here."):""}</section>`;
}
function historyView() {return pageHead("My attendance","A simple, transparent view of your class participation.")+studentSummary()+historyTable();}
function checkinView() {
  return pageHead("Check in to class","Scan the classroom QR. Your attendance is linked to your signed-in account.")+`<div class="scan-layout"><section class="card card-pad"><span class="course-symbol">${icon("qr")}</span><h2>Classroom check-in</h2><p>Use your phone camera to open the QR link, or paste the full link shared by your faculty.</p><form id="scan-form">${field("QR check-in link","url","url",pendingScan?`${location.origin}/#session=${pendingScan.session_id}&token=${encodeURIComponent(pendingScan.token)}`:"","required placeholder=\"https://campus.example/#session=…&token=…\"")}<p class="form-note">Location is optional unless your class uses a classroom boundary. Your browser will ask permission before sharing it.</p><label class="check-field"><input type="checkbox" name="location"> Include my current location</label><p class="form-error" role="alert"></p><button class="btn btn-primary btn-wide" type="submit">${icon("check")}Submit attendance</button></form><div id="scan-result"></div></section><section class="card card-pad"><span class="course-symbol">${icon("camera")}</span><h2>Scan with this device</h2><p>On supported browsers, scan directly with your camera. Otherwise, use your phone’s built-in camera and open the detected link.</p>${button("Open camera","camera","secondary","","camera")}<video id="camera-preview" autoplay playsinline muted hidden></video><p class="form-note" id="camera-note">Camera access requires HTTPS or localhost. If scanning is unavailable, paste the QR link instead.</p><div class="notice">${icon("clock")}<span>QR codes are valid for up to 5 minutes. A refreshed QR replaces the previous one. Each student may check in once per session.</span></div></section></div>`;
}

function userForm(role="student", user=null) {
  modalOpen(user?"Edit student":role==="faculty"?"Add faculty member":"Add student",user?"Updates apply to future rosters. Existing attendance stays intact.":"Create an account with a strong initial password.",`<form id="user-form" data-id="${user?.id||""}" data-role="${role}"><div class="form-grid">${field("Full name","name","text",user?.name||"","required minlength=\"2\" maxlength=\"120\"")}${field("Email address","email","email",user?.email||"","required")}${!user?field("Initial password","password","password","","required minlength=\"12\" maxlength=\"128\" autocomplete=\"new-password\""):""}${role==="student"?field("Roll number","roll_number","text",user?.roll_number||"","required maxlength=\"40\"")+field("Department","department","text",user?.department||"Computer Science","required")+field("Semester","semester","number",user?.semester||4,"required min=\"1\" max=\"12\""):""}</div>${user?`<p class="form-note">Inactive students cannot sign in and are excluded from future class rosters.</p><label class="check-field"><input type="checkbox" name="active" ${user.active?"checked":""}> Account is active</label>`:'<p class="form-note">Passwords must be at least 12 characters. Share credentials privately with the account holder.</p>'}${formEnd(user?"Save changes":"Create account")}`);
}
function courseForm(course=null) {
  const faculty=state.users.filter(u=>u.role==="faculty"&&u.active);
  if (!faculty.length) {toast("Add a faculty member before creating a course.");return userForm("faculty");}
  modalOpen(course?"Edit course":"Create a course","Students are enrolled by matching department and semester.",`<form id="course-form" data-id="${course?.id||""}"><div class="form-grid">${field("Course code","code","text",course?.code||"","required minlength=\"2\" maxlength=\"30\"")}${field("Course name","name","text",course?.name||"","required minlength=\"2\"")}${selectField("Assigned faculty","faculty_id",faculty.map(f=>[f.id,f.name]),course?.faculty_id)}${field("Department","department","text",course?.department||"Computer Science","required")}${field("Semester","semester","number",course?.semester||4,"required min=\"1\" max=\"12\"")}</div><p class="form-note">Changing a course does not reassign faculty or students in existing sessions.</p><label class="check-field"><input type="checkbox" name="active" ${!course||course.active?"checked":""}> Course is active</label>${formEnd("Save course")}`);
}
function sessionForm(courseId) {
  const courses=state.courses.filter(c=>c.active);
  if (!courses.length) return toast("An administrator must add an active course first.",true);
  const localDate=d=>new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);
  modalOpen("Create a class session","The current course roster is saved when you create the session.",`<form id="session-form"><div class="form-grid">${selectField("Course","course_id",courses.map(c=>[c.id,`${c.code} · ${c.name}`]),courseId)}${field("Start time (local)","starts_at","datetime-local",localDate(new Date()),"required")}${field("End time (local)","ends_at","datetime-local",localDate(new Date(Date.now()+3600000)),"required")}</div><p class="form-note">Optional classroom boundary: fill all three values to require a location check. GPS is a review signal, not proof of physical presence.</p><div class="form-grid">${field("Latitude (optional)","latitude","number","","step=\"any\" min=\"-90\" max=\"90\"")}${field("Longitude (optional)","longitude","number","","step=\"any\" min=\"-180\" max=\"180\"")}${field("Radius in meters (optional)","radius_m","number","","min=\"10\" max=\"5000\"")}</div>${formEnd("Create session")}`);
}
async function qrModal(id) {
  const qr=await write(`/sessions/${id}/qr`);
  modalOpen("Scan. Check in. Settle in.","Display this QR in the classroom. Students must sign in to check in.",`<div class="qr-full"><img src="${esc(qr.image)}" alt="Classroom check-in QR code"><div class="countdown" id="qr-countdown" role="timer"></div><p id="qr-status">One redemption per student · Five-minute expiry</p><label><span class="sr-only">QR check-in URL</span><input class="qr-link" value="${esc(qr.url)}" readonly id="qr-link"></label><div class="actions">${button("Copy link","copy-qr","secondary","","qr")}${button("Refresh QR","qr","primary",`data-id="${id}"`,"refresh")}</div><p class="form-note">Refreshing immediately invalidates the old code. Use a reachable PUBLIC_URL for students on other devices.</p></div>`);
  const tick=()=>{const left=Math.max(0,Math.ceil((new Date(qr.expires_at)-Date.now())/1000));const timer=document.querySelector("#qr-countdown");if(timer)timer.textContent=`${Math.floor(left/60).toString().padStart(2,"0")}:${(left%60).toString().padStart(2,"0")}`;if(!left){clearInterval(qrTimer);document.querySelector("#qr-status").textContent="This code expired. Refresh to continue.";}};
  tick();qrTimer=setInterval(tick,1000);
}
function reviewForm(id) {
  const row=state.detail?.attendance.find(r=>r.id===id);
  modalOpen("Review attendance",row?`${row.name} · ${row.roll_number}`:"Record a decision with a clear explanation.",`<form id="review-form" data-id="${id}">${row?.reason?`<div class="notice">${icon("alert")}${esc(row.reason)}</div>`:""}<p class="form-note">Approvals cannot exceed the actual headcount. If capacity is full, correct the headcount or block an incorrect approval first.</p><div class="form-grid">${selectField("Decision","decision",[["PRESENT","Approve as present"],["BLOCKED","Block attendance"]])}${field("Reason for decision","reason","text","","required minlength=\"5\" maxlength=\"500\"")}</div>${formEnd("Save decision")}`);
}
async function refresh() {await loadData();if(state.page==="reports")await loadReport();if(state.page==="activity"&&state.activityTab==="audit")state.audit=await api("/audit-logs");renderContent();}
async function exportCsv(period,day) {
  const response=await fetch(`/api/reports?period=${period}&day=${day}&download=true`,{credentials:"same-origin"});
  if(!response.ok)throw new Error("Report export failed. Please sign in and try again.");
  const url=URL.createObjectURL(await response.blob());const link=document.createElement("a");link.href=url;link.download=`attendance-${period}-${day}.csv`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast("Report downloaded");
}
async function startCamera() {
  if(!("BarcodeDetector" in window)||!navigator.mediaDevices?.getUserMedia)throw new Error("This browser does not support in-app QR scanning. Use your phone camera or paste the QR link.");
  stopCamera();cameraStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:"environment"},audio:false});
  const video=document.querySelector("#camera-preview");if(!video){stopCamera();return;}video.hidden=false;video.srcObject=cameraStream;await video.play();
  const detector=new window.BarcodeDetector({formats:["qr_code"]});
  document.querySelector("#camera-note").textContent="Point the camera at the classroom QR code.";
  async function detect() {
    if(!cameraStream)return;
    try{const codes=await detector.detect(video);if(codes.length){document.querySelector('#scan-form input[name="url"]').value=codes[0].rawValue;stopCamera();video.hidden=true;toast("QR captured. Confirm and submit your attendance.");return;}}catch{ /* A frame may not be ready yet. */ }
    scanTimer=setTimeout(detect,350);
  }
  detect();
}

document.addEventListener("click", async event => {
  const target=event.target.closest("[data-action]");if(!target)return;
  const action=target.dataset.action,id=Number(target.dataset.id);
  target.disabled=true;
  try {
    if(action==="navigate")await navigate(target.dataset.page);
    else if(action==="logout"){await write("/auth/logout");state.user=null;closeModal();renderLogin();}
    else if(action==="close-modal")closeModal();
    else if(action==="new-user")userForm();
    else if(action==="new-faculty")userForm("faculty");
    else if(action==="edit-student")userForm("student",state.users.find(u=>u.id===id));
    else if(action==="new-course")courseForm();
    else if(action==="edit-course")courseForm(state.courses.find(c=>c.id===id));
    else if(action==="new-session")sessionForm(id);
    else if(action==="qr")await qrModal(id);
    else if(action==="copy-qr"){await navigator.clipboard.writeText(document.querySelector("#qr-link").value);toast("Check-in link copied");}
    else if(action==="headcount"){const s=state.sessions.find(x=>x.id===id);modalOpen("Set actual headcount","Count the students physically present. Responses beyond this count need review.",`<form id="headcount-form" data-id="${id}">${field("Actual students present","headcount","number",s?.headcount??"",`required min="0" max="${s?.class_strength||0}"`)}<p class="form-note">Class strength: ${s?.class_strength||0}. Saving recalculates attendance without discarding any response.</p>${formEnd("Save headcount")}`);}
    else if(action==="detail"){state.selected=id;state.detail=await api(`/sessions/${id}`);state.showDetail=true;await navigate("sessions");}
    else if(action==="all-sessions"){state.showDetail=false;renderContent();}
    else if(action==="close-session")modalOpen("Close this class?","Further QR submissions will be rejected. Staff can still review existing records.",`<form id="close-session-form" data-id="${id}"><p class="form-note">Ensure the actual headcount is entered before closing.</p>${formEnd("Close session")}`);
    else if(action==="review")reviewForm(id);
    else if(action==="refresh"){await refresh();toast("Workspace updated");}
    else if(action==="export-daily")await exportCsv("daily",new Date().toISOString().slice(0,10));
    else if(action==="export-report")await exportCsv(state.reportPeriod,state.reportDay);
    else if(action==="activity-tab"){state.activityTab=target.dataset.tab;if(state.activityTab==="audit")state.audit=await api("/audit-logs");renderContent();}
    else if(action==="go-checkin")await navigate("checkin");
    else if(action==="camera")await startCamera();
  } catch(error){toast(error.message,true);} finally {target.disabled=false;}
});
document.addEventListener("input",event=>{if(event.target.id==="search-input"){state.query=event.target.value;renderContent();}});
document.addEventListener("change",async event=>{
  try{
    if(event.target.id==="status-filter"){state.filter=event.target.value;renderContent();}
    if(event.target.id==="session-select"){state.selected=Number(event.target.value);state.detail=await api(`/sessions/${state.selected}`);renderContent();}
    if(event.target.id==="report-period"||event.target.id==="report-day"){const day=document.querySelector("#report-day").value;if(!day)return;state.reportPeriod=document.querySelector("#report-period").value;state.reportDay=day;await loadReport();renderContent();}
  }catch(error){toast(error.message,true);}
});
document.addEventListener("submit",async event=>{
  event.preventDefault();const form=event.target;const submit=form.querySelector('[type="submit"]');if(!submit)return;submit.disabled=true;
  const errorEl=form.querySelector(".form-error");if(errorEl)errorEl.textContent="";
  const data=Object.fromEntries(new FormData(form));
  try {
    if(form.id==="login-form"){state.user=await write("/auth/login",data);state.page=pendingScan&&state.user.role==="student"?"checkin":"overview";state.selected=null;state.showDetail=false;state.query="";await loadData();renderShell();return;}
    if(form.id==="user-form") {data.semester=Number(data.semester||1);if(form.dataset.id){data.active=!!data.active;await write(`/students/${form.dataset.id}`,data,"PUT");}else{data.role=form.dataset.role;await write("/users",data);}}
    if(form.id==="course-form"){data.faculty_id=Number(data.faculty_id);data.semester=Number(data.semester);data.active=!!data.active;await write(`/courses${form.dataset.id?`/${form.dataset.id}`:""}`,data,form.dataset.id?"PUT":"POST");}
    if(form.id==="session-form"){data.course_id=Number(data.course_id);data.starts_at=new Date(data.starts_at).toISOString();data.ends_at=new Date(data.ends_at).toISOString();for(const key of ["latitude","longitude","radius_m"])data[key]=data[key]===""?null:Number(data[key]);const created=await write("/sessions",data);state.selected=created.id;}
    if(form.id==="headcount-form")await write(`/sessions/${form.dataset.id}/headcount`,{headcount:Number(data.headcount)},"PUT");
    if(form.id==="review-form")await write(`/attendance/${form.dataset.id}/review`,data,"PUT");
    if(form.id==="close-session-form")await write(`/sessions/${form.dataset.id}/close`);
    if(form.id==="scan-form") {
      let parsed;try{const url=new URL(data.url);if(url.origin!==location.origin)throw new Error();parsed=new URLSearchParams(url.hash.slice(1));}catch{throw new Error("Use a valid QR link from this attendance workspace.");}
      const payload={session_id:Number(parsed.get("session")),token:parsed.get("token"),device_id:deviceId()};
      if(!payload.session_id||!payload.token)throw new Error("The link must include a session and QR token.");
      if(data.location){if(!navigator.geolocation)throw new Error("Location is unavailable in this browser.");const pos=await new Promise((resolve,reject)=>navigator.geolocation.getCurrentPosition(resolve,reject,{enableHighAccuracy:true,timeout:12000,maximumAge:0}));payload.latitude=pos.coords.latitude;payload.longitude=pos.coords.longitude;}
      const result=await write("/attendance/scan",payload);pendingScan=null;stopCamera();await loadData();
      form.hidden=true;document.querySelector("#scan-result").innerHTML=`<div class="scan-result">${icon(result.status==="PRESENT"?"check":"clock")}<h2>${esc(result.message)}</h2>${badge(result.status)}<p>Your faculty validates attendance against the actual classroom headcount.</p>${button("View my attendance","navigate","secondary",'data-page="history"',"arrow")}</div>`;toast(result.message);return;
    }
    closeModal();await refresh();toast("Changes saved successfully");
  }catch(error){if(errorEl)errorEl.textContent=error.message;else toast(error.message,true);}finally{submit.disabled=false;}
});
function deviceId() {let id=localStorage.getItem("attendly_device");if(!id){id=crypto.randomUUID();localStorage.setItem("attendly_device",id);}return id;}
window.addEventListener("beforeunload",stopCamera);
async function boot() {
  try{state.user=await api("/auth/me");if(pendingScan&&state.user.role==="student")state.page="checkin";await loadData();renderShell();}
  catch(error){if(state.user)toast(error.message,true);state.user=null;renderLogin();}
}
setInterval(async()=>{
  if(!state.user||modal.open||document.hidden||refreshBusy||!["overview","sessions","history"].includes(state.page))return;
  refreshBusy=true;try{await refresh();}catch{/* Explicit refresh surfaces connection errors without repeated toasts. */}finally{refreshBusy=false;}
},30000);
boot();