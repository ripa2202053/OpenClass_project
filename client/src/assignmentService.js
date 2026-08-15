import {
  getFirestore, collection, doc, addDoc, getDoc, getDocs,
  updateDoc, deleteDoc, setDoc, query, where, orderBy, onSnapshot, serverTimestamp, arrayUnion, Timestamp
} from 'firebase/firestore';
import { fetchWithAuth } from './utils/api.js';
import { safeOnSnapshot, isQuotaExceededError } from './utils/firestoreGuard.js';

export const STATUS = { DRAFT: 'draft', PUBLISHED: 'published', CLOSED: 'closed' };

async function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = (err) => reject(err);
    reader.readAsDataURL(file);
  });
}

export async function uploadFiles(classroomId, files) {
  const results = [];
  if (!files || files.length === 0) return results;

  for (const file of files) {
    if (!file) continue;
    if (!(file instanceof File)) {
      results.push(file);
      continue;
    }
    const fileData = await readFileAsBase64(file);
    let res = null;
    let uploadErr = null;

    try {
      res = await fetchWithAuth(`/api/classrooms/${classroomId}/assignments/upload`, {
        method: 'POST',
        body: JSON.stringify({
          fileName: file.name,
          originalName: file.name,
          fileData,
          mimeType: file.type || 'application/octet-stream',
          fileSize: file.size,
        }),
      });
    } catch (err) {
      uploadErr = err;
    }

    if (!res || (res && res.error) || uploadErr) {
      const errStr = String((res && res.error) || (uploadErr ? uploadErr.message : ''));
      if (errStr.includes('404') || errStr.includes('Not Found') || !res) {
        console.warn('[uploadFiles] /assignments/upload returned 404 on server; trying deployed /files endpoint fallback...');
        try {
          const fallbackRes = await fetchWithAuth(`/api/classrooms/${classroomId}/files`, {
            method: 'POST',
            body: JSON.stringify({
              fileName: file.name,
              originalName: file.name,
              fileData,
              mimeType: file.type || 'application/octet-stream',
              fileSize: file.size,
              title: file.name,
              category: 'Documents'
            }),
          });
          if (fallbackRes && (fallbackRes.downloadURL || fallbackRes.url || fallbackRes.id)) {
            const rawUrl = fallbackRes.downloadURL || fallbackRes.url || `/api/classrooms/${classroomId}/files/${fallbackRes.id}/download`;
            res = {
              originalName: file.name,
              storedName: fallbackRes.fileName || file.name,
              mimeType: file.type || 'application/octet-stream',
              size: file.size,
              url: rawUrl,
              uploadedAt: new Date().toISOString()
            };
          }
        } catch (fbErr) {
          console.error('[uploadFiles] Both /assignments/upload and /files upload endpoints failed:', fbErr.message);
        }
      }
    }

    if (res && res.url) {
      results.push(res);
    } else {
      const errMsg = (res && res.error) ? res.error : `Failed to upload attachment "${file.name}"`;
      throw new Error(errMsg);
    }
  }
  return results;
}

export async function createAssignment(classroomId, data, user) {
  let files = [];
  if (data.files && data.files.length > 0) {
    files = await uploadFiles(classroomId, data.files);
  }

  const db = getFirestore();
  const now = serverTimestamp();

  let dueTimestamp = null;
  if (data.dueDate) {
    const d = data.dueDate instanceof Date ? data.dueDate : new Date(data.dueDate);
    if (!isNaN(d.getTime())) {
      dueTimestamp = Timestamp.fromDate(d);
    }
  }

  const targetStatus = data.status || STATUS.PUBLISHED;

  const docData = {
    title: (data.title || '').trim(),
    description: data.description || '',
    dueDate: dueTimestamp,
    maxMarks: Number(data.maxMarks) || 100,
    files,
    status: targetStatus,
    allowLateSubmissions: data.allowLateSubmissions !== false,
    createdBy: user ? (user.uid || 'teacher') : 'teacher',
    createdByName: (user && (user.displayName || user.name || user.email)) || 'Teacher',
    createdAt: now,
    updatedAt: now,
    publishedAt: targetStatus === STATUS.CLOSED ? null : now,
  };

  try {
    const res = await fetchWithAuth(`/api/classrooms/${classroomId}/assignments`, {
      method: 'POST',
      body: JSON.stringify({
        title: docData.title,
        description: docData.description,
        dueDate: data.dueDate,
        maxMarks: docData.maxMarks,
        files,
        status: docData.status,
        allowLateSubmissions: docData.allowLateSubmissions,
      }),
    });
    if (res && res.id) return { id: res.id };
  } catch (err) {
    console.warn('[createAssignment] Express API call failed, writing directly to Firestore:', err.message);
  }

  const docRef = await addDoc(collection(db, 'classrooms', classroomId, 'assignments'), docData);
  return { id: docRef.id };
}

export async function updateAssignment(classroomId, assignmentId, data) {
  let newFiles = null;
  if (data.files && data.files.length > 0) {
    newFiles = await uploadFiles(classroomId, data.files);
  }
  try {
    const res = await fetchWithAuth(`/api/classrooms/${classroomId}/assignments/${assignmentId}`, {
      method: 'PUT',
      body: JSON.stringify({
        title: data.title,
        description: data.description,
        dueDate: data.dueDate,
        maxMarks: data.maxMarks,
        status: data.status,
        allowLateSubmissions: data.allowLateSubmissions,
        ...(newFiles ? { files: newFiles } : {}),
      }),
    });
    if (res && res.message) return;
  } catch (err) {
    console.warn('Express API updateAssignment failed, falling back to Firestore:', err.message);
  }
  const db = getFirestore();
  const updates = { updatedAt: serverTimestamp() };
  if (data.title !== undefined) updates.title = data.title.trim();
  if (data.description !== undefined) updates.description = data.description;
  if (data.dueDate !== undefined) updates.dueDate = data.dueDate ? Timestamp.fromDate(new Date(data.dueDate)) : null;
  if (data.maxMarks !== undefined) updates.maxMarks = Number(data.maxMarks);
  if (data.status !== undefined) updates.status = data.status;
  if (data.allowLateSubmissions !== undefined) updates.allowLateSubmissions = data.allowLateSubmissions;
  if (newFiles) updates.files = newFiles;
  await updateDoc(doc(db, 'classrooms', classroomId, 'assignments', assignmentId), updates);
}

export async function publishAssignment(classroomId, assignmentId) {
  const db = getFirestore();
  const ref = doc(db, 'classrooms', classroomId, 'assignments', assignmentId);
  const snap = await getDoc(ref);
  const assignment = snap.exists() ? snap.data() : null;

  await updateDoc(ref, {
    status: STATUS.PUBLISHED, publishedAt: serverTimestamp(), updatedAt: serverTimestamp(),
  });

  if (assignment) {
    try {
      await fetchWithAuth(`/api/classrooms/${classroomId}/assignments/${assignmentId}`, {
        method: 'PUT',
        body: JSON.stringify({ status: STATUS.PUBLISHED }),
      });
    } catch (e) {
      console.warn('[assignmentService] Backend publish update failed (non-blocking):', e.message);
    }
  }
}

export async function closeAssignment(classroomId, assignmentId) {
  const db = getFirestore();
  await updateDoc(doc(db, 'classrooms', classroomId, 'assignments', assignmentId), {
    status: STATUS.CLOSED, closedAt: serverTimestamp(), updatedAt: serverTimestamp(),
  });
}

export async function deleteAssignment(classroomId, assignmentId) {
  try {
    const res = await fetchWithAuth(`/api/classrooms/${classroomId}/assignments/${assignmentId}`, {
      method: 'DELETE',
    });
    if (res && res.message) return;
  } catch (err) {
    console.warn('Express API deleteAssignment failed, falling back to Firestore:', err.message);
  }
  await deleteDoc(doc(getFirestore(), 'classrooms', classroomId, 'assignments', assignmentId));
}

export function subscribeAssignments(classroomId, callback) {
  const db = getFirestore();
  return safeOnSnapshot(
    collection(db, 'classrooms', classroomId, 'assignments'),
    (snap) => {
      const list = snap.docs.map(d => ({ id: d.id, classroomId, ...d.data() }));
      list.sort((a, b) => {
        const tA = a.createdAt ? (a.createdAt.toMillis ? a.createdAt.toMillis() : new Date(a.createdAt).getTime()) : Date.now();
        const tB = b.createdAt ? (b.createdAt.toMillis ? b.createdAt.toMillis() : new Date(b.createdAt).getTime()) : Date.now();
        return tB - tA;
      });
      callback(list);
    },
    (err) => console.warn('[assignmentService] subscribeAssignments quota warning:', err)
  );
}

export function subscribeAllClassroomsAssignments(classroomIds, callback) {
  if (!classroomIds || classroomIds.length === 0) {
    callback([]);
    return () => {};
  }
  const db = getFirestore();
  const unsubs = [];
  const map = {};

  classroomIds.forEach(cId => {
    const unsub = safeOnSnapshot(
      collection(db, 'classrooms', cId, 'assignments'),
      (snap) => {
        map[cId] = snap.docs.map(d => ({ id: d.id, classroomId: cId, ...d.data() }));
        const merged = Object.values(map).flat();
        merged.sort((a, b) => {
          const tA = a.createdAt ? (a.createdAt.toMillis ? a.createdAt.toMillis() : new Date(a.createdAt).getTime()) : Date.now();
          const tB = b.createdAt ? (b.createdAt.toMillis ? b.createdAt.toMillis() : new Date(b.createdAt).getTime()) : Date.now();
          return tB - tA;
        });
        callback(merged);
      },
      (err) => console.warn('[assignmentService] subscribeAllClassroomsAssignments warning for class', cId, err)
    );
    unsubs.push(unsub);
  });

  return () => unsubs.forEach(fn => fn && fn());
}

export async function submitAssignment(classroomId, assignmentId, student, files) {
  let uploaded = [];
  if (files && files.length > 0) {
    uploaded = await uploadFiles(classroomId, files);
  }

  try {
    const res = await fetchWithAuth(`/api/classrooms/${classroomId}/assignments/${assignmentId}/submit`, {
      method: 'POST',
      body: JSON.stringify({ files: uploaded }),
    });
    if (res && res.message) {
      return { late: res.late || false };
    }
  } catch (err) {
    console.warn('Express API submitAssignment failed, falling back to Firestore:', err.message);
  }

  const db = getFirestore();
  const assignmentRef = doc(db, 'classrooms', classroomId, 'assignments', assignmentId);
  const assignmentSnap = await getDoc(assignmentRef);
  if (!assignmentSnap.exists()) throw new Error('Assignment not found.');
  const assignment = assignmentSnap.data();

  if (assignment.status === 'closed') throw new Error('This assignment is closed. Submissions are no longer accepted.');
  if (assignment.status === 'draft') throw new Error('This assignment is not yet published.');

  const dueDate = assignment.dueDate ? assignment.dueDate.toMillis() : null;
  const now = Date.now();
  const isLate = dueDate ? now > dueDate : false;

  if (isLate && assignment.allowLateSubmissions === false) {
    throw new Error('Late submissions are not allowed for this assignment.');
  }

  const subRef = doc(db, 'classrooms', classroomId, 'assignments', assignmentId, 'submissions', student.uid);
  const existingSnap = await getDoc(subRef);

  if (uploaded.length === 0 && existingSnap.exists()) {
    uploaded = existingSnap.data().files || [];
  }

  const submission = {
    studentId: student.uid,
    studentName: student.displayName || student.name || student.email || 'Student',
    files: uploaded,
    submittedAt: serverTimestamp(),
    late: isLate,
    status: isLate ? 'late' : 'submitted',
  };

  if (!existingSnap.exists()) {
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

  await setDoc(subRef, submission, { merge: true });
  return { late: isLate };
}

export async function unsubmitAssignment(classroomId, assignmentId, studentUid) {
  try {
    const res = await fetchWithAuth(`/api/classrooms/${classroomId}/assignments/${assignmentId}/unsubmit`, {
      method: 'POST',
    });
    if (res && res.message) return;
  } catch (err) {
    console.warn('Express API unsubmitAssignment failed, falling back to Firestore:', err.message);
  }
  const db = getFirestore();
  const subRef = doc(db, 'classrooms', classroomId, 'assignments', assignmentId, 'submissions', studentUid);
  const subSnap = await getDoc(subRef);
  if (subSnap.exists() && subSnap.data().status === 'graded') {
    throw new Error('Graded work cannot be unsubmitted.');
  }
  await updateDoc(subRef, {
    files: [],
    submittedAt: null,
    status: 'assigned',
    updatedAt: serverTimestamp(),
  });
}

export function subscribeSubmissions(classroomId, assignmentId, callback) {
  const db = getFirestore();
  return safeOnSnapshot(
    collection(db, 'classrooms', classroomId, 'assignments', assignmentId, 'submissions'),
    (snap) => {
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      callback(list);
    },
    (err) => console.warn('[assignmentService] subscribeSubmissions quota warning:', err)
  );
}

export async function gradeAssignment(classroomId, assignmentId, studentId, marks, feedback) {
  try {
    const res = await fetchWithAuth(`/api/classrooms/${classroomId}/assignments/${assignmentId}/submissions/${studentId}/grade`, {
      method: 'POST',
      body: JSON.stringify({ marks: Number(marks), feedback: feedback || '' }),
    });
    if (res && res.message) return;
  } catch (err) {
    console.warn('Express API gradeAssignment failed, falling back to Firestore:', err.message);
  }

  const db = getFirestore();
  const subRef = doc(db, 'classrooms', classroomId, 'assignments', assignmentId, 'submissions', studentId);
  await updateDoc(subRef, {
    marks: Number(marks),
    feedback: feedback || '',
    gradedAt: serverTimestamp(),
    status: 'graded',
  });
}

export function subscribeMySubmission(classroomId, assignmentId, studentUid, callback) {
  const db = getFirestore();
  return safeOnSnapshot(
    doc(db, 'classrooms', classroomId, 'assignments', assignmentId, 'submissions', studentUid),
    (snap) => {
      callback(snap.exists() ? { id: snap.id, ...snap.data() } : null);
    },
    (err) => console.warn('[assignmentService] subscribeMySubmission warning:', err)
  );
}

export const uploadFile = uploadFiles;
