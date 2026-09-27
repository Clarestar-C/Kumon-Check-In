import { useEffect, useMemo, useRef, useState } from 'react';
import { onValue, set as dbSet } from 'firebase/database';
import { connectedRef, ensureSignedIn, stateRef } from './firebase';

const LS_KEY = 'kumon-checkin-v2';
const OLD_KEY = 'kumon-checkin-v1';
const TZ = 'America/Toronto';

// Dropdown choices for session length (minutes). Covers typical Kumon slots.
const PRESETS = [15, 30, 45, 60, 90, 120];

// Kumon levels, from the earliest (7A) to the most advanced (O).
const KUMON_LEVELS = [
  '7A', '6A', '5A', '4A', '3A', '2A',
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O',
];
const SUBJECTS = [
  { id: 'math', label: 'Math' },
  { id: 'reading', label: 'Reading' },
];
// Compact "Math G · Reading D" summary for lists; '—' when not set.
const levelSummary = (s) =>
  SUBJECTS.map((sub) => sub.label + ' ' + (s[sub.id + 'Level'] || '—')).join(' · ');

const DAYS = [
  { id: 'mon', label: 'Monday' },
  { id: 'thu', label: 'Thursday' },
  { id: 'sat', label: 'Saturday' },
];
const dayLabel = (id) => (DAYS.find((d) => d.id === id) || {}).label || id;

/* ---------------- helpers ---------------- */

function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function normalize(p) {
  // Auto-close any session left open from a previous day (in Eastern Time),
  // so a forgotten check-out doesn't show the student as "here" next week.
  // Checkout is assumed at the end of their preset time and marked as auto.
  // Firebase may hand back plain objects instead of arrays; accept both.
  const toArray = (v) =>
    Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : [];
  const todayKey = etDateKey(new Date().toISOString());
  const sessions = toArray(p.sessions).map((s) => {
    if (!s.out && etDateKey(s.in) !== todayKey) {
      const allotted = Number(s.allotted) > 0 ? Number(s.allotted) : 60;
      return {
        ...s,
        out: new Date(new Date(s.in).getTime() + allotted * 60000).toISOString(),
        autoClosed: true,
      };
    }
    return s;
  });
  return {
    centerName: p.centerName || 'Kumon',
    defaultMinutes: Number(p.defaultMinutes) > 0 ? Number(p.defaultMinutes) : 60,
    // clearedAt marks a deliberate "delete everything" so other devices can
    // tell it apart from a database that simply has no data yet.
    clearedAt: Number(p.clearedAt) || 0,
    students: toArray(p.students).map((s) => ({
      id: s.id || uid(),
      name: s.name,
      days:
        Array.isArray(s.days) && s.days.length
          ? s.days.filter((d) => DAYS.some((x) => x.id === d))
          : ['mon', 'thu', 'sat'],
      minutes: Number(s.minutes) > 0 ? Number(s.minutes) : 60,
      mathLevel: typeof s.mathLevel === 'string' ? s.mathLevel : '',
      readingLevel: typeof s.readingLevel === 'string' ? s.readingLevel : '',
    })),
    sessions,
  };
}

// Calendar date (YYYY-MM-DD) of a timestamp in Eastern Time.
function etDateKey(iso) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return normalize(JSON.parse(raw));
    // migrate the old single-roster version if present
    const old = localStorage.getItem(OLD_KEY);
    if (old) {
      const p = JSON.parse(old);
      return normalize({
        centerName: p.centerName,
        defaultMinutes: 60,
        students: (p.students || []).map((s) => ({
          id: s.id,
          name: s.name,
          days: ['mon', 'thu', 'sat'],
          minutes: 60,
        })),
        sessions: [],
      });
    }
  } catch {
    /* corrupted storage -> start fresh */
  }
  return { centerName: 'Kumon', defaultMinutes: 60, students: [], sessions: [] };
}

// Which day tab should open? Today if Kumon is open, otherwise the next open day.
function initialDay() {
  const wd = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'short',
  }).format(new Date()); // 'Mon', 'Tue', ...
  const map = { Mon: 'mon', Thu: 'thu', Sat: 'sat' };
  if (map[wd]) return map[wd];
  const order = ['mon', 'thu', 'sat'];
  const openJs = [1, 4, 6]; // Mon, Thu, Sat
  const jsDay = new Date().getDay();
  for (let i = 1; i <= 7; i++) {
    const idx = openJs.indexOf((jsDay + i) % 7);
    if (idx >= 0) return order[idx];
  }
  return 'mon';
}

const timeFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hour: 'numeric',
  minute: '2-digit',
});
const dateFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  weekday: 'long',
  month: 'long',
  day: 'numeric',
});
const fmtTime = (iso) => timeFmt.format(new Date(iso));

function fmtLeft(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return h + 'h ' + m + 'm';
  if (m > 0) return m + 'm ' + String(s).padStart(2, '0') + 's';
  return s + 's';
}

// ontime -> still within their preset time; timeup -> preset time has run out.
function statusOf(session, nowMs) {
  const elapsed = nowMs - new Date(session.in).getTime();
  const remaining = session.allotted * 60000 - elapsed;
  if (remaining > 0) return { phase: 'ontime', remaining };
  return { phase: 'timeup', remaining: 0 };
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/* ---------------- small components ---------------- */

function Modal({ title, children, onClose }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

// Dropdown for picking a session length. Keeps any existing custom value selectable.
function MinutesSelect({ value, onChange, label }) {
  const v = Number(value);
  const options = PRESETS.includes(v)
    ? PRESETS
    : [...PRESETS, v].sort((a, b) => a - b);
  return (
    <select
      className="select-input"
      value={String(v)}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
    >
      {options.map((m) => (
        <option key={m} value={m}>
          {m} min
        </option>
      ))}
    </select>
  );
}

// Dropdown for picking a Kumon level for one subject. Blank = not set.
function LevelSelect({ subject, value, onChange }) {
  return (
    <select
      className="select-input level-select"
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      aria-label={subject + ' level'}
    >
      <option value="">{subject} — not set</option>
      {KUMON_LEVELS.map((l) => (
        <option key={l} value={l}>
          {l}
        </option>
      ))}
    </select>
  );
}

// Tap-a-level grid used when changing a level straight from a time card.
function LevelPicker({ student, subject, onPick, onClose }) {
  const label = subject === 'math' ? 'Math' : 'Reading';
  const current = student[subject + 'Level'] || '';
  return (
    <Modal title={student.name + ' — ' + label + ' level'} onClose={onClose}>
      <div className="level-grid">
        {KUMON_LEVELS.map((l) => (
          <button
            key={l}
            type="button"
            className={'level-cell' + (current === l ? ' on' : '')}
            onClick={() => onPick(l)}
          >
            {l}
          </button>
        ))}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn small" onClick={() => onPick('')}>
          Not enrolled
        </button>
        <button type="button" className="btn small" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}

function StudentEditor({ student, onSave, onRemove }) {
  const [days, setDays] = useState(student.days);
  const [minutes, setMinutes] = useState(String(student.minutes));
  const [mathLevel, setMathLevel] = useState(student.mathLevel || '');
  const [readingLevel, setReadingLevel] = useState(student.readingLevel || '');

  function toggleDay(id) {
    setDays((d) => (d.includes(id) ? d.filter((x) => x !== id) : [...d, id]));
  }

  function save() {
    const v = parseInt(minutes, 10);
    if (!v || v < 5 || v > 300 || days.length === 0) return;
    onSave(student.id, { days, minutes: v, mathLevel, readingLevel }, v !== student.minutes);
  }

  const dirty =
    minutes !== String(student.minutes) ||
    days.slice().sort().join() !== student.days.slice().sort().join() ||
    mathLevel !== (student.mathLevel || '') ||
    readingLevel !== (student.readingLevel || '');

  return (
    <div className="student-edit">
      <div className="student-edit-name">{student.name}</div>
      <div className="chips">
        {DAYS.map((d) => (
          <button
            key={d.id}
            type="button"
            className={'chip' + (days.includes(d.id) ? ' on' : '')}
            onClick={() => toggleDay(d.id)}
          >
            {d.label.slice(0, 3)}
          </button>
        ))}
      </div>
      <div className="row-form">
        <MinutesSelect value={minutes} onChange={setMinutes} label="Session length" />
        <span className="unit">SCT preset</span>
      </div>
      <div className="row-form">
        <LevelSelect subject="Math" value={mathLevel} onChange={setMathLevel} />
        <LevelSelect subject="Reading" value={readingLevel} onChange={setReadingLevel} />
      </div>
      <div className="row-form">
        <button className="btn small" type="button" onClick={save} disabled={!dirty}>
          Save
        </button>
        <button className="btn danger small" type="button" onClick={() => onRemove(student)}>
          Remove
        </button>
      </div>
    </div>
  );
}

/* ---------------- main app ---------------- */

export default function App() {
  const [state, setState] = useState(loadState);
  const [day, setDay] = useState(initialDay);
  const [view, setView] = useState('day'); // 'day' | 'settings'
  const [now, setNow] = useState(Date.now());
  const [query, setQuery] = useState('');
  const [walkinOpen, setWalkinOpen] = useState(false);
  const [walkinQuery, setWalkinQuery] = useState('');
  const [walkinForm, setWalkinForm] = useState(null); // null | {name, minutes, mathLevel, readingLevel}
  const [levelEdit, setLevelEdit] = useState(null); // null | {id, subject}
  const [confirm, setConfirm] = useState(null); // {title,message,confirmLabel,onConfirm}
  const [defaultDraft, setDefaultDraft] = useState(String(loadState().defaultMinutes));
  const [newStu, setNewStu] = useState({ name: '', days: [initialDay()], minutes: '', mathLevel: '', readingLevel: '' });

  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state));
    } catch {
      /* storage unavailable */
    }
  }, [state]);

  // ---- Real-time multi-device sync (Firebase) ----
  // Local-first: the UI always renders from local state instantly, so taps
  // never feel slow. Changes are pushed to the cloud in the background, and
  // remote changes from other devices are applied as they arrive.
  // Conflicts resolve as last-write-wins.
  const [cloud, setCloud] = useState('connecting'); // 'connecting'|'live'|'offline'
  const stateMirror = useRef(state);
  stateMirror.current = state;
  const lastPushed = useRef(null);
  const fromCloud = useRef(false);
  const readyToPublish = useRef(false);

  const pushState = (s) => {
    const json = JSON.stringify(s);
    lastPushed.current = json;
    dbSet(stateRef, JSON.parse(json)).catch((err) =>
      console.warn('Sync write failed:', err)
    );
  };

  useEffect(() => {
    let offValue = null;
    let offConn = null;
    ensureSignedIn()
      .then(() => {
        offConn = onValue(connectedRef, (snap) => {
          setCloud(snap.val() ? 'live' : 'offline');
        });
        offValue = onValue(
          stateRef,
          (snap) => {
            const val = snap.val();
            readyToPublish.current = true;
            const local = stateMirror.current;
            const localEmpty =
              local.students.length === 0 && local.sessions.length === 0;
            if (val == null) {
              // Cloud has never held data: seed it from this device when we
              // have something; an empty device simply waits its turn.
              if (!localEmpty) pushState(local);
              return;
            }
            const json = JSON.stringify(val);
            if (json === lastPushed.current) return; // echo of our own write
            const remoteEmpty =
              (!val.students || val.students.length === 0) &&
              (!val.sessions || val.sessions.length === 0);
            const remoteClearedAt = Number(val.clearedAt) || 0;
            if (
              remoteEmpty &&
              !localEmpty &&
              remoteClearedAt <= (local.clearedAt || 0)
            ) {
              // The cloud is empty but we hold data and nobody deliberately
              // cleared it: push ours up instead of wiping ourselves.
              pushState(local);
              return;
            }
            lastPushed.current = json;
            fromCloud.current = true;
            setState(normalize(val));
          },
          (err) => {
            console.warn('Sync read failed:', err);
            setCloud('offline');
          }
        );
      })
      .catch((err) => {
        console.warn('Cloud sync unavailable (working offline):', err);
        setCloud('offline');
      });
    return () => {
      if (offValue) offValue();
      if (offConn) offConn();
    };
  }, []);

  // Publish local changes to the cloud (debounced to batch rapid taps).
  useEffect(() => {
    if (cloud !== 'live' || !readyToPublish.current) return;
    if (fromCloud.current) {
      fromCloud.current = false;
      return;
    }
    const json = JSON.stringify(state);
    if (json === lastPushed.current) return;
    lastPushed.current = json;
    const t = setTimeout(() => {
      dbSet(stateRef, JSON.parse(json)).catch((err) =>
        console.warn('Sync write failed:', err)
      );
    }, 150);
    return () => clearTimeout(t);
  }, [state, cloud]);

  // Tick every second so countdowns stay live.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const openByStudent = useMemo(() => {
    const map = new Map();
    for (const s of state.sessions) {
      if (!s.out && s.day === day) map.set(s.studentId, s);
    }
    return map;
  }, [state.sessions, day]);

  const roster = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = state.students.filter(
      (s) => s.days.includes(day) && (!q || s.name.toLowerCase().includes(q))
    );
    // Pure alphabetical order for fast scanning; time's-up students are
    // already surfaced in the notices banner at the top of the screen.
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [state.students, day, query]);

  const notices = useMemo(() => {
    const out = [];
    for (const s of openByStudent.values()) {
      if (statusOf(s, now).phase === 'timeup') out.push(s);
    }
    return out;
  }, [openByStudent, now]);

  const hereCount = openByStudent.size;

  /* ----- actions ----- */

  function checkIn(student) {
    if (openByStudent.has(student.id)) return;
    const session = {
      id: uid(),
      studentId: student.id,
      name: student.name,
      day,
      in: new Date().toISOString(), // exact moment, stored in UTC, shown in ET
      out: null,
      allotted: student.minutes, // SCT preset filed for this student
    };
    setState((p) => ({ ...p, sessions: [session, ...p.sessions] }));
  }

  function checkOut(studentId) {
    const open = openByStudent.get(studentId);
    if (!open) return;
    const out = new Date().toISOString();
    setState((p) => ({
      ...p,
      sessions: p.sessions.map((s) => (s.id === open.id ? { ...s, out } : s)),
    }));
  }

  // Change one subject level straight from a time card. No confirmation:
  // it's one tap to set and one tap to fix.
  function pickLevel(level) {
    if (!levelEdit) return;
    const key = levelEdit.subject + 'Level';
    const id = levelEdit.id;
    setLevelEdit(null);
    setState((p) => ({
      ...p,
      students: p.students.map((s) => (s.id === id ? { ...s, [key]: level } : s)),
    }));
  }

  function closeWalkin() {
    setWalkinOpen(false);
    setWalkinQuery('');
    setWalkinForm(null);
  }

  // Walk-in: check in an existing student (adding today to their days when
  // needed) at this exact time.
  function walkinCheckIn(student) {
    if (openByStudent.has(student.id)) {
      closeWalkin();
      return;
    }
    setState((p) => {
      let students = p.students;
      let stu = students.find((s) => s.id === student.id);
      if (!stu.days.includes(day)) {
        stu = { ...stu, days: [...stu.days, day] };
        students = students.map((s) => (s.id === stu.id ? stu : s));
      }
      const session = {
        id: uid(),
        studentId: stu.id,
        name: stu.name,
        day,
        in: new Date().toISOString(),
        out: null,
        allotted: stu.minutes,
      };
      return { ...p, students, sessions: [session, ...p.sessions] };
    });
    closeWalkin();
  }

  // Walk-in: brand-new student with levels, added to today's list and checked in.
  function walkinCreate(e) {
    e.preventDefault();
    const name = (walkinForm.name || '').trim();
    if (!name) return;
    const minutes = parseInt(walkinForm.minutes, 10) || state.defaultMinutes;
    const stu = {
      id: uid(),
      name,
      days: [day],
      minutes,
      mathLevel: walkinForm.mathLevel || '',
      readingLevel: walkinForm.readingLevel || '',
    };
    const session = {
      id: uid(),
      studentId: stu.id,
      name,
      day,
      in: new Date().toISOString(),
      out: null,
      allotted: minutes,
    };
    setState((p) => ({
      ...p,
      students: [...p.students, stu],
      sessions: [session, ...p.sessions],
    }));
    closeWalkin();
  }

  // Search-as-you-type over every student for the walk-in sheet.
  const walkinResults = useMemo(() => {
    const q = walkinQuery.trim().toLowerCase();
    if (!q) return [];
    return state.students
      .filter((s) => s.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 8);
  }, [state.students, walkinQuery]);

  function saveDefaultTimer() {
    const v = parseInt(defaultDraft, 10);
    if (!v || v < 5 || v > 300 || v === state.defaultMinutes) return;
    setConfirm({
      title: 'Change default session length?',
      message:
        'New students will be given ' +
        v +
        ' minutes. Existing students keep their own preset times.',
      confirmLabel: 'Change to ' + v + ' min',
      onConfirm: () => setState((p) => ({ ...p, defaultMinutes: v })),
    });
  }

  function addStudent(e) {
    e.preventDefault();
    const name = newStu.name.trim();
    const minutes = parseInt(newStu.minutes, 10) || state.defaultMinutes;
    if (!name || newStu.days.length === 0) return;
    setState((p) => ({
      ...p,
      students: [
        ...p.students,
        {
          id: uid(),
          name,
          days: newStu.days,
          minutes,
          mathLevel: newStu.mathLevel || '',
          readingLevel: newStu.readingLevel || '',
        },
      ],
    }));
    setNewStu({ name: '', days: [day], minutes: '', mathLevel: '', readingLevel: '' });
  }

  function saveStudent(id, patch, minutesChanged) {
    const student = state.students.find((s) => s.id === id);
    const apply = () =>
      setState((p) => ({
        ...p,
        students: p.students.map((s) => (s.id === id ? { ...s, ...patch } : s)),
      }));
    if (minutesChanged) {
      setConfirm({
        title: 'Change preset time?',
        message:
          "Set " + student.name + "'s session length to " + patch.minutes + ' minutes (SCT)?',
        confirmLabel: 'Change time',
        onConfirm: apply,
      });
    } else {
      apply();
    }
  }

  function removeStudent(student) {
    setConfirm({
      title: 'Remove student?',
      message:
        'Remove ' +
        student.name +
        ' from the roster? Their past visit records are kept. A currently checked-in visit will be closed now.',
      confirmLabel: 'Remove student',
      onConfirm: () =>
        setState((p) => ({
          ...p,
          students: p.students.filter((s) => s.id !== student.id),
          sessions: p.sessions.map((s) =>
            s.studentId === student.id && !s.out
              ? { ...s, out: new Date().toISOString() }
              : s
          ),
        })),
    });
  }

  function exportCsv() {
    const rows = [
      ['Day', 'Date', 'Student', 'Math level', 'Reading level', 'Check-in (ET)', 'Check-out (ET)', 'Preset (min)', 'Duration (min)'],
    ];
    const byId = new Map(state.students.map((s) => [s.id, s]));
    const sorted = [...state.sessions].sort((a, b) => (a.in < b.in ? -1 : 1));
    for (const s of sorted) {
      const mins = s.out
        ? Math.max(0, Math.round((new Date(s.out) - new Date(s.in)) / 60000))
        : '';
      const stu = byId.get(s.studentId);
      rows.push([
        dayLabel(s.day),
        new Date(s.in).toLocaleDateString('en-US', { timeZone: TZ }),
        s.name,
        (stu && stu.mathLevel) || '',
        (stu && stu.readingLevel) || '',
        fmtTime(s.in),
        s.out ? fmtTime(s.out) + (s.autoClosed ? ' (auto)' : '') : 'Still here',
        s.allotted,
        mins,
      ]);
    }
    const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'kumon-attendance.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function clearAll() {
    setConfirm({
      title: 'Delete all data?',
      message:
        'This permanently deletes every student and every visit record on all synced devices. This cannot be undone.',
      confirmLabel: 'Delete everything',
      onConfirm: () =>
        setState({
          centerName: state.centerName,
          defaultMinutes: 60,
          students: [],
          sessions: [],
          clearedAt: Date.now(),
        }),
    });
  }

  const todayStr = dateFmt.format(new Date());

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <div className="center-name">{state.centerName}</div>
          <div className="date-line">
            {todayStr} · <span className="tz-note">Eastern Time</span>
          </div>
          <div className={'sync-line ' + cloud} title="Sync status">
            <span className="sync-dot" />
            {cloud === 'live'
              ? 'Live sync'
              : cloud === 'offline'
                ? 'Offline — changes save on this device'
                : 'Connecting…'}
          </div>
        </div>
        <div className={'here-pill' + (hereCount > 0 ? ' active' : '')}>
          <span className="here-count">{hereCount}</span>
          <span className="here-label">here now</span>
        </div>
      </header>

      <main className="content">
        {view === 'day' && (
          <section>
            {notices.length > 0 && (
              <div className="notice-banner">
                <span className="notice-dot" />
                <div>
                  {notices.map((s) => (
                    <div key={s.id} className="notice-line">
                      <strong>{s.name}</strong> — time&rsquo;s up, ready to leave
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="day-actions">
              <button className="arrive-btn" onClick={() => setWalkinOpen(true)}>
                <span className="arrive-plus">+</span> Walk-in student
              </button>

              <input
                className="search"
                type="search"
                placeholder={'Search ' + dayLabel(day) + ' students…'}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>

            {roster.length === 0 ? (
              <div className="empty">
                <p className="empty-title">No students for {dayLabel(day)}</p>
                <p>
                  Add students for this day in Settings, or tap &ldquo;Walk-in
                  student&rdquo; above.
                </p>
              </div>
            ) : (
              <ul className="student-list">
                {roster.map((st) => {
                  const open = openByStudent.get(st.id);
                  const phase = open ? statusOf(open, now).phase : null;
                  const cardClass =
                    'student-card' + (phase === 'ontime' ? ' here' : phase === 'timeup' ? ' timeup' : '');
                  const pct = open
                    ? Math.min(
                        100,
                        ((now - new Date(open.in).getTime()) / (open.allotted * 60000)) * 100
                      )
                    : 0;
                  return (
                    <li key={st.id} className={cardClass}>
                      <div className="student-info">
                        <span className="student-name">{st.name}</span>
                        <div className="level-row">
                          {SUBJECTS.map((sub) => (
                            <button
                              key={sub.id}
                              type="button"
                              className="level-btn"
                              title={'Change ' + st.name + '’s ' + sub.label + ' level'}
                              onClick={() => setLevelEdit({ id: st.id, subject: sub.id })}
                            >
                              {sub.label} · {st[sub.id + 'Level'] || '—'}
                            </button>
                          ))}
                        </div>
                        {!open && (
                          <span className="preset-line">Preset {st.minutes} min (SCT)</span>
                        )}
                        {open && phase === 'ontime' && (
                          <span className="timer-line ontime">
                            In at {fmtTime(open.in)} · {fmtLeft(statusOf(open, now).remaining)} left
                          </span>
                        )}
                        {open && phase === 'timeup' && (
                          <span className="timer-line timeup">Time&rsquo;s up!</span>
                        )}
                        {open && (
                          <div className="progress">
                            <div
                              className={'progress-fill ' + phase}
                              style={{ width: pct + '%' }}
                            />
                          </div>
                        )}
                      </div>
                      {open ? (
                        <button
                          className="btn checkout"
                          onClick={() => checkOut(st.id)}
                        >
                          Check out
                        </button>
                      ) : (
                        <button className="btn checkin" onClick={() => checkIn(st)}>
                          Check in
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}

        {view === 'settings' && (
          <section className="settings">
            <h2>Session timer</h2>
            <div className="setting-card">
              <p className="muted">
                Default length for new students, picked from the list. When a
                timer runs out, the student&rsquo;s card lights up and a banner
                appears at the top.
              </p>
              <div className="row-form">
                <MinutesSelect
                  value={defaultDraft}
                  onChange={setDefaultDraft}
                  label="Default session length"
                />
                <button className="btn small" type="button" onClick={saveDefaultTimer}>
                  Save
                </button>
              </div>
            </div>

            <h2 className="mt">Add student</h2>
            <div className="setting-card">
              <form onSubmit={addStudent}>
                <input
                  className="text-input"
                  value={newStu.name}
                  onChange={(e) => setNewStu({ ...newStu, name: e.target.value })}
                  placeholder="Student name"
                  maxLength={60}
                />
                <div className="chips">
                  {DAYS.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      className={'chip' + (newStu.days.includes(d.id) ? ' on' : '')}
                      onClick={() =>
                        setNewStu({
                          ...newStu,
                          days: newStu.days.includes(d.id)
                            ? newStu.days.filter((x) => x !== d.id)
                            : [...newStu.days, d.id],
                        })
                      }
                    >
                      {d.label.slice(0, 3)}
                    </button>
                  ))}
                </div>
                <div className="row-form">
                  <LevelSelect
                    subject="Math"
                    value={newStu.mathLevel}
                    onChange={(v) => setNewStu({ ...newStu, mathLevel: v })}
                  />
                  <LevelSelect
                    subject="Reading"
                    value={newStu.readingLevel}
                    onChange={(v) => setNewStu({ ...newStu, readingLevel: v })}
                  />
                </div>
                <div className="row-form">
                  <MinutesSelect
                    value={newStu.minutes || String(state.defaultMinutes)}
                    onChange={(v) => setNewStu({ ...newStu, minutes: v })}
                    label="Preset session length"
                  />
                  <span className="unit">SCT preset</span>
                  <button className="btn primary" type="submit">
                    Add
                  </button>
                </div>
              </form>
            </div>

            <h2 className="mt">Students ({state.students.length})</h2>
            {state.students.length === 0 ? (
              <p className="muted">No students yet.</p>
            ) : (
              <div className="setting-card">
                {[...state.students]
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((st) => (
                    <StudentEditor
                      key={st.id}
                      student={st}
                      onSave={saveStudent}
                      onRemove={removeStudent}
                    />
                  ))}
              </div>
            )}

            <h2 className="mt">Centre</h2>
            <div className="setting-card">
              <div className="row-form">
                <input
                  className="text-input"
                  value={state.centerName}
                  onChange={(e) =>
                    setState((p) => ({ ...p, centerName: e.target.value }))
                  }
                  placeholder="Centre name"
                  maxLength={60}
                />
              </div>
              <p className="muted small">All times are shown in Eastern Time.</p>
            </div>

            <h2 className="mt">Records</h2>
            <div className="setting-card">
              <p className="muted">
                {state.sessions.length} visit
                {state.sessions.length === 1 ? '' : 's'} stored on this device.
              </p>
              <div className="data-actions">
                {state.sessions.length > 0 && (
                  <button className="btn small" onClick={exportCsv}>
                    Export CSV
                  </button>
                )}
                <button className="btn danger small" onClick={clearAll}>
                  Delete all data
                </button>
              </div>
            </div>
          </section>
        )}
      </main>

      <nav className="tabbar">
        {DAYS.map((d) => (
          <button
            key={d.id}
            className={view === 'day' && day === d.id ? 'active' : ''}
            onClick={() => {
              setDay(d.id);
              setView('day');
              setQuery('');
            }}
          >
            <span className="tab-icon">{d.label.slice(0, 3)}</span>
            {d.label}
          </button>
        ))}
        <button
          className={view === 'settings' ? 'active' : ''}
          onClick={() => setView('settings')}
          aria-label="Settings"
        >
          <span className="tab-icon">⚙</span>
          Settings
        </button>
      </nav>

      {walkinOpen && (
        <Modal title={'Walk-in student — ' + dayLabel(day)} onClose={closeWalkin}>
          {!walkinForm ? (
            <>
              <input
                className="text-input"
                autoFocus
                value={walkinQuery}
                onChange={(e) => setWalkinQuery(e.target.value)}
                placeholder="Type a student name…"
                maxLength={60}
              />
              {walkinQuery.trim() === '' ? (
                <p className="muted small">
                  Search every student — tap one to check them in. Someone new?
                  Add them as a walk-in below.
                </p>
              ) : walkinResults.length === 0 ? (
                <p className="muted">
                  No matches for &ldquo;{walkinQuery.trim()}&rdquo;. Add them as
                  a new walk-in below.
                </p>
              ) : (
                <ul className="walkin-results">
                  {walkinResults.map((st) => {
                    const here = openByStudent.has(st.id);
                    return (
                      <li key={st.id} className="walkin-row">
                        <div className="walkin-info">
                          <span className="walkin-name">{st.name}</span>
                          <span className="walkin-meta">
                            {levelSummary(st)} ·{' '}
                            {st.days.map((d) => dayLabel(d).slice(0, 3)).join(', ')}
                          </span>
                        </div>
                        {here ? (
                          <span className="walkin-here">Here now</span>
                        ) : (
                          <button
                            type="button"
                            className="btn small primary"
                            onClick={() => walkinCheckIn(st)}
                          >
                            Check in
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="modal-actions">
                <button type="button" className="btn small" onClick={closeWalkin}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn primary"
                  onClick={() =>
                    setWalkinForm({
                      name: walkinQuery.trim(),
                      minutes: '',
                      mathLevel: '',
                      readingLevel: '',
                    })
                  }
                >
                  + Add as new walk-in
                </button>
              </div>
            </>
          ) : (
            <form onSubmit={walkinCreate}>
              <input
                className="text-input"
                autoFocus
                value={walkinForm.name}
                onChange={(e) => setWalkinForm({ ...walkinForm, name: e.target.value })}
                placeholder="Student name"
                maxLength={60}
              />
              <div className="row-form">
                <LevelSelect
                  subject="Math"
                  value={walkinForm.mathLevel}
                  onChange={(v) => setWalkinForm({ ...walkinForm, mathLevel: v })}
                />
                <LevelSelect
                  subject="Reading"
                  value={walkinForm.readingLevel}
                  onChange={(v) => setWalkinForm({ ...walkinForm, readingLevel: v })}
                />
              </div>
              <div className="row-form">
                <MinutesSelect
                  value={walkinForm.minutes || String(state.defaultMinutes)}
                  onChange={(v) => setWalkinForm({ ...walkinForm, minutes: v })}
                  label="Preset session length"
                />
                <span className="unit">SCT preset</span>
              </div>
              <p className="muted small">
                Added to {dayLabel(day)}&rsquo;s list and checked in now — the exact
                time is recorded in Eastern Time.
              </p>
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn small"
                  onClick={() => setWalkinForm(null)}
                >
                  Back
                </button>
                <button type="submit" className="btn primary">
                  Check in now
                </button>
              </div>
            </form>
          )}
        </Modal>
      )}

      {(() => {
        if (!levelEdit) return null;
        const st = state.students.find((s) => s.id === levelEdit.id);
        if (!st) return null;
        return (
          <LevelPicker
            student={st}
            subject={levelEdit.subject}
            onPick={pickLevel}
            onClose={() => setLevelEdit(null)}
          />
        );
      })()}

      {confirm && (
        <Modal title={confirm.title} onClose={() => setConfirm(null)}>
          <p className="muted">{confirm.message}</p>
          <div className="modal-actions">
            <button className="btn small" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button
              className="btn danger"
              onClick={() => {
                setConfirm(null);
                confirm.onConfirm();
              }}
            >
              {confirm.confirmLabel}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
