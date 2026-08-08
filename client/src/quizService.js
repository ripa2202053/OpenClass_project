import {
  getFirestore, collection, doc, addDoc, getDoc, getDocs,
  updateDoc, deleteDoc, setDoc, query, where, orderBy, onSnapshot, serverTimestamp, limit
} from 'firebase/firestore';
import { fetchWithAuth } from './utils/api.js';

export const QTYPE = { MCQ: 'mcq', TRUE_FALSE: 'truefalse', SHORT: 'shortanswer' };

export async function createQuiz(classroomId, data, user) {
  try {
    const res = await fetchWithAuth(`/api/classrooms/${classroomId}/quizzes`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    if (res && res.id) return { id: res.id };
  } catch (err) {
    console.warn('Express API createQuiz failed, falling back to Firestore:', err.message);
  }
  const db = getFirestore();

  const ref = await addDoc(collection(db, 'classrooms', classroomId, 'quizzes'), {
    title: data.title.trim(),
    description: data.description || '',
    timeLimit: Number(data.timeLimit) || 0,
    questions: data.questions || [],
    maxMarks: Number(data.maxMarks) || (data.questions ? data.questions.length : 0),
    shuffleQuestions: !!data.shuffleQuestions,
    allowReview: data.allowReview !== false,
    attemptsAllowed: Number(data.attemptsAllowed) || 1,
    status: data.status || 'draft',
    createdBy: user.uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    publishedAt: null,
  });
  return { id: ref.id };
}

export async function updateQuiz(classroomId, quizId, data) {
  const db = getFirestore();
  const updates = {
    title: data.title.trim(),
    description: data.description || '',
    timeLimit: Number(data.timeLimit) || 0,
    questions: data.questions || [],
    maxMarks: Number(data.maxMarks) || 0,
    updatedAt: serverTimestamp(),
  };
  if (data.status) updates.status = data.status;
  if (data.status === 'published') updates.publishedAt = serverTimestamp();
  await updateDoc(doc(db, 'classrooms', classroomId, 'quizzes', quizId), updates);
}

export async function deleteQuiz(classroomId, quizId) {
  await deleteDoc(doc(getFirestore(), 'classrooms', classroomId, 'quizzes', quizId));
}

export async function publishQuiz(classroomId, quizId) {
  await updateDoc(doc(getFirestore(), 'classrooms', classroomId, 'quizzes', quizId), {
    status: 'published', publishedAt: serverTimestamp(), updatedAt: serverTimestamp(),
  });
}

export async function closeQuiz(classroomId, quizId) {
  await updateDoc(doc(getFirestore(), 'classrooms', classroomId, 'quizzes', quizId), {
    status: 'closed', updatedAt: serverTimestamp(),
  });
}

export function subscribeQuizzes(classroomId, callback) {
  return onSnapshot(
    query(collection(getFirestore(), 'classrooms', classroomId, 'quizzes'), orderBy('createdAt', 'desc')),
    (snap) => callback(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  );
}

function gradeQuestion(question, answer) {
  if (question.type === QTYPE.MCQ) {
    return answer === question.correctAnswer;
  }
  if (question.type === QTYPE.TRUE_FALSE) {
    return answer === question.correctAnswer;
  }
  if (question.type === QTYPE.SHORT) {
    if (!question.correctAnswerText || !answer) return false;
    return answer.trim().toLowerCase() === question.correctAnswerText.trim().toLowerCase();
  }
  return false;
}

export async function submitQuizAttempt(classroomId, quizId, student, answers, timeTaken) {
  try {
    const res = await fetchWithAuth(`/api/classrooms/${classroomId}/quizzes/${quizId}/submit`, {
      method: 'POST',
      body: JSON.stringify({ answers, timeTaken }),
    });
    if (res && res.score !== undefined) {
      return {
        score: res.score,
        total: res.total !== undefined ? res.total : res.totalMarks,
        totalMarks: res.totalMarks,
        percentage: res.percentage,
        graded: res.graded || res.gradedQuestions || [],
        attemptNumber: res.attemptNumber || 1,
      };
    }
  } catch (err) {
    console.warn('Express API submitQuizAttempt failed, falling back to Firestore:', err.message);
  }
  const db = getFirestore();

  const quizSnap = await getDoc(doc(db, 'classrooms', classroomId, 'quizzes', quizId));
  if (!quizSnap.exists()) throw new Error('Quiz not found.');
  const quiz = quizSnap.data();

  const existingRef = doc(db, 'classrooms', classroomId, 'quizzes', quizId, 'attempts', student.uid);
  const existingSnap = await getDoc(existingRef);
  const attemptCount = existingSnap.exists() ? ((existingSnap.data().attemptNumber || 0) + 1) : 1;

  const questions = quiz.questions || [];
  let score = 0;
  let totalMarks = 0;
  const graded = questions.map((q, i) => {
    const ans = answers[i] !== undefined ? answers[i] : null;
    const isCorrect = gradeQuestion(q, ans);
    const qMarks = q.marks || 1;
    totalMarks += qMarks;
    if (isCorrect) score += qMarks;
    return {
      questionIndex: i,
      question: q.question,
      type: q.type || QTYPE.MCQ,
      selectedAnswer: ans,
      correctAnswer: q.type === QTYPE.SHORT ? q.correctAnswerText : q.correctAnswer,
      isCorrect,
      marks: isCorrect ? qMarks : 0,
      maxMarks: qMarks,
    };
  });

  const attempt = {
    studentId: student.uid,
    studentName: student.displayName || 'Unknown',
    answers: graded,
    score,
    total: questions.length,
    totalMarks,
    submittedAt: serverTimestamp(),
    timeTaken: timeTaken || 0,
    attemptNumber: attemptCount,
    status: 'completed',
  };

  await setDoc(existingRef, attempt);

  if (existingSnap.exists()) {
    const historyRef = doc(db, 'classrooms', classroomId, 'quizzes', quizId, 'attempts', student.uid, 'history', String(attemptCount - 1));
    await setDoc(historyRef, { ...existingSnap.data(), archivedAt: serverTimestamp() });
  }

  return { score, total: questions.length, totalMarks, graded, attemptCount };
}

export function subscribeMyAttempt(classroomId, quizId, uid, callback) {
  return onSnapshot(
    doc(getFirestore(), 'classrooms', classroomId, 'quizzes', quizId, 'attempts', uid),
    (snap) => callback(snap.exists() ? { id: snap.id, ...snap.data() } : null)
  );
}

export function subscribeAttemptHistory(classroomId, quizId, uid, callback) {
  return onSnapshot(
    query(collection(getFirestore(), 'classrooms', classroomId, 'quizzes', quizId, 'attempts', uid, 'history'), orderBy('archivedAt', 'asc')),
    (snap) => callback(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  );
}

export function subscribeLeaderboard(classroomId, quizId, callback) {
  return onSnapshot(
    query(
      collection(getFirestore(), 'classrooms', classroomId, 'quizzes', quizId, 'attempts'),
      orderBy('score', 'desc'),
      orderBy('timeTaken', 'asc')
    ),
    (snap) => {
      const list = snap.docs.map((d, i) => ({ rank: i + 1, id: d.id, ...d.data() }));
      callback(list);
    }
  );
}

export function subscribeQuizAnalytics(classroomId, quizId, callback) {
  const db = getFirestore();
  const unsubs = [];
  let quizData = null;
  let attempts = [];

  unsubs.push(onSnapshot(doc(db, 'classrooms', classroomId, 'quizzes', quizId), (snap) => {
    quizData = snap.exists() ? { id: snap.id, ...snap.data() } : null;
    emitAnalysis();
  }));

  unsubs.push(onSnapshot(
    query(collection(db, 'classrooms', classroomId, 'quizzes', quizId, 'attempts')),
    (snap) => {
      attempts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      emitAnalysis();
    }
  ));

  function emitAnalysis() {
    if (!quizData) return;
    const totalAttempts = attempts.length;
    const scores = attempts.map(a => a.score || 0);
    const avgScore = totalAttempts > 0 ? scores.reduce((s, v) => s + v, 0) / totalAttempts : 0;
    const maxScore = scores.length > 0 ? Math.max(...scores) : 0;
    const minScore = scores.length > 0 ? Math.min(...scores) : 0;
    const passCount = attempts.filter(a => a.score >= (quizData.totalMarks || quizData.total || 1) / 2).length;
    const passRate = totalAttempts > 0 ? (passCount / totalAttempts * 100) : 0;

    const questionBreakdown = (quizData.questions || []).map((q, qi) => {
      const correct = attempts.filter(a => {
        const ans = (a.answers || []).find(ag => ag.questionIndex === qi);
        return ans && ans.isCorrect;
      }).length;
      return {
        questionIndex: qi,
        question: q.question,
        type: q.type || 'mcq',
        correctCount: correct,
        totalAttempts,
        accuracy: totalAttempts > 0 ? (correct / totalAttempts * 100) : 0,
      };
    });

    callback({
      totalAttempts,
      avgScore: Math.round(avgScore * 10) / 10,
      maxScore,
      minScore,
      passRate: Math.round(passRate * 10) / 10,
      questionBreakdown,
      attempts,
    });
  }

  return () => unsubs.forEach(u => u());
}

export async function saveToQuestionBank(classroomId, question, user) {
  const db = getFirestore();
  await addDoc(collection(db, 'classrooms', classroomId, 'questionBank'), {
    ...question,
    createdBy: user.uid,
    createdAt: serverTimestamp(),
    usedCount: 0,
  });
}

export function subscribeQuestionBank(classroomId, callback) {
  return onSnapshot(
    query(collection(getFirestore(), 'classrooms', classroomId, 'questionBank'), orderBy('createdAt', 'desc')),
    (snap) => callback(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  );
}

export async function deleteFromQuestionBank(classroomId, questionId) {
  await deleteDoc(doc(getFirestore(), 'classrooms', classroomId, 'questionBank', questionId));
}
