import express from 'express';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { verifyAuthToken } from '../middleware/auth.js';

const router = express.Router({ mergeParams: true });

// GET /api/classrooms/:classId/notes - Fetch notes
router.get('/', verifyAuthToken, async (req, res) => {
  try {
    const { classId } = req.params;
    const db = getFirestore();

    const snapshot = await db.collection('classrooms')
      .doc(classId)
      .collection('notes')
      .orderBy('createdAt', 'desc')
      .get();

    const notes = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    return res.json(notes);
  } catch (error) {
    console.error('Error fetching notes:', error);
    return res.status(500).json({ error: 'Failed to fetch notes', details: error.message });
  }
});

// POST /api/classrooms/:classId/notes - Create note
router.post('/', verifyAuthToken, async (req, res) => {
  try {
    const { classId } = req.params;
    const { title, fileName, fileUrl, fileType, fileSize, category } = req.body;
    const user = req.user;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Note title is required.' });
    }

    const db = getFirestore();
    const now = FieldValue.serverTimestamp();

    const noteData = {
      title: title.trim(),
      fileName: fileName || title.trim(),
      fileUrl: fileUrl || '',
      fileType: fileType || 'document',
      fileSize: fileSize || 0,
      category: category || 'Uncategorized',
      uploadedBy: user.uid,
      uploadedByName: user.name || user.displayName || user.email || 'User',
      createdAt: now,
    };

    const docRef = await db.collection('classrooms')
      .doc(classId)
      .collection('notes')
      .add(noteData);

    return res.status(201).json({ id: docRef.id, ...noteData });
  } catch (error) {
    console.error('Error creating note:', error);
    return res.status(500).json({ error: 'Failed to create note', details: error.message });
  }
});

// DELETE /api/classrooms/:classId/notes/:id - Delete note
router.delete('/:id', verifyAuthToken, async (req, res) => {
  try {
    const { classId, id: noteId } = req.params;
    const db = getFirestore();

    await db.collection('classrooms')
      .doc(classId)
      .collection('notes')
      .doc(noteId)
      .delete();

    return res.json({ message: 'Note deleted successfully', id: noteId });
  } catch (error) {
    console.error('Error deleting note:', error);
    return res.status(500).json({ error: 'Failed to delete note', details: error.message });
  }
});

export default router;
