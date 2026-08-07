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
} from 'firebase/firestore';
import { getStorage, ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { fetchWithAuth } from './utils/api.js';

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
  blue: { id: 'blue', name: 'Science Blue', gradient: 'linear-gradient(135deg, #1e3c72 0%, #2a5298 100%)', bg: '#1e3c72' },
  purple: { id: 'purple', name: 'Math Purple', gradient: 'linear-gradient(135deg, #614385 0%, #516395 100%)', bg: '#614385' },
  teal: { id: 'teal', name: 'English Teal', gradient: 'linear-gradient(135deg, #11998e 0%, #38ef7d 100%)', bg: '#11998e' },
  amber: { id: 'amber', name: 'Arts Amber', gradient: 'linear-gradient(135deg, #f857a6 0%, #ff5858 100%)', bg: '#f857a6' },
  indigo: { id: 'indigo', name: 'Tech Indigo', gradient: 'linear-gradient(135deg, #4776E6 0%, #8E54E9 100%)', bg: '#4776E6' },
};

export function getThemeGradient(themeId) {
  return (CLASSROOM_THEMES[themeId] || CLASSROOM_THEMES.blue).gradient;
}

export function generateInviteLink(classroomCode) {
  const origin = window.location.origin || 'http://localhost:5173';
  return `${origin}/?join=${classroomCode}`;
}

export async function createClassroom(data, user) {
  if (!data.classroomName || !data.classroomName.trim()) {
    throw new Error('Classroom name cannot be empty.');
  }
  if ((user.role || '').toLowerCase() !== 'teacher') {
    throw new Error('Only Teachers can create classrooms.');
  }

  const themeColor = data.themeColor || 'blue';
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
        section: data.section,
        subject: data.subject,
        room: data.room,
        themeColor,
        coverImageUrl,
      }),
    });
    if (res && res.id) {
      return { classroomId: res.id, ...res };
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
    section: data.section ? data.section.trim() : '',
    subject: data.subject ? data.subject.trim() : '',
    room: data.room ? data.room.trim() : '',
    themeColor,
    coverImageUrl,
    createdBy: user.uid,
    teacherId: user.uid,
    teacherName: user.displayName || user.name || 'Teacher',
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

  return { classroomId: docRef.id, ...classroom };
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
        section: data.section,
        subject: data.subject,
        room: data.room,
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
    section: data.section ? data.section.trim() : '',
    subject: data.subject ? data.subject.trim() : '',
    room: data.room ? data.room.trim() : '',
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
  return { 
    valid: true, 
    classroomId: classroomDoc.id, 
    teacherId: classroomDoc.data().teacherId,
    classroomCode: classroomDoc.data().classroomCode,
    classroomName: classroomDoc.data().classroomName
  };
}

export async function joinClassroomByCode(code, user) {
  if (!code || !code.trim()) throw new Error('Please enter a classroom code.');
  try {
    const res = await fetchWithAuth('/api/classrooms/join', {
      method: 'POST',
      body: JSON.stringify({ code: code.trim() }),
    });
    if (res && res.classId) {
      return {
        classroomId: res.classId,
        joinStatus: res.status === 'pending' ? 'pending' : 'approved',
        ...res,
      };
    }
  } catch (err) {
    console.warn('Express API joinClassroom failed, falling back to Firestore:', err.message);
  }
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
  const memberRef = doc(db, 'classrooms', classroomId, 'members', user.uid);
  const memberSnap = await getDoc(memberRef);
  if (memberSnap.exists()) throw new Error('You have already joined this classroom.');
  const joinReqRef = doc(db, 'classrooms', classroomId, 'joinRequests', user.uid);
  const joinReqSnap = await getDoc(joinReqRef);
  if (joinReqSnap.exists() && joinReqSnap.data().status === 'pending') {
    throw new Error('You already have a pending join request for this classroom.');
  }
  await setDoc(joinReqRef, {
    uid: user.uid,
    displayName: user.displayName || 'Unknown',
    email: user.email || '',
    photoURL: user.photoURL || '',
    role: user.role,
    requestedAt: serverTimestamp(),
    status: 'pending',
  });
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
    where('status', '==', 'pending'),
    orderBy('requestedAt', 'desc')
  ));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
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
    displayName: reqData.displayName,
    email: reqData.email || '',
    photoURL: reqData.photoURL || '',
    role: (reqData.role || 'student').toLowerCase(),
    joinedAt: serverTimestamp(),
    approved: true,
    approvedBy: user.uid,
    approvedAt: serverTimestamp(),
  });
  await deleteDoc(joinReqRef);
  const currentCount = classroomSnap.data().memberCount || 0;
  await updateDoc(classroomRef, { memberCount: currentCount + 1, updatedAt: serverTimestamp() });
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

export function subscribeToUserClassrooms(uid, userRole, callback) {
  const db = getFirestore();
  const isTeacherRole = (userRole || '').toLowerCase() === 'teacher';

  let delivered = false;
  const deliver = (classrooms, errorMsg) => {
    delivered = true;
    try {
      callback(classrooms, errorMsg);
    } catch (err) {
      console.warn('Classrooms callback error:', err);
    }
  };

  fetchWithAuth('/api/classrooms')
    .then(data => {
      if (Array.isArray(data)) {
        const formatted = data.map(c => ({ classroomId: c.id || c.classroomId, ...c }));
        deliver(formatted);
      }
    })
    .catch(err => {
      console.warn('Express API fetch classrooms failed, relying on Firestore:', err.message);
    });

  const classroomsRef = collection(db, 'classrooms');
  const FIREBASE_UNAVAILABLE_MSG = 'Could not load your classrooms. Please check your connection and try again.';

  let fsUnsub;
  if (isTeacherRole) {
    fsUnsub = onSnapshot(
      query(classroomsRef, where('createdBy', '==', uid), where('isActive', '==', true)),
      (snapshot) => {
        const userClassrooms = snapshot.docs.map(d => ({ classroomId: d.id, ...d.data() }));
        userClassrooms.sort((a, b) => {
          const ta = a.createdAt?.seconds || (a.createdDate ? new Date(a.createdDate).getTime() : 0);
          const tb = b.createdAt?.seconds || (b.createdDate ? new Date(b.createdDate).getTime() : 0);
          return tb - ta;
        });
        deliver(userClassrooms);
      },
      (error) => {
        console.warn('Firestore subscription error for teacher classrooms:', error.message);
        deliver([], FIREBASE_UNAVAILABLE_MSG);
      }
    );
  } else {
    fsUnsub = onSnapshot(
      query(classroomsRef, where('isActive', '==', true)),
      async (snapshot) => {
        try {
          const userClassrooms = [];
          const promises = snapshot.docs.map(async (d) => {
            const data = d.data();
            if (data.createdBy === uid || (Array.isArray(data.members) && data.members.includes(uid))) {
              userClassrooms.push({ classroomId: d.id, ...data });
              return;
            }
            try {
              const memberSnap = await getDoc(doc(db, 'classrooms', d.id, 'members', uid));
              if (memberSnap.exists() && memberSnap.data().approved === true) {
                userClassrooms.push({ classroomId: d.id, ...data });
              }
            } catch (e) {}
          });
          await Promise.all(promises);

          // Safely query pending join requests without crashing on missing collectionGroup index
          const joinedIds = new Set(userClassrooms.map(c => c.classroomId));
          try {
            const pendingSnap = await getDocs(query(
              collectionGroup(db, 'joinRequests'),
              where('uid', '==', uid)
            ));
            const pendingClassroomIds = new Set();
            pendingSnap.docs.forEach(d => {
              if (d.data().status === 'pending') {
                const requestClassroomId = d.ref.path.split('/')[1];
                if (requestClassroomId && !joinedIds.has(requestClassroomId)) {
                  pendingClassroomIds.add(requestClassroomId);
                }
              }
            });
            if (pendingClassroomIds.size > 0) {
              const pendingClassrooms = [];
              const pendingPromises = [...pendingClassroomIds].map(async (cid) => {
                const cSnap = await getDoc(doc(db, 'classrooms', cid));
                if (cSnap.exists()) {
                  pendingClassrooms.push({ classroomId: cSnap.id, ...cSnap.data(), joinStatus: 'pending' });
                }
              });
              await Promise.all(pendingPromises);
              userClassrooms.push(...pendingClassrooms);
            }
          } catch (pendingErr) {
            console.warn('collectionGroup query failed (index missing), skipping pending requests:', pendingErr.message);
          }

          // Fallback to local storage cached joined classrooms for student
          try {
            const cacheKey = `openclass_joined_${uid}`;
            const cached = JSON.parse(localStorage.getItem(cacheKey) || '[]');
            cached.forEach(c => {
              if (!userClassrooms.some(existing => existing.classroomId === c.classroomId)) {
                userClassrooms.push(c);
              }
            });
          } catch (e) {}

          deliver(userClassrooms);
        } catch (error) {
          console.warn('Firestore subscription error for student classrooms:', error.message);
          try {
            const cacheKey = `openclass_joined_${uid}`;
            const cached = JSON.parse(localStorage.getItem(cacheKey) || '[]');
            deliver(cached);
          } catch (e) {
            deliver([]);
          }
        }
      },
      (error) => {
        console.warn('Firestore subscription error for student classrooms:', error.message);
        try {
          const cacheKey = `openclass_joined_${uid}`;
          const cached = JSON.parse(localStorage.getItem(cacheKey) || '[]');
          deliver(cached);
        } catch (e) {
          deliver([]);
        }
      }
    );
  }

  const safetyTimer = setTimeout(() => {
    if (!delivered) {
      deliver([], 'Loading your classrooms timed out. Please refresh the page.');
    }
  }, 5000);

  return () => {
    clearTimeout(safetyTimer);
    fsUnsub();
  };
}

export function subscribeToClassroomMembers(classroomId, callback) {
  return onSnapshot(
    query(collection(getFirestore(), 'classrooms', classroomId, 'members'), orderBy('joinedAt', 'asc')),
    (snap) => callback(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  );
}

export function subscribeToJoinRequests(classroomId, callback) {
  return onSnapshot(
    query(collection(getFirestore(), 'classrooms', classroomId, 'joinRequests'), orderBy('requestedAt', 'desc')),
    (snap) => callback(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  );
}

export function subscribeToClassroomStats(classroomId, callback) {
  const db = getFirestore();
  const unsubs = [];
  const stats = { members: 0, assignments: 0, quizzes: 0, notes: 0, notices: 0 };
  unsubs.push(onSnapshot(doc(db, 'classrooms', classroomId), (snap) => {
    if (snap.exists()) {
      stats.members = snap.data().memberCount || 0;
      callback({ ...stats });
    }
  }));
  unsubs.push(onSnapshot(query(collection(db, 'classrooms', classroomId, 'assignments')), (snap) => {
    stats.assignments = snap.size;
    callback({ ...stats });
  }));
  unsubs.push(onSnapshot(query(collection(db, 'classrooms', classroomId, 'quizzes')), (snap) => {
    stats.quizzes = snap.size;
    callback({ ...stats });
  }));
  unsubs.push(onSnapshot(query(collection(db, 'classrooms', classroomId, 'notes')), (snap) => {
    stats.notes = snap.size;
    callback({ ...stats });
  }));
  unsubs.push(onSnapshot(query(collection(db, 'classrooms', classroomId, 'notices')), (snap) => {
    stats.notices = snap.size;
    callback({ ...stats });
  }));
  return () => unsubs.forEach(u => u());
}

export function subscribeToClassroomActivity(classroomId, callback) {
  return onSnapshot(
    query(collection(getFirestore(), 'classrooms', classroomId, 'activity'), orderBy('timestamp', 'desc'), limit(50)),
    (snap) => callback(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  );
}

export async function addActivity(classroomId, type, description, user) {
  if (!classroomId) return;
  try {
    await addDoc(collection(getFirestore(), 'classrooms', classroomId, 'activity'), {
      type, description, userId: user.uid, userName: user.displayName || 'Unknown', timestamp: serverTimestamp(),
    });
  } catch (e) {
    console.warn('Could not add activity:', e);
  }
}