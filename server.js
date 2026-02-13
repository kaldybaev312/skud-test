const express = require("express");
const app = express();
app.use(express.json());

// ====== CONFIG ======
const PORT = process.env.PORT || 3000;

// В Render: Environment -> AGENT_TOKEN
const AGENT_TOKEN = process.env.AGENT_TOKEN || "mySecret123";

// начало занятий и "льгота" опоздания
const START_TIME = process.env.START_TIME || "09:00";
const GRACE_MIN = Number(process.env.GRACE_MIN || 5);

// ====== STUDENTS (проверочный список) ======
// КЛЮЧ Map = employeeNo (как приходит из терминала)
const students = new Map([
  ["00724246", { lyceumId: "00724246", name: "Илим", group: "Группа A" }],
  // добавляйте сюда остальных:
  // ["00000001", { lyceumId:"00000001", name:"...", group:"Группа A" }],
]);

// ====== STORAGE (in-memory) ======
/**
 * attendance: employeeNo -> Map(dateKey -> {present, late, firstIn, lastIn, count})
 */
const attendance = new Map();

/**
 * rawEvents: last N events for debugging
 */
const rawEvents = [];
const RAW_LIMIT = 200;

// ====== HELPERS ======
function pad2(n) {
  return String(n).padStart(2, "0");
}

function dateKeyFromAnyTime(value) {
  // принимаем ISO или "YYYY-MM-DDTHH:mm:ss" (локальное)
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  return `${yyyy}-${mm}-${dd}`;
}

function timeHHMMFromAnyTime(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function minutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function isLate(firstInHHMM) {
  return minutes(firstInHHMM) > (minutes(START_TIME) + GRACE_MIN);
}

function upsertAttendance(employeeNo, timeValue, payload) {
  const dk = dateKeyFromAnyTime(timeValue);
  const hhmm = timeHHMMFromAnyTime(timeValue);
  if (!dk || !hhmm) return { ok: false, error: "bad time format" };

  if (!attendance.has(employeeNo)) attendance.set(employeeNo, new Map());
  const byDate = attendance.get(employeeNo);

  const prev = byDate.get(dk);

  // первое время прихода — самое раннее
  let firstIn = prev?.firstIn ?? hhmm;
  if (minutes(hhmm) < minutes(firstIn)) firstIn = hhmm;

  // последнее событие — самое позднее (для справки)
  let lastIn = prev?.lastIn ?? hhmm;
  if (minutes(hhmm) > minutes(lastIn)) lastIn = hhmm;

  const rec = {
    present: true,
    late: isLate(firstIn),
    firstIn,
    lastIn,
    count: (prev?.count || 0) + 1,
    lastPayload: payload,
  };

  byDate.set(dk, rec);
  return { ok: true, date: dk, time: hhmm, rec };
}

function monthDays(monthYYYYMM) {
  const [y, m] = monthYYYYMM.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return Array.from({ length: last }, (_, i) => {
    const d = pad2(i + 1);
    return `${monthYYYYMM}-${d}`;
  });
}

// ====== API: health ======
app.get("/health", (req, res) => res.json({ ok: true }));

// ====== API: receive events from Agent ======
app.post("/api/agent/sync", (req, res) => {
  const token = req.headers["x-agent-token"];
  if (token !== AGENT_TOKEN) {
    return res.status(401).json({ ok: false, error: "Bad token" });
  }

  const employeeNo = String(req.body.employeeNo || "").trim();
  const time = req.body.time || new Date().toISOString();

  if (!employeeNo) return res.status(400).json({ ok: false, error: "employeeNo required" });

  // логируем сырое событие (для диагностики)
  rawEvents.unshift({ at: new Date().toISOString(), employeeNo, time, body: req.body });
  if (rawEvents.length > RAW_LIMIT) rawEvents.pop();

  // если хотите принимать "неизвестных" — можно не делать 404
  if (!students.has(employeeNo)) {
    return res.status(404).json({
      ok: false,
      error: "student not found",
      hint: "Добавьте employeeNo в students Map или проверьте ведущие нули",
      employeeNo,
    });
  }

  const r = upsertAttendance(employeeNo, time, req.body);
  if (!r.ok) return res.status(400).json(r);

  res.json({
    ok: true,
    employeeNo,
    date: r.date,
    time: r.time,
    late: r.rec.late,
    firstIn: r.rec.firstIn,
    count: r.rec.count,
  });
});

// ====== API: attendance matrix ======
app.get("/api/attendance", (req, res) => {
  const group = req.query.group || "Группа A";
  const month = req.query.month || new Date().toISOString().slice(0, 7); // YYYY-MM

  const days = monthDays(month);

  const out = [];
  for (const [id, s] of students.entries()) {
    if (s.group !== group) continue;

    const byDate = attendance.get(id) || new Map();
    const map = {};
    for (const d of days) {
      const rec = byDate.get(d);
      map[d] = rec ? { present: true, late: rec.late, firstIn: rec.firstIn } : null;
    }

    out.push({ ...s, days: map });
  }

  res.json({ ok: true, group, month, startTime: START_TIME, graceMin: GRACE_MIN, students: out });
});

// ====== API: last raw events (debug) ======
app.get("/api/debug/events", (req, res) => {
  res.json({ ok: true, count: rawEvents.length, events: rawEvents });
});

// ====== UI ======
app.get("/", (req, res) => {
  const nowMonth = new Date().toISOString().slice(0, 7);
  res.type("html").send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>СКУД — Проверочный сайт</title>
  <style>
    body{font-family:Arial,sans-serif;padding:16px}
    .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
    input,button{padding:8px;font-size:14px}
    table{border-collapse:collapse;margin-top:12px;width:100%;font-size:12px}
    th,td{border:1px solid #ddd;padding:6px;text-align:center}
    th{position:sticky;top:0;background:#f7f7f7}
    .ok{background:#c9f7c9}
    .late{background:#ffe7a6}
    .abs{background:#ffd1d1}
    .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
    .small{font-size:11px;color:#333}
  </style>
</head>
<body>
  <h2>СКУД — Проверочный сайт</h2>

  <div class="row">
    <label>Месяц:</label>
    <input id="month" class="mono" value="${nowMonth}">
    <button onclick="load()">Обновить</button>
    <span class="small">Старт: <b>${START_TIME}</b>, льгота: <b>${GRACE_MIN} мин</b></span>
  </div>

  <h3>Ручной тест (проверка сервера)</h3>
  <div class="row">
    <label>employeeNo:</label>
    <input id="emp" class="mono" value="00724246">
    <label>token:</label>
    <input id="token" class="mono" value="${AGENT_TOKEN}">
    <button onclick="sendTest()">Отправить</button>
  </div>
  <pre id="resp" class="mono"></pre>

  <h3>Журнал</h3>
  <div id="tbl"></div>

<script>
function daysInMonth(ym){
  const [y,m]=ym.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

async function sendTest(){
  const employeeNo = document.getElementById('emp').value.trim();
  const token = document.getElementById('token').value.trim();
  const time = new Date().toISOString();
  const r = await fetch('/api/agent/sync', {
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      'x-agent-token': token
    },
    body: JSON.stringify({ employeeNo, time, result:'granted', source:'manual' })
  });
  const j = await r.json().catch(()=>({}));
  document.getElementById('resp').textContent = JSON.stringify(j,null,2);
  await load();
}

async function load(){
  const month = document.getElementById('month').value.trim();
  const r = await fetch('/api/attendance?group=' + encodeURIComponent('Группа A') + '&month=' + encodeURIComponent(month));
  const j = await r.json();
  const dim = daysInMonth(month);
  const days = [];
  for(let i=1;i<=dim;i++){
    days.push(month + '-' + String(i).padStart(2,'0'));
  }

  let html = '<table><thead><tr><th>EmployeeNo</th><th>ФИО</th>';
  for(const d of days){ html += '<th>'+d.slice(-2)+'</th>'; }
  html += '</tr></thead><tbody>';

  j.students.forEach(s => {
    html += '<tr><td class="mono">'+s.lyceumId+'</td><td>'+s.name+'</td>';
    days.forEach(dk => {
      const rec = s.days[dk];
      if(!rec){
        html += '<td class="abs"></td>';
      } else if(rec.late){
        html += '<td class="late">●<div class="mono" style="font-size:10px">'+rec.firstIn+'</div></td>';
      } else {
        html += '<td class="ok">●<div class="mono" style="font-size:10px">'+rec.firstIn+'</div></td>';
      }
    });
    html += '</tr>';
  });

  html += '</tbody></table>';
  document.getElementById('tbl').innerHTML = html;
}
load();
</script>
</body>
</html>
  `);
});

app.listen(PORT, () => console.log("Running on port", PORT));
