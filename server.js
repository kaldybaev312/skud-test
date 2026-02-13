const express = require("express");
const app = express();

app.use(express.json());

// ====== НАСТРОЙКИ ======
const PORT = process.env.PORT || 3000;

// 🔐 Токен (ты его сам задаёшь)
const AGENT_TOKEN = "mySecret123";

// Начало занятий
const START_TIME = "09:00";
const GRACE_MIN = 5;

// ====== СТУДЕНТЫ ======
const students = new Map([
  ["00724246", {
    lyceumId: "00724246",
    name: "Илим 00724246",
    group: "Группа A"
  }],
]);

// ====== ATTENDANCE ======
const attendance = new Map();

// ====== ВСПОМОГАТЕЛЬНОЕ ======
function toDateKey(iso) {
  const d = new Date(iso);
  return d.toISOString().slice(0, 10);
}

function toTimeHHMM(iso) {
  const d = new Date(iso);
  return d.toTimeString().slice(0, 5);
}

function minutesFromHHMM(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function computeLate(firstInHHMM) {
  const start = minutesFromHHMM(START_TIME);
  const inMin = minutesFromHHMM(firstInHHMM);
  return inMin > (start + GRACE_MIN);
}

function upsertAttendance(lyceumId, isoTime, raw) {
  const dateKey = toDateKey(isoTime);
  const timeHHMM = toTimeHHMM(isoTime);

  if (!attendance.has(lyceumId)) attendance.set(lyceumId, new Map());
  const mapByDate = attendance.get(lyceumId);

  const existing = mapByDate.get(dateKey);

  let firstIn = existing?.firstIn ?? timeHHMM;
  if (minutesFromHHMM(timeHHMM) < minutesFromHHMM(firstIn)) {
    firstIn = timeHHMM;
  }

  const late = computeLate(firstIn);

  mapByDate.set(dateKey, {
    present: true,
    late,
    firstIn,
    lastEvent: raw
  });
}

// ====== API: AGENT SYNC ======
app.post("/api/agent/sync", (req, res) => {

  // 🔐 Проверка токена
  const token = req.headers["x-agent-token"];

  if (token !== AGENT_TOKEN) {
    return res.status(401).json({
      ok: false,
      error: "Bad token"
    });
  }

  const employeeNo = String(req.body.employeeNo || "").trim();
  const time = req.body.time || new Date().toISOString();

  if (!employeeNo) {
    return res.status(400).json({
      ok: false,
      error: "employeeNo required"
    });
  }

  if (!students.has(employeeNo)) {
    return res.status(404).json({
      ok: false,
      error: "student not found"
    });
  }

  upsertAttendance(employeeNo, time, req.body);

  res.json({
    ok: true,
    employeeNo,
    date: toDateKey(time),
    time: toTimeHHMM(time)
  });
});

// ====== ATTENDANCE VIEW ======
app.get("/api/attendance", (req, res) => {

  const result = [];

  for (const [id, s] of students.entries()) {
    const byDate = attendance.get(id) || new Map();

    const days = {};
    for (const [dateKey, rec] of byDate.entries()) {
      days[dateKey] = rec;
    }

    result.push({ ...s, days });
  }

  res.json({
    ok: true,
    students: result
  });
});

// ====== UI ======
app.get("/", (req, res) => {
  res.send(`
    <h2>СКУД Тест</h2>
    <button onclick="send()">Отправить тест</button>
    <pre id="out"></pre>

    <script>
      async function send(){
        const r = await fetch('/api/agent/sync', {
          method:'POST',
          headers:{
            'Content-Type':'application/json',
            'x-agent-token':'mySecret123'
          },
          body: JSON.stringify({
            employeeNo:'00724246',
            time:new Date().toISOString()
          })
        });
        const j = await r.json();
        document.getElementById('out').textContent =
          JSON.stringify(j,null,2);
      }
    </script>
  `);
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
