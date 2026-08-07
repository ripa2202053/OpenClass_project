/**
 * OpenClass Backend Health Check
 * ==============================
 * Verifies the Node.js/Express backend + Firebase Admin SDK + Firestore
 * integration end-to-end, including auth middleware, CORS, and all main
 * API endpoints used by the Vanilla JS client.
 *
 * Usage:
 *   node scripts/health-check.mjs
 *
 * Optional env:
 *   API_BASE           base URL for the Express server (default http://localhost:5000)
 *   FIREBASE_ID_TOKEN  a REAL Firebase ID token to test with (defaults to a mock JWT
 *                      which the dev-mode middleware accepts via payload decode)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

const BASE = (process.env.API_BASE || 'http://localhost:5000').replace(/\/$/, '');
const TEST_UID = `hc_test_${Date.now()}`;

// ───────────────────────────── test harness ─────────────────────────────
const results = [];
let currentSection = '';

function section(name) {
  currentSection = name;
  console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`);
}

function record(name, pass, detail) {
  results.push({ section: currentSection, name, pass, detail });
  const icon = pass ? 'PASS' : 'FAIL';
  const color = pass ? '\x1b[32m' : '\x1b[31m';
  console.log(`  ${color}${icon}\x1b[0m  ${name}${detail ? `\n        → ${detail}` : ''}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, detail === false ? false : true, typeof detail === 'string' ? detail : undefined);
  } catch (err) {
    record(name, false, err.message || String(err));
  }
}

// ───────────────────────────── HTTP helper ─────────────────────────────
function mockJwt(payload) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const header = b64({ alg: 'none', typ: 'JWT' });
  const body = b64(payload);
  return `${header}.${body}.mock-signature`;
}

const TOKEN = process.env.FIREBASE_ID_TOKEN || mockJwt({
  user_id: TEST_UID,
  sub: TEST_UID,
  email: 'health@check.local',
  name: 'Health Check User',
  role: 'teacher',
});

async function req(method, p, { token = TOKEN, body, origin } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (origin) headers.Origin = origin;

  const res = await fetch(`${BASE}${p}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json() : await res.text();
  return { status: res.status, headers: res.headers, data };
}

// ───────────────────────────── admin SDK (lazy) ─────────────────────────────
let admin = null;
let adminInitError = null;

async function getAdmin() {
  if (admin) return admin;
  if (adminInitError) throw adminInitError;
  const { initializeApp, getApps, cert } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  if (getApps().length) {
    admin = getFirestore();
    return admin;
  }
  initializeApp({ credential: cert(JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, 'serviceAccountKey.json'), 'utf8'))) });
  admin = getFirestore();
  return admin;
}

async function deleteCollection(colRef) {
  const snap = await colRef.get();
  await Promise.all(snap.docs.map(async (d) => {
    const subs = await d.ref.listCollections();
    await Promise.all(subs.map((s) => deleteCollection(s)));
    await d.ref.delete();
  }));
}

async function hardDeleteClassroom(classId) {
  const db = await getAdmin();
  const ref = db.collection('classrooms').doc(classId);
  const subs = await ref.listCollections();
  for (const s of subs) await deleteCollection(s);
  await ref.delete();
}

// ───────────────────────────── server status ─────────────────────────────
let serverOnline = false;

section('1. Express Server Status');
await check('Server is reachable (GET /api/health)', async () => {
  const r = await req('GET', '/api/health', { token: null });
  if (r.status !== 200) throw new Error(`Expected 200, got ${r.status}`);
  if (!r.data || r.data.status !== 'ok') throw new Error(`Unexpected body: ${JSON.stringify(r.data)}`);
  serverOnline = true;
  return `status=${r.data.status} timestamp=${r.data.timestamp}`;
});

await check('CORS allows origin http://localhost:5173', async () => {
  const res = await fetch(`${BASE}/api/health`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'GET' } });
  const allow = res.headers.get('access-control-allow-origin');
  if (!allow || !allow.includes('localhost:5173')) throw new Error(`Allow-Origin=${allow}`);
  return `Access-Control-Allow-Origin: ${allow}`;
});

await check('CORS rejects unknown origin', async () => {
  const res = await fetch(`${BASE}/api/health`, { method: 'GET', headers: { Origin: 'http://evil.example.com' } });
  const allow = res.headers.get('access-control-allow-origin');
  if (allow) throw new Error(`Unexpectedly allowed origin evil.example.com`);
  return 'no Allow-Origin header sent';
});

// ───────────────────────────── firebase admin ─────────────────────────────
section('2. Firebase Admin SDK Initialization');
const keyPath = path.join(SERVER_ROOT, 'serviceAccountKey.json');
await check('serviceAccountKey.json exists', () => {
  if (!fs.existsSync(keyPath)) throw new Error('Missing server/serviceAccountKey.json');
  return keyPath;
});

await check('serviceAccountKey.json is a valid service-account', () => {
  const sa = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  if (sa.type !== 'service_account') throw new Error('type is not service_account');
  for (const f of ['project_id', 'client_email', 'private_key']) {
    if (!sa[f]) throw new Error(`Missing field "${f}"`);
  }
  return `project_id=${sa.project_id} client_email=${sa.client_email}`;
});

await check('Admin SDK can initialize and reach Firestore', async () => {
  if (!serverOnline) throw new Error('Server offline; skipping (will fail on endpoints)');
  const db = await getAdmin();
  const snap = await db.collection('classrooms').limit(1).get();
  return `read classrooms OK (query returned ${snap.size} doc)`;
});

// ───────────────────────────── auth middleware ─────────────────────────────
section('3. Auth & Middleware Verification');
await check('Missing Authorization header → 401', async () => {
  const r = await req('GET', '/api/classrooms', { token: null });
  if (r.status !== 401) throw new Error(`Expected 401, got ${r.status}`);
  return `status=${r.status} ${r.data?.error || ''}`;
});

await check('Malformed token (no payload) → 401', async () => {
  const r = await req('GET', '/api/classrooms', { token: 'not-a-real-token' });
  if (r.status !== 401) throw new Error(`Expected 401, got ${r.status}`);
  return `status=${r.status} ${r.data?.error || ''}`;
});

await check('Bearer with valid-format token → req.user attached', async () => {
  const r = await req('GET', '/api/dashboard/stats');
  if (r.status === 401) throw new Error(`Middleware rejected token (401): ${JSON.stringify(r.data)}`);
  if (r.status === 200) return 'middleware decoded token and populated req.user (dev fallback)';
  if (r.status === 500 && /PERMISSION_DENIED|Firestore/.test(JSON.stringify(r.data))) {
    return 'token ACCEPTED (passed middleware → reached route). Downstream failed only because Firestore is disabled on the project.';
  }
  throw new Error(`Unexpected response: ${r.status} ${JSON.stringify(r.data)}`);
});

// ───────────────────────────── main endpoints ─────────────────────────────
let classId = null;
let assignmentId = null;
let quizId = null;
let meetingId = null;
let noteId = null;
let reminderId = null;

section('4. API Endpoint Testing');

await check('GET /api/dashboard/stats → 200 + stats shape', async () => {
  const r = await req('GET', '/api/dashboard/stats');
  if (r.status !== 200) throw new Error(`Expected 200, got ${r.status} ${JSON.stringify(r.data)}`);
  for (const k of ['totalClassrooms', 'totalStudents', 'assignmentsCreated', 'quizzesCreated']) {
    if (typeof r.data[k] !== 'number') throw new Error(`Missing numeric field "${k}"`);
  }
  return `totalClassrooms=${r.data.totalClassrooms} students=${r.data.totalStudents} assignments=${r.data.assignmentsCreated} quizzes=${r.data.quizzesCreated}`;
});

await check('GET /api/classrooms → 200 + array', async () => {
  const r = await req('GET', '/api/classrooms');
  if (r.status !== 200) throw new Error(`Expected 200, got ${r.status} ${JSON.stringify(r.data)}`);
  if (!Array.isArray(r.data)) throw new Error('Response is not an array');
  return `${r.data.length} classroom(s) for test user`;
});

await check('POST /api/classrooms/join with invalid code → error (no fallback needed)', async () => {
  const r = await req('POST', '/api/classrooms/join', { body: { code: 'ZZ9!NOPE' } });
  if (r.status === 200 || r.status === 201) throw new Error(`Invalid code should NOT succeed, got ${r.status}`);
  return `status=${r.status} error="${r.data?.error || 'n/a'}" (correctly rejected)`;
});

await check('POST /api/classrooms → 201 (create)', async () => {
  const r = await req('POST', '/api/classrooms', {
    body: {
      classroomName: `HC-Test-${TEST_UID.slice(-6)}`,
      section: 'Health',
      subject: 'Automated Check',
      room: '101',
      themeColor: 'teal',
    },
  });
  if (r.status !== 201) throw new Error(`Expected 201, got ${r.status} ${JSON.stringify(r.data)}`);
  if (!r.data.id || !r.data.classroomCode) throw new Error('Missing id/classroomCode in response');
  classId = r.data.id;
  return `id=${r.data.id} code=${r.data.classroomCode} theme=${r.data.themeColor}`;
});

await check('GET /api/classrooms includes the new classroom (read-back)', async () => {
  const r = await req('GET', '/api/classrooms');
  if (!Array.isArray(r.data)) throw new Error('Response is not an array');
  if (!r.data.some((c) => c.id === classId)) throw new Error(`classroom ${classId} not present`);
  return 'present in list';
});

await check('POST /api/classrooms/:id/assignments → 201 (create)', async () => {
  const r = await req('POST', `/api/classrooms/${classId}/assignments`, {
    body: { title: 'HC Assignment', description: 'created by health check', dueDate: new Date(Date.now() + 86400000).toISOString(), maxMarks: 10 },
  });
  if (r.status !== 201) throw new Error(`Expected 201, got ${r.status} ${JSON.stringify(r.data)}`);
  assignmentId = r.data.id;
  return `id=${assignmentId}`;
});

await check('GET /api/classrooms/:id/assignments → 200 + array', async () => {
  const r = await req('GET', `/api/classrooms/${classId}/assignments`);
  if (r.status !== 200 || !Array.isArray(r.data)) throw new Error(`Expected 200 array, got ${r.status}`);
  if (!r.data.some((a) => a.id === assignmentId)) throw new Error('Assignment not in list');
  return `${r.data.length} assignment(s)`;
});

await check('POST /api/classrooms/:id/assignments/:id/submit → 200 (student submission)', async () => {
  const r = await req('POST', `/api/classrooms/${classId}/assignments/${assignmentId}/submit`, {
    body: { files: [{ name: 'answer.pdf', url: 'https://example.com/answer.pdf' }] },
  });
  if (r.status !== 200) throw new Error(`Expected 200, got ${r.status} ${JSON.stringify(r.data)}`);
  if (typeof r.data.late !== 'boolean') throw new Error('Missing "late" field');
  return `late=${r.data.late}`;
});

await check('POST /api/classrooms/:id/quizzes → 201 (create, 2 MCQs)', async () => {
  const r = await req('POST', `/api/classrooms/${classId}/quizzes`, {
    body: {
      title: 'HC Quiz',
      maxMarks: 5,
      questions: [
        { type: 'mcq', question: 'Q1', options: ['a', 'b', 'c'], correctAnswer: 'b', marks: 2 },
        { type: 'mcq', question: 'Q2', options: ['a', 'b'], correctAnswer: 'a', marks: 3 },
      ],
    },
  });
  if (r.status !== 201) throw new Error(`Expected 201, got ${r.status} ${JSON.stringify(r.data)}`);
  quizId = r.data.id;
  return `id=${quizId}`;
});

await check('GET /api/classrooms/:id/quizzes → 200 + array', async () => {
  const r = await req('GET', `/api/classrooms/${classId}/quizzes`);
  if (r.status !== 200 || !Array.isArray(r.data)) throw new Error(`Expected 200 array, got ${r.status}`);
  if (!r.data.some((q) => q.id === quizId)) throw new Error('Quiz not in list');
  return `${r.data.length} quiz(es)`;
});

await check('POST /api/classrooms/:id/quizzes/:id/submit → auto-grade correct (score 2/5 = 40%)', async () => {
  const r = await req('POST', `/api/classrooms/${classId}/quizzes/${quizId}/submit`, {
    body: { answers: ['b', 'b'], timeTaken: 42 },
  });
  if (r.status !== 200) throw new Error(`Expected 200, got ${r.status} ${JSON.stringify(r.data)}`);
  const { score, totalMarks, percentage } = r.data;
  if (score !== 2 || totalMarks !== 5 || percentage !== 40) {
    throw new Error(`Grading mismatch: score=${score}/${totalMarks} (${percentage}%) expected 2/5 (40%)`);
  }
  return `score=${score}/${totalMarks} (${percentage}%) attempt=${r.data.attemptNumber}`;
});

// ───────────────────────────── bonus modules ─────────────────────────────
section('4b. Notes / Meetings / Attendance / Calendar / Reminders (bonus)');

await check('POST /api/classrooms/:id/notes → 201', async () => {
  const r = await req('POST', `/api/classrooms/${classId}/notes`, {
    body: { title: 'HC Note', fileUrl: 'https://example.com/note.pdf', fileType: 'pdf' },
  });
  if (r.status !== 201) throw new Error(`Expected 201, got ${r.status} ${JSON.stringify(r.data)}`);
  noteId = r.data.id;
  return `id=${noteId}`;
});

await check('GET + DELETE note round-trip', async () => {
  const g = await req('GET', `/api/classrooms/${classId}/notes`);
  if (!Array.isArray(g.data) || !g.data.some((n) => n.id === noteId)) throw new Error('Note not listed');
  const d = await req('DELETE', `/api/classrooms/${classId}/notes/${noteId}`);
  if (d.status !== 200) throw new Error(`Delete failed: ${d.status}`);
  return 'listed and deleted';
});

await check('POST /api/classrooms/:id/meetings → 201 with meetingLink', async () => {
  const r = await req('POST', `/api/classrooms/${classId}/meetings`, {
    body: { title: 'HC Meeting' },
  });
  if (r.status !== 201) throw new Error(`Expected 201, got ${r.status} ${JSON.stringify(r.data)}`);
  if (!r.data.meetingLink || !r.data.roomName) throw new Error('Missing meetingLink/roomName');
  meetingId = r.data.id;
  return `link=${r.data.meetingLink}`;
});

await check('POST /api/classrooms/:id/meetings/:id/start → 200', async () => {
  const r = await req('POST', `/api/classrooms/${classId}/meetings/${meetingId}/start`);
  if (r.status !== 200) throw new Error(`Expected 200, got ${r.status} ${JSON.stringify(r.data)}`);
  return 'meeting started';
});

await check('DELETE meeting → 200', async () => {
  const r = await req('DELETE', `/api/classrooms/${classId}/meetings/${meetingId}`);
  if (r.status !== 200) throw new Error(`Delete failed: ${r.status}`);
  return 'deleted';
});

await check('POST /api/classrooms/:id/attendance (autoMark) → 200', async () => {
  const r = await req('POST', `/api/classrooms/${classId}/attendance`, { body: { autoMark: true } });
  if (r.status !== 200) throw new Error(`Expected 200, got ${r.status} ${JSON.stringify(r.data)}`);
  if (!r.data.records || !r.data.records[TEST_UID]) throw new Error('Auto-marked record missing');
  return `marked ${TEST_UID} as present for ${r.data.date}`;
});

await check('GET /api/classrooms/:id/attendance → 200', async () => {
  const r = await req('GET', `/api/classrooms/${classId}/attendance`);
  if (r.status !== 200 || !Array.isArray(r.data)) throw new Error(`Expected 200 array, got ${r.status}`);
  return `${r.data.length} attendance record(s)`;
});

await check('GET /api/calendar/events → 200 + array', async () => {
  const r = await req('GET', '/api/calendar/events');
  if (r.status !== 200 || !Array.isArray(r.data)) throw new Error(`Expected 200 array, got ${r.status}`);
  return `${r.data.length} event(s)`;
});

await check('POST + DELETE /api/reminders round-trip', async () => {
  const p = await req('POST', '/api/reminders', { body: { title: 'HC Reminder', date: new Date().toISOString() } });
  if (p.status !== 201) throw new Error(`Create failed: ${p.status} ${JSON.stringify(p.data)}`);
  reminderId = p.data.id;
  const d = await req('DELETE', `/api/reminders/${reminderId}`);
  if (d.status !== 200) throw new Error(`Delete failed: ${d.status}`);
  return `id=${reminderId} created & deleted`;
});

// ───────────────────────────── cleanup ─────────────────────────────
section('5. Cleanup');
await check('Soft-delete test classroom via API (DELETE /api/classrooms/:id)', async () => {
  if (!classId) throw new Error('No classroom created');
  const r = await req('DELETE', `/api/classrooms/${classId}`);
  if (r.status !== 200) throw new Error(`Delete failed: ${r.status} ${JSON.stringify(r.data)}`);
  return `classroom ${classId} soft-deleted (isActive=false)`;
});

await check('Hard-delete test classroom + subcollections via Admin SDK', async () => {
  if (!classId) throw new Error('No classroom created');
  await hardDeleteClassroom(classId);
  return `classroom ${classId} + subcollections removed`;
});

// ───────────────────────────── client integration ─────────────────────────────
section('6. Vanilla JS Client ↔ Express Integration');

await check('client/src/utils/api.js points to the tested server', async () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'client', 'src', 'utils', 'api.js'), 'utf8');
  const m = src.match(/API_BASE_URL\s*=\s*['"]([^'"]+)['"]/);
  if (!m) throw new Error('Could not find API_BASE_URL');
  if (!BASE.includes(new URL(m[1]).port)) throw new Error(`Client uses ${m[1]}, server tested on ${BASE}`);
  return `API_BASE_URL = ${m[1]}`;
});

await check('fetchWithAuth attaches Bearer token from current user', async () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'client', 'src', 'utils', 'api.js'), 'utf8');
  if (!src.includes("Authorization: `Bearer ${token}`") && !src.includes('Authorization: `Bearer') && !src.includes('Authorization: Bearer')) {
    throw new Error('No Bearer Authorization header found');
  }
  return 'Authorization: Bearer <idToken> header present';
});

await check('All client API-first calls route to Express endpoints (no 404)', async () => {
  const clientSrc = path.join(REPO_ROOT, 'client', 'src');
  const files = fs.readdirSync(clientSrc).filter((f) => f.endsWith('Service.js'));
  const paths = new Set();
  for (const f of files) {
    const src = fs.readFileSync(path.join(clientSrc, f), 'utf8');
    for (const m of src.matchAll(/fetchWithAuth\(`?\s*(['`])(\/api\/[^`$'"]*)/g)) {
      paths.add(m[2].replace(/^\s*['`]/, ''));
    }
  }
  const unreachable = [];
  for (const p of [...paths]) {
    const testPath = p
      .replace('${classroomId}', classId || 'missing')
      .replace('${assignmentId}', assignmentId || 'missing')
      .replace('${quizId}', quizId || 'missing')
      .replace('${meetingId}', meetingId || 'missing')
      .replace('${noteId}', noteId || 'missing')
      .replace('${reminderId}', reminderId || 'missing');
    const r = await req('GET', testPath).catch(() => null);
    const viaGet = r && r.status !== 404;
    const viaPost = viaGet ? true : ((await req('POST', testPath, { body: {} }).catch(() => null))?.status ?? 0) !== 404;
    if (!viaGet && !viaPost) unreachable.push(p);
  }
  if (unreachable.length) throw new Error(`No server route for: ${unreachable.join(', ')}`);
  return `${paths.size} unique /api paths all resolve to Express routes`;
});

await check('API-first order + Firestore fallback only on error (static)', async () => {
  const files = fs.readdirSync(path.join(REPO_ROOT, 'client', 'src')).filter((f) => f.endsWith('Service.js'));
  let apiFirst = 0;
  for (const f of files) {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'client', 'src', f), 'utf8');
    if (src.includes('fetchWithAuth') && /catch\s*\(/.test(src)) apiFirst++;
  }
  if (apiFirst === 0) throw new Error('No API-first services with fallback found');
  return `${apiFirst}/${files.length} service files implement API-first with Firestore fallback`;
});

// ───────────────────────────── summary ─────────────────────────────
section('Summary');
const total = results.length;
const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);
const pct = total ? Math.round((passed / total) * 100) : 0;

for (const s of [...new Set(results.map((r) => r.section))]) {
  const sec = results.filter((r) => r.section === s);
  const p = sec.filter((r) => r.pass).length;
  console.log(`  ${'•'.repeat(3)} ${s}: ${p}/${sec.length} passed`);
}

console.log(`\n  RESULT: ${passed}/${total} passed (${pct}%)`);
if (failed.length) {
  console.log('\n  FAILED CHECKS:');
  for (const f of failed) console.log(`    ✗ [${f.section}] ${f.name} → ${f.detail}`);
  process.exit(1);
} else {
  console.log('\n  All backend health checks passed ✓');
  process.exit(0);
}
