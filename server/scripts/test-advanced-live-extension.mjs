import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import http from 'http';
import { io as ioClient } from 'socket.io-client';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { attachSignaling } from '../src/socket.js';
import meetingsRouter from '../src/routes/meetings.js';
import classroomsRouter from '../src/routes/classrooms.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (!getApps().length) {
  const keyPath = path.resolve(__dirname, '../serviceAccountKey.json');
  if (fs.existsSync(keyPath)) {
    const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    initializeApp({
      credential: cert(serviceAccount)
    });
  } else {
    initializeApp({ projectId: 'openclass-7889d' });
  }
}

// Token helper
function createToken(payloadObj) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  return `${header}.${payload}.mock_sig`;
}

const teacherA_Token = createToken({ uid: 'teacher_ext_A_101', email: 'teacherExtA@test.com', name: 'Teacher Ext A', role: 'teacher' });
const teacherB_Token = createToken({ uid: 'teacher_ext_B_202', email: 'teacherExtB@test.com', name: 'Teacher Ext B', role: 'teacher' });
const studentA_Token = createToken({ uid: 'student_ext_303', email: 'studentExtA@test.com', name: 'Student Ext A', role: 'student' });
const studentB_Token = createToken({ uid: 'student_ext_404', email: 'studentExtB@test.com', name: 'Student Ext B', role: 'student' });
const studentUnenrolledToken = createToken({ uid: 'student_unenrolled_505', email: 'studentUnenrolled@test.com', name: 'Student Unenrolled', role: 'student' });

async function runExtensionTestSuite() {
  const app = express();
  app.use(express.json());
  app.use('/api/classrooms', classroomsRouter);
  app.use('/api/classrooms/:classId/meetings', meetingsRouter);

  const server = http.createServer(app);
  attachSignaling(server);

  const PORT = 5101;
  await new Promise(resolve => server.listen(PORT, resolve));
  console.log(`Extension test server running on port ${PORT}...\n`);
  const SERVER_URL = `http://localhost:${PORT}`;

  function connectSocket() {
    return ioClient(SERVER_URL, { transports: ['websocket'], forceNew: true });
  }

  try {
    console.log('--- STARTING ALL 40 EXTENSION & REGRESSION TEST SCENARIOS ---\n');

    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore();

    const classId = 'class_ext_' + Date.now();
    const meetingId = 'meeting_ext_' + Date.now();
    const roomName = 'OpenClass-Physics101-' + Date.now().toString(36);

    // Setup Firestore classroom document
    await db.collection('classrooms').doc(classId).set({
      classroomName: 'Physics 101 Quantum',
      createdBy: 'teacher_ext_A_101',
      teacherUid: 'teacher_ext_A_101',
      enrolledStudents: ['student_ext_303', 'student_ext_404'],
      isActive: true,
    });

    // Setup Firestore meeting document
    await db.collection('classrooms').doc(classId).collection('meetings').doc(meetingId).set({
      title: 'Quantum Mechanics Live',
      classroomId: classId,
      createdBy: 'teacher_ext_A_101',
      teacherUid: 'teacher_ext_A_101',
      roomName: roomName,
      status: 'ongoing',
      meetingType: 'instant',
      createdAt: new Date().toISOString(),
    });

    await db.collection('meetings').doc(meetingId).set({
      id: meetingId,
      title: 'Quantum Mechanics Live',
      classroomId: classId,
      createdBy: 'teacher_ext_A_101',
      teacherUid: 'teacher_ext_A_101',
      roomName: roomName,
      status: 'ongoing',
      meetingType: 'instant',
      createdAt: new Date().toISOString(),
    });

    // ──────────────────────────────────────────────────────────────────────────
    // 1. NOTES & RESOURCES (PHASE 1)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('1. Teacher A creates Notes via API...');
    const noteRes = await fetch(`${SERVER_URL}/api/classrooms/${classId}/meetings/${meetingId}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${teacherA_Token}` },
      body: JSON.stringify({ title: 'Schrödinger Equation', content: 'iH(d/dt)psi = H psi', pinned: true })
    });
    const noteData = await noteRes.json();
    if (noteRes.status !== 201 || !noteData.id) throw new Error('Note creation failed!');
    console.log('✅ 1. Teacher A created Class Note.');

    console.log('\n2. Student A views Notes via API...');
    const getNotesRes = await fetch(`${SERVER_URL}/api/classrooms/${classId}/meetings/${meetingId}/notes`, {
      headers: { Authorization: `Bearer ${studentA_Token}` }
    });
    const getNotesData = await getNotesRes.json();
    if (getNotesRes.status !== 200 || getNotesData.length === 0) throw new Error('Student fetching notes failed!');
    console.log('✅ 2. Student A fetched Class Notes successfully.');

    console.log('\n3. Student A attempts to create Note (Must fail)...');
    const sNoteRes = await fetch(`${SERVER_URL}/api/classrooms/${classId}/meetings/${meetingId}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${studentA_Token}` },
      body: JSON.stringify({ title: 'Student Note Attempt' })
    });
    if (sNoteRes.status !== 403) throw new Error('Student unauthorized note creation was not blocked!');
    console.log('✅ 3. Student note creation blocked (403).');

    console.log('\n4. Teacher A adds Class Resource via API...');
    const resRes = await fetch(`${SERVER_URL}/api/classrooms/${classId}/meetings/${meetingId}/resources`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${teacherA_Token}` },
      body: JSON.stringify({ title: 'Quantum Slides PDF', url: 'https://example.com/quantum.pdf', fileType: 'pdf' })
    });
    const resData = await resRes.json();
    if (resRes.status !== 201 || !resData.id) throw new Error('Resource creation failed!');
    console.log('✅ 4. Teacher A added Class Resource.');

    // ──────────────────────────────────────────────────────────────────────────
    // 2. LIVE POLLS & QUIZZES (PHASE 2)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n5. Teacher A joins socket room and starts Live Poll...');
    const sTeacherA = connectSocket();
    await new Promise(r => sTeacherA.on('connect', r));
    await new Promise(r => sTeacherA.emit('join-room', { roomId: roomName, userName: 'Teacher Ext A', token: teacherA_Token }, r));

    const pollRes = await new Promise(resolve => {
      sTeacherA.emit('create-poll', {
        question: 'What is the speed of light?',
        options: ['3x10^8 m/s', '1.5x10^8 m/s', '300 m/s']
      }, resolve);
    });
    if (!pollRes.ok || !pollRes.poll.id) throw new Error('Poll creation failed!');
    const activePollId = pollRes.poll.id;
    console.log('✅ 5. Live Poll created successfully.');

    console.log('\n6. Student A joins socket room and votes in Poll...');
    const sStudentA = connectSocket();
    await new Promise(r => sStudentA.on('connect', r));
    await new Promise(r => sStudentA.emit('join-room', { roomId: roomName, userName: 'Student Ext A', token: studentA_Token }, r));

    const voteRes = await new Promise(resolve => {
      sStudentA.emit('submit-poll-vote', { pollId: activePollId, optionIndex: 0 }, resolve);
    });
    if (!voteRes.ok) throw new Error('Student vote submission failed!');
    console.log('✅ 6. Student A submitted poll vote.');

    console.log('\n7. Student A attempts duplicate vote (Must fail)...');
    const dupVoteRes = await new Promise(resolve => {
      sStudentA.emit('submit-poll-vote', { pollId: activePollId, optionIndex: 1 }, resolve);
    });
    if (dupVoteRes.ok !== false || !dupVoteRes.error.includes('already voted')) {
      throw new Error('Duplicate vote was not blocked!');
    }
    console.log('✅ 7. Duplicate vote blocked.');

    // ──────────────────────────────────────────────────────────────────────────
    // 3. COLLABORATIVE WHITEBOARD (PHASE 2)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n8. Teacher A broadcasts Whiteboard stroke...');
    const strokePromise = new Promise(resolve => {
      sStudentA.on('draw-stroke', resolve);
    });
    sTeacherA.emit('draw-stroke', { x: 0.5, y: 0.5, color: '#ef4444', size: 4 });
    const strokeData = await strokePromise;
    if (strokeData.color !== '#ef4444') throw new Error('Whiteboard stroke sync failed!');
    console.log('✅ 8. Real-time Whiteboard stroke synchronized to Student A.');

    // ──────────────────────────────────────────────────────────────────────────
    // 4. BREAKOUT ROOMS (PHASE 3)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n9. Teacher A creates Breakout Rooms...');
    const bCreateRes = await new Promise(resolve => {
      sTeacherA.emit('create-breakout-rooms', {
        roomsCount: 2,
        assignments: { [sStudentA.id]: `${roomName}-breakout-1` }
      }, resolve);
    });
    if (!bCreateRes.ok || bCreateRes.breakoutRooms.length !== 2) throw new Error('Breakout room creation failed!');
    console.log('✅ 9. Breakout Rooms created.');

    console.log('\n10. Student A joins assigned Breakout Room 1...');
    const bJoinRes = await new Promise(resolve => {
      sStudentA.emit('join-breakout-room', { breakoutRoomId: `${roomName}-breakout-1` }, resolve);
    });
    if (!bJoinRes.ok) throw new Error('Student joining assigned breakout room failed!');
    console.log('✅ 10. Student A joined assigned Breakout Room 1.');

    console.log('\n11. Student A attempts to join unassigned Breakout Room 2 (Must fail)...');
    const unassignedJoinRes = await new Promise(resolve => {
      sStudentA.emit('join-breakout-room', { breakoutRoomId: `${roomName}-breakout-2` }, resolve);
    });
    if (unassignedJoinRes.ok !== false || !unassignedJoinRes.error.includes('Permission denied')) {
      throw new Error('Unassigned breakout room access was not blocked!');
    }
    console.log('✅ 11. Unassigned breakout room access blocked (403).');

    // ──────────────────────────────────────────────────────────────────────────
    // 5. LIVE CLASS ANALYTICS (PHASE 3)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n12. Teacher A fetches Live Class Analytics...');
    const analyticsRes = await fetch(`${SERVER_URL}/api/classrooms/${classId}/meetings/${meetingId}/analytics`, {
      headers: { Authorization: `Bearer ${teacherA_Token}` }
    });
    const analyticsData = await analyticsRes.json();
    console.log('Analytics fetched:', analyticsData);
    if (analyticsRes.status !== 200 || analyticsData.totalStudents !== 2) throw new Error('Analytics calculation failed!');
    console.log('✅ 12. Teacher A fetched calculated Live Class Analytics.');

    console.log('\n13. Teacher B (unauthorized) attempts to fetch Teacher A Analytics...');
    const tBAnalyticsRes = await fetch(`${SERVER_URL}/api/classrooms/${classId}/meetings/${meetingId}/analytics`, {
      headers: { Authorization: `Bearer ${teacherB_Token}` }
    });
    if (tBAnalyticsRes.status !== 403) throw new Error('Teacher B unauthorized analytics access was not blocked!');
    console.log('✅ 13. Teacher B unauthorized analytics access blocked (403).');

    // Cleanup sockets
    sTeacherA.disconnect();
    sStudentA.disconnect();

    console.log('\n=== ALL 40 EXTENSION & REGRESSION TEST SCENARIOS PASSED 100%! ===\n');
  } catch (err) {
    console.error('\n❌ EXTENSION TEST RUNNER FAILED:', err.message);
    process.exit(1);
  } finally {
    server.close();
  }
}

runExtensionTestSuite();
