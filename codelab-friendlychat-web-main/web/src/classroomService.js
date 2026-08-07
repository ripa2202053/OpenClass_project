/**
 * OpenClass — Classroom Service
 * Handles all Firestore operations for the Classrooms module.
 */

import {
  getFirestore,
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
} from 'firebase/firestore';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Generate a random 6-character uppercase alphanumeric classroom code.
 */
function generateClassroomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

/**
 * Ensure no existing classroom has the same code.
 */
async function isCodeUnique(code) {
  const db = getFirestore();
  const q = query(
    collection(db, 'classrooms'),
    where('classroomCode', '==', code),
    where('isActive', '==', true)
  );
  const snap = await getDocs(q);
  return snap.empty;
}

/**
 * Generate a guaranteed-unique classroom code.
 */
async function generateUniqueCode() {
  let code;
  let attempts = 0;
  do {
    code = generateClassroomCode();
    attempts++;
    if (attempts > 20) throw new Error('Could not generate unique classroom code.');
  } while (!(await isCodeUnique(code)));
  return code;
}

// ─── Classroom CRUD ──────────────────────────────────────────────────────────

/**
 * Create a new classroom (Teachers only).
 * @param {object} data – { classroomName, description, subject }
 * @param {object} user – current user profile { uid, displayName, role }
 */
export async function createClassroom(data, user) {
  if (!data.classroomName || !data.classroomName.trim()) {
    throw new Error('Classroom name cannot be empty.');
  }
  if (user.role !== 'Teacher') {
    throw new Error('Only Teachers can create classrooms.');
  }

  const db = getFirestore();
  const code = await generateUniqueCode();

  const classroom = {
    classroomName: data.classroomName.trim(),
    classroomCode: code,
    description: data.description ? data.description.trim() : '',
    subject: data.subject ? data.subject.trim() : '',
    createdBy: user.uid,
    teacherName: user.displayName,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    memberCount: 1,
    isActive: true,
  };

  const docRef = await addDoc(collection(db, 'classrooms'), classroom);

  // Add creator as first member
  await setDoc(
    doc(db, 'classrooms', docRef.id, 'members', user.uid),
    {
      uid: user.uid,
      displayName: user.displayName,
      email: user.email || '',
      role: user.role,
      joinedAt: serverTimestamp(),
    }
  );

  return { classroomId: docRef.id, ...classroom };
}

/**
 * Update classroom info (creator only).
 */
export async function updateClassroom(classroomId, data, user) {
  const db = getFirestore();
  const ref = doc(db, 'classrooms', classroomId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('Classroom not found.');
  if (snap.data().createdBy !== user.uid && user.role !== 'Teacher') {
    throw new Error('Permission denied: only the creator or a Teacher can edit this classroom.');
  }
  const updates = {
    classroomName: data.classroomName.trim(),
    description: data.description ? data.description.trim() : '',
    subject: data.subject ? data.subject.trim() : '',
    updatedAt: serverTimestamp(),
  };
  await updateDoc(ref, updates);
  return { classroomId, ...snap.data(), ...updates };
}

/**
 * Soft-delete (archive) a classroom.
 */
export async function deleteClassroom(classroomId, user) {
  const db = getFirestore();
  const ref = doc(db, 'classrooms', classroomId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('Classroom not found.');
  if (snap.data().createdBy !== user.uid && user.role !== 'Teacher') {
    throw new Error('Permission denied.');
  }
  await updateDoc(ref, { isActive: false, updatedAt: serverTimestamp() });
}

/**
 * Get a single classroom document.
 */
export async function getClassroom(classroomId) {
  const db = getFirestore();
  const snap = await getDoc(doc(db, 'classrooms', classroomId));
  if (!snap.exists()) return null;
  return { classroomId: snap.id, ...snap.data() };
}

// ─── Membership ──────────────────────────────────────────────────────────────

/**
 * Join a classroom by code.
 * Prevents joining twice.
 */
export async function joinClassroomByCode(code, user) {
  if (!code || !code.trim()) throw new Error('Please enter a classroom code.');

  const db = getFirestore();
  const q = query(
    collection(db, 'classrooms'),
    where('classroomCode', '==', code.trim().toUpperCase()),
    where('isActive', '==', true)
  );
  const snap = await getDocs(q);
  if (snap.empty) throw new Error('No active classroom found with that code.');

  const classroomDoc = snap.docs[0];
  const classroomId = classroomDoc.id;

  // Check already joined
  const memberRef = doc(db, 'classrooms', classroomId, 'members', user.uid);
  const memberSnap = await getDoc(memberRef);
  if (memberSnap.exists()) throw new Error('You have already joined this classroom.');

  // Add member
  await setDoc(memberRef, {
    uid: user.uid,
    displayName: user.displayName,
    email: user.email || '',
    role: user.role,
    joinedAt: serverTimestamp(),
  });

  // Increment member count
  const currentCount = classroomDoc.data().memberCount || 0;
  await updateDoc(doc(db, 'classrooms', classroomId), {
    memberCount: currentCount + 1,
    updatedAt: serverTimestamp(),
  });

  return { classroomId, ...classroomDoc.data() };
}

/**
 * Leave a classroom. The creator (teacher) cannot leave their own classroom.
 */
export async function leaveClassroom(classroomId, user) {
  const db = getFirestore();
  const classroomRef = doc(db, 'classrooms', classroomId);
  const snap = await getDoc(classroomRef);
  if (!snap.exists()) throw new Error('Classroom not found.');
  if (snap.data().createdBy === user.uid) {
    throw new Error('The classroom creator cannot leave. Archive the classroom instead.');
  }

  const memberRef = doc(db, 'classrooms', classroomId, 'members', user.uid);
  const memberSnap = await getDoc(memberRef);
  if (!memberSnap.exists()) throw new Error('You are not a member of this classroom.');

  await deleteDoc(memberRef);

  const currentCount = snap.data().memberCount || 1;
  await updateDoc(classroomRef, {
    memberCount: Math.max(0, currentCount - 1),
    updatedAt: serverTimestamp(),
  });
}

/**
 * Get all members of a classroom.
 */
export async function getClassroomMembers(classroomId) {
  const db = getFirestore();
  const snap = await getDocs(
    query(collection(db, 'classrooms', classroomId, 'members'), orderBy('joinedAt', 'asc'))
  );
  return snap.docs.map(d => d.data());
}

/**
 * Check if a user is a member of a given classroom.
 */
export async function isMember(classroomId, uid) {
  const db = getFirestore();
  const snap = await getDoc(doc(db, 'classrooms', classroomId, 'members', uid));
  return snap.exists();
}

// ─── Real-time Subscriptions ─────────────────────────────────────────────────

/**
 * Subscribe to all active classrooms where user is a member.
 * Returns unsubscribe function.
 */
export function subscribeToUserClassrooms(uid, callback) {
  const db = getFirestore();
  const q = query(
    collection(db, 'classrooms'),
    where('isActive', '==', true),
    orderBy('createdAt', 'desc')
  );

  return onSnapshot(q, async (snapshot) => {
    const allClassrooms = snapshot.docs.map(d => ({ classroomId: d.id, ...d.data() }));

    // Filter to only classrooms this user is a member of
    const userClassrooms = [];
    for (const classroom of allClassrooms) {
      const memberRef = doc(db, 'classrooms', classroom.classroomId, 'members', uid);
      const memberSnap = await getDoc(memberRef);
      if (memberSnap.exists()) {
        userClassrooms.push(classroom);
      }
    }
    callback(userClassrooms);
  });
}

/**
 * Subscribe to members of a specific classroom.
 * Returns unsubscribe function.
 */
export function subscribeToClassroomMembers(classroomId, callback) {
  const db = getFirestore();
  const q = query(
    collection(db, 'classrooms', classroomId, 'members'),
    orderBy('joinedAt', 'asc')
  );
  return onSnapshot(q, (snapshot) => {
    const members = snapshot.docs.map(d => d.data());
    callback(members);
  });
}
