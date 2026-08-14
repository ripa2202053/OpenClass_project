import {
  getFirestore, collection, doc, addDoc, getDoc, getDocs,
  updateDoc, deleteDoc, onSnapshot, query, where, orderBy, limit, serverTimestamp,
  Timestamp
} from 'firebase/firestore';

import { safeOnSnapshot, isQuotaExceededError } from './utils/firestoreGuard.js';

export function subscribeAllUsers(callback) {
  return safeOnSnapshot(
    query(collection(getFirestore(), 'users'), orderBy('createdAt', 'desc')),
    (snap) => callback(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    (err) => console.warn('[adminService] subscribeAllUsers quota warning:', err),
    'subscribeAllUsers'
  );
}

export function subscribeUsersByRole(role, callback) {
  return safeOnSnapshot(
    query(collection(getFirestore(), 'users'), where('role', '==', role), orderBy('createdAt', 'desc')),
    (snap) => callback(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    (err) => console.warn('[adminService] subscribeUsersByRole quota warning:', err),
    'subscribeUsersByRole'
  );
}

export async function toggleUserBlock(uid, reason) {
  const db = getFirestore();
  const userSnap = await getDoc(doc(db, 'users', uid));
  if (!userSnap.exists()) throw new Error('User not found.');
  const current = userSnap.data().blocked || false;
  await updateDoc(doc(db, 'users', uid), {
    blocked: !current,
    blockedReason: current ? null : (reason || 'No reason provided'),
    blockedAt: current ? null : serverTimestamp(),
    blockedBy: current ? null : 'system',
    updatedAt: serverTimestamp(),
  });
}

export async function updateUserRole(uid, newRole) {
  await updateDoc(doc(getFirestore(), 'users', uid), {
    role: newRole, updatedAt: serverTimestamp(),
  });
}

export function subscribeAllClassrooms(callback) {
  return safeOnSnapshot(
    query(collection(getFirestore(), 'classrooms'), orderBy('createdAt', 'desc')),
    (snap) => callback(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    (err) => console.warn('[adminService] subscribeAllClassrooms quota warning:', err),
    'subscribeAllClassrooms'
  );
}

export async function archiveClassroomAdmin(classroomId) {
  const db = getFirestore();
  const snap = await getDoc(doc(db, 'classrooms', classroomId));
  if (!snap.exists()) return;
  const current = snap.data().archived || false;
  await updateDoc(doc(db, 'classrooms', classroomId), {
    archived: !current, updatedAt: serverTimestamp(),
  });
}

export async function deleteClassroomAdmin(classroomId) {
  await deleteDoc(doc(getFirestore(), 'classrooms', classroomId));
}

export function subscribeActivityLogs(limitCount = 100, callback) {
  return safeOnSnapshot(
    query(collection(getFirestore(), 'activityLogs'), orderBy('timestamp', 'desc'), limit(limitCount)),
    (snap) => callback(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    (err) => console.warn('[adminService] subscribeActivityLogs quota warning:', err),
    'subscribeActivityLogs'
  );
}

export async function logActivity(action, user, details = {}) {
  const db = getFirestore();
  try {
    await addDoc(collection(db, 'activityLogs'), {
      action,
      userId: user.uid,
      userName: user.displayName || 'Unknown',
      userEmail: user.email || '',
      role: user.role || 'unknown',
      details,
      timestamp: serverTimestamp(),
    });
  } catch (e) {
    if (isQuotaExceededError(e)) {
      console.warn('[adminService] logActivity quota exceeded:', e.message);
    }
  }
}

export function subscribePlatformStats(callback) {
  const db = getFirestore();
  const unsubs = [];
  let users = [];
  let classrooms = [];
  let quizCount = 0;
  let assignmentCount = 0;

  unsubs.push(safeOnSnapshot(collection(db, 'users'), snap => {
    users = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    emit();
  }, null, 'subscribePlatformStats.users'));

  unsubs.push(safeOnSnapshot(collection(db, 'classrooms'), snap => {
    classrooms = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    emit();
  }, null, 'subscribePlatformStats.classrooms'));

  let emitTimer = null;
  function emit() {
    clearTimeout(emitTimer);
    emitTimer = setTimeout(() => {
      const totalUsers = users.length;
      const totalTeachers = users.filter(u => u.role === 'teacher').length;
      const totalStudents = users.filter(u => u.role === 'student').length;
      const blockedUsers = users.filter(u => u.blocked).length;
      const activeClassrooms = classrooms.filter(c => !c.archived).length;
      const archivedClassrooms = classrooms.filter(c => c.archived).length;
      callback({ totalUsers, totalTeachers, totalStudents, blockedUsers, totalClassrooms: classrooms.length, activeClassrooms, archivedClassrooms, totalQuizzes: quizCount, totalAssignments: assignmentCount, lastUpdated: Date.now() });
    }, 500);
  }

  return () => { clearTimeout(emitTimer); unsubs.forEach(u => u()); };
}

