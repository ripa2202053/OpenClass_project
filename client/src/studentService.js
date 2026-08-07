import { getFirestore, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';

// ─── GAMIFICATION & STUDENT UTILITIES ──────────────────────────────────────

const STORAGE_BOOKMARKS_KEY = 'openclass_bookmarked_resources';

export const BADGES_LIST = [
  { id: 'first_step', title: 'First Step', desc: 'Completed your first assignment or quiz', icon: 'directions_walk', color: '#3B82F6' },
  { id: 'quiz_ace', title: 'Quiz Ace', desc: 'Scored 80% or higher on a quiz', icon: 'emoji_events', color: '#F59E0B' },
  { id: 'streak_master', title: 'Streak Master', desc: 'Maintained a 3-day active learning streak', icon: 'local_fire_department', color: '#EF4444' },
  { id: 'top_scholar', title: 'Top Scholar', desc: 'Earned 500+ XP points', icon: 'workspace_premium', color: '#10B981' },
];

/**
 * Calculates Gamification stats (XP, Streak, Unlocked Badges) from student data
 */
export function calculateGamification(studentSubmissions = [], quizAttempts = [], userProfile = {}) {
  let xp = 0;
  
  // Base XP from profile if present
  if (userProfile.xp) xp += userProfile.xp;

  // Assignment XP (+50 per submission)
  const submittedCount = studentSubmissions.length;
  xp += submittedCount * 50;

  // Quiz XP (+100 per completed attempt + score bonus)
  let highestQuizScore = 0;
  quizAttempts.forEach(attempt => {
    xp += 100;
    const score = attempt.score || 0;
    if (score > highestQuizScore) highestQuizScore = score;
    xp += Math.round(score * 0.5); // bonus XP
  });

  // Calculate Streak
  const lastLoginStr = localStorage.getItem('openclass_last_active_date');
  const streakCount = parseInt(localStorage.getItem('openclass_streak_count') || '1', 10);
  const todayStr = new Date().toDateString();

  if (lastLoginStr !== todayStr) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    if (lastLoginStr === yesterday.toDateString()) {
      localStorage.setItem('openclass_streak_count', (streakCount + 1).toString());
    } else {
      localStorage.setItem('openclass_streak_count', '1');
    }
    localStorage.setItem('openclass_last_active_date', todayStr);
  }

  const currentStreak = parseInt(localStorage.getItem('openclass_streak_count') || '1', 10);

  // Evaluate Unlocked Badges
  const unlockedBadges = [];
  if (submittedCount > 0 || quizAttempts.length > 0) unlockedBadges.push('first_step');
  if (highestQuizScore >= 80) unlockedBadges.push('quiz_ace');
  if (currentStreak >= 3) unlockedBadges.push('streak_master');
  if (xp >= 500) unlockedBadges.push('top_scholar');

  return {
    xp,
    streak: currentStreak,
    unlockedBadges,
    badgesList: BADGES_LIST.map(b => ({
      ...b,
      unlocked: unlockedBadges.includes(b.id)
    }))
  };
}

/**
 * Resource Bookmarks Management
 */
export function getBookmarkedResourceIds() {
  try {
    const data = localStorage.getItem(STORAGE_BOOKMARKS_KEY);
    return data ? JSON.parse(data) : [];
  } catch (e) {
    return [];
  }
}

export function toggleBookmarkResource(resourceId) {
  const bookmarks = getBookmarkedResourceIds();
  const index = bookmarks.indexOf(resourceId);
  let isBookmarked = false;

  if (index > -1) {
    bookmarks.splice(index, 1);
  } else {
    bookmarks.push(resourceId);
    isBookmarked = true;
  }

  localStorage.setItem(STORAGE_BOOKMARKS_KEY, JSON.stringify(bookmarks));
  return isBookmarked;
}

/**
 * AI Study Assistant Helper (Summarizer & Quiz Generator)
 */
export function summarizeTextAI(text) {
  if (!text || !text.trim()) return null;
  const cleanText = text.trim();
  const sentences = cleanText.split(/(?<=[.?!])\s+/).filter(Boolean);
  
  if (sentences.length <= 2) {
    return {
      summary: cleanText,
      keyTakeaways: [cleanText]
    };
  }

  // Key takeaways extraction (first 3-4 significant sentences)
  const keyTakeaways = sentences.slice(0, 4);
  const summary = sentences.slice(0, Math.min(sentences.length, 3)).join(' ');

  return {
    summary,
    keyTakeaways
  };
}

export function generateQuizAI(topicOrText) {
  const seed = topicOrText || 'General Knowledge';
  const cleanSeed = seed.trim();

  return [
    {
      id: 1,
      question: `What is the primary core concept discussed regarding ${cleanSeed}?`,
      options: [
        `Fundamental principles and key properties of ${cleanSeed}`,
        `Secondary legacy attributes`,
        `Unrelated historical timeline`,
        `Experimental fallback definitions`
      ],
      correctAnswer: 0
    },
    {
      id: 2,
      question: `Which of the following is considered a best practice when analyzing ${cleanSeed}?`,
      options: [
        `Ignoring baseline validation metrics`,
        `Systematic review and structured synthesis`,
        `Random sampling without empirical verification`,
        `Disabling error handlers`
      ],
      correctAnswer: 1
    },
    {
      id: 3,
      question: `What is a major practical application of ${cleanSeed}?`,
      options: [
        `Static documentation storage only`,
        `Streamlining workflow efficiency and problem solving`,
        `Manual paper logging`,
        `Disabling network communication`
      ],
      correctAnswer: 1
    }
  ];
}
