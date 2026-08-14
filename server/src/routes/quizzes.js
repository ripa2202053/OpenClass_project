import express from 'express';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { verifyAuthToken } from '../middleware/auth.js';

const router = express.Router({ mergeParams: true });

function gradeQuestion(question, answer) {
  if (!question) return false;

  if (question.type === 'mcq' || question.type === 'truefalse') {
    return answer === question.correctAnswer;
  }

  if (question.type === 'shortanswer') {
    if (!question.correctAnswerText || !answer) return false;
    return String(answer).trim().toLowerCase() === String(question.correctAnswerText).trim().toLowerCase();
  }

  return false;
}

// POST /api/classrooms/:classId/quizzes - Create quiz
router.post('/', verifyAuthToken, async (req, res) => {
  try {
    const { classId } = req.params;
    const { title, description, timeLimit, questions, maxMarks, shuffleQuestions, allowReview, attemptsAllowed, status } = req.body;
    const user = req.user;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Quiz title is required.' });
    }

    const db = getFirestore();
    const now = FieldValue.serverTimestamp();

    const quizData = {
      title: title.trim(),
      description: description || '',
      timeLimit: Number(timeLimit) || 0,
      questions: questions || [],
      maxMarks: Number(maxMarks) || (questions ? questions.length : 0),
      shuffleQuestions: !!shuffleQuestions,
      allowReview: allowReview !== false,
      attemptsAllowed: Number(attemptsAllowed) || 1,
      status: status || 'published',
      createdBy: user.uid,
      createdByName: user.name || user.displayName || user.email || 'Teacher',
      createdAt: now,
      updatedAt: now,
      publishedAt: status === 'published' ? now : null,
    };

    const docRef = await db.collection('classrooms')
      .doc(classId)
      .collection('quizzes')
      .add(quizData);

    // Add activity log
    await db.collection('classrooms').doc(classId).collection('activity').add({
      type: 'quiz_created',
      description: `New quiz created: ${title.trim()}`,
      userId: user.uid,
      userName: user.name || user.displayName || user.email || 'Teacher',
      timestamp: now,
    });

    return res.status(201).json({ id: docRef.id, ...quizData });
  } catch (error) {
    console.error('Error creating quiz:', error);
    return res.status(500).json({ error: 'Failed to create quiz', details: error.message });
  }
});

import { safeServerQuery, isQuotaExceededError } from '../utils/quotaGuard.js';

// GET /api/classrooms/:classId/quizzes - Get quizzes for classroom
router.get('/', verifyAuthToken, async (req, res) => {
  const { classId } = req.params;
  const cacheKey = `server_quizzes_${classId}`;

  try {
    const quizzes = await safeServerQuery(cacheKey, async () => {
      const db = getFirestore();

      const snapshot = await db.collection('classrooms')
        .doc(classId)
        .collection('quizzes')
        .orderBy('createdAt', 'desc')
        .get();

      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    }, [], 30000);

    return res.json(quizzes);
  } catch (error) {
    if (isQuotaExceededError(error)) {
      console.warn('[Quizzes Route] Firestore RESOURCE_EXHAUSTED. Returning empty quizzes list.');
      return res.json([]);
    }
    console.error('Error fetching quizzes:', error);
    return res.status(500).json({ error: 'Failed to fetch quizzes', details: error.message });
  }
});

// POST /api/classrooms/:classId/quizzes/:id/submit - Submit quiz & auto-grade
router.post('/:id/submit', verifyAuthToken, async (req, res) => {
  try {
    const { classId, id: quizId } = req.params;
    const { answers, timeTaken } = req.body;
    const user = req.user;

    const db = getFirestore();
    const quizRef = db.collection('classrooms').doc(classId).collection('quizzes').doc(quizId);
    const quizSnap = await quizRef.get();

    if (!quizSnap.exists) {
      return res.status(404).json({ error: 'Quiz not found.' });
    }

    const quiz = quizSnap.data();
    const questions = quiz.questions || [];

    let score = 0;
    let totalMarks = 0;

    const graded = questions.map((q, i) => {
      const ans = answers ? answers[i] : null;
      const isCorrect = gradeQuestion(q, ans);
      const qMarks = Number(q.marks) || 1;
      totalMarks += qMarks;
      if (isCorrect) score += qMarks;

      return {
        questionIndex: i,
        question: q.question,
        type: q.type || 'mcq',
        selectedAnswer: ans,
        correctAnswer: q.type === 'shortanswer' ? q.correctAnswerText : q.correctAnswer,
        isCorrect,
        marks: isCorrect ? qMarks : 0,
        maxMarks: qMarks,
      };
    });

    const percentage = totalMarks > 0 ? Math.round((score / totalMarks) * 100) : 0;

    const attemptRef = quizRef.collection('attempts').doc(user.uid);
    const attemptSnap = await attemptRef.get();
    const attemptNumber = attemptSnap.exists ? ((attemptSnap.data().attemptNumber || 0) + 1) : 1;

    const attemptData = {
      studentId: user.uid,
      studentName: user.name || user.displayName || user.email || 'Student',
      answers: graded,
      score,
      total: questions.length,
      totalMarks,
      percentage,
      timeTaken: Number(timeTaken) || 0,
      attemptNumber,
      status: 'completed',
      submittedAt: FieldValue.serverTimestamp(),
    };

    await attemptRef.set(attemptData);

    // Add activity log
    await db.collection('classrooms').doc(classId).collection('activity').add({
      type: 'quiz_submitted',
      description: `${user.name || user.email || 'Student'} completed quiz "${quiz.title}" with score ${score}/${totalMarks}`,
      userId: user.uid,
      userName: user.name || user.displayName || user.email || 'Student',
      timestamp: FieldValue.serverTimestamp(),
    });

    return res.json({
      message: 'Quiz submitted and auto-graded successfully',
      score,
      total: questions.length,
      totalMarks,
      percentage,
      graded,
      attemptNumber
    });
  } catch (error) {
    console.error('Error submitting quiz:', error);
    return res.status(500).json({ error: 'Failed to submit quiz', details: error.message });
  }
});

export default router;
