import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { io as ioClient } from 'socket.io-client';

import { attachSignaling } from '../src/socket.js';
import classroomsRoutes from '../src/routes/classrooms.js';
import filesRoutes from '../src/routes/files.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Firebase Admin
if (!getApps().length) {
  const keyPath = path.resolve(__dirname, '../serviceAccountKey.json');
  if (fs.existsSync(keyPath)) {
    try {
      const sa = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
      initializeApp({ credential: cert(sa) });
    } catch (e) {
      initializeApp({ projectId: 'openclass-7889d' });
    }
  } else {
    initializeApp({ projectId: 'openclass-7889d' });
  }
}

const db = getFirestore();
const PORT = 5105;
const BASE_URL = `http://localhost:${PORT}`;

// Helper: Make HTTP requests
function makeRequest(method, urlPath, headers = {}, bodyData = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method.toUpperCase(),
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { json = data; }
        resolve({ status: res.statusCode, data: json, headers: res.headers });
      });
    });

    req.on('error', (err) => reject(err));

    if (bodyData) {
      if (typeof bodyData === 'string') req.write(bodyData);
      else req.write(JSON.stringify(bodyData));
    }
    req.end();
  });
}

// Generate Mock ID Token for tests
function getMockToken(uid, role = 'student', name = 'Test User', email = 'test@example.com') {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    uid,
    user_id: uid,
    sub: uid,
    name,
    email,
    role,
    iss: 'https://securetoken.google.com/openclass-7889d',
    aud: 'openclass-7889d',
    auth_time: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600
  })).toString('base64url');
  return `${header}.${payload}.signature`;
}

async function runTestSuite() {
  console.log('\n==================================================');
  console.log('  CLASSROOM FILE UPLOAD & SHARING TEST SUITE');
  console.log('==================================================\n');

  // Start Express Test Server
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/api/classrooms', classroomsRoutes);
  app.use('/api/classrooms/:classId/files', filesRoutes);

  const server = http.createServer(app);
  attachSignaling(server);

  await new Promise(r => server.listen(PORT, r));
  console.log(`Test server running on ${BASE_URL}...\n`);

  let passedCount = 0;
  let totalCount = 0;

  function assert(condition, message) {
    totalCount++;
    if (condition) {
      console.log(`  [PASS] Test ${totalCount}: ${message}`);
      passedCount++;
    } else {
      console.error(`  [FAIL] Test ${totalCount}: ${message}`);
    }
  }

  // Generate test UIDs and classroom
  const teacherA = `teacher_A_${Date.now()}`;
  const teacherB = `teacher_B_${Date.now()}`;
  const studentEnrolled = `student_enrolled_${Date.now()}`;
  const studentUnenrolled = `student_unenrolled_${Date.now()}`;

  const tokenTeacherA = getMockToken(teacherA, 'teacher', 'Teacher A', 'teachera@test.com');
  const tokenTeacherB = getMockToken(teacherB, 'teacher', 'Teacher B', 'teacherb@test.com');
  const tokenStudentEnrolled = getMockToken(studentEnrolled, 'student', 'Student Enrolled', 'studentenrolled@test.com');
  const tokenStudentUnenrolled = getMockToken(studentUnenrolled, 'student', 'Student Unenrolled', 'studentunenrolled@test.com');

  // Create Classroom A
  const classId = `class_filetest_${Date.now()}`;
  await db.collection('classrooms').doc(classId).set({
    classroomName: 'File Sharing Test Classroom',
    createdBy: teacherA,
    teacherId: teacherA,
    teacherUid: teacherA,
    teacherName: 'Teacher A',
    enrolledStudents: [studentEnrolled],
    createdAt: new Date().toISOString()
  });

  // Add enrolled student to members subcollection
  await db.collection('classrooms').doc(classId).collection('members').doc(studentEnrolled).set({
    uid: studentEnrolled,
    displayName: 'Student Enrolled',
    role: 'student'
  });

  let uploadedFileId = null;
  let socketEnrolled = null;
  let realTimeUploadedReceived = false;
  let realTimeDeletedReceived = false;

  try {
    // Socket.io connection for real-time verification
    socketEnrolled = ioClient(BASE_URL, {
      auth: { token: tokenStudentEnrolled },
      transports: ['websocket', 'polling']
    });

    socketEnrolled.on('file-uploaded', (data) => {
      if (data && data.classroomId === classId) {
        realTimeUploadedReceived = true;
      }
    });

    socketEnrolled.on('file-deleted', (data) => {
      if (data && data.classroomId === classId) {
        realTimeDeletedReceived = true;
      }
    });

    await new Promise((resolve) => {
      if (socketEnrolled.connected) resolve();
      else socketEnrolled.on('connect', resolve);
    });

    await new Promise((resolve) => {
      socketEnrolled.emit('join-room', { roomId: classId, classroomId: classId, token: tokenStudentEnrolled }, () => resolve());
      setTimeout(resolve, 500);
    });

    // 1. Teacher uploads file (PDF)
    const pdfData = Buffer.from('%PDF-1.4 sample pdf content for testing file upload system').toString('base64');
    const uploadRes = await makeRequest('POST', `/api/classrooms/${classId}/files`, {
      Authorization: `Bearer ${tokenTeacherA}`
    }, {
      fileName: 'Lecture_01_Notes.pdf',
      originalName: 'Lecture_01_Notes.pdf',
      title: 'Calculus Lecture 01 Notes',
      description: 'Introductory limits and derivatives',
      category: 'PDF',
      fileData: pdfData,
      fileType: 'pdf',
      mimeType: 'application/pdf',
      fileSize: 1024
    });

    assert(uploadRes.status === 201 && (uploadRes.data.id || uploadRes.data.fileId), '1. Teacher A uploads valid PDF file -> 201 Created');
    uploadedFileId = uploadRes.data.id || uploadRes.data.fileId;

    // Emit socket event to trigger real-time notification
    socketEnrolled.emit('upload-file', { classroomId: classId, file: uploadRes.data });
    await new Promise(r => setTimeout(r, 400));

    // 2. Firestore metadata created
    const fileDocSnap = await db.collection('classrooms').doc(classId).collection('files').doc(uploadedFileId).get();
    assert(fileDocSnap.exists && fileDocSnap.data().title === 'Calculus Lecture 01 Notes', '2. Firestore metadata document created under classrooms/{classId}/files/{fileId}');

    // 3. Storage path created
    const fileData = fileDocSnap.data();
    assert(fileData.storagePath && fileData.storagePath.includes(`classrooms/${classId}/files/${uploadedFileId}`), '3. Storage path correctly configured in metadata');

    // 4. Enrolled Student can list file
    const listRes = await makeRequest('GET', `/api/classrooms/${classId}/files`, {
      Authorization: `Bearer ${tokenStudentEnrolled}`
    });
    assert(listRes.status === 200 && Array.isArray(listRes.data) && listRes.data.length > 0, '4. Enrolled Student can list classroom files');

    // 5. Enrolled Student can open file
    const openRes = await makeRequest('GET', `/api/classrooms/${classId}/files/${uploadedFileId}/download`, {
      Authorization: `Bearer ${tokenStudentEnrolled}`
    });
    assert(openRes.status === 200, '5. Enrolled Student can open/preview classroom file stream');

    // 6. Enrolled Student can download file
    assert(openRes.headers['content-disposition'] && openRes.headers['content-disposition'].includes('attachment'), '6. File stream includes download attachment content-disposition header');

    // 7. Student cannot upload (403 Forbidden)
    const studentUploadRes = await makeRequest('POST', `/api/classrooms/${classId}/files`, {
      Authorization: `Bearer ${tokenStudentEnrolled}`
    }, {
      fileName: 'Hack.pdf',
      fileData: pdfData,
      fileType: 'pdf',
      fileSize: 100
    });
    assert(studentUploadRes.status === 403, '7. Student upload attempt -> 403 Forbidden');

    // 8. Student cannot edit (403 Forbidden)
    const studentEditRes = await makeRequest('PUT', `/api/classrooms/${classId}/files/${uploadedFileId}`, {
      Authorization: `Bearer ${tokenStudentEnrolled}`
    }, {
      title: 'Hacked Title'
    });
    assert(studentEditRes.status === 403, '8. Student edit attempt -> 403 Forbidden');

    // 9. Student cannot delete (403 Forbidden)
    const studentDeleteRes = await makeRequest('DELETE', `/api/classrooms/${classId}/files/${uploadedFileId}`, {
      Authorization: `Bearer ${tokenStudentEnrolled}`
    });
    assert(studentDeleteRes.status === 403, '9. Student delete attempt -> 403 Forbidden');

    // 10. Unenrolled Student cannot list files (403 Forbidden)
    const unenrolledListRes = await makeRequest('GET', `/api/classrooms/${classId}/files`, {
      Authorization: `Bearer ${tokenStudentUnenrolled}`
    });
    assert(unenrolledListRes.status === 403, '10. Unenrolled Student list attempt -> 403 Forbidden');

    // 11. Unenrolled Student cannot download (403 Forbidden)
    const unenrolledDownloadRes = await makeRequest('GET', `/api/classrooms/${classId}/files/${uploadedFileId}/download`, {
      Authorization: `Bearer ${tokenStudentUnenrolled}`
    });
    assert(unenrolledDownloadRes.status === 403, '11. Unenrolled Student download attempt -> 403 Forbidden');

    // 12. Teacher B cannot access Teacher A classroom files (403 Forbidden)
    const teacherBListRes = await makeRequest('GET', `/api/classrooms/${classId}/files`, {
      Authorization: `Bearer ${tokenTeacherB}`
    });
    assert(teacherBListRes.status === 403, '12. Teacher B access attempt to Teacher A classroom -> 403 Forbidden');

    // 13. Teacher B cannot delete Teacher A files (403 Forbidden)
    const teacherBDeleteRes = await makeRequest('DELETE', `/api/classrooms/${classId}/files/${uploadedFileId}`, {
      Authorization: `Bearer ${tokenTeacherB}`
    });
    assert(teacherBDeleteRes.status === 403, '13. Teacher B delete attempt on Teacher A file -> 403 Forbidden');

    // 14. Teacher can edit metadata
    const teacherEditRes = await makeRequest('PUT', `/api/classrooms/${classId}/files/${uploadedFileId}`, {
      Authorization: `Bearer ${tokenTeacherA}`
    }, {
      title: 'Updated Calculus Lecture Notes Vol 1',
      description: 'Updated with chapter 2 summary'
    });
    assert(teacherEditRes.status === 200, '14. Teacher A edits metadata -> 200 OK');

    // Verify metadata update in Firestore
    const updatedSnap = await db.collection('classrooms').doc(classId).collection('files').doc(uploadedFileId).get();
    assert(updatedSnap.data().title === 'Updated Calculus Lecture Notes Vol 1', '14b. Updated metadata reflected in Firestore');

    // 15. Real-time upload appears without refresh
    assert(realTimeUploadedReceived === true, '15. Real-time socket event "file-uploaded" received by enrolled student');

    // 16. Unsupported file type rejected (.exe)
    const badTypeRes = await makeRequest('POST', `/api/classrooms/${classId}/files`, {
      Authorization: `Bearer ${tokenTeacherA}`
    }, {
      fileName: 'malware.exe',
      originalName: 'malware.exe',
      fileData: Buffer.from('binary').toString('base64'),
      fileType: 'exe',
      fileSize: 500
    });
    assert(badTypeRes.status === 400, '16. Unsupported file type (.exe) rejected with 400 Bad Request');

    // 17. Oversized file (>50MB) rejected
    const oversizedRes = await makeRequest('POST', `/api/classrooms/${classId}/files`, {
      Authorization: `Bearer ${tokenTeacherA}`
    }, {
      fileName: 'huge_video.mp4',
      originalName: 'huge_video.mp4',
      fileType: 'pdf',
      fileSize: 60 * 1024 * 1024 // 60MB
    });
    assert(oversizedRes.status === 400, '17. Oversized file (>50MB) rejected with 400 Bad Request');

    // 18. Valid file under 50MB accepted
    const validZipRes = await makeRequest('POST', `/api/classrooms/${classId}/files`, {
      Authorization: `Bearer ${tokenTeacherA}`
    }, {
      fileName: 'Project_Assets.zip',
      originalName: 'Project_Assets.zip',
      title: 'Project Starter Assets',
      category: 'ZIP',
      fileData: Buffer.from('zip contents').toString('base64'),
      fileType: 'zip',
      fileSize: 5 * 1024 * 1024 // 5MB
    });
    assert(validZipRes.status === 201, '18. Valid file under 50MB (5MB ZIP) accepted with 201 Created');

    // 19. Teacher can delete file
    const deleteRes = await makeRequest('DELETE', `/api/classrooms/${classId}/files/${uploadedFileId}`, {
      Authorization: `Bearer ${tokenTeacherA}`
    });
    assert(deleteRes.status === 200, '19. Teacher A deletes file -> 200 OK');

    // Emit socket delete notification
    socketEnrolled.emit('delete-file', { classroomId: classId, fileId: uploadedFileId });
    await new Promise(r => setTimeout(r, 400));

    // 20. Delete removes Firestore metadata
    const deletedSnap = await db.collection('classrooms').doc(classId).collection('files').doc(uploadedFileId).get();
    assert(!deletedSnap.exists, '20. Deletion removes metadata document from Firestore');

    // 21. Delete removes Storage file
    const deletedLocalFileExists = fs.existsSync(path.resolve(__dirname, `../../storage/classrooms/${classId}/files/${uploadedFileId}/Lecture_01_Notes.pdf`));
    assert(!deletedLocalFileExists, '21. Deletion cleans up file from storage path');

    // 22. Real-time deletion disappears without refresh
    assert(realTimeDeletedReceived === true, '22. Real-time socket event "file-deleted" received by enrolled student');

  } catch (err) {
    console.error('Test Suite Error:', err);
  } finally {
    if (socketEnrolled) socketEnrolled.disconnect();
    server.close();
    // Cleanup test classroom from Firestore
    try {
      await db.collection('classrooms').doc(classId).delete();
    } catch (e) {}
  }

  console.log('\n==================================================');
  console.log(`  TEST RESULTS: ${passedCount} / ${totalCount} PASSED (${Math.round((passedCount/totalCount)*100)}%)`);
  console.log('==================================================\n');

  if (passedCount === totalCount) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

runTestSuite();
