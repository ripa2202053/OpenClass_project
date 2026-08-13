import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import classroomsRoutes from '../src/routes/classrooms.js';
import meetingsRoutes from '../src/routes/meetings.js';

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

function createToken(payloadObj) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  return `${header}.${payload}.mock_sig`;
}

const teacherA_Token = createToken({ uid: 'teacher_live_A_101', email: 'teacherLiveA@test.com', name: 'Teacher Live A', role: 'teacher' });
const teacherB_Token = createToken({ uid: 'teacher_live_B_202', email: 'teacherLiveB@test.com', name: 'Teacher Live B', role: 'teacher' });
const studentEnrolledToken = createToken({ uid: 'student_enrolled_303', email: 'studentEnrolled@test.com', name: 'Student Enrolled', role: 'student' });
const studentUnenrolledToken = createToken({ uid: 'student_unenrolled_404', email: 'studentUnenrolled@test.com', name: 'Student Unenrolled', role: 'student' });

const app = express();
app.use(express.json());
app.use('/api/classrooms', classroomsRoutes);
app.use('/api/classrooms/:classId/meetings', meetingsRoutes);

const PORT = 5098;
const server = app.listen(PORT, async () => {
  console.log(`Live class test server running on port ${PORT}...`);
  try {
    await runLiveClassTests();
  } catch (err) {
    console.error('LIVE CLASS TEST ERROR:', err);
    process.exitCode = 1;
  } finally {
    server.close(() => console.log('Live class test server closed.'));
  }
});

async function apiRequest(path, method = 'GET', token, body = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(`http://localhost:${PORT}${path}`, options);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function runLiveClassTests() {
  console.log('\n--- STARTING LIVE CLASS END-TO-END TESTS ---\n');

  // SETUP: Teacher A creates Classroom A
  console.log('1. Teacher A creates Classroom A...');
  const createClassRes = await apiRequest('/api/classrooms', 'POST', teacherA_Token, {
    classroomName: 'Calculus III',
    section: 'Section B',
    subject: 'Math'
  });
  if (createClassRes.status !== 201 || !createClassRes.data.id) {
    throw new Error(`Failed to create classroom: ${JSON.stringify(createClassRes.data)}`);
  }
  const classAId = createClassRes.data.id;
  const classACode = createClassRes.data.classroomCode;
  console.log('Classroom A created:', classAId, 'Code:', classACode);

  // Student Enrolled joins and gets approved
  console.log('\n2. Enrolled Student joins Classroom A and gets approved...');
  await apiRequest('/api/classrooms/join', 'POST', studentEnrolledToken, { code: classACode });
  await apiRequest(`/api/classrooms/${classAId}/requests/student_enrolled_303/accept`, 'POST', teacherA_Token);

  // TEST 1: Teacher A creates Live Class in Classroom A
  console.log('\n3. Teacher A creates a Live Class in Classroom A...');
  const createLiveRes = await apiRequest(`/api/classrooms/${classAId}/meetings`, 'POST', teacherA_Token, {
    title: 'Derivatives & Integration Live',
    description: 'Weekly interactive problem set session',
    meetingType: 'scheduled',
    scheduledAt: new Date(Date.now() + 3600000).toISOString()
  });
  console.log('Live class creation status:', createLiveRes.status, 'Title:', createLiveRes.data.title);
  if (createLiveRes.status !== 201 || !createLiveRes.data.id || createLiveRes.data.classroomId !== classAId) {
    throw new Error(`Teacher A live class creation failed: ${JSON.stringify(createLiveRes.data)}`);
  }
  const liveClassId = createLiveRes.data.id;

  // TEST 2: Teacher B attempts to create a Live Class in Classroom A
  console.log('\n4. Teacher B attempts to create a Live Class in Classroom A...');
  const createLiveB = await apiRequest(`/api/classrooms/${classAId}/meetings`, 'POST', teacherB_Token, {
    title: 'Unauthorized Live Class'
  });
  console.log('Teacher B create status:', createLiveB.status, 'Error:', createLiveB.data.error);
  if (createLiveB.status !== 403) {
    throw new Error('SECURITY VIOLATION: Teacher B created a live class in Teacher A\'s classroom!');
  }

  // TEST 3: Enrolled Student fetches Live Classes for Classroom A
  console.log('\n5. Enrolled Student fetches Live Classes for Classroom A...');
  const enrolledGet = await apiRequest(`/api/classrooms/${classAId}/meetings`, 'GET', studentEnrolledToken);
  console.log('Enrolled student fetch status:', enrolledGet.status, 'Count:', Array.isArray(enrolledGet.data) ? enrolledGet.data.length : 0);
  if (enrolledGet.status !== 200 || !Array.isArray(enrolledGet.data) || !enrolledGet.data.some(m => m.id === liveClassId)) {
    throw new Error('Enrolled student cannot see Live Class A!');
  }

  // TEST 4: Unenrolled Student attempts to fetch Live Classes for Classroom A
  console.log('\n6. Unenrolled Student attempts to fetch Live Classes for Classroom A...');
  const unenrolledGet = await apiRequest(`/api/classrooms/${classAId}/meetings`, 'GET', studentUnenrolledToken);
  console.log('Unenrolled student fetch status:', unenrolledGet.status, 'Error:', unenrolledGet.data.error);
  if (unenrolledGet.status !== 403) {
    throw new Error('SECURITY VIOLATION: Unenrolled student accessed Live Classes for Classroom A!');
  }

  // TEST 5: Teacher B attempts to Start, End, or Delete Live Class A
  console.log('\n7. Teacher B attempts to start Live Class A...');
  const startB = await apiRequest(`/api/classrooms/${classAId}/meetings/${liveClassId}/start`, 'POST', teacherB_Token);
  console.log('Teacher B start status:', startB.status, 'Error:', startB.data.error);
  if (startB.status !== 403) throw new Error('SECURITY VIOLATION: Teacher B started Live Class A!');

  console.log('\n8. Student attempts early access to scheduled meeting before teacher starts...');
  const earlyCheck = await apiRequest(`/api/classrooms/${classAId}/meetings/${liveClassId}`, 'GET', studentEnrolledToken);
  console.log('Early join check status:', earlyCheck.status, 'Error:', earlyCheck.data.error);
  if (earlyCheck.status !== 403) {
    throw new Error('SECURITY VIOLATION: Enrolled student accessed scheduled meeting before teacher started class!');
  }

  console.log('\n9. Teacher B attempts to end Live Class A...');
  const endB = await apiRequest(`/api/classrooms/${classAId}/meetings/${liveClassId}/end`, 'POST', teacherB_Token);
  console.log('Teacher B end status:', endB.status, 'Error:', endB.data.error);
  if (endB.status !== 403) throw new Error('SECURITY VIOLATION: Teacher B ended Live Class A!');

  console.log('\n10. Teacher B attempts to delete Live Class A...');
  const deleteB = await apiRequest(`/api/classrooms/${classAId}/meetings/${liveClassId}`, 'DELETE', teacherB_Token);
  console.log('Teacher B delete status:', deleteB.status, 'Error:', deleteB.data.error);
  if (deleteB.status !== 403) throw new Error('SECURITY VIOLATION: Teacher B deleted Live Class A!');

  // TEST 6: Teacher A starts Live Class A
  console.log('\n10. Teacher A starts Live Class A...');
  const startA = await apiRequest(`/api/classrooms/${classAId}/meetings/${liveClassId}/start`, 'POST', teacherA_Token);
  console.log('Teacher A start status:', startA.status, 'Status:', startA.data.status);
  if (startA.status !== 200 || startA.data.status !== 'ongoing') {
    throw new Error('Teacher A failed to start Live Class A!');
  }

  // TEST 7: Teacher A creates an Instant Live Class
  console.log('\n11. Teacher A creates an Instant Live Class in Classroom A...');
  const instantRes = await apiRequest(`/api/classrooms/${classAId}/meetings`, 'POST', teacherA_Token, {
    title: 'Instant Math Office Hours',
    meetingType: 'instant'
  });
  console.log('Instant creation status:', instantRes.status, 'Status:', instantRes.data.status, 'RoomName:', instantRes.data.roomName);
  if (instantRes.status !== 201 || instantRes.data.status !== 'ongoing' || !instantRes.data.roomName) {
    throw new Error(`Instant Live Class creation failed: ${JSON.stringify(instantRes.data)}`);
  }
  const instantRoomName = instantRes.data.roomName;
  const instantId = instantRes.data.id;

  // TEST 8: Enrolled Student verifies Instant Live Class presence and matching roomName
  console.log('\n12. Enrolled Student fetches meetings to verify Instant Live Class...');
  const studentInstantGet = await apiRequest(`/api/classrooms/${classAId}/meetings`, 'GET', studentEnrolledToken);
  const foundInstant = Array.isArray(studentInstantGet.data) && studentInstantGet.data.find(m => m.id === instantId);
  console.log('Enrolled student found instant class?', !!foundInstant, 'Student RoomName:', foundInstant?.roomName);
  if (!foundInstant || foundInstant.status !== 'ongoing' || foundInstant.roomName !== instantRoomName) {
    throw new Error('STUDENT MISMATCH: Student did not receive ongoing instant live class with matching roomName!');
  }

  // TEST 9: Teacher A ends Live Class A
  console.log('\n13. Teacher A ends Live Class A...');
  const endA = await apiRequest(`/api/classrooms/${classAId}/meetings/${liveClassId}/end`, 'POST', teacherA_Token);
  console.log('Teacher A end status:', endA.status, 'Status:', endA.data.status);
  if (endA.status !== 200 || endA.data.status !== 'ended') {
    throw new Error('Teacher A failed to end Live Class A!');
  }

  // Clean up
  await apiRequest(`/api/classrooms/${classAId}`, 'DELETE', teacherA_Token);

  console.log('\n=== ALL LIVE CLASS END-TO-END SCENARIO TESTS PASSED SUCCESSFULLY! ===\n');
}
