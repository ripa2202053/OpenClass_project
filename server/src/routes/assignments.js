import express from 'express';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { verifyAuthToken } from '../middleware/auth.js';

const router = express.Router({ mergeParams: true });

// POST /api/classrooms/:classId/assignments - Create assignment
router.post('/', verifyAuthToken, async (req, res) => {
  try {
    const { classId } = req.params;
    const { title, description, dueDate, maxMarks, files, status } = req.body;
    const user = req.user;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Assignment title is required.' });
    }

    const db = getFirestore();
    const now = FieldValue.serverTimestamp();

    const assignmentData = {
      title: title.trim(),
      description: description || '',
      dueDate: dueDate || null,
      maxMarks: Number(maxMarks) || 0,
      files: files || [],
      status: status || 'published',
      createdBy: user.uid,
      createdByName: user.name || user.displayName || user.email || 'Teacher',
      createdAt: now,
      updatedAt: now,
      publishedAt: status === 'published' ? now : null,
    };

    const docRef = await db.collection('classrooms')
      .doc(classId)
      .collection('assignments')
      .add(assignmentData);

    // Add activity log
    await db.collection('classrooms').doc(classId).collection('activity').add({
      type: 'assignment_created',
      description: `New assignment created: ${title.trim()}`,
      userId: user.uid,
      userName: user.name || user.displayName || user.email || 'Teacher',
      timestamp: now,
    });

    return res.status(201).json({ id: docRef.id, ...assignmentData });
  } catch (error) {
    console.error('Error creating assignment:', error);
    return res.status(500).json({ error: 'Failed to create assignment', details: error.message });
  }
});

// GET /api/classrooms/:classId/assignments - Get assignments
router.get('/', verifyAuthToken, async (req, res) => {
  try {
    const { classId } = req.params;
    const db = getFirestore();

    const snapshot = await db.collection('classrooms')
      .doc(classId)
      .collection('assignments')
      .orderBy('createdAt', 'desc')
      .get();

    const assignments = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    return res.json(assignments);
  } catch (error) {
    console.error('Error fetching assignments:', error);
    return res.status(500).json({ error: 'Failed to fetch assignments', details: error.message });
  }
});

// POST /api/classrooms/:classId/assignments/:id/submit - Submit assignment
router.post('/:id/submit', verifyAuthToken, async (req, res) => {
  try {
    const { classId, id: assignmentId } = req.params;
    const { files } = req.body;
    const user = req.user;

    const db = getFirestore();
    const assignmentRef = db.collection('classrooms').doc(classId).collection('assignments').doc(assignmentId);
    const assignmentSnap = await assignmentRef.get();

    if (!assignmentSnap.exists) {
      return res.status(404).json({ error: 'Assignment not found.' });
    }

    const assignment = assignmentSnap.data();
    if (assignment.status === 'closed') {
      return res.status(400).json({ error: 'This assignment is closed for submissions.' });
    }

    const dueDate = assignment.dueDate ? new Date(assignment.dueDate).getTime() : null;
    const now = Date.now();
    const isLate = dueDate ? now > dueDate : false;

    const subRef = assignmentRef.collection('submissions').doc(user.uid);
    const existingSnap = await subRef.get();

    const submission = {
      studentId: user.uid,
      studentName: user.name || user.displayName || user.email || 'Student',
      files: files || [],
      submittedAt: FieldValue.serverTimestamp(),
      late: isLate,
      status: isLate ? 'late' : 'submitted',
    };

    if (!existingSnap.exists) {
      submission.marks = null;
      submission.feedback = '';
      submission.gradedAt = null;
      submission.history = [];
    } else {
      const existing = existingSnap.data();
      submission.marks = existing.marks || null;
      submission.feedback = existing.feedback || '';
      submission.gradedAt = existing.gradedAt || null;
      submission.history = [...(existing.history || []), {
        files: existing.files || [],
        submittedAt: existing.submittedAt || null,
        status: existing.status || 'submitted',
      }];
    }

    await subRef.set(submission);

    // Add activity log
    await db.collection('classrooms').doc(classId).collection('activity').add({
      type: 'assignment_submitted',
      description: `${user.name || user.email || 'Student'} submitted assignment "${assignment.title}"`,
      userId: user.uid,
      userName: user.name || user.displayName || user.email || 'Student',
      timestamp: FieldValue.serverTimestamp(),
    });

    return res.json({ message: 'Assignment submitted successfully', late: isLate });
  } catch (error) {
    console.error('Error submitting assignment:', error);
    return res.status(500).json({ error: 'Failed to submit assignment', details: error.message });
  }
});

export default router;
