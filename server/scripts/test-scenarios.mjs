import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import classroomsRoutes from '../src/routes/classrooms.js';

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

const teacherA_Token = createToken({ uid: 'teacher_A_123', email: 'teacherA@test.com', name: 'Teacher A', role: 'teacher' });
const teacherB_Token = createToken({ uid: 'teacher_B_456', email: 'teacherB@test.com', name: 'Teacher B', role: 'teacher' });
const student_Token = createToken({ uid: 'student_S_789', email: 'studentS@test.com', name: 'Student S', role: 'student' });

const app = express();
app.use(express.json());
app.use('/api/classrooms', classroomsRoutes);

const PORT = 5099;
const server = app.listen(PORT, async () => {
  console.log(`Test server running on port ${PORT}...`);
  try {
    await runScenarioTests();
  } catch (err) {
    console.error('TEST ERROR:', err);
    process.exitCode = 1;
  } finally {
    server.close(() => console.log('Test server closed.'));
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

async function runScenarioTests() {
  console.log('\n--- STARTING END-TO-END SCENARIO TESTS ---\n');

  // SCENARIO 1: Teacher A creates Classroom A
  console.log('1. Teacher A creates Classroom A...');
  const createRes = await apiRequest('/api/classrooms', 'POST', teacherA_Token, {
    classroomName: 'Physics 101',
    description: 'Introductory Physics',
    subject: 'Physics'
  });
  console.log('Creation response status:', createRes.status);
  console.log('Classroom created:', createRes.data.id, 'Code:', createRes.data.classroomCode);
  if (createRes.status !== 201 || !createRes.data.id) {
    throw new Error(`Classroom creation failed! ${JSON.stringify(createRes.data)}`);
  }
  const classAId = createRes.data.id;
  const classACode = createRes.data.classroomCode;

  // Teacher A fetches classrooms
  console.log('\n2. Teacher A fetches classrooms...');
  const teacherAGet = await apiRequest('/api/classrooms', 'GET', teacherA_Token);
  console.log('Teacher A classrooms count:', teacherAGet.data.length);
  const foundA = Array.isArray(teacherAGet.data) && teacherAGet.data.some(c => (c.id || c.classroomId) === classAId);
  console.log('Teacher A sees Classroom A?', foundA ? 'YES' : 'NO');
  if (!foundA) throw new Error('Teacher A cannot see Classroom A!');

  // Teacher B fetches classrooms
  console.log('\n3. Teacher B fetches classrooms...');
  const teacherBGet = await apiRequest('/api/classrooms', 'GET', teacherB_Token);
  console.log('Teacher B classrooms count:', Array.isArray(teacherBGet.data) ? teacherBGet.data.length : 0);
  const foundB = Array.isArray(teacherBGet.data) && teacherBGet.data.some(c => (c.id || c.classroomId) === classAId);
  console.log('Teacher B sees Classroom A?', foundB ? 'YES' : 'NO');
  if (foundB) throw new Error('SECURITY VIOLATION: Teacher B CAN SEE Teacher A\'s classroom!');

  // SCENARIO 2: Student enters Classroom A Code -> Join Request created (Pending)
  console.log('\n4. Student requests to join Classroom A via code:', classACode);
  const joinRes = await apiRequest('/api/classrooms/join', 'POST', student_Token, { code: classACode });
  console.log('Join response status:', joinRes.status, 'Message:', joinRes.data.message);
  if (joinRes.status !== 200 || joinRes.data.status !== 'pending') {
    throw new Error(`Student join request creation failed! ${JSON.stringify(joinRes.data)}`);
  }

  // SCENARIO 3 & 4: Join request visibility & actions
  console.log('\n5. Teacher B attempts to view join requests for Classroom A...');
  const reqsB = await apiRequest(`/api/classrooms/${classAId}/requests`, 'GET', teacherB_Token);
  console.log('Teacher B get requests status:', reqsB.status, 'Data:', reqsB.data);
  if (reqsB.status !== 403) throw new Error('SECURITY VIOLATION: Teacher B could view Teacher A\'s requests!');

  console.log('\n6. Teacher A views join requests for Classroom A...');
  const reqsA = await apiRequest(`/api/classrooms/${classAId}/requests`, 'GET', teacherA_Token);
  console.log('Teacher A requests count:', reqsA.data.requests ? reqsA.data.requests.length : 0);
  if (reqsA.status !== 200 || !reqsA.data.requests || reqsA.data.requests.length === 0) {
    throw new Error('Teacher A cannot view pending join request!');
  }

  // Teacher B attempts to approve
  console.log('\n7. Teacher B attempts to approve Student\'s request...');
  const approveB = await apiRequest(`/api/classrooms/${classAId}/requests/student_S_789/accept`, 'POST', teacherB_Token);
  console.log('Teacher B approve status:', approveB.status, 'Error:', approveB.data.error);
  if (approveB.status !== 403) throw new Error('SECURITY VIOLATION: Teacher B approved Teacher A\'s request!');

  // Teacher B attempts to edit classroom details
  console.log('\n8. Teacher B attempts to edit Classroom A...');
  const editB = await apiRequest(`/api/classrooms/${classAId}`, 'PUT', teacherB_Token, { classroomName: 'Hacked Class' });
  console.log('Teacher B edit status:', editB.status, 'Error:', editB.data.error);
  if (editB.status !== 403) throw new Error('SECURITY VIOLATION: Teacher B edited Teacher A\'s classroom!');

  // Teacher B attempts to delete classroom
  console.log('\n9. Teacher B attempts to delete Classroom A...');
  const deleteB = await apiRequest(`/api/classrooms/${classAId}`, 'DELETE', teacherB_Token);
  console.log('Teacher B delete status:', deleteB.status, 'Error:', deleteB.data.error);
  if (deleteB.status !== 403) throw new Error('SECURITY VIOLATION: Teacher B deleted Teacher A\'s classroom!');

  // Teacher A approves request
  console.log('\n10. Teacher A approves Student\'s request...');
  const approveA = await apiRequest(`/api/classrooms/${classAId}/requests/student_S_789/accept`, 'POST', teacherA_Token);
  console.log('Teacher A approve status:', approveA.status, 'Message:', approveA.data.message);
  if (approveA.status !== 200) throw new Error('Teacher A failed to approve student!');

  // Verify Student is now member
  console.log('\n11. Student fetches classrooms after approval...');
  const studentGet = await apiRequest('/api/classrooms', 'GET', student_Token);
  console.log('Student classrooms count:', studentGet.data.length);
  const foundStudent = Array.isArray(studentGet.data) && studentGet.data.some(c => (c.id || c.classroomId) === classAId);
  console.log('Student sees Classroom A after approval?', foundStudent ? 'YES' : 'NO');
  if (!foundStudent) throw new Error('Student does not see classroom after approval!');

  // Clean up created test classroom
  await apiRequest(`/api/classrooms/${classAId}`, 'DELETE', teacherA_Token);

  console.log('\n=== ALL 5 END-TO-END SCENARIO TESTS PASSED SUCCESSFULLY! ===\n');
}
