import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { verifyAuthToken } from '../middleware/auth.js';
import { emitTeacherEvent } from '../utils/classroomEvents.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router({ mergeParams: true });

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const ALLOWED_EXTENSIONS = new Set([
  'pdf', 'ppt', 'pptx', 'doc', 'docx', 'xls', 'xlsx', 'txt',
  'jpg', 'jpeg', 'png', 'webp', 'zip'
]);

function sanitizeFileName(name, fallback = 'file') {
  let n = String(name || '').trim();
  n = n.replace(/\\/g, '/');
  n = n.split('/').pop();
  n = n.replace(/[\u0000-\u001f\u007f"]/g, '');
  n = n.replace(/^\.+/, '');
  if (!n || n === '.' || n === '..') return fallback;
  return n;
}

function normalizeDueDate(dueDate) {
  if (!dueDate) return null;
  if (typeof dueDate.toDate === 'function' && typeof dueDate.toMillis === 'function') return dueDate;
  const d = dueDate instanceof Date ? dueDate : new Date(dueDate);
  return isNaN(d.getTime()) ? null : Timestamp.fromDate(d);
}

// POST /api/classrooms/:classId/assignments/upload - Express Backend Attachment & Submission File Upload
router.post('/upload', verifyAuthToken, async (req, res) => {
  try {
    const classId = req.params.classId || req.params.id;
    const { fileName, originalName, fileData, mimeType, fileSize } = req.body;
    const user = req.user;

    if (!fileData || typeof fileData !== 'string') {
      return res.status(400).json({ error: 'File content (base64) is required.' });
    }

    const cleanOriginalName = sanitizeFileName(originalName || fileName || 'file');
    const ext = cleanOriginalName.split('.').pop().toLowerCase();

    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return res.status(400).json({
        error: `Unsupported file type: .${ext}. Allowed types are PDF, PPT, PPTX, DOC, DOCX, XLS, XLSX, TXT, JPG, JPEG, PNG, WEBP, ZIP.`
      });
    }

    let buffer = null;
    let size = Number(fileSize || 0);
    try {
      buffer = Buffer.from(fileData.replace(/^data:.*?;base64,/, ''), 'base64');
      size = buffer.length;
    } catch (err) {
      return res.status(400).json({ error: 'File content is corrupted or not valid Base64.' });
    }

    if (size > MAX_FILE_SIZE) {
      return res.status(400).json({
        error: `File size exceeds 50MB limit (Uploaded size: ${(size / (1024 * 1024)).toFixed(1)}MB).`
      });
    }

    const fileId = `file_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const storedName = `${fileId}_${cleanOriginalName}`;
    const localDir = path.resolve(__dirname, `../../storage/classrooms/${classId}/assignments/${fileId}`);
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(path.join(localDir, cleanOriginalName), buffer);

    const downloadUrl = `/api/classrooms/${classId}/assignments/files/${fileId}/download`;

    const metadata = {
      fileId,
      originalName: cleanOriginalName,
      storedName,
      mimeType: mimeType || 'application/octet-stream',
      size,
      url: downloadUrl,
      uploadedAt: new Date().toISOString(),
      uploadedBy: user.uid,
    };

    return res.status(201).json(metadata);
  } catch (error) {
    console.error('Error uploading assignment file to backend:', error);
    return res.status(500).json({ error: 'Failed to upload file to backend storage', details: error.message });
  }
});

// GET /api/classrooms/:classId/assignments/files/:fileId/download - Download file from Express backend storage
router.get('/files/:fileId/download', verifyAuthToken, async (req, res) => {
  try {
    const classId = req.params.classId || req.params.id;
    const { fileId } = req.params;

    const fileDir = path.resolve(__dirname, `../../storage/classrooms/${classId}/assignments/${fileId}`);
    if (!fs.existsSync(fileDir)) {
      return res.status(404).json({ error: 'File directory not found on server.' });
    }

    const files = fs.readdirSync(fileDir);
    if (!files || files.length === 0) {
      return res.status(404).json({ error: 'File payload unavailable in backend storage.' });
    }

    const fileName = files[0];
    const filePath = path.join(fileDir, fileName);
    const safeName = sanitizeFileName(fileName, 'downloaded_file');

    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    console.error('Error serving file download:', error);
    return res.status(500).json({ error: 'Failed to download file', details: error.message });
  }
});

// // POST /api/classrooms/:classId/assignments - Create assignment
router.post('/', verifyAuthToken, async (req, res) => {
  try {
    const { classId } = req.params;
    const { title, description, dueDate, maxMarks, files, status } = req.body;
    const user = req.user;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Assignment title is required.' });
    }

    const db = getFirestore();
    const now = FieldValue.serverTimestamp();

    const assignmentData = {
      title: title.trim(),
      description: description || '',
      dueDate: normalizeDueDate(dueDate),
      maxMarks: Number(maxMarks) || 0,
      files: files || [],
      status: status || 'published',
      allowLateSubmissions: req.body.allowLateSubmissions !== false,
      createdBy: user.uid,
      createdByName: user.name || user.displayName || user.email || 'Teacher',
      createdAt: now,
      updatedAt: now,
      publishedAt: status === 'published' ? now : null,
    };

    const docRef = await db.collection('classrooms')
      .doc(classId)
      .collection('assignments')
      .add(assignmentData);

    // Add activity log
    await db.collection('classrooms').doc(classId).collection('activity').add({
      type: 'assignment_created',
      description: `New assignment created: ${title.trim()}`,
      userId: user.uid,
      userName: user.name || user.displayName || user.email || 'Teacher',
      timestamp: now,
    });

    // Dual-layer event: course stream card + per-student notifications
    let classroomData = null;
    try {
      const cDoc = await db.collection('classrooms').doc(classId).get();
      if (cDoc.exists) classroomData = cDoc.data();
    } catch (e) {}
    const className = classroomData ? (classroomData.classroomName || 'Classroom') : 'Classroom';
    const teacherName = user.name || user.displayName || user.email || 'Teacher';
    try {
      await emitTeacherEvent(classId, classroomData || { classroomName: className }, {
        type: 'assignment',
        title: `New Assignment: ${title.trim()}`,
        message: `${teacherName} posted a new assignment "${title.trim()}" in ${className}`,
        teacherName,
        teacherId: user.uid,
        itemId: docRef.id,
        itemType: 'assignment',
        link: `/classroom/${classId}`,
        metadata: { dueDate: assignmentData.dueDate || null, maxMarks: assignmentData.maxMarks },
      });
    } catch (err) {
      console.warn('[Assignments Route] Stream/notification emit failed (non-blocking):', err.message || err);
    }

    return res.status(201).json({ id: docRef.id, ...assignmentData });
  } catch (error) {
    console.error('Error creating assignment:', error);
    return res.status(500).json({ error: 'Failed to create assignment', details: error.message });
  }
});

import { safeServerQuery, isQuotaExceededError } from '../utils/quotaGuard.js';

// GET /api/classrooms/:classId/assignments - Get assignments
router.get('/', verifyAuthToken, async (req, res) => {
  const { classId } = req.params;
  const cacheKey = `server_assignments_${classId}`;

  try {
    const assignments = await safeServerQuery(cacheKey, async () => {
      const db = getFirestore();

      const snapshot = await db.collection('classrooms')
        .doc(classId)
        .collection('assignments')
        .orderBy('createdAt', 'desc')
        .get();

      return snapshot.docs.map(doc => {
        const data = doc.data();
        if (data.dueDate && typeof data.dueDate.toMillis === 'function') {
          data.dueDate = new Date(data.dueDate.toMillis()).toISOString();
        }
        return { id: doc.id, ...data };
      });
    }, [], 30000);

    return res.json(assignments);
  } catch (error) {
    if (isQuotaExceededError(error)) {
      console.warn('[Assignments Route] Firestore RESOURCE_EXHAUSTED. Returning empty assignments list.');
      return res.json([]);
    }
    console.error('Error fetching assignments:', error);
    return res.status(500).json({ error: 'Failed to fetch assignments', details: error.message });
  }
});

// POST /api/classrooms/:classId/assignments/:id/submit - Submit assignment
router.post('/:id/submit', verifyAuthToken, async (req, res) => {
  try {
    const { classId, id: assignmentId } = req.params;
    const { files } = req.body;
    const user = req.user;

    const db = getFirestore();
    const assignmentRef = db.collection('classrooms').doc(classId).collection('assignments').doc(assignmentId);
    const assignmentSnap = await assignmentRef.get();

    if (!assignmentSnap.exists) {
      return res.status(404).json({ error: 'Assignment not found.' });
    }

    const assignment = assignmentSnap.data();
    if (assignment.status === 'closed') {
      return res.status(400).json({ error: 'This assignment is closed for submissions.' });
    }

    const dueMillis = assignment.dueDate
      ? (typeof assignment.dueDate.toMillis === 'function' ? assignment.dueDate.toMillis() : new Date(assignment.dueDate).getTime())
      : null;
    const isLate = dueMillis ? Date.now() > dueMillis : false;

    if (isLate && assignment.allowLateSubmissions === false) {
      return res.status(403).json({ error: 'Late submissions are not allowed for this assignment.' });
    }

    const subRef = assignmentRef.collection('submissions').doc(user.uid);
    const existingSnap = await subRef.get();

    const submission = {
      studentId: user.uid,
      studentName: user.name || user.displayName || user.email || 'Student',
      files: files || [],
      submittedAt: FieldValue.serverTimestamp(),
      late: isLate,
      status: isLate ? 'late' : 'submitted',
    };

    if (!existingSnap.exists) {
      submission.marks = null;
      submission.feedback = '';
      submission.gradedAt = null;
      submission.history = [];
    } else {
      const existing = existingSnap.data();
      submission.marks = existing.marks || null;
      submission.feedback = existing.feedback || '';
      submission.gradedAt = existing.gradedAt || null;
      submission.history = [...(existing.history || []), {
        files: existing.files || [],
        submittedAt: existing.submittedAt || null,
        status: existing.status || 'submitted',
      }];
    }

    await subRef.set(submission);

    // Add activity log
    await db.collection('classrooms').doc(classId).collection('activity').add({
      type: 'assignment_submitted',
      description: `${user.name || user.email || 'Student'} submitted assignment "${assignment.title}"`,
      userId: user.uid,
      userName: user.name || user.displayName || user.email || 'Student',
      timestamp: FieldValue.serverTimestamp(),
    });

    // Trigger 2: notify the classroom teacher that a student submitted work
    try {
      const classSnap = await db.collection('classrooms').doc(classId).get();
      if (classSnap.exists) {
        const classroom = classSnap.data();
        const teacherUid = classroom.createdBy || classroom.teacherId || classroom.teacherUid || classroom.ownerId;
        const teacherName = user.name || user.displayName || user.email || 'Student';
        if (teacherUid) {
          await db.collection('users').doc(teacherUid).collection('notifications').add({
            id: '',
            classId,
            className: classroom.classroomName || 'Classroom',
            teacherName: classroom.teacherName || 'Teacher',
            type: 'assignment_submitted',
            title: 'New Submission',
            message: `${teacherName} turned in "${assignment.title}"${isLate ? ' (late)' : ''}`,
            timestamp: FieldValue.serverTimestamp(),
            read: false,
            link: `/classroom/${classId}`,
            itemId: assignmentId,
            itemType: 'assignment',
            createdAt: FieldValue.serverTimestamp(),
          });
        }
      }
    } catch (err) {
      console.warn('[Assignments Route] Teacher submission notification failed (non-blocking):', err.message || err);
    }

    return res.json({ message: 'Assignment submitted successfully', late: isLate });
  } catch (error) {
    console.error('Error submitting assignment:', error);
    return res.status(500).json({ error: 'Failed to submit assignment', details: error.message });
  }
});

// POST /api/classrooms/:classId/assignments/:id/unsubmit - Unsubmit assignment
router.post('/:id/unsubmit', verifyAuthToken, async (req, res) => {
  try {
    const { classId, id: assignmentId } = req.params;
    const user = req.user;

    const db = getFirestore();
    const subRef = db.collection('classrooms').doc(classId).collection('assignments').doc(assignmentId).collection('submissions').doc(user.uid);
    const subSnap = await subRef.get();

    if (!subSnap.exists) {
      return res.status(404).json({ error: 'Submission not found.' });
    }

    const submission = subSnap.data();
    if (submission.status === 'graded') {
      return res.status(400).json({ error: 'Graded work cannot be unsubmitted. Please contact your teacher.' });
    }

    await subRef.update({
      files: [],
      submittedAt: null,
      status: 'assigned',
      updatedAt: FieldValue.serverTimestamp(),
    });

    return res.json({ message: 'Work unsubmitted successfully.' });
  } catch (error) {
    console.error('Error unsubmitting assignment:', error);
    return res.status(500).json({ error: 'Failed to unsubmit assignment', details: error.message });
  }
});

// POST /api/classrooms/:classId/assignments/:id/submissions/:studentId/grade - Grade submission
router.post('/:id/submissions/:studentId/grade', verifyAuthToken, async (req, res) => {
  try {
    const { classId, id: assignmentId, studentId } = req.params;
    const { marks, feedback } = req.body;
    const user = req.user;

    const db = getFirestore();
    const assignmentRef = db.collection('classrooms').doc(classId).collection('assignments').doc(assignmentId);
    const assignmentSnap = await assignmentRef.get();

    if (!assignmentSnap.exists) {
      return res.status(404).json({ error: 'Assignment not found.' });
    }

    const assignment = assignmentSnap.data();
    const subRef = assignmentRef.collection('submissions').doc(studentId);
    const subSnap = await subRef.get();

    if (!subSnap.exists) {
      return res.status(404).json({ error: 'Submission not found.' });
    }

    const gradeMarks = Number(marks) || 0;
    const gradeFeedback = feedback || '';
    await subRef.update({
      marks: gradeMarks,
      feedback: gradeFeedback,
      gradedAt: FieldValue.serverTimestamp(),
      gradedBy: user.uid,
      status: 'graded',
    });

    // Trigger 3: notify the student with score + feedback
    try {
      const classSnap = await db.collection('classrooms').doc(classId).get();
      const className = classSnap.exists ? (classSnap.data().classroomName || 'Classroom') : 'Classroom';
      const notifDoc = db.collection('users').doc(studentId).collection('notifications').doc();
      await notifDoc.set({
        id: notifDoc.id,
        classId,
        className,
        teacherName: user.name || user.displayName || user.email || 'Teacher',
        type: 'work_graded',
        title: 'Work Graded',
        message: `Your work for "${assignment.title}" was graded: ${gradeMarks}/${assignment.maxMarks || 100}${gradeFeedback ? ` — ${gradeFeedback}` : ''}`,
        timestamp: FieldValue.serverTimestamp(),
        read: false,
        link: `/classroom/${classId}`,
        itemId: assignmentId,
        itemType: 'assignment',
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (err) {
      console.warn('[Assignments Route] Student grade notification failed (non-blocking):', err.message || err);
    }

    return res.json({ message: 'Submission graded successfully', marks: gradeMarks });
  } catch (error) {
    console.error('Error grading submission:', error);
    return res.status(500).json({ error: 'Failed to grade submission', details: error.message });
  }
});

// PUT /api/classrooms/:classId/assignments/:id - Edit assignment
router.put('/:id', verifyAuthToken, async (req, res) => {
  try {
    const { classId, id: assignmentId } = req.params;
    const { title, description, dueDate, maxMarks, files, status, allowLateSubmissions } = req.body;
    const user = req.user;

    const db = getFirestore();
    const assignmentRef = db.collection('classrooms').doc(classId).collection('assignments').doc(assignmentId);
    const snap = await assignmentRef.get();
    if (!snap.exists) {
      return res.status(404).json({ error: 'Assignment not found.' });
    }

    const existing = snap.data();
    const updates = {
      title: (title !== undefined ? String(title).trim() : existing.title) || existing.title,
      description: description !== undefined ? description : (existing.description || ''),
      dueDate: dueDate !== undefined ? normalizeDueDate(dueDate) : (existing.dueDate || null),
      maxMarks: maxMarks !== undefined ? (Number(maxMarks) || 0) : (existing.maxMarks || 0),
      allowLateSubmissions: allowLateSubmissions !== undefined ? allowLateSubmissions : existing.allowLateSubmissions,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (files && Array.isArray(files)) updates.files = files;
    if (status && status !== existing.status) {
      updates.status = status;
      if (status === 'published') updates.publishedAt = FieldValue.serverTimestamp();
      if (status === 'closed') updates.closedAt = FieldValue.serverTimestamp();
    }

    await assignmentRef.update(updates);

    // Add activity log
    await db.collection('classrooms').doc(classId).collection('activity').add({
      type: 'assignment_updated',
      description: `Assignment updated: ${updates.title}`,
      userId: user.uid,
      userName: user.name || user.displayName || user.email || 'Teacher',
      timestamp: FieldValue.serverTimestamp(),
    });

    return res.json({ id: assignmentId, message: 'Assignment updated successfully' });
  } catch (error) {
    console.error('Error updating assignment:', error);
    return res.status(500).json({ error: 'Failed to update assignment', details: error.message });
  }
});

// DELETE /api/classrooms/:classId/assignments/:id - Delete assignment
router.delete('/:id', verifyAuthToken, async (req, res) => {
  try {
    const { classId, id: assignmentId } = req.params;
    const user = req.user;

    const db = getFirestore();
    const assignmentRef = db.collection('classrooms').doc(classId).collection('assignments').doc(assignmentId);
    const snap = await assignmentRef.get();
    if (!snap.exists) {
      return res.status(404).json({ error: 'Assignment not found.' });
    }

    const title = snap.data().title || 'Assignment';

    // Remove any student submissions before deleting the parent document.
    try {
      const subs = await assignmentRef.collection('submissions').listDocuments();
      await Promise.all(subs.map(s => s.delete()));
    } catch (e) {
      console.warn('[Assignments Route] Could not remove submissions (non-blocking):', e.message || e);
    }

    await assignmentRef.delete();

    // Add activity log
    await db.collection('classrooms').doc(classId).collection('activity').add({
      type: 'assignment_deleted',
      description: `Assignment deleted: ${title}`,
      userId: user.uid,
      userName: user.name || user.displayName || user.email || 'Teacher',
      timestamp: FieldValue.serverTimestamp(),
    });

    return res.json({ message: 'Assignment deleted successfully' });
  } catch (error) {
    console.error('Error deleting assignment:', error);
    return res.status(500).json({ error: 'Failed to delete assignment', details: error.message });
  }
});

export default router;
