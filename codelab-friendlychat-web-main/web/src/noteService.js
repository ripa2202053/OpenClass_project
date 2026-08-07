import {
  getFirestore, collection, doc, addDoc, getDocs,
  deleteDoc, query, orderBy, onSnapshot, serverTimestamp
} from 'firebase/firestore';
import { getStorage, ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';

export async function uploadNote(classroomId, file, category, user) {
  const storage = getStorage();
  const filePath = `notes/${classroomId}/${Date.now()}_${file.name}`;
  const storageRef = ref(storage, filePath);
  await uploadBytesResumable(storageRef, file);
  const fileUrl = await getDownloadURL(storageRef);
  const db = getFirestore();
  await addDoc(collection(db, 'classrooms', classroomId, 'notes'), {
    title: file.name.replace(/\.[^/.]+$/, ''),
    fileName: file.name,
    fileUrl,
    fileType: file.name.split('.').pop().toLowerCase(),
    fileSize: file.size,
    category: category || 'Uncategorized',
    uploadedBy: user.uid,
    uploadedByName: user.displayName || 'Unknown',
    createdAt: serverTimestamp(),
  });
}

export async function deleteNote(classroomId, noteId) {
  await deleteDoc(doc(getFirestore(), 'classrooms', classroomId, 'notes', noteId));
}

export function subscribeNotes(classroomId, callback) {
  const db = getFirestore();
  return onSnapshot(
    query(collection(db, 'classrooms', classroomId, 'notes'), orderBy('createdAt', 'desc')),
    (snap) => {
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      callback(list);
    }
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
