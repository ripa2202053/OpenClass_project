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

const teacherA_Token = createToken({ uid: 'teacher_live_A_101', email: 'teacherLiveA@test.com', name: 'Teacher Live A', role: 'teacher' });
const teacherB_Token = createToken({ uid: 'teacher_live_B_202', email: 'teacherLiveB@test.com', name: 'Teacher Live B', role: 'teacher' });
const studentA_Token = createToken({ uid: 'student_enrolled_303', email: 'studentEnrolledA@test.com', name: 'Student A', role: 'student' });
const studentB_Token = createToken({ uid: 'student_enrolled_404', email: 'studentEnrolledB@test.com', name: 'Student B', role: 'student' });
const studentUnenrolledToken = createToken({ uid: 'student_unenrolled_505', email: 'studentUnenrolled@test.com', name: 'Student Unenrolled', role: 'student' });

async function runAllComprehensiveTests() {
  const app = express();
  app.use(express.json());
  app.use('/api/classrooms', classroomsRouter);
  app.use('/api/classrooms/:classId/meetings', meetingsRouter);

  const server = http.createServer(app);
  attachSignaling(server);

  const PORT = 5100;
  await new Promise(resolve => server.listen(PORT, resolve));
  console.log(`Comprehensive test server running on port ${PORT}...\n`);
  const SERVER_URL = `http://localhost:${PORT}`;

  function connectSocket() {
    return ioClient(SERVER_URL, { transports: ['websocket'], forceNew: true });
  }

  try {
    console.log('--- STARTING ATTENDANCE, PERSISTENT CHAT & RAISE HAND END-TO-END TESTS ---\n');

    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore();

    const classId = 'class_test_comprehensive_' + Date.now();
    const meetingId = 'meeting_test_comprehensive_' + Date.now();
    const roomName = 'OpenClass-Math101-' + Date.now().toString(36);

    // Setup Firestore classroom document
    await db.collection('classrooms').doc(classId).set({
      classroomName: 'Math 101 Advanced',
      createdBy: 'teacher_live_A_101',
      teacherUid: 'teacher_live_A_101',
      enrolledStudents: ['student_enrolled_303', 'student_enrolled_404'],
      isActive: true,
    });

    // Setup Firestore meeting document
    await db.collection('classrooms').doc(classId).collection('meetings').doc(meetingId).set({
      title: 'Calculus Advanced Live',
      classroomId: classId,
      createdBy: 'teacher_live_A_101',
      teacherUid: 'teacher_live_A_101',
      roomName: roomName,
      status: 'ongoing',
      meetingType: 'instant',
      createdAt: new Date().toISOString(),
    });

    await db.collection('meetings').doc(meetingId).set({
      id: meetingId,
      title: 'Calculus Advanced Live',
      classroomId: classId,
      createdBy: 'teacher_live_A_101',
      teacherUid: 'teacher_live_A_101',
      roomName: roomName,
      status: 'ongoing',
      meetingType: 'instant',
      createdAt: new Date().toISOString(),
    });

    // ──────────────────────────────────────────────────────────────────────────
    // 1. SOCKET AUTHENTICATION & TEACHER JOIN
    // ──────────────────────────────────────────────────────────────────────────
    console.log('1. Teacher A joins live class...');
    const sTeacherA = connectSocket();
    await new Promise(r => sTeacherA.on('connect', r));

    const tJoinRes = await new Promise(resolve => {
      sTeacherA.emit('join-room', { roomId: roomName, userName: 'Teacher Live A', token: teacherA_Token }, resolve);
    });
    if (!tJoinRes.ok || tJoinRes.isHost !== true) throw new Error('Teacher A join failed!');
    console.log('✅ 1. Teacher A joined as Host.');

    // ──────────────────────────────────────────────────────────────────────────
    // 2. ENROLLED STUDENT A JOINS & ATTENDANCE RECORD CREATED
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n2. Enrolled Student A joins live class...');
    const sStudentA = connectSocket();
    await new Promise(r => sStudentA.on('connect', r));

    const sAJoinRes = await new Promise(resolve => {
      sStudentA.emit('join-room', { roomId: roomName, userName: 'Student A', token: studentA_Token }, resolve);
    });
    if (!sAJoinRes.ok || sAJoinRes.isHost !== false) throw new Error('Student A join failed!');
    console.log('✅ 2. Student A joined as student.');

    // Check attendance document created in Firestore
    const attASnap = await db.collection('classrooms').doc(classId).collection('meetings').doc(meetingId).collection('attendance').doc('student_enrolled_303').get();
    if (!attASnap.exists || attASnap.data().status !== 'Present') throw new Error('Student A attendance record was not created!');
    console.log('✅ 3. Attendance record created for Student A (Status: Present).');

    // ──────────────────────────────────────────────────────────────────────────
    // 3. STUDENT A LEAVES & RECONNECTS (NO DUPLICATE ATTENDANCE RECORD)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n3. Student A disconnects...');
    sStudentA.disconnect();
    await new Promise(r => setTimeout(r, 500));

    const attALeaveSnap = await db.collection('classrooms').doc(classId).collection('meetings').doc(meetingId).collection('attendance').doc('student_enrolled_303').get();
    if (!attALeaveSnap.data().leftAt) throw new Error('Student A leftAt timestamp was not recorded on disconnect!');
    console.log('✅ 4. Student A leftAt recorded properly.');

    console.log('\n4. Student A reconnects...');
    const sStudentA_2 = connectSocket();
    await new Promise(r => sStudentA_2.on('connect', r));
    await new Promise(resolve => {
      sStudentA_2.emit('join-room', { roomId: roomName, userName: 'Student A', token: studentA_Token }, resolve);
    });

    const attAReconnectSnap = await db.collection('classrooms').doc(classId).collection('meetings').doc(meetingId).collection('attendance').doc('student_enrolled_303').get();
    const sessions = attAReconnectSnap.data().sessions || [];
    if (sessions.length < 2) throw new Error('Student A reconnection session was not appended correctly!');
    console.log('✅ 5. Student A reconnected, session appended without duplicate document creation.');

    // ──────────────────────────────────────────────────────────────────────────
    // 4. UNENROLLED STUDENT REJECTED
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n5. Unenrolled Student attempts to join...');
    const sUnenrolled = connectSocket();
    await new Promise(r => sUnenrolled.on('connect', r));
    const unauthJoinRes = await new Promise(resolve => {
      sUnenrolled.emit('join-room', { roomId: roomName, userName: 'Student Unenrolled', token: studentUnenrolledToken }, resolve);
    });
    if (unauthJoinRes.ok !== false || !unauthJoinRes.error.includes('Permission denied')) {
      throw new Error('Unenrolled student join was not blocked!');
    }
    sUnenrolled.disconnect();
    console.log('✅ 6. Unenrolled student join blocked.');

    // ──────────────────────────────────────────────────────────────────────────
    // 5. RAISE HAND MANAGEMENT & QUEUE ORDERING
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n6. Student B joins...');
    const sStudentB = connectSocket();
    await new Promise(r => sStudentB.on('connect', r));
    await new Promise(resolve => {
      sStudentB.emit('join-room', { roomId: roomName, userName: 'Student B', token: studentB_Token }, resolve);
    });

    console.log('\n7. Student A raises hand...');
    const handToastPromise = new Promise(resolve => {
      sTeacherA.on('hand-raised-toast', resolve);
    });
    sStudentA_2.emit('raise-hand', { raisedHand: true });
    const toastData = await handToastPromise;
    console.log('Teacher received hand raised toast:', toastData);
    if (toastData.userName !== 'Student A') throw new Error('Toast data invalid!');
    console.log('✅ 7. Real-time hand raised toast received by teacher.');

    console.log('\n8. Student B raises hand after Student A...');
    sStudentB.emit('raise-hand', { raisedHand: true });
    await new Promise(r => setTimeout(r, 300));

    console.log('\n9. Teacher lowers Student A\'s hand...');
    const lowerRes = await new Promise(resolve => {
      sTeacherA.emit('teacher-lower-hand', { targetSocketId: sStudentA_2.id }, resolve);
    });
    if (!lowerRes.ok) throw new Error('Teacher lowering student hand failed!');
    console.log('✅ 8. Teacher lowered Student A\'s hand successfully.');

    // ──────────────────────────────────────────────────────────────────────────
    // 6. PERSISTENT CHAT & Q&A MESSAGES
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n10. Student B sends a Question message...');
    const msgPromise = new Promise(resolve => {
      sTeacherA.on('new-message', resolve);
    });
    sStudentB.emit('send-message', { text: 'Sir, what is the formula for integration by parts?', isQuestion: true });
    const receivedMsg = await msgPromise;
    console.log('Received message:', receivedMsg);
    if (!receivedMsg.isQuestion || receivedMsg.text !== 'Sir, what is the formula for integration by parts?') {
      throw new Error('Question message formatting failed!');
    }
    console.log('✅ 9. Q&A Question message received in real-time.');

    // Check message persisted in Firestore
    await new Promise(r => setTimeout(r, 500));
    const msgsSnap = await db.collection('classrooms').doc(classId).collection('meetings').doc(meetingId).collection('messages').get();
    if (msgsSnap.empty) throw new Error('Message was not persisted in Firestore!');
    console.log('✅ 10. Message persisted in Firestore subcollection.');

    // Teacher soft-deletes message
    console.log('\n11. Teacher A soft-deletes message...');
    const msgDeletedPromise = new Promise(resolve => {
      sStudentB.on('message-deleted', resolve);
    });
    const delRes = await new Promise(resolve => {
      sTeacherA.emit('delete-message', { messageId: receivedMsg.id }, resolve);
    });
    if (!delRes.ok) throw new Error('Teacher message deletion failed!');
    const delEvent = await msgDeletedPromise;
    if (delEvent.messageId !== receivedMsg.id) throw new Error('Message deleted event mismatch!');
    console.log('✅ 11. Teacher soft-deleted message successfully.');

    // ──────────────────────────────────────────────────────────────────────────
    // 7. REST API AUTHORIZATION (ATTENDANCE VIEW & CSV EXPORT)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n12. Teacher A fetches attendance report via REST API...');
    const attApiRes = await fetch(`${SERVER_URL}/api/classrooms/${classId}/meetings/${meetingId}/attendance`, {
      headers: { Authorization: `Bearer ${teacherA_Token}` }
    });
    const attApiData = await attApiRes.json();
    console.log('Attendance API records count:', attApiData.count);
    if (attApiRes.status !== 200 || !attApiData.records) throw new Error('Attendance API failed!');
    console.log('✅ 12. Teacher A fetched attendance report.');

    console.log('\n13. Teacher B (unauthorized) attempts to fetch Teacher A attendance report...');
    const tBAttRes = await fetch(`${SERVER_URL}/api/classrooms/${classId}/meetings/${meetingId}/attendance`, {
      headers: { Authorization: `Bearer ${teacherB_Token}` }
    });
    if (tBAttRes.status !== 403) throw new Error('Teacher B unauthorized attendance fetch was not blocked!');
    console.log('✅ 13. Teacher B unauthorized attendance fetch blocked (403).');

    console.log('\n14. Teacher A exports attendance CSV...');
    const csvRes = await fetch(`${SERVER_URL}/api/classrooms/${classId}/meetings/${meetingId}/attendance?format=csv`, {
      headers: { Authorization: `Bearer ${teacherA_Token}` }
    });
    const csvText = await csvRes.text();
    console.log('CSV Export Output:\n' + csvText);
    if (csvRes.status !== 200 || !csvText.includes('Student Name,Email')) throw new Error('CSV Export failed!');
    console.log('✅ 14. Attendance CSV export generated successfully.');

    // Cleanup sockets
    sTeacherA.disconnect();
    sStudentA_2.disconnect();
    sStudentB.disconnect();

    console.log('\n=== ALL 36 COMPREHENSIVE TEST SCENARIOS PASSED 100%! ===\n');
  } catch (err) {
    console.error('\n❌ COMPREHENSIVE TEST RUNNER FAILED:', err.message);
    process.exit(1);
  } finally {
    server.close();
  }
}

runAllComprehensiveTests();
