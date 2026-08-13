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

// Mock Firebase tokens for testing
function createMockToken(uid, role = 'student', email = 'test@example.com') {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64');
  const payload = Buffer.from(JSON.stringify({
    uid,
    user_id: uid,
    sub: uid,
    email,
    role,
    name: uid === 'teacher_live_A_101' ? 'Teacher A' : (uid === 'teacher_live_B_202' ? 'Teacher B' : 'Student A')
  })).toString('base64');
  return `${header}.${payload}.signature`;
}

const teacherA_Token = createMockToken('teacher_live_A_101', 'teacher', 'teachera@example.com');
const teacherB_Token = createMockToken('teacher_live_B_202', 'teacher', 'teacherb@example.com');
const studentA_Token = createMockToken('student_enrolled_303', 'student', 'studenta@example.com');
const studentB_Token = createMockToken('student_enrolled_404', 'student', 'studentb@example.com');

async function runSessionControlsTests() {
  const app = express();
  app.use(express.json());
  app.use('/api/classrooms/:classId/meetings', meetingsRouter);

  const server = http.createServer(app);
  attachSignaling(server);

  await new Promise(resolve => server.listen(5099, resolve));
  console.log('Live session controls test server running on port 5099...\n');
  const SERVER_URL = 'http://localhost:5099';

  function connectSocket() {
    return ioClient(SERVER_URL, { transports: ['websocket'], forceNew: true });
  }

  const roomName = 'OpenClass-TestRoom-' + Date.now().toString(36);

  try {
    console.log('--- STARTING LIVE SESSION CONTROLS END-TO-END TESTS ---\n');

    // Create mock classroom and meeting documents in Firestore
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore();
    const classAId = 'class_test_A_' + Date.now();
    const meetingId = 'meeting_test_A_' + Date.now();

    await db.collection('classrooms').doc(classAId).set({
      classroomName: 'Physics 101',
      createdBy: 'teacher_live_A_101',
      teacherUid: 'teacher_live_A_101',
      enrolledStudents: ['student_enrolled_303', 'student_enrolled_404'],
      isActive: true
    });

    await db.collection('meetings').doc(meetingId).set({
      classroomId: classAId,
      createdBy: 'teacher_live_A_101',
      teacherUid: 'teacher_live_A_101',
      roomName: roomName,
      status: 'ongoing',
      title: 'Quantum Mechanics Live'
    });

    // TEST 1: Socket Authentication Failure (No token)
    console.log('1. Testing Socket Authentication without token...');
    const sUnauth = connectSocket();
    await new Promise((resolve) => sUnauth.on('connect', resolve));

    const authFailRes = await new Promise((resolve) => {
      sUnauth.emit('join-room', { roomId: roomName, userName: 'Unauth User' }, resolve);
    });
    console.log('Unauth join result:', authFailRes);
    if (authFailRes.ok !== false || !authFailRes.error.includes('Authentication required')) {
      throw new Error('TEST 1 FAILED: Unauthenticated socket join was not rejected!');
    }
    sUnauth.disconnect();
    console.log('✅ TEST 1 PASSED: Unauthenticated socket rejected.');

    // TEST 2: Valid Teacher joins as Host
    console.log('\n2. Testing Teacher A joining as Host...');
    const sTeacherA = connectSocket();
    await new Promise((resolve) => sTeacherA.on('connect', resolve));

    const teacherJoinRes = await new Promise((resolve) => {
      sTeacherA.emit('join-room', { roomId: roomName, userName: 'Teacher A', token: teacherA_Token }, resolve);
    });
    console.log('Teacher A join result:', teacherJoinRes);
    if (!teacherJoinRes.ok || teacherJoinRes.isHost !== true) {
      throw new Error('TEST 2 FAILED: Teacher A join failed or isHost was not true!');
    }
    console.log('✅ TEST 2 PASSED: Teacher A joined as Host.');

    // TEST 3 & 4: Student Joins after Teacher (Must get isHost = false)
    console.log('\n3. Testing Student A joining after Teacher A (Must receive isHost = false)...');
    const sStudentA = connectSocket();
    await new Promise((resolve) => sStudentA.on('connect', resolve));

    const studentAJoinRes = await new Promise((resolve) => {
      sStudentA.emit('join-room', { roomId: roomName, userName: 'Student A', token: studentA_Token }, resolve);
    });
    console.log('Student A join result:', studentAJoinRes);
    if (!studentAJoinRes.ok || studentAJoinRes.isHost !== false) {
      throw new Error('TEST 3 FAILED: Student A join failed or received isHost = true!');
    }
    console.log('✅ TEST 3 PASSED: Student A joined with isHost = false.');

    // TEST 5: Student B Joins
    console.log('\n4. Testing Student B joining meeting room...');
    const sStudentB = connectSocket();
    await new Promise((resolve) => sStudentB.on('connect', resolve));

    const studentBJoinRes = await new Promise((resolve) => {
      sStudentB.emit('join-room', { roomId: roomName, userName: 'Student B', token: studentB_Token }, resolve);
    });
    console.log('Student B join result:', studentBJoinRes);
    if (!studentBJoinRes.ok || studentBJoinRes.isHost !== false) {
      throw new Error('TEST 4 FAILED: Student B join failed!');
    }
    console.log('✅ TEST 4 PASSED: Student B joined meeting room.');

    // TEST 6: Student A attempts to kick Student B (Must fail)
    console.log('\n5. Testing Student A attempting to kick Student B...');
    const studentKickRes = await new Promise((resolve) => {
      sStudentA.emit('kick-participant', { targetSocketId: sStudentB.id }, resolve);
    });
    console.log('Student A kick result:', studentKickRes);
    if (studentKickRes.ok !== false || !studentKickRes.error.includes('Only the classroom teacher')) {
      throw new Error('SECURITY VIOLATION: Student A was allowed to kick Student B!');
    }
    console.log('✅ TEST 5 PASSED: Student kick attempt blocked.');

    // TEST 7: Teacher B (unauthorized teacher) attempts to kick Student B (Must fail)
    console.log('\n6. Testing Teacher B (unauthorized) attempting to kick Student B from Teacher A room...');
    const sTeacherB = connectSocket();
    await new Promise((resolve) => sTeacherB.on('connect', resolve));
    await new Promise((resolve) => {
      sTeacherB.emit('join-room', { roomId: roomName, userName: 'Teacher B', token: teacherB_Token }, resolve);
    });

    const teacherBKickRes = await new Promise((resolve) => {
      sTeacherB.emit('kick-participant', { targetSocketId: sStudentB.id }, resolve);
    });
    console.log('Teacher B kick result:', teacherBKickRes);
    if (teacherBKickRes.ok !== false) {
      throw new Error('SECURITY VIOLATION: Teacher B was allowed to kick a student from Teacher A room!');
    }
    sTeacherB.disconnect();
    console.log('✅ TEST 6 PASSED: Unauthorized Teacher B kick attempt blocked.');

    // TEST 8: Teacher A kicks Student A
    console.log('\n7. Testing Teacher A kicking Student A...');
    const studentAKickedPromise = new Promise((resolve) => {
      sStudentA.on('participant-kicked', resolve);
    });

    const teacherKickARes = await new Promise((resolve) => {
      sTeacherA.emit('kick-participant', { targetSocketId: sStudentA.id }, resolve);
    });
    console.log('Teacher A kick Student A result:', teacherKickARes);
    if (!teacherKickARes.ok) {
      throw new Error('TEST 7 FAILED: Teacher A could not kick Student A!');
    }

    const kickEvent = await studentAKickedPromise;
    console.log('Student A received kick event:', kickEvent);
    if (!kickEvent.reason.includes('removed from this live class')) {
      throw new Error('TEST 7 FAILED: Student A did not receive proper kick payload!');
    }
    sStudentA.disconnect();
    console.log('✅ TEST 7 PASSED: Teacher A kicked Student A successfully, Student B remains connected.');

    // TEST 9: Student B attempts to end meeting (Must fail)
    console.log('\n8. Testing Student B attempting to end meeting...');
    const studentEndRes = await new Promise((resolve) => {
      sStudentB.emit('end-meeting', { roomId: roomName }, resolve);
    });
    console.log('Student B end meeting result:', studentEndRes);
    if (studentEndRes.ok !== false || !studentEndRes.error.includes('Only the classroom teacher')) {
      throw new Error('SECURITY VIOLATION: Student B was allowed to end the meeting!');
    }
    console.log('✅ TEST 8 PASSED: Student end-meeting attempt blocked.');

    // TEST 10: Teacher A ends meeting for all
    console.log('\n9. Testing Teacher A ending meeting for all...');
    const studentBEndedPromise = new Promise((resolve) => {
      sStudentB.on('meeting-ended', resolve);
    });

    const teacherEndRes = await new Promise((resolve) => {
      sTeacherA.emit('end-meeting', { roomId: roomName }, resolve);
    });
    console.log('Teacher A end meeting result:', teacherEndRes);
    if (!teacherEndRes.ok) {
      throw new Error('TEST 9 FAILED: Teacher A failed to end meeting for all!');
    }

    const endedEvent = await studentBEndedPromise;
    console.log('Student B received meeting-ended event:', endedEvent);
    console.log('✅ TEST 9 PASSED: Teacher A ended meeting for all, Student B received event.');

    sTeacherA.disconnect();
    sStudentB.disconnect();

    console.log('\n=== ALL LIVE SESSION CONTROLS TEST SCENARIOS PASSED 100%! ===\n');
  } catch (err) {
    console.error('\n❌ TEST RUNNER FAILED:', err.message);
    process.exit(1);
  } finally {
    server.close();
  }
}

runSessionControlsTests();
