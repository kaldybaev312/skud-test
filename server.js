const express = require("express");
const app = express();

app.use(express.json());

// ====== НАСТРОЙКИ ======
const PORT = process.env.PORT || 3000;
const START_TIME = "09:00";     // начало занятий
const GRACE_MIN = 5;            // допуск опоздания

// ====== ДАННЫЕ (в памяти) ======
/**
 * students: lyceumId -> { lyceumId, name, group }
 */
const students = new Map([
  ["105", { lyceumId: "105", name: "Студент 105", group: "Группа A" }],
  ["106", { lyceumId: "106", name: "Студент 106", group: "Группа A" }],
]);

/**
 * attendance: lyceumId -> Map(dateYYYYMMDD -> { present, late, firstIn, lastEvent })
 */
const attendance = new Map();

// ====== ВСПОМОГАТЕЛЬНОЕ ======
function toDateKey(isoOrDate) {
  const d = new Date(isoOrDate);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function toTimeHHMM(iso) {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function minutesFromHHMM(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function computeLate(firstInHHMM) {
  const start = minutesFromHHMM(START_TIME);
  const grace = GRACE_MIN;
  const inMin = minutesFromHHMM(firstInHHMM);
  return inMin > (start + grace);
}

function upsertAttendance(lyceumId, isoTime, raw) {
  const dateKey = toDateKey(isoTime);
  const timeHHMM = toTimeHHMM(isoTime);

  if (!attendance.has(lyceumId)) attendance.set(lyceumId, new Map());
  const mapByDate = attendance.get(lyceumId);

  const existing = mapByDate.get(dateKey);

  // Берём самое раннее время как "приход"
  let firstIn = existing?.firstIn ?? timeHHMM;
  if (minutesFromHHMM(timeHHMM) < minutesFromHHMM(firstIn)) firstIn = timeHHMM;

  const present = true;
  const late = computeLate(firstIn);

  mapByDate.set(dateKey, {
    present,
    late,
    firstIn,
    lastEvent: raw,
  });
}

// ====== API: приём события ======
app.post("/api/agent/sync", (req, res) => {
  const body = req.body || {};

  // Поддерживаем оба варианта названий
  const employeeNo = String(body.employeeNo ?? body.employeeId ?? body.id ?? "").trim();
  const result = String(body.result ?? body.accessResult ?? "granted").toLowerCase();
  const time = body.time ?? body.eventTime ?? new Date().toISOString();

  if (!employeeNo) {
    return res.status(400).json({ ok: false, error: "employeeNo is required" });
  }
  if (!students.has(employeeNo)) {
    return res.status(404).json({ ok: false, error: `student with lyceumId=${employeeNo} not found` });
  }

  // Считаем только успешный проход
  const granted = ["granted", "success", "ok", "allow"].includes(result);
  if (!granted) {
    return res.json({ ok: true, skipped: true, reason: `result=${result}` });
  }

  upsertAttendance(employeeNo, time, body);

  res.json({ ok: true, employeeNo, date: toDateKey(time), time: toTimeHHMM(time) });
});

// ====== API: посмотреть данные ======
app.get("/api/attendance", (req, res) => {
  const group = req.query.group || "Группа A";
  const month = req.query.month || toDateKey(new Date()).slice(0, 7); // YYYY-MM

  const result = [];
  for (const [id, s] of students.entries()) {
    if (s.group !== group) continue;
    const byDate = attendance.get(id) || new Map();

    // Собираем статусы только по нужному месяцу
    const days = {};
    for (const [dateKey, rec] of byDate.entries()) {
      if (dateKey.startsWith(month)) days[dateKey] = rec;
    }

    result.push({ ...s, days });
  }

  res.json({ ok: true, group, month, startTime: START_TIME, graceMin: GRACE_MIN, students: result });
});

// ====== Мини-страница ======
app.get("/", (req, res) => {
  res.type("html").send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>СКУД Тест</title>
  <style>
    body{font-family:Arial,sans-serif;padding:16px}
    .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    input,button{padding:8px;font-size:14px}
    table{border-collapse:collapse;margin-top:12px;width:100%}
    th,td{border:1px solid #ccc;padding:8px;text-align:center}
    .ok{background:#c8f7c5}
    .late{background:#ffe8a3}
    .abs{background:#ffd1d1}
    .mono{font-family:ui-monospace, SFMono-Regular, Menlo, monospace}
  </style>
</head>
<body>
  <h2>СКУД мини-тест (iVMS/Agent → API → Журнал)</h2>

  <div class="row">
    <label>Месяц (YYYY-MM):</label>
    <input id="month" value="${toDateKey(new Date()).slice(0,7)}" class="mono"/>
    <button onclick="load()">Обновить</button>
  </div>

  <h3>Ручная проверка (отправить событие)</h3>
  <div class="row">
    <label>employeeNo:</label>
    <input id="emp" value="105" class="mono"/>
    <label>time ISO:</label>
    <input id="time" value="${new Date().toISOString()}" class="mono" style="min-width:320px"/>
    <button onclick="sendTest()">Отправить /api/agent/sync</button>
  </div>
  <pre id="resp" class="mono"></pre>

  <h3>Журнал</h3>
  <div id="tbl"></div>

<script>
async function sendTest(){
  const employeeNo = document.getElementById('emp').value.trim();
  const time = document.getElementById('time').value.trim();
  const r = await fetch('/api/agent/sync', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ employeeNo, time, result:'granted', event:'access', deviceId:'TEST' })
  });
  const j = await r.json();
  document.getElementById('resp').textContent = JSON.stringify(j,null,2);
  await load();
}

function daysInMonth(ym){
  const [y,m]=ym.split('-').map(Number);
  const d = new Date(y, m, 0).getDate();
  return d;
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

  let html = '<table><thead><tr><th>№</th><th>ФИО</th>';
  for(const d of days){ html += '<th>'+d.slice(-2)+'</th>'; }
  html += '</tr></thead><tbody>';

  j.students.forEach((s, idx) => {
    html += '<tr><td class="mono">'+s.lyceumId+'</td><td>'+s.name+'</td>';
    days.forEach(dk => {
      const rec = s.days[dk];
      if(!rec){
        html += '<td class="abs"></td>';
      } else if(rec.late){
        html += '<td class="late">●<div class="mono" style="font-size:11px">'+rec.firstIn+'</div></td>';
      } else {
        html += '<td class="ok">●<div class="mono" style="font-size:11px">'+rec.firstIn+'</div></td>';
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

app.listen(PORT, () => {
  console.log(`SKUD test server: http://localhost:${PORT}`);
});
