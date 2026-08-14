import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  serverTimestamp,
  collection,
  onSnapshot,
  getDocs
} from 'firebase/firestore';
import {
  getStorage,
  ref,
  uploadBytesResumable,
  getDownloadURL
} from 'firebase/storage';
import { getAuth, updateProfile as updateAuthProfile } from 'firebase/auth';

export const ROLES = { TEACHER: 'teacher', STUDENT: 'student' };

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Storage operation timed out')), ms)
    )
  ]);
}

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

// Account-level approval is removed: students get immediate access when they
// sign up. Classroom membership is gated per-classroom via join requests.
export function isApproved(profile) {
  if (!profile) return false;
  if (isTeacher(profile)) return true;
  if (profile.status === 'rejected') return false;
  return true;
}

export function isPending(profile) {
  return false;
}

/**
 * Ensures every student account carries explicit approval flags so legacy
 * accounts never get stuck in a "pending" state. Students missing a `status`
 * default to 'approved' (immediate access). Returns a NEW object when changes
 * are needed (so callers can detect and persist them), otherwise the original
 * reference.
 */
function normalizeApprovalFlags(data) {
  if (!data || !data.role) return data;
  if (normalizeRole(data.role) !== ROLES.STUDENT) return data;
  const next = { ...data };
  let changed = false;
  if (next.status === undefined) {
    next.status = 'approved';
    changed = true;
  }
  if (next.isApproved === undefined) {
    next.isApproved = true;
    changed = true;
  }
  if (next.status === 'pending') {
    next.status = 'approved';
    changed = true;
  }
  if (next.isApproved === false) {
    next.isApproved = true;
    changed = true;
  }
  return changed ? next : data;
}

async function persistApprovalFlags(userRef, data) {
  try {
    await updateDoc(userRef, {
      status: data.status,
      isApproved: data.isApproved,
      updatedAt: serverTimestamp()
    });
  } catch (e) {
    console.warn('Could not persist approval flags:', e);
  }
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

export function isLocalhost() {
  if (typeof window === 'undefined') return false;
  const hostname = window.location.hostname || '';
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('192.168.');
}

export function getInitialsSvgDataUrl(profile) {
  const name = (profile && (profile.displayName || profile.name)) || 'User';
  const initials = name.trim().split(/\s+/).map(w => w.charAt(0)).slice(0, 2).join('').toUpperCase() || 'U';
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180">' +
    '<rect width="100%" height="100%" fill="#2563eb"/>' +
    '<text x="50%" y="50%" dy=".35em" fill="#ffffff" font-family="Arial, Helvetica, sans-serif" ' +
    'font-size="64" text-anchor="middle" font-weight="600">' + initials + '</text></svg>';
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

/**
 * Returns a render-safe avatar URL. On localhost (no Storage CORS rules),
 * Firebase Storage URLs are never fetched — they are replaced immediately
 * with an inline initials-SVG data URL to avoid CORS errors / broken images.
 */
export function sanitizeProfilePhotoUrl(photoURL, profile) {
  if (!photoURL) return '';
  if (typeof photoURL === 'string' && photoURL.startsWith('data:')) return photoURL;
  if (
    isLocalhost() &&
    typeof photoURL === 'string' &&
    photoURL.startsWith('https://firebasestorage.googleapis.com')
  ) {
    console.log('[userService] Localhost detected: skipping Firebase Storage fetch for photoURL. Using initials fallback.');
    return getInitialsSvgDataUrl(profile);
  }
  return photoURL;
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
      session: isNewStudent ? (extraData.session || '') : '',
      designation: !isNewStudent ? (extraData.designation || '') : '',
      officeRoom: !isNewStudent ? (extraData.officeRoom || '') : '',
      status: 'approved',
      isApproved: true,
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
      const fullProfile = { ...data, role: normalizedRole };
      saveProfileToStorage(fullProfile);
      return fullProfile;
    }
  } catch (error) {
    console.warn('[userService] Error/quota fetching user from Firestore, attempting storage fallback:', error.message || error);
  }

  const cached = getProfileFromStorage(uid);
  if (cached) {
    console.log('[userService] Serving cached profile from localStorage for uid:', uid);
    return cached;
  }
  return null;
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
    await setDoc(userRef, updatePayload, { merge: true });
    return await getUser(uid);
  } catch (error) {
    console.error('Error updating user document:', error);
    throw error;
  }
}

export async function updateProfile(uid, profileData, imageFile = null, fallbackDataUrl = null) {
  if (!uid) return null;

  let newPhotoURL = profileData.photoURL || '';
  let photoUploadSkipped = false;

  // 1) Isolate the optional storage upload so CORS/network/permission failures
  //    can NEVER abort or block the Firestore text update below. A timeout also
  //    guarantees a hung Storage request cannot stall the setDoc() write.
  if (imageFile) {
    try {
      const storage = getStorage();
      const storageRef = ref(storage, `profile_pics/${uid}/${Date.now()}_${imageFile.name}`);
      await withTimeout(uploadBytesResumable(storageRef, imageFile), 10000);
      newPhotoURL = await withTimeout(getDownloadURL(storageRef), 10000);
    } catch (uploadError) {
      console.warn('Storage upload failed, keeping existing photoURL:', uploadError);
      photoUploadSkipped = true;
      // CORS/network blocked? Persist the pre-prepared Base64 data URL instead,
      // so the avatar change is still saved without Storage access.
      if (fallbackDataUrl) {
        newPhotoURL = fallbackDataUrl;
      }
    }
  }

  // 2) Preserve the existing photoURL when no new photo was uploaded/provided,
  //    so a CORS/skip path never wipes the user's avatar.
  if (!newPhotoURL) {
    try {
      const db = getFirestore();
      const existingSnap = await getDoc(doc(db, 'users', uid));
      if (existingSnap.exists()) {
        newPhotoURL = existingSnap.data().photoURL || '';
      }
    } catch (readError) {
      console.warn('Could not read existing photoURL:', readError);
    }
    newPhotoURL = newPhotoURL || profileData.photoURL || '';
  }
  profileData.photoURL = newPhotoURL;

  // 3) Update Firebase Auth profile displayName/photoURL (best-effort only).
  //    Skip photoURL when it's a Base64 data URL — auth profiles are not suited
  //    to storing large inline images.
  const auth = getAuth();
  if (auth.currentUser && auth.currentUser.uid === uid) {
    try {
      const authPayload = { displayName: profileData.displayName || undefined };
      if (newPhotoURL && !newPhotoURL.startsWith('data:')) {
        authPayload.photoURL = newPhotoURL;
      }
      await updateAuthProfile(auth.currentUser, authPayload);
    } catch (authError) {
      console.warn('Could not update Firebase Auth profile:', authError);
    }
  }

  // 4) Guaranteed Firestore merge write of the text fields + photoURL —
  //    always executed regardless of upload outcome.
  const savedUser = await updateUser(uid, {
    ...profileData,
    photoURL: newPhotoURL
  });

  if (savedUser && photoUploadSkipped) {
    savedUser._photoUploadSkipped = true;
  }
  return savedUser;
}

import { safeOnSnapshot, isQuotaExceededError } from './utils/firestoreGuard.js';

export function subscribeAllUsers(callback) {
  const db = getFirestore();
  const colRef = collection(db, 'users');

  const unsub = safeOnSnapshot(
    colRef,
    (snap) => {
      const users = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
      callback(users);
    },
    async (err) => {
      if (isQuotaExceededError(err)) {
        console.warn('subscribeAllUsers quota exceeded:', err.message);
        return;
      }
      console.warn('subscribeAllUsers snapshot error, attempting fallback getDocs:', err);
      try {
        const snap = await getDocs(colRef);
        const users = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
        callback(users);
      } catch (fallbackErr) {
        console.error('Failed to fetch users fallback:', fallbackErr);
        callback([]);
      }
    },
    'subscribeAllUsers'
  );

  return unsub;
}
