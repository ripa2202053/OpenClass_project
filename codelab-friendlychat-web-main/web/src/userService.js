import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  query,
  where,
  orderBy,
  serverTimestamp
} from 'firebase/firestore';
import {
  getStorage,
  ref,
  uploadBytesResumable,
  getDownloadURL
} from 'firebase/storage';
import { getAuth, updateProfile as updateAuthProfile } from 'firebase/auth';

/**
 * Creates or fetches a user document in Firestore on login.
 * If user doc doesn't exist, initializes default fields.
 * Students get status:"pending", Teachers get status:"approved".
 * If doc exists, returns existing user data without overwriting.
 */
export async function createUser(user) {
  if (!user || !user.uid) return null;
  const db = getFirestore();
  const userRef = doc(db, 'users', user.uid);
  
  try {
    const docSnap = await getDoc(userRef);
    if (!docSnap.exists()) {
      // Default role is Student with pending status
      const role = 'Student';
      const newUser = {
        uid: user.uid,
        displayName: user.displayName || 'OpenClass User',
        email: user.email || '',
        photoURL: user.photoURL || '',
        role: role,
        status: 'pending', // Students start as pending
        department: 'Computer Science',
        studentId: '',
        teacherId: '',
        semester: 'Semester 1',
        phone: '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        isActive: true
      };
      await setDoc(userRef, newUser);
      return { ...newUser, createdAt: new Date(), updatedAt: new Date() };
    } else {
      return docSnap.data();
    }
  } catch (error) {
    console.error('Error in createUser:', error);
    throw error;
  }
}

/**
 * Creates a user with a specific role chosen during registration.
 * Teachers are auto-approved, Students start as pending.
 */
export async function createUserWithRole(user, role) {
  if (!user || !user.uid) return null;
  const db = getFirestore();
  const userRef = doc(db, 'users', user.uid);

  try {
    const docSnap = await getDoc(userRef);
    if (!docSnap.exists()) {
      const status = role === 'Teacher' ? 'approved' : 'pending';
      const newUser = {
        uid: user.uid,
        displayName: user.displayName || 'OpenClass User',
        email: user.email || '',
        photoURL: user.photoURL || '',
        role: role,
        status: status,
        department: '',
        studentId: '',
        teacherId: '',
        semester: '',
        phone: '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        isActive: true
      };
      await setDoc(userRef, newUser);
      return { ...newUser, createdAt: new Date(), updatedAt: new Date() };
    } else {
      return docSnap.data();
    }
  } catch (error) {
    console.error('Error in createUserWithRole:', error);
    throw error;
  }
}

/**
 * Get all students (for Teacher management panel).
 */
export async function getAllStudents() {
  const db = getFirestore();
  const q = query(
    collection(db, 'users'),
    where('role', '==', 'Student'),
    orderBy('createdAt', 'desc')
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ uid: d.id, ...d.data() }));
}

/**
 * Approve a student's registration.
 */
export async function approveStudent(uid) {
  const db = getFirestore();
  await updateDoc(doc(db, 'users', uid), {
    status: 'approved',
    updatedAt: serverTimestamp()
  });
}

/**
 * Reject a student's registration.
 */
export async function rejectStudent(uid) {
  const db = getFirestore();
  await updateDoc(doc(db, 'users', uid), {
    status: 'rejected',
    updatedAt: serverTimestamp()
  });
}

/**
 * Fetches user profile data from Firestore.
 */
export async function getUser(uid) {
  if (!uid) return null;
  const db = getFirestore();
  const userRef = doc(db, 'users', uid);
  try {
    const docSnap = await getDoc(userRef);
    if (docSnap.exists()) {
      return docSnap.data();
    }
    return null;
  } catch (error) {
    console.error('Error fetching user:', error);
    return null;
  }
}

/**
 * Updates specific fields in user's Firestore document.
 */
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

/**
 * Updates full user profile including optional photo upload.
 */
export async function updateProfile(uid, profileData, imageFile = null) {
  if (!uid) return null;
  
  let newPhotoURL = profileData.photoURL || '';

  // 1. Upload photo if provided
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

  // 2. Update Auth profile if photoURL or displayName changed
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

  // 3. Update Firestore document
  return await updateUser(uid, {
    ...profileData,
    photoURL: newPhotoURL
  });
}
