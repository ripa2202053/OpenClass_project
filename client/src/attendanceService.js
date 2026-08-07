import {
  getFirestore, collection, doc, getDoc, setDoc, getDocs,
  query, where, orderBy, onSnapshot, serverTimestamp, writeBatch
} from 'firebase/firestore';
import { fetchWithAuth } from './utils/api.js';

function today() { return new Date().toISOString().slice(0, 10); }

// Auto-mark attendance (once per day per student per class)
export async function autoAttend(classroomId, uid, displayName) {
  try {
    await fetchWithAuth(`/api/classrooms/${classroomId}/attendance`, {
      method: 'POST',
      body: JSON.stringify({ autoMark: true }),
    });
    return;
  } catch (err) {
    console.warn('Express API autoAttend failed, falling back to Firestore:', err.message);
  }
  const d = today();

  const db = getFirestore();
  const ref = doc(db, 'classrooms', classroomId, 'attendance', d);
  const snap = await getDoc(ref);
  const exists = snap.exists();
  const records = exists ? { ...snap.data().records } : {};

  if (records[uid]) return; // already marked

  records[uid] = { status: 'present', timestamp: serverTimestamp(), markedBy: 'auto', markedByName: displayName || 'Auto' };

  if (exists) {
    await setDoc(ref, { ...snap.data(), records, updatedAt: serverTimestamp() });
  } else {
    await setDoc(ref, { date: d, records, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  }

  const uRef = doc(db, 'users', uid, 'attendance', `${classroomId}_${d}`);
  await setDoc(uRef, { classroomId, date: d, status: 'present', markedBy: 'auto', markedByName: 'Auto', timestamp: serverTimestamp() });
}

// Mark individual student
export async function markAttendance(classroomId, dateStr, studentId, status, user) {
  try {
    await fetchWithAuth(`/api/classrooms/${classroomId}/attendance`, {
      method: 'POST',
      body: JSON.stringify({ date: dateStr, studentId, status }),
    });
    return;
  } catch (err) {
    console.warn('Express API markAttendance failed, falling back to Firestore:', err.message);
  }
  const db = getFirestore();
  const ref = doc(db, 'classrooms', classroomId, 'attendance', dateStr);
  const snap = await getDoc(ref);
  const exists = snap.exists();
  const records = exists ? { ...snap.data().records } : {};

  records[studentId] = { status, timestamp: serverTimestamp(), markedBy: user.uid, markedByName: user.displayName || user.uid };

  if (exists) {
    await setDoc(ref, { ...snap.data(), records, updatedAt: serverTimestamp() });
  } else {
    await setDoc(ref, { date: dateStr, records, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  }

  const uRef = doc(db, 'users', studentId, 'attendance', `${classroomId}_${dateStr}`);
  await setDoc(uRef, { classroomId, date: dateStr, status, markedBy: user.uid, markedByName: user.displayName || user.uid, timestamp: serverTimestamp() });
}

// Mark all present
export async function markAllPresent(classroomId, dateStr, studentIds, user) {
  try {
    await fetchWithAuth(`/api/classrooms/${classroomId}/attendance`, {
      method: 'POST',
      body: JSON.stringify({ date: dateStr, studentIds }),
    });
    return;
  } catch (err) {
    console.warn('Express API markAllPresent failed, falling back to Firestore:', err.message);
  }
  const db = getFirestore();

  const batch = writeBatch(db);
  const records = {};

  studentIds.forEach(sid => {
    records[sid] = { status: 'present', timestamp: serverTimestamp(), markedBy: user.uid, markedByName: user.displayName || user.uid };
    const uRef = doc(db, 'users', sid, 'attendance', `${classroomId}_${dateStr}`);
    batch.set(uRef, { classroomId, date: dateStr, status: 'present', markedBy: user.uid, markedByName: user.displayName || user.uid, timestamp: serverTimestamp() });
  });

  const ref = doc(db, 'classrooms', classroomId, 'attendance', dateStr);
  batch.set(ref, { date: dateStr, records, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  await batch.commit();
}

// Real-time attendance for a date
export function subscribeAttendance(classroomId, dateStr, callback) {
  const db = getFirestore();
  return onSnapshot(doc(db, 'classrooms', classroomId, 'attendance', dateStr), (snap) => {
    callback(snap.exists() ? { id: snap.id, ...snap.data() } : null);
  });
}

// Real-time student history
export function subscribeStudentHistory(uid, callback) {
  const db = getFirestore();
  return onSnapshot(
    query(collection(db, 'users', uid, 'attendance'), orderBy('timestamp', 'desc'), limit(200)),
    (snap) => callback(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  );
}

// Get attendance stats for teacher dashboard (today across all classrooms)
export async function getTodayStats(classroomIds) {
  const d = today();
  const db = getFirestore();
  const results = [];
  for (const cId of classroomIds) {
    const snap = await getDoc(doc(db, 'classrooms', cId, 'attendance', d));
    if (snap.exists()) {
      const data = snap.data();
      const records = data.records || {};
      const vals = Object.values(records);
      results.push({
        classroomId: cId,
        total: vals.length,
        present: vals.filter(r => r.status === 'present').length,
        absent: vals.filter(r => r.status === 'absent').length,
        late: vals.filter(r => r.status === 'late').length,
      });
    } else {
      results.push({ classroomId: cId, total: 0, present: 0, absent: 0, late: 0 });
    }
  }
  return results;
}

// Get all attendance docs for a month range
export async function getMonthRange(classroomId, year, month) {
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  const db = getFirestore();
  const col = collection(db, 'classrooms', classroomId, 'attendance');
  const q = query(col, where('date', '>=', `${prefix}-01`), where('date', '<=', `${prefix}-31`));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// Export attendance records from a date range as CSV
export function exportCSV(records) {
  const rows = ['Date,Classroom,Student,Status,Marked By'];
  records.forEach(r => {
    if (r.records) {
      Object.entries(r.records).forEach(([uid, rec]) => {
        rows.push(`${r.date || r.id},${r.classroomId || ''},${uid},${rec.status},${rec.markedByName || rec.markedBy}`);
      });
    }
  });
  return rows.join('\n');
}

// Get classroom members once
export async function getMembers(classroomId) {
  const db = getFirestore();
  const snap = await getDocs(collection(db, 'classrooms', classroomId, 'members'));
  return snap.docs.map(d => ({ uid: d.id, ...d.data() }));
}
