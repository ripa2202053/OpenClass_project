import {
  getFirestore, collection, doc, addDoc, getDoc, getDocs,
  updateDoc, deleteDoc, setDoc, query, where, orderBy, onSnapshot, serverTimestamp
} from 'firebase/firestore';

export async function createQuiz(classroomId, data, user) {
  const db = getFirestore();
  const ref = await addDoc(collection(db, 'classrooms', classroomId, 'quizzes'), {
    title: data.title.trim(),
    description: data.description || '',
    timeLimit: Number(data.timeLimit) || 0,
    questions: data.questions || [],
    createdBy: user.uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return { id: ref.id };
}

export async function updateQuiz(classroomId, quizId, data) {
  const db = getFirestore();
  await updateDoc(doc(db, 'classrooms', classroomId, 'quizzes', quizId), {
    title: data.title.trim(),
    description: data.description || '',
    timeLimit: Number(data.timeLimit) || 0,
    questions: data.questions || [],
    updatedAt: serverTimestamp(),
  });
}

export async function deleteQuiz(classroomId, quizId) {
  await deleteDoc(doc(getFirestore(), 'classrooms', classroomId, 'quizzes', quizId));
}

export function subscribeQuizzes(classroomId, callback) {
  const db = getFirestore();
  return onSnapshot(
    query(collection(db, 'classrooms', classroomId, 'quizzes'), orderBy('createdAt', 'desc')),
    (snap) => {
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      callback(list);
    }
  );
}

export async function submitQuizAttempt(classroomId, quizId, student, answers, timeTaken) {
  const db = getFirestore();
  const quizSnap = await getDoc(doc(db, 'classrooms', classroomId, 'quizzes', quizId));
  if (!quizSnap.exists()) throw new Error('Quiz not found.');
  const quiz = quizSnap.data();
  const questions = quiz.questions || [];
  let score = 0;
  const graded = questions.map((q, i) => {
    const selected = answers[i] !== undefined ? answers[i] : -1;
    const correct = selected === q.correctAnswer;
    if (correct) score++;
    return { questionIndex: i, selectedAnswer: selected, correctAnswer: q.correctAnswer, isCorrect: correct };
  });
  await setDoc(doc(db, 'classrooms', classroomId, 'quizzes', quizId, 'attempts', student.uid), {
    studentId: student.uid,
    studentName: student.displayName || 'Unknown',
    answers: graded,
    score,
    total: questions.length,
    submittedAt: serverTimestamp(),
    timeTaken: timeTaken || 0,
  });
  return { score, total: questions.length };
}

export function subscribeMyAttempt(classroomId, quizId, uid, callback) {
  const db = getFirestore();
  return onSnapshot(
    doc(db, 'classrooms', classroomId, 'quizzes', quizId, 'attempts', uid),
    (snap) => { callback(snap.exists() ? { id: snap.id, ...snap.data() } : null); }
  );
}

export function subscribeLeaderboard(classroomId, quizId, callback) {
  const db = getFirestore();
  return onSnapshot(
    query(
      collection(db, 'classrooms', classroomId, 'quizzes', quizId, 'attempts'),
      orderBy('score', 'desc'),
      orderBy('timeTaken', 'asc')
    ),
    (snap) => {
      const list = snap.docs.map((d, i) => ({ rank: i + 1, id: d.id, ...d.data() }));
      callback(list);
    }
  );
}
