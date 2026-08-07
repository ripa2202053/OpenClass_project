import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  serverTimestamp
} from 'firebase/firestore';
import {
  getStorage,
  ref,
  uploadBytesResumable,
  getDownloadURL
} from 'firebase/storage';
import { getAuth, updateProfile as updateAuthProfile } from 'firebase/auth';

export const ROLES = { TEACHER: 'teacher', STUDENT: 'student' };

export function normalizeRole(role) {
  if (!role) return '';
  const normalized = String(role).toLowerCase();
  return (normalized === ROLES.TEACHER || normalized === ROLES.STUDENT) ? normalized : '';
}

export function isValidRole(role) {
  return normalizeRole(role) !== '';
}

export function isTeacher(profile) {
  return profile && normalizeRole(profile.role) === ROLES.TEACHER;
}

export function isStudent(profile) {
  return profile && normalizeRole(profile.role) === ROLES.STUDENT;
}

export function isApproved(profile) {
  if (!profile) return false;
  if (isTeacher(profile)) return true;
  return profile.status === 'approved';
}

export function isPending(profile) {
  return profile && isStudent(profile) && profile.status === 'pending';
}

export function requireRole(profile, role) {
  if (!profile) return false;
  const normalized = normalizeRole(role);
  if (normalized === ROLES.TEACHER) return isTeacher(profile);
  if (normalized === ROLES.STUDENT) return isStudent(profile);
  return normalizeRole(profile.role) === normalized;
}

export function displayRole(role) {
  const normalized = normalizeRole(role);
  if (normalized === ROLES.TEACHER) return 'Teacher';
  if (normalized === ROLES.STUDENT) return 'Student';
  return role || '';
}

const PROFILE_STORAGE_PREFIX = 'openclass_profile_';

export function saveProfileToStorage(profile) {
  if (!profile || !profile.uid) return;
  try {
    localStorage.setItem(PROFILE_STORAGE_PREFIX + profile.uid, JSON.stringify(profile));
  } catch (e) { /* ignore */ }
}

export function getProfileFromStorage(uid) {
  if (!uid) return null;
  try {
    const raw = localStorage.getItem(PROFILE_STORAGE_PREFIX + uid);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

export function clearProfileFromStorage(uid) {
  if (!uid) return;
  try {
    localStorage.removeItem(PROFILE_STORAGE_PREFIX + uid);
  } catch (e) { /* ignore */ }
}

export async function createUser(user, selectedRole, extraData = {}) {
  if (!user || !user.uid) return null;
  const db = getFirestore();
  const userRef = doc(db, 'users', user.uid);

  try {
    const docSnap = await getDoc(userRef);
    if (docSnap.exists()) {
      const data = docSnap.data();
      const storedRole = data.role;
      const normalizedRole = normalizeRole(storedRole) || storedRole;
      // Migrate legacy uppercase roles to lowercase and persist.
      if (storedRole && storedRole !== normalizedRole && isValidRole(normalizedRole)) {
        try {
          await updateDoc(userRef, { role: normalizedRole, updatedAt: serverTimestamp() });
        } catch (e) {
          console.warn('Could not persist role migration for', user.uid, e);
        }
      }
      return { ...data, role: normalizedRole };
    }
    const role = normalizeRole(selectedRole);
    if (!role) {
      console.error('Cannot create user: no valid role provided for new user');
      return null;
    }
    const isNewStudent = role === ROLES.STUDENT;
    const newUser = {
      uid: user.uid,
      displayName: extraData.displayName || user.displayName || 'OpenClass User',
      email: user.email || '',
      photoURL: user.photoURL || '',
      role: role,
      department: extraData.department || '',
      studentId: isNewStudent ? (extraData.studentId || '') : '',
      teacherId: !isNewStudent ? (extraData.teacherId || '') : '',
      semester: isNewStudent ? (extraData.semester || '') : '',
      designation: !isNewStudent ? (extraData.designation || '') : '',
      status: isNewStudent ? 'pending' : 'approved',
      phone: extraData.phone || '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      isActive: true
    };
    await setDoc(userRef, newUser);
    return { ...newUser, createdAt: new Date(), updatedAt: new Date() };
  } catch (error) {
    console.error('Error in createUser:', error);
    throw error;
  }
}

export async function getUser(uid) {
  if (!uid) return null;
  const db = getFirestore();
  const userRef = doc(db, 'users', uid);
  try {
    const docSnap = await getDoc(userRef);
    if (docSnap.exists()) {
      const data = docSnap.data();
      const storedRole = data.role;
      const normalizedRole = normalizeRole(storedRole) || storedRole;
      // Migrate legacy uppercase roles (Teacher/Student) to lowercase and
      // PERSIST the corrected value back to Firestore.
      if (storedRole && storedRole !== normalizedRole && isValidRole(normalizedRole)) {
        try {
          await updateDoc(userRef, { role: normalizedRole, updatedAt: serverTimestamp() });
        } catch (e) {
          console.warn('Could not persist role migration for', uid, e);
        }
      }
      return { ...data, role: normalizedRole };
    }
    return null;
  } catch (error) {
    console.error('Error fetching user:', error);
    return null;
  }
}

export async function updateUser(uid, data) {
  if (!uid) return null;
  const db = getFirestore();
  const userRef = doc(db, 'users', uid);
  try {
    const updatePayload = {
      ...data,
      updatedAt: serverTimestamp()
    };
    await updateDoc(userRef, updatePayload);
    return await getUser(uid);
  } catch (error) {
    console.error('Error updating user document:', error);
    throw error;
  }
}

export async function updateProfile(uid, profileData, imageFile = null) {
  if (!uid) return null;

  let newPhotoURL = profileData.photoURL || '';

  if (imageFile) {
    try {
      const storage = getStorage();
      const storageRef = ref(storage, `profile_pics/${uid}/${Date.now()}_${imageFile.name}`);
      await uploadBytesResumable(storageRef, imageFile);
      newPhotoURL = await getDownloadURL(storageRef);
      profileData.photoURL = newPhotoURL;
    } catch (uploadError) {
      console.error('Error uploading profile picture:', uploadError);
    }
  }

  const auth = getAuth();
  if (auth.currentUser && auth.currentUser.uid === uid) {
    try {
      await updateAuthProfile(auth.currentUser, {
        displayName: profileData.displayName,
        photoURL: newPhotoURL
      });
    } catch (authError) {
      console.warn('Could not update Firebase Auth profile:', authError);
    }
  }

  return await updateUser(uid, {
    ...profileData,
    photoURL: newPhotoURL
  });
}

export function subscribeAllUsers(callback) {
  const db = getFirestore();
  const colRef = collection(db, 'users');

  const unsub = onSnapshot(
    colRef,
    (snap) => {
      const users = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
      callback(users);
    },
    async (err) => {
      console.warn('subscribeAllUsers snapshot error, attempting fallback getDocs:', err);
      try {
        const snap = await getDocs(colRef);
        const users = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
        callback(users);
      } catch (fallbackErr) {
        console.error('Failed to fetch users fallback:', fallbackErr);
        callback([]);
      }
    }
  );

  return unsub;
}
