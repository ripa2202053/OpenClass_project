import { getAuth } from 'firebase/auth';
import {
  getFirestore,
  collection,
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
  limit,
  onSnapshot,
  serverTimestamp,
  collectionGroup,
  arrayUnion,
} from 'firebase/firestore';
import { getStorage, ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { fetchWithAuth } from './utils/api.js';
import { createNotification } from './notificationService.js';
import { safeOnSnapshot, isQuotaExceededError } from './utils/firestoreGuard.js';

const knownMemberClassroomIds = new Set();


function generateClassroomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const length = Math.floor(Math.random() * 2) + 6; // 6-7 characters
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

async function isCodeUnique(code) {
  const db = getFirestore();
  const q = query(collection(db, 'classrooms'), where('classroomCode', '==', code), where('isActive', '==', true));
  const snap = await getDocs(q);
  return snap.empty;
}

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

export const CLASSROOM_THEMES = {
  blue: { id: 'blue', name: 'Classic Blue', gradient: 'linear-gradient(135deg, #3B82F6 0%, #1E3A8A 100%)', bg: '#3B82F6' },
  electric: { id: 'electric', name: 'Neon Electric Blue', gradient: 'linear-gradient(135deg, #00F0FF 0%, #0072FF 100%)', bg: '#00F0FF' },
  cyber: { id: 'cyber', name: 'Neon Cyber Purple', gradient: 'linear-gradient(135deg, #A855F7 0%, #6D28D9 100%)', bg: '#A855F7' },
  emerald: { id: 'emerald', name: 'Neon Emerald Green', gradient: 'linear-gradient(135deg, #10B981 0%, #065F46 100%)', bg: '#10B981' },
  hotpink: { id: 'hotpink', name: 'Neon Hot Pink', gradient: 'linear-gradient(135deg, #FF007F 0%, #C0004F 100%)', bg: '#FF007F' },
  sunset: { id: 'sunset', name: 'Neon Sunset Orange', gradient: 'linear-gradient(135deg, #FF6B00 0%, #E11D48 100%)', bg: '#FF6B00' },
  yellow: { id: 'yellow', name: 'Neon Bright Yellow', gradient: 'linear-gradient(135deg, #FFE600 0%, #FFB300 100%)', bg: '#FFE600' },
  indigo: { id: 'indigo', name: 'Neon Deep Indigo', gradient: 'linear-gradient(135deg, #6366F1 0%, #312E81 100%)', bg: '#6366F1' },
  crimson: { id: 'crimson', name: 'Neon Crimson Red', gradient: 'linear-gradient(135deg, #FF2A6D 0%, #8A0E2F 100%)', bg: '#FF2A6D' },
};

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function darkenHex(hex, percent) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const num = parseInt(full, 16);
  let r = (num >> 16) & 0xff;
  let g = (num >> 8) & 0xff;
  let b = num & 0xff;
  const amt = Math.round(2.55 * percent);
  r = Math.max(0, Math.min(255, r + amt));
  g = Math.max(0, Math.min(255, g + amt));
  b = Math.max(0, Math.min(255, b + amt));
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

export function getThemeGradient(themeId) {
  const theme = CLASSROOM_THEMES[themeId];
  if (theme) return theme.gradient;
  if (typeof themeId === 'string' && HEX_RE.test(themeId.trim())) {
    const hex = themeId.trim();
    return `linear-gradient(135deg, ${hex} 0%, ${darkenHex(hex, -45)} 100%)`;
  }
  return CLASSROOM_THEMES.blue.gradient;
}

export function generateInviteLink(classroomCode) {
  const origin = window.location.origin || 'http://localhost:5173';
  return `${origin}/?join=${classroomCode}`;
}

export async function createClassroom(data, user) {
  if (!data.classroomName || !data.classroomName.trim()) {
    throw new Error('Classroom name cannot be empty.');
  }
  const uRole = (user?.role || localStorage.getItem('openclass_user_role') || (JSON.parse(localStorage.getItem('openclass_user_profile') || '{}').role) || '').toLowerCase();
  if (uRole && uRole !== 'teacher' && uRole !== 'admin') {
    throw new Error('Only Teachers can create classrooms.');
  }

  const themeColor = data.themeColor || 'blue';
  const teacherName = (data.teacherName || user.displayName || user.name || 'Teacher').trim();
  let coverImageUrl = '';

  // 1. Cover upload logic if file is provided
  if (data.coverFile) {
    try {
      const storage = getStorage();
      const storageRef = ref(storage, `classroom_covers/${Date.now()}_${data.coverFile.name}`);
      await uploadBytesResumable(storageRef, data.coverFile);
      coverImageUrl = await getDownloadURL(storageRef);
    } catch (e) {
      console.warn('Cover upload failed, proceeding without cover:', e);
    }
  }

  // 2. Try Express API first
  try {
    const res = await fetchWithAuth('/api/classrooms', {
      method: 'POST',
      body: JSON.stringify({
        classroomName: data.classroomName,
        description: data.description,
        courseCode: data.courseCode,
        teacherName,
        themeColor,
        coverImageUrl,
      }),
    });
    if (res && res.id) {
      const createdObj = { classroomId: res.id, ...res };
      try {
        const cacheKey = `openclass_cached_classrooms_${user.uid}`;
        const cached = JSON.parse(localStorage.getItem(cacheKey) || '[]');
        if (!cached.some(c => c.classroomId === res.id)) {
          cached.unshift(createdObj);
          localStorage.setItem(cacheKey, JSON.stringify(cached));
        }
      } catch (e) {}
      return createdObj;
    }
  } catch (err) {
    console.warn('Express API createClassroom failed, falling back to Firestore:', err.message);
  }

  // 3. Fallback to direct Firestore write
  const db = getFirestore();
  const code = await generateUniqueCode();

  const classroom = {
    classroomName: data.classroomName.trim(),
    classroomCode: code,
    description: data.description ? data.description.trim() : '',
    courseCode: data.courseCode ? String(data.courseCode).trim() : '',
    teacherName,
    themeColor,
    coverImageUrl,
    createdBy: user.uid,
    teacherId: user.uid,
    teacherUid: user.uid,
    ownerId: user.uid,
    teacherPhotoURL: user.photoURL || '',
    createdAt: serverTimestamp(),
    createdDate: new Date().toISOString(),
    updatedAt: serverTimestamp(),
    memberCount: 1,
    isActive: true,
    isArchived: false,
  };

  const docRef = await addDoc(collection(db, 'classrooms'), classroom);
  
  await setDoc(doc(db, 'classrooms', docRef.id, 'members', user.uid), {
    uid: user.uid,
    displayName: user.displayName || user.name || 'Teacher',
    email: user.email || '',
    photoURL: user.photoURL || '',
    role: user.role,
    joinedAt: serverTimestamp(),
    approved: true,
    approvedBy: user.uid,
    approvedAt: serverTimestamp(),
  });

  await addDoc(collection(db, 'classrooms', docRef.id, 'activity'), {
    type: 'classroom_created',
    description: 'Classroom created',
    userId: user.uid,
    userName: user.displayName || user.name || 'Teacher',
    timestamp: serverTimestamp(),
  });

  const createdObj = { classroomId: docRef.id, ...classroom };
  try {
    const cacheKey = `openclass_cached_classrooms_${user.uid}`;
    const cached = JSON.parse(localStorage.getItem(cacheKey) || '[]');
    if (!cached.some(c => c.classroomId === docRef.id)) {
      cached.unshift(createdObj);
      localStorage.setItem(cacheKey, JSON.stringify(cached));
    }
  } catch (e) {}

  return createdObj;
}

export async function updateClassroom(classroomId, data, user) {
  let coverImageUrl = '';

  if (data.coverFile) {
    try {
      const storage = getStorage();
      const storageRef = ref(storage, `classroom_covers/${Date.now()}_${data.coverFile.name}`);
      await uploadBytesResumable(storageRef, data.coverFile);
      coverImageUrl = await getDownloadURL(storageRef);
    } catch (e) {
      console.warn('Cover upload failed:', e);
    }
  }

  try {
    const res = await fetchWithAuth(`/api/classrooms/${classroomId}`, {
      method: 'PUT',
      body: JSON.stringify({
        classroomName: data.classroomName,
        description: data.description,
        courseCode: data.courseCode,
        teacherName: data.teacherName,
        themeColor: data.themeColor,
        ...(coverImageUrl ? { coverImageUrl } : {}),
      }),
    });
    if (res && res.id) return { classroomId: res.id, ...res };
  } catch (err) {
    console.warn('Express API updateClassroom failed, falling back to Firestore:', err.message);
  }

  const db = getFirestore();
  const classRef = doc(db, 'classrooms', classroomId);
  const snap = await getDoc(classRef);
  if (!snap.exists()) throw new Error('Classroom not found.');
  if (snap.data().createdBy !== user.uid) {
    throw new Error('Permission denied: only the creator can edit this classroom.');
  }

  const finalCoverUrl = coverImageUrl || snap.data().coverImageUrl || '';

  const updates = {
    classroomName: data.classroomName.trim(),
    description: data.description ? data.description.trim() : '',
    courseCode: data.courseCode ? String(data.courseCode).trim() : '',
    ...(data.teacherName ? { teacherName: String(data.teacherName).trim() } : {}),
    ...(data.themeColor ? { themeColor: data.themeColor } : {}),
    coverImageUrl: finalCoverUrl,
    updatedAt: serverTimestamp(),
  };

  await updateDoc(classRef, updates);
  await addDoc(collection(db, 'classrooms', classroomId, 'activity'), {
    type: 'classroom_updated',
    description: 'Classroom details updated',
    userId: user.uid,
    userName: user.displayName || user.name || 'Teacher',
    timestamp: serverTimestamp(),
  });

  return { classroomId, ...snap.data(), ...updates };
}

export async function archiveClassroom(classroomId, user) {
  try {
    await fetchWithAuth(`/api/classrooms/${classroomId}/archive`, {
      method: 'PUT',
    });
    return;
  } catch (err) {
    console.warn('Express API archiveClassroom failed, falling back to Firestore:', err.message);
  }

  const db = getFirestore();
  const classRef = doc(db, 'classrooms', classroomId);
  const snap = await getDoc(classRef);
  if (!snap.exists()) throw new Error('Classroom not found.');
  if (snap.data().createdBy !== user.uid) {
    throw new Error('Permission denied.');
  }
  const newStatus = !snap.data().isArchived;
  await updateDoc(classRef, { isArchived: newStatus, isActive: !newStatus, updatedAt: serverTimestamp() });
}

export async function deleteClassroomPermanent(classroomId, user) {
  try {
    await fetchWithAuth(`/api/classrooms/${classroomId}`, {
      method: 'DELETE',
    });
    return;
  } catch (err) {
    console.warn('Express API deleteClassroom failed, falling back to Firestore:', err.message);
  }

  const db = getFirestore();
  const classRef = doc(db, 'classrooms', classroomId);
  await updateDoc(classRef, { isActive: false, isDeleted: true, updatedAt: serverTimestamp() });
}

export async function getClassroom(classroomId) {
  const snap = await getDoc(doc(getFirestore(), 'classrooms', classroomId));
  if (!snap.exists()) return null;
  return { classroomId: snap.id, ...snap.data() };
}

export async function validateJoinCode(code) {
  if (!code || !code.trim()) {
    return { valid: false, error: 'Please enter a classroom code.' };
  }
  const db = getFirestore();
  const q = query(
    collection(db, 'classrooms'),
    where('classroomCode', '==', code.trim().toUpperCase()),
    where('isActive', '==', true)
  );
  const snap = await getDocs(q);
  if (snap.empty) {
    return { valid: false, error: 'Invalid Classroom Code' };
  }
  const classroomDoc = snap.docs[0];
  const cData = classroomDoc.data();
  return { 
    valid: true, 
    classroomId: classroomDoc.id, 
    teacherId: cData.teacherId || cData.createdBy || '',
    classroomCode: cData.classroomCode,
    classroomName: cData.classroomName
  };
}

export async function joinClassroomByCode(code, user) {
  if (!code || !code.trim()) throw new Error('Please enter a classroom code.');
  // Direct Firestore flow — intentionally bypasses the Express API so the join
  // request persists even if a backend route fails silently.
  const db = getFirestore();
  const q = query(
    collection(db, 'classrooms'),
    where('classroomCode', '==', code.trim().toUpperCase()),
    where('isActive', '==', true)
  );
  const snap = await getDocs(q);
  if (snap.empty) throw new Error('No active classroom found with that code.');
  const classroomDoc = snap.docs[0];
  const classroomData = classroomDoc.data();
  console.log('[DEBUG Join] Found classroom:', classroomDoc.id, classroomData.classroomName || classroomData.courseName, 'Teacher:', classroomData.teacherUid || classroomData.ownerId);
  const classroomId = classroomDoc.id;
  const memberRef = doc(db, 'classrooms', classroomId, 'members', user.uid);
  const memberSnap = await getDoc(memberRef);
  if (memberSnap.exists()) throw new Error('You have already joined this classroom.');
  const joinReqRef = doc(db, 'classrooms', classroomId, 'joinRequests', user.uid);
  const joinReqSnap = await getDoc(joinReqRef);
  if (joinReqSnap.exists() && joinReqSnap.data().status === 'pending') {
    throw new Error('You already have a pending join request for this classroom.');
  }
  const resolvedTeacherUid = classroomData.ownerId || classroomData.teacherUid || classroomData.createdBy || classroomData.userId || classroomData.teacherId || '';
  const studentName = user.displayName || user.name || 'Student';
  const requestId = `${classroomId}_${user.uid}`;
  const requestDoc = {
    requestId,
    studentUid: user.uid,
    uid: user.uid,
    displayName: studentName,
    studentName,
    email: user.email || '',
    studentEmail: user.email || '',
    studentId: user.studentId || user.roll || '',
    department: user.department || '',
    photoURL: user.photoURL || '',
    role: (user.role || 'student').toLowerCase(),
    classId: classroomId,
    className: classroomData.classroomName || classroomData.courseName || 'Classroom',
    classroomId,
    classroomName: classroomData.classroomName || classroomData.courseName || 'Classroom',
    classroomCode: classroomData.classroomCode || '',
    teacherUid: resolvedTeacherUid,
    ownerId: resolvedTeacherUid,
    teacherId: resolvedTeacherUid,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  // Direct write into the top-level collection; the approvals tab subscribes to
  // it. The per-classroom subcollection mirrors it for classroom-detail views.
  await setDoc(doc(db, 'classroomRequests', requestId), requestDoc);
  console.log('[DEBUG Join] Request successfully saved to Firestore!');
  await setDoc(joinReqRef, {
    uid: user.uid,
    displayName: requestDoc.studentName,
    email: requestDoc.studentEmail,
    studentId: requestDoc.studentId,
    photoURL: requestDoc.photoURL || '',
    role: requestDoc.role,
    requestedAt: serverTimestamp(),
    status: 'pending',
  });
  // Notify the teacher (best-effort, non-blocking) so the bell badge updates.
  if (resolvedTeacherUid) {
    createNotification(resolvedTeacherUid, 'join_request', 'New Join Request', `${studentName} requested to join ${requestDoc.className || 'your classroom'}`, {
      teacherUid: resolvedTeacherUid,
      classId: classroomId,
    }).catch(() => {});
  }
  await addDoc(collection(db, 'classrooms', classroomId, 'activity'), {
    type: 'join_requested',
    description: `${user.displayName || 'A student'} requested to join`,
    userId: user.uid,
    userName: user.displayName || 'Unknown',
    timestamp: serverTimestamp(),
  });
  const joinedObj = { classroomId, ...classroomDoc.data(), joinStatus: 'pending' };
  try {
    const cacheKey = `openclass_joined_${user.uid}`;
    const cached = JSON.parse(localStorage.getItem(cacheKey) || '[]');
    if (!cached.some(c => c.classroomId === classroomId)) {
      cached.push(joinedObj);
      localStorage.setItem(cacheKey, JSON.stringify(cached));
    }
  } catch(e) {}
  return joinedObj;
}

export async function getJoinRequests(classroomId) {
  try {
    const res = await fetchWithAuth(`/api/classrooms/${classroomId}/requests`);
    if (res && Array.isArray(res.requests)) {
      return res.requests;
    }
  } catch (err) {
    console.warn('Express API getJoinRequests failed, falling back to Firestore:', err.message);
  }
  const db = getFirestore();
  const snap = await getDocs(query(
    collection(db, 'classrooms', classroomId, 'joinRequests'),
    where('status', '==', 'pending')
  ));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.requestedAt?.seconds || 0) - (a.requestedAt?.seconds || 0));
}

export async function approveMember(classroomId, memberUid, user) {
  try {
    await fetchWithAuth(`/api/classrooms/${classroomId}/requests/${memberUid}/accept`, {
      method: 'POST',
    });
    return;
  } catch (err) {
    console.warn('Express API approveMember failed, falling back to Firestore:', err.message);
  }
  const db = getFirestore();
  const classroomRef = doc(db, 'classrooms', classroomId);
  const classroomSnap = await getDoc(classroomRef);
  if (!classroomSnap.exists()) throw new Error('Classroom not found.');
  if (classroomSnap.data().createdBy !== user.uid) {
    throw new Error('Permission denied.');
  }
  const joinReqRef = doc(db, 'classrooms', classroomId, 'joinRequests', memberUid);
  const joinReqSnap = await getDoc(joinReqRef);
  if (!joinReqSnap.exists()) throw new Error('No join request found.');
  const reqData = joinReqSnap.data();
  await setDoc(doc(db, 'classrooms', classroomId, 'members', memberUid), {
    uid: memberUid,
    displayName: reqData.displayName || reqData.studentName || 'Unknown',
    email: reqData.email || reqData.studentEmail || '',
    photoURL: reqData.photoURL || '',
    role: (reqData.role || 'student').toLowerCase(),
    joinedAt: serverTimestamp(),
    approved: true,
    approvedBy: user.uid,
    approvedAt: serverTimestamp(),
  });
  await deleteDoc(joinReqRef);
  try {
    await updateDoc(doc(db, 'classroomRequests', `${classroomId}_${memberUid}`), {
      status: 'approved',
      approvedBy: user.uid,
      approvedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  } catch (e) {
    console.warn('Could not update top-level classroomRequests:', e);
  }
  const currentCount = classroomSnap.data().memberCount || 0;
  await updateDoc(classroomRef, {
    memberCount: currentCount + 1,
    students: arrayUnion(memberUid),
    members: arrayUnion(memberUid),
    updatedAt: serverTimestamp()
  });
  await addDoc(collection(db, 'classrooms', classroomId, 'activity'), {
    type: 'member_approved',
    description: `${reqData.displayName} joined the classroom`,
    userId: memberUid,
    userName: reqData.displayName,
    timestamp: serverTimestamp(),
  });
}

export async function rejectMember(classroomId, memberUid, user) {
  try {
    await fetchWithAuth(`/api/classrooms/${classroomId}/requests/${memberUid}/reject`, {
      method: 'POST',
    });
    return;
  } catch (err) {
    console.warn('Express API rejectMember failed, falling back to Firestore:', err.message);
  }
  const db = getFirestore();
  const classroomRef = doc(db, 'classrooms', classroomId);
  const classroomSnap = await getDoc(classroomRef);
  if (!classroomSnap.exists()) throw new Error('Classroom not found.');
  if (classroomSnap.data().createdBy !== user.uid) {
    throw new Error('Permission denied.');
  }
  await deleteDoc(doc(db, 'classrooms', classroomId, 'joinRequests', memberUid));
  try {
    await updateDoc(doc(db, 'classroomRequests', `${classroomId}_${memberUid}`), {
      status: 'rejected',
      rejectedBy: user.uid,
      updatedAt: serverTimestamp()
    });
  } catch (e) {
    console.warn('Could not update top-level classroomRequests:', e);
  }
  await addDoc(collection(db, 'classrooms', classroomId, 'activity'), {
    type: 'join_rejected',
    description: `Join request rejected`,
    userId: user.uid,
    userName: user.displayName,
    timestamp: serverTimestamp(),
  });
}

export async function removeMember(classroomId, memberUid, user) {
  const db = getFirestore();
  const classroomRef = doc(db, 'classrooms', classroomId);
  const classroomSnap = await getDoc(classroomRef);
  if (!classroomSnap.exists()) throw new Error('Classroom not found.');
  if (classroomSnap.data().createdBy !== user.uid) {
    throw new Error('Permission denied.');
  }
  if (classroomSnap.data().createdBy === memberUid) {
    throw new Error('Cannot remove the classroom creator.');
  }
  const memberRef = doc(db, 'classrooms', classroomId, 'members', memberUid);
  const memberSnap = await getDoc(memberRef);
  if (!memberSnap.exists()) throw new Error('User is not a member.');
  const memberData = memberSnap.data();
  await deleteDoc(memberRef);
  const currentCount = classroomSnap.data().memberCount || 1;
  await updateDoc(classroomRef, { memberCount: Math.max(0, currentCount - 1), updatedAt: serverTimestamp() });
  await addDoc(collection(db, 'classrooms', classroomId, 'activity'), {
    type: 'member_removed',
    description: `${memberData.displayName || 'A member'} was removed from the classroom`,
    userId: user.uid,
    userName: user.displayName,
    timestamp: serverTimestamp(),
  });
}

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
  await updateDoc(classroomRef, { memberCount: Math.max(0, currentCount - 1), updatedAt: serverTimestamp() });
  await addDoc(collection(db, 'classrooms', classroomId, 'activity'), {
    type: 'member_left',
    description: `${user.displayName} left the classroom`,
    userId: user.uid,
    userName: user.displayName,
    timestamp: serverTimestamp(),
  });
}

export async function getClassroomMembers(classroomId) {
  const snap = await getDocs(query(collection(getFirestore(), 'classrooms', classroomId, 'members'), orderBy('joinedAt', 'asc')));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function isMember(classroomId, uid) {
  const snap = await getDoc(doc(getFirestore(), 'classrooms', classroomId, 'members', uid));
  return snap.exists();
}

export function subscribeToUserClassrooms(uid, role, callback) {
  const isTeacherRole = (role || '').toLowerCase() === 'teacher';
  const cacheKey = `user_classrooms_${uid}`;
  const db = getFirestore();

  let hasDelivered = false;

  const deliver = (list, errMessage = null) => {
    hasDelivered = true;
    try {
      localStorage.setItem(cacheKey, JSON.stringify(list));
    } catch (e) {}
    if (typeof callback === 'function') {
      callback(list, errMessage);
    }
  };

  let cached = [];
  try {
    cached = JSON.parse(localStorage.getItem(cacheKey) || '[]');
    if (Array.isArray(cached) && cached.length > 0) {
      cached.forEach(c => knownMemberClassroomIds.add(c.classroomId || c.id));
      deliver(cached);
    }
  } catch (e) {}

  fetchWithAuth('/api/classrooms')
    .then(data => {
      console.log('[ClassroomService] API /api/classrooms response:', data);
      if (Array.isArray(data)) {
        const formatted = data.map(c => ({ classroomId: c.id || c.classroomId, ...c }));
        const map = new Map();
        if (Array.isArray(cached)) {
          cached.forEach(c => map.set(c.classroomId || c.id, c));
        }
        formatted.forEach(c => map.set(c.classroomId || c.id, c));
        const mergedList = Array.from(map.values());
        mergedList.forEach(c => knownMemberClassroomIds.add(c.classroomId || c.id));
        console.log('[ClassroomService] API returned merged classroom(s):', mergedList.length);
        deliver(mergedList);
      } else if (!hasDelivered) {
        deliver(cached);
      }
    })
    .catch(err => {
      console.warn('[ClassroomService] Express API fetch classrooms failed/quota:', err.message);
      if (!hasDelivered) {
        deliver(cached);
      }
    });

  const classroomsRef = collection(db, 'classrooms');

  let fsUnsub;
  fsUnsub = safeOnSnapshot(
    classroomsRef,
    async (snapshot) => {
      console.log('[ClassroomService] Firestore snapshot fired. Total docs:', snapshot.docs.length);
      try {
        const authUser = getAuth().currentUser;
        const authUid = authUser?.uid || '';
        const authEmail = (authUser?.email || '').toLowerCase();
        const profile = window.currentUserProfile || {};
        const profileUid = profile.uid || '';
        const profileEmail = (profile.email || '').toLowerCase();

        const targetUids = new Set([uid, authUid, profileUid].filter(Boolean));
        const targetEmails = new Set([authEmail, profileEmail].filter(Boolean));

        const userClassrooms = [];
        for (const d of snapshot.docs) {
          const data = d.data();
          if (data.isDeleted === true || data.isActive === false) continue;

          let isMatch = false;

          for (const uId of targetUids) {
            if (data.createdBy === uId || data.teacherId === uId || data.teacherUid === uId || data.ownerId === uId) {
              isMatch = true;
              break;
            }
            if (Array.isArray(data.enrolledStudents) && data.enrolledStudents.includes(uId)) {
              isMatch = true;
              break;
            }
            if (Array.isArray(data.members) && data.members.includes(uId)) {
              isMatch = true;
              break;
            }
          }

          if (!isMatch && (data.teacherEmail || data.createdEmail)) {
            const e1 = String(data.teacherEmail || '').toLowerCase();
            const e2 = String(data.createdEmail || '').toLowerCase();
            if ((e1 && targetEmails.has(e1)) || (e2 && targetEmails.has(e2))) {
              isMatch = true;
            }
          }

          if (!isMatch && knownMemberClassroomIds.has(d.id)) {
            isMatch = true;
          }

          if (isMatch) {
            knownMemberClassroomIds.add(d.id);
            userClassrooms.push({ classroomId: d.id, ...data });
          }
        }

        // Merge with locally cached classrooms so newly created items are never lost
        try {
          const cached = JSON.parse(localStorage.getItem(cacheKey) || '[]');
          if (Array.isArray(cached)) {
            cached.forEach(c => {
              if (!userClassrooms.some(existing => existing.classroomId === c.classroomId)) {
                userClassrooms.push(c);
              }
            });
          }
        } catch (e) {}

        userClassrooms.sort((a, b) => {
          const ta = a.createdAt?.seconds || (a.createdDate ? new Date(a.createdDate).getTime() : 0);
          const tb = b.createdAt?.seconds || (b.createdDate ? new Date(b.createdDate).getTime() : 0);
          return tb - ta;
        });

        console.log('[ClassroomService] Firestore matched classrooms:', userClassrooms.length);
        deliver(userClassrooms);
      } catch (error) {
        console.warn('Firestore subscription process error:', error.message);
        try {
          const cached = JSON.parse(localStorage.getItem(cacheKey) || '[]');
          deliver(cached);
        } catch (e) {
          deliver([]);
        }
      }
    },
    (error) => {
      console.warn('Firestore subscription error (serving cached classrooms):', error.message);
      try {
        const cached = JSON.parse(localStorage.getItem(cacheKey) || '[]');
        deliver(cached);
      } catch (e) {
        deliver([]);
      }
    },
    'subscribeToUserClassrooms'
  );

  const safetyTimer = setTimeout(() => {
    if (!hasDelivered) {
      try {
        const cached = JSON.parse(localStorage.getItem(cacheKey) || '[]');
        deliver(cached);
      } catch (e) {
        deliver([], 'Loading your classrooms timed out. Please refresh the page.');
      }
    }
  }, 4000);

  return () => {
    clearTimeout(safetyTimer);
    if (typeof fsUnsub === 'function') fsUnsub();
  };
}

export function subscribeToClassroomMembers(classroomId, callback = () => {}) {
  if (!classroomId) {
    if (typeof callback === 'function') callback([]);
    return () => {};
  }
  const db = getFirestore();
  
  const deliverMergedMembers = async (subcollDocs = []) => {
    const memberMap = new Map();

    // 1. Add subcollection members
    subcollDocs.forEach(d => {
      const data = d.data ? d.data() : d;
      const mUid = d.id || data.uid || data.userId;
      if (mUid) {
        memberMap.set(mUid, { id: mUid, uid: mUid, ...data });
      }
    });

    // 2. Fetch classroom doc to get teacher & enrolledStudents/members arrays
    try {
      const classSnap = await getDoc(doc(db, 'classrooms', classroomId));
      if (classSnap.exists()) {
        const cData = classSnap.data();
        
        // Add teacher
        const tUid = cData.createdBy || cData.teacherId || cData.teacherUid;
        if (tUid) {
          const existingT = memberMap.get(tUid) || {};
          memberMap.set(tUid, {
            id: tUid,
            uid: tUid,
            displayName: cData.teacherName || existingT.displayName || 'Teacher',
            email: cData.teacherEmail || existingT.email || '',
            photoURL: cData.teacherPhotoURL || existingT.photoURL || '',
            role: 'teacher',
            approved: true
          });
        }

        // Add enrolled students
        const studentUids = Array.from(new Set([
          ...(Array.isArray(cData.enrolledStudents) ? cData.enrolledStudents : []),
          ...(Array.isArray(cData.students) ? cData.students : []),
          ...(Array.isArray(cData.members) ? cData.members : []),
        ]));

        for (const sUid of studentUids) {
          if (!memberMap.has(sUid)) {
            let uName = sUid === tUid ? (cData.teacherName || 'Teacher') : 'Enrolled Student';
            let uEmail = sUid === tUid ? (cData.teacherEmail || '') : '';
            let uPhoto = sUid === tUid ? (cData.teacherPhotoURL || '') : '';
            try {
              const uSnap = await getDoc(doc(db, 'users', sUid));
              if (uSnap.exists()) {
                const uData = uSnap.data();
                uName = uData.displayName || uData.name || uName;
                uEmail = uData.email || uEmail;
                uPhoto = uData.photoURL || uPhoto;
              }
            } catch (e) {}

            memberMap.set(sUid, {
              id: sUid,
              uid: sUid,
              displayName: uName,
              email: uEmail,
              photoURL: uPhoto,
              role: sUid === tUid ? 'teacher' : 'student',
              approved: true
            });
          }
        }
      }
    } catch (e) {
      console.warn('[ClassroomMembers] Error fetching classroom doc fallback:', e);
    }

    // 3. Deliver list
    const finalList = Array.from(memberMap.values());
    if (typeof callback === 'function') {
      callback(finalList);
    }
  };

  // Run immediate fetch on call
  deliverMergedMembers([]);

  return onSnapshot(
    collection(db, 'classrooms', classroomId, 'members'),
    (snap) => {
      deliverMergedMembers(snap.docs);
    },
    (err) => {
      console.warn('[ClassroomService] subscribeToClassroomMembers fallback:', err);
      deliverMergedMembers([]);
    }
  );
}

export function subscribeToJoinRequests(classroomId, callback = () => {}) {
  return safeOnSnapshot(
    query(collection(getFirestore(), 'classrooms', classroomId, 'joinRequests'), orderBy('requestedAt', 'desc')),
    (snap) => callback(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    (err) => console.warn('[ClassroomService] subscribeToJoinRequests quota warning:', err),
    'subscribeToJoinRequests'
  );
}

export function subscribeToClassroomRequests(callback = () => {}, statusFilter = null) {
  const db = getFirestore();
  const baseQuery = collection(db, 'classroomRequests');
  const q = statusFilter ? query(baseQuery, where('status', '==', statusFilter)) : query(baseQuery);
  return safeOnSnapshot(
    q,
    (snap) => {
      console.log('[Approvals] classroomRequests snapshot fired. Docs:', snap.size);
      callback(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    },
    (err) => {
      console.warn('subscribeToClassroomRequests error:', err);
      callback([]);
    },
    'subscribeToClassroomRequests'
  );
}

export function subscribeToClassroomStats(classroomId, callback = () => {}) {
  const db = getFirestore();
  const unsubs = [];
  const stats = { members: 0, assignments: 0, quizzes: 0, notes: 0, notices: 0 };
  unsubs.push(safeOnSnapshot(doc(db, 'classrooms', classroomId), (snap) => {
    if (snap.exists()) {
      stats.members = snap.data().memberCount || 0;
      callback({ ...stats });
    }
  }, null, 'subscribeToClassroomStats.doc'));
  unsubs.push(safeOnSnapshot(query(collection(db, 'classrooms', classroomId, 'assignments')), (snap) => {
    stats.assignments = snap.size;
    callback({ ...stats });
  }, null, 'subscribeToClassroomStats.assignments'));
  unsubs.push(safeOnSnapshot(query(collection(db, 'classrooms', classroomId, 'quizzes')), (snap) => {
    stats.quizzes = snap.size;
    callback({ ...stats });
  }, null, 'subscribeToClassroomStats.quizzes'));
  unsubs.push(safeOnSnapshot(query(collection(db, 'classrooms', classroomId, 'notes')), (snap) => {
    stats.notes = snap.size;
    callback({ ...stats });
  }, null, 'subscribeToClassroomStats.notes'));
  unsubs.push(safeOnSnapshot(query(collection(db, 'classrooms', classroomId, 'notices')), (snap) => {
    stats.notices = snap.size;
    callback({ ...stats });
  }, null, 'subscribeToClassroomStats.notices'));
  return () => unsubs.forEach(u => u());
}

export function subscribeToClassroomActivity(classroomId, callback = () => {}) {
  return safeOnSnapshot(
    query(collection(getFirestore(), 'classrooms', classroomId, 'activity'), orderBy('timestamp', 'desc'), limit(50)),
    (snap) => callback(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    (err) => console.warn('[ClassroomService] subscribeToClassroomActivity quota warning:', err),
    'subscribeToClassroomActivity'
  );
}

export async function addActivity(classroomId, type, description, user) {
  if (!classroomId) return;
  try {
    await addDoc(collection(getFirestore(), 'classrooms', classroomId, 'activity'), {
      type, description, userId: user.uid, userName: user.displayName || 'Unknown', timestamp: serverTimestamp(),
    });
  } catch (e) {
    if (isQuotaExceededError(e)) {
      console.warn('Could not add activity (quota exceeded):', e.message);
    } else {
      console.warn('Could not add activity:', e);
    }
  }
}