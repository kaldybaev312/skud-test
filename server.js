const express = require("express");
const app = express();
app.use(express.json());

// ====== CONFIG ======
const PORT = process.env.PORT || 3000;
const AGENT_TOKEN = process.env.AGENT_TOKEN || "mySecret123";
const START_TIME = process.env.START_TIME || "09:00";
const GRACE_MIN = Number(process.env.GRACE_MIN || 5);

// ====== STUDENTS (можно частично, в тестовом режиме принимаем любых) ======
const students = new Map([
  ["00724246", { lyceumId: "00724246", name: "Илим", group: "Группа A" }],
  // добавляйте известных студентов по мере необходимости
]);

// ====== STORAGE (IN-MEMORY) ======
/**
 * attendance: employeeNo -> Map(dateKey -> {present, late, firstIn, lastIn, count, knownStudent, name})
 */
const attendance = new Map();

/**
 * rawEvents: последние события (для debug)
 */
const rawEvents = [];
const RAW_LIMIT = 300;

// ====== HELPERS ======
function pad2(n) {
  return String(n).padStart(2, "0");
}

function toDateKey(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function toTimeHHMM(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function minutesFromHHMM(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function computeLate(firstInHHMM) {
  return minutesFromHHMM(firstInHHMM) > (minutesFromHHMM(START_TIME) + GRACE_MIN);
}

function upsertAttendance(employeeNo, timeValue, knownStudent, name, raw) {
  const dateKey = toDateKey(timeValue);
  const timeHHMM = toTimeHHMM(timeValue);
  if (!dateKey || !timeHHMM) return { ok: false, error: "bad time format" };

  if (!attendance.has(employeeNo)) attendance.set(employeeNo, new Map());
  const byDate = attendance.get(employeeNo);

  const prev = byDate.get(dateKey);

  // самое раннее время = firstIn
  let firstIn = prev?.firstIn ?? timeHHMM;
  if (minutesFromHHMM(timeHHMM) < minutesFromHHMM(firstIn)) firstIn = timeHHMM;

  // самое позднее = lastIn
  let lastIn = prev?.lastIn ?? timeHHMM;
  if (minutesFromHHMM(timeHHMM) > minutesFromHHMM(lastIn)) lastIn = timeHHMM;

  const rec = {
    present: true,
    late: computeLate(firstIn),
    firstIn,
    lastIn,
    count: (prev?.count || 0) + 1,
    knownStudent,
    name,
    lastPayload: raw,
  };

  byDate.set(dateKey, rec);

  return { ok: true, dateKey, timeHHMM, rec };
}

function monthDays(monthYYYYMM) {
  const [y, m] = monthYYYYMM.split("-").map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const out = [];
  for (let i = 1; i <= lastDay; i++) {
    out.push(`${monthYYYYMM}-${pad2(i)}`);
  }
  return out;
}

// ====== ROUTES ======
app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/api/debug/events", (req, res) => {
  res.json({ ok: true, count: rawEvents.length, events: rawEvents });
});

// ТЕСТОВЫЙ РЕЖИМ: принимает ЛЮБОЙ employeeNo
app.post("/api/agent/sync", (req, res) => {
  const token = req.headers["x-agent-token"];
  if (token !== AGENT_TOKEN) {
    return res.status(401).json({ ok: false, error: "Bad token" });
  }

  const employeeNo = String(req.body.employeeNo || "").trim();
  const time = req.body.time || new Date().toISOString();

  if (!employeeNo) return res.status(400).json({ ok: false, error: "employeeNo required" });

  const student = students.get(employeeNo);
  const knownStudent = !!student;
  const name = student?.name || "UNKNOWN";

  // сохраняем raw событие
  rawEvents.unshift({
    at: new Date().toISOString(),
    employeeNo,
    time,
    knownStudent,
    name,
    body: req.body,
  });
  if (rawEvents.length > RAW_LIMIT) rawEvents.pop();

  // фиксируем посещаемость даже если UNKNOWN
  const r = upsertAttendance(employeeNo, time, knownStudent, name, req.body);
  if (!r.ok) return res.status(400).json(r);

  // ответ
  res.json({
    ok: true,
    mode: "test",
    employeeNo,
    knownStudent,
    name,
    date: r.dateKey,
    time: r.timeHHMM,
    late: r.rec.late,
    firstIn: r.rec.firstIn,
    count: r.rec.count,
  });
});

app.get("/api/attendance", (req, res) => {
  const group = req.query.group || "Группа A";
  const month = req.query.month || new Date().toISOString().slice(0, 7); // YYYY-MM

  const days = monthDays(month);

  // собираем список всех ID: известных + тех, кто уже засветился (UNKNOWN)
  const ids = new Set([...students.keys()]);
  for (const [id] of attendance.entries()) ids.add(id);

  const out = [];
  for (const id of ids) {
    const known = students.get(id);
    const name = known?.name || "UNKNOWN";
    const groupName = known?.group || group;

    // показываем только выбранную группу (UNKNOWN считаем относящимися к выбранной группе)
    if (known && known.group !== group) continue;

    const byDate = attendance.get(id) || new Map();
    const dayMap = {};
    for (const d of days) {
      const rec = byDate.get(d);
      dayMap[d] = rec ? { present: true, late: rec.late, firstIn: rec.firstIn } : null;
    }

    out.push({
      lyceumId: id,
      name,
      group: groupName,
      knownStudent: !!known,
      days: dayMap,
    });
  }

  // сортируем: known сверху, UNKNOWN снизу
  out.sort((a, b) => Number(b.knownStudent) - Number(a.knownStudent) || a.lyceumId.localeCompare(b.lyceumId));

  res.json({ ok: true, group, month, startTime: START_TIME, graceMin: GRACE_MIN, students: out });
});

app.get("/", (req, res) => {
  const nowMonth = new Date().toISOString().slice(0, 7);
  res.type("html").send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>СКУД — Проверка</title>
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
    .unknown{opacity:.75}
    .badge{padding:2px 6px;border-radius:8px;font-size:11px;border:1px solid #ccc}
  </style>
</head>
<body>
  <h2>СКУД — Проверочный сайт (TEST MODE)</h2>

  <div class="row">
    <label>Месяц:</label>
    <input id="month" class="mono" value="${nowMonth}">
    <button onclick="load()">Обновить</button>
    <span class="badge">Старт: ${START_TIME}</span>
    <span class="badge">Льгота: ${GRACE_MIN} мин</span>
  </div>

  <h3>Ручной тест (сервер)</h3>
  <div class="row">
    <label>employeeNo:</label>
    <input id="emp" class="mono" value="00724246">
    <label>token:</label>
    <input id="token" class="mono" value="${AGENT_TOKEN}">
    <button onclick="sendTest()">Отправить</button>
    <a href="/api/debug/events" target="_blank">debug events</a>
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

  let html = '<table><thead><tr><th>EmployeeNo</th><th>ФИО</th><th>Known</th>';
  for(const d of days){ html += '<th>'+d.slice(-2)+'</th>'; }
  html += '</tr></thead><tbody>';

  j.students.forEach(s => {
    const cls = s.knownStudent ? '' : ' class="unknown"';
    html += '<tr'+cls+'><td class="mono">'+s.lyceumId+'</td><td>'+s.name+'</td><td>'+(s.knownStudent?'YES':'NO')+'</td>';

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
