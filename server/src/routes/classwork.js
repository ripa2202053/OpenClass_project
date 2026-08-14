import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { verifyAuthToken } from '../middleware/auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router({ mergeParams: true });

const CLASSWORK_TYPES = new Set(['assignment', 'quiz', 'resource']);
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const ALLOWED_EXTENSIONS = new Set([
  'pdf', 'ppt', 'pptx', 'doc', 'docx', 'xls', 'xlsx', 'txt',
  'jpg', 'jpeg', 'png', 'webp', 'zip'
]);

// Same protections as the Files module: drops path segments, control chars,
// quotes, and leading dots so names can never escape a storage directory.
function sanitizeFileName(name, fallback = 'file') {
  let n = String(name || '').trim();
  n = n.replace(/\\/g, '/');
  n = n.split('/').pop();
  n = n.replace(/[\u0000-\u001f\u007f"]/g, '');
  n = n.replace(/^\.+/, '');
  if (!n || n === '.' || n === '..') return fallback;
  return n;
}

function mimeMatchesExtension(ext, mime) {
  const m = String(mime || '').trim().toLowerCase();
  if (!m || m === 'application/octet-stream') return true;
  if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) return m.startsWith('image/');
  if (['doc', 'docx', 'txt'].includes(ext)) {
    return m.startsWith('text/') || m.includes('word') || m.includes('msword')
      || m.includes('rtf') || m.includes('opendocument');
  }
  if (['ppt', 'pptx'].includes(ext)) {
    return m.includes('powerpoint') || m.includes('ms-powerpoint')
      || m.includes('presentation') || m.includes('opendocument');
  }
  if (['xls', 'xlsx'].includes(ext)) {
    return m.includes('excel') || m.includes('spreadsheet') || m.includes('csv');
  }
  if (ext === 'pdf') return m.includes('pdf');
  if (ext === 'zip') return m.includes('zip') || m.includes('compressed');
  return true;
}

async function checkClassroomAccess(db, classroomId, uid) {
  const classDoc = await db.collection('classrooms').doc(classroomId).get();
  if (!classDoc.exists) return { classroomData: null, isOwner: false, isMember: false };
  const data = classDoc.data();
  const isOwner =
    data.createdBy === uid ||
    data.teacherId === uid ||
    data.teacherUid === uid ||
    data.ownerId === uid;

  let isMember = isOwner;
  if (!isMember) {
    if (Array.isArray(data.enrolledStudents) && data.enrolledStudents.includes(uid)) {
      isMember = true;
    } else {
      const memberDoc = await db
        .collection('classrooms')
        .doc(classroomId)
        .collection('members')
        .doc(uid)
        .get();
      if (memberDoc.exists) isMember = true;
    }
  }

  return { classroomData: data, isOwner, isMember };
}

function normalizeDueDate(dueDate) {
  if (!dueDate) return null;
  if (typeof dueDate.toDate === 'function' && typeof dueDate.toMillis === 'function') return dueDate;
  const d = dueDate instanceof Date ? dueDate : new Date(dueDate);
  return isNaN(d.getTime()) ? null : new Date(d.getTime()).toISOString();
}

function cleanText(value, max = 8000) {
  return String(value || '').trim().slice(0, max);
}

function sanitizeQuestions(questions) {
  if (!Array.isArray(questions)) return [];
  const out = [];
  questions.forEach((q, idx) => {
    if (!q) return;
    const text = cleanText(q.question || q.text, 500);
    const marks = Math.max(0, Math.floor(Number(q.marks) || 1));
    let options = Array.isArray(q.options)
      ? q.options.map(o => cleanText(o, 300)).filter(Boolean)
      : [];
    options = options.slice(0, 4);
    if (!text || options.length < 2) return;
    let correctIndex = Number(q.correctIndex);
    if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length) correctIndex = 0;
    out.push({ id: idx + 1, question: text, options, correctIndex, marks });
  });
  return out;
}

function sanitizeAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments
    .map(a => ({
      fileId: cleanText(a.fileId, 200),
      fileName: sanitizeFileName(a.fileName || a.originalName || 'file'),
      originalName: sanitizeFileName(a.originalName || a.fileName || 'file'),
      mimeType: cleanText(a.mimeType, 200) || 'application/octet-stream',
      fileType: cleanText(a.fileType, 50),
      fileSize: Math.max(0, Number(a.fileSize) || 0),
      downloadURL: cleanText(a.downloadURL, 500),
    }))
    .filter(a => a.fileId);
}

// Strip quiz answers + only keep published items for student-facing responses.
function serializeForStudent(work) {
  const copy = { ...work };
  if (copy.type === 'quiz' && Array.isArray(copy.questions)) {
    copy.questions = copy.questions.map(({ correctIndex, correctAnswer, correctAnswerText, ...rest }) => rest);
    copy.totalMarks = copy.questions.reduce((sum, q) => sum + (Number(q.marks) || 1), 0);
  }
  delete copy.correctAnswers;
  return copy;
}

function toSerializable(doc) {
  const data = doc.data();
  const out = { id: doc.id, ...data };
  if (out.dueDate && typeof out.dueDate.toMillis === 'function') {
    out.dueDate = new Date(out.dueDate.toMillis()).toISOString();
  }
  if (out.createdAt && typeof out.createdAt.toMillis === 'function') {
    out.createdAt = new Date(out.createdAt.toMillis()).toISOString();
  }
  if (out.updatedAt && typeof out.updatedAt.toMillis === 'function') {
    out.updatedAt = new Date(out.updatedAt.toMillis()).toISOString();
  }
  return out;
}

import { safeServerQuery, isQuotaExceededError } from '../utils/quotaGuard.js';

// GET /api/classrooms/:classId/classwork - List class work (role aware)
router.get('/', verifyAuthToken, async (req, res) => {
  const classId = req.params.classId || req.params.id;
  const user = req.user;
  const cacheKey = `server_classwork_${classId}_${user.uid}`;

  try {
    const items = await safeServerQuery(cacheKey, async () => {
      const db = getFirestore();

      const access = await checkClassroomAccess(db, classId, user.uid);
      if (!access.classroomData || (!access.isOwner && !access.isMember)) {
        return null;
      }

      let query = db.collection('classrooms').doc(classId).collection('classwork').orderBy('createdAt', 'desc');
      const snap = await query.get();

      let classworkItems = snap.docs.map(toSerializable);

      if (!access.isOwner) {
        // Students see published items only
        classworkItems = classworkItems.filter(w => w.published === true || w.status === 'published');
        classworkItems = classworkItems.map(serializeForStudent);
        try {
          classworkItems = await attachStudentState(db, classId, user.uid, classworkItems);
        } catch (e) {
          if (isQuotaExceededError(e)) {
            console.warn('[Classwork Route] Quota exceeded attaching student state.');
          }
        }
      }

      return classworkItems;
    }, [], 30000);

    if (items === null) {
      return res.status(403).json({ error: 'Permission denied: You are not a member of this classroom.' });
    }

    return res.json(items);
  } catch (error) {
    if (isQuotaExceededError(error)) {
      console.warn('[Classwork Route] Firestore RESOURCE_EXHAUSTED. Returning cached/empty items list.');
      return res.json([]);
    }
    console.error('Error fetching class work:', error);
    return res.status(500).json({ error: 'Failed to fetch class work', details: error.message });
  }
});

// POST /api/classrooms/:classId/classwork - Teacher creates class work
router.post('/', verifyAuthToken, async (req, res) => {
  try {
    const classId = req.params.classId || req.params.id;
    const {
      type, title, description, instructions, dueDate, points, published,
      attachments, questions, allowResubmission,
    } = req.body;
    const user = req.user;
    const db = getFirestore();

    const access = await checkClassroomAccess(db, classId, user.uid);
    if (!access.classroomData || !access.isOwner) {
      return res.status(403).json({ error: 'Permission denied: Only the classroom teacher can create class work.' });
    }

    const workType = String(type || '').toLowerCase();
    if (!CLASSWORK_TYPES.has(workType)) {
      return res.status(400).json({ error: 'Invalid class work type. Must be assignment, quiz, or resource.' });
    }
    const cleanTitle = cleanText(title, 200);
    if (!cleanTitle) {
      return res.status(400).json({ error: 'Title is required.' });
    }

    const isPublished = published === true || published === 'true';
    const now = FieldValue.serverTimestamp();

    const workData = {
      classroomId: classId,
      teacherId: user.uid,
      teacherName: user.name || user.displayName || user.email || 'Teacher',
      type: workType,
      title: cleanTitle,
      description: cleanText(description, 2000),
      instructions: cleanText(instructions, 4000),
      dueDate: normalizeDueDate(dueDate),
      points: Math.max(0, Math.floor(Number(points) || 0)),
      attachments: sanitizeAttachments(attachments),
      published: isPublished,
      status: isPublished ? 'published' : 'draft',
      allowResubmission: allowResubmission === true,
      createdAt: now,
      updatedAt: now,
      publishedAt: isPublished ? now : null,
    };

    if (workType === 'quiz') {
      const qs = sanitizeQuestions(questions);
      if (qs.length === 0) {
        return res.status(400).json({ error: 'A quiz must have at least one complete question with 2-4 options.' });
      }
      workData.questions = qs;
      workData.totalMarks = qs.reduce((sum, q) => sum + q.marks, 0);
      workData.questionCount = qs.length;
    }

    const docRef = await db.collection('classrooms').doc(classId).collection('classwork').add(workData);

    await db.collection('classrooms').doc(classId).collection('activity').add({
      type: 'classwork_created',
      description: `New ${workType} created: ${cleanTitle}`,
      userId: user.uid,
      userName: workData.teacherName,
      timestamp: now,
    });

    return res.status(201).json({ id: docRef.id, ...workData });
  } catch (error) {
    console.error('Error creating class work:', error);
    return res.status(500).json({ error: 'Failed to create class work', details: error.message });
  }
});

// GET /api/classrooms/:classId/classwork/:workId - Class work detail (role aware)
router.get('/:workId', verifyAuthToken, async (req, res) => {
  try {
    const classId = req.params.classId || req.params.id;
    const { workId } = req.params;
    const user = req.user;
    const db = getFirestore();

    const access = await checkClassroomAccess(db, classId, user.uid);
    if (!access.classroomData || (!access.isOwner && !access.isMember)) {
      return res.status(403).json({ error: 'Permission denied: You are not a member of this classroom.' });
    }

    const docRef = db.collection('classrooms').doc(classId).collection('classwork').doc(workId);
    const snap = await docRef.get();
    if (!snap.exists) {
      return res.status(404).json({ error: 'Class work not found.' });
    }

    let work = toSerializable(snap);
    if (!access.isOwner) {
      if (work.published !== true && work.status !== 'published') {
        return res.status(403).json({ error: 'This class work has not been published yet.' });
      }
      work = serializeForStudent(work);
      work.mySubmission = await getStudentState(db, docRef, work, user.uid);
    }

    return res.json(work);
  } catch (error) {
    console.error('Error fetching class work:', error);
    return res.status(500).json({ error: 'Failed to fetch class work', details: error.message });
  }
});

// PUT /api/classrooms/:classId/classwork/:workId - Teacher edits class work
router.put('/:workId', verifyAuthToken, async (req, res) => {
  try {
    const classId = req.params.classId || req.params.id;
    const { workId } = req.params;
    const {
      title, description, instructions, dueDate, points, published,
      attachments, questions, allowResubmission,
    } = req.body;
    const user = req.user;
    const db = getFirestore();

    const access = await checkClassroomAccess(db, classId, user.uid);
    if (!access.classroomData || !access.isOwner) {
      return res.status(403).json({ error: 'Permission denied: Only the classroom teacher can edit class work.' });
    }

    const docRef = db.collection('classrooms').doc(classId).collection('classwork').doc(workId);
    const snap = await docRef.get();
    if (!snap.exists) {
      return res.status(404).json({ error: 'Class work not found.' });
    }

    const existing = snap.data();
    const isPublished = published === true || published === 'true';
    const update = {
      title: cleanText(title !== undefined ? title : existing.title, 200),
      description: cleanText(description !== undefined ? description : existing.description, 2000),
      instructions: cleanText(instructions !== undefined ? instructions : existing.instructions, 4000),
      dueDate: normalizeDueDate(dueDate !== undefined ? dueDate : existing.dueDate),
      points: Math.max(0, Math.floor(Number(points !== undefined ? points : existing.points) || 0)),
      attachments: sanitizeAttachments(attachments !== undefined ? attachments : existing.attachments),
      published: isPublished,
      status: isPublished ? 'published' : 'draft',
      allowResubmission: allowResubmission === true,
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (update.status === 'published' && existing.status !== 'published') {
      update.publishedAt = FieldValue.serverTimestamp();
    }

    if (existing.type === 'quiz') {
      const qs = questions !== undefined ? sanitizeQuestions(questions) : existing.questions;
      if (Array.isArray(qs) && qs.length === 0) {
        return res.status(400).json({ error: 'A quiz must have at least one complete question with 2-4 options.' });
      }
      update.questions = Array.isArray(qs) ? qs : (existing.questions || []);
      update.totalMarks = update.questions.reduce((sum, q) => sum + (Number(q.marks) || 1), 0);
      update.questionCount = update.questions.length;
    }

    await docRef.update(update);

    const updated = await docRef.get();
    return res.json(toSerializable(updated));
  } catch (error) {
    console.error('Error updating class work:', error);
    return res.status(500).json({ error: 'Failed to update class work', details: error.message });
  }
});

// DELETE /api/classrooms/:classId/classwork/:workId - Teacher deletes class work
router.delete('/:workId', verifyAuthToken, async (req, res) => {
  try {
    const classId = req.params.classId || req.params.id;
    const { workId } = req.params;
    const user = req.user;
    const db = getFirestore();

    const access = await checkClassroomAccess(db, classId, user.uid);
    if (!access.classroomData || !access.isOwner) {
      return res.status(403).json({ error: 'Permission denied: Only the classroom teacher can delete class work.' });
    }

    const docRef = db.collection('classrooms').doc(classId).collection('classwork').doc(workId);
    const snap = await docRef.get();
    if (!snap.exists) {
      return res.status(404).json({ error: 'Class work not found.' });
    }

    await docRef.delete();

    await db.collection('classrooms').doc(classId).collection('activity').add({
      type: 'classwork_deleted',
      description: `Class work removed: ${snap.data().title || workId}`,
      userId: user.uid,
      userName: user.name || user.displayName || user.email || 'Teacher',
      timestamp: FieldValue.serverTimestamp(),
    });

    return res.json({ message: 'Class work deleted successfully', workId });
  } catch (error) {
    console.error('Error deleting class work:', error);
    return res.status(500).json({ error: 'Failed to delete class work', details: error.message });
  }
});

// ─── Submissions (assignments) ───────────────────────────────────────────

function getWorkRef(db, classId, workId) {
  return db.collection('classrooms').doc(classId).collection('classwork').doc(workId);
}

async function getStudentState(db, docRef, work, studentUid) {
  if (work.type === 'quiz') {
    const att = await docRef.collection('attempts').doc(studentUid).get();
    if (!att.exists) return null;
    const a = att.data();
    return {
      submitted: true,
      type: 'quiz',
      score: a.score,
      totalMarks: a.totalMarks,
      percentage: a.percentage,
      submittedAt: a.submittedAt && typeof a.submittedAt.toMillis === 'function'
        ? new Date(a.submittedAt.toMillis()).toISOString() : null,
    };
  }
  if (work.type === 'assignment') {
    const sub = await docRef.collection('submissions').doc(studentUid).get();
    if (!sub.exists) return null;
    const s = sub.data();
    return {
      submitted: true,
      type: 'assignment',
      status: s.status || 'submitted',
      late: !!s.late,
      submittedAt: s.submittedAt && typeof s.submittedAt.toMillis === 'function'
        ? new Date(s.submittedAt.toMillis()).toISOString() : null,
      marks: s.marks ?? null,
      feedback: s.feedback || '',
      attachment: s.attachment || null,
      textAnswer: s.textAnswer || '',
    };
  }
  return null;
}

async function attachStudentState(db, classId, studentUid, items) {
  const dbNow = getFirestore();
  return Promise.all(items.map(async (work) => {
    const docRef = dbNow.collection('classrooms').doc(classId).collection('classwork').doc(work.id);
    work.mySubmission = await getStudentState(db, docRef, work, studentUid);
    return work;
  }));
}

// POST /api/classrooms/:classId/classwork/:workId/submissions - Student submits assignment
router.post('/:workId/submissions', verifyAuthToken, async (req, res) => {
  try {
    const classId = req.params.classId || req.params.id;
    const { workId } = req.params;
    const { textAnswer, fileName, fileData, mimeType, fileSize } = req.body;
    const user = req.user;
    const db = getFirestore();

    const access = await checkClassroomAccess(db, classId, user.uid);
    if (!access.classroomData || (!access.isOwner && !access.isMember)) {
      return res.status(403).json({ error: 'Permission denied: You are not a member of this classroom.' });
    }
    if (access.isOwner) {
      return res.status(403).json({ error: 'The teacher cannot submit an assignment to their own classroom.' });
    }

    const docRef = getWorkRef(db, classId, workId);
    const snap = await docRef.get();
    if (!snap.exists) {
      return res.status(404).json({ error: 'Class work not found.' });
    }
    const work = snap.data();
    if (work.type !== 'assignment') {
      return res.status(400).json({ error: 'This class work is not an assignment.' });
    }
    if (work.published !== true && work.status !== 'published') {
      return res.status(403).json({ error: 'This assignment has not been published yet.' });
    }
    if (work.status === 'closed') {
      return res.status(400).json({ error: 'This assignment is closed for submissions.' });
    }

    const cleanTextAnswer = cleanText(textAnswer, 20000);
    if (!cleanTextAnswer && !fileData) {
      return res.status(400).json({ error: 'Please provide a text answer or attach a file.' });
    }

    const subRef = docRef.collection('submissions').doc(user.uid);
    const existingSnap = await subRef.get();
    if (existingSnap.exists && work.allowResubmission !== true) {
      return res.status(400).json({ error: 'You have already submitted this assignment. Resubmission is not allowed.' });
    }

    const dueMillis = work.dueDate
      ? (typeof work.dueDate.toMillis === 'function' ? work.dueDate.toMillis() : new Date(work.dueDate).getTime())
      : null;
    const isLate = dueMillis ? Date.now() > dueMillis : false;

    // Optional submission file - same protections as the Files module.
    let attachment = null;
    if (fileData) {
      const cleanName = sanitizeFileName(fileName || 'submission', 'submission');
      const ext = cleanName.split('.').pop().toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        return res.status(400).json({ error: `Unsupported file type: .${ext}. Allowed types are PDF, PPT, PPTX, DOC, DOCX, XLS, XLSX, TXT, JPG, JPEG, PNG, WEBP, ZIP.` });
      }
      if (!mimeMatchesExtension(ext, mimeType)) {
        return res.status(400).json({ error: `File MIME type (${mimeType || 'unknown'}) does not match the file extension (.${ext}).` });
      }
      let buffer = null;
      try {
        buffer = Buffer.from(String(fileData).replace(/^data:.*?;base64,/, ''), 'base64');
      } catch (e) {
        return res.status(400).json({ error: 'File content is corrupted or not valid Base64.' });
      }
      const size = buffer.length;
      if (size > MAX_FILE_SIZE) {
        return res.status(400).json({ error: `File size exceeds the 50MB limit (Uploaded size: ${(size / (1024 * 1024)).toFixed(1)}MB).` });
      }
      const subFileId = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const relDir = `classrooms/${classId}/classwork/${workId}/submissions/${user.uid}`;
      const localDir = path.resolve(__dirname, `../../storage/${relDir}`);
      fs.mkdirSync(localDir, { recursive: true });
      fs.writeFileSync(path.join(localDir, cleanName), buffer);
      attachment = {
        subFileId,
        fileName: cleanName,
        mimeType: mimeType || 'application/octet-stream',
        fileSize: size,
        fileType: ext,
      };
    }

    const submission = {
      studentId: user.uid,
      studentName: user.name || user.displayName || user.email || 'Student',
      workId,
      textAnswer: cleanTextAnswer,
      attachment,
      submittedAt: FieldValue.serverTimestamp(),
      late: isLate,
      status: isLate ? 'late' : 'submitted',
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (!existingSnap.exists) {
      submission.marks = null;
      submission.feedback = '';
      submission.gradedAt = null;
      submission.history = [];
    } else {
      const prev = existingSnap.data();
      submission.marks = prev.marks ?? null;
      submission.feedback = prev.feedback || '';
      submission.gradedAt = prev.gradedAt || null;
      submission.history = [...(prev.history || []), {
        textAnswer: prev.textAnswer || '',
        attachment: prev.attachment || null,
        submittedAt: prev.submittedAt || null,
        status: prev.status || 'submitted',
      }];
    }

    await subRef.set(submission);

    await db.collection('classrooms').doc(classId).collection('activity').add({
      type: 'assignment_submitted',
      description: `${submission.studentName} submitted "${work.title}"`,
      userId: user.uid,
      userName: submission.studentName,
      timestamp: FieldValue.serverTimestamp(),
    });

    return res.json({ message: 'Assignment submitted successfully', late: isLate, status: submission.status });
  } catch (error) {
    console.error('Error submitting assignment:', error);
    return res.status(500).json({ error: 'Failed to submit assignment', details: error.message });
  }
});

// GET /api/classrooms/:classId/classwork/:workId/submissions - Teacher views submissions
router.get('/:workId/submissions', verifyAuthToken, async (req, res) => {
  try {
    const classId = req.params.classId || req.params.id;
    const { workId } = req.params;
    const user = req.user;
    const db = getFirestore();

    const access = await checkClassroomAccess(db, classId, user.uid);
    if (!access.classroomData || !access.isOwner) {
      return res.status(403).json({ error: 'Permission denied: Only the classroom teacher can view submissions.' });
    }

    const snap = await getWorkRef(db, classId, workId).collection('submissions').orderBy('submittedAt', 'desc').get();
    const submissions = snap.docs.map(doc => {
      const d = doc.data();
      if (d.submittedAt && typeof d.submittedAt.toMillis === 'function') d.submittedAt = new Date(d.submittedAt.toMillis()).toISOString();
      if (d.updatedAt && typeof d.updatedAt.toMillis === 'function') d.updatedAt = new Date(d.updatedAt.toMillis()).toISOString();
      return { id: doc.id, ...d };
    });
    return res.json(submissions);
  } catch (error) {
    console.error('Error fetching submissions:', error);
    return res.status(500).json({ error: 'Failed to fetch submissions', details: error.message });
  }
});

// POST /api/classrooms/:classId/classwork/:workId/submissions/:studentId/grade - Teacher grades
router.post('/:workId/submissions/:studentId/grade', verifyAuthToken, async (req, res) => {
  try {
    const classId = req.params.classId || req.params.id;
    const { workId, studentId } = req.params;
    const { marks, feedback } = req.body;
    const user = req.user;
    const db = getFirestore();

    const access = await checkClassroomAccess(db, classId, user.uid);
    if (!access.classroomData || !access.isOwner) {
      return res.status(403).json({ error: 'Permission denied: Only the classroom teacher can grade submissions.' });
    }

    const subRef = getWorkRef(db, classId, workId).collection('submissions').doc(studentId);
    const snap = await subRef.get();
    if (!snap.exists) {
      return res.status(404).json({ error: 'Submission not found.' });
    }

    const update = {
      marks: marks === undefined || marks === null ? null : Math.max(0, Number(marks) || 0),
      feedback: cleanText(feedback, 2000),
      gradedAt: FieldValue.serverTimestamp(),
    };
    await subRef.update(update);

    const updated = await subRef.get();
    const d = updated.data();
    if (d.submittedAt && typeof d.submittedAt.toMillis === 'function') d.submittedAt = new Date(d.submittedAt.toMillis()).toISOString();
    return res.json({ id: updated.id, ...d });
  } catch (error) {
    console.error('Error grading submission:', error);
    return res.status(500).json({ error: 'Failed to grade submission', details: error.message });
  }
});

// GET /api/classrooms/:classId/classwork/:workId/submissions/:studentId/file - Attachment download
router.get('/:workId/submissions/:studentId/file', verifyAuthToken, async (req, res) => {
  try {
    const classId = req.params.classId || req.params.id;
    const { workId, studentId } = req.params;
    const user = req.user;
    const db = getFirestore();

    const access = await checkClassroomAccess(db, classId, user.uid);
    if (!access.classroomData || (!access.isOwner && !access.isMember)) {
      return res.status(403).json({ error: 'Permission denied.' });
    }
    if (!access.isOwner && user.uid !== studentId) {
      return res.status(403).json({ error: 'Permission denied: You can only access your own submission.' });
    }

    const subSnap = await getWorkRef(db, classId, workId).collection('submissions').doc(studentId).get();
    if (!subSnap.exists) {
      return res.status(404).json({ error: 'Submission not found.' });
    }
    const attachment = subSnap.data().attachment;
    if (!attachment) {
      return res.status(404).json({ error: 'This submission has no attachment.' });
    }

    const safeName = sanitizeFileName(attachment.fileName, 'submission');
    const localFilePath = path.resolve(__dirname, `../../storage/classrooms/${classId}/classwork/${workId}/submissions/${studentId}/${path.basename(safeName)}`);
    if (!fs.existsSync(localFilePath)) {
      return res.status(404).json({ error: 'File payload unavailable.' });
    }
    res.setHeader('Content-Type', attachment.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return fs.createReadStream(localFilePath).pipe(res);
  } catch (error) {
    console.error('Error downloading submission file:', error);
    return res.status(500).json({ error: 'Failed to download submission file', details: error.message });
  }
});

// ─── Quiz submissions ────────────────────────────────────────────────────

// POST /api/classrooms/:classId/classwork/:workId/quiz-submit - Student submits quiz, auto-graded server side
router.post('/:workId/quiz-submit', verifyAuthToken, async (req, res) => {
  try {
    const classId = req.params.classId || req.params.id;
    const { workId } = req.params;
    const { answers } = req.body;
    const user = req.user;
    const db = getFirestore();

    const access = await checkClassroomAccess(db, classId, user.uid);
    if (!access.classroomData || (!access.isOwner && !access.isMember)) {
      return res.status(403).json({ error: 'Permission denied: You are not a member of this classroom.' });
    }
    if (access.isOwner) {
      return res.status(403).json({ error: 'The teacher cannot take a quiz in their own classroom.' });
    }

    const docRef = getWorkRef(db, classId, workId);
    const snap = await docRef.get();
    if (!snap.exists) {
      return res.status(404).json({ error: 'Class work not found.' });
    }
    const work = snap.data();
    if (work.type !== 'quiz') {
      return res.status(400).json({ error: 'This class work is not a quiz.' });
    }
    if (work.published !== true && work.status !== 'published') {
      return res.status(403).json({ error: 'This quiz has not been published yet.' });
    }

    const questions = work.questions || [];
    if (questions.length === 0) {
      return res.status(400).json({ error: 'This quiz has no questions.' });
    }

    const attemptRef = docRef.collection('attempts').doc(user.uid);
    const attemptSnap = await attemptRef.get();
    const attemptNumber = attemptSnap.exists ? ((attemptSnap.data().attemptNumber || 0) + 1) : 1;
    if (attemptNumber > 1 && !work.allowResubmission) {
      return res.status(400).json({ error: 'You have already taken this quiz. Retakes are not allowed.' });
    }

    let score = 0;
    let totalMarks = 0;
    const answersArr = Array.isArray(answers) ? answers : [];

    const graded = questions.map((q, i) => {
      const selected = answersArr[i];
      const isCorrect = selected !== undefined && selected !== null && Number(selected) === Number(q.correctIndex);
      const qMarks = Number(q.marks) || 1;
      totalMarks += qMarks;
      if (isCorrect) score += qMarks;
      return {
        questionIndex: i,
        question: q.question,
        selectedAnswer: selected === undefined ? null : Number(selected),
        isCorrect,
        marks: isCorrect ? qMarks : 0,
        maxMarks: qMarks,
      };
    });

    const percentage = totalMarks > 0 ? Math.round((score / totalMarks) * 100) : 0;

    await attemptRef.set({
      studentId: user.uid,
      studentName: user.name || user.displayName || user.email || 'Student',
      workId,
      answers: graded,
      score,
      totalMarks,
      percentage,
      attemptNumber,
      status: 'completed',
      submittedAt: FieldValue.serverTimestamp(),
    });

    await db.collection('classrooms').doc(classId).collection('activity').add({
      type: 'quiz_submitted',
      description: `${user.name || user.email || 'Student'} completed quiz "${work.title}" with score ${score}/${totalMarks}`,
      userId: user.uid,
      userName: user.name || user.displayName || user.email || 'Student',
      timestamp: FieldValue.serverTimestamp(),
    });

    return res.json({
      message: 'Quiz submitted and auto-graded successfully',
      score,
      totalMarks,
      percentage,
      attemptNumber,
      graded,
      status: 'completed',
    });
  } catch (error) {
    console.error('Error submitting quiz:', error);
    return res.status(500).json({ error: 'Failed to submit quiz', details: error.message });
  }
});

// GET /api/classrooms/:classId/classwork/:workId/attempts - Teacher views quiz attempts
router.get('/:workId/attempts', verifyAuthToken, async (req, res) => {
  try {
    const classId = req.params.classId || req.params.id;
    const { workId } = req.params;
    const user = req.user;
    const db = getFirestore();

    const access = await checkClassroomAccess(db, classId, user.uid);
    if (!access.classroomData || !access.isOwner) {
      return res.status(403).json({ error: 'Permission denied: Only the classroom teacher can view attempts.' });
    }

    const snap = await getWorkRef(db, classId, workId).collection('attempts').orderBy('submittedAt', 'desc').get();
    const attempts = snap.docs.map(doc => {
      const d = doc.data();
      if (d.submittedAt && typeof d.submittedAt.toMillis === 'function') d.submittedAt = new Date(d.submittedAt.toMillis()).toISOString();
      return { id: doc.id, ...d };
    });
    return res.json(attempts);
  } catch (error) {
    console.error('Error fetching attempts:', error);
    return res.status(500).json({ error: 'Failed to fetch attempts', details: error.message });
  }
});

export default router;
