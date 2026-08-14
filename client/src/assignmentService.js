import {
  getFirestore, collection, doc, addDoc, getDoc, getDocs,
  updateDoc, deleteDoc, setDoc, query, where, orderBy, onSnapshot, serverTimestamp, arrayUnion, Timestamp
} from 'firebase/firestore';
import { getStorage, ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { fetchWithAuth } from './utils/api.js';
import { safeOnSnapshot, isQuotaExceededError } from './utils/firestoreGuard.js';


export const STATUS = { DRAFT: 'draft', PUBLISHED: 'published', CLOSED: 'closed' };

async function uploadFiles(files, basePath) {
  const storage = getStorage();
  const results = [];
  for (const file of files) {
    const path = `${basePath}/${Date.now()}_${file.name}`;
    const storageRef = ref(storage, path);
    await uploadBytesResumable(storageRef, file);
    const url = await getDownloadURL(storageRef);
    results.push({ name: file.name, url, type: file.type, size: file.size });
  }
  return results;
}

export async function createAssignment(classroomId, data, user) {
  let files = [];
  if (data.files && data.files.length > 0) {
    files = await uploadFiles(data.files, `assignments/${classroomId}/${Date.now()}`);
  }
  try {
    const res = await fetchWithAuth(`/api/classrooms/${classroomId}/assignments`, {
      method: 'POST',
      body: JSON.stringify({
        title: data.title,
        description: data.description,
        dueDate: data.dueDate,
        maxMarks: data.maxMarks,
        files,
        status: data.status || STATUS.DRAFT,
      }),
    });
    if (res && res.id) return { id: res.id };
  } catch (err) {
    console.warn('Express API createAssignment failed, falling back to Firestore:', err.message);
  }
  const db = getFirestore();

  const now = serverTimestamp();
  const docData = {
    title: data.title.trim(),
    description: data.description || '',
    dueDate: data.dueDate || null,
    maxMarks: Number(data.maxMarks) || 0,
    files,
    status: data.status || STATUS.DRAFT,
    createdBy: user.uid,
    createdAt: now,
    updatedAt: now,
    publishedAt: data.status === STATUS.PUBLISHED ? now : null,
  };
  const ref = await addDoc(collection(db, 'classrooms', classroomId, 'assignments'), docData);
  return { id: ref.id };
}

export async function updateAssignment(classroomId, assignmentId, data) {
  const db = getFirestore();
  const ref = doc(db, 'classrooms', classroomId, 'assignments', assignmentId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('Assignment not found.');
  const updates = {
    title: data.title.trim(),
    description: data.description || '',
    dueDate: data.dueDate || null,
    maxMarks: Number(data.maxMarks) || 0,
    updatedAt: serverTimestamp(),
  };
  if (data.files && data.files.length > 0) {
    updates.files = await uploadFiles(data.files, `assignments/${classroomId}/${assignmentId}`);
  }
  if (data.status && data.status !== snap.data().status) {
    updates.status = data.status;
    if (data.status === STATUS.PUBLISHED) updates.publishedAt = serverTimestamp();
    if (data.status === STATUS.CLOSED) updates.closedAt = serverTimestamp();
  }
  await updateDoc(ref, updates);
}

export async function publishAssignment(classroomId, assignmentId) {
  const db = getFirestore();
  await updateDoc(doc(db, 'classrooms', classroomId, 'assignments', assignmentId), {
    status: STATUS.PUBLISHED, publishedAt: serverTimestamp(), updatedAt: serverTimestamp(),
  });
}

export async function closeAssignment(classroomId, assignmentId) {
  const db = getFirestore();
  await updateDoc(doc(db, 'classrooms', classroomId, 'assignments', assignmentId), {
    status: STATUS.CLOSED, closedAt: serverTimestamp(), updatedAt: serverTimestamp(),
  });
}

export async function deleteAssignment(classroomId, assignmentId) {
  await deleteDoc(doc(getFirestore(), 'classrooms', classroomId, 'assignments', assignmentId));
}

export function subscribeAssignments(classroomId, callback) {
  return safeOnSnapshot(
    query(collection(getFirestore(), 'classrooms', classroomId, 'assignments'), orderBy('createdAt', 'desc')),
    (snap) => callback(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    (err) => console.warn('[assignmentService] subscribeAssignments quota warning:', err),
    'subscribeAssignments'
  );
}

export function subscribeAllClassroomsAssignments(classroomIds, callback) {
  const db = getFirestore();
  const unsubs = [];
  const allMap = {};
  classroomIds.forEach(cId => {
    const u = safeOnSnapshot(
      query(collection(db, 'classrooms', cId, 'assignments'), orderBy('createdAt', 'desc')),
      (snap) => {
        allMap[cId] = snap.docs.map(d => ({ id: d.id, classroomId: cId, ...d.data() }));
        const merged = Object.values(allMap).flat();
        callback(merged);
      },
      (err) => console.warn(`[assignmentService] subscribeAllClassroomsAssignments quota warning for ${cId}:`, err),
      `subscribeAllClassroomsAssignments_${cId}`
    );
    unsubs.push(u);
  });
  return () => unsubs.forEach(u => u());
}

export async function uploadFile(storagePath, file) {
  const storage = getStorage();
  const storageRef = ref(storage, storagePath);
  await uploadBytesResumable(storageRef, file);
  return await getDownloadURL(storageRef);
}

export async function submitAssignment(classroomId, assignmentId, student, files) {
  let uploaded = [];
  if (files && files.length > 0) {
    const filtered = files.filter(f => f instanceof File);
    if (filtered.length > 0) {
      uploaded = await uploadFiles(filtered, `assignments/${classroomId}/${assignmentId}/${student.uid}`);
    } else {
      uploaded = files;
    }
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

  const subRef = doc(db, 'classrooms', classroomId, 'assignments', assignmentId, 'submissions', student.uid);
  const existingSnap = await getDoc(subRef);
  if (uploaded.length === 0 && files && files.length > 0) {

    const filtered = files.filter(f => f instanceof File);
    if (filtered.length > 0) {
      uploaded = await uploadFiles(filtered, `assignments/${classroomId}/${assignmentId}/${student.uid}`);
    }
  }

  if (uploaded.length === 0 && existingSnap.exists()) {
    uploaded = existingSnap.data().files || [];
  }

  const submission = {
    studentId: student.uid,
    studentName: student.displayName || 'Unknown',
    files: uploaded,
    submittedAt: serverTimestamp(),
    late: isLate,
    status: isLate ? 'late' : (existingSnap.exists() ? 'resubmitted' : 'submitted'),
  };
  if (!existingSnap.exists()) {
    submission.marks = null;
    submission.feedback = '';
    submission.gradedAt = null;
    submission.history = [];
  } else {
    const existing = existingSnap.data();
    submission.marks = existing.marks;
    submission.feedback = existing.feedback;
    submission.gradedAt = existing.gradedAt;
    const prevEntry = {
      files: existing.files || [],
      submittedAt: existing.submittedAt || null,
      status: existing.status || 'submitted',
      late: existing.late || false,
    };
    submission.history = [...(existing.history || []), prevEntry];
  }
  await setDoc(subRef, submission);
  return { late: isLate };
}

export async function gradeAssignment(classroomId, assignmentId, studentId, marks, feedback, grader) {
  const db = getFirestore();
  await updateDoc(doc(db, 'classrooms', classroomId, 'assignments', assignmentId, 'submissions', studentId), {
    marks: Number(marks),
    feedback: feedback || '',
    gradedAt: serverTimestamp(),
    gradedBy: grader?.uid || '',
    status: 'graded',
  });
}

export function subscribeSubmissions(classroomId, assignmentId, callback) {
  return safeOnSnapshot(
    query(collection(getFirestore(), 'classrooms', classroomId, 'assignments', assignmentId, 'submissions')),
    (snap) => callback(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    (err) => console.warn('[assignmentService] subscribeSubmissions quota warning:', err),
    'subscribeSubmissions'
  );
}

export function subscribeMySubmission(classroomId, assignmentId, uid, callback) {
  return safeOnSnapshot(
    doc(getFirestore(), 'classrooms', classroomId, 'assignments', assignmentId, 'submissions', uid),
    (snap) => callback(snap.exists() ? { id: snap.id, ...snap.data() } : null),
    (err) => console.warn('[assignmentService] subscribeMySubmission quota warning:', err),
    'subscribeMySubmission'
  );
}

