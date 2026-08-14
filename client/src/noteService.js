import {
  getFirestore, collection, doc, addDoc, getDocs,
  deleteDoc, query, orderBy, onSnapshot, serverTimestamp
} from 'firebase/firestore';
import { getStorage, ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { fetchWithAuth } from './utils/api.js';

export async function uploadNote(classroomId, file, category, user) {
  const storage = getStorage();
  const filePath = `notes/${classroomId}/${Date.now()}_${file.name}`;
  const storageRef = ref(storage, filePath);
  await uploadBytesResumable(storageRef, file);
  const fileUrl = await getDownloadURL(storageRef);

  const title = file.name.replace(/\.[^/.]+$/, '');
  const fileName = file.name;
  const fileType = file.name.split('.').pop().toLowerCase();
  const fileSize = file.size;
  const noteCategory = category || 'Uncategorized';

  try {
    const res = await fetchWithAuth(`/api/classrooms/${classroomId}/notes`, {
      method: 'POST',
      body: JSON.stringify({
        title,
        fileName,
        fileUrl,
        fileType,
        fileSize,
        category: noteCategory,
      }),
    });
    if (res && res.id) return;
  } catch (err) {
    console.warn('Express API uploadNote failed, falling back to Firestore:', err.message);
  }

  const db = getFirestore();
  await addDoc(collection(db, 'classrooms', classroomId, 'notes'), {
    title,
    fileName,
    fileUrl,
    fileType,
    fileSize,
    category: noteCategory,
    uploadedBy: user.uid,
    uploadedByName: user.displayName || 'Unknown',
    createdAt: serverTimestamp(),
  });
}

export async function deleteNote(classroomId, noteId) {
  try {
    await fetchWithAuth(`/api/classrooms/${classroomId}/notes/${noteId}`, {
      method: 'DELETE',
    });
    return;
  } catch (err) {
    console.warn('Express API deleteNote failed, falling back to Firestore:', err.message);
  }
  await deleteDoc(doc(getFirestore(), 'classrooms', classroomId, 'notes', noteId));
}


import { safeOnSnapshot, isQuotaExceededError } from './utils/firestoreGuard.js';

export function subscribeNotes(classroomId, callback) {
  const db = getFirestore();
  return safeOnSnapshot(
    query(collection(db, 'classrooms', classroomId, 'notes'), orderBy('createdAt', 'desc')),
    (snap) => {
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      callback(list);
    },
    (err) => console.warn('[noteService] subscribeNotes quota warning:', err),
    'subscribeNotes'
  );
}

export function getCategories(notes) {
  const cats = new Set();
  notes.forEach(n => { if (n.category) cats.add(n.category); });
  return ['All', ...Array.from(cats)];
}

export function searchNotes(notes, query) {
  if (!query || !query.trim()) return notes;
  const q = query.toLowerCase().trim();
  return notes.filter(n =>
    (n.title && n.title.toLowerCase().includes(q)) ||
    (n.fileName && n.fileName.toLowerCase().includes(q)) ||
    (n.category && n.category.toLowerCase().includes(q))
  );
}
