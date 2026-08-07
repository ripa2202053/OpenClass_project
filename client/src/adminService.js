import {
  getFirestore, collection, doc, addDoc, getDoc, getDocs,
  updateDoc, deleteDoc, onSnapshot, query, where, orderBy, limit, serverTimestamp,
  Timestamp
} from 'firebase/firestore';

export function subscribeAllUsers(callback) {
  return onSnapshot(
    query(collection(getFirestore(), 'users'), orderBy('createdAt', 'desc')),
    (snap) => callback(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  );
}

export function subscribeUsersByRole(role, callback) {
  return onSnapshot(
    query(collection(getFirestore(), 'users'), where('role', '==', role), orderBy('createdAt', 'desc')),
    (snap) => callback(snap.docs.map(d => ({ id: d.id, ...d.data() })))
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
  return onSnapshot(
    query(collection(getFirestore(), 'classrooms'), orderBy('createdAt', 'desc')),
    (snap) => callback(snap.docs.map(d => ({ id: d.id, ...d.data() })))
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
  return onSnapshot(
    query(collection(getFirestore(), 'activityLogs'), orderBy('timestamp', 'desc'), limit(limitCount)),
    (snap) => callback(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  );
}

export async function logActivity(action, user, details = {}) {
  const db = getFirestore();
  await addDoc(collection(db, 'activityLogs'), {
    action,
    userId: user.uid,
    userName: user.displayName || 'Unknown',
    userEmail: user.email || '',
    role: user.role || 'unknown',
    details,
    timestamp: serverTimestamp(),
  });
}

export function subscribePlatformStats(callback) {
  const db = getFirestore();
  const unsubs = [];
  let users = [];
  let classrooms = [];
  let quizzes = [];
  let assignments = [];

  unsubs.push(onSnapshot(collection(db, 'users'), snap => { users = snap.docs.map(d => ({ id: d.id, ...d.data() })); emit(); }));
  unsubs.push(onSnapshot(collection(db, 'classrooms'), snap => { classrooms = snap.docs.map(d => ({ id: d.id, ...d.data() })); emit(); }));

  let quizCount = 0;
  let assignmentCount = 0;

  async function refreshCounts() {
    let qc = 0, ac = 0;
    for (const c of classrooms) {
      try {
        const qSnap = await getDocs(collection(db, 'classrooms', c.id, 'quizzes'));
        qc += qSnap.size;
        const aSnap = await getDocs(collection(db, 'classrooms', c.id, 'assignments'));
        ac += aSnap.size;
      } catch {}
    }
    quizCount = qc;
    assignmentCount = ac;
    emit();
  }

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

  refreshCounts();
  return () => { clearTimeout(emitTimer); unsubs.forEach(u => u()); };
}
