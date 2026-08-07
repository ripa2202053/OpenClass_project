import {
  getFirestore, collection, doc, addDoc, getDoc, getDocs,
  updateDoc, deleteDoc, setDoc, query, where, orderBy, onSnapshot, serverTimestamp
} from 'firebase/firestore';
import { getStorage, ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';

export async function createAssignment(classroomId, data, user) {
  const db = getFirestore();
  const ref = await addDoc(collection(db, 'classrooms', classroomId, 'assignments'), {
    title: data.title.trim(),
    description: data.description || '',
    dueDate: data.dueDate || null,
    maxMarks: Number(data.maxMarks) || 0,
    fileUrl: data.fileUrl || '',
    fileName: data.fileName || '',
    createdBy: user.uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return { id: ref.id };
}

export async function updateAssignment(classroomId, assignmentId, data) {
  const db = getFirestore();
  const updates = {
    title: data.title.trim(),
    description: data.description || '',
    dueDate: data.dueDate || null,
    maxMarks: Number(data.maxMarks) || 0,
    updatedAt: serverTimestamp(),
  };
  if (data.fileUrl) { updates.fileUrl = data.fileUrl; updates.fileName = data.fileName || ''; }
  await updateDoc(doc(db, 'classrooms', classroomId, 'assignments', assignmentId), updates);
}

export async function deleteAssignment(classroomId, assignmentId) {
  await deleteDoc(doc(getFirestore(), 'classrooms', classroomId, 'assignments', assignmentId));
}

export function subscribeAssignments(classroomId, callback) {
  const db = getFirestore();
  return onSnapshot(
    query(collection(db, 'classrooms', classroomId, 'assignments'), orderBy('createdAt', 'desc')),
    (snap) => {
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      callback(list);
    }
  );
}

export async function uploadFile(storagePath, file) {
  const storage = getStorage();
  const storageRef = ref(storage, storagePath);
  const snap = await uploadBytesResumable(storageRef, file);
  return await getDownloadURL(storageRef);
}

export async function submitAssignment(classroomId, assignmentId, student, file, fileName) {
  const db = getFirestore();
  const subRef = doc(db, 'classrooms', classroomId, 'assignments', assignmentId, 'submissions', student.uid);
  let fileUrl = '';
  if (file) {
    fileUrl = await uploadFile(`assignments/${classroomId}/${assignmentId}/${student.uid}/${file.name}`, file);
  }
  const existing = await getDoc(subRef);
  const data = {
    studentId: student.uid,
    studentName: student.displayName || 'Unknown',
    fileUrl: fileUrl || existing.data()?.fileUrl || '',
    fileName: fileName || existing.data()?.fileName || '',
    submittedAt: serverTimestamp(),
    status: existing.exists() ? 'resubmitted' : 'submitted',
  };
  if (!existing.exists()) {
    data.marks = null;
    data.feedback = '';
    data.gradedAt = null;
  }
  await setDoc(subRef, data, { merge: true });
}

export async function gradeAssignment(classroomId, assignmentId, studentId, marks, feedback) {
  const db = getFirestore();
  await updateDoc(doc(db, 'classrooms', classroomId, 'assignments', assignmentId, 'submissions', studentId), {
    marks: Number(marks),
    feedback: feedback || '',
    gradedAt: serverTimestamp(),
    status: 'graded',
  });
}

export function subscribeSubmissions(classroomId, assignmentId, callback) {
  const db = getFirestore();
  return onSnapshot(
    query(collection(db, 'classrooms', classroomId, 'assignments', assignmentId, 'submissions')),
    (snap) => {
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      callback(list);
    }
  );
}

export function subscribeMySubmission(classroomId, assignmentId, uid, callback) {
  const db = getFirestore();
  return onSnapshot(
    doc(db, 'classrooms', classroomId, 'assignments', assignmentId, 'submissions', uid),
    (snap) => { callback(snap.exists() ? { id: snap.id, ...snap.data() } : null); }
  );
}
