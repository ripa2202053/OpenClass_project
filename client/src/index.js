'use strict';

import { initializeApp } from 'firebase/app';
import {
  getAuth,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signInAnonymously,
} from 'firebase/auth';
import {
  getFirestore,
  collection,
  addDoc,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  getDocs,
  setDoc,
  updateDoc,
  doc,
  serverTimestamp,
} from 'firebase/firestore';
import {
  getStorage,
  ref,
  uploadBytesResumable,
  getDownloadURL,
} from 'firebase/storage';
import {
  getMessaging,
  getToken,
  onMessage
} from 'firebase/messaging';
import { getPerformance } from 'firebase/performance';

import { getFirebaseConfig } from './firebase-config.js';
import { createUser, getUser, updateUser, updateProfile, isTeacher, isStudent, requireRole, normalizeRole, isValidRole, displayRole, saveProfileToStorage, getProfileFromStorage, clearProfileFromStorage, ROLES, subscribeAllUsers, isLocalhost, getInitialsSvgDataUrl, sanitizeProfilePhotoUrl } from './userService.js';
import {
  createClassroom, joinClassroomByCode, validateJoinCode, subscribeToUserClassrooms,
  updateClassroom, archiveClassroom, deleteClassroomPermanent, leaveClassroom, getClassroom,
  approveMember, rejectMember, removeMember,
  subscribeToClassroomMembers, subscribeToJoinRequests, subscribeToClassroomRequests,
  subscribeToClassroomStats, subscribeToClassroomActivity,
  addActivity as addClassroomActivity,
  getThemeGradient, CLASSROOM_THEMES
} from './classroomService.js';

import { subscribeDashboardData, unsubscribeAll, addActivity, addNotice, subscribeNotices } from './dashboardService.js';
import {
  calculateGamification, getBookmarkedResourceIds, toggleBookmarkResource,
  summarizeTextAI, generateQuizAI
} from './studentService.js';
import {
  createMeeting, subscribeTeacherMeetings, subscribeClassroomMeetings,
  updateMeetingStatus, recordMeetingJoin, exportAttendanceCSV
} from './meetingService.js';
import { openInAppMeeting as mountMeetingUi, closeInAppMeeting, isMeetingOpen } from './meeting/index.jsx';
import {
  subscribeToChannels, createChannel, sendMessage, sendImageMessage,
  subscribeToMessages, setTyping, subscribeToTyping, markChannelAsRead,
  subscribeToUnreadCounts,
  sendFileMessage, sendMessageWithReply, addReaction, removeReaction,
  editMessage, deleteMessage as deleteChatMessage, searchMessages,
  createPrivateChat, subscribePrivateChats, sendPrivateMessage, subscribePrivateMessages,
  subscribePresence, setOnline, subscribeReadReceipts, markRead,
  subscribeAllUserPrivateChats
} from './chatService.js';
import {
  initFloatingMessenger,
  openFloatingMessenger,
  showChatToastAlert
} from './floatingMessenger.js';
import {
  initMessengerTab,
  selectContact
} from './messengerTab.js';

let currentUserProfile = null;
let selectedProfileImageFile = null;
let selectedProfileImageDataUrl = null;
let classroomsUnsubscribe = null;
let dashboardUnsubscribe = null;
let chatChannelsUnsubscribe = null;
let chatMessagesUnsubscribe = null;
let chatTypingUnsubscribe = null;
let userPrivateChatsUnsub = null;
let assignmentsUnsub = null;
let quizzesUnsub = null;
let notesUnsub = null;
let privateChatUnsub = null;
let meetingsUnsub = null;
let globalMeetingsUnsub = null;
let detailAttendanceUnsub = null;
let globalAttendanceUnsubs = [];
let studentHistoryUnsub = null;
let remindersUnsub = null;
let notificationsUnsub = null;
let userStatusUnsub = null;
let requestsUnsub = null;
let teacherMeetingsUnsub = null;
let detailStatsUnsub = null;
let detailMembersUnsub = null;
let detailRequestsUnsub = null;
let detailActivityUnsub = null;
let detailNoticesUnsub = null;
let calendarEventsCache = [];
let selectedCalendarDay = null;
const notifiedMessageIds = new Set();
let currentChannelId = null;
let typingTimeout = null;
let roleSelectionResolve = null;
let selectedFirstLoginRole = null;

// Calendar + classroom state (module-global so renderCalendar / loadCalendarEvents
// and every event handler can safely read/mutate them without TDZ or ReferenceErrors)
let userClassrooms = [];
let calendarDate = new Date();
let calendarView = 'month';

async function signIn() {
  try {
    const provider = new GoogleAuthProvider();
    await signInWithPopup(getAuth(), provider);
  } catch (error) {
    console.error('Sign-in failed:', error);
  }
}

function clearAuthData() {
  // Only clear our app-specific data, NOT Firebase's auth session
  window.__pendingRole = undefined;
  window.__pendingExtraData = undefined;
  
  // Clear all auth form fields
  document.getElementById('auth-email')?.setAttribute('value', '');
  document.getElementById('auth-password')?.setAttribute('value', '');
  document.getElementById('auth-reg-name')?.setAttribute('value', '');
  document.getElementById('auth-reg-email')?.setAttribute('value', '');
  document.getElementById('auth-reg-password')?.setAttribute('value', '');
  document.getElementById('auth-reg-confirm')?.setAttribute('value', '');
  document.getElementById('auth-reg-join-code')?.setAttribute('value', '');
  document.getElementById('auth-reg-student-id')?.setAttribute('value', '');
  document.getElementById('auth-reg-student-dept')?.setAttribute('value', '');
  document.getElementById('auth-reg-semester')?.setAttribute('value', '');
  document.getElementById('auth-reg-teacher-id')?.setAttribute('value', '');
  document.getElementById('auth-reg-teacher-dept')?.setAttribute('value', '');
  document.getElementById('auth-reg-designation')?.setAttribute('value', '');
  document.getElementById('auth-reg-role')?.setAttribute('value', '');
  
  // Reset role selection cards
  const studentBtn = document.getElementById('role-student-btn');
  const teacherBtn = document.getElementById('role-teacher-btn');
  const submitBtn = document.getElementById('auth-register-btn');
  if (studentBtn) studentBtn.classList.remove('selected');
  if (teacherBtn) teacherBtn.classList.remove('selected');
  if (submitBtn) submitBtn.disabled = true;
  
  // Hide role-specific fields
  document.querySelectorAll('.reg-field-student').forEach(field => field.style.display = 'none');
  document.querySelectorAll('.reg-field-teacher').forEach(field => field.style.display = 'none');
}

function signOutUser() {
  // Clear localStorage/sessionStorage only on explicit logout
  localStorage.clear();
  sessionStorage.clear();
  clearAuthData();
  try {
    signOut(getAuth());
  } catch (error) {
    console.error('Sign-out failed:', error);
  }
}

function showFirstLoginRoleModal() {
  return new Promise((resolve) => {
    roleSelectionResolve = resolve;
    selectedFirstLoginRole = null;
    const modal = document.getElementById('modal-role-select');
    if (modal) modal.style.display = 'flex';
    const confirmBtn = document.getElementById('role-select-confirm');
    if (confirmBtn) confirmBtn.disabled = true;
    const errEl = document.getElementById('role-select-error');
    if (errEl) errEl.style.display = 'none';
    // Reset card selection
    document.querySelectorAll('#modal-role-select .role-selection-card').forEach(card => card.classList.remove('selected'));
  });
}

function selectFirstLoginRole(role) {
  selectedFirstLoginRole = normalizeRole(role);
  const confirmBtn = document.getElementById('role-select-confirm');
  if (confirmBtn) confirmBtn.disabled = !selectedFirstLoginRole;
  const errEl = document.getElementById('role-select-error');
  if (errEl) errEl.style.display = 'none';
  document.querySelectorAll('#modal-role-select .role-selection-card').forEach(card => {
    card.classList.toggle('selected', normalizeRole(card.getAttribute('data-role')) === selectedFirstLoginRole);
  });
}

function confirmFirstLoginRole() {
  const modal = document.getElementById('modal-role-select');
  if (!selectedFirstLoginRole) {
    const errEl = document.getElementById('role-select-error');
    if (errEl) {
      errEl.textContent = 'Please select a role to continue.';
      errEl.style.display = 'block';
    }
    return;
  }
  if (modal) modal.style.display = 'none';
  const resolver = roleSelectionResolve;
  roleSelectionResolve = null;
  if (resolver) resolver(selectedFirstLoginRole);
}

function getProfilePicUrl() {
  const raw = (currentUserProfile && currentUserProfile.photoURL) || getAuth().currentUser?.photoURL || '';
  const safe = sanitizeProfilePhotoUrl(raw, currentUserProfile);
  return safe || '/images/profile_placeholder.png';
}

function getUserName() {
  return (currentUserProfile && currentUserProfile.displayName) || getAuth().currentUser?.displayName || 'OpenClass User';
}

function isUserSignedIn() {
  return !!getAuth().currentUser;
}

async function saveMessage(messageText) {
  if (currentChannelId) {
    await sendMessage(currentChannelId, messageText, currentUserProfile || getAuth().currentUser);
    return;
  }
  try {
    await addDoc(collection(getFirestore(), 'messages'), {
      name: getUserName(),
      text: messageText,
      profilePicUrl: getProfilePicUrl(),
      timestamp: serverTimestamp()
    });
  }
  catch(error) {
    console.error('Error writing new message to Firebase Database', error);
  }
}

async function saveImageMessage(file) {
  if (currentChannelId) {
    await sendImageMessage(currentChannelId, file, currentUserProfile || getAuth().currentUser);
    return;
  }
  try {
    const messageRef = await addDoc(collection(getFirestore(), 'messages'), {
      name: getUserName(),
      imageUrl: LOADING_IMAGE_URL,
      profilePicUrl: getProfilePicUrl(),
      timestamp: serverTimestamp()
    });
    const filePath = `${getAuth().currentUser.uid}/${messageRef.id}/${file.name}`;
    const newImageRef = ref(getStorage(), filePath);
    const fileSnapshot = await uploadBytesResumable(newImageRef, file);
    const publicImageUrl = await getDownloadURL(newImageRef);
    await updateDoc(messageRef,{
      imageUrl: publicImageUrl,
      storageUri: fileSnapshot.metadata.fullPath
    });
  } catch (error) {
    console.error('There was an error uploading a file to Cloud Storage:', error);
  }
}

async function saveMessagingDeviceToken() {
  // FCM getToken() 401s on localhost (no valid push key) and just pollutes the
  // console — skip Push token registration entirely on local dev environments.
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    console.log('[FCM] Skipping Push Token registration on localhost environment.');
    return;
  }
  try {
    // Register the Firebase Messaging service worker so getToken() has a working
    // registration for background push messages.
    let registration = null;
    if ('serviceWorker' in navigator) {
      try {
        registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
      } catch (swErr) {
        console.warn('FCM service worker registration failed:', swErr);
      }
    }
    const tokenOptions = {};
    if (registration) tokenOptions.serviceWorkerRegistration = registration;
    const currentToken = await getToken(getMessaging(), tokenOptions);
    if (currentToken) {
      console.log('Got FCM device token:', currentToken);
      const tokenRef = doc(getFirestore(), 'fcmTokens', currentToken);
      await setDoc(tokenRef, { uid: getAuth().currentUser.uid });
      onMessage(getMessaging(), (message) => {
        console.log(
          'New foreground notification from Firebase Messaging!',
          message.notification
        );
      });
    } else {
      requestNotificationsPermissions();
    }
  } catch(error) {
    const code = (error && (error.code || error.message || error.name || '')) || '';
    // AbortError / permission-declined / service-worker failures are expected on
    // localhost & strict browsers — warn instead of breaking app initialization.
    if (/abort|permission-blocked|permission_denied|permission_default|serviceworker|messaging\/(permission|token|service-worker)/i.test(code)) {
      console.warn('FCM token unavailable (expected on localhost):', error);
      return;
    }
    console.error('Unable to get messaging token.', error);
  };
}

async function requestNotificationsPermissions() {
  if (!('Notification' in window)) {
    console.log('Notifications not supported in this browser.');
    return;
  }
  console.log('Requesting notifications permission...');
  const permission = await Notification.requestPermission();
  if (permission === 'granted') {
    console.log('Notification permission granted.');
    await saveMessagingDeviceToken();
  } else {
    console.log('Unable to get permission to notify.');
  }
}

function onMediaFileSelected(event) {
  event.preventDefault();
  var file = event.target.files[0];
  imageFormElement.reset();
  if (!file.type.match('image.*')) {
    var data = {
      message: 'You can only share images',
      timeout: 2000
    };
    signInSnackbarElement.MaterialSnackbar.showSnackbar(data);
    return;
  }
  if (checkSignedInWithMessage()) {
    saveImageMessage(file);
  }
}

function onMessageFormSubmit(e) {
  e.preventDefault();
  const msgInput = document.getElementById('message');
  if (msgInput?.dataset?.replyTo) return;
  if (messageInputElement.value && checkSignedInWithMessage()) {
    saveMessage(messageInputElement.value).then(function() {
      resetMaterialTextfield(messageInputElement);
      toggleButton();
      if (currentChannelId && currentUserProfile) {
        setTyping(currentChannelId, getAuth().currentUser.uid, getUserName(), false);
      }
    });
  }
}

function populateProfileForm(profile) {
  if (!profile) return;
  const nameInput = document.getElementById('profile-input-name');
  const emailInput = document.getElementById('profile-input-email');
  const roleInput = document.getElementById('profile-input-role');
  const deptInput = document.getElementById('profile-input-department');
  const stuIdInput = document.getElementById('profile-input-student-id');
  const tchIdInput = document.getElementById('profile-input-teacher-id');
  const semInput = document.getElementById('profile-input-semester');
  const sessionInput = document.getElementById('profile-input-session');
  const designationInput = document.getElementById('profile-input-designation');
  const officeRoomInput = document.getElementById('profile-input-office-room');
  const phoneInput = document.getElementById('profile-input-phone');
  if (nameInput) nameInput.value = profile.displayName || '';
  if (emailInput) emailInput.value = profile.email || '';
  if (roleInput) roleInput.value = profile.role || '';
  if (deptInput) deptInput.value = profile.department || '';
  if (stuIdInput) stuIdInput.value = profile.studentId || '';
  if (tchIdInput) tchIdInput.value = profile.teacherId || '';
  if (semInput) semInput.value = profile.semester || '';
  if (sessionInput) sessionInput.value = profile.session || '';
  if (designationInput) designationInput.value = profile.designation || '';
  if (officeRoomInput) officeRoomInput.value = profile.officeRoom || '';
  if (phoneInput) phoneInput.value = profile.phone || '';
  applyRoleBasedProfileForm(profile);
  refreshProfileSummaryUI(profile);
}

function refreshProfileSummaryUI(profile) {
  const p = profile || currentUserProfile;
  if (!p) return;
  const isUserTeacher = isTeacher(p);
  const photoUrl = p.photoURL || '';
  const displayName = p.displayName || 'OpenClass User';
  const roleLabel = displayRole(p.role);

  // Center profile summary card (avatar, name, badge)
  const avatarImg = document.getElementById('profile-avatar');
  if (avatarImg) applyAvatarBackground(avatarImg, photoUrl, p);
  const headerName = document.getElementById('profile-header-name');
  if (headerName) headerName.textContent = displayName;
  const headerRole = document.getElementById('profile-header-role');
  if (headerRole) headerRole.textContent = roleLabel;

  // Sidebar user profile component (avatar, name, badge)
  const picEl = document.getElementById('user-pic');
  if (picEl) {
    applyAvatarBackground(picEl, photoUrl, p);
    picEl.removeAttribute('hidden');
  }
  const nameEl = document.getElementById('user-name');
  if (nameEl) {
    nameEl.textContent = displayName;
    nameEl.removeAttribute('hidden');
  }
  const badgeEl = document.getElementById('topbar-role-badge');
  if (badgeEl) {
    badgeEl.textContent = roleLabel;
    badgeEl.className = 'user-card-role role-badge ' + (isUserTeacher ? 'teacher' : 'student');
    badgeEl.removeAttribute('hidden');
  }
}

function applyAvatarBackground(element, photoUrl, profile) {
  if (!element) return;
  const fallback = getInitialsSvgDataUrl(profile);
  // Localhost CORS bypass: never request Firebase Storage locally — render the
  // initials SVG directly so no HTTP request / CORS error is ever triggered.
  const isStorageOnLocalhost =
    isLocalhost() &&
    typeof photoUrl === 'string' &&
    photoUrl.startsWith('https://firebasestorage.googleapis.com');
  if (isStorageOnLocalhost || !photoUrl) {
    element.style.backgroundImage = `url('${fallback}')`;
    return;
  }
  // Never request Firebase Storage on localhost — swap to a local fallback first.
  const safeUrl = sanitizeProfilePhotoUrl(photoUrl, profile);
  if (!safeUrl || safeUrl.startsWith('data:')) {
    // Local data URL (initials SVG or Base64) — apply directly, no network request.
    element.style.backgroundImage = `url('${safeUrl || fallback}')`;
    return;
  }
  const img = new Image();
  img.onload = () => {
    if (element) element.style.backgroundImage = `url('${addSizeToGoogleProfilePic(safeUrl)}')`;
  };
  // CORS/network failure on any CDN — replace with a placeholder so no broken image is shown.
  img.onerror = () => {
    if (element) element.style.backgroundImage = `url('${fallback}')`;
  };
  img.src = safeUrl;
}

function downscaleImageDataUrl(dataUrl, maxDim) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      } catch (err) {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function applyRoleBasedProfileForm(profile) {
  const isUserTeacher = isTeacher(profile);
  const isUserStudent = isStudent(profile);
  const groups = document.querySelectorAll('#profile-form [data-profile-role]');
  groups.forEach((group) => {
    const roles = (group.getAttribute('data-profile-role') || 'common').split(/\s+/);
    const show = roles.includes('common') ||
      (isUserTeacher && roles.includes('teacher')) ||
      (isUserStudent && roles.includes('student'));
    group.style.display = show ? '' : 'none';
  });
}

let profileSaveInFlight = false;

async function onProfileFormSubmit(e) {
  e.preventDefault();
  e.stopPropagation();
  if (profileSaveInFlight) return;
  profileSaveInFlight = true;
  const alertElement = document.getElementById('profile-alert-msg');
  const saveBtn = document.getElementById('save-profile-btn');
  if (saveBtn) saveBtn.disabled = true;
  try {
    const user = getAuth().currentUser;
    if (!user) throw new Error('No active authenticated user found.');

    // Safely query by ID with fallback chains in case an input id is renamed.
    const formVal = (...ids) => {
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el) return el.value || '';
      }
      return '';
    };
    const role = formVal('profile-input-role', 'profile-role');
    const common = {
      displayName: formVal('profile-input-name', 'profile-full-name'),
      role: role,
      department: formVal('profile-input-department', 'profile-dept'),
      phone: formVal('profile-input-phone', 'profile-phone'),
      photoURL: (currentUserProfile && currentUserProfile.photoURL) || '',
    };
    // Extract only the fields relevant to the current role.
    const updatedData = role === 'teacher'
      ? {
          ...common,
          teacherId: formVal('profile-input-teacher-id', 'profile-teacher-id'),
          designation: formVal('profile-input-designation', 'profile-designation'),
          officeRoom: formVal('profile-input-office-room', 'profile-office', 'profile-office-room')
        }
      : {
          ...common,
          studentId: formVal('profile-input-student-id', 'profile-student-id'),
          semester: formVal('profile-input-semester', 'profile-semester'),
          session: formVal('profile-input-session', 'profile-session')
        };
    const updateResult = await updateProfile(
      user.uid,
      updatedData,
      selectedProfileImageFile,
      selectedProfileImageDataUrl
    );
    const photoUploadSkipped = !!(updateResult && updateResult._photoUploadSkipped);
    let updatedUser = updateResult;

    if (!updatedUser) {
      // Firestore write succeeded but the read-back failed; merge locally so the UI never loses the profile.
      // When Storage was blocked, fall back to the locally-prepared Base64 photo.
      const localPhoto = selectedProfileImageDataUrl || (currentUserProfile && currentUserProfile.photoURL) || '';
      updatedUser = {
        ...(currentUserProfile || {}),
        ...updatedData,
        uid: user.uid,
        photoURL: localPhoto
      };
    }

    currentUserProfile = updatedUser;
    window.currentUserProfile = updatedUser;
    selectedProfileImageFile = null;
    selectedProfileImageDataUrl = null;
    saveProfileToStorage(updatedUser);
    populateProfileForm(updatedUser);
    refreshProfileSummaryUI(updatedUser);
    applyRoleBasedUI(updatedUser);
    showAppToast('Profile updated successfully!');
    if (photoUploadSkipped) {
      showAppToast('Profile saved! (Photo upload bypassed due to storage network policy)', 'info');
    }
    if (alertElement) {
      alertElement.className = 'profile-alert success';
      alertElement.textContent = 'Profile updated successfully!';
      alertElement.style.display = 'block';
      setTimeout(() => { alertElement.style.display = 'none'; }, 4000);
    }
  } catch (error) {
    console.error('Profile Save Failed:', error);
    // Revert any local photo preview so the UI shows the last successfully saved avatar.
    if (selectedProfileImageFile) {
      selectedProfileImageFile = null;
      selectedProfileImageDataUrl = null;
      populateProfileForm(currentUserProfile);
    }
    if (alertElement) {
      alertElement.className = 'profile-alert error';
      alertElement.textContent = 'Failed to save profile changes. Please try again.';
      alertElement.style.display = 'block';
    }
    showAppToast('Failed to save profile: ' + ((error && error.message) || error), 'error');
  } finally {
    if (saveBtn) saveBtn.disabled = false;
    profileSaveInFlight = false;
  }
}

function applyRoleBasedUI(profile) {
  const isUserTeacher = isTeacher(profile);
  const isUserStudent = isStudent(profile);

  // Pending/rejected card is no longer used — students get immediate access.
  // Account-level approval was removed; classroom access is gated per-course
  // via join requests, not per-account.
  const pendingCard = document.getElementById('pending-status-card');
  const studentContent = document.getElementById('student-dashboard-content');
  if (pendingCard && studentContent) {
    pendingCard.style.display = 'none';
    studentContent.style.display = 'block';
  }

  // Show/Hide Teacher-only navigation items in sidebar
  const approvalsTab = document.querySelector('.nav-item[data-tab="approvals"]');
  if (approvalsTab) {
    approvalsTab.style.display = isUserTeacher ? '' : 'none';
  }

  // Label customization for Student vs Teacher sidebar
  const classroomsTabLabel = document.querySelector('.nav-item[data-tab="classrooms"] span');
  if (classroomsTabLabel) {
    classroomsTabLabel.textContent = isUserTeacher ? 'Classrooms' : 'My Courses';
  }
  const chatTabLabel = document.querySelector('.nav-item[data-tab="chat"] span');
  if (chatTabLabel) {
    chatTabLabel.textContent = isUserTeacher ? 'Global Chat' : 'Discussion Forum';
  }
  const noticeTabLabel = document.querySelector('.nav-item[data-tab="notice-board"] span');
  if (noticeTabLabel) {
    noticeTabLabel.textContent = isUserTeacher ? 'Notice Board' : 'Announcements';
  }

  if (profile?.role) {
    localStorage.setItem('openclass_user_role', String(profile.role).toLowerCase());
  }

  // Role badge styling
  const badge = document.getElementById('topbar-role-badge');
  if (badge) {
    badge.textContent = displayRole(profile.role);
    badge.className = 'user-card-role role-badge ' + (isUserTeacher ? 'teacher' : 'student');
  }

  // Dashboard switching
  const teacherDash = document.getElementById('tab-dashboard');
  const studentDash = document.getElementById('tab-dashboard-student');
  const activeTab = document.querySelector('.tab-content.active-tab');

  if (isUserTeacher) {
    if (teacherDash) {
      teacherDash.style.display = 'block';
      teacherDash.classList.add('active-tab');
    }
    if (studentDash) {
      studentDash.style.display = 'none';
      studentDash.classList.remove('active-tab');
    }
  } else if (isUserStudent) {
    if (teacherDash) {
      teacherDash.style.display = 'none';
      teacherDash.classList.remove('active-tab');
    }
    if (studentDash) {
      studentDash.style.display = 'block';
      studentDash.classList.add('active-tab');
    }
  }

  // Classroom buttons: Teacher sees ONLY "Create Class", Student sees ONLY "Join Class"
  const btnCreateClass = document.getElementById('btn-create-classroom');
  if (btnCreateClass) btnCreateClass.style.display = isUserTeacher ? 'inline-flex' : 'none';
  const btnJoinClass = document.getElementById('btn-join-classroom');
  if (btnJoinClass) btnJoinClass.style.display = isUserTeacher ? 'none' : 'inline-flex';

  // Top-navbar button: "+ Create" for teachers, "+ Join Class" for students
  const btnCreateDropdown = document.getElementById('btn-create-dropdown');
  if (btnCreateDropdown) {
    if (isUserTeacher) {
      btnCreateDropdown.innerHTML = '<i class="material-icons" style="font-size:18px">add</i> Create <i class="material-icons" style="font-size:16px;vertical-align:middle;">arrow_drop_down</i>';
    } else {
      btnCreateDropdown.innerHTML = '<i class="material-icons" style="font-size:18px">login</i> Join Class';
      btnCreateDropdown.onclick = (e) => {
        e.stopPropagation();
        const modalJoin = document.getElementById('modal-join-classroom');
        if (modalJoin) modalJoin.style.display = 'flex';
      };
    }
  }

  // Top-navbar dropdown items
  const menuCreateClass = document.getElementById('menu-create-class');
  if (menuCreateClass) menuCreateClass.style.display = isUserTeacher ? 'flex' : 'none';
  const menuJoinClass = document.getElementById('menu-join-class');
  if (menuJoinClass) menuJoinClass.style.display = isUserTeacher ? 'none' : 'flex';
  const createMenu = document.getElementById('create-menu');
  if (createMenu) createMenu.style.display = 'none';

  const btnCreateAssignment = document.getElementById('btn-create-assignment');
  if (btnCreateAssignment) btnCreateAssignment.style.display = 'none';
  const btnCreateQuiz = document.getElementById('btn-create-quiz');
  if (btnCreateQuiz) btnCreateQuiz.style.display = 'none';

  // Classroom quick action
  const teacherQuickActions = document.getElementById('teacher-quick-actions');
  const studentQuickActions = document.getElementById('student-quick-actions');
  if (teacherQuickActions) teacherQuickActions.style.display = isUserTeacher ? '' : 'none';
  if (studentQuickActions) studentQuickActions.style.display = isUserStudent ? '' : 'none';

  // Presence tracking
  if (profile?.uid) {
    setOnline(profile.uid);
    subscribePresence(profile.uid, (status) => {
      currentUserOnlineStatus = status;
    });
  }
}

async function authStateObserver(user) {
  if (user) {
    // Always load the authoritative profile + role from Firestore
    currentUserProfile = await getUser(user.uid);

    // If the document does not exist yet (e.g. brand-new signup), create it
    // with the selected role. Do not overwrite an existing user document.
    if (!currentUserProfile) {
      if (window.__pendingRole) {
        // Registration flow (email/Google register) staged a role already.
        currentUserProfile = await createUser(
          user,
          window.__pendingRole,
          window.__pendingExtraData || {}
        );
      } else {
        // First-time login (e.g. "Sign in with Google") with no role chosen.
        // Block until the user selects Student or Teacher.
        const chosenRole = await showFirstLoginRoleModal();
        currentUserProfile = await createUser(user, chosenRole, {});
      }
    }
    window.__pendingRole = undefined;
    window.__pendingExtraData = undefined;

    // Retry once more to handle any race during signup
    if (!currentUserProfile) {
      console.log('User profile not found, retrying once...');
      await new Promise(resolve => setTimeout(resolve, 500));
      currentUserProfile = await getUser(user.uid);
    }

    // If still no profile after retry, fall back to a persisted role if present
    if (!currentUserProfile) {
      const cached = getProfileFromStorage(user.uid);
      if (cached && cached.uid === user.uid) {
        currentUserProfile = cached;
      }
    }

    // If still no profile, this is an error - sign out
    if (!currentUserProfile) {
      console.error('User profile not found in Firestore after retry');
      signOutUser();
      showAuth();
      return;
    }

    // Persist profile + role for session persistence
    saveProfileToStorage(currentUserProfile);

    var profilePicUrl = getProfilePicUrl();
    var userName = getUserName();
    userPicElement.style.backgroundImage = 'url(' + addSizeToGoogleProfilePic(profilePicUrl) + ')';
    userNameElement.textContent = userName;
    userNameElement.removeAttribute('hidden');
    userPicElement.removeAttribute('hidden');
    signOutButtonElement.removeAttribute('hidden');
    signInButtonElement.setAttribute('hidden', 'true');
    signInButtonElement.style.display = 'none';
    
    populateProfileForm(currentUserProfile);
    applyRoleBasedUI(currentUserProfile);

    // Live-listen to this user's document so profile edits and role changes
    // reflect instantly. Account-level approval was removed, so no pending/
    // rejected modal is shown here.
    if (userStatusUnsub) userStatusUnsub();
    userStatusUnsub = onSnapshot(doc(getFirestore(), 'users', user.uid), (snap) => {
      if (!snap.exists()) return;
      const updated = { uid: user.uid, ...snap.data() };
      currentUserProfile = updated;
      window.currentUserProfile = updated;
      saveProfileToStorage(updated);
      populateProfileForm(updated);
      applyRoleBasedUI(updated);
    });

    if (classroomsUnsubscribe) classroomsUnsubscribe();
    classroomsUnsubscribe = subscribeToUserClassrooms(user.uid, currentUserProfile?.role || '', renderClassrooms);
    
    // Role-based dashboard redirect
    redirectToDashboard(currentUserProfile);
    
    if (dashboardUnsubscribe) dashboardUnsubscribe();
    dashboardUnsubscribe = subscribeDashboardData(user.uid, currentUserProfile?.role || '', (update) => {
      handleDashboardUpdate(update);
    });
    saveMessagingDeviceToken();
    initCalendarAndNotifications();

    // Initialize Online Active Status, Floating Messenger & Messenger Tab UI
    window.currentUserProfile = currentUserProfile;
    setOnline(user.uid);
    initFloatingMessenger(currentUserProfile || user);
    initMessengerTab(currentUserProfile || user);

    if (userPrivateChatsUnsub) userPrivateChatsUnsub();
    userPrivateChatsUnsub = subscribeAllUserPrivateChats(user.uid, (chats) => {
      let totalUnread = 0;
      chats.forEach((chat) => {
        const lastMsg = chat.lastMessage;
        if (lastMsg && lastMsg.senderId !== user.uid) {
          totalUnread += 1;
          const msgKey = `${chat.id}_${lastMsg.timestamp?.seconds || lastMsg.timestamp}`;
          if (!notifiedMessageIds.has(msgKey)) {
            notifiedMessageIds.add(msgKey);
            showChatToastAlert(
              { uid: lastMsg.senderId, displayName: lastMsg.senderName, photoURL: lastMsg.senderPhoto || '' },
              lastMsg.text || 'Sent a message',
              () => {
                openFloatingMessenger({
                  uid: lastMsg.senderId,
                  displayName: lastMsg.senderName,
                  photoURL: lastMsg.senderPhoto || '',
                  role: 'user'
                });
              }
            );
          }
        }
      });

      // NOTE: Private-chat unread counts intentionally do NOT touch the
      // notification bell badge (#notif-badge) — that badge must reflect ONLY
      // the `notifications` collection so it stays in sync with the dropdown
      // list. Chat unread is surfaced via the toast alerts above.
    });
  } else {
    // Close any open first-login role modal
    const roleModal = document.getElementById('modal-role-select');
    if (roleModal) roleModal.style.display = 'none';
    if (roleSelectionResolve) {
      roleSelectionResolve(null);
      roleSelectionResolve = null;
    }
    const prevUid = currentUserProfile?.uid || getAuth().currentUser?.uid;
    if (prevUid) clearProfileFromStorage(prevUid);
    currentUserProfile = null;
    userNameElement.setAttribute('hidden', 'true');
    userPicElement.setAttribute('hidden', 'true');
    signOutButtonElement.setAttribute('hidden', 'true');
    const topbarRoleBadge = document.getElementById('topbar-role-badge');
    if (topbarRoleBadge) topbarRoleBadge.setAttribute('hidden', 'true');
    signInButtonElement.removeAttribute('hidden');
    signInButtonElement.style.display = '';
    if (classroomsUnsubscribe) { classroomsUnsubscribe(); classroomsUnsubscribe = null; }
    if (dashboardUnsubscribe) { dashboardUnsubscribe(); dashboardUnsubscribe = null; }
    if (userStatusUnsub) { userStatusUnsub(); userStatusUnsub = null; }
    if (chatChannelsUnsubscribe) { chatChannelsUnsubscribe(); chatChannelsUnsubscribe = null; }
    if (chatMessagesUnsubscribe) { chatMessagesUnsubscribe(); chatMessagesUnsubscribe = null; }
    if (chatTypingUnsubscribe) { chatTypingUnsubscribe(); chatTypingUnsubscribe = null; }
    unsubscribeAll();
    const btnCreate = document.getElementById('btn-create-classroom');
    const btnJoin = document.getElementById('btn-join-classroom');
    if (btnCreate) btnCreate.style.display = 'none';
    if (btnJoin) btnJoin.style.display = 'none';
    const createMenu = document.getElementById('create-menu');
    if (createMenu) createMenu.style.display = 'none';
    const menuCreateClass = document.getElementById('menu-create-class');
    if (menuCreateClass) menuCreateClass.style.display = 'none';
    const listEl = document.getElementById('classroom-list');
    if (listEl) {
      listEl.innerHTML = `
        <div class="empty-state-lg" id="classroom-empty-state">
          <img src="https://www.gstatic.com/images/branding/product/2x/classroom_64dp.png" alt="Classroom" style="width: 64px; opacity: 0.5; margin-bottom: 20px;">
          <h2>No classrooms yet</h2>
          <p id="classroom-empty-text">Sign in and join or create a classroom to get started.</p>
        </div>`;
    }
  }
}

function redirectToDashboard(profile) {
  if (!profile) return;
  const navItems = document.querySelectorAll('.nav-menu .nav-item[data-tab]');
  const target = Array.from(navItems).find(item => item.getAttribute('data-tab') === 'dashboard');
  if (target) {
    setTimeout(() => target.click(), 300);
  }
}

function checkSignedInWithMessage() {
  if (isUserSignedIn()) return true;
  var data = { message: 'You must sign-in first', timeout: 2000 };
  signInSnackbarElement.MaterialSnackbar.showSnackbar(data);
  return false;
}

function resetMaterialTextfield(element) {
  element.value = '';
  element.parentNode.MaterialTextfield.boundUpdateClassesHandler();
}

var MESSAGE_TEMPLATE =
    '<div class="message-container">' +
      '<div class="pic"></div>' +
      '<div class="msg-content-wrapper">' +
        '<div class="msg-header">' +
          '<span class="name"></span>' +
          '<span class="msg-time"></span>' +
        '</div>' +
        '<div class="message"></div>' +
        '<div class="msg-seen"></div>' +
      '</div>' +
    '</div>';

function addSizeToGoogleProfilePic(url) {
  if (url && url.indexOf('googleusercontent.com') !== -1 && url.indexOf('?') === -1) {
    return url + '?sz=150';
  }
  return url || '/images/profile_placeholder.png';
}

var LOADING_IMAGE_URL = 'https://www.google.com/images/spin-32.gif?a';

function createAndInsertMessage(id, timestamp) {
  const container = document.createElement('div');
  container.innerHTML = MESSAGE_TEMPLATE;
  const div = container.firstChild;
  div.setAttribute('id', id);
  timestamp = timestamp ? timestamp.toMillis() : Date.now();
  div.setAttribute('timestamp', timestamp);
  const existingMessages = messageListElement.children;
  if (existingMessages.length === 0) {
    messageListElement.appendChild(div);
  } else {
    let messageListNode = existingMessages[0];
    while (messageListNode) {
      const messageListNodeTime = messageListNode.getAttribute('timestamp');
      if (!messageListNodeTime) {
        throw new Error(`Child ${messageListNode.id} has no 'timestamp' attribute`);
      }
      if (messageListNodeTime > timestamp) break;
      messageListNode = messageListNode.nextSibling;
    }
    messageListElement.insertBefore(div, messageListNode);
  }
  return div;
}

function displayMessage(id, timestamp, name, text, picUrl, imageUrl, seenBy) {
  var div = document.getElementById(id) || createAndInsertMessage(id, timestamp);
  if (picUrl) {
    div.querySelector('.pic').style.backgroundImage = 'url(' + addSizeToGoogleProfilePic(picUrl) + ')';
  }
  div.querySelector('.name').textContent = name;
  var timeEl = div.querySelector('.msg-time');
  if (timeEl && timestamp) {
    var d = timestamp.toMillis ? new Date(timestamp.toMillis()) : new Date(timestamp);
    var now = new Date();
    var diff = now - d;
    if (diff < 60000) timeEl.textContent = 'just now';
    else if (diff < 3600000) timeEl.textContent = Math.floor(diff / 60000) + 'm ago';
    else if (diff < 86400000) timeEl.textContent = Math.floor(diff / 3600000) + 'h ago';
    else timeEl.textContent = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  var messageElement = div.querySelector('.message');
  if (text) {
    messageElement.textContent = text;
    messageElement.innerHTML = messageElement.innerHTML.replace(/\n/g, '<br>');
  } else if (imageUrl) {
    var image = document.createElement('img');
    image.addEventListener('load', function() {
      messageListElement.scrollTop = messageListElement.scrollHeight;
    });
    image.src = imageUrl + '&' + new Date().getTime();
    messageElement.innerHTML = '';
    messageElement.appendChild(image);
  }
  var seenEl = div.querySelector('.msg-seen');
  if (seenEl && seenBy && seenBy.length > 0) {
    seenEl.innerHTML = '<i class="material-icons seen-read">done_all</i> Seen';
  }
  setTimeout(function() {div.classList.add('visible')}, 1);
  messageListElement.scrollTop = messageListElement.scrollHeight;
  messageInputElement.focus();
}

function toggleButton() {
  if (messageInputElement.value) {
    submitButtonElement.removeAttribute('disabled');
  } else {
    submitButtonElement.setAttribute('disabled', 'true');
  }
}

function showApp() {
  const loadingEl = document.getElementById('loading-screen');
  const authEl = document.getElementById('auth-container');
  const appEl = document.querySelector('.app-layout');
  const signInEl = document.getElementById('sign-in');
  if (loadingEl) {
    loadingEl.classList.add('hidden');
    loadingEl.style.display = 'none';
  }
  if (authEl) authEl.style.display = 'none';
  if (appEl) appEl.style.display = 'flex';
  if (signInEl) signInEl.style.display = 'none';
}

function showAuth() {
  const loadingEl = document.getElementById('loading-screen');
  const authEl = document.getElementById('auth-container');
  const appEl = document.querySelector('.app-layout');
  if (loadingEl) {
    loadingEl.classList.add('hidden');
    loadingEl.style.display = 'none';
  }
  if (authEl) authEl.style.display = 'block';
  if (appEl) appEl.style.display = 'none';
  const splash = document.getElementById('screen-splash');
  const welcome = document.getElementById('screen-welcome');
  if (splash) splash.style.display = 'flex';
  if (welcome) welcome.style.display = 'none';
  setTimeout(() => {
    if (splash) splash.style.display = 'none';
    if (welcome) welcome.style.display = 'flex';
  }, 2000);
}

function showAuthError(elementId, message) {
  const el = document.getElementById(elementId);
  if (el) {
    el.textContent = message;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 5000);
  }
}

async function handleEmailLogin(e) {
  e.preventDefault();
  const email = document.getElementById('auth-email').value;
  const password = document.getElementById('auth-password').value;
  window.__pendingRole = undefined;
  window.__pendingExtraData = undefined;
  try {
    await signInWithEmailAndPassword(getAuth(), email, password);
  } catch (err) {
    showAuthError('auth-error-msg', err.message);
  }
}

async function handleEmailRegister(e) {
  e.preventDefault();
  const name = document.getElementById('auth-reg-name').value.trim();
  const email = document.getElementById('auth-reg-email').value.trim();
  const password = document.getElementById('auth-reg-password').value;
  const confirm = document.getElementById('auth-reg-confirm').value;
  const role = document.getElementById('auth-reg-role').value;
  
  if (!role) {
    showAuthError('auth-reg-error-msg', 'Please select a role (Student or Teacher).');
    return;
  }
  
  if (password !== confirm) {
    showAuthError('auth-reg-error-msg', 'Passwords do not match.');
    return;
  }
  
  const normalizedRole = normalizeRole(role);
  if (!isValidRole(normalizedRole)) {
    showAuthError('auth-reg-error-msg', 'Invalid role. Choose either Student or Teacher.');
    return;
  }

  let extraData;
  let classroomInfo = null;
  
  if (normalizedRole === ROLES.TEACHER) {
    extraData = {
      displayName: name,
      department: document.getElementById('auth-reg-teacher-dept')?.value || '',
      teacherId: document.getElementById('auth-reg-teacher-id')?.value || '',
      designation: document.getElementById('auth-reg-designation')?.value || '',
    };
  } else {
    // Join code is OPTIONAL for registration; a student can join a
    // classroom later from the Classrooms tab.
    const joinCode = document.getElementById('auth-reg-join-code')?.value?.trim();
    if (joinCode) {
      const validation = await validateJoinCode(joinCode);
      if (!validation.valid) {
        showAuthError('auth-reg-error-msg', validation.error);
        return;
      }
      classroomInfo = validation;
    }
    extraData = {
      displayName: name,
      department: document.getElementById('auth-reg-student-dept')?.value || '',
      studentId: document.getElementById('auth-reg-student-id')?.value || '',
      semester: document.getElementById('auth-reg-semester')?.value || '',
      classroomId: classroomInfo?.classroomId || '',
      classroomCode: classroomInfo?.classroomCode || '',
      teacherId: classroomInfo?.teacherId || '',
    };
  }
  
  // Stage the pending role BEFORE creating the auth user so that
  // onAuthStateChanged -> authStateObserver can create the Firestore
  // document with the correct role (no race condition).
  window.__pendingRole = normalizedRole;
  window.__pendingExtraData = extraData;
  
  try {
    const cred = await createUserWithEmailAndPassword(getAuth(), email, password);
    if (cred.user) {
      const { updateProfile } = await import('firebase/auth');
      await updateProfile(cred.user, { displayName: name });
      // Ensure the Firestore user document exists with the selected role
      await createUser(cred.user, normalizedRole, extraData);
      
      // For students, create the classroom join request document
      if (normalizedRole === ROLES.STUDENT && classroomInfo) {
        const db = getFirestore();
        const requestId = `${classroomInfo.classroomId}_${cred.user.uid}`;
        const requestDoc = {
          requestId,
          studentUid: cred.user.uid,
          uid: cred.user.uid,
          displayName: name,
          studentName: name,
          email,
          studentEmail: email,
          studentId: extraData.studentId || '',
          department: extraData.department || '',
          photoURL: '',
          role: ROLES.STUDENT,
          classId: classroomInfo.classroomId,
          className: classroomInfo.classroomName || '',
          classroomId: classroomInfo.classroomId,
          classroomName: classroomInfo.classroomName || '',
          classroomCode: classroomInfo.classroomCode || '',
          teacherUid: classroomInfo.teacherId || '',
          teacherId: classroomInfo.teacherId || '',
          status: 'pending',
          requestedAt: serverTimestamp(),
          createdAt: serverTimestamp(),
        };
        await setDoc(doc(db, 'classroomRequests', requestId), requestDoc);
        await setDoc(doc(db, 'classrooms', classroomInfo.classroomId, 'joinRequests', cred.user.uid), {
          uid: cred.user.uid,
          displayName: name,
          email,
          studentId: extraData.studentId || '',
          photoURL: '',
          role: ROLES.STUDENT,
          requestedAt: serverTimestamp(),
          status: 'pending',
        });
        if (classroomInfo.teacherId) {
          createNotification(classroomInfo.teacherId, 'join_request', 'New Join Request', `${name} requested to join ${classroomInfo.classroomName || 'your classroom'}`).catch(() => {});
        }
      }
    }
  } catch (err) {
    showAuthError('auth-reg-error-msg', err.message);
  }
}

async function handleGoogleAuth() {
  window.__pendingRole = undefined;
  window.__pendingExtraData = undefined;
  try {
    const provider = new GoogleAuthProvider();
    await signInWithPopup(getAuth(), provider);
  } catch (err) {
    showAuthError('auth-error-msg', err.message);
  }
}

async function handleGoogleRegister() {
  // Check if role is selected from the cards
  const role = document.getElementById('auth-reg-role').value;
  const normalizedRole = normalizeRole(role);
  if (!isValidRole(normalizedRole)) {
    showAuthError('auth-reg-error-msg', 'Please select a role (Student or Teacher) first.');
    return;
  }
  
  let extraData;
  if (normalizedRole === ROLES.TEACHER) {
    extraData = {
      displayName: '',
      department: document.getElementById('auth-reg-teacher-dept')?.value || '',
      teacherId: document.getElementById('auth-reg-teacher-id')?.value || '',
      designation: document.getElementById('auth-reg-designation')?.value || '',
    };
  } else {
    extraData = {
      displayName: '',
      department: document.getElementById('auth-reg-student-dept')?.value || '',
      studentId: document.getElementById('auth-reg-student-id')?.value || '',
      semester: document.getElementById('auth-reg-semester')?.value || '',
    };
  }
  
  // Stage the pending role BEFORE the popup so authStateObserver can
  // create the Firestore document with the correct role.
  window.__pendingRole = normalizedRole;
  window.__pendingExtraData = extraData;
  
  try {
    const provider = new GoogleAuthProvider();
    const cred = await signInWithPopup(getAuth(), provider);
    if (cred.user) {
      // Ensure the Firestore user document exists with the selected role
      await createUser(cred.user, normalizedRole, extraData);
    }
  } catch (err) {
    window.__pendingRole = undefined;
    window.__pendingExtraData = undefined;
    showAuthError('auth-reg-error-msg', err.message);
  }
}

async function handleForgotPassword() {
  const email = document.getElementById('auth-email').value;
  if (!email) {
    showAuthError('auth-error-msg', 'Please enter your email address first.');
    return;
  }
  try {
    const actionCodeSettings = {
      url: window.location.origin,
      handleCodeInApp: false,
    };
    await sendPasswordResetEmail(getAuth(), email, actionCodeSettings);
    showAuthError('auth-error-msg', 'Password reset email sent!');
  } catch (err) {
    showAuthError('auth-error-msg', err.message);
  }
}

async function handleGuestAuth() {
  try {
    await signInAnonymously(getAuth());
  } catch (err) {
    showAuthError('auth-error-msg', err.message);
  }
}

var messageListElement = document.getElementById('messages');
var messageFormElement = document.getElementById('message-form');
var messageInputElement = document.getElementById('message');
var submitButtonElement = document.getElementById('submit');
var imageButtonElement = document.getElementById('submitImage');
var imageFormElement = document.getElementById('image-form');
var mediaCaptureElement = document.getElementById('mediaCapture');
var userPicElement = document.getElementById('user-pic');
var userNameElement = document.getElementById('user-name');
var signInButtonElement = document.getElementById('sign-in');
var signOutButtonElement = document.getElementById('sign-out');
var signInSnackbarElement = document.getElementById('must-signin-snackbar');
var profileFormElement = document.getElementById('profile-form');
var profileFileInputElement = document.getElementById('profile-file-input');

messageFormElement?.addEventListener('submit', onMessageFormSubmit);
signOutButtonElement?.addEventListener('click', signOutUser);
signInButtonElement?.addEventListener('click', signIn);
messageInputElement?.addEventListener('keyup', toggleButton);
messageInputElement?.addEventListener('change', toggleButton);
imageButtonElement?.addEventListener('click', function(e) {
  e.preventDefault();
  mediaCaptureElement?.click();
});
mediaCaptureElement?.addEventListener('change', onMediaFileSelected);
if (profileFormElement) {
  profileFormElement.addEventListener('submit', onProfileFormSubmit);
}
const saveProfileButton = document.getElementById('save-profile-btn');
if (saveProfileButton) {
  saveProfileButton.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    onProfileFormSubmit(e);
  });
}
if (profileFileInputElement) {
  profileFileInputElement.addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file || !file.type.match('image.*')) return;
    selectedProfileImageFile = file;
    selectedProfileImageDataUrl = null;
    const reader = new FileReader();
    reader.onload = async function(evt) {
      const rawDataUrl = evt.target.result;
      const avatarImg = document.getElementById('profile-avatar');
      if (avatarImg) {
        avatarImg.style.backgroundImage = `url('${rawDataUrl}')`;
      }
      // Keep a compact Base64 copy for the CORS fallback path so the
      // avatar can still be persisted to Firestore when Storage is blocked.
      try {
        selectedProfileImageDataUrl = await downscaleImageDataUrl(rawDataUrl, 256);
      } catch (err) {
        console.warn('Could not downscale profile photo for fallback:', err);
        selectedProfileImageDataUrl = rawDataUrl;
      }
    };
    reader.readAsDataURL(file);
  });
}

// Role selection card handlers
document.getElementById('role-student-btn')?.addEventListener('click', function() {
  selectRole(ROLES.STUDENT);
});
document.getElementById('role-teacher-btn')?.addEventListener('click', function() {
  selectRole(ROLES.TEACHER);
});

function selectRole(role) {
  const normalized = normalizeRole(role);
  const roleInput = document.getElementById('auth-reg-role');
  const studentBtn = document.getElementById('role-student-btn');
  const teacherBtn = document.getElementById('role-teacher-btn');
  const studentFields = document.querySelectorAll('.reg-field-student');
  const teacherFields = document.querySelectorAll('.reg-field-teacher');
  const submitBtn = document.getElementById('auth-register-btn');

  roleInput.value = normalized;
  
  studentBtn.classList.toggle('selected', normalized === ROLES.STUDENT);
  teacherBtn.classList.toggle('selected', normalized === ROLES.TEACHER);

  studentFields.forEach(field => field.style.display = normalized === ROLES.STUDENT ? '' : 'none');
  teacherFields.forEach(field => field.style.display = normalized === ROLES.TEACHER ? '' : 'none');

  submitBtn.disabled = false;
}

document.getElementById('auth-login-form')?.addEventListener('submit', handleEmailLogin);
document.getElementById('auth-register-form')?.addEventListener('submit', handleEmailRegister);
document.getElementById('auth-google-btn')?.addEventListener('click', handleGoogleAuth);
document.getElementById('auth-google-reg-btn')?.addEventListener('click', handleGoogleRegister);
document.getElementById('auth-forgot-btn')?.addEventListener('click', handleForgotPassword);

// First-login role selection modal
document.getElementById('role-select-student')?.addEventListener('click', () => selectFirstLoginRole('student'));
document.getElementById('role-select-teacher')?.addEventListener('click', () => selectFirstLoginRole('teacher'));
document.getElementById('role-select-confirm')?.addEventListener('click', confirmFirstLoginRole);

// Clear form fields on app startup (but NOT Firebase auth session)
clearAuthData();

try {
  const firebaseApp = initializeApp(getFirebaseConfig());
  getPerformance();
  // Register onAuthStateChanged only once
  onAuthStateChanged(getAuth(), async (user) => {
    try {
      if (user) {
        console.log('[Auth] User signed in:', user.uid, user.email);
        showApp();
        await authStateObserver(user);
        updateHeroGreeting();
        loadInitialChannels();
        
        // Guaranteed classroom loading check: if classroomsUnsubscribe is still null,
        // it means authStateObserver failed to set it up. Force it.
        if (!classroomsUnsubscribe) {
          console.warn('[Auth] classroomsUnsubscribe not set after authStateObserver. Force-loading classrooms.');
          const role = currentUserProfile?.role || localStorage.getItem('openclass_user_role') || 'teacher';
          classroomsUnsubscribe = subscribeToUserClassrooms(user.uid, role, renderClassrooms);
        }
      } else {
        console.log('[Auth] No user signed in');
        showAuth();
      }
    } catch (err) {
      console.error('[Auth] Error in auth state observer:', err);
      showApp();
      // Even on error, try to load classrooms if user exists
      if (user && !classroomsUnsubscribe) {
        try {
          console.warn('[Auth] Attempting emergency classroom load after error');
          const role = localStorage.getItem('openclass_user_role') || 'teacher';
          classroomsUnsubscribe = subscribeToUserClassrooms(user.uid, role, renderClassrooms);
        } catch (e2) {
          console.error('[Auth] Emergency classroom load also failed:', e2);
        }
      }
    }
  });
} catch (error) {
  console.warn('Firebase initialization failed — some features will be unavailable:', error);
  showAuth();
}

// Safety timeout: ensure loading screen is hidden after 2s
setTimeout(() => {
  const loadingEl = document.getElementById('loading-screen');
  if (loadingEl) {
    loadingEl.classList.add('hidden');
    loadingEl.style.display = 'none';
  }
}, 2000);

// Safety timeout: force-load classrooms after 4s if not already loaded
setTimeout(() => {
  const authUser = getAuth().currentUser;
  const listEl = document.getElementById('classroom-list');
  if (authUser && listEl && listEl.children.length === 0) {
    console.warn('[Safety] Classrooms not loaded after 4s. Force-loading for uid:', authUser.uid);
    const role = currentUserProfile?.role || localStorage.getItem('openclass_user_role') || 'teacher';
    if (classroomsUnsubscribe) classroomsUnsubscribe();
    classroomsUnsubscribe = subscribeToUserClassrooms(authUser.uid, role, renderClassrooms);
  }
}, 4000);

// ─── DASHBOARD ────────────────────────────────────────────────────

function handleDashboardUpdate(update) {
  const { type, data } = update;
  const isUserTeacher = currentUserProfile && isTeacher(currentUserProfile);
  switch (type) {
    case 'totalClassrooms': {
      const t = document.getElementById('dashboard-total-classrooms');
      if (t) t.textContent = data;
      const s = document.getElementById('student-total-classrooms');
      if (s) s.textContent = data;
      break;
    }
    case 'totalStudents': {
      const el = document.getElementById('dashboard-total-students');
      if (el) el.textContent = data;
      break;
    }
    case 'assignmentsCreated': {
      const el = document.getElementById('dashboard-assignments-created');
      if (el) el.textContent = data;
      break;
    }
    case 'quizzesCreated': {
      const el = document.getElementById('dashboard-quizzes-created');
      if (el) el.textContent = data;
      break;
    }
    case 'pendingAssignments': {
      const el = document.getElementById('student-pending-assignments');
      if (el) el.textContent = data;
      const teacherEl = document.getElementById('dashboard-pending-assignments');
      if (teacherEl) teacherEl.textContent = data;
      const subEl = document.getElementById('dashboard-hero-subtitle');
      if (subEl && isUserTeacher && typeof data === 'number') {
        subEl.textContent = data > 0
          ? `You have ${data} pending task${data > 1 ? 's' : ''} to review.`
          : 'All caught up! No pending reviews.';
      }
      const studentSubEl = document.getElementById('student-dashboard-hero-subtitle');
      if (studentSubEl && !isUserTeacher && typeof data === 'number') {
        studentSubEl.textContent = data > 0
          ? `You have ${data} assignment${data > 1 ? 's' : ''} due soon.`
          : 'All caught up! No pending assignments.';
      }
      break;
    }
    case 'upcomingQuizzes': {
      const el = document.getElementById('student-upcoming-quizzes');
      if (el) el.textContent = data;
      break;
    }
    case 'learningProgress': {
      const el = document.getElementById('student-learning-progress');
      if (el) el.textContent = data + '%';
      break;
    }
    case 'unreadMessages': {
      const t = document.getElementById('dashboard-unread-messages');
      if (t) t.textContent = data;
      const s = document.getElementById('student-unread-messages');
      if (s) s.textContent = data;
      break;
    }
    case 'recentActivity': {
      const listEl = document.getElementById('dashboard-activity-list');
      const studentRecentEl = document.getElementById('student-recent-activity-list');
      
      if (listEl) {
        if (!data || data.length === 0) {
          listEl.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:40px 0;color:var(--text-muted);">No recent activity.</div>';
        } else {
          listEl.innerHTML = '';
          data.slice(0, 10).forEach(item => {
            const div = document.createElement('div');
            div.className = 'timeline-item';
            const icon = item.type === 'classroom_created' ? 'add' :
                         item.type === 'classroom_joined' ? 'person_add' :
                         item.type === 'assignment_submitted' ? 'check' : 'notifications';
            const dotClass = item.type === 'assignment_submitted' ? 'primary' : '';
            const ts = item.timestamp ? item.timestamp.toMillis() : Date.now();
            const timeStr = timeAgo(ts);
            div.innerHTML = `
              <div class="timeline-dot ${dotClass}"><i class="material-icons">${icon}</i></div>
              <div class="timeline-content">
                <h4>${item.description || 'Activity'}</h4>
                <p>${item.userName || ''}</p>
                <span class="timeline-time">${timeStr}</span>
              </div>`;
            listEl.appendChild(div);
          });
        }
      }

      if (studentRecentEl) {
        if (!data || data.length === 0) {
          studentRecentEl.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:32px 0;color:var(--text-muted);">No recent activity updates yet.</div>';
        } else {
          studentRecentEl.innerHTML = '';
          data.slice(0, 6).forEach(item => {
            const div = document.createElement('div');
            div.className = 'timeline-item';
            const icon = item.type === 'assignment_submitted' ? 'assignment_turned_in' :
                         item.type === 'note_uploaded' ? 'description' :
                         item.type === 'grade_published' ? 'grade' : 'notifications';
            const ts = item.timestamp ? item.timestamp.toMillis() : Date.now();
            div.innerHTML = `
              <div class="timeline-dot primary"><i class="material-icons">${icon}</i></div>
              <div class="timeline-content">
                <h4 style="font-size:13.5px;margin-bottom:2px;">${item.description || 'Student Activity'}</h4>
                <p style="font-size:12px;color:var(--text-muted);">${item.userName || 'Instructor'} • ${timeAgo(ts)}</p>
              </div>`;
            studentRecentEl.appendChild(div);
          });
        }
      }
      break;
    }
    case 'upcomingDeadlines': {
      const listEl = document.getElementById('student-upcoming-deadlines-list');
      const mainListEl = document.getElementById('main-dashboard-upcoming-deadlines-list');
      const targets = [listEl, mainListEl].filter(Boolean);
      if (targets.length === 0) break;
      targets.forEach(t => {
        if (!data || data.length === 0) {
          t.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:32px 0;color:var(--text-muted);">No upcoming deadlines due.</div>';
        } else {
          t.innerHTML = '';
          data.slice(0, 5).forEach(item => {
            const div = document.createElement('div');
            div.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:12px 14px; background:rgba(255,255,255,0.02); border:1px solid var(--border); border-radius:10px; margin-bottom:10px;';
            div.innerHTML = `
              <div>
                <div style="font-weight:600; font-size:13.5px; color:#f8fafc; margin-bottom:2px;">${item.title || 'Assignment Deadline'}</div>
                <div style="font-size:12px; color:#94a3b8;">Course: ${item.courseName || 'Classroom'}</div>
              </div>
              <span class="badge ${item.urgent ? 'badge-danger' : 'badge-orange'}" style="font-size:11px;">${item.dueDateStr || 'Due Soon'}</span>
            `;
            t.appendChild(div);
          });
        }
      });
      break;
    }
    case 'notices': {
      const listEl = document.getElementById('notice-list');
      if (listEl) {
        if (!data || data.length === 0) {
          listEl.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:60px 0;color:var(--text-muted);">No notices yet.</div>';
        } else {
          listEl.innerHTML = '';
          data.forEach(n => {
            const card = document.createElement('div');
            card.className = 'notice-card';
            const ts = n.createdAt ? n.createdAt.toMillis() : Date.now();
            card.innerHTML = `
              <h4>${n.title || 'Announcement'}</h4>
              <p>${n.content || ''}</p>
              <div class="notice-meta">
                <span>${n.createdByName || 'System'}</span>
                <span>${timeAgo(ts)}</span>
              </div>`;
            listEl.appendChild(card);
          });
        }
      }
      const studentNotices = document.getElementById('student-notices-list');
      if (studentNotices) {
        if (!data || data.length === 0) {
          studentNotices.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:40px 0;color:var(--text-muted);">No notices yet.</div>';
        } else {
          studentNotices.innerHTML = '';
          data.slice(0, 5).forEach(n => {
            const card = document.createElement('div');
            card.className = 'notice-card';
            const ts = n.createdAt ? n.createdAt.toMillis() : Date.now();
            card.innerHTML = `
              <h4>${n.title || 'Announcement'}</h4>
              <p>${n.content || ''}</p>
              <div class="notice-meta">
                <span>${n.createdByName || 'System'}</span>
                <span>${timeAgo(ts)}</span>
              </div>`;
            studentNotices.appendChild(card);
          });
        }
      }
      break;
    }
  }
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function updateHeroGreeting() {
  const el = document.getElementById('dashboard-hero-greeting');
  if (el) {
    const name = getUserName();
    const hour = new Date().getHours();
    let greeting = 'Welcome back';
    if (hour < 12) greeting = 'Good morning';
    else if (hour < 17) greeting = 'Good afternoon';
    else greeting = 'Good evening';
    el.textContent = `${greeting}, ${name.split(' ')[0]}!`;
  }
  const studentEl = document.getElementById('student-dashboard-hero-greeting');
  if (studentEl) {
    const name = getUserName();
    const hour = new Date().getHours();
    let greeting = 'Welcome back';
    if (hour < 12) greeting = 'Good morning';
    else if (hour < 17) greeting = 'Good afternoon';
    else greeting = 'Good evening';
    studentEl.textContent = `${greeting}, ${name.split(' ')[0]}!`;
  }
  const dateEl = document.getElementById('current-date-display');
  if (dateEl) dateEl.textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const studentDateEl = document.getElementById('student-current-date-display');
  if (studentDateEl) studentDateEl.textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

// ─── CHAT CHANNELS ────────────────────────────────────────────────

function renderChannels(channels) {
  const listEl = document.getElementById('chat-channel-list');
  if (!listEl) return;
  listEl.innerHTML = '';
  if (channels.length === 0) {
    listEl.innerHTML = '<div style="padding:16px;color:var(--text-muted);font-size:13px;">No channels yet.</div>';
    return;
  }
  channels.forEach(ch => {
    const div = document.createElement('div');
    div.className = 'channel-item' + (currentChannelId === ch.id ? ' active' : '');
    div.dataset.channelId = ch.id;
    div.innerHTML = `<i class="material-icons">tag</i> ${ch.name}`;
    div.addEventListener('click', () => switchChannel(ch.id, ch.name));
    listEl.appendChild(div);
  });
}

function switchChannel(channelId, channelName) {
  if (channelId === currentChannelId) return;
  if (chatMessagesUnsubscribe) { chatMessagesUnsubscribe(); chatMessagesUnsubscribe = null; }
  if (chatTypingUnsubscribe) { chatTypingUnsubscribe(); chatTypingUnsubscribe = null; }
  if (typingTimeout) { clearTimeout(typingTimeout); typingTimeout = null; }
  currentChannelId = channelId;
  document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('active'));
  const activeEl = document.querySelector(`.channel-item[data-channel-id="${channelId}"]`);
  if (activeEl) activeEl.classList.add('active');
  const titleEl = document.getElementById('chat-current-channel-name');
  if (titleEl) titleEl.innerHTML = `<i class="material-icons text-muted">tag</i> ${channelName || 'General'}`;
  const inputEl = document.getElementById('message');
  if (inputEl) inputEl.placeholder = `Message #${channelName || 'General'}`;
  const msgContainer = document.getElementById('messages');
  if (msgContainer) msgContainer.innerHTML = '';
  chatMessagesUnsubscribe = subscribeToMessages(channelId, (msgs) => {
    if (msgContainer) msgContainer.innerHTML = '';
    msgs.forEach(m => {
      const seenBy = m.seenBy ? Object.keys(m.seenBy) : [];
      displayMessage(m.id, m.timestamp, m.senderName, m.text, m.senderPic, m.imageUrl, seenBy);
    });
    if (msgContainer) msgContainer.scrollTop = msgContainer.scrollHeight;
    if (getAuth().currentUser) {
      markChannelAsRead(channelId, getAuth().currentUser.uid);
    }
  });
  chatTypingUnsubscribe = subscribeToTyping(channelId, getAuth().currentUser?.uid || '', (typing) => {
    const typingEl = document.getElementById('chat-typing-indicator');
    const typingText = document.getElementById('chat-typing-text');
    if (!typingEl || !typingText) return;
    if (typing.length === 0) {
      typingEl.style.display = 'none';
      return;
    }
    const names = typing.map(t => t.displayName || 'Someone');
    if (names.length === 1) typingText.textContent = `${names[0]} is typing...`;
    else if (names.length === 2) typingText.textContent = `${names[0]} and ${names[1]} are typing...`;
    else typingText.textContent = `${names[0]} and ${names.length - 1} others are typing...`;
    typingEl.style.display = 'flex';
  });
}

function loadInitialChannels() {
  const user = getAuth().currentUser || currentUserProfile;
  if (user) {
    initMessengerTab(user);
  }
}

document.getElementById('btn-create-channel')?.addEventListener('click', async () => {
  const user = getAuth().currentUser;
  if (!user) return;
  const channelName = prompt('Enter new channel name (e.g. Math-Group):');
  if (!channelName || !channelName.trim()) return;
  try {
    const cleanName = channelName.trim().replace(/^#/, '');
    const newCh = await createChannel(cleanName, user.uid);
    switchChannel(newCh.id, cleanName);
  } catch (err) {
    alert('Error creating channel: ' + err.message);
  }
});

if (messageInputElement) {
  messageInputElement.addEventListener('input', () => {
    if (!currentChannelId || !getAuth().currentUser) return;
    setTyping(currentChannelId, getAuth().currentUser.uid, getUserName(), true);
    if (typingTimeout) clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      if (currentChannelId && getAuth().currentUser) {
        setTyping(currentChannelId, getAuth().currentUser.uid, getUserName(), false);
      }
    }, 2000);
  });
}

const emojiBtn = document.getElementById('chat-emoji-btn');
const emojiPicker = document.getElementById('chat-emoji-picker');
if (emojiBtn && emojiPicker) {
  emojiBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    emojiPicker.style.display = emojiPicker.style.display === 'none' ? 'block' : 'none';
  });
  document.addEventListener('click', () => { emojiPicker.style.display = 'none'; });
  emojiPicker.addEventListener('click', (e) => e.stopPropagation());
  document.querySelectorAll('.emoji-item').forEach(item => {
    item.addEventListener('click', () => {
      const emoji = item.dataset.emoji;
      if (messageInputElement) {
        messageInputElement.value += emoji;
        messageInputElement.dispatchEvent(new Event('input'));
        toggleButton();
      }
    });
  });
}

// ─── CLASSROOM MANAGEMENT ──────────────────────────────────────────────

let meetingDeepLinkHandled = false;

function buildLocalMeetingLink(roomName) {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('meeting', roomName);
  return url.toString();
}

function extractRoomNameFromLink(link, fallback) {
  if (!link) return fallback;
  try {
    const url = new URL(link, window.location.origin);
    const q = url.searchParams.get('meeting');
    if (q) return decodeURIComponent(q);
  } catch (err) { /* ignore */ }
  if (link.includes('meet.jit.si')) {
    const m = link.match(/meet\.jit\.si\/([^#?]+)/);
    if (m) return decodeURIComponent(m[1]);
  }
  return fallback;
}

/**
 * Opens the embedded meeting UI when the app loads with a `?meeting=<room>` deep link.
 */
function handleMeetingDeepLink() {
  if (meetingDeepLinkHandled || !currentUserProfile) return;
  const params = new URLSearchParams(window.location.search);
  const roomName = params.get('meeting');
  if (!roomName) return;
  meetingDeepLinkHandled = true;
  const known = activeMeetingDataList.find((m) => m.roomName === roomName);
  const meeting = known || { title: 'OpenClass Live Session', roomName, status: 'active' };
  setTimeout(() => {
    openInAppMeeting(meeting, currentUserProfile);
    const url = new URL(window.location.href);
    url.searchParams.delete('meeting');
    window.history.replaceState({}, '', url.toString());
  }, 500);
}

function showAppToast(message, type = 'success') {
  let toastContainer = document.getElementById('app-toast-container');
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.id = 'app-toast-container';
    toastContainer.style.cssText =
      'position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:99999;' +
      'display:flex;flex-direction:column;gap:10px;align-items:center;pointer-events:none;';
    document.body.appendChild(toastContainer);
  }
  const toast = document.createElement('div');
  const isError = type === 'error';
  const bg = isError ? '#b91c1c' : type === 'info' ? '#2563eb' : '#059669';
  const icon = isError ? 'error_outline' : type === 'info' ? 'info' : 'check_circle';
  toast.style.cssText =
    `display:flex;align-items:center;gap:10px;background:${bg};color:#fff;` +
    'padding:12px 20px;border-radius:10px;font-size:14px;font-weight:500;' +
    'box-shadow:0 8px 24px rgba(0,0,0,.25);max-width:90vw;animation:toastIn .25s ease;';
  toast.innerHTML = `<i class="material-icons" style="font-size:18px;">${icon}</i><span>${message}</span>`;
  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.transition = 'opacity .3s';
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

var renderClassrooms = function renderClassroomsBase(classrooms, errorMsg) {
  const listEl = document.getElementById('classroom-list');
  if (!listEl) return;

  // Clear loading state and any existing content immediately
  listEl.innerHTML = '';

  try {
  if (currentUserProfile) {
    try {
      initLiveMeetingsModule(currentUserProfile, classrooms);
    } catch (e) {
      console.error('Error initializing live meetings:', e);
    }
    try {
      handleMeetingDeepLink();
    } catch (e) {
      console.error('Error handling meeting deep link:', e);
    }
    if (isStudent(currentUserProfile)) {
      try {
        initStudentDashboardFeatures(currentUserProfile, classrooms);
      } catch (e) {
        console.error('Error initializing student dashboard features:', e);
      }
    }
  }
  
  if (errorMsg) {
    listEl.insertAdjacentHTML('beforeend', `
      <div class="gc-alert-banner" style="display:flex; align-items:center; gap:8px; background:#fef2f2; color:#b91c1c; border:1px solid #fecaca; border-radius:8px; padding:12px 16px; margin:0 0 16px; font-size:14px;">
        <i class="material-icons" style="font-size:18px;">error_outline</i>
        <span>${errorMsg}</span>
      </div>`);
  }
  
  if (classrooms.length === 0) {
    const roleVal = (currentUserProfile?.role || localStorage.getItem('openclass_user_role') || (JSON.parse(localStorage.getItem('openclass_user_profile') || '{}').role) || '').toLowerCase();
    const isUserTeacher = roleVal === 'teacher' || roleVal === 'admin';
    if (isUserTeacher) {
      listEl.innerHTML = `
        <div class="empty-state-lg" id="classroom-empty-state" style="text-align:center; padding:50px 20px;">
          <img src="https://www.gstatic.com/images/branding/product/2x/classroom_64dp.png" alt="Classroom" style="width: 64px; opacity: 0.6; margin-bottom: 20px;">
          <h2>No classrooms created yet</h2>
          <p id="classroom-empty-text" style="color:var(--text-muted); max-width:440px; margin:0 auto 20px auto;">Create a new classroom to start managing your students and live sessions.</p>
          <div style="display:flex; gap:12px; justify-content:center; flex-wrap:wrap;">
            <button type="button" class="btn btn-primary" onclick="const m=document.getElementById('modal-create-classroom'); if(m){ m.style.display='flex'; m.style.zIndex='999999'; }">
              <i class="material-icons">add</i> Create Class
            </button>
            <button type="button" id="btn-load-sample-teacher-class" class="btn btn-outline" style="padding:10px 20px; font-size:13px;">
              <i class="material-icons" style="color:var(--primary); font-size:18px;">auto_awesome</i> Load Sample Class
            </button>
          </div>
        </div>`;

      const sampleTeacherBtn = document.getElementById('btn-load-sample-teacher-class');
      if (sampleTeacherBtn) {
        sampleTeacherBtn.onclick = () => {
          const teacherUid = currentUserProfile?.uid || getAuth().currentUser?.uid || 'teacher-id';
          const sampleClass = {
            classroomId: 'cs101-teacher-demo',
            classroomName: 'Computer Science 101: Web Development',
            subject: 'Computer Science',
            section: 'Section A (Fall 2026)',
            classroomCode: 'CS101DEMO',
            teacherName: currentUserProfile?.displayName || 'Teacher',
            teacherEmail: currentUserProfile?.email || 'teacher@openclass.edu',
            memberCount: 24,
            description: 'Master HTML5, CSS3, JavaScript, web development architecture, and cloud apps.',
            createdAt: { seconds: Date.now() / 1000 },
            createdBy: teacherUid,
            teacherId: teacherUid,
            themeColor: 'blue',
            isActive: true
          };
          renderClassrooms([sampleClass]);
        };
      }
    } else {
      listEl.innerHTML = `
        <div class="empty-state-lg" id="classroom-empty-state" style="text-align:center; padding:40px 24px; background:var(--card-bg); border:1px solid var(--border); border-radius:16px; margin-top:10px;">
          <div style="width:64px; height:64px; border-radius:50%; background:rgba(59,130,246,0.12); color:var(--primary); display:flex; align-items:center; justify-content:center; margin:0 auto 16px auto;">
            <i class="material-icons" style="font-size:36px;">school</i>
          </div>
          <h2 style="margin-bottom:8px; font-size:22px; color:var(--text-main);">Welcome to Your Student Workspace!</h2>
          <p id="classroom-empty-text" style="color:var(--text-muted); max-width:460px; margin:0 auto 24px auto; font-size:14px; line-height:1.5;">
            You haven't joined any classrooms yet. Enter your teacher's class code to join, or click below to load a sample demo classroom.
          </p>
          <div style="display:flex; gap:12px; justify-content:center; flex-wrap:wrap;">
            <button type="button" class="btn btn-primary" style="padding:10px 22px; font-size:13px;" onclick="document.getElementById('btn-join-classroom')?.click()">
              <i class="material-icons" style="font-size:18px;">login</i> Join Class with Code
            </button>
            <button type="button" id="btn-load-sample-student-class" class="btn btn-outline" style="padding:10px 20px; font-size:13px;">
              <i class="material-icons" style="color:var(--primary); font-size:18px;">auto_awesome</i> Load Sample Class
            </button>
          </div>
        </div>`;

      const sampleBtn = document.getElementById('btn-load-sample-student-class');
      if (sampleBtn) {
        sampleBtn.onclick = () => {
          const sampleClass = {
            classroomId: 'cs101-demo-class',
            classroomName: 'Computer Science 101: Web Development',
            subject: 'Computer Science',
            section: 'Section A (Fall 2026)',
            classroomCode: 'CS101DEMO',
            teacherName: 'Dr. Alan Turing',
            teacherEmail: 'turing@openclass.edu',
            officeHours: '🕒 Office Hours: Mon & Wed 2:00 - 4:00 PM',
            routine: '📅 Mon & Wed (10:00 AM - 11:30 AM)<br>📍 Computer Lab #302',
            progress: 75,
            studentGrade: '92% (Grade A+)',
            studentAttendance: '95%',
            description: 'Master HTML5, CSS3, JavaScript, web development architecture, and cloud apps.',
            createdAt: { seconds: Date.now() / 1000 },
            createdBy: 'demo-teacher-id',
            themeColor: '#3b82f6'
          };
          renderClassrooms([sampleClass]);
        };
      }
    }
    return;
  }
  
  window.openClassroomDetail = openClassroomDetail;

  if (listEl && !listEl.dataset.clickBound) {
    listEl.dataset.clickBound = 'true';
    listEl.addEventListener('click', (e) => {
      if (e.target.closest('.gc-card-actions')) return;
      const card = e.target.closest('.class-card, .gc-card');
      if (card && card.dataset.classroomId) {
        const classId = card.dataset.classroomId;
        const found = (userClassrooms || []).find(c => String(c.classroomId) === String(classId));
        if (found) {
          openClassroomDetail(found);
        } else {
          const title = card.querySelector('.gc-card-title')?.textContent || 'Classroom';
          const sub = card.querySelector('.gc-card-subtitle')?.textContent || '';
          openClassroomDetail({ classroomId: classId, classroomName: title, section: sub });
        }
      }
    });
  }

  classrooms.forEach(c => {
    const isPending = c.joinStatus === 'pending';
    const card = document.createElement('div');
    card.className = `class-card gc-card${isPending ? ' gc-card-pending' : ''}`;
    card.setAttribute('data-classroom-id', c.classroomId);
    card.style.cursor = 'pointer';
    const isCreator = c.createdBy === getAuth().currentUser?.uid;
    const isArchived = c.isArchived;

    const teacherName = c.teacherName || 'Teacher';
    const teacherInitials = teacherName.split(' ').map(w => w.charAt(0)).filter(Boolean).slice(0, 2).join('').toUpperCase();
    const teacherPhoto = sanitizeProfilePhotoUrl(c.teacherPhotoURL || (isCreator && currentUserProfile?.photoURL) || '', c);
    const cardSubtitle = c.courseCode || c.section || c.subject || '';

    const bgStyle = c.coverImageUrl
      ? `background-image: url('${c.coverImageUrl}'); background-size: cover; background-position: center;`
      : `background: ${getThemeGradient(c.themeColor)};`;

    card.innerHTML = `
      <div class="gc-card-banner" style="${bgStyle}">
        <div class="gc-card-banner-overlay"></div>
        <div class="gc-card-banner-header">
          <div class="gc-card-title-group">
            <h3 class="gc-card-title" title="${c.classroomName}">${c.classroomName}</h3>
            ${cardSubtitle ? `<p class="gc-card-subtitle">${cardSubtitle}</p>` : ''}
          </div>
          ${isPending ? '' : `
          <div class="gc-card-actions">
            <button class="gc-card-menu-btn" data-menu-id="${c.classroomId}" title="Options">
              <i class="material-icons">more_vert</i>
            </button>
            <div class="gc-card-dropdown" id="dropdown-${c.classroomId}" style="display:none;">
              ${isCreator ? `
                <button class="gc-dropdown-item edit-btn" data-classroom-id="${c.classroomId}"><i class="material-icons">edit</i> Edit</button>
                <button class="gc-dropdown-item copy-code-btn" data-code="${c.classroomCode}"><i class="material-icons">content_copy</i> Copy Code</button>
                <button class="gc-dropdown-item archive-btn" data-classroom-id="${c.classroomId}"><i class="material-icons">${isArchived ? 'unarchive' : 'archive'}</i> ${isArchived ? 'Restore' : 'Archive'}</button>
                <button class="gc-dropdown-item delete-btn danger" data-classroom-id="${c.classroomId}"><i class="material-icons">delete</i> Delete</button>
              ` : `
                <button class="gc-dropdown-item leave-btn warning" data-classroom-id="${c.classroomId}"><i class="material-icons">exit_to_app</i> Leave Class</button>
              `}
            </div>
          </div>
          `}
        </div>

        <div class="gc-card-teacher-info">
          <span class="gc-card-teacher-name">${teacherName}</span>
        </div>

        <div class="gc-card-avatar-wrapper">
          ${teacherPhoto 
            ? `<img src="${teacherPhoto}" alt="${teacherName}" class="gc-card-avatar-img" />` 
            : `<div class="gc-card-avatar-fallback">${teacherInitials}</div>`}
        </div>
      </div>
      ${isPending ? `
        <div class="gc-pending-bar">
          <i class="material-icons">schedule</i>
          <span>Pending Approval</span>
          <span class="gc-pending-sub">Waiting for your teacher to accept your join request.</span>
        </div>` : ''}
      <div class="gc-card-body"></div>
    `;

    // Click card to open full screen classroom view
    card.onclick = (e) => {
      if (e.target.closest('.gc-card-actions')) return;
      openClassroomDetail(c);
    };

    const menuBtn = card.querySelector(`.gc-card-menu-btn[data-menu-id="${c.classroomId}"]`);
    const dropdown = card.querySelector(`#dropdown-${c.classroomId}`);
    if (menuBtn && dropdown) {
      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelectorAll('.gc-card-dropdown').forEach(d => {
          if (d !== dropdown) d.style.display = 'none';
        });
        dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
      });
    }

    listEl.appendChild(card);
  });

  document.addEventListener('click', () => {
    document.querySelectorAll('.gc-card-dropdown').forEach(d => d.style.display = 'none');
  });

  listEl.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cId = btn.dataset.classroomId;
      const classroom = classrooms.find(c => c.classroomId === cId);
      if (classroom) openEditModal(classroom);
    });
  });

  listEl.querySelectorAll('.archive-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const cId = btn.dataset.classroomId;
      const classroom = classrooms.find(c => c.classroomId === cId);
      const verb = classroom && classroom.isArchived ? 'restore' : 'archive';
      if (!confirm(`Are you sure you want to ${verb} this classroom?`)) return;
      try {
        await archiveClassroom(cId, currentUserProfile);
      } catch (err) {
        alert(err.message);
      }
    });
  });

  listEl.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const cId = btn.dataset.classroomId;
      if (!confirm('Are you sure you want to permanently delete this classroom? This action cannot be undone.')) return;
      try {
        await deleteClassroomPermanent(cId, currentUserProfile);
      } catch (err) {
        alert(err.message);
      }
    });
  });

  listEl.querySelectorAll('.leave-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const cId = btn.dataset.classroomId;
      if (!confirm('Are you sure you want to leave this classroom?')) return;
      try {
        await leaveClassroom(cId, currentUserProfile);
      } catch (err) {
        alert(err.message);
      }
    });
  });

  listEl.querySelectorAll('.copy-code-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const code = btn.dataset.code;
      if (code && code !== 'N/A') {
        navigator.clipboard.writeText(code).then(() => {
          alert(`Class code '${code}' copied to clipboard!`);
        });
      }
    });
  });
  
  // Regenerate code button handlers
  listEl.querySelectorAll('.regenerate-code-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const cId = btn.dataset.classroomId;
      if (!confirm('Are you sure you want to regenerate the join code? The old code will no longer work.')) return;
      try {
        const db = getFirestore();
        const classroomRef = doc(db, 'classrooms', cId);
        const snap = await getDoc(classroomRef);
        if (!snap.exists()) throw new Error('Classroom not found.');
        if (snap.data().createdBy !== getAuth().currentUser?.uid) {
          throw new Error('Permission denied.');
        }
        
        // Helper function to check if code is unique
        async function isCodeUnique(code) {
          const q = query(collection(db, 'classrooms'), where('classroomCode', '==', code), where('isActive', '==', true));
          const snap = await getDocs(q);
          return snap.empty;
        }
        
        // Generate new unique code
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const length = Math.floor(Math.random() * 2) + 6;
        let newCode;
        let attempts = 0;
        do {
          newCode = '';
          for (let i = 0; i < length; i++) {
            newCode += chars.charAt(Math.floor(Math.random() * chars.length));
          }
          attempts++;
          if (attempts > 20) throw new Error('Could not generate unique code.');
        } while (!(await isCodeUnique(newCode)));
        
        await updateDoc(classroomRef, { classroomCode: newCode, updatedAt: serverTimestamp() });
        alert('Join code regenerated successfully!');
      } catch (err) {
        alert(err.message);
      }
    });
  });
  listEl.querySelectorAll('.leave-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Are you sure you want to leave this classroom?')) return;
      try {
        await leaveClassroom(btn.dataset.classroomId, currentUserProfile);
      } catch (err) {
        alert(err.message);
      }
    });
  });
  } catch (err) {
    console.error('renderClassrooms error:', err);
    listEl.innerHTML = `
      <div class="empty-state-lg" style="text-align:center; padding:50px 20px;">
        <i class="material-icons" style="font-size:48px; color:var(--danger);">error_outline</i>
        <h2>Could not load classrooms</h2>
        <p id="classroom-empty-text" style="color:var(--text-muted); max-width:440px; margin:0 auto 20px auto;">Something went wrong while rendering your classrooms. Please try again.</p>
        <button type="button" class="btn btn-primary" onclick="window.renderClassroomsRetry && window.renderClassroomsRetry()">
          <i class="material-icons">refresh</i> Retry
        </button>
      </div>`;
  }
}

window.renderClassroomsRetry = () => {
  if (!currentUserProfile) return;
  if (classroomsUnsubscribe) classroomsUnsubscribe();
  classroomsUnsubscribe = subscribeToUserClassrooms(currentUserProfile.uid, currentUserProfile.role || '', renderClassrooms);
};

const btnCreateClass = document.getElementById('btn-create-classroom');
const btnJoinClass = document.getElementById('btn-join-classroom');
const btnCreateDropdown = document.getElementById('btn-create-dropdown');
const createMenu = document.getElementById('create-menu');
const menuCreateClass = document.getElementById('menu-create-class');
const menuJoinClass = document.getElementById('menu-join-class');
const formCreateClass = document.getElementById('form-create-classroom');
const formJoinClass = document.getElementById('form-join-classroom');

function openModalById(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'flex';
  if (id === 'modal-create-classroom') {
    const teacherNameEl = document.getElementById('create-classroom-teacher-name');
    if (teacherNameEl && !teacherNameEl.value) {
      teacherNameEl.value = (currentUserProfile?.displayName || getUserName() || '').trim();
    }
  }
}

function closeCreateMenu() {
  if (createMenu) createMenu.style.display = 'none';
}

function showCreateDeniedToast() {
  if (signInSnackbarElement && signInSnackbarElement.MaterialSnackbar) {
    signInSnackbarElement.MaterialSnackbar.showSnackbar({
      message: 'Only teachers can create classes.',
      timeout: 2500,
    });
  }
}

// "Create Class" (Classrooms header) strictly opens the CREATE modal only.
if (btnCreateClass) {
  btnCreateClass.addEventListener('click', () => {
    openModalById('modal-create-classroom');
  });
}

// "Join Class" (Classrooms header) opens the JOIN modal only.
if (btnJoinClass) {
  btnJoinClass.addEventListener('click', () => {
    openModalById('modal-join-classroom');
  });
}

// Top-navbar "+" dropdown: "Create class" (teachers) / "Join class" (all).
if (btnCreateDropdown) {
  btnCreateDropdown.addEventListener('click', (e) => {
    e.stopPropagation();
    if (createMenu) {
      createMenu.style.display = createMenu.style.display === 'flex' ? 'none' : 'flex';
    }
  });
}
if (menuCreateClass) {
  menuCreateClass.addEventListener('click', () => {
    closeCreateMenu();
    openModalById('modal-create-classroom');
  });
}
if (menuJoinClass) {
  menuJoinClass.addEventListener('click', () => {
    closeCreateMenu();
    openModalById('modal-join-classroom');
  });
}

// Close the "+" dropdown on outside click.
document.addEventListener('click', (e) => {
  if (createMenu && createMenu.style.display === 'flex' && !e.target.closest('#create-menu-wrap')) {
    closeCreateMenu();
  }
});


if (formCreateClass) {
  formCreateClass.addEventListener('submit', async (e) => {
    e.preventDefault();
    const activeProfile = currentUserProfile || {
      uid: getAuth().currentUser?.uid || 'teacher-uid',
      displayName: getUserName() || 'Teacher',
      role: localStorage.getItem('openclass_user_role') || 'teacher'
    };
    const alertEl = document.getElementById('create-classroom-alert');
    const btnSubmit = document.getElementById('btn-submit-create');
    btnSubmit.disabled = true;
    try {
      const classroom = await createClassroom({
        classroomName: document.getElementById('create-classroom-name').value,
        courseCode: document.getElementById('create-classroom-course-code').value,
        teacherName: document.getElementById('create-classroom-teacher-name').value || activeProfile.displayName || '',
        themeColor: document.getElementById('create-classroom-theme')?.value || '#3B82F6',
      }, activeProfile);
      formCreateClass.reset();
      document.getElementById('modal-create-classroom').style.display = 'none';
      
      if (classroom && classroom.classroomId) {
        if (!Array.isArray(userClassrooms)) userClassrooms = [];
        if (!userClassrooms.some(c => c.classroomId === classroom.classroomId)) {
          userClassrooms.unshift(classroom);
        }
        renderClassrooms(userClassrooms);
      }

      // Refresh classrooms view so subscription stays live
      if (activeProfile.uid) {
        if (classroomsUnsubscribe) classroomsUnsubscribe();
        classroomsUnsubscribe = subscribeToUserClassrooms(activeProfile.uid, activeProfile.role || 'teacher', renderClassrooms);
      }

      // Show success modal with classroom details
      showClassroomCreatedModal(classroom);
    } catch (err) {
      if (alertEl) {
        alertEl.className = 'alert error';
        alertEl.textContent = err.message || 'Could not create classroom.';
        alertEl.style.display = 'block';
        setTimeout(() => { alertEl.style.display = 'none'; }, 4000);
      } else {
        alert(err.message || 'Could not create classroom.');
      }
    } finally {
      btnSubmit.disabled = false;
    }
  });
}

// ─── CLASSROOM CREATED SUCCESS MODAL ───────────────────────────────

let currentCreatedClassroom = null;

function showClassroomCreatedModal(classroom) {
  currentCreatedClassroom = classroom;
  
  // Populate modal with classroom details
  document.getElementById('success-classroom-name').textContent = classroom.classroomName || 'Classroom';
  document.getElementById('success-course-code').textContent = classroom.courseCode || classroom.classroomCode || 'N/A';
  document.getElementById('success-teacher-name').textContent = classroom.teacherName || '-';
  document.getElementById('success-join-code').textContent = classroom.classroomCode || 'N/A';
  
  // Show modal
  document.getElementById('modal-classroom-created').style.display = 'flex';
}

// Copy Join Code button handler
document.getElementById('btn-copy-join-code')?.addEventListener('click', async () => {
  if (!currentCreatedClassroom) return;
  const code = currentCreatedClassroom.classroomCode;
  if (code && code !== 'N/A') {
    try {
      await navigator.clipboard.writeText(code);
      // Show success toast
      const btn = document.getElementById('btn-copy-join-code');
      const originalText = btn.innerHTML;
      btn.innerHTML = '<i class="material-icons" style="font-size:16px;margin-right:4px;">check</i> Copied!';
      btn.classList.add('btn-success');
      setTimeout(() => {
        btn.innerHTML = originalText;
        btn.classList.remove('btn-success');
      }, 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
      alert('Failed to copy join code. Please try again.');
    }
  }
});

// Share Join Code button handler
document.getElementById('btn-share-join-code')?.addEventListener('click', async () => {
  if (!currentCreatedClassroom) return;
  const shareText = `Classroom: ${currentCreatedClassroom.classroomName}\nCourse Code: ${currentCreatedClassroom.courseCode || currentCreatedClassroom.classroomCode || 'General'}\nJoin Code: ${currentCreatedClassroom.classroomCode}`;
  
  if (navigator.share && navigator.canShare && navigator.canShare({ text: shareText })) {
    try {
      await navigator.share({
        title: 'Join My Classroom',
        text: shareText,
      });
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('Share failed:', err);
        // Fallback to clipboard copy
        await navigator.clipboard.writeText(shareText);
        alert('Share dialog not available. Join code copied to clipboard instead.');
      }
    }
  } else {
    // Fallback: copy to clipboard
    try {
      await navigator.clipboard.writeText(shareText);
      const btn = document.getElementById('btn-share-join-code');
      const originalText = btn.innerHTML;
      btn.innerHTML = '<i class="material-icons" style="font-size:16px;margin-right:4px;">check</i> Copied!';
      setTimeout(() => {
        btn.innerHTML = originalText;
      }, 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
      alert('Failed to copy join code. Please try again.');
    }
  }
});

// Go to Classroom button handler
document.getElementById('btn-go-to-classroom')?.addEventListener('click', () => {
  if (!currentCreatedClassroom) return;

  // Close the modal
  document.getElementById('modal-classroom-created').style.display = 'none';

  // Directly open the classroom using the created object
  // The subscription will update the list in the background
  openClassroomDetail(currentCreatedClassroom);
});

if (formJoinClass) {
  formJoinClass.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentUserProfile) return;
    const alertEl = document.getElementById('join-classroom-alert');
    const btnSubmit = document.getElementById('btn-submit-join');
    btnSubmit.disabled = true;
    try {
      const result = await joinClassroomByCode(
        document.getElementById('join-classroom-code').value,
        currentUserProfile
      );
      formJoinClass.reset();
      document.getElementById('modal-join-classroom').style.display = 'none';
      if (result && result.joinStatus === 'pending') {
        showAppToast('Join request submitted! Waiting for teacher approval.', 'info');
      } else {
        showAppToast('Successfully joined the classroom.', 'success');
      }
    } catch (err) {
      alertEl.className = 'alert error';
      alertEl.textContent = err.message;
      alertEl.style.display = 'block';
      setTimeout(() => { alertEl.style.display = 'none'; }, 4000);
    } finally {
      btnSubmit.disabled = false;
    }
  });
}

// ─── EDIT CLASSROOM ──────────────────────────────────────────────

function openEditModal(classroom) {
  document.getElementById('edit-classroom-id').value = classroom.classroomId;
  document.getElementById('edit-classroom-name').value = classroom.classroomName || '';
  document.getElementById('edit-classroom-course-code').value = classroom.courseCode || '';
  document.getElementById('edit-classroom-teacher-name').value = classroom.teacherName || '';
  if (document.getElementById('edit-classroom-theme')) {
    const tc = classroom.themeColor || '#3B82F6';
    const legacyMap = { blue: '#3B82F6', purple: '#A855F7', teal: '#10B981', amber: '#FF6B00', indigo: '#6366F1' };
    const val = legacyMap[tc] || tc;
    const themeSelect = document.getElementById('edit-classroom-theme');
    themeSelect.value = themeSelect.querySelector(`option[value="${val}"]`) ? val : '#3B82F6';
  }
  if (document.getElementById('edit-classroom-desc')) {
    document.getElementById('edit-classroom-desc').value = classroom.description || '';
  }
  document.getElementById('modal-edit-classroom').style.display = 'flex';
}

const formEditClass = document.getElementById('form-edit-classroom');
if (formEditClass) {
  formEditClass.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentUserProfile) return;
    const classroomId = document.getElementById('edit-classroom-id').value;
    const alertEl = document.getElementById('edit-classroom-alert');
    const btnSubmit = document.getElementById('btn-submit-edit');
    btnSubmit.disabled = true;
    try {
      await updateClassroom(classroomId, {
        classroomName: document.getElementById('edit-classroom-name').value,
        courseCode: document.getElementById('edit-classroom-course-code').value,
        teacherName: document.getElementById('edit-classroom-teacher-name').value,
        themeColor: document.getElementById('edit-classroom-theme')?.value || '#3B82F6',
        description: document.getElementById('edit-classroom-desc')?.value || '',
      }, currentUserProfile);
      formEditClass.reset();
      document.getElementById('modal-edit-classroom').style.display = 'none';
    } catch (err) {
      alertEl.className = 'alert error';
      alertEl.textContent = err.message;
      alertEl.style.display = 'block';
      setTimeout(() => { alertEl.style.display = 'none'; }, 4000);
    } finally {
      btnSubmit.disabled = false;
    }
  });
}

// ─── CLASSROOM DETAIL ──────────────────────────────────────────

detailStatsUnsub = null;
detailMembersUnsub = null;
detailRequestsUnsub = null;
detailActivityUnsub = null;
detailNoticesUnsub = null;
let detailCurrentClassroomId = null;
let detailCurrentClassroomCreatedBy = null;

function openClassroomDetail(classroom) {
  if (!classroom) return;
  const modal = document.getElementById('modal-classroom-detail');
  if (!modal) return;
  detailCurrentClassroomId = classroom.classroomId;
  detailCurrentClassroomCreatedBy = classroom.createdBy || classroom.classroomId;

  // Open modal immediately on screen
  modal.classList.add('gc-fullscreen-overlay');
  modal.style.display = 'flex';
  modal.style.zIndex = '999999';
  document.body.style.overflow = 'hidden';

  const nameEl = document.getElementById('detail-classroom-name');
  if (nameEl) nameEl.textContent = classroom.classroomName || 'Classroom Detail';
  const subEl = document.getElementById('detail-classroom-subtitle');
  if (subEl) subEl.textContent = classroom.courseCode || classroom.section || classroom.subject || '';
  
  const codeValEl = document.getElementById('detail-code-val');
  if (codeValEl) codeValEl.textContent = classroom.classroomCode || 'N/A';
  const streamCodeEl = document.getElementById('stream-code-display');
  if (streamCodeEl) streamCodeEl.textContent = classroom.classroomCode || 'N/A';

  // Hero Banner elements
  const heroTitle = document.getElementById('detail-hero-title');
  if (heroTitle) heroTitle.textContent = classroom.classroomName || 'Classroom';
  const heroSub = document.getElementById('detail-hero-subtitle');
  if (heroSub) heroSub.textContent = classroom.courseCode || classroom.section || classroom.subject || '';
  
  const heroBanner = document.getElementById('detail-hero-banner');
  if (heroBanner) {
    if (classroom.coverImageUrl) {
      heroBanner.style.backgroundImage = `url('${classroom.coverImageUrl}')`;
    } else {
      heroBanner.style.backgroundImage = '';
      heroBanner.style.background = getThemeGradient(classroom.themeColor);
    }
  }

  const teacherName = classroom.teacherName || 'Teacher';
  const teacherInitials = teacherName.split(' ').map(w => w.charAt(0)).filter(Boolean).slice(0, 2).join('').toUpperCase();
  const isCreator = classroom.createdBy === getAuth().currentUser?.uid;
  const teacherPhoto = sanitizeProfilePhotoUrl(classroom.teacherPhotoURL || (isCreator && currentUserProfile?.photoURL) || '', classroom);

  const heroTeacherName = document.getElementById('detail-hero-teacher-name');
  if (heroTeacherName) heroTeacherName.textContent = teacherName;
  const heroAvatar = document.getElementById('detail-hero-avatar');
  if (heroAvatar) {
    if (teacherPhoto) {
      heroAvatar.style.backgroundImage = `url('${teacherPhoto}')`;
      heroAvatar.textContent = '';
    } else {
      heroAvatar.style.backgroundImage = '';
      heroAvatar.textContent = teacherInitials;
    }
  }

  // Current user avatar for announcement box
  const userAvatar = document.getElementById('announce-user-avatar');
  if (userAvatar && currentUserProfile) {
    if (currentUserProfile.photoURL) {
      userAvatar.style.backgroundImage = `url('${sanitizeProfilePhotoUrl(currentUserProfile.photoURL, currentUserProfile)}')`;
      userAvatar.textContent = '';
    } else {
      const uInitials = (currentUserProfile.displayName || currentUserProfile.name || 'User').split(' ').map(w => w.charAt(0)).slice(0, 2).join('').toUpperCase();
      userAvatar.style.backgroundImage = '';
      userAvatar.textContent = uInitials;
    }
  }

  // Setup announcement box input & post trigger
  const announceInput = document.getElementById('announce-input-text');
  const announceActions = document.getElementById('announce-actions-row');
  const btnCancelAnnounce = document.getElementById('btn-cancel-announce');
  const btnPostAnnounce = document.getElementById('btn-post-announce');
  if (announceInput && announceActions) {
    announceInput.onfocus = () => {
      announceActions.style.display = 'flex';
    };
    if (btnCancelAnnounce) {
      btnCancelAnnounce.onclick = () => {
        announceInput.value = '';
        announceActions.style.display = 'none';
      };
    }
    if (btnPostAnnounce) {
      btnPostAnnounce.onclick = async () => {
        const content = announceInput.value.trim();
        if (!content) return;
        try {
          await addNotice(classroom.classroomId, `Announcement by ${currentUserProfile?.displayName || 'Teacher'}`, content, currentUserProfile);
          announceInput.value = '';
          announceActions.style.display = 'none';
        } catch (err) {
          alert(err.message || 'Could not post announcement.');
        }
      };
    }
  }

  // Code copy buttons
  const copyBtn1 = document.getElementById('detail-classroom-code');
  const copyBtn2 = document.getElementById('btn-copy-stream-code');
  const doCopy = () => {
    if (classroom.classroomCode) {
      navigator.clipboard.writeText(classroom.classroomCode).then(() => {
        alert(`Class code '${classroom.classroomCode}' copied to clipboard!`);
      });
    }
  };
  if (copyBtn1) copyBtn1.onclick = doCopy;
  if (copyBtn2) copyBtn2.onclick = doCopy;

  const statusBadge = document.getElementById('detail-status-badge');
  const infoStatus = document.getElementById('detail-info-status');
  if (classroom.isArchived) {
    if (statusBadge) { statusBadge.className = 'badge-status bg-archived-dim'; statusBadge.textContent = 'Archived'; }
    if (infoStatus) { infoStatus.textContent = 'Archived'; infoStatus.style.color = 'var(--danger)'; }
  } else {
    if (statusBadge) { statusBadge.className = 'badge-status bg-success-dim'; statusBadge.textContent = 'Active'; }
    if (infoStatus) { infoStatus.textContent = 'Active'; infoStatus.style.color = 'var(--success)'; }
  }

  const infoName = document.getElementById('detail-info-name');
  if (infoName) infoName.textContent = classroom.classroomName || '';
  const infoSubject = document.getElementById('detail-info-subject');
  if (infoSubject) infoSubject.textContent = classroom.courseCode || classroom.subject || 'General';
  const infoCode = document.getElementById('detail-info-code');
  if (infoCode) infoCode.textContent = classroom.classroomCode || 'N/A';
  const infoTeacher = document.getElementById('detail-info-teacher');
  if (infoTeacher) infoTeacher.textContent = classroom.teacherName || 'Unknown';
  const infoDesc = document.getElementById('detail-info-desc');
  if (infoDesc) infoDesc.textContent = classroom.description || 'No description.';
  const infoCreated = document.getElementById('detail-info-created');
  if (infoCreated) {
    infoCreated.textContent = classroom.createdAt
      ? new Date(classroom.createdAt.seconds * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
      : 'Unknown';
  }

  const isUserTeacher = currentUserProfile && isTeacher(currentUserProfile);

  // Role-based element visibility (Hide class code & attendance tab for students)
  const codeChipHdr = document.getElementById('detail-classroom-code');
  if (codeChipHdr) codeChipHdr.style.display = isUserTeacher ? 'inline-flex' : 'none';

  const streamCodeSidebarCard = document.querySelector('.gc-stream-sidebar .gc-sidebar-card');
  if (streamCodeSidebarCard) streamCodeSidebarCard.style.display = isUserTeacher ? 'block' : 'none';

  const infoCodeGroup = document.getElementById('detail-info-code-group');
  if (infoCodeGroup) infoCodeGroup.style.display = isUserTeacher ? 'block' : 'none';

  const attTab = document.getElementById('detail-tab-attendance');
  if (attTab) attTab.style.display = isUserTeacher ? 'inline-flex' : 'none';

  const gradesTab = document.getElementById('detail-tab-grades');
  if (gradesTab) gradesTab.style.display = 'inline-flex';

  // Populate Info Cards
  const progressVal = classroom.progress !== undefined ? classroom.progress : 65;
  const progressValEl = document.getElementById('info-card-progress-val');
  if (progressValEl) progressValEl.textContent = `${progressVal}%`;
  const progressBarEl = document.getElementById('info-card-progress-bar');
  if (progressBarEl) progressBarEl.style.width = `${progressVal}%`;

  const routineTextEl = document.getElementById('info-card-routine-text');
  if (routineTextEl) routineTextEl.innerHTML = classroom.routine || '📅 Mon & Wed (10:00 AM - 11:30 AM)<br>📍 Online Room #101';

  const gradeValEl = document.getElementById('info-card-grade-val');
  if (gradeValEl) gradeValEl.textContent = classroom.studentGrade || '88% (Grade A)';

  const attValEl = document.getElementById('info-card-attendance-val');
  if (attValEl) attValEl.textContent = classroom.studentAttendance || '92%';

  const teacherNameEl = document.getElementById('info-card-teacher-name');
  if (teacherNameEl) teacherNameEl.textContent = teacherName;

  const officeHoursEl = document.getElementById('info-card-office-hours');
  if (officeHoursEl) officeHoursEl.textContent = classroom.officeHours || '🕒 Office Hours: Sun & Tue 2:00 - 4:00 PM';

  const emailTeacherBtn = document.getElementById('btn-email-teacher');
  if (emailTeacherBtn) {
    const tEmail = classroom.teacherEmail || 'teacher@openclass.edu';
    emailTeacherBtn.href = `mailto:${tEmail}?subject=Query regarding ${encodeURIComponent(classroom.classroomName)}`;
  }

  // Download Syllabus button handler
  const downloadSyllabusBtn = document.getElementById('btn-download-syllabus');
  if (downloadSyllabusBtn) {
    downloadSyllabusBtn.onclick = () => {
      const element = document.createElement('a');
      const file = new Blob([
        `=========================================\n` +
        `OPENCLASS COURSE SYLLABUS\n` +
        `=========================================\n\n` +
        `Course: ${classroom.classroomName}\n` +
        `Course Code: ${classroom.courseCode || classroom.subject || 'General'}\n` +
        `Instructor: ${teacherName}\n` +
        `Office Hours: ${classroom.officeHours || 'Sun & Tue 2:00 - 4:00 PM'}\n` +
        `Schedule: ${classroom.routine || 'Mon & Wed 10:00 AM - 11:30 AM'}\n\n` +
        `COURSE OVERVIEW & LEARNING OBJECTIVES:\n` +
        `1. Comprehensive module walkthrough and assignments.\n` +
        `2. Interactive weekly live video class sessions.\n` +
        `3. Practical quizzes and collaborative projects.\n\n` +
        `GRADED COMPONENTS:\n` +
        `- Classwork & Assignments: 40%\n` +
        `- Quizzes & Assessments: 40%\n` +
        `- Attendance & Participation: 20%\n`
      ], {type: 'text/plain'});
      element.href = URL.createObjectURL(file);
      element.download = `${classroom.classroomName.replace(/\s+/g, '_')}_Syllabus.txt`;
      document.body.appendChild(element);
      element.click();
      document.body.removeChild(element);
    };
  }

  // Populate My Grades Tab
  const ovGradeEl = document.getElementById('student-overall-grade');
  if (ovGradeEl) ovGradeEl.textContent = classroom.studentGrade || '88%';
  const compTasksEl = document.getElementById('student-completed-tasks');
  if (compTasksEl) compTasksEl.textContent = '4/5';
  const qAvgEl = document.getElementById('student-quiz-avg');
  if (qAvgEl) qAvgEl.textContent = '90%';
  const attRateEl = document.getElementById('student-attendance-rate');
  if (attRateEl) attRateEl.textContent = classroom.studentAttendance || '92%';

  const gradesTableContainer = document.getElementById('student-grades-table-container');
  if (gradesTableContainer) {
    gradesTableContainer.innerHTML = `
      <table style="width:100%; border-collapse:collapse; font-size:13px; text-align:left;">
        <thead>
          <tr style="border-bottom:1px solid var(--border); color:var(--text-muted);">
            <th style="padding:10px 12px;">Item Name</th>
            <th style="padding:10px 12px;">Type</th>
            <th style="padding:10px 12px;">Submitted Date</th>
            <th style="padding:10px 12px;">Score</th>
            <th style="padding:10px 12px;">Status</th>
          </tr>
        </thead>
        <tbody>
          <tr style="border-bottom:1px solid var(--border);">
            <td style="padding:12px; font-weight:600;">Assignment 1: Fundamentals Overview</td>
            <td style="padding:12px;"><span class="badge-status bg-info-dim">Assignment</span></td>
            <td style="padding:12px; color:var(--text-muted);">Aug 1, 2026</td>
            <td style="padding:12px; font-weight:700; color:var(--success);">95 / 100</td>
            <td style="padding:12px;"><span class="badge-status bg-success-dim">Graded</span></td>
          </tr>
          <tr style="border-bottom:1px solid var(--border);">
            <td style="padding:12px; font-weight:600;">Quiz 1: Mid-Term Assessment</td>
            <td style="padding:12px;"><span class="badge-status bg-warning-dim">Quiz</span></td>
            <td style="padding:12px; color:var(--text-muted);">Aug 4, 2026</td>
            <td style="padding:12px; font-weight:700; color:var(--success);">90 / 100</td>
            <td style="padding:12px;"><span class="badge-status bg-success-dim">Graded</span></td>
          </tr>
          <tr style="border-bottom:1px solid var(--border);">
            <td style="padding:12px; font-weight:600;">Assignment 2: Practical Lab Project</td>
            <td style="padding:12px;"><span class="badge-status bg-info-dim">Assignment</span></td>
            <td style="padding:12px; color:var(--text-muted);">Aug 6, 2026</td>
            <td style="padding:12px; font-weight:700; color:var(--primary);">80 / 100</td>
            <td style="padding:12px;"><span class="badge-status bg-success-dim">Graded</span></td>
          </tr>
        </tbody>
      </table>
    `;
  }

  // Footer Actions Rendering
  const footer = document.getElementById('detail-modal-footer');
  footer.innerHTML = '';
  footer.style.display = 'flex';
  footer.style.justifyContent = 'space-between';
  footer.style.alignItems = 'center';
  footer.style.flexWrap = 'wrap';
  footer.style.gap = '12px';

  const leftFooterDiv = document.createElement('div');
  leftFooterDiv.style.display = 'flex';
  leftFooterDiv.style.alignItems = 'center';
  leftFooterDiv.style.gap = '12px';

  const rightFooterDiv = document.createElement('div');
  rightFooterDiv.style.display = 'flex';
  rightFooterDiv.style.alignItems = 'center';
  rightFooterDiv.style.gap = '12px';
  rightFooterDiv.style.flexWrap = 'wrap';

  if (isCreator) {
    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-outline';
    editBtn.innerHTML = '<i class="material-icons" style="font-size:16px;">edit</i> Edit Class';
    editBtn.addEventListener('click', () => {
      modal.style.display = 'none';
      openEditModal(classroom);
    });
    rightFooterDiv.appendChild(editBtn);

    const archBtn = document.createElement('button');
    archBtn.className = 'btn btn-outline';
    archBtn.style.color = classroom.isArchived ? 'var(--success)' : 'var(--warning)';
    archBtn.innerHTML = `<i class="material-icons" style="font-size:16px;">${classroom.isArchived ? 'unarchive' : 'archive'}</i> ${classroom.isArchived ? 'Restore' : 'Archive'}`;
    archBtn.addEventListener('click', async () => {
      if (!confirm(`Are you sure you want to ${classroom.isArchived ? 'restore' : 'archive'} this classroom?`)) return;
      try {
        await archiveClassroom(classroom.classroomId, currentUserProfile);
        modal.style.display = 'none';
      } catch (err) { alert(err.message); }
    });
    rightFooterDiv.appendChild(archBtn);
  } else {
    // Student view: Danger compact Leave Class button at left edge
    const leaveBtn = document.createElement('button');
    leaveBtn.className = 'btn btn-leave-class-danger';
    leaveBtn.style.padding = '5px 12px';
    leaveBtn.style.fontSize = '12px';
    leaveBtn.style.background = 'rgba(239, 68, 68, 0.12)';
    leaveBtn.style.color = '#ef4444';
    leaveBtn.style.border = '1px solid rgba(239, 68, 68, 0.3)';
    leaveBtn.style.borderRadius = '8px';
    leaveBtn.style.cursor = 'pointer';
    leaveBtn.innerHTML = '<i class="material-icons" style="font-size:14px;">exit_to_app</i> Leave Class';
    leaveBtn.addEventListener('click', async () => {
      if (!confirm('Are you sure you want to leave this classroom?')) return;
      try {
        await leaveClassroom(classroom.classroomId, currentUserProfile);
        modal.style.display = 'none';
      } catch (err) { alert(err.message); }
    });
    leftFooterDiv.appendChild(leaveBtn);

    // Ask Question button for students
    const askQBtn = document.createElement('button');
    askQBtn.className = 'btn btn-outline';
    askQBtn.style.fontSize = '13px';
    askQBtn.innerHTML = '<i class="material-icons" style="font-size:16px;">help_outline</i> Ask Question';
    askQBtn.addEventListener('click', () => {
      const askModal = document.getElementById('modal-ask-question');
      if (askModal) {
        document.getElementById('ask-question-topic').value = '';
        document.getElementById('ask-question-message').value = '';
        askModal.style.display = 'flex';

        const submitBtn = document.getElementById('btn-submit-teacher-question');
        if (submitBtn) {
          submitBtn.onclick = async () => {
            const topic = document.getElementById('ask-question-topic').value.trim();
            const message = document.getElementById('ask-question-message').value.trim();
            if (!message) {
              alert('Please write your question before submitting.');
              return;
            }
            try {
              await addNotice(classroom.classroomId, `Question: ${topic || 'General Question'}`, `From ${currentUserProfile?.displayName || 'Student'}:\n\n${message}`, currentUserProfile);
              alert('Your question has been sent directly to the teacher!');
              askModal.style.display = 'none';
            } catch (err) {
              alert('Error sending question: ' + err.message);
            }
          };
        }
      }
    });
    rightFooterDiv.appendChild(askQBtn);
  }

  const chatBtn = document.createElement('button');
  chatBtn.className = 'btn btn-outline';
  chatBtn.style.fontSize = '13px';
  chatBtn.innerHTML = '<i class="material-icons" style="font-size:16px;">forum</i> Chat Channel';
  chatBtn.addEventListener('click', () => {
    modal.style.display = 'none';
    const channelItem = document.querySelector(`.channel-item[data-channel-id="${classroom.classroomId}"]`);
    if (channelItem) channelItem.click();
    else document.querySelector('.nav-item[data-tab="chat"]')?.click();
  });
  rightFooterDiv.appendChild(chatBtn);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn btn-primary';
  closeBtn.style.fontSize = '13px';
  closeBtn.textContent = 'Back to Classrooms';
  closeBtn.addEventListener('click', () => { modal.style.display = 'none'; });
  rightFooterDiv.appendChild(closeBtn);

  footer.appendChild(leftFooterDiv);
  footer.appendChild(rightFooterDiv);

  modal.style.display = 'flex';
  switchDetailTab('stream');
  subscribeDetailData(classroom.classroomId);
}

function switchDetailTab(tabName) {
  document.querySelectorAll('.detail-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.detail-panel').forEach(p => p.style.display = 'none');
  const tabEl = document.querySelector(`.detail-tab[data-detail-tab="${tabName}"]`);
  if (tabEl) tabEl.classList.add('active');
  const panel = document.getElementById(`detail-panel-${tabName}`);
  if (panel) { panel.style.display = 'block'; panel.style.animation = 'none'; void panel.offsetHeight; panel.style.animation = ''; }
}

document.querySelectorAll('.detail-tab').forEach(tab => {
  tab.addEventListener('click', () => switchDetailTab(tab.getAttribute('data-detail-tab')));
});

let subscribeDetailData = function subscribeDetailDataBase(classroomId) {
  if (detailStatsUnsub) detailStatsUnsub();
  if (detailMembersUnsub) detailMembersUnsub();
  if (detailRequestsUnsub) detailRequestsUnsub();
  if (detailActivityUnsub) detailActivityUnsub();
  if (detailNoticesUnsub) detailNoticesUnsub();

  detailNoticesUnsub = subscribeNotices(classroomId, (notices) => {
    const esc = (v) => String(v || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const fmtTs = (ts) => new Date(ts).toLocaleString();
    const toMillis = (ts) => ts && typeof ts.toMillis === 'function' ? ts.toMillis() : Date.now();
    const postsEl = document.getElementById('detail-posts-list');
    if (postsEl) {
      if (!notices || notices.length === 0) {
        postsEl.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:40px 0;color:var(--text-muted);font-size:14px;">No posts yet. Announce something to your class!</div>';
      } else {
        postsEl.innerHTML = notices.map(n => {
          const ts = toMillis(n.createdAt);
          const initials = (n.createdByName || 'U').split(' ').map(w => w.charAt(0)).filter(Boolean).slice(0, 2).join('').toUpperCase();
          return `<div style="background:var(--card-bg);border:1px solid var(--border);border-radius:12px;padding:16px 20px;">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
              <div style="width:36px;height:36px;border-radius:50%;background:var(--primary);display:flex;align-items:center;justify-content:center;color:#fff;font-size:13px;font-weight:700;flex-shrink:0;">${initials}</div>
              <div>
                <div style="font-weight:700;font-size:14px;color:var(--text-main);">${esc(n.createdByName) || 'Unknown'}</div>
                <div style="font-size:12px;color:var(--text-muted);">${fmtTs(ts)}</div>
              </div>
            </div>
            <div style="font-size:14px;color:var(--text-main);white-space:pre-wrap;">${esc(n.content)}</div>
          </div>`;
        }).join('');
      }
    }
    const matsEl = document.getElementById('detail-notices-list');
    if (matsEl) {
      if (!notices || notices.length === 0) {
        matsEl.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:20px 0;color:var(--text-muted);font-size:14px;">No materials posted yet.</div>';
      } else {
        matsEl.innerHTML = notices.map(n => {
          const ts = toMillis(n.createdAt);
          return `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;background:var(--bg-color);border:1px solid var(--border);border-radius:10px;margin-bottom:8px;">
            <div>
              <div style="font-weight:600;font-size:14px;color:var(--text-main);">${esc(n.title)}</div>
              <div style="font-size:12px;color:var(--text-muted);">${esc(n.createdByName) || 'Unknown'} &middot; ${fmtTs(ts)}</div>
            </div>
            <span class="material-icons" style="color:var(--primary);font-size:20px;">description</span>
          </div>`;
        }).join('');
      }
    }
  });

  detailStatsUnsub = subscribeToClassroomStats(classroomId, (stats) => {
    if (!stats) return;
    const m = document.getElementById('detail-stat-members');
    if (m) m.textContent = stats.members || 0;
    const a = document.getElementById('detail-stat-assignments');
    if (a) a.textContent = stats.assignments || 0;
    const q = document.getElementById('detail-stat-quizzes');
    if (q) q.textContent = stats.quizzes || 0;
    const n = document.getElementById('detail-stat-notes');
    if (n) n.textContent = stats.notes || 0;
  });

  detailActivityUnsub = subscribeToClassroomActivity(classroomId, (activities) => {
    const container = document.getElementById('detail-activity-list');
    if (!container) return;
    if (!activities || activities.length === 0) {
      container.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:40px 0;color:var(--text-muted);">No announcements yet.</div>';
      return;
    }
    container.innerHTML = '';
    activities.forEach(a => {
      const div = document.createElement('div');
      div.className = 'detail-activity-item';
      const icon = a.type === 'classroom_created' ? 'add' :                   a.type === 'classroom_updated' ? 'edit' :
                   a.type === 'classroom_archived' ? 'archive' :
                   a.type === 'classroom_restored' ? 'unarchive' :
                   a.type === 'member_approved' ? 'person_add' :
                   a.type === 'member_removed' ? 'person_remove' :
                   a.type === 'member_left' ? 'exit_to_app' :
                   a.type === 'join_requested' ? 'person_search' :
                   a.type === 'join_rejected' ? 'cancel' : 'notifications';
      const dotClass = a.type === 'member_approved' || a.type === 'classroom_created' ? 'primary' : '';
      const ts = a.timestamp ? a.timestamp.toMillis() : Date.now();
      div.innerHTML = `
        <div class="detail-activity-dot ${dotClass}"><i class="material-icons" style="font-size:16px;">${icon}</i></div>
        <div class="detail-activity-content">
          <h4>${a.description || 'Activity'}</h4>
          <p>${a.userName || ''}</p>
          <span class="detail-activity-time">${timeAgo(ts)}</span>
        </div>`;
      container.appendChild(div);
    });
  });

  const isCreator = currentUserProfile && detailCurrentClassroomId &&
    (currentUserProfile.uid === getAuth().currentUser?.uid);

  detailMembersUnsub = subscribeToClassroomMembers(classroomId, (members) => {
    const container = document.getElementById('detail-members-list');
    const teachersContainer = document.getElementById('detail-teachers-list');
    const studentsCountEl = document.getElementById('detail-students-count');
    if (!container) return;
    container.innerHTML = '';
    if (teachersContainer) teachersContainer.innerHTML = '';

    if (!members || members.length === 0) {
      container.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:20px 0;color:var(--text-muted);">No members.</div>';
      return;
    }
    const currentUid = getAuth().currentUser?.uid;
    const isCreatorView = currentUserProfile && isTeacher(currentUserProfile) &&
      classroomId && members.some(m => m.uid === currentUid && m.approved);

    const teachers = members.filter(m => (m.role || '').toLowerCase() === 'teacher');
    const students = members.filter(m => (m.role || '').toLowerCase() !== 'teacher');

    if (studentsCountEl) studentsCountEl.textContent = `${students.length} student${students.length === 1 ? '' : 's'}`;

    const renderMemberRow = (m, targetEl) => {
      const isSelf = m.uid === currentUid;
      const row = document.createElement('div');
      row.className = 'member-row';
      const photoUrl = sanitizeProfilePhotoUrl(m.photoURL || '', m) || '/images/profile_placeholder.png';
      row.innerHTML = `
        <div class="member-avatar-sm" style="background-image:url('${photoUrl}');"></div>
        <div class="member-info">
          <div class="member-name">${m.displayName || 'Unknown'} ${isSelf ? '(You)' : ''}</div>
          <div class="member-email">${m.email || ''}</div>
        </div>
        <span class="member-role-badge">${displayRole(m.role)}</span>
        <div class="member-actions">
          ${!isSelf ? `<button class="btn btn-outline start-floating-chat-btn" style="padding:4px 10px;font-size:0.8rem;margin-right:6px;color:#60a5fa;border-color:rgba(96,165,250,0.4);"><i class="material-icons" style="font-size:14px;vertical-align:-2px;margin-right:2px;">chat</i> Chat</button>` : ''}
          ${!isSelf && (isCreatorView || isCreator) && (m.role || '').toLowerCase() !== 'teacher' && m.uid !== classroomId
            ? `<button class="btn btn-outline remove-member-btn" data-uid="${m.uid}" data-name="${m.displayName || 'this member'}" style="padding:4px 10px;font-size:0.8rem;color:var(--danger);">Remove</button>`
            : ''}
        </div>`;

      const chatBtn = row.querySelector('.start-floating-chat-btn');
      chatBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        openFloatingMessenger({
          uid: m.uid,
          displayName: m.displayName || 'User',
          role: m.role || 'student',
          photoURL: photoUrl,
          classroomId: detailCurrentClassroomId || 'global'
        });
      });

      targetEl.appendChild(row);
    };

    if (teachersContainer) {
      if (teachers.length === 0) {
        teachersContainer.innerHTML = '<div class="empty-state-sm" style="padding:10px 0;color:var(--text-muted);font-size:13px;">No teachers assigned.</div>';
      } else {
        teachers.forEach(t => renderMemberRow(t, teachersContainer));
      }
    }

    if (students.length === 0) {
      container.innerHTML = '<div class="empty-state-sm" style="padding:10px 0;color:var(--text-muted);font-size:13px;">No students enrolled yet.</div>';
    } else {
      students.forEach(s => renderMemberRow(s, container));
    }

    container.querySelectorAll('.remove-member-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Remove ${btn.dataset.name} from this classroom?`)) return;
        try {
          await removeMember(classroomId, btn.dataset.uid, currentUserProfile);
        } catch (err) { alert(err.message); }
      });
    });
  });

  const canManageRequests = currentUserProfile &&
    (detailCurrentClassroomCreatedBy || classroomId) === getAuth().currentUser?.uid;

  detailRequestsUnsub = subscribeToJoinRequests(classroomId, (requests) => {
    const container = document.getElementById('detail-requests-list');
    const section = document.getElementById('detail-members-requests');
    if (!container || !section) return;
    if (!canManageRequests) {
      section.style.display = 'none';
      return;
    }
    const pending = requests.filter(r => r.status === 'pending');
    if (pending.length === 0) {
      section.style.display = 'none';
      return;
    }
    section.style.display = 'block';
    container.innerHTML = '';
    pending.forEach(r => {
      const card = document.createElement('div');
      card.className = 'request-card';
      const photoUrl = sanitizeProfilePhotoUrl(r.photoURL || '', r) || '/images/profile_placeholder.png';
      card.innerHTML = `
        <div class="member-avatar-sm" style="background-image:url('${photoUrl}');"></div>
        <div class="member-info">
          <div class="member-name">${r.displayName || 'Unknown'}</div>
          <div class="member-email">${r.email || ''}</div>
        </div>
        <div class="request-actions">
          <button class="btn btn-primary approve-request-btn" data-uid="${r.uid}" style="padding:4px 12px;font-size:0.8rem;">Approve</button>
          <button class="btn btn-outline reject-request-btn" data-uid="${r.uid}" style="padding:4px 12px;font-size:0.8rem;color:var(--danger);">Reject</button>
        </div>`;
      container.appendChild(card);
    });
    container.querySelectorAll('.approve-request-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await approveMember(classroomId, btn.dataset.uid, currentUserProfile);
        } catch (err) { alert(err.message); }
      });
    });
    container.querySelectorAll('.reject-request-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await rejectMember(classroomId, btn.dataset.uid, currentUserProfile);
        } catch (err) { alert(err.message); }
      });
    });
  });
}

// ─── NEW MODULE IMPORTS ────────────────────────────────────────

import {
  createAssignment, updateAssignment, deleteAssignment,
  publishAssignment, closeAssignment,
  subscribeAssignments, submitAssignment, gradeAssignment,
  subscribeSubmissions, subscribeMySubmission, uploadFile
} from './assignmentService.js';
import {
  createQuiz, updateQuiz, deleteQuiz, publishQuiz, closeQuiz,
  subscribeQuizzes, submitQuizAttempt,
  subscribeMyAttempt, subscribeLeaderboard, subscribeQuizAnalytics,
  subscribeAttemptHistory,
  saveToQuestionBank, subscribeQuestionBank, deleteFromQuestionBank,
  QTYPE
} from './quizService.js';
import { uploadNote, deleteNote, subscribeNotes, getCategories, searchNotes } from './noteService.js';
import { autoAttend, markAttendance, markAllPresent, subscribeAttendance, subscribeStudentHistory, getTodayStats, getMonthRange, exportCSV, getMembers } from './attendanceService.js';
import { subscribeReminders, createReminder, deleteReminder, fetchCalendarEvents } from './calendarService.js';
import { getClassroomAnalytics, getStudentPerformance, exportToCSV, downloadCSV, printElement } from './analyticsService.js';
import { createNotification, createBulkNotifications, subscribeNotifications, markAsRead, markAllAsRead, deleteNotification, setupFCM, onForegroundMessage } from './notificationService.js';

// ─── EXTENDED GLOBAL STATE ─────────────────────────────────────

let currentAssignmentClassId = null;
let currentQuizClassId = null;
let quizTimer = null;
let quizTimerSeconds = 0;
let quizAnswers = [];

let privateChatId = null;
let currentUserOnlineStatus = null;
let currentMeetingClassroomId = null;
let currentMeetingId = null;
let detailAttendanceDate = '';

// Notifications
let notificationsCache = [];

// Analytics
let analyticsChartInstances = [];
let analyticsClassData = {};

// ─── ASSIGNMENTS ───────────────────────────────────────────────

let countdownIntervals = [];

function clearAssignmentCountdowns() {
  countdownIntervals.forEach(c => clearInterval(c));
  countdownIntervals = [];
}

function getStatusBadge(status, dueDate, isLate) {
  if (isLate) return '<span class="badge-status bg-archived-dim">Late</span>';
  if (status === 'draft') return '<span class="badge-status" style="background:rgba(148,163,184,0.1);color:var(--text-muted);">Draft</span>';
  if (status === 'closed') return '<span class="badge-status bg-archived-dim">Closed</span>';
  if (status === 'published' && dueDate && dueDate < Date.now()) return '<span class="badge-status bg-warning-dim">Overdue</span>';
  return '<span class="badge-status bg-success-dim">Published</span>';
}

function getCountdownHtml(dueDate) {
  if (!dueDate) return '<span style="font-size:12px;color:var(--text-muted);">No due date</span>';
  const diff = dueDate - Date.now();
  if (diff <= 0) return '<span style="font-size:12px;color:var(--danger);font-weight:600;">Past due</span>';
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  if (days > 0) return `<span style="font-size:12px;color:var(--text-muted);">${days}d ${hours}h remaining</span>`;
  if (hours > 0) return `<span style="font-size:12px;color:var(--warning);font-weight:600;">${hours}h ${mins}m remaining</span>`;
  return `<span style="font-size:12px;color:var(--danger);font-weight:600;">${mins}m remaining</span>`;
}

function createCountdownTimer(el, dueDate) {
  if (!dueDate) return;
  const interval = setInterval(() => {
    const diff = dueDate - Date.now();
    if (diff <= 0) {
      el.innerHTML = '<span style="font-size:12px;color:var(--danger);font-weight:600;">Past due</span>';
      clearInterval(interval);
      return;
    }
    const days = Math.floor(diff / 86400000);
    const hours = Math.floor((diff % 86400000) / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    const secs = Math.floor((diff % 60000) / 1000);
    if (days > 0) el.innerHTML = `<span style="font-size:12px;color:var(--text-muted);">${days}d ${hours}h ${mins}m remaining</span>`;
    else if (hours > 0) el.innerHTML = `<span style="font-size:12px;color:var(--warning);font-weight:600;">${hours}h ${mins}m ${secs}s remaining</span>`;
    else el.innerHTML = `<span style="font-size:12px;color:var(--danger);font-weight:600;">${mins}m ${secs}s remaining</span>`;
  }, 1000);
  countdownIntervals.push(interval);
}

function renderFileList(files) {
  if (!files || files.length === 0) return '';
  return files.map(f =>
    `<a href="${f.url}" target="_blank" class="file-chip" title="${f.name}">
      <i class="material-icons" style="font-size:14px;">attach_file</i> ${f.name.length > 20 ? f.name.substring(0, 17) + '...' : f.name}
    </a>`
  ).join('');
}

function buildAssignmentClassroomSelector(containerId, onClick) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  const allBtn = document.createElement('button');
  allBtn.className = 'class-tab-btn';
  allBtn.textContent = 'All Classrooms';
  allBtn.addEventListener('click', () => { onClick(''); container.querySelectorAll('.class-tab-btn').forEach(b => b.classList.remove('active')); allBtn.classList.add('active'); });
  container.appendChild(allBtn);
  userClassrooms.forEach(c => {
    const btn = document.createElement('button');
    btn.className = 'class-tab-btn';
    btn.textContent = c.classroomName;
    btn.addEventListener('click', () => {
      onClick(c.classroomId);
      container.querySelectorAll('.class-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
    container.appendChild(btn);
  });
  if (container.firstChild) container.firstChild.classList.add('active');
}

function renderAssignments(assignments) {
  const container = document.getElementById('assignment-list');
  if (!container) return;
  clearAssignmentCountdowns();
  if (!assignments || assignments.length === 0) {
    container.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:60px 0;color:var(--text-muted);">No assignments yet.</div>';
    return;
  }
  container.innerHTML = '';
  const isUserTeacher = currentUserProfile && isTeacher(currentUserProfile);
  const currentUid = getAuth().currentUser?.uid;
  assignments.forEach(a => {
    const dueMillis = a.dueDate ? a.dueDate.toMillis() : null;
    const dueDate = dueMillis ? new Date(dueMillis) : null;
    const dueStr = dueDate ? dueDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'No due date';
    const isOverdue = dueMillis ? dueMillis < Date.now() : false;
    const isClosed = a.status === 'closed';
    const isDraft = a.status === 'draft';
    const isLate = a.late;
    const statusHtml = getStatusBadge(a.status, dueMillis, isLate);
    const card = document.createElement('div');
    card.className = 'assignment-card';
    card.innerHTML =
      '<div class="assignment-card-header"><h3>' + a.title + '</h3>' + statusHtml + '</div>' +
      (a.description ? '<div class="assignment-card-desc">' + a.description + '</div>' : '') +
      '<div class="assignment-card-meta">' +
        '<span><i class="material-icons" style="font-size:16px;">calendar_today</i> ' + dueStr + '</span>' +
        '<span><i class="material-icons" style="font-size:16px;">grade</i> ' + (a.maxMarks || 0) + ' marks</span>' +
        '<span class="countdown-display">' + getCountdownHtml(dueMillis) + '</span>' +
      '</div>' +
      ((a.files && a.files.length > 0) ? '<div class="assignment-card-files">' + renderFileList(a.files) + '</div>' : '') +
      '<div class="assignment-card-actions"></div>';
    container.appendChild(card);
    const countdownEl = card.querySelector('.countdown-display');
    if (countdownEl && dueMillis && dueMillis > Date.now()) {
      createCountdownTimer(countdownEl, dueMillis);
    }
    const actionsDiv = card.querySelector('.assignment-card-actions');
    if (isUserTeacher) {
      if (a.status !== 'published') {
        const pubBtn = document.createElement('button');
        pubBtn.className = 'btn btn-outline'; pubBtn.style.cssText = 'padding:4px 10px;font-size:0.8rem;color:var(--success);';
        pubBtn.innerHTML = '<i class="material-icons" style="font-size:14px;">publish</i> Publish';
        pubBtn.addEventListener('click', async () => {
          if (!confirm('Publish this assignment? Students will be able to submit.')) return;
          await publishAssignment(currentAssignmentClassId || a.classroomId, a.id);
        });
        actionsDiv.appendChild(pubBtn);
      }
      if (a.status === 'published') {
        const closeBtn = document.createElement('button');
        closeBtn.className = 'btn btn-outline'; closeBtn.style.cssText = 'padding:4px 10px;font-size:0.8rem;color:var(--warning);';
        closeBtn.innerHTML = '<i class="material-icons" style="font-size:14px;">block</i> Close';
        closeBtn.addEventListener('click', async () => {
          if (!confirm('Close this assignment? No more submissions will be accepted.')) return;
          await closeAssignment(currentAssignmentClassId || a.classroomId, a.id);
        });
        actionsDiv.appendChild(closeBtn);
      }
      if (a.status === 'published' || a.status === 'closed') {
        const viewBtn = document.createElement('button');
        viewBtn.className = 'btn btn-outline'; viewBtn.style.cssText = 'padding:4px 10px;font-size:0.8rem;';
        viewBtn.innerHTML = '<i class="material-icons" style="font-size:14px;">visibility</i> Submissions';
        viewBtn.addEventListener('click', () => openViewSubmissions(currentAssignmentClassId || a.classroomId, a));
        actionsDiv.appendChild(viewBtn);
      }
      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-outline'; delBtn.style.cssText = 'padding:4px 10px;font-size:0.8rem;color:var(--danger);';
      delBtn.innerHTML = '<i class="material-icons" style="font-size:14px;">delete</i> Delete';
      delBtn.addEventListener('click', async () => {
        if (!confirm('Delete this assignment?')) return;
        await deleteAssignment(currentAssignmentClassId || a.classroomId, a.id);
      });
      actionsDiv.appendChild(delBtn);
    } else {
      if (isClosed) {
        const closedMsg = document.createElement('span');
        closedMsg.style.cssText = 'font-size:13px;color:var(--text-muted);font-style:italic;';
        closedMsg.textContent = 'Submissions closed';
        actionsDiv.appendChild(closedMsg);
      } else if (isDraft) {
        const draftMsg = document.createElement('span');
        draftMsg.style.cssText = 'font-size:13px;color:var(--text-muted);font-style:italic;';
        draftMsg.textContent = 'Not yet published';
        actionsDiv.appendChild(draftMsg);
      } else {
        const subBtn = document.createElement('button');
        subBtn.className = 'btn btn-primary'; subBtn.style.cssText = 'padding:4px 10px;font-size:0.8rem;';
        subBtn.innerHTML = '<i class="material-icons" style="font-size:14px;">upload</i> ' + (isOverdue ? 'Submit (Late)' : 'Submit');
        subBtn.addEventListener('click', () => {
          document.getElementById('submit-assignment-id').value = a.id;
          document.getElementById('submit-assignment-classroom').value = currentAssignmentClassId || a.classroomId;
          document.getElementById('submit-assignment-title').textContent = 'Submit: ' + a.title;
          document.getElementById('submit-assignment-info').innerHTML =
            '<strong>' + a.title + '</strong><br>' +
            '<span style="font-size:13px;color:var(--text-muted);">Due: ' + dueStr + ' &middot; ' + (a.maxMarks || 0) + ' marks</span>';
          const lateWarn = document.getElementById('submit-assignment-late-warning');
          if (lateWarn) lateWarn.style.display = isOverdue ? 'block' : 'none';
          document.getElementById('submit-assignment-alert').style.display = 'none';
          document.getElementById('modal-submit-assignment').style.display = 'flex';
        });
        actionsDiv.appendChild(subBtn);
      }
      const cId = currentAssignmentClassId || a.classroomId;
      if (cId) {
        subscribeMySubmission(cId, a.id, currentUid, (sub) => {
          actionsDiv.querySelectorAll('.grade-display, .history-btn, .sub-status').forEach(e => e.remove());
          if (sub) {
            const statusEl = document.createElement('div');
            statusEl.className = 'sub-status';
            statusEl.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:4px;';
            const statusText = sub.late ? '⚠ Late' : '✓ Submitted';
            const statusColor = sub.late ? 'var(--warning)' : 'var(--success)';
            statusEl.innerHTML = `<span style="font-size:12px;color:${statusColor};font-weight:600;">${statusText}</span>`;
            if (sub.files && sub.files.length > 0) {
              statusEl.innerHTML += `<span style="font-size:12px;color:var(--text-muted);">(${sub.files.length} file${sub.files.length > 1 ? 's' : ''})</span>`;
            }
            actionsDiv.appendChild(statusEl);
            if (sub.marks !== null && sub.marks !== undefined) {
              const ge = document.createElement('span');
              ge.className = 'grade-display'; ge.style.cssText = 'font-weight:700;color:var(--success);font-size:14px;margin-top:4px;display:inline-block;';
              ge.textContent = 'Marks: ' + sub.marks + '/' + (a.maxMarks || 0);
              actionsDiv.appendChild(ge);
              if (sub.feedback) {
                const fe = document.createElement('div');
                fe.className = 'grade-display'; fe.style.cssText = 'font-size:13px;color:var(--text-muted);margin-top:2px;';
                fe.textContent = 'Feedback: ' + sub.feedback;
                actionsDiv.appendChild(fe);
              }
            }
            if (!isClosed && !isDraft) {
              const hb = document.createElement('button');
              hb.className = 'btn btn-outline history-btn'; hb.style.cssText = 'padding:4px 10px;font-size:0.8rem;margin-top:4px;';
              hb.innerHTML = '<i class="material-icons" style="font-size:14px;">history</i> History';
              hb.addEventListener('click', () => openSubmissionHistory(cId, a, sub));
              actionsDiv.appendChild(hb);
            }
          }
        });
      }
    }
  });
}

document.getElementById('btn-create-assignment')?.addEventListener('click', () => {
  if (!currentAssignmentClassId) { alert('Select a classroom first.'); return; }
  if (!currentUserProfile || !isTeacher(currentUserProfile)) {
    alert('Only teachers can create assignments.');
    return;
  }
  document.getElementById('create-assignment-classroom').value = currentAssignmentClassId;
  document.getElementById('create-assignment-alert').style.display = 'none';
  document.getElementById('modal-create-assignment').style.display = 'flex';
});

document.getElementById('form-create-assignment')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentUserProfile) return;
  const alertEl = document.getElementById('create-assignment-alert');
  const btn = document.getElementById('btn-submit-create-assignment');
  btn.disabled = true;
  try {
    const cId = document.getElementById('create-assignment-classroom').value;
    const fi = document.getElementById('create-assignment-files');
    const files = fi.files ? Array.from(fi.files) : [];
    const dd = document.getElementById('create-assignment-due').value;
    const status = document.getElementById('create-assignment-status').value;
    await createAssignment(cId, {
      title: document.getElementById('create-assignment-title').value,
      description: document.getElementById('create-assignment-desc').value,
      dueDate: dd ? new Date(dd) : null,
      maxMarks: document.getElementById('create-assignment-marks').value,
      files,
      status,
    }, currentUserProfile);
    document.getElementById('form-create-assignment').reset();
    document.getElementById('create-assignment-file-list').innerHTML = '';
    document.getElementById('modal-create-assignment').style.display = 'none';
  } catch (err) {
    alertEl.className = 'alert error'; alertEl.textContent = err.message; alertEl.style.display = 'block';
    setTimeout(() => alertEl.style.display = 'none', 4000);
  } finally { btn.disabled = false; }
});

document.getElementById('create-assignment-files')?.addEventListener('change', (e) => {
  const list = document.getElementById('create-assignment-file-list');
  if (!list) return;
  list.innerHTML = '';
  Array.from(e.target.files).forEach(f => {
    const chip = document.createElement('span');
    chip.className = 'file-chip';
    chip.innerHTML = `<i class="material-icons" style="font-size:14px;">attach_file</i> ${f.name}`;
    list.appendChild(chip);
  });
});

document.getElementById('form-submit-assignment')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentUserProfile) return;
  const alertEl = document.getElementById('submit-assignment-alert');
  const btn = document.getElementById('btn-submit-assignment');
  btn.disabled = true;
  try {
    const aId = document.getElementById('submit-assignment-id').value;
    const cId = document.getElementById('submit-assignment-classroom').value;
    const fi = document.getElementById('submit-assignment-files');
    const files = fi.files ? Array.from(fi.files) : [];
    if (files.length === 0) throw new Error('Please select at least one file to submit.');
    await submitAssignment(cId, aId, currentUserProfile, files);
    document.getElementById('form-submit-assignment').reset();
    document.getElementById('submit-assignment-file-list').innerHTML = '';
    document.getElementById('modal-submit-assignment').style.display = 'none';
  } catch (err) {
    alertEl.className = 'alert error'; alertEl.textContent = err.message; alertEl.style.display = 'block';
    setTimeout(() => alertEl.style.display = 'none', 4000);
  } finally { btn.disabled = false; }
});

document.getElementById('submit-assignment-files')?.addEventListener('change', (e) => {
  const list = document.getElementById('submit-assignment-file-list');
  if (!list) return;
  list.innerHTML = '';
  Array.from(e.target.files).forEach(f => {
    const chip = document.createElement('span');
    chip.className = 'file-chip';
    chip.innerHTML = `<i class="material-icons" style="font-size:14px;">attach_file</i> ${f.name}`;
    list.appendChild(chip);
  });
});

// ─── SUBMISSION HISTORY ─────────────────────────────────────────

function openSubmissionHistory(classroomId, assignment, submission) {
  const title = document.getElementById('history-modal-title');
  const list = document.getElementById('history-submission-list');
  if (!title || !list) return;
  title.textContent = 'History: ' + assignment.title;
  list.innerHTML = '';

  if (!submission) {
    list.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:40px 0;color:var(--text-muted);">No submissions yet.</div>';
    document.getElementById('modal-submission-history').style.display = 'flex';
    return;
  }

  const allEntries = [...(submission.history || []), {
    files: submission.files || [],
    submittedAt: submission.submittedAt,
    status: submission.status,
    late: submission.late,
  }];

  if (allEntries.length === 0) {
    list.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:40px 0;color:var(--text-muted);">No submissions yet.</div>';
    document.getElementById('modal-submission-history').style.display = 'flex';
    return;
  }

  allEntries.forEach((entry, idx) => {
    const div = document.createElement('div');
    div.className = 'history-entry';
    const ts = entry.submittedAt ? entry.submittedAt.toMillis() : Date.now();
    const dateStr = new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const entryStatus = entry.late ? 'Late' : (entry.status === 'graded' ? 'Graded' : 'Submitted');
    const statusColor = entry.late ? 'var(--warning)' : (entry.status === 'graded' ? 'var(--success)' : 'var(--primary)');
    const isLatest = idx === allEntries.length - 1;
    div.innerHTML = `
      <div class="history-entry-header">
        <span class="history-entry-num">#${idx + 1} ${isLatest ? '(Latest)' : ''}</span>
        <span class="badge-status" style="background:${statusColor}15;color:${statusColor};">${entryStatus}</span>
      </div>
      <div class="history-entry-meta">
        <span>${dateStr}</span>
      </div>
      ${(entry.files && entry.files.length > 0) ? '<div class="history-entry-files">' + renderFileList(entry.files) + '</div>' : '<span style="font-size:13px;color:var(--text-muted);">No files</span>'}
    `;
    list.appendChild(div);
  });
  document.getElementById('modal-submission-history').style.display = 'flex';
}

// ─── VIEW SUBMISSIONS (Teacher) ─────────────────────────────────

function openViewSubmissions(classroomId, assignment) {
  const title = document.getElementById('view-submissions-title');
  const list = document.getElementById('view-submissions-list');
  if (!title || !list) return;
  title.textContent = 'Submissions: ' + assignment.title;
  list.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);">Loading...</div>';
  document.getElementById('modal-view-submissions').style.display = 'flex';

  const unsub = subscribeSubmissions(classroomId, assignment.id, (submissions) => {
    const allStudents = [];
    const subMap = {};
    submissions.forEach(s => {
      subMap[s.studentId] = s;
      allStudents.push(s);
    });

    document.getElementById('vs-submitted-count').textContent = allStudents.length;
    document.getElementById('vs-late-count').textContent = allStudents.filter(s => s.late).length;
    document.getElementById('vs-graded-count').textContent = allStudents.filter(s => s.status === 'graded').length;
    document.getElementById('vs-pending-count').textContent = allStudents.filter(s => s.status !== 'graded').length;

    list.innerHTML = '';
    if (allStudents.length === 0) {
      list.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:40px 0;color:var(--text-muted);">No submissions yet.</div>';
      return;
    }
    allStudents.forEach(s => {
      const div = document.createElement('div');
      div.className = 'submission-row';
      const ts = s.submittedAt ? s.submittedAt.toMillis() : Date.now();
      const dateStr = new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const subStatus = s.late ? 'Late' : (s.status === 'graded' ? 'Graded' : 'Submitted');
      const statusColor = s.late ? 'var(--warning)' : (s.status === 'graded' ? 'var(--success)' : 'var(--primary)');
      div.innerHTML = `
        <div style="flex:1;">
          <div style="font-weight:600;font-size:14px;">${s.studentName || 'Unknown'}</div>
          <div style="font-size:12px;color:var(--text-muted);">${dateStr} ${s.late ? '⚠ Late' : ''}</div>
          ${(s.files && s.files.length > 0) ? '<div style="margin-top:4px;">' + renderFileList(s.files) + '</div>' : ''}
        </div>
        <div style="text-align:right;">
          <span class="badge-status" style="background:${statusColor}15;color:${statusColor};">${subStatus}</span>
          ${s.marks !== null && s.marks !== undefined
            ? `<div style="font-weight:700;font-size:14px;margin-top:4px;color:var(--success);">${s.marks}/${assignment.maxMarks || 0}</div>`
            : (s.status !== 'graded'
              ? `<button class="btn btn-outline grade-btn" data-sid="${s.studentId}" data-sname="${s.studentName || 'Unknown'}" style="padding:4px 10px;font-size:0.8rem;margin-top:4px;display:block;">Grade</button>`
              : '')}
          ${s.feedback ? `<div style="font-size:12px;color:var(--text-muted);margin-top:4px;max-width:200px;">${s.feedback}</div>` : ''}
        </div>`;
      list.appendChild(div);
    });
    list.querySelectorAll('.grade-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.getElementById('grade-assignment-id').value = assignment.id;
        document.getElementById('grade-assignment-classroom').value = classroomId;
        document.getElementById('grade-student-id').value = btn.dataset.sid;
        document.getElementById('grade-student-name').value = btn.dataset.sname;
        document.getElementById('grade-student-display').textContent = 'Grading: ' + btn.dataset.sname;
        const sub = subMap[btn.dataset.sid];
        if (sub) {
          document.getElementById('grade-submission-status').textContent =
            'Submitted: ' + new Date(sub.submittedAt?.toMillis() || Date.now()).toLocaleString() +
            (sub.late ? ' ⚠ Late' : '');
          if (sub.marks !== null && sub.marks !== undefined) {
            document.getElementById('grade-input-marks').value = sub.marks;
            document.getElementById('grade-input-feedback').value = sub.feedback || '';
          } else {
            document.getElementById('grade-input-marks').value = '';
            document.getElementById('grade-input-feedback').value = '';
          }
        }
        document.getElementById('grade-max-marks').value = assignment.maxMarks || 0;
        document.getElementById('grade-assignment-alert').style.display = 'none';
        document.getElementById('modal-grade-assignment').style.display = 'flex';
      });
    });
  });
  document.getElementById('modal-view-submissions')?.addEventListener('click', () => unsub(), { once: true });
}

document.getElementById('form-grade-assignment')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentUserProfile) return;
  const alertEl = document.getElementById('grade-assignment-alert');
  const btn = document.getElementById('btn-submit-grade');
  btn.disabled = true;
  try {
    const cId = document.getElementById('grade-assignment-classroom').value;
    const aId = document.getElementById('grade-assignment-id').value;
    const sId = document.getElementById('grade-student-id').value;
    const marks = document.getElementById('grade-input-marks').value;
    const feedback = document.getElementById('grade-input-feedback').value;
    if (!marks && marks !== 0) throw new Error('Please enter marks.');
    await gradeAssignment(cId, aId, sId, marks, feedback, currentUserProfile);
    document.getElementById('form-grade-assignment').reset();
    document.getElementById('modal-grade-assignment').style.display = 'none';
  } catch (err) {
    alertEl.className = 'alert error'; alertEl.textContent = err.message; alertEl.style.display = 'block';
    setTimeout(() => alertEl.style.display = 'none', 4000);
  } finally { btn.disabled = false; }
});

// ─── SYNC CLASSROOM SELECTORS (updated) ────────────────────────

// ─── QUIZZES ───────────────────────────────────────────────────

function buildQuizClassroomSelector() {
  const container = document.getElementById('quiz-class-selector');
  if (!container) return;
  container.innerHTML = '';
  userClassrooms.forEach(c => {
    const btn = document.createElement('button');
    btn.className = 'class-tab-btn';
    btn.textContent = c.classroomName;
    btn.addEventListener('click', () => {
      currentQuizClassId = c.classroomId;
      container.querySelectorAll('.class-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (quizzesUnsub) quizzesUnsub();
      quizzesUnsub = subscribeQuizzes(currentQuizClassId, renderQuizzes);
      const cb = document.getElementById('btn-create-quiz');
      if (cb) cb.style.display = (currentUserProfile && isTeacher(currentUserProfile)) ? 'inline-flex' : 'none';
    });
    container.appendChild(btn);
  });
  if (container.firstChild) container.firstChild.click();
}

// renderQuizzes moved to enhanced section below

// startQuizAttempt moved to enhanced section below

async function submitQuizAttemptAction() {
  if (quizTimer) clearInterval(quizTimer);
  const qId = document.getElementById('attempt-quiz-id').value;
  const cId = document.getElementById('attempt-quiz-classroom').value;
  const quizTotalSeconds = quizTimerSeconds;
  quizTimerSeconds = 0;
  try {
    const r = await submitQuizAttempt(cId, qId, currentUserProfile, quizAnswers, Math.max(0, quizTotalSeconds));
    document.getElementById('modal-attempt-quiz').style.display = 'none';
    alert('Quiz submitted! Score: ' + r.score + '/' + r.total);
  } catch (err) { alert('Error: ' + err.message); }
}

document.getElementById('btn-submit-attempt')?.addEventListener('click', async () => {
  const ua = quizAnswers.filter(a => a === -1).length;
  if (ua > 0 && !confirm(ua + ' unanswered. Submit anyway?')) return;
  await submitQuizAttemptAction();
});

function openLeaderboard(classroomId, quizId, title) {
  document.getElementById('leaderboard-title').textContent = 'Leaderboard: ' + title;
  const container = document.getElementById('leaderboard-body');
  container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);">Loading...</div>';
  document.getElementById('modal-leaderboard').style.display = 'flex';
  subscribeLeaderboard(classroomId, quizId, (entries) => {
    container.innerHTML = '';
    if (!entries || entries.length === 0) { container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);">No attempts yet.</div>'; return; }
    entries.forEach(e => {
      const d = document.createElement('div');
      d.className = 'lb-entry';
      const rc = e.rank === 1 ? 'gold' : e.rank === 2 ? 'silver' : e.rank === 3 ? 'bronze' : '';
      d.innerHTML = '<div class="lb-rank ' + rc + '">' + e.rank + '</div><div class="lb-name">' + e.studentName + '</div><div class="lb-score">' + e.score + '/' + e.total + '</div>';
      container.appendChild(d);
    });
  });
}

// openReview moved to enhanced section below
// btn-open-question-bank moved to enhanced section below

document.getElementById('btn-create-quiz')?.addEventListener('click', () => {
  if (!currentQuizClassId) { alert('Select a classroom first.'); return; }
  if (!currentUserProfile || !isTeacher(currentUserProfile)) {
    alert('Only teachers can create quizzes.');
    return;
  }
  document.getElementById('create-quiz-classroom').value = currentQuizClassId;
  document.getElementById('create-quiz-alert').style.display = 'none';
  document.getElementById('modal-create-quiz').style.display = 'flex';
});

// ─── NOTES ─────────────────────────────────────────────────────

document.getElementById('btn-upload-note')?.addEventListener('click', () => {
  if (userClassrooms.length === 0) { alert('You must be in a classroom.'); return; }
  if (!currentUserProfile || !isTeacher(currentUserProfile)) {
    alert('Only teachers can upload notes.');
    return;
  }
  document.getElementById('note-upload-alert').style.display = 'none';
  document.getElementById('modal-note-upload').style.display = 'flex';
});

document.getElementById('form-note-upload')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentUserProfile) return;
  const alertEl = document.getElementById('note-upload-alert');
  const btn = document.getElementById('btn-submit-note-upload');
  btn.disabled = true;
  try {
    const fi = document.getElementById('note-upload-file');
    if (!fi.files[0]) throw new Error('Select a file.');
    await uploadNote(userClassrooms[0].classroomId, fi.files[0], document.getElementById('note-upload-category').value, currentUserProfile);
    document.getElementById('form-note-upload').reset();
    document.getElementById('modal-note-upload').style.display = 'none';
  } catch (err) {
    alertEl.className = 'alert error'; alertEl.textContent = err.message; alertEl.style.display = 'block';
    setTimeout(() => alertEl.style.display = 'none', 4000);
  } finally { btn.disabled = false; }
});

// ─── SYNC CLASSROOM SELECTORS ──────────────────────────────────

const origRC = renderClassrooms;
renderClassrooms = function(classrooms, errorMsg) {
  userClassrooms = classrooms;
  try {
  origRC(classrooms, errorMsg);
  if (document.getElementById('meetings-global-list')) {
    loadGlobalMeetings();
  }
  if (document.getElementById('tab-attendance')) {
    loadGlobalAttendance();
  }
  if (document.getElementById('assignment-list')) {
    buildAssignmentClassroomSelector('assignment-class-selector', (classId) => {
      currentAssignmentClassId = classId;
      if (assignmentsUnsub) assignmentsUnsub();
      document.getElementById('assignments-subtitle').textContent = classId ? 'Assignments for selected class.' : 'All classrooms.';
      const cb = document.getElementById('btn-create-assignment');
      if (cb) cb.style.display = (classId && currentUserProfile && isTeacher(currentUserProfile)) ? 'inline-flex' : 'none';
      if (classId) assignmentsUnsub = subscribeAssignments(classId, renderAssignments);
      else document.getElementById('assignment-list').innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:60px 0;color:var(--text-muted);">Select a classroom.</div>';
    });
  }
  if (document.getElementById('quiz-list')) buildQuizClassroomSelector();
  if (classrooms.length > 0 && document.getElementById('notes-grid')) {
    if (notesUnsub) notesUnsub();
    notesUnsub = subscribeNotes(classrooms[0].classroomId, (notes) => {
      window._allNotes = notes;
      const catsContainer = document.getElementById('notes-categories');
      if (catsContainer) {
        const cats = getCategories(notes);
        catsContainer.innerHTML = '';
        cats.forEach(cat => {
          const b = document.createElement('button');
          b.className = 'cat-btn' + (cat === 'All' ? ' active' : '');
          b.textContent = cat;
          b.addEventListener('click', () => {
            catsContainer.querySelectorAll('.cat-btn').forEach(x => x.classList.remove('active'));
            b.classList.add('active');
            renderNoteGrid(cat === 'All' ? notes : notes.filter(n => n.category === cat));
          });
          catsContainer.appendChild(b);
        });
      }
      renderNoteGrid(notes);
    });
    document.getElementById('notes-search-input')?.addEventListener('input', (e) => {
      const q = e.target.value;
      if (window._allNotes) {
        renderNoteGrid(searchNotes(window._allNotes, q));
        const cc = document.getElementById('notes-categories');
        if (cc) cc.style.display = q ? 'none' : 'flex';
      }
    });
  }
  } catch (err) {
    console.error('renderClassrooms sync enhancement error:', err);
  }
};

function renderNoteGrid(notes) {
  const grid = document.getElementById('notes-grid');
  if (!grid) return;
  if (!notes || notes.length === 0) { grid.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:60px 0;color:var(--text-muted);">No notes found.</div>'; return; }
  grid.innerHTML = '';
  notes.forEach(n => {
    const im = { pdf: 'picture_as_pdf', ppt: 'slideshow', pptx: 'slideshow', doc: 'description', docx: 'description' };
    const icon = im[n.fileType] || 'insert_drive_file';
    const cm = { pdf: 'var(--danger)', ppt: 'var(--warning)', pptx: 'var(--warning)', doc: 'var(--primary)', docx: 'var(--primary)' };
    const card = document.createElement('div');
    card.className = 'note-card';
    card.innerHTML = '<i class="material-icons note-icon file-icon" style="color:' + (cm[n.fileType] || 'var(--text-muted)') + ';">' + icon + '</i><h3>' + (n.title || n.fileName) + '</h3><p style="font-size:12px;color:var(--text-muted);margin-top:4px;">' + (n.category || '') + (n.fileSize ? ' &middot; ' + (n.fileSize / 1024 / 1024).toFixed(1) + ' MB' : '') + '</p><a href="' + n.fileUrl + '" target="_blank" class="btn btn-outline download-btn" style="padding:6px 14px;font-size:12px;display:inline-flex;"><i class="material-icons" style="font-size:14px;">download</i> Download</a>';
    grid.appendChild(card);
  });
}

// ─── ENHANCED QUIZ: QUESTION TYPE SUPPORT ──────────────────────────

function getQuestionTypeHtml(type, idx) {
  if (type === QTYPE.TRUE_FALSE) {
    return '<div style="display:flex;gap:16px;margin-top:8px;">' +
      '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="radio" name="c_' + idx + '" value="true" checked /> True</label>' +
      '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="radio" name="c_' + idx + '" value="false" /> False</label></div>';
  }
  if (type === QTYPE.SHORT) {
    return '<div style="margin-top:8px;"><input type="text" class="form-control q-short-answer" placeholder="Correct answer (case-insensitive)..." style="padding:8px 12px;font-size:13px;" /></div>';
  }
  let html = '';
  for (let i = 0; i < 4; i++) {
    html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">' +
      '<input type="radio" name="c_' + idx + '" value="' + i + '" ' + (i === 0 ? 'checked' : '') + ' />' +
      '<input type="text" class="form-control q-opt" placeholder="Option ' + String.fromCharCode(65 + i) + '..." style="flex:1;padding:8px 12px;font-size:13px;" /></div>';
  }
  return html;
}

let qCount = 0;
document.getElementById('btn-add-question')?.addEventListener('click', () => {
  const container = document.getElementById('quiz-questions-container');
  const idx = qCount++;
  const div = document.createElement('div');
  div.className = 'quiz-question-card';
  div.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <strong>Question ${idx + 1}</strong>
      <div style="display:flex;gap:8px;align-items:center;">
        <select class="form-control q-type-select" style="width:auto;padding:4px 8px;font-size:12px;">
          <option value="${QTYPE.MCQ}">Multiple Choice</option>
          <option value="${QTYPE.TRUE_FALSE}">True/False</option>
          <option value="${QTYPE.SHORT}">Short Answer</option>
        </select>
        <button type="button" class="icon-btn remove-question" style="width:28px;height:28px;color:var(--danger);"><i class="material-icons" style="font-size:18px;">close</i></button>
      </div>
    </div>
    <input type="text" class="form-control q-text" placeholder="Enter question..." style="margin-bottom:8px;" />
    <div class="q-options-area">${getQuestionTypeHtml(QTYPE.MCQ, idx)}</div>
  `;
  container.appendChild(div);
  div.querySelector('.q-type-select')?.addEventListener('change', function() {
    div.querySelector('.q-options-area').innerHTML = getQuestionTypeHtml(this.value, idx);
  });
  div.querySelector('.remove-question')?.addEventListener('click', () => div.remove());
});

function collectQuizQuestions() {
  const qes = document.querySelectorAll('#quiz-questions-container .quiz-question-card');
  return Array.from(qes).map(el => {
    const type = el.querySelector('.q-type-select')?.value || QTYPE.MCQ;
    const question = el.querySelector('.q-text')?.value.trim() || '';
    let result = { question, type };
    if (type === QTYPE.MCQ) {
      result.options = Array.from(el.querySelectorAll('.q-opt')).map(o => o.value.trim());
      const checked = el.querySelector('input[type="radio"]:checked');
      result.correctAnswer = checked ? (checked.value === 'true' ? true : checked.value === 'false' ? false : parseInt(checked.value)) : 0;
    } else if (type === QTYPE.TRUE_FALSE) {
      result.options = ['True', 'False'];
      result.correctAnswer = el.querySelector('input[type="radio"]:checked')?.value === 'true';
    } else if (type === QTYPE.SHORT) {
      result.options = [];
      result.correctAnswer = -1;
      result.correctAnswerText = el.querySelector('.q-short-answer')?.value?.trim() || '';
    }
    return result;
  }).filter(q => q.question);
}

document.getElementById('form-create-quiz')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentUserProfile) return;
  const alertEl = document.getElementById('create-quiz-alert');
  const btn = document.getElementById('btn-submit-create-quiz');
  btn.disabled = true;
  try {
    const questions = collectQuizQuestions();
    if (questions.length === 0) throw new Error('Add at least one question.');
    const qc = { ...questions };
    document.querySelectorAll('#quiz-questions-container .quiz-question-card').forEach((el, i) => {
      const saveBtn = el.querySelector('.q-save-bank-btn');
      if (saveBtn?.checked) {
        saveToQuestionBank(document.getElementById('create-quiz-classroom').value || currentQuizClassId, questions[i], currentUserProfile);
      }
    });
    await createQuiz(document.getElementById('create-quiz-classroom').value || currentQuizClassId, {
      title: document.getElementById('create-quiz-title').value,
      description: document.getElementById('create-quiz-desc').value,
      timeLimit: document.getElementById('create-quiz-timer').value,
      questions: questions,
      shuffleQuestions: document.getElementById('create-quiz-shuffle')?.checked || false,
      allowReview: document.getElementById('create-quiz-review')?.checked !== false,
      attemptsAllowed: parseInt(document.getElementById('create-quiz-attempts')?.value) || 1,
      status: 'published',
    }, currentUserProfile);
    document.getElementById('form-create-quiz').reset();
    document.getElementById('quiz-questions-container').innerHTML = '';
    qCount = 0;
    document.getElementById('modal-create-quiz').style.display = 'none';
  } catch (err) {
    alertEl.className = 'alert error'; alertEl.textContent = err.message; alertEl.style.display = 'block';
    setTimeout(() => alertEl.style.display = 'none', 4000);
  } finally { btn.disabled = false; }
});

document.getElementById('btn-open-question-bank')?.addEventListener('click', () => {
  const cId = document.getElementById('create-quiz-classroom').value || currentQuizClassId;
  if (!cId) { alert('Select a classroom first.'); return; }
  const list = document.getElementById('question-bank-list');
  list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);">Loading...</div>';
  document.getElementById('modal-question-bank').style.display = 'flex';
  subscribeQuestionBank(cId, (questions) => {
    list.innerHTML = '';
    if (!questions || questions.length === 0) {
      list.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:40px 0;color:var(--text-muted);">No saved questions.</div>';
      return;
    }
    questions.forEach(q => {
      const card = document.createElement('div');
      card.className = 'quiz-question-card';
      card.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;">
          <div style="flex:1;">
            <div style="font-weight:600;font-size:14px;">${q.question}</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">Type: ${q.type || 'mcq'} ${q.options ? '· Options: ' + q.options.join(', ') : ''}</div>
          </div>
          <div style="display:flex;gap:4px;">
            <button class="btn btn-outline qb-use-btn" style="padding:4px 8px;font-size:12px;">Use</button>
            <button class="btn btn-outline qb-del-btn" style="padding:4px 8px;font-size:12px;color:var(--danger);">Del</button>
          </div>
        </div>`;
      list.appendChild(card);
      card.querySelector('.qb-use-btn')?.addEventListener('click', () => {
        document.getElementById('modal-question-bank').style.display = 'none';
        const container = document.getElementById('quiz-questions-container');
        const idx = qCount++;
        const div = document.createElement('div');
        div.className = 'quiz-question-card';
        const type = q.type || QTYPE.MCQ;
        div.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <strong>Question ${idx + 1} (from bank)</strong>
            <div style="display:flex;gap:8px;align-items:center;">
              <select class="form-control q-type-select" style="width:auto;padding:4px 8px;font-size:12px;">
                <option value="${QTYPE.MCQ}" ${type === QTYPE.MCQ ? 'selected' : ''}>MCQ</option>
                <option value="${QTYPE.TRUE_FALSE}" ${type === QTYPE.TRUE_FALSE ? 'selected' : ''}>T/F</option>
                <option value="${QTYPE.SHORT}" ${type === QTYPE.SHORT ? 'selected' : ''}>Short</option>
              </select>
              <button type="button" class="icon-btn remove-question" style="width:28px;height:28px;color:var(--danger);"><i class="material-icons" style="font-size:18px;">close</i></button>
            </div>
          </div>
          <input type="text" class="form-control q-text" value="${q.question}" style="margin-bottom:8px;" />
          <div class="q-options-area">${getQuestionTypeHtml(type, idx)}</div>`;
        container.appendChild(div);
        setTimeout(() => {
          if (type === QTYPE.MCQ) {
            div.querySelectorAll('.q-opt').forEach((optEl, oi) => { if (q.options?.[oi]) optEl.value = q.options[oi]; });
            const radios = div.querySelectorAll('input[type="radio"]');
            if (q.correctAnswer !== undefined && radios[q.correctAnswer]) radios[q.correctAnswer].checked = true;
          } else if (type === QTYPE.TRUE_FALSE) {
            const tRadio = div.querySelector('input[type="radio"][value="true"]');
            const fRadio = div.querySelector('input[type="radio"][value="false"]');
            if (q.correctAnswer === true && tRadio) tRadio.checked = true;
            else if (fRadio) fRadio.checked = true;
          } else if (type === QTYPE.SHORT) {
            const sa = div.querySelector('.q-short-answer');
            if (sa && q.correctAnswerText) sa.value = q.correctAnswerText;
          }
        }, 50);
        div.querySelector('.q-type-select')?.addEventListener('change', function() {
          div.querySelector('.q-options-area').innerHTML = getQuestionTypeHtml(this.value, idx);
        });
        div.querySelector('.remove-question')?.addEventListener('click', () => div.remove());
      });
      card.querySelector('.qb-del-btn')?.addEventListener('click', async () => {
        if (confirm('Delete from bank?')) { await deleteFromQuestionBank(cId, q.id); }
      });
    });
  });
});

// ─── ENHANCED QUIZ RENDERING (analytics, publish/close) ──────────

function renderQuizzes(quizzes) {
  const container = document.getElementById('quiz-list');
  if (!container) return;
  if (!quizzes || quizzes.length === 0) {
    container.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:60px 0;color:var(--text-muted);">No quizzes yet.</div>';
    return;
  }
  container.innerHTML = '';
  const isUserTeacher = currentUserProfile && isTeacher(currentUserProfile);
  quizzes.forEach(q => {
    const qCount = (q.questions && q.questions.length) || 0;
    const card = document.createElement('div');
    card.className = 'quiz-card';
    const statusHtml = q.status === 'published' ? '<span class="badge-status bg-success-dim">Published</span>' :
      q.status === 'closed' ? '<span class="badge-status bg-archived-dim">Closed</span>' :
      '<span class="badge-status" style="background:rgba(148,163,184,0.1);color:var(--text-muted);">Draft</span>';
    card.innerHTML =
      '<div class="quiz-card-header"><h3>' + q.title + '</h3>' + statusHtml + '</div>' +
      (q.description ? '<p style="font-size:14px;color:var(--text-muted);margin-bottom:12px;">' + q.description + '</p>' : '') +
      '<div class="quiz-card-meta"><span><i class="material-icons" style="font-size:16px;">timer</i> ' + (q.timeLimit || 0) + ' min</span><span><i class="material-icons" style="font-size:16px;">help_outline</i> ' + qCount + ' Q</span></div>' +
      '<div class="quiz-card-actions"></div>';
    container.appendChild(card);
    const actionsDiv = card.querySelector('.quiz-card-actions');
    if (isUserTeacher) {
      if (q.status === 'draft') {
        const pubBtn = document.createElement('button');
        pubBtn.className = 'btn btn-outline'; pubBtn.style.cssText = 'padding:4px 10px;font-size:0.8rem;color:var(--success);';
        pubBtn.innerHTML = '<i class="material-icons" style="font-size:14px;">publish</i> Publish';
        pubBtn.addEventListener('click', async () => { if (confirm('Publish this quiz?')) await publishQuiz(currentQuizClassId, q.id); });
        actionsDiv.appendChild(pubBtn);
      }
      if (q.status === 'published') {
        const closeBtn = document.createElement('button');
        closeBtn.className = 'btn btn-outline'; closeBtn.style.cssText = 'padding:4px 10px;font-size:0.8rem;color:var(--warning);';
        closeBtn.innerHTML = '<i class="material-icons" style="font-size:14px;">block</i> Close';
        closeBtn.addEventListener('click', async () => { if (confirm('Close this quiz?')) await closeQuiz(currentQuizClassId, q.id); });
        actionsDiv.appendChild(closeBtn);
      }
      const analyticsBtn = document.createElement('button');
      analyticsBtn.className = 'btn btn-outline'; analyticsBtn.style.cssText = 'padding:4px 10px;font-size:0.8rem;';
      analyticsBtn.innerHTML = '<i class="material-icons" style="font-size:14px;">analytics</i> Analytics';
      analyticsBtn.addEventListener('click', () => openQuizAnalytics(currentQuizClassId, q));
      actionsDiv.appendChild(analyticsBtn);
      const lb = document.createElement('button');
      lb.className = 'btn btn-outline'; lb.style.cssText = 'padding:4px 10px;font-size:0.8rem;';
      lb.innerHTML = '<i class="material-icons" style="font-size:14px;">leaderboard</i> Leaderboard';
      lb.addEventListener('click', () => openLeaderboard(currentQuizClassId, q.id, q.title));
      actionsDiv.appendChild(lb);
      const db = document.createElement('button');
      db.className = 'btn btn-outline'; db.style.cssText = 'padding:4px 10px;font-size:0.8rem;color:var(--danger);';
      db.innerHTML = '<i class="material-icons" style="font-size:14px;">delete</i> Delete';
      db.addEventListener('click', async () => { if (confirm('Delete this quiz?')) await deleteQuiz(currentQuizClassId, q.id); });
      actionsDiv.appendChild(db);
    } else {
      subscribeMyAttempt(currentQuizClassId, q.id, getAuth().currentUser.uid, (attempt) => {
        actionsDiv.innerHTML = '';
        if (q.status === 'closed') {
          const msg = document.createElement('span');
          msg.style.cssText = 'font-size:13px;color:var(--text-muted);font-style:italic;';
          msg.textContent = 'Quiz closed';
          actionsDiv.appendChild(msg);
          return;
        }
        if (attempt) {
          const se = document.createElement('span');
          se.style.cssText = 'font-weight:700;color:var(--success);font-size:14px;margin-right:12px;';
          se.textContent = 'Score: ' + attempt.score + '/' + attempt.total;
          actionsDiv.appendChild(se);
          const rb = document.createElement('button');
          rb.className = 'btn btn-outline'; rb.style.cssText = 'padding:4px 10px;font-size:0.8rem;';
          rb.innerHTML = '<i class="material-icons" style="font-size:14px;">visibility</i> Review';
          rb.addEventListener('click', () => openReview(currentQuizClassId, q, attempt));
          actionsDiv.appendChild(rb);
          const hb = document.createElement('button');
          hb.className = 'btn btn-outline'; hb.style.cssText = 'padding:4px 10px;font-size:0.8rem;';
          hb.innerHTML = '<i class="material-icons" style="font-size:14px;">history</i> History';
          hb.addEventListener('click', () => openAttemptHistory(currentQuizClassId, q, attempt));
          actionsDiv.appendChild(hb);
          const lb2 = document.createElement('button');
          lb2.className = 'btn btn-outline'; lb2.style.cssText = 'padding:4px 10px;font-size:0.8rem;';
          lb2.innerHTML = '<i class="material-icons" style="font-size:14px;">leaderboard</i> Leaderboard';
          lb2.addEventListener('click', () => openLeaderboard(currentQuizClassId, q.id, q.title));
          actionsDiv.appendChild(lb2);
        } else {
          if (q.status === 'published') {
            const sb = document.createElement('button');
            sb.className = 'btn btn-primary'; sb.style.cssText = 'padding:4px 10px;font-size:0.8rem;';
            sb.innerHTML = '<i class="material-icons" style="font-size:14px;">play_arrow</i> Attempt';
            sb.addEventListener('click', () => startQuizAttempt(currentQuizClassId, q));
            actionsDiv.appendChild(sb);
          } else {
            const msg = document.createElement('span');
            msg.style.cssText = 'font-size:13px;color:var(--text-muted);font-style:italic;';
            msg.textContent = 'Not published yet';
            actionsDiv.appendChild(msg);
          }
        }
      });
    }
  });
}

function openQuizAnalytics(classroomId, quiz) {
  const titleEl = document.getElementById('quiz-analytics-title');
  const body = document.getElementById('quiz-analytics-body');
  if (!titleEl || !body) return;
  titleEl.textContent = 'Analytics: ' + quiz.title;
  body.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);">Loading...</div>';
  document.getElementById('modal-quiz-analytics').style.display = 'flex';
  subscribeQuizAnalytics(classroomId, quiz.id, (analytics) => {
    body.innerHTML = `
      <div class="stats-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:24px;">
        <div class="stat-card" style="padding:16px;gap:4px;"><div class="stat-header"><div class="stat-icon stat-c-blue" style="width:32px;height:32px;font-size:16px;"><i class="material-icons">people</i></div><span style="font-size:12px;">Attempts</span></div><span class="stat-value" style="font-size:24px;">${analytics.totalAttempts}</span></div>
        <div class="stat-card" style="padding:16px;gap:4px;"><div class="stat-header"><div class="stat-icon stat-c-green" style="width:32px;height:32px;font-size:16px;"><i class="material-icons">trending_up</i></div><span style="font-size:12px;">Avg Score</span></div><span class="stat-value" style="font-size:24px;">${analytics.avgScore}</span></div>
        <div class="stat-card" style="padding:16px;gap:4px;"><div class="stat-header"><div class="stat-icon stat-c-orange" style="width:32px;height:32px;font-size:16px;"><i class="material-icons">emoji_events</i></div><span style="font-size:12px;">Max Score</span></div><span class="stat-value" style="font-size:24px;">${analytics.maxScore}</span></div>
        <div class="stat-card" style="padding:16px;gap:4px;"><div class="stat-header"><div class="stat-icon stat-c-purple" style="width:32px;height:32px;font-size:16px;"><i class="material-icons">check_circle</i></div><span style="font-size:12px;">Pass Rate</span></div><span class="stat-value" style="font-size:24px;">${analytics.passRate}%</span></div>
      </div>
      <h3 style="margin-bottom:16px;">Question Breakdown</h3>
      <div style="display:flex;flex-direction:column;gap:12px;">${analytics.questionBreakdown.map(qb => `
        <div style="padding:12px;background:var(--card-bg);border:1px solid var(--border);border-radius:var(--radius);">
          <div style="font-weight:600;font-size:14px;margin-bottom:4px;">${qb.question}</div>
          <div style="font-size:13px;color:var(--text-muted);">Type: ${qb.type} &middot; Correct: ${qb.correctCount}/${qb.totalAttempts} (${qb.accuracy}%)</div>
          <div style="height:6px;background:rgba(255,255,255,0.05);border-radius:3px;margin-top:8px;overflow:hidden;">
            <div style="height:100%;width:${qb.accuracy}%;background:var(--primary);border-radius:3px;transition:width 0.5s;"></div>
          </div>
        </div>`).join('')}</div>`;
  });
}

function openAttemptHistory(classroomId, quiz, attempt) {
  const container = document.getElementById('attempt-questions-container');
  container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);">Loading history...</div>';
  document.getElementById('attempt-quiz-title').textContent = 'History: ' + quiz.title;
  document.getElementById('quiz-timer-display').textContent = 'Latest: ' + attempt.score + '/' + attempt.total;
  document.getElementById('btn-submit-attempt').style.display = 'none';
  document.getElementById('modal-attempt-quiz').style.display = 'flex';
  subscribeAttemptHistory(classroomId, quiz.id, getAuth().currentUser.uid, (history) => {
    container.innerHTML = '';
    const all = [...history, attempt];
    if (all.length === 0) {
      container.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:40px;color:var(--text-muted);">No history.</div>';
      return;
    }
    all.forEach((a, ai) => {
      const entry = document.createElement('div');
      entry.className = 'history-entry';
      const ts = a.submittedAt ? a.submittedAt.toMillis() : Date.now();
      entry.innerHTML = `
        <div class="history-entry-header">
          <span class="history-entry-num">Attempt #${ai + 1} ${ai === all.length - 1 ? '(Latest)' : ''}</span>
          <span class="badge-status bg-success-dim" style="font-size:12px;">Score: ${a.score}/${a.total}</span>
        </div>
        <div class="history-entry-meta"><span>${new Date(ts).toLocaleString()}</span></div>
        <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:8px;">
          ${(a.answers || []).map(ans => `<span style="font-size:12px;padding:2px 8px;border-radius:4px;background:${ans.isCorrect ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)'};color:${ans.isCorrect ? 'var(--success)' : 'var(--danger)'};">Q${ans.questionIndex + 1}: ${ans.isCorrect ? '✓' : '✗'}</span>`).join('')}
        </div>`;
      container.appendChild(entry);
    });
  });
  document.getElementById('btn-close-attempt')?.addEventListener('click', () => {
    document.getElementById('btn-submit-attempt').style.display = '';
  }, { once: true });
}

// Override startQuizAttempt to support new question types
let startQuizAttempt = function(classroomId, quiz) {
  quizAnswers = new Array((quiz.questions || []).length).fill(null);
  document.getElementById('attempt-quiz-id').value = quiz.id;
  document.getElementById('attempt-quiz-classroom').value = classroomId;
  document.getElementById('attempt-quiz-total').value = (quiz.questions || []).length;
  document.getElementById('attempt-quiz-title').textContent = quiz.title;
  document.getElementById('attempt-quiz-alert').style.display = 'none';
  document.getElementById('btn-submit-attempt').style.display = '';
  const container = document.getElementById('attempt-questions-container');
  container.innerHTML = '';
  (quiz.questions || []).forEach((q, idx) => {
    const qDiv = document.createElement('div');
    qDiv.className = 'quiz-question-card';
    qDiv.innerHTML = '<div class="q-title">' + (idx + 1) + '. ' + q.question + '</div>';
    if (q.type === QTYPE.TRUE_FALSE) {
      ['True', 'False'].forEach((opt, oi) => {
        const od = document.createElement('div');
        od.className = 'quiz-option';
        od.innerHTML = '<span style="width:24px;height:24px;border-radius:50%;border:2px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;">' + (oi === 0 ? 'T' : 'F') + '</span> ' + opt;
        od.addEventListener('click', () => {
          qDiv.querySelectorAll('.quiz-option').forEach(o => o.classList.remove('selected'));
          od.classList.add('selected');
          quizAnswers[idx] = oi === 0;
        });
        qDiv.appendChild(od);
      });
    } else if (q.type === QTYPE.SHORT) {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'form-control';
      input.placeholder = 'Type your answer...';
      input.style.cssText = 'margin-top:8px;';
      input.addEventListener('input', () => { quizAnswers[idx] = input.value; });
      qDiv.appendChild(input);
      quizAnswers[idx] = '';
    } else {
      (q.options || []).forEach((opt, oi) => {
        const od = document.createElement('div');
        od.className = 'quiz-option';
        od.innerHTML = '<span style="width:24px;height:24px;border-radius:50%;border:2px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;">' + String.fromCharCode(65 + oi) + '</span> ' + opt;
        od.addEventListener('click', () => {
          qDiv.querySelectorAll('.quiz-option').forEach(o => o.classList.remove('selected'));
          od.classList.add('selected');
          quizAnswers[idx] = oi;
        });
        qDiv.appendChild(od);
      });
    }
    container.appendChild(qDiv);
  });
  if (quiz.timeLimit > 0) {
    quizTimerSeconds = quiz.timeLimit * 60;
    const td = document.getElementById('quiz-timer-display');
    if (quizTimer) clearInterval(quizTimer);
    quizTimer = setInterval(() => {
      quizTimerSeconds--;
      const m = Math.floor(quizTimerSeconds / 60), s = quizTimerSeconds % 60;
      if (td) td.textContent = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
      if (quizTimerSeconds <= 0) { clearInterval(quizTimer); submitQuizAttemptAction(); }
    }, 1000);
  } else document.getElementById('quiz-timer-display').textContent = '--:--';
  document.getElementById('modal-attempt-quiz').style.display = 'flex';
};

// Override openReview to support new question types
let openReview = function(classroomId, quiz, attempt) {
  const container = document.getElementById('attempt-questions-container');
  container.innerHTML = '';
  (quiz.questions || []).forEach((q, idx) => {
    const ans = (attempt.answers || []).find(a => a.questionIndex === idx);
    const qDiv = document.createElement('div');
    qDiv.className = 'quiz-question-card';
    qDiv.innerHTML = '<div class="q-title">' + (idx + 1) + '. ' + q.question + '</div>';
    if (q.type === QTYPE.TRUE_FALSE) {
      ['True', 'False'].forEach((opt, oi) => {
        const isCorrect = ans && ans.correctAnswer === (oi === 0);
        const isSelected = ans && ans.selectedAnswer === (oi === 0);
        const od = document.createElement('div');
        od.className = 'quiz-option ' + (isCorrect ? 'correct' : (isSelected ? 'wrong' : ''));
        od.innerHTML = '<span style="width:24px;height:24px;border-radius:50%;border:2px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;">' + (oi === 0 ? 'T' : 'F') + '</span> ' + opt + (isCorrect || isSelected ? ' <i class="material-icons" style="font-size:16px;color:' + (isCorrect ? 'var(--success)' : 'var(--danger)') + ';">' + (isCorrect ? 'check_circle' : 'cancel') + '</i>' : '');
        qDiv.appendChild(od);
      });
    } else if (q.type === QTYPE.SHORT) {
      const od = document.createElement('div');
      od.style.cssText = 'margin-top:8px;';
      const userAns = ans ? ans.selectedAnswer : '';
      const correctAns = ans ? ans.correctAnswer : '';
      const isCorrect = ans && ans.isCorrect;
      od.innerHTML = `<div style="margin-bottom:4px;">Your answer: <strong style="color:${isCorrect ? 'var(--success)' : 'var(--danger)'};">${userAns || '(none)'}</strong></div>
        <div style="font-size:13px;color:var(--text-muted);">Correct answer: <strong style="color:var(--success);">${correctAns}</strong></div>`;
      qDiv.appendChild(od);
    } else {
      (q.options || []).forEach((opt, oi) => {
        const isCorrect = ans && ans.correctAnswer === oi;
        const isSelected = ans && ans.selectedAnswer === oi;
        const od = document.createElement('div');
        od.className = 'quiz-option ' + (isCorrect ? 'correct' : (isSelected ? 'wrong' : ''));
        od.innerHTML = '<span style="width:24px;height:24px;border-radius:50%;border:2px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;">' + String.fromCharCode(65 + oi) + '</span> ' + opt + (isCorrect || isSelected ? ' <i class="material-icons" style="font-size:16px;color:' + (isCorrect ? 'var(--success)' : 'var(--danger)') + ';">' + (isCorrect ? 'check_circle' : 'cancel') + '</i>' : '');
        qDiv.appendChild(od);
      });
    }
    container.appendChild(qDiv);
  });
  document.getElementById('attempt-quiz-title').textContent = 'Review: ' + quiz.title;
  document.getElementById('quiz-timer-display').textContent = 'Score: ' + attempt.score + '/' + attempt.total;
  document.getElementById('btn-submit-attempt').style.display = 'none';
  document.getElementById('modal-attempt-quiz').style.display = 'flex';
  document.getElementById('btn-close-attempt')?.addEventListener('click', () => { document.getElementById('btn-submit-attempt').style.display = ''; }, { once: true });
};

// ─── MEETINGS ────────────────────────────────────────────────

function renderMeetingCard(meeting, isCreatorView) {
  const isActive = meeting.status === 'active';
  const isScheduled = meeting.status === 'scheduled';
  const isEnded = meeting.status === 'ended' || meeting.status === 'cancelled';
  const statusLabel = isActive ? 'Live' : isScheduled ? 'Scheduled' : 'Ended';
  const statusClass = isActive ? 'bg-success-dim' : isScheduled ? 'bg-warning-dim' : 'bg-archived-dim';
  const card = document.createElement('div');
  card.className = 'meeting-card';
  const ts = meeting.createdAt ? meeting.createdAt.toMillis() : Date.now();
  const dateStr = new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  card.innerHTML = `
    <div class="meeting-card-left">
      <div class="meeting-icon ${isActive ? 'live' : ''}">
        <i class="material-icons">${isActive ? 'videocam' : isScheduled ? 'schedule' : 'videocam_off'}</i>
        ${isActive ? '<span class="live-dot"></span>' : ''}
      </div>
      <div class="meeting-info">
        <h4>${meeting.title}</h4>
        <p>${meeting.description || 'No description'}</p>
        <div class="meeting-meta">
          <span><i class="material-icons" style="font-size:14px;">person</i> ${meeting.createdByName || 'Unknown'}</span>
          <span><i class="material-icons" style="font-size:14px;">schedule</i> ${dateStr}</span>
        </div>
      </div>
    </div>
    <div class="meeting-card-right">
      <span class="badge-status ${statusClass}">${statusLabel}</span>
      ${!isEnded ? `<button class="btn btn-primary join-meeting-btn" style="padding:6px 14px;font-size:13px;" data-id="${meeting.id}" data-link="${meeting.meetingLink}" data-title="${meeting.title}" data-status="${meeting.status}" data-creator="${meeting.createdBy}"><i class="material-icons" style="font-size:16px;">videocam</i> Join</button>` : ''}
    </div>`;
  return card;
}

function renderMeetings(meetings, containerId, isCreatorView) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  if (!meetings || meetings.length === 0) {
    container.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:40px 0;color:var(--text-muted);">No meetings yet.</div>';
    return;
  }
  meetings.forEach(m => {
    const card = renderMeetingCard(m, isCreatorView);
    container.appendChild(card);
  });
  container.querySelectorAll('.join-meeting-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      openMeetingRoom(btn.dataset.id, btn.dataset.link, btn.dataset.title, btn.dataset.status, btn.dataset.creator);
    });
  });
}

function openMeetingRoom(meetingId, meetingLink, title, status, creatorUid) {
  if (status === 'ended' || status === 'cancelled') {
    showAppToast('This meeting has ended.', 'info');
    return;
  }
  openInAppMeeting({
    id: meetingId,
    title: title || 'OpenClass Live Meeting',
    roomName: extractRoomNameFromLink(meetingLink, `OpenClass-${meetingId}`),
    meetingLink,
    createdBy: creatorUid,
    status,
  }, currentUserProfile);
}

// Global create meeting button
document.getElementById('btn-create-meeting-global')?.addEventListener('click', () => {
  if (!currentUserProfile) { alert('Sign in first.'); return; }
  if (userClassrooms.length === 0) { alert('You must be in a classroom to create meetings.'); return; }
  document.getElementById('create-meeting-classroom').value = userClassrooms[0].classroomId;
  document.getElementById('create-meeting-alert').style.display = 'none';
  document.getElementById('modal-create-meeting').style.display = 'flex';
});

// Detail create meeting button & empty state triggers
const openDetailMeetingModal = (type = 'instant') => {
  if (!currentUserProfile) { alert('Sign in first.'); return; }
  const cId = detailCurrentClassroomId;
  if (!cId) { alert('No classroom selected.'); return; }
  
  const modalCreateMeeting = document.getElementById('modal-create-meeting');
  const classroomSelect = document.getElementById('meeting-form-classroom');
  const typeRadios = document.getElementsByName('meeting-type-radio');
  const scheduledTimeGroup = document.getElementById('meeting-scheduled-time-group');
  
  if (classroomSelect) classroomSelect.value = cId;
  if (typeRadios) {
    typeRadios.forEach(r => {
      if (r.value === type) r.checked = true;
    });
    if (scheduledTimeGroup) {
      scheduledTimeGroup.style.display = (type === 'scheduled') ? 'block' : 'none';
    }
  }
  if (modalCreateMeeting) modalCreateMeeting.style.display = 'flex';
};

// ─── Embedded classroom meeting (rendered inside the detail workspace) ────

let activeClassroomMeeting = null;

function classroomMeetingRoom(classId) {
  return `classroom-${classId || 'unknown'}-meeting`;
}

function closeClassroomMeeting() {
  if (!activeClassroomMeeting) return;
  activeClassroomMeeting = null;
  closeInAppMeeting();
  const container = document.getElementById('classroom-meeting-host');
  if (container) container.style.display = 'none';
  const emptyState = document.getElementById('detail-meetings-empty-state');
  const content = document.getElementById('detail-meetings-content');
  if (emptyState) emptyState.style.display = '';
  if (content) content.style.display = '';
}

function openClassroomMeetingInline(meeting, classId, userProfile) {
  if (isMeetingOpen()) return;
  const container = document.getElementById('classroom-meeting-host');
  if (!container) return;
  const profile = userProfile || currentUserProfile;
  const roomName =
    meeting.roomName && meeting.roomName !== 'false' && meeting.roomName !== 'null'
      ? meeting.roomName
      : classroomMeetingRoom(classId);
  const emptyState = document.getElementById('detail-meetings-empty-state');
  const content = document.getElementById('detail-meetings-content');

  activeClassroomMeeting = { classId, roomId: roomName, meetingId: meeting.id || null };
  if (emptyState) emptyState.style.display = 'none';
  if (content) content.style.display = 'none';

  mountMeetingUi({
    roomName,
    userName: (profile && (profile.displayName || profile.email)) || 'Guest',
    title: meeting.title || 'OpenClass Live Meeting',
    inviteLink: buildLocalMeetingLink(roomName),
    inline: true,
    container,
    onClosed: closeClassroomMeeting,
  });

  if (meeting.id && profile) {
    recordMeetingJoin(meeting.id, profile).catch((err) => console.warn('Could not record meeting join:', err));
  }
}

function startClassroomInstantMeeting() {
  if (!currentUserProfile) { alert('Sign in first.'); return; }
  const classId = detailCurrentClassroomId;
  if (!classId) { alert('No classroom selected.'); return; }
  if (isMeetingOpen()) { showAppToast('A meeting is already open in this window.', 'info'); return; }
  const classroom = userClassrooms.find((c) => c.classroomId === classId);
  openClassroomMeetingInline({
    title: (classroom ? classroom.classroomName : 'Classroom') + ' — Live Session',
    classroomName: classroom ? classroom.classroomName : 'Classroom',
    roomName: classroomMeetingRoom(classId),
    status: 'ongoing',
    createdBy: currentUserProfile.uid,
  }, classId, currentUserProfile);
}

// Detail + New Meeting / Instant Meeting → start embedded meeting in-workspace
document.getElementById('btn-create-meeting-detail')?.addEventListener('click', startClassroomInstantMeeting);
document.getElementById('btn-detail-empty-instant')?.addEventListener('click', startClassroomInstantMeeting);
document.getElementById('btn-detail-empty-schedule')?.addEventListener('click', () => openDetailMeetingModal('scheduled'));

// Auto-close the embedded meeting when the classroom detail modal closes
(function watchClassroomDetailModal() {
  const modal = document.getElementById('modal-classroom-detail');
  if (!modal) return;
  const observer = new MutationObserver(() => {
    if (modal.style.display === 'none') closeClassroomMeeting();
  });
  observer.observe(modal, { attributes: true, attributeFilter: ['style'] });
})();

// Subscribe meetings in classroom detail
function subscribeDetailMeetings(classroomId) {
  if (meetingsUnsub) meetingsUnsub();
  meetingsUnsub = subscribeClassroomMeetings(classroomId, (meetings) => {
    renderClassroomDetailMeetings(meetings, classroomId);
  });
}

/**
 * Renders full meeting features inside Classroom Detail Modal (Meetings Tab)
 */
function renderClassroomDetailMeetings(meetings = [], classroomId) {
  if (activeClassroomMeeting) return;
  const emptyStateEl = document.getElementById('detail-meetings-empty-state');
  const ongoingWrapper = document.getElementById('detail-meetings-ongoing-wrapper');
  const ongoingCard = document.getElementById('detail-meetings-ongoing-card');
  const upcomingGrid = document.getElementById('detail-meetings-upcoming-grid');
  const historyList = document.getElementById('detail-meetings-history-list');

  if (!meetings || meetings.length === 0) {
    if (emptyStateEl) emptyStateEl.style.display = 'block';
    if (ongoingWrapper) ongoingWrapper.style.display = 'none';
    if (upcomingGrid) upcomingGrid.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:20px 0;color:var(--text-muted);grid-column:1/-1;font-size:13px;">No upcoming classes scheduled.</div>';
    if (historyList) historyList.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:20px 0;color:var(--text-muted);font-size:13px;">No past classes found.</div>';
    return;
  }

  if (emptyStateEl) emptyStateEl.style.display = 'none';

  const isUserTeacher = currentUserProfile && isTeacher(currentUserProfile);
  const ongoing = meetings.find(m => m.status === 'ongoing');
  const upcoming = meetings.filter(m => m.status === 'scheduled');
  const past = meetings.filter(m => m.status === 'ended');

  // Section A: Ongoing Meeting
  if (ongoing && ongoingWrapper && ongoingCard) {
    ongoingWrapper.style.display = 'block';
    const participantCount = ongoing.participantCount || (ongoing.participants ? ongoing.participants.length : 1);
    ongoingCard.innerHTML = `
      <div>
        <div style="font-size:16px; font-weight:700; color:var(--text-main); margin-bottom:4px;">${ongoing.title}</div>
        <div style="font-size:12px; color:var(--text-muted);">${ongoing.classroomName} &bull; Instructor: ${ongoing.teacherName}</div>
        <div style="margin-top:8px; font-size:12px; color:var(--success); font-weight:600; display:flex; align-items:center; gap:6px;">
          <i class="material-icons" style="font-size:15px;">people</i> ${participantCount} Active Participants Joined
        </div>
      </div>
      <div style="display:flex; gap:8px;">
        <button class="btn btn-primary btn-rejoin-detail-meeting" style="padding:6px 14px; font-size:12px;">
          <i class="material-icons" style="font-size:15px; margin-right:4px;">videocam</i> Re-join Class
        </button>
        ${isUserTeacher ? `
          <button class="btn btn-outline btn-end-detail-meeting" style="color:#EF4444; border-color:#EF4444; padding:6px 12px; font-size:12px;">
            <i class="material-icons" style="font-size:15px; margin-right:4px;">call_end</i> End Meeting
          </button>
        ` : ''}
      </div>
    `;

    ongoingCard.querySelector('.btn-rejoin-detail-meeting')?.addEventListener('click', () => {
      openInAppMeeting(ongoing, currentUserProfile);
    });

    ongoingCard.querySelector('.btn-end-detail-meeting')?.addEventListener('click', async () => {
      if (!confirm('Are you sure you want to end this live meeting for all students?')) return;
      await updateMeetingStatus(ongoing.id, 'ended');
    });
  } else if (ongoingWrapper) {
    ongoingWrapper.style.display = 'none';
  }

  // Section B: Upcoming Meetings List
  if (upcomingGrid) {
    if (upcoming.length === 0) {
      upcomingGrid.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:20px 0;color:var(--text-muted);grid-column:1/-1;font-size:13px;">No upcoming classes scheduled.</div>';
    } else {
      upcomingGrid.innerHTML = upcoming.map(m => {
        const timeStr = m.scheduledTime
          ? new Date(m.scheduledTime.toMillis ? m.scheduledTime.toMillis() : m.scheduledTime).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
          : 'Scheduled';

        let countdownText = 'Starts soon';
        if (m.scheduledTime) {
          const diffMs = (m.scheduledTime.toMillis ? m.scheduledTime.toMillis() : new Date(m.scheduledTime).getTime()) - Date.now();
          if (diffMs > 0) {
            const diffMins = Math.round(diffMs / 60000);
            if (diffMins < 60) countdownText = `Starts in ${diffMins} mins`;
            else countdownText = `Starts in ${Math.round(diffMins / 60)} hours`;
          } else {
            countdownText = 'Ready to start';
          }
        }

        return `
          <div class="upcoming-meeting-card">
            <div>
              <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:6px;">
                <span class="countdown-badge">🕒 ${countdownText}</span>
                <span style="font-size:11px; color:var(--text-muted);">${m.classroomName}</span>
              </div>
              <h4 style="font-size:14px; font-weight:700; margin:0 0 4px 0; color:var(--text-main);">${m.title}</h4>
              <div style="font-size:11px; color:var(--text-muted);"><i class="material-icons" style="font-size:13px; vertical-align:middle;">event</i> ${timeStr}</div>
            </div>
            <div style="display:flex; gap:8px; margin-top:12px;">
              <button class="btn btn-primary btn-start-detail-scheduled" data-meeting-id="${m.id}" style="flex:1; font-size:11px; padding:5px 10px;">
                <i class="material-icons" style="font-size:13px; margin-right:2px;">play_arrow</i> Start Class
              </button>
              <button class="btn btn-outline btn-copy-detail-link" data-link="${m.meetingLink}" style="font-size:11px; padding:5px 8px;" title="Copy Meeting Link">
                <i class="material-icons" style="font-size:13px;">content_copy</i>
              </button>
            </div>
          </div>
        `;
      }).join('');

      upcomingGrid.querySelectorAll('.btn-start-detail-scheduled').forEach(btn => {
        btn.onclick = async () => {
          const mId = btn.dataset.meetingId;
          const targetMeeting = upcoming.find(item => item.id === mId);
          if (targetMeeting) {
            await updateMeetingStatus(mId, 'ongoing');
            openInAppMeeting(targetMeeting, currentUserProfile);
          }
        };
      });

      upcomingGrid.querySelectorAll('.btn-copy-detail-link').forEach(btn => {
        btn.onclick = () => {
          const link = btn.dataset.link;
          if (link) {
            navigator.clipboard.writeText(link);
            alert('Meeting link copied to clipboard!');
          }
        };
      });
    }
  }

  // Section C: Past Class History & Recordings
  if (historyList) {
    if (past.length === 0) {
      historyList.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:20px 0;color:var(--text-muted);font-size:13px;">No past classes found.</div>';
    } else {
      historyList.innerHTML = past.map(m => {
        const dateStr = m.createdAt
          ? new Date(m.createdAt.toMillis ? m.createdAt.toMillis() : m.createdAt).toLocaleDateString()
          : 'Past';
        const attendeesCount = (m.participants ? m.participants.length : 0);
        return `
          <div class="history-meeting-row">
            <div>
              <div style="font-weight:600; font-size:13px; color:var(--text-main);">${m.title}</div>
              <div style="font-size:11px; color:var(--text-muted);">${m.classroomName} &bull; Date: ${dateStr} &bull; ${attendeesCount} Attendees</div>
            </div>
            <div style="display:flex; gap:6px;">
              <button class="btn btn-outline btn-download-detail-attendance" data-meeting-id="${m.id}" style="font-size:11px; padding:4px 10px;">
                <i class="material-icons" style="font-size:13px; margin-right:2px;">download</i> Attendance Report (CSV)
              </button>
              <button class="btn btn-outline btn-watch-detail-recording" data-link="${m.meetingLink}" style="font-size:11px; padding:4px 10px;">
                <i class="material-icons" style="font-size:13px; margin-right:2px;">content_copy</i> Copy Invite
              </button>
            </div>
          </div>
        `;
      }).join('');

      historyList.querySelectorAll('.btn-download-detail-attendance').forEach(btn => {
        btn.onclick = () => {
          const mId = btn.dataset.meetingId;
          const targetMeeting = past.find(item => item.id === mId);
          if (targetMeeting) {
            exportAttendanceCSV(targetMeeting);
          }
        };
      });

      historyList.querySelectorAll('.btn-watch-detail-recording').forEach(btn => {
        btn.onclick = () => {
          const link = btn.dataset.link;
          if (link) {
            navigator.clipboard.writeText(link);
            showAppToast('Meeting invite link copied to clipboard.', 'info');
          }
        };
      });
    }
  }
}

// Override openClassroomDetail to add meetings subscription
const origSubscribeDetailData = subscribeDetailData;
subscribeDetailData = function(classroomId) {
  origSubscribeDetailData(classroomId);
  subscribeDetailMeetings(classroomId);
};

// Global meetings tab subscription
function loadGlobalMeetings() {
  if (userClassrooms.length === 0) {
    const container = document.getElementById('meetings-global-list');
    if (container) container.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:60px 0;color:var(--text-muted);">Join or create a classroom to see meetings.</div>';
    return;
  }
  if (globalMeetingsUnsub) globalMeetingsUnsub();
  globalMeetingsUnsub = subscribeActiveMeetings(
    userClassrooms.map(c => c.classroomId),
    (meetings) => {
      const container = document.getElementById('meetings-global-list');
      if (!container) return;
      renderMeetings(meetings, 'meetings-global-list', true);
    }
  );
}

// ─── ATTENDANCE ────────────────────────────────────────────────

function renderAttendanceRecord(uid, record, member, isTeacherUser, classroomId, dateStr) {
  const div = document.createElement('div');
  div.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:10px 16px;background:var(--card-bg);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:8px;';
  const name = member?.displayName || member?.email || uid;
  const pic = sanitizeProfilePhotoUrl(member?.photoURL || '', member) || '';
  div.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;">
      ${pic ? `<img src="${pic}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;" />` : `<div style="width:36px;height:36px;border-radius:50%;background:var(--primary);display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px;font-weight:600;">${name.charAt(0).toUpperCase()}</div>`}
      <div><div style="font-weight:600;font-size:14px;color:var(--text-main);">${name}</div><div style="font-size:12px;color:var(--text-muted);">${record.markedByName || record.markedBy}</div></div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;">
      <span class="badge-status ${record.status === 'present' ? 'bg-success-dim' : record.status === 'late' ? 'bg-warning-dim' : 'bg-archived-dim'}">${record.status.charAt(0).toUpperCase() + record.status.slice(1)}</span>
      ${isTeacherUser ? `
        <select class="att-status-select form-input" data-uid="${uid}" style="width:auto;padding:4px 6px;font-size:12px;margin:0;">
          <option value="present" ${record.status === 'present' ? 'selected' : ''}>Present</option>
          <option value="late" ${record.status === 'late' ? 'selected' : ''}>Late</option>
          <option value="absent" ${record.status === 'absent' ? 'selected' : ''}>Absent</option>
        </select>
      ` : ''}
    </div>`;
  return div;
}

function renderDetailAttendance(attendanceData, members, isTeacherUser, classroomId, dateStr) {
  const container = document.getElementById('detail-attendance-list');
  if (!container) return;
  const statsTot = document.getElementById('att-total');
  const statsPre = document.getElementById('att-present');
  const statsLate = document.getElementById('att-late');
  const statsAbs = document.getElementById('att-absent');
  if (!attendanceData || !attendanceData.records) {
    container.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:40px 0;color:var(--text-muted);font-size:14px;">No attendance records for this date.</div>';
    if (statsTot) statsTot.textContent = '0';
    if (statsPre) statsPre.textContent = '0';
    if (statsLate) statsLate.textContent = '0';
    if (statsAbs) statsAbs.textContent = '0';
    return;
  }
  const records = attendanceData.records || {};
  const vals = Object.values(records);
  const total = vals.length;
  const present = vals.filter(r => r.status === 'present').length;
  const late = vals.filter(r => r.status === 'late').length;
  const absent = vals.filter(r => r.status === 'absent').length;
  if (statsTot) statsTot.textContent = total;
  if (statsPre) statsPre.textContent = present;
  if (statsLate) statsLate.textContent = late;
  if (statsAbs) statsAbs.textContent = absent;

  container.innerHTML = '';
  Object.entries(records).forEach(([uid, rec]) => {
    const member = members.find(m => m.uid === uid);
    const el = renderAttendanceRecord(uid, rec, member, isTeacherUser, classroomId, dateStr);
    container.appendChild(el);
  });

  if (isTeacherUser) {
    container.querySelectorAll('.att-status-select').forEach(sel => {
      sel.addEventListener('change', async () => {
        try {
          await markAttendance(classroomId, dateStr, sel.dataset.uid, sel.value, currentUserProfile);
        } catch (err) { alert(err.message); }
      });
    });
  }
  const markAllBtn = document.getElementById('btn-attendance-mark-all');
  if (markAllBtn) {
    markAllBtn.style.display = isTeacherUser ? 'inline-flex' : 'none';
    markAllBtn.onclick = async () => {
      if (!confirm('Mark all students as present?')) return;
      try {
        await markAllPresent(classroomId, dateStr, Object.keys(records).filter(uid => records[uid].status !== 'present'), currentUserProfile);
      } catch (err) { alert(err.message); }
    };
  }
}

// Subscribe to attendance for classroom detail
function subscribeDetailAttendance(classroomId, dateStr, members) {
  if (detailAttendanceUnsub) detailAttendanceUnsub();
  detailAttendanceDate = dateStr;
  const isTeacherUser = currentUserProfile && isTeacher(currentUserProfile);
  detailAttendanceUnsub = subscribeAttendance(classroomId, dateStr, (data) => {
    renderDetailAttendance(data, members, isTeacherUser, classroomId, dateStr);
  });
}

// Override subscribeDetailData to add attendance subscription
const origSubscribeDetailData2 = subscribeDetailData;
subscribeDetailData = function(classroomId) {
  origSubscribeDetailData2(classroomId);
  // Set up attendance with today's date
  const dateInput = document.getElementById('detail-attendance-date');
  if (dateInput) {
    const d = new Date().toISOString().slice(0, 10);
    dateInput.value = d;
    getMembers(classroomId).then(members => {
      subscribeDetailAttendance(classroomId, d, members);
      // Auto-attend for current user if student
      if (currentUserProfile && isStudent(currentUserProfile)) {
        autoAttend(classroomId, currentUserProfile.uid, currentUserProfile.displayName).catch(() => {});
      }
    });
    dateInput.onchange = () => {
      getMembers(classroomId).then(members => {
        subscribeDetailAttendance(classroomId, dateInput.value, members);
      });
    };
  }
};

// ═══ Global Attendance Tab ═══

function renderGlobalAttendance(attendanceMap, selectedClassId, selectedDate, membersMap) {
  const container = document.getElementById('attendance-global-view');
  if (!container) return;
  if (!selectedClassId) {
    container.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:60px 0;color:var(--text-muted);">Select a classroom to view attendance.</div>';
    return;
  }
  const data = attendanceMap[selectedClassId];
  if (!data || !data.records) {
    container.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:60px 0;color:var(--text-muted);">No attendance records for this date.</div>';
    return;
  }
  const records = data.records;
  const members = membersMap[selectedClassId] || [];
  const vals = Object.values(records);
  const total = vals.length;
  const present = vals.filter(r => r.status === 'present').length;
  const late = vals.filter(r => r.status === 'late').length;
  const absent = vals.filter(r => r.status === 'absent').length;
  const isTeacherUser = currentUserProfile && isTeacher(currentUserProfile);

  let html = `
    <div class="stats-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:20px;">
      <div class="stat-card" style="padding:14px;gap:4px;"><div class="stat-header"><div class="stat-icon stat-c-blue" style="width:32px;height:32px;font-size:16px;"><i class="material-icons">people</i></div><span class="stat-title">Total</span></div><span class="stat-value" style="font-size:22px;">${total}</span></div>
      <div class="stat-card" style="padding:14px;gap:4px;"><div class="stat-header"><div class="stat-icon stat-c-green" style="width:32px;height:32px;font-size:16px;"><i class="material-icons">check_circle</i></div><span class="stat-title">Present</span></div><span class="stat-value" style="font-size:22px;">${present}</span></div>
      <div class="stat-card" style="padding:14px;gap:4px;"><div class="stat-header"><div class="stat-icon stat-c-orange" style="width:32px;height:32px;font-size:16px;"><i class="material-icons">schedule</i></div><span class="stat-title">Late</span></div><span class="stat-value" style="font-size:22px;">${late}</span></div>
      <div class="stat-card" style="padding:14px;gap:4px;"><div class="stat-header"><div class="stat-icon stat-c-red" style="width:32px;height:32px;font-size:16px;"><i class="material-icons">cancel</i></div><span class="stat-title">Absent</span></div><span class="stat-value" style="font-size:22px;">${absent}</span></div>
    </div>
    <div style="margin-bottom:16px;display:flex;justify-content:space-between;align-items:center;">
      <h3 style="margin:0;font-size:16px;">Student Attendance</h3>
      ${isTeacherUser ? '<button id="btn-mark-all-global" class="btn btn-primary" style="font-size:13px;padding:6px 14px;"><i class="material-icons" style="font-size:16px;">check_circle</i> Mark All Present</button>' : ''}
    </div>
    <div id="global-attendance-list"></div>`;
  container.innerHTML = html;

  const listContainer = document.getElementById('global-attendance-list');
  if (listContainer) {
    Object.entries(records).forEach(([uid, rec]) => {
      const member = members.find(m => m.uid === uid);
      const el = renderAttendanceRecord(uid, rec, member, isTeacherUser, selectedClassId, selectedDate);
      listContainer.appendChild(el);
    });
    if (isTeacherUser) {
      listContainer.querySelectorAll('.att-status-select').forEach(sel => {
        sel.addEventListener('change', async () => {
          try {
            await markAttendance(selectedClassId, selectedDate, sel.dataset.uid, sel.value, currentUserProfile);
          } catch (err) { alert(err.message); }
        });
      });
      const markAllBtn = document.getElementById('btn-mark-all-global');
      if (markAllBtn) {
        markAllBtn.onclick = async () => {
          if (!confirm('Mark all students as present?')) return;
          try {
            await markAllPresent(selectedClassId, selectedDate, Object.keys(records).filter(uid => records[uid].status !== 'present'), currentUserProfile);
          } catch (err) { alert(err.message); }
        };
      }
    }
  }
}

async function loadGlobalAttendance() {
  if (!currentUserProfile) return;
  const isTeacherUser = isTeacher(currentUserProfile);

  // Populate class selector
  const classSel = document.getElementById('attendance-class-selector');
  if (classSel && userClassrooms.length > 0) {
    const currentVal = classSel.value;
    classSel.innerHTML = '<option value="">All Classrooms</option>' +
      userClassrooms.map(c => `<option value="${c.classroomId}">${c.classroomName || c.classroomId}</option>`).join('');
    if (currentVal) classSel.value = currentVal;
  }

  const datePicker = document.getElementById('attendance-date-picker');
  const monthPicker = document.getElementById('attendance-month-picker');
  if (datePicker && !datePicker.value) datePicker.value = new Date().toISOString().slice(0, 10);
  if (monthPicker && !monthPicker.value) monthPicker.value = new Date().toISOString().slice(0, 7);

  const selectedClassId = classSel?.value || '';
  const selectedDate = datePicker?.value || new Date().toISOString().slice(0, 10);
  const selectedMonth = monthPicker?.value || '';
  const selectedStudent = document.getElementById('attendance-student-selector')?.value || '';

  // If month is selected (and no specific date), show monthly view
  if (selectedMonth && !datePicker?.value) {
    if (selectedClassId) {
      try {
        const monthData = await getMonthRange(selectedClassId, selectedMonth.slice(0, 4), selectedMonth.slice(5, 7));
        renderMonthlyAttendance(selectedClassId, selectedMonth, monthData);
      } catch (e) { /* ignore */ }
    }
    globalAttendanceUnsubs.forEach(u => u());
    globalAttendanceUnsubs = [];
    populateStudentSelector();
    return;
  }

  // If a student is selected, show student history
  if (selectedStudent && !selectedClassId) {
    if (studentHistoryUnsub) studentHistoryUnsub();
    const container = document.getElementById('attendance-global-view');
    if (container) container.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:60px 0;color:var(--text-muted);">Loading history...</div>';
    studentHistoryUnsub = subscribeStudentHistory(selectedStudent, (records) => {
      renderStudentHistory(selectedStudent, records);
    });
    populateStudentSelector();
    return;
  }

  // Load dashboard stats if teacher
  if (isTeacherUser && userClassrooms.length > 0) {
    try {
      const stats = await getTodayStats(userClassrooms.map(c => c.classroomId));
      const dashClasses = document.getElementById('att-dash-classes');
      const dashTotal = document.getElementById('att-dash-total');
      const dashPresent = document.getElementById('att-dash-present');
      const dashAbsent = document.getElementById('att-dash-absent');
      if (dashClasses) dashClasses.textContent = stats.filter(s => s.total > 0).length;
      if (dashTotal) dashTotal.textContent = stats.reduce((a, s) => a + s.total, 0);
      if (dashPresent) dashPresent.textContent = stats.reduce((a, s) => a + s.present, 0);
      if (dashAbsent) dashAbsent.textContent = stats.reduce((a, s) => a + s.absent, 0);
    } catch (e) { /* ignore */ }
  }

  // Subscribe to attendance for selected class
  globalAttendanceUnsubs.forEach(u => u());
  globalAttendanceUnsubs = [];

  if (selectedClassId) {
    const membersMap = {};
    try {
      const members = await getMembers(selectedClassId);
      membersMap[selectedClassId] = members;
    } catch (e) { membersMap[selectedClassId] = []; }

    const attendanceMap = {};
    const unsub = subscribeAttendance(selectedClassId, selectedDate, (data) => {
      attendanceMap[selectedClassId] = data;
      renderGlobalAttendance(attendanceMap, selectedClassId, selectedDate, membersMap);
    });
    globalAttendanceUnsubs.push(unsub);
  } else {
    // Show all classrooms attendance
    const container = document.getElementById('attendance-global-view');
    if (container) {
      container.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:60px 0;color:var(--text-muted);">Select a specific classroom to view attendance.</div>';
    }
  }

  // Student history selector
  const studentSel = document.getElementById('attendance-student-selector');
  if (studentSel && userClassrooms.length > 0) {
    if (studentSel.options.length <= 1) {
      const allMembers = [];
      for (const c of userClassrooms) {
        try {
          const ms = await getMembers(c.classroomId);
          ms.forEach(m => { if (!allMembers.find(x => x.uid === m.uid)) allMembers.push(m); });
        } catch (e) { /* ignore */ }
      }
      studentSel.innerHTML = '<option value="">All Students</option>' +
        allMembers.map(m => `<option value="${m.uid}">${m.displayName || m.email || m.uid}</option>`).join('');
    }
  }
}

// ═══ Monthly & Student Views ═══

function renderMonthlyAttendance(classroomId, month, data) {
  const container = document.getElementById('attendance-global-view');
  if (!container) return;
  const [year, mon] = month.split('-').map(Number);
  const daysInMonth = new Date(year, mon, 0).getDate();
  const recordsByDate = {};
  data.forEach(d => { recordsByDate[d.date] = d.records || {}; });

  let totalPresent = 0, totalAbsent = 0, totalLate = 0, totalDays = 0;
  let html = `<div style="margin-bottom:16px;"><h3 style="margin:0;font-size:16px;">Monthly Attendance — ${month}</h3></div>
    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin-bottom:20px;">`;
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${month}-${String(d).padStart(2, '0')}`;
    const dayRecords = recordsByDate[dateStr];
    const vals = dayRecords ? Object.values(dayRecords) : [];
    const pres = vals.filter(r => r.status === 'present').length;
    const abs = vals.filter(r => r.status === 'absent').length;
    const lat = vals.filter(r => r.status === 'late').length;
    const total = vals.length;
    if (total > 0) { totalDays++; totalPresent += pres; totalAbsent += abs; totalLate += lat; }
    const pct = total > 0 ? Math.round(pres / total * 100) : 0;
    const color = total === 0 ? 'var(--bg-tertiary)' : pct >= 80 ? 'var(--success)' : pct >= 50 ? 'var(--warning)' : 'var(--danger)';
    html += `<div style="padding:8px;border-radius:8px;background:${color}20;border:1px solid ${color}40;text-align:center;font-size:12px;">
      <div style="font-weight:600;color:var(--text-main);">${d}</div>
      ${total > 0 ? `<div style="font-size:11px;color:var(--text-muted);">${pres}/${total}</div>` : '<div style="font-size:11px;color:var(--text-muted);">—</div>'}
    </div>`;
  }
  html += `</div>`;
  html += `<div class="stats-grid" style="grid-template-columns:repeat(4,1fr);">
    <div class="stat-card" style="padding:14px;gap:4px;"><div class="stat-header"><div class="stat-icon stat-c-blue" style="width:32px;height:32px;font-size:16px;"><i class="material-icons">today</i></div><span class="stat-title">Days</span></div><span class="stat-value" style="font-size:22px;">${totalDays}</span></div>
    <div class="stat-card" style="padding:14px;gap:4px;"><div class="stat-header"><div class="stat-icon stat-c-green" style="width:32px;height:32px;font-size:16px;"><i class="material-icons">check_circle</i></div><span class="stat-title">Present</span></div><span class="stat-value" style="font-size:22px;">${totalPresent}</span></div>
    <div class="stat-card" style="padding:14px;gap:4px;"><div class="stat-header"><div class="stat-icon stat-c-orange" style="width:32px;height:32px;font-size:16px;"><i class="material-icons">schedule</i></div><span class="stat-title">Late</span></div><span class="stat-value" style="font-size:22px;">${totalLate}</span></div>
    <div class="stat-card" style="padding:14px;gap:4px;"><div class="stat-header"><div class="stat-icon stat-c-red" style="width:32px;height:32px;font-size:16px;"><i class="material-icons">cancel</i></div><span class="stat-title">Absent</span></div><span class="stat-value" style="font-size:22px;">${totalAbsent}</span></div>
  </div>`;
  container.innerHTML = html;
}

function renderStudentHistory(studentUid, records) {
  const container = document.getElementById('attendance-global-view');
  if (!container) return;
  if (!records || records.length === 0) {
    container.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:60px 0;color:var(--text-muted);">No attendance history for this student.</div>';
    return;
  }
  const total = records.length;
  const present = records.filter(r => r.status === 'present').length;
  const late = records.filter(r => r.status === 'late').length;
  const absent = records.filter(r => r.status === 'absent').length;
  const pct = Math.round(present / total * 100);

  let html = `<div style="margin-bottom:16px;"><h3 style="margin:0;font-size:16px;">Attendance History — ${studentUid}</h3></div>
    <div class="stats-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:20px;">
      <div class="stat-card" style="padding:14px;gap:4px;"><div class="stat-header"><div class="stat-icon stat-c-blue" style="width:32px;height:32px;font-size:16px;"><i class="material-icons">event</i></div><span class="stat-title">Total Days</span></div><span class="stat-value" style="font-size:22px;">${total}</span></div>
      <div class="stat-card" style="padding:14px;gap:4px;"><div class="stat-header"><div class="stat-icon stat-c-green" style="width:32px;height:32px;font-size:16px;"><i class="material-icons">check_circle</i></div><span class="stat-title">Present</span></div><span class="stat-value" style="font-size:22px;">${present}</span></div>
      <div class="stat-card" style="padding:14px;gap:4px;"><div class="stat-header"><div class="stat-icon stat-c-orange" style="width:32px;height:32px;font-size:16px;"><i class="material-icons">schedule</i></div><span class="stat-title">Late</span></div><span class="stat-value" style="font-size:22px;">${late}</span></div>
      <div class="stat-card" style="padding:14px;gap:4px;"><div class="stat-header"><div class="stat-icon stat-c-green" style="width:32px;height:32px;font-size:16px;"><i class="material-icons">percent</i></div><span class="stat-title">Attendance %</span></div><span class="stat-value" style="font-size:22px;">${pct}%</span></div>
    </div>
    <div style="display:flex;flex-direction:column;gap:6px;">`;
  records.slice(0, 100).forEach(r => {
    const cls = r.status === 'present' ? 'bg-success-dim' : r.status === 'late' ? 'bg-warning-dim' : 'bg-archived-dim';
    html += `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 14px;background:var(--card-bg);border:1px solid var(--border);border-radius:var(--radius);">
      <span style="font-size:13px;color:var(--text-main);">${r.date || r.id || '—'}</span>
      <span style="font-size:13px;color:var(--text-muted);">${r.classroomId || ''}</span>
      <span class="badge-status ${cls}">${r.status.charAt(0).toUpperCase() + r.status.slice(1)}</span>
    </div>`;
  });
  html += `</div>`;
  container.innerHTML = html;
}

async function populateStudentSelector() {
  const studentSel = document.getElementById('attendance-student-selector');
  if (!studentSel || studentSel.options.length > 1) return;
  const allMembers = [];
  for (const c of userClassrooms) {
    try {
      const ms = await getMembers(c.classroomId);
      ms.forEach(m => { if (!allMembers.find(x => x.uid === m.uid)) allMembers.push(m); });
    } catch (e) { /* ignore */ }
  }
  studentSel.innerHTML = '<option value="">All Students</option>' +
    allMembers.map(m => `<option value="${m.uid}">${m.displayName || m.email || m.uid}</option>`).join('');
}

// ═══ Attendance Event Handlers ═══

// Load global attendance when tab becomes active (via renderClassrooms hook, but also on direct access)
function initGlobalAttendance() {
  if (document.getElementById('tab-attendance')?.classList.contains('active-tab')) {
    loadGlobalAttendance();
  }
}

document.getElementById('attendance-class-selector')?.addEventListener('change', loadGlobalAttendance);
document.getElementById('attendance-date-picker')?.addEventListener('change', loadGlobalAttendance);
document.getElementById('attendance-month-picker')?.addEventListener('change', loadGlobalAttendance);
document.getElementById('attendance-student-selector')?.addEventListener('change', loadGlobalAttendance);

document.getElementById('btn-attendance-export-global')?.addEventListener('click', async () => {
  try {
    const classId = document.getElementById('attendance-class-selector')?.value;
    const date = document.getElementById('attendance-date-picker')?.value;
    if (!classId || !date) { alert('Select a classroom and date first.'); return; }
    const data = await new Promise((resolve) => {
      const unsub = subscribeAttendance(classId, date, (d) => { unsub(); resolve(d); });
    });
    if (!data) { alert('No attendance data for this date.'); return; }
    data.classroomId = classId;
    const csv = exportCSV([data]);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `attendance-${classId}-${date}.csv`; a.click();
    URL.revokeObjectURL(url);
  } catch (err) { alert(err.message); }
});

document.getElementById('btn-attendance-export')?.addEventListener('click', async () => {
  const classId = detailCurrentClassroomId;
  const date = document.getElementById('detail-attendance-date')?.value;
  if (!classId || !date) { alert('Select a date first.'); return; }
  const data = await new Promise((resolve) => {
    const unsub = subscribeAttendance(classId, date, (d) => { unsub(); resolve(d); });
  });
  if (!data) { alert('No attendance data for this date.'); return; }
  data.classroomId = classId;
  const csv = exportCSV([data]);
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `attendance-${classId}-${date}.csv`; a.click();
  URL.revokeObjectURL(url);
});

// ═══════════════════════════ CALENDAR ═══════════════════════════

function renderCalendar() {
  if (typeof calendarView === 'undefined') calendarView = 'month';
  const year = calendarDate.getFullYear();
  const month = calendarDate.getMonth();
  const headerLabel = document.getElementById('calendar-header-label');
  if (headerLabel) headerLabel.textContent = new Date(year, month).toLocaleDateString('en-US', { year: 'numeric', month: 'long' });

  if (calendarView === 'month') {
    renderMonthGrid(year, month);
  } else {
    renderWeekGrid(year, month);
  }

  // Update view buttons
  document.getElementById('btn-calendar-month')?.classList.toggle('btn-primary', calendarView === 'month');
  document.getElementById('btn-calendar-month')?.classList.toggle('btn-outline', calendarView !== 'month');
  document.getElementById('btn-calendar-week')?.classList.toggle('btn-primary', calendarView === 'week');
  document.getElementById('btn-calendar-week')?.classList.toggle('btn-outline', calendarView !== 'week');
}

function renderMonthGrid(year, month) {
  const grid = document.getElementById('calendar-grid');
  if (!grid) return;
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();

  const eventsByDate = {};
  calendarEventsCache.forEach(e => {
    const d = e.date instanceof Date ? e.date : new Date(e.date);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (!eventsByDate[key]) eventsByDate[key] = [];
    eventsByDate[key].push(e);
  });

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let html = `<div class="cal-header" style="display:grid;grid-template-columns:repeat(7,1fr);background:var(--bg-color);border-bottom:1px solid var(--border);">
    ${dayNames.map(d => `<div style="padding:12px 8px;text-align:center;font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;">${d}</div>`).join('')}</div>
    <div class="cal-body" style="display:grid;grid-template-columns:repeat(7,1fr);">`;

  for (let i = 0; i < firstDay; i++) {
    html += `<div class="cal-cell cal-cell--empty"></div>`;
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${year}-${month}-${d}`;
    const dayEvents = eventsByDate[key] || [];
    const isToday = d === today.getDate() && month === today.getMonth() && year === today.getFullYear();
    const isSelected = selectedCalendarDay && d === selectedCalendarDay.getDate() && month === selectedCalendarDay.getMonth() && year === selectedCalendarDay.getFullYear();
    // Color codes for event types
    const colorDots = dayEvents.map(e => `<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${e.color || 'var(--primary)'};"></span>`).join('');
    html += `<div class="cal-cell ${isToday ? 'cal-cell--today' : ''} ${isSelected ? 'cal-cell--selected' : ''}" data-day="${d}">
      <div class="cal-cell-date">${d}</div>
      ${dayEvents.length > 0 ? `<div class="cal-cell-dots">${colorDots}</div><div class="cal-cell-count">${dayEvents.length}</div>` : ''}
    </div>`;
  }

  html += `</div>`;
  grid.innerHTML = html;

  grid.querySelectorAll('.cal-cell:not(.cal-cell--empty)').forEach(cell => {
    cell.addEventListener('click', () => {
      const day = parseInt(cell.dataset.day);
      selectedCalendarDay = new Date(year, month, day);
      renderCalendar();
      renderDayDetail(selectedCalendarDay);
    });
  });
}

function renderWeekGrid(year, month) {
  const grid = document.getElementById('calendar-grid');
  if (!grid) return;
  const today = new Date();
  const startOfWeek = new Date(calendarDate);
  startOfWeek.setDate(calendarDate.getDate() - calendarDate.getDay());
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 6);

  const eventsByDate = {};
  calendarEventsCache.forEach(e => {
    const d = e.date instanceof Date ? e.date : new Date(e.date);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (!eventsByDate[key]) eventsByDate[key] = [];
    eventsByDate[key].push(e);
  });

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let html = `<div class="cal-header" style="display:grid;grid-template-columns:repeat(7,1fr);background:var(--bg-color);border-bottom:1px solid var(--border);">
    ${dayNames.map(d => `<div style="padding:12px 8px;text-align:center;font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;">${d}</div>`).join('')}</div>
    <div class="cal-body" style="display:grid;grid-template-columns:repeat(7,1fr);">`;

  for (let d = new Date(startOfWeek); d <= endOfWeek; d.setDate(d.getDate() + 1)) {
    const day = d.getDate();
    const key = `${d.getFullYear()}-${d.getMonth()}-${day}`;
    const dayEvents = eventsByDate[key] || [];
    const isToday = day === today.getDate() && d.getMonth() === today.getMonth() && d.getFullYear() === today.getFullYear();
    const isSelected = selectedCalendarDay && day === selectedCalendarDay.getDate() && d.getMonth() === selectedCalendarDay.getMonth() && d.getFullYear() === selectedCalendarDay.getFullYear();

    let dayHtml = `<div class="cal-cell ${isToday ? 'cal-cell--today' : ''} ${isSelected ? 'cal-cell--selected' : ''}" data-day="${day}" data-full="${d.toISOString()}">
      <div class="cal-cell-date">${day}</div>`;
    if (dayEvents.length > 0) {
      dayHtml += `<div style="margin-top:4px;display:flex;flex-direction:column;gap:2px;">`;
      dayEvents.slice(0, 3).forEach(e => {
        dayHtml += `<div style="font-size:10px;padding:2px 4px;border-radius:4px;background:${e.color || 'var(--primary)'}20;color:var(--text-main);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${e.title}</div>`;
      });
      if (dayEvents.length > 3) dayHtml += `<div style="font-size:10px;color:var(--text-muted);padding:0 4px;">+${dayEvents.length - 3} more</div>`;
      dayHtml += `</div>`;
    }
    dayHtml += `</div>`;
    html += dayHtml;
  }

  html += `</div>`;
  grid.innerHTML = html;

  grid.querySelectorAll('.cal-cell:not(.cal-cell--empty)').forEach(cell => {
    cell.addEventListener('click', () => {
      const day = parseInt(cell.dataset.day);
      selectedCalendarDay = new Date(year, month, day);
      renderCalendar();
      renderDayDetail(selectedCalendarDay);
    });
  });
}

function renderDayDetail(date) {
  const container = document.getElementById('calendar-event-detail');
  if (!container) return;
  const dateStr = date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const dayEvents = calendarEventsCache.filter(e => {
    const d = e.date instanceof Date ? e.date : new Date(e.date);
    return d.getFullYear() === date.getFullYear() && d.getMonth() === date.getMonth() && d.getDate() === date.getDate();
  });

  let html = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
    <h3 style="margin:0;font-size:16px;">Events for ${dateStr}</h3>
    <span style="font-size:13px;color:var(--text-muted);">${dayEvents.length} event${dayEvents.length !== 1 ? 's' : ''}</span>
  </div>`;

  if (dayEvents.length === 0) {
    html += `<div class="empty-state-sm" style="text-align:center;padding:40px 0;color:var(--text-muted);font-size:14px;">No events on this day.</div>`;
  } else {
    dayEvents.forEach(e => {
      const time = e.date instanceof Date ? e.date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '';
      html += `<div style="display:flex;align-items:center;gap:14px;padding:14px 18px;background:var(--card-bg);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:8px;">
        <div style="width:4px;height:40px;border-radius:4px;background:${e.color || 'var(--primary)'};flex-shrink:0;"></div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;font-size:14px;color:var(--text-main);">${e.title}</div>
          <div style="font-size:12px;color:var(--text-muted);">${e.source || ''}${e.classroomId ? ' · ' + e.classroomId : ''}</div>
          ${e.description ? `<div style="font-size:12px;color:var(--text-muted);margin-top:4px;">${e.description}</div>` : ''}
        </div>
        <div style="font-size:12px;color:var(--text-muted);text-align:right;flex-shrink:0;">
          <div>${time}</div>
          <span class="badge-status" style="font-size:10px;padding:2px 8px;background:${e.color}20;color:${e.color};">${e.type}</span>
        </div>
      </div>`;
    });
  }

  container.innerHTML = html;
}

async function loadCalendarEvents(uid) {
  if (!Array.isArray(userClassrooms)) userClassrooms = [];
  const classList = userClassrooms.length
    ? userClassrooms
    : (window.currentUserClassrooms && Array.isArray(window.currentUserClassrooms) ? window.currentUserClassrooms : []);
  if (classList.length === 0) return;
  const year = calendarDate.getFullYear();
  const month = calendarDate.getMonth();
  const startDate = new Date(year, month, 1);
  const endDate = new Date(year, month + 1, 0, 23, 59, 59);

  try {
    // Fetch from services
    const classEvents = await fetchCalendarEvents(classList.map(c => c.classroomId), startDate, endDate);

    // Merge with reminders
    const allEvents = [...classEvents];

    calendarEventsCache = allEvents;
    renderCalendar();
    if (selectedCalendarDay) {
      renderDayDetail(selectedCalendarDay);
    }
  } catch (e) { /* ignore */ }
}

// Calendar event handlers
document.getElementById('btn-calendar-prev')?.addEventListener('click', () => {
  if (calendarView === 'month') {
    calendarDate.setMonth(calendarDate.getMonth() - 1);
  } else {
    calendarDate.setDate(calendarDate.getDate() - 7);
  }
  loadCalendarEvents();
});

document.getElementById('btn-calendar-next')?.addEventListener('click', () => {
  if (calendarView === 'month') {
    calendarDate.setMonth(calendarDate.getMonth() + 1);
  } else {
    calendarDate.setDate(calendarDate.getDate() + 7);
  }
  loadCalendarEvents();
});

document.getElementById('btn-calendar-today')?.addEventListener('click', () => {
  calendarDate = new Date();
  selectedCalendarDay = new Date();
  loadCalendarEvents();
});

document.getElementById('btn-calendar-month')?.addEventListener('click', () => {
  calendarView = 'month';
  renderCalendar();
});

document.getElementById('btn-calendar-week')?.addEventListener('click', () => {
  calendarView = 'week';
  renderCalendar();
});

document.getElementById('btn-add-reminder')?.addEventListener('click', () => {
  const dateInput = document.getElementById('reminder-date');
  if (dateInput) dateInput.value = new Date().toISOString().slice(0, 10);
  document.getElementById('reminder-alert').style.display = 'none';
  document.getElementById('modal-add-reminder').style.display = 'flex';
});

document.getElementById('form-add-reminder')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentUserProfile) return;
  const btn = document.getElementById('btn-submit-reminder');
  btn.disabled = true;
  try {
    await createReminder(currentUserProfile.uid, {
      title: document.getElementById('reminder-title').value,
      description: document.getElementById('reminder-desc').value,
      date: document.getElementById('reminder-date').value,
    });
    document.getElementById('form-add-reminder').reset();
    document.getElementById('modal-add-reminder').style.display = 'none';
    loadCalendarEvents(); // Refresh reminders
  } catch (err) {
    const alertEl = document.getElementById('reminder-alert');
    alertEl.className = 'alert error';
    alertEl.textContent = err.message;
    alertEl.style.display = 'block';
    setTimeout(() => alertEl.style.display = 'none', 4000);
  } finally { btn.disabled = false; }
});

// Init reminders subscription
function initCalendar(uid) {
  if (remindersUnsub) remindersUnsub();
  remindersUnsub = subscribeReminders(uid, (reminders) => {
    // Merge reminders into cache
    const reminderEvents = reminders.map(r => ({
      id: r.id, type: 'reminder', title: r.title, description: r.description || '',
      date: r.date ? new Date(r.date + 'T00:00:00') : new Date(),
      source: 'Personal', color: 'var(--secondary)', classroomId: null,
    }));
    // Rebuild events cache - classroom events + reminders
    const classEvents = calendarEventsCache.filter(e => e.type !== 'reminder');
    calendarEventsCache = [...classEvents, ...reminderEvents];
    renderCalendar();
    if (selectedCalendarDay) renderDayDetail(selectedCalendarDay);
  });
}

// ═══════════════════════════ NOTIFICATIONS ═══════════════════════

function parseNotifTime(n) {
  const t = n?.createdAt;
  if (!t) return null;
  if (typeof t.toDate === 'function') return t.toDate();
  if (typeof t === 'string' || typeof t === 'number') return new Date(t);
  return null;
}

function renderNotificationItem(notif, compact = false) {
  const div = document.createElement('div');
  const isRead = notif.isRead === undefined ? !!notif.read : !!notif.isRead;
  div.className = `notif-item ${isRead ? 'notif-item--read' : ''}`;
  const icons = { assignment: 'assignment', quiz: 'quiz', meeting: 'videocam', announcement: 'campaign', chat: 'forum', attendance: 'fact_check', system: 'info', join_request: 'person_add' };
  const icon = icons[notif.type] || 'notifications';
  const time = parseNotifTime(notif);
  const timeStr = time ? time.toLocaleString() : '';
  const body = notif.message || notif.body || '';
  div.innerHTML = `
    <div class="notif-icon"><i class="material-icons" style="font-size:20px;">${icon}</i></div>
    <div class="notif-content">
      <div class="notif-title">${notif.title}</div>
      <div class="notif-body">${body}</div>
      <div class="notif-time">${timeStr}</div>
    </div>
    ${!compact ? `<div class="notif-actions">${!isRead ? `<button class="notif-mark-read icon-btn" data-id="${notif.id}" style="font-size:16px;"><i class="material-icons">mark_email_read</i></button>` : ''}<button class="notif-delete icon-btn" data-id="${notif.id}" style="font-size:16px;color:var(--text-muted);"><i class="material-icons">delete</i></button></div>` : ''}`;
  return div;
}

function renderNotificationDropdown(notifications) {
  const list = document.getElementById('notif-dropdown-list');
  if (!list) return;
  const isUnread = (n) => n.isRead === undefined ? !n.read : !n.isRead;
  const unread = notifications.filter(isUnread);
  const badge = document.getElementById('notif-badge');
  if (badge) {
    if (unread.length > 0) {
      badge.textContent = unread.length > 99 ? '99+' : unread.length;
      badge.style.display = '';
    } else {
      // Force-clear: if nothing in the notifications collection is unread for
      // this user, the badge MUST show nothing (removes any stale red '1').
      badge.textContent = '0';
      badge.style.display = 'none';
    }
  }

  if (notifications.length === 0) {
    list.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px;">No notifications yet.</div>';
    return;
  }
  list.innerHTML = '';
  [...notifications]
    .sort((a, b) => ((parseNotifTime(b) || 0) - (parseNotifTime(a) || 0)))
    .slice(0, 10)
    .forEach(n => {
      const el = renderNotificationItem(n, true);
      el.addEventListener('click', async () => {
        if (!isUnread(n)) return;
        try { await markAsRead(n.id); } catch (e) { /* ignore */ }
      });
      list.appendChild(el);
    });
}

function renderNotificationFullList(notifications) {
  const container = document.getElementById('notifications-full-list');
  if (!container) return;
  if (notifications.length === 0) {
    container.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:60px 0;color:var(--text-muted);">No notifications yet.</div>';
    return;
  }
  container.innerHTML = '';
  [...notifications]
    .sort((a, b) => ((parseNotifTime(b) || 0) - (parseNotifTime(a) || 0)))
    .forEach(n => {
      const el = renderNotificationItem(n, false);
      container.appendChild(el);

    const markBtn = el.querySelector('.notif-mark-read');
    if (markBtn) markBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try { await markAsRead(n.id); } catch (e) { /* ignore */ }
    });

    const delBtn = el.querySelector('.notif-delete');
    if (delBtn) delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try { await deleteNotification(n.id); } catch (e) { /* ignore */ }
    });
  });
}

function initNotifications(uid) {
  if (notificationsUnsub) notificationsUnsub();
  notificationsUnsub = subscribeNotifications(uid, (notifications) => {
    notificationsCache = notifications;
    renderNotificationDropdown(notifications);
    if (document.getElementById('tab-notifications')?.classList.contains('active-tab')) {
      renderNotificationFullList(notifications);
    }
  });

  // Setup FCM
  setupFCM(uid).catch(() => {});
  onForegroundMessage((payload) => {
    const title = payload.notification?.title || 'New Notification';
    const body = payload.notification?.body || '';
    // Add to notifications collection if it has data
    if (payload.data) {
      createNotification(uid, payload.data.type || 'system', title, body, payload.data).catch(() => {});
    }
    // Show browser notification
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body, icon: '/favicon.ico' });
    }
  });
}

// Notification event handlers
document.getElementById('notification-bell')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const dropdown = document.getElementById('notification-dropdown');
  if (dropdown) dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
});

document.addEventListener('click', (e) => {
  const dropdown = document.getElementById('notification-dropdown');
  const bell = document.getElementById('notification-bell');
  if (dropdown && bell && !dropdown.contains(e.target) && !bell.contains(e.target)) {
    dropdown.style.display = 'none';
  }
});

document.getElementById('btn-mark-all-read')?.addEventListener('click', async () => {
  if (!currentUserProfile) return;
  try { await markAllAsRead(currentUserProfile.uid); } catch (e) { /* ignore */ }
});

document.getElementById('btn-notif-mark-all')?.addEventListener('click', async () => {
  if (!currentUserProfile) return;
  try { await markAllAsRead(currentUserProfile.uid); } catch (e) { /* ignore */ }
});

document.getElementById('btn-view-all-notifications')?.addEventListener('click', () => {
  const notifTab = document.querySelector('.nav-item[data-tab="notifications"]');
  if (notifTab) notifTab.click();
  document.getElementById('notification-dropdown').style.display = 'none';
});

// ═══ Notification creation hooks ═══

function hookAssignmentNotifications() {
  const origSubmit = document.getElementById('form-create-assignment')?.onsubmit;
  document.getElementById('form-create-assignment')?.addEventListener('submit', async (e) => {
    // Notifications are created after the assignment creation completes
    // We use a microtask to hook after the original handler
    setTimeout(async () => {
      if (!currentUserProfile || !userClassrooms.length) return;
      const classroomId = document.getElementById('create-assignment-classroom')?.value;
      if (!classroomId) return;
      try {
        const members = await getMembers(classroomId);
        const studentIds = members.filter(m => (m.role || 'student').toLowerCase() === 'student').map(m => m.uid);
        if (studentIds.length > 0) {
          const title = document.getElementById('create-assignment-title')?.value || 'New Assignment';
          await createBulkNotifications(studentIds, 'assignment', title, `A new assignment has been posted.`, { classroomId });
        }
      } catch (e) { /* ignore */ }
    }, 100);
  }, true);
}

function hookQuizNotifications() {
  document.getElementById('form-create-quiz')?.addEventListener('submit', async (e) => {
    setTimeout(async () => {
      if (!currentUserProfile || !userClassrooms.length) return;
      const classroomId = document.getElementById('create-quiz-classroom')?.value || currentQuizClassId;
      if (!classroomId) return;
      try {
        const members = await getMembers(classroomId);
        const studentIds = members.filter(m => (m.role || 'student').toLowerCase() === 'student').map(m => m.uid);
        if (studentIds.length > 0) {
          const title = document.getElementById('create-quiz-title')?.value || 'New Quiz';
          await createBulkNotifications(studentIds, 'quiz', title, `A new quiz is available.`, { classroomId });
        }
      } catch (e) { /* ignore */ }
    }, 100);
  }, true);
}

function hookMeetingNotifications() {
  document.getElementById('form-create-meeting')?.addEventListener('submit', async (e) => {
    setTimeout(async () => {
      if (!currentUserProfile || !userClassrooms.length) return;
      const classroomId = document.getElementById('create-meeting-classroom')?.value;
      if (!classroomId) return;
      try {
        const members = await getMembers(classroomId);
        const studentIds = members.filter(m => (m.role || 'student').toLowerCase() === 'student').map(m => m.uid);
        if (studentIds.length > 0) {
          const title = document.getElementById('create-meeting-title')?.value || 'Live Meeting';
          await createBulkNotifications(studentIds, 'meeting', title, `A live meeting has started.`, { classroomId, meetingLink: document.getElementById('create-meeting-title')?.value });
        }
      } catch (e) { /* ignore */ }
    }, 100);
  }, true);
}

// Hook into renderClassrooms to init calendar and analytics
const origRC3 = renderClassrooms;
renderClassrooms = function(classrooms, errorMsg) {
  try {
    origRC3(classrooms, errorMsg);
  } catch (err) {
    console.error('origRC3 base renderClassrooms error:', err);
  }
  try {
  if (document.getElementById('tab-calendar')) {
    loadCalendarEvents();
    if (currentUserProfile) initCalendar(currentUserProfile.uid);
  }
  if (document.getElementById('tab-analytics')) {
    loadAnalytics();
  }
  if (document.getElementById('tab-approvals')) {
    loadStudentRequests();
  }
  } catch (err) {
    console.error('renderClassrooms calendar/analytics/approvals init error:', err);
  }
};

// ═══ Init when user signs in ═══
function initCalendarAndNotifications() {
  if (!currentUserProfile) return;
  initCalendar(currentUserProfile.uid);
  initNotifications(currentUserProfile.uid);
  hookAssignmentNotifications();
  hookQuizNotifications();
  hookMeetingNotifications();
  // Load calendar events if tab exists
  if (document.getElementById('tab-calendar')) loadCalendarEvents();
}

// ═══════════════════════════ ANALYTICS ═══════════════════════════

function destroyAnalyticsCharts() {
  analyticsChartInstances.forEach(c => { try { c.destroy(); } catch (e) { /* ignore */ } });
  analyticsChartInstances = [];
}

function initAnalyticsChart(canvasId, type, labels, data, label, color) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  try {
    const chart = new Chart(ctx, {
      type,
      data: {
        labels,
        datasets: [{
          label,
          data,
          backgroundColor: color || 'rgba(59,130,246,0.3)',
          borderColor: color || '#3B82F6',
          borderWidth: 2,
          tension: 0.3,
          fill: true,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#94A3B8' } },
          x: { grid: { display: false }, ticks: { color: '#94A3B8', maxRotation: 45 } }
        }
      }
    });
    analyticsChartInstances.push(chart);
    return chart;
  } catch (e) { return null; }
}

async function loadAnalytics() {
  if (!currentUserProfile || userClassrooms.length === 0) {
    document.querySelectorAll('#tab-analytics .stat-value').forEach(el => { if (el.id.startsWith('ana-')) el.textContent = '0'; });
    return;
  }
  destroyAnalyticsCharts();
  const classSel = document.getElementById('analytics-class-selector');
  const studentSel = document.getElementById('analytics-student-selector');
  const selectedClassId = classSel?.value || '';
  const selectedStudentId = studentSel?.value || '';

  // Populate class selector
  if (classSel && classSel.options.length <= 1 && userClassrooms.length > 0) {
    classSel.innerHTML = '<option value="">All Classrooms</option>' +
      userClassrooms.map(c => `<option value="${c.classroomId}">${c.classroomName || c.classroomId}</option>`).join('');
  }

  let overview = { classrooms: userClassrooms.length, students: 0, assignments: 0, quizzes: 0, attendance: 0 };
  let assignLabels = [], assignData = [], quizLabels = [], quizData = [], attLabels = [], attData = [];
  let assignTableHtml = '', quizTableHtml = '';

  if (selectedClassId) {
    try {
      const data = await getClassroomAnalytics(selectedClassId);
      analyticsClassData = data;
      overview = {
        classrooms: 1,
        students: data.members.students,
        assignments: data.assignments.total,
        quizzes: data.quizzes.total,
        attendance: data.attendance.avgRate,
      };

      assignLabels = data.assignments.data.map(a => a.title.length > 15 ? a.title.slice(0, 15) + '...' : a.title);
      assignData = data.assignments.data.map(a => a.completionRate);
      quizLabels = data.quizzes.data.map(q => q.title.length > 15 ? q.title.slice(0, 15) + '...' : q.title);
      quizData = data.quizzes.data.map(q => q.avgScore);
      attLabels = data.attendance.records.map(r => r.date ? r.date.slice(5) : '');
      attData = data.attendance.records.map(r => r.rate);

      assignTableHtml = data.assignments.data.length > 0
        ? `<table style="width:100%;border-collapse:collapse;font-size:13px;">
            <tr style="border-bottom:1px solid var(--border);"><th style="text-align:left;padding:8px;color:var(--text-muted);">Assignment</th><th style="text-align:center;padding:8px;color:var(--text-muted);">Submitted</th><th style="text-align:center;padding:8px;color:var(--text-muted);">Completion</th></tr>
            ${data.assignments.data.map(a => `<tr style="border-bottom:1px solid var(--border);">
              <td style="padding:8px;color:var(--text-main);">${a.title}</td>
              <td style="text-align:center;padding:8px;color:var(--text-muted);">${a.submitted}/${a.totalStudents}</td>
              <td style="text-align:center;padding:8px;"><span style="padding:2px 10px;border-radius:4px;font-size:12px;background:${a.completionRate >= 80 ? 'rgba(34,197,94,0.15)' : a.completionRate >= 50 ? 'rgba(245,158,11,0.15)' : 'rgba(239,68,68,0.15)'};color:${a.completionRate >= 80 ? 'var(--success)' : a.completionRate >= 50 ? 'var(--warning)' : 'var(--danger)'};">${a.completionRate}%</span></td>
            </tr>`).join('')}</table>`
        : '<div style="text-align:center;padding:30px;color:var(--text-muted);font-size:13px;">No assignments.</div>';

      quizTableHtml = data.quizzes.data.length > 0
        ? `<table style="width:100%;border-collapse:collapse;font-size:13px;">
            <tr style="border-bottom:1px solid var(--border);"><th style="text-align:left;padding:8px;color:var(--text-muted);">Quiz</th><th style="text-align:center;padding:8px;color:var(--text-muted);">Attempts</th><th style="text-align:center;padding:8px;color:var(--text-muted);">Avg Score</th></tr>
            ${data.quizzes.data.map(q => `<tr style="border-bottom:1px solid var(--border);">
              <td style="padding:8px;color:var(--text-main);">${q.title}</td>
              <td style="text-align:center;padding:8px;color:var(--text-muted);">${q.totalAttempts}</td>
              <td style="text-align:center;padding:8px;color:var(--text-main);">${q.avgScore}</td>
            </tr>`).join('')}</table>`
        : '<div style="text-align:center;padding:30px;color:var(--text-muted);font-size:13px;">No quizzes.</div>';

      // Populate student selector for this class
      if (studentSel) {
        try {
          const members = await getMembers(selectedClassId);
          studentSel.innerHTML = '<option value="">All Students</option>' +
            members.filter(m => (m.role || 'student').toLowerCase() === 'student').map(m =>
              `<option value="${m.uid}">${m.displayName || m.email || m.uid}</option>`
            ).join('');
          if (selectedStudentId) studentSel.value = selectedStudentId;
        } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
  } else {
    // Aggregate across all classrooms
    let totalStudents = 0, totalAssign = 0, totalQuizzes = 0, totalAtt = 0, attCount = 0;
    for (const c of userClassrooms) {
      try {
        const data = await getClassroomAnalytics(c.classroomId);
        totalStudents += data.members.students;
        totalAssign += data.assignments.total;
        totalQuizzes += data.quizzes.total;
        totalAtt += data.attendance.avgRate;
        attCount++;
        data.assignments.data.forEach(a => { assignLabels.push(a.title); assignData.push(a.completionRate); });
        data.quizzes.data.forEach(q => { quizLabels.push(q.title); quizData.push(q.avgScore); });
        data.attendance.records.forEach(r => { attLabels.push(r.date ? r.date.slice(5) : ''); attData.push(r.rate); });
      } catch (e) { /* ignore */ }
    }
    overview = { classrooms: userClassrooms.length, students: totalStudents, assignments: totalAssign, quizzes: totalQuizzes, attendance: attCount > 0 ? Math.round(totalAtt / attCount) : 0 };
  }

  // Update overview cards
  document.getElementById('ana-classrooms').textContent = overview.classrooms;
  document.getElementById('ana-students').textContent = overview.students;
  document.getElementById('ana-assignments').textContent = overview.assignments;
  document.getElementById('ana-quizzes').textContent = overview.quizzes;
  document.getElementById('ana-attendance').textContent = overview.attendance + '%';

  // Render charts
  initAnalyticsChart('chart-assignment', 'bar', assignLabels, assignData, 'Completion Rate', 'rgba(59,130,246,0.6)');
  initAnalyticsChart('chart-quiz', 'bar', quizLabels, quizData, 'Avg Score', 'rgba(139,92,246,0.6)');
  initAnalyticsChart('chart-attendance', 'line', attLabels, attData, 'Attendance %', 'rgba(34,197,94,0.6)');

  // Render tables
  document.getElementById('analytics-assignment-table').innerHTML = assignTableHtml || '<div style="text-align:center;padding:30px;color:var(--text-muted);font-size:13px;">No data.</div>';
  document.getElementById('analytics-quiz-table').innerHTML = quizTableHtml || '<div style="text-align:center;padding:30px;color:var(--text-muted);font-size:13px;">No data.</div>';

  // Student performance chart (if student selected)
  if (selectedStudentId && selectedClassId) {
    try {
      const perf = await getStudentPerformance(selectedStudentId, [selectedClassId]);
      const sLabels = ['Assignments', 'Quizzes', 'Attendance'];
      const sData = [perf.assignments.avgScore, perf.quizzes.avgScore, perf.attendance.rate];
      initAnalyticsChart('chart-student', 'radar', sLabels, sData, 'Performance', 'rgba(59,130,246,0.3)');
    } catch (e) { /* ignore */ }
  }
}

// Analytics event handlers
document.getElementById('analytics-class-selector')?.addEventListener('change', loadAnalytics);
document.getElementById('analytics-student-selector')?.addEventListener('change', loadAnalytics);

document.getElementById('btn-analytics-export-csv')?.addEventListener('click', () => {
  const d = analyticsClassData;
  if (!d || !d.assignments || !d.assignments.data) { alert('Load classroom analytics first.'); return; }
  const headers = ['Metric', 'Value'];
  const rows = [
    ['Classroom', d.classroom?.name || ''],
    ['Total Students', d.members?.students || 0],
    ['Total Assignments', d.assignments?.total || 0],
    ['Avg Completion Rate', d.assignments?.avgCompletion + '%' || '0%'],
    ['Total Quizzes', d.quizzes?.total || 0],
    ['Avg Quiz Score', d.quizzes?.avgScore || 0],
    ['Avg Attendance Rate', d.attendance?.avgRate + '%' || '0%'],
    ['', ''],
    ['Assignment Details'],
    ['Title', 'Submitted', 'Total', 'Completion Rate'],
    ...(d.assignments?.data || []).map(a => [a.title, String(a.submitted), String(a.totalStudents), a.completionRate + '%']),
  ];
  const csv = exportToCSV(headers, rows);
  downloadCSV(`analytics-${d.classroom?.name || 'export'}.csv`, csv);
});

document.getElementById('btn-analytics-export-pdf')?.addEventListener('click', () => {
  printElement('tab-analytics', 'OpenClass Analytics Report');
});

// ═══════════════════════════ STUDENT REQUESTS ═══════════════════════════

requestsUnsub = null;
let requestsFilter = 'pending';

function matchesApprovalFilter(r, filter) {
  const status = r.status || 'pending';
  if (filter === 'pending') return status === 'pending';
  if (filter === 'rejected') return status === 'rejected';
  if (filter === 'approved') return status === 'approved';
  return true;
}

function parseReqTime(r) {
  if (!r) return null;
  const t = r.createdAt || r.requestedAt;
  if (!t) return null;
  if (typeof t.toDate === 'function') return t.toDate();
  if (typeof t.toMillis === 'function') return new Date(t.toMillis());
  if (typeof t === 'string' || typeof t === 'number') return new Date(t);
  return null;
}

function renderStudentRequests(requests) {
  const container = document.getElementById('approvals-list');
  if (!container) return;
  const filtered = requests
    .filter(r => matchesApprovalFilter(r, requestsFilter))
    .sort((a, b) => ((parseReqTime(b) || 0) - (parseReqTime(a) || 0)));
  if (filtered.length === 0) {
    const msg = requestsFilter === 'pending'
      ? 'No pending join requests found'
      : requestsFilter === 'all'
        ? 'No classroom join requests found'
        : `No ${requestsFilter} join requests found`;
    container.innerHTML = `<div class="empty-state-sm" style="text-align:center;padding:60px 0;color:var(--text-muted);">${msg}.</div>`;
    return;
  }
  container.innerHTML = '';
  filtered.forEach(r => {
    const dispStatus = r.status || 'pending';
    const card = document.createElement('div');
    card.className = 'approval-card';
    const reqTime = parseReqTime(r);
    const requestedDateStr = reqTime ? reqTime.toLocaleDateString() : '—';
    const statusClass = dispStatus === 'approved' ? 'bg-success-dim' : dispStatus === 'rejected' ? 'bg-archived-dim' : 'bg-warning-dim';
    const reqName = r.displayName || r.studentName || 'Unknown';
    const reqEmail = r.email || r.studentEmail || 'No email';
    const reqClass = r.className || r.classroomName || '';
    const reqClassId = r.classId || r.classroomId || '';
    const initials = (reqName || reqEmail || '?').charAt(0).toUpperCase();
    const requestPhoto = sanitizeProfilePhotoUrl(r.photoURL || '', r);
    const studentUid = String(r.studentUid || r.uid || '');
    const idLine = r.studentId && r.studentId !== studentUid ? r.studentId : '';
    card.innerHTML = `
      <div class="approval-card-left">
        <div class="approval-avatar">${requestPhoto ? `<img src="${requestPhoto}" />` : `<span>${initials}</span>`}</div>
        <div class="approval-info">
          <div class="approval-name">${reqName}</div>
          <div class="approval-meta">
            <span>${reqEmail}</span>
            ${reqClass ? `<span>Requesting to join: ${reqClass}</span>` : ''}
            ${r.classroomCode ? `<span>Code: ${r.classroomCode}</span>` : ''}
            ${idLine ? `<span>Student ID: ${idLine}</span>` : ''}
            ${r.department ? `<span>Department: ${r.department}</span>` : ''}
            <span>Requested: ${requestedDateStr}</span>
          </div>
        </div>
      </div>
      <div class="approval-card-right">
        <span class="badge-status ${statusClass}" style="text-transform:capitalize;">${dispStatus}</span>
        ${studentUid ? `<button class="icon-btn request-view-btn" data-student-id="${studentUid}" title="View Request"><i class="material-icons">visibility</i></button>` : ''}
        ${dispStatus === 'pending' ? `
          <button class="icon-btn request-approve-btn" data-student-id="${studentUid}" data-classroom-id="${reqClassId}" style="color:var(--success);" title="Approve"><i class="material-icons">check_circle</i></button>
          <button class="icon-btn request-reject-btn" data-student-id="${studentUid}" data-classroom-id="${reqClassId}" style="color:var(--danger);" title="Reject"><i class="material-icons">cancel</i></button>
        ` : ''}
      </div>`;
    container.appendChild(card);
  });

  // Event handlers
  container.querySelectorAll('.request-approve-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const studentId = btn.dataset.studentId;
      const classroomId = btn.dataset.classroomId;
      if (!studentId || !classroomId) return;
      if (!confirm('Approve this join request?')) return;
      try {
        await approveMember(classroomId, studentId, currentUserProfile);
        showAppToast('Join request approved successfully!');
      } catch (err) {
        console.error('Approval failed:', err);
        alert(err.message);
      }
    });
  });

  container.querySelectorAll('.request-reject-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const studentId = btn.dataset.studentId;
      const classroomId = btn.dataset.classroomId;
      if (!studentId || !classroomId) return;
      if (!confirm('Reject this join request?')) return;
      try {
        await rejectMember(classroomId, studentId, currentUserProfile);
        showAppToast('Join request rejected.');
      } catch (err) {
        console.error('Reject failed:', err);
        alert(err.message);
      }
    });
  });

  container.querySelectorAll('.request-view-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const studentId = btn.dataset.studentId;
      if (!studentId) return;
      const req = requests.find(r => String(r.studentUid || r.uid || '') === String(studentId));
      if (!req) return;
      try {
        const name = req.displayName || req.studentName || 'Unknown';
        const email = req.email || req.studentEmail || '—';
        const photo = sanitizeProfilePhotoUrl(req.photoURL || '', req);
        const reqClassId = req.classId || req.classroomId || '';
        const reqClass = req.className || req.classroomName || '—';
        const initials = name.charAt(0).toUpperCase();
        const statusClass = (req.status || 'pending') === 'approved' ? 'bg-success-dim' : (req.status || '') === 'rejected' ? 'bg-archived-dim' : 'bg-warning-dim';
        const requestedDate = parseReqTime(req);
        const requestedDateStr = requestedDate ? requestedDate.toLocaleString() : '—';
        const body = document.getElementById('student-profile-body');
        const footer = document.getElementById('student-profile-footer');
        body.innerHTML = `
            <div style="text-align:center;margin-bottom:24px;">
              ${photo ? `<img src="${photo}" style="width:80px;height:80px;border-radius:50%;object-fit:cover;" />` : `<div style="width:80px;height:80px;border-radius:50%;background:var(--primary);display:flex;align-items:center;justify-content:center;color:#fff;font-size:32px;font-weight:600;margin:0 auto;">${initials}</div>`}
              <h3 style="margin-top:12px;">${name}</h3>
              <span class="badge-status ${statusClass}" style="text-transform:capitalize;">${req.status || 'pending'}</span>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
              <div class="form-group"><label>Email</label><div style="color:var(--text-main);">${email}</div></div>
              <div class="form-group"><label>Role</label><div style="color:var(--text-main);">Student</div></div>
              <div class="form-group"><label>Student ID</label><div style="color:var(--text-main);">${req.studentId || '—'}</div></div>
              <div class="form-group"><label>Department</label><div style="color:var(--text-main);">${req.department || '—'}</div></div>
              <div class="form-group"><label>Classroom</label><div style="color:var(--text-main);">${reqClass}</div></div>
              <div class="form-group"><label>Requested</label><div style="color:var(--text-main);">${requestedDateStr}</div></div>
            </div>`;
        footer.innerHTML = (req.status || 'pending') === 'pending' ? `
            <button class="btn btn-success" id="profile-approve-btn" data-student-id="${studentId}" data-classroom-id="${reqClassId}"><i class="material-icons">check_circle</i> Approve</button>
            <button class="btn btn-outline" style="color:var(--danger);" id="profile-reject-btn" data-student-id="${studentId}" data-classroom-id="${reqClassId}"><i class="material-icons">cancel</i> Reject</button>
            <button type="button" class="btn btn-outline" data-close="modal-student-profile">Close</button>
          ` : `<button type="button" class="btn btn-outline" data-close="modal-student-profile">Close</button>`;
        document.getElementById('modal-student-profile').style.display = 'flex';
        document.getElementById('profile-approve-btn')?.addEventListener('click', async (e) => {
          try {
            await approveMember(reqClassId, studentId, currentUserProfile);
            document.getElementById('modal-student-profile').style.display = 'none';
            showAppToast('Join request approved successfully!');
          } catch (err) { console.error('Approval failed:', err); alert(err.message); }
        });
        document.getElementById('profile-reject-btn')?.addEventListener('click', async () => {
          if (!confirm('Reject this join request?')) return;
          try {
            await rejectMember(reqClassId, studentId, currentUserProfile);
            document.getElementById('modal-student-profile').style.display = 'none';
            showAppToast('Join request rejected.');
          } catch (err) { console.error('Reject failed:', err); alert(err.message); }
        });
      } catch (err) {
        console.error('Could not load join request details:', err);
        alert('Could not load join request details.');
      }
    });
  });
}

function getOwnedClassroomIds(teacherUid) {
  // Teachers only fetch/subscribe to classrooms they manage/teach, so every
  // classroom in userClassrooms is treated as an owned classroom by default.
  const ownedClassroomIds = new Set((userClassrooms || [])
    .map(c => c.classroomId || c.id || c._id)
    .filter(Boolean));
  console.log('[DEBUG] Teacher Owned Classroom IDs:', [...ownedClassroomIds]);
  return ownedClassroomIds;
}

function filterTeacherRequests(requests, teacherUid) {
  const ownedClassroomIds = getOwnedClassroomIds(teacherUid);
  const matched = requests.filter(r => {
    const classId = r.classId || r.classroomId;
    // Direct ownership fallback: the request explicitly names this teacher.
    const directMatch = r.teacherUid === teacherUid || r.ownerId === teacherUid;
    if (ownedClassroomIds.size > 0 && classId) {
      return ownedClassroomIds.has(classId) || directMatch;
    }
    // No owned classrooms known yet (userClassrooms not loaded) — fall back to
    // direct ownership fields plus a lenient match so nothing is hidden.
    return directMatch || !r.teacherUid;
  });
  console.log('[DEBUG] Total classroomRequests in snapshot:', requests.length, 'Matched for Teacher:', matched.length);
  return matched;
}

function loadStudentRequests() {
  if (requestsUnsub) requestsUnsub();
  const container = document.getElementById('approvals-list');
  if (container) {
    container.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:60px 0;color:var(--text-muted);">Loading join requests...</div>';
  }

  const teacherUid = currentUserProfile?.uid;
  if (!teacherUid) return;

  let hasLoadedOnce = false;
  let safetyTimer = null;
  // Safety net: if the Firestore query never responds (network issue, disabled
  // DB, missing index), never leave the tab stuck on "Loading...".
  safetyTimer = setTimeout(() => {
    if (!hasLoadedOnce) renderStudentRequests([]);
  }, 12000);

  const handleSnapshot = (requests) => {
    if (!hasLoadedOnce) {
      hasLoadedOnce = true;
      clearTimeout(safetyTimer);
    }
    // Re-render on EVERY snapshot so new requests appear immediately without
    // requiring a manual browser refresh.
    renderStudentRequests(filterTeacherRequests(requests, teacherUid));
    if (requests.length === 0) loadPendingFallback(teacherUid);
  };

  // Query by the selected status tab; no teacherUid where-clause is used, so
  // missing/mismatched teacherUid can never hide a request. Belonging is
  // resolved client-side via classId in filterTeacherRequests.
  const statusFilter = requestsFilter === 'all' ? null : requestsFilter;
  requestsUnsub = subscribeToClassroomRequests(handleSnapshot, statusFilter);
}

async function loadPendingFallback(teacherUid) {
  const ownedClassroomIds = getOwnedClassroomIds(teacherUid);
  if (ownedClassroomIds.size === 0) return;
  try {
    const snap = await getDocs(query(collection(getFirestore(), 'classroomRequests'), where('status', '==', 'pending')));
    const matching = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(r => ownedClassroomIds.has(r.classId || r.classroomId));
    if (matching.length > 0) renderStudentRequests(matching);
  } catch (err) {
    console.warn('Approvals fallback query failed:', err);
  }
}

document.getElementById('approvals-filter')?.addEventListener('change', (e) => {
  requestsFilter = e.target.value;
  loadStudentRequests();
});

// Global delegated handler so dynamically-rendered "data-close" buttons
// (e.g. the student-profile modal footer, "Got it" in the status modal) always
// dismiss their modal even when bound after page load.
document.addEventListener('click', (e) => {
  const closeBtn = e.target.closest('[data-close]');
  if (!closeBtn) return;
  const modalId = closeBtn.getAttribute('data-close');
  if (!modalId) return;
  const modal = document.getElementById(modalId);
  if (modal) modal.style.display = 'none';
});

// ═══ Student Access Restrictions ═══
// Account-level approval was removed. Students get immediate access; classroom
// content is gated per-course via join requests instead. These helpers are
// kept as no-ops so any remaining call sites never block the dashboard.

function showStudentStatusModal(profile) {
  const modal = document.getElementById('modal-student-status');
  if (modal) modal.style.display = 'none';
}

function checkAccess(tabName) {
  return !!currentUserProfile;
}

// Hook into the tab click system to check access
document.querySelectorAll('.nav-menu .nav-item[data-tab]').forEach(item => {
  item.addEventListener('click', function(e) {
    const tab = this.getAttribute('data-tab');
    if (tab === 'chat') {
      const user = currentUserProfile || getAuth().currentUser;
      if (user) {
        initMessengerTab(user);
      }
    }
    // Force-load / refresh classrooms when Classrooms tab is activated
    if (tab === 'classrooms') {
      const authUser = getAuth().currentUser;
      const uid = authUser?.uid || currentUserProfile?.uid || (JSON.parse(localStorage.getItem('openclass_user_profile') || '{}').uid);
      if (uid) {
        console.log('[Nav] Classrooms tab clicked, refreshing classrooms for uid:', uid);
        const role = currentUserProfile?.role || localStorage.getItem('openclass_user_role') || 'teacher';
        if (classroomsUnsubscribe) classroomsUnsubscribe();
        classroomsUnsubscribe = subscribeToUserClassrooms(uid, role, renderClassrooms);
      }
    }
    if (!checkAccess(tab)) {
      e.stopImmediatePropagation();
      this.classList.remove('active');
      const currentActive = document.querySelector('.nav-item.active');
      if (currentActive) currentActive.classList.add('active');
    }
  });
});

// ─── CHAT ENHANCEMENTS: Reactions, Search, File Share, Private Chat ──

function addChatSearchBar() {
  const chatArea = document.querySelector('.chat-main-header');
  if (!chatArea || document.getElementById('chat-search-input')) return;
  const searchDiv = document.createElement('div');
  searchDiv.id = 'chat-search-area';
  searchDiv.style.cssText = 'display:flex;gap:8px;align-items:center;padding:8px 16px;border-bottom:1px solid var(--border);';
  searchDiv.innerHTML = `
    <div class="search-container" style="flex:1;">
      <i class="material-icons">search</i>
      <input type="text" id="chat-search-input" placeholder="Search messages..." />
    </div>
    <button id="chat-search-close" class="icon-btn" style="display:none;"><i class="material-icons">close</i></button>`;
  const header = document.querySelector('.chat-main');
  if (header) header.insertBefore(searchDiv, header.querySelector('.chat-messages-container'));
  document.getElementById('chat-search-input')?.addEventListener('input', (e) => {
    const q = e.target.value.trim();
    const closeBtn = document.getElementById('chat-search-close');
    if (!closeBtn) return;
    if (!q || !currentChannelId) {
      const msgContainer = document.getElementById('messages');
      if (msgContainer && !q) {
        if (chatMessagesUnsub) chatMessagesUnsub();
        chatMessagesUnsub = subscribeToMessages(currentChannelId, (msgs) => {
          msgContainer.innerHTML = '';
          msgs.forEach(m => {
            const seenBy = m.seenBy ? Object.keys(m.seenBy) : [];
            displayMessage(m.id, m.timestamp, m.senderName, m.text, m.senderPic, m.imageUrl, seenBy);
          });
          msgContainer.scrollTop = msgContainer.scrollHeight;
        });
      }
      closeBtn.style.display = 'none';
      return;
    }
    closeBtn.style.display = '';
    searchMessages(currentChannelId, q, (results) => {
      const msgContainer = document.getElementById('messages');
      if (!msgContainer) return;
      msgContainer.innerHTML = '';
      results.forEach(m => {
        const seenBy = m.seenBy ? Object.keys(m.seenBy) : [];
        displayMessage(m.id, m.timestamp, m.senderName, m.text, m.senderPic, m.imageUrl, seenBy);
      });
      if (results.length === 0) {
        msgContainer.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);font-size:14px;">No messages found.</div>';
      }
    });
  });
  document.getElementById('chat-search-close')?.addEventListener('click', () => {
    document.getElementById('chat-search-input').value = '';
    document.getElementById('chat-search-input').dispatchEvent(new Event('input'));
  });
}

addChatSearchBar();

function addChatFileSharing() {
  const imageBtn = document.getElementById('submitImage');
  if (!imageBtn) return;
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.id = 'chat-file-input';
  fileInput.style.display = 'none';
  fileInput.accept = '.pdf,.doc,.docx,.ppt,.pptx,.txt,.zip,.rar,.jpg,.png,.gif,.mp4,.mp3';
  imageBtn.parentNode.insertBefore(fileInput, imageBtn.nextSibling);
  const fileBtn = document.createElement('button');
  fileBtn.type = 'button';
  fileBtn.className = 'icon-btn';
  fileBtn.title = 'Share file';
  fileBtn.innerHTML = '<i class="material-icons">attach_file</i>';
  fileBtn.addEventListener('click', () => fileInput.click());
  imageBtn.parentNode.insertBefore(fileBtn, imageBtn);
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file || !currentChannelId || !isUserSignedIn()) return;
    if (!currentUserProfile) return;
    try {
      await sendFileMessage(currentChannelId, file, currentUserProfile, '');
    } catch (err) { console.error('File upload error:', err); }
    fileInput.value = '';
  });
}

addChatFileSharing();

function addMessageReactions() {
  const msgContainer = document.getElementById('messages');
  if (!msgContainer) return;
  const observer = new MutationObserver(() => {
    document.querySelectorAll('.message-container:not(.has-reactions)').forEach(el => {
      el.classList.add('has-reactions');
      const msgId = el.id;
      if (!msgId || !currentChannelId) return;
      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'msg-reactions';
      actionsDiv.style.cssText = 'display:flex;gap:4px;margin-top:4px;flex-wrap:wrap;';
      const reactionEmojis = ['👍', '❤️', '😂', '😮', '🎉', '🔥'];
      reactionEmojis.forEach(emoji => {
        const btn = document.createElement('button');
        btn.className = 'reaction-btn';
        btn.textContent = emoji;
        btn.style.cssText = 'border:none;background:rgba(255,255,255,0.05);border-radius:4px;padding:2px 6px;cursor:pointer;font-size:14px;line-height:1;';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!isUserSignedIn() || !currentUserProfile) return;
          const uid = getAuth().currentUser.uid;
          addReaction(currentChannelId, msgId, uid, emoji);
        });
        actionsDiv.appendChild(btn);
      });
      const replyBtn = document.createElement('button');
      replyBtn.className = 'reaction-btn';
      replyBtn.innerHTML = '<i class="material-icons" style="font-size:14px;">reply</i>';
      replyBtn.title = 'Reply';
      replyBtn.style.cssText = 'border:none;background:rgba(255,255,255,0.05);border-radius:4px;padding:2px 6px;cursor:pointer;font-size:14px;line-height:1;';
      replyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const msgDiv = document.getElementById(msgId);
        if (!msgDiv) return;
        const name = msgDiv.querySelector('.name')?.textContent || 'Unknown';
        const text = msgDiv.querySelector('.message')?.textContent || '';
        document.getElementById('message').placeholder = `Reply to ${name}...`;
        document.getElementById('message').focus();
        document.getElementById('message').dataset.replyTo = msgId;
        document.getElementById('message').dataset.replyName = name;
        document.getElementById('message').dataset.replyText = text;
        const cancelBtn = document.getElementById('reply-cancel-btn') || (() => {
          const cb = document.createElement('button');
          cb.id = 'reply-cancel-btn';
          cb.type = 'button';
          cb.className = 'icon-btn';
          cb.title = 'Cancel reply';
          cb.innerHTML = '<i class="material-icons">close</i>';
          cb.style.cssText = 'font-size:12px;';
          cb.addEventListener('click', () => {
            delete document.getElementById('message').dataset.replyTo;
            document.getElementById('message').placeholder = `Message #${document.getElementById('chat-current-channel-name')?.textContent?.trim() || 'General'}`;
            cb.remove();
          });
          document.getElementById('submit')?.parentNode?.insertBefore(cb, document.getElementById('submit'));
          return cb;
        })();
      });
      actionsDiv.appendChild(replyBtn);
      const msgContent = el.querySelector('.msg-content-wrapper');
      if (msgContent) msgContent.appendChild(actionsDiv);
    });
  });
  observer.observe(msgContainer, { childList: true, subtree: true });
}

addMessageReactions();

document.addEventListener('DOMContentLoaded', () => {
  const origSubmit = document.getElementById('message-form')?.onsubmit;
  document.getElementById('message-form')?.addEventListener('submit', async (e) => {
    const msgInput = document.getElementById('message');
    if (!msgInput?.dataset?.replyTo) return;
    e.preventDefault();
    if (!msgInput.value || !currentChannelId || !currentUserProfile) return;
    const replyEl = document.getElementById(msgInput.dataset.replyTo);
    const replyTo = replyEl ? { id: msgInput.dataset.replyTo, text: msgInput.dataset.replyText || '', senderName: msgInput.dataset.replyName || 'Unknown' } : null;
    if (replyTo) {
      await sendMessageWithReply(currentChannelId, msgInput.value, currentUserProfile, replyTo);
    } else {
      await sendMessage(currentChannelId, msgInput.value, currentUserProfile);
    }
    msgInput.value = '';
    msgInput.placeholder = `Message #${document.getElementById('chat-current-channel-name')?.textContent?.trim() || 'General'}`;
    delete msgInput.dataset.replyTo;
    document.getElementById('reply-cancel-btn')?.remove();
    toggleButton();
  });
});

// Add private chat to member list
const origSubscribeToClassroomMembers = window.subscribeToClassroomMembers;
const origRenderMembers = window.renderMembers;

function enhanceMemberList(classroomId) {
  const container = document.getElementById('chat-members-list');
  if (!container) return;
  const currentUid = getAuth().currentUser?.uid;
  const privateBtns = container.querySelectorAll('.private-chat-btn');
  privateBtns.forEach(b => b.remove());
  container.querySelectorAll('.member-category, .member-item').forEach(el => {
    if (el.classList.contains('member-category') && el.textContent === 'MEMBERS') {
      const pcCategory = document.createElement('div');
      pcCategory.className = 'member-category';
      pcCategory.textContent = 'PRIVATE CHAT';
      container.insertBefore(pcCategory, el.nextSibling);
    }
    const uid = el.dataset?.memberUid;
    if (uid && uid !== currentUid && classroomId) {
      const chatBtn = document.createElement('button');
      chatBtn.className = 'private-chat-btn';
      chatBtn.style.cssText = 'background:none;border:none;color:var(--primary);cursor:pointer;font-size:12px;padding:2px 8px;';
      chatBtn.innerHTML = '<i class="material-icons" style="font-size:14px;">chat</i>';
      chatBtn.title = 'Private chat';
      chatBtn.addEventListener('click', async () => {
        const result = await createPrivateChat([currentUid, uid], classroomId);
        openPrivateChat(result.id, classroomId, uid);
      });
      el.querySelector('.member-info')?.appendChild(chatBtn);
    }
  });
}

function openPrivateChat(chatId, classroomId, otherUid) {
  privateChatId = chatId;
  const modal = document.getElementById('modal-private-chat');
  const msgsContainer = document.getElementById('private-chat-messages');
  const input = document.getElementById('private-chat-input');
  if (!modal || !msgsContainer) return;
  document.getElementById('private-chat-title').textContent = 'Private Chat';
  msgsContainer.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);">Loading...</div>';
  modal.style.display = 'flex';
  if (privateChatUnsub) privateChatUnsub();
  privateChatUnsub = subscribePrivateMessages(chatId, (msgs) => {
    msgsContainer.innerHTML = '';
    if (!msgs || msgs.length === 0) {
      msgsContainer.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);font-size:13px;">No messages yet. Say hello!</div>';
      return;
    }
    const currentUid = getAuth().currentUser?.uid;
    msgs.forEach(m => {
      const isMe = m.senderId === currentUid;
      const div = document.createElement('div');
      div.style.cssText = 'display:flex;flex-direction:column;align-items:' + (isMe ? 'flex-end' : 'flex-start') + ';margin-bottom:8px;';
      div.innerHTML = `
        <div style="background:${isMe ? 'var(--primary)' : 'rgba(255,255,255,0.05)'};color:${isMe ? '#fff' : 'var(--text-main)'};padding:8px 14px;border-radius:${isMe ? '16px 16px 4px 16px' : '16px 16px 16px 4px'};max-width:80%;">
          <div style="font-size:13px;">${m.senderName}: ${m.text}</div>
          <div style="font-size:10px;color:${isMe ? 'rgba(255,255,255,0.6)' : 'var(--text-muted)'};margin-top:2px;">${m.timestamp ? timeAgo(m.timestamp.toMillis()) : ''}</div>
        </div>`;
      msgsContainer.appendChild(div);
    });
    msgsContainer.scrollTop = msgsContainer.scrollHeight;
  });
  document.getElementById('private-chat-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!input?.value || !currentUserProfile) return;
    await sendPrivateMessage(chatId, currentUserProfile, input.value);
    input.value = '';
  });
}

// ─── STUDENT DASHBOARD ENHANCEMENTS & STUDY TOOLS ──────────────────────────

export function initStudentDashboardFeatures(userProfile, userClassrooms = []) {
  if (!userProfile) return;

  // 1. Gamification Bar
  const gamification = calculateGamification([], [], userProfile);
  const xpEl = document.getElementById('student-xp-display');
  if (xpEl) xpEl.textContent = `${gamification.xp} XP`;
  const streakEl = document.getElementById('student-streak-display');
  if (streakEl) streakEl.textContent = `${gamification.streak} Day Streak`;
  
  const badgesPreview = document.getElementById('student-badges-preview');
  if (badgesPreview) {
    badgesPreview.innerHTML = gamification.badgesList.map(b => `
      <div class="badge-pill ${b.unlocked ? '' : 'locked'}" title="${b.desc}">
        <i class="material-icons" style="font-size:14px; color:${b.color}">${b.icon}</i>
        <span>${b.title}</span>
      </div>
    `).join('');
  }

  // 2. Modern Course Progress Cards Grid
  const courseGrid = document.getElementById('student-course-progress-grid');
  if (courseGrid) {
    if (!userClassrooms || userClassrooms.length === 0) {
      courseGrid.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:30px 0;color:var(--text-muted);grid-column:1/-1;">No enrolled courses yet. Use "Join Class" to add a course!</div>';
    } else {
      const gradients = [
        'linear-gradient(135deg, #3B82F6, #1D4ED8)',
        'linear-gradient(135deg, #10B981, #047857)',
        'linear-gradient(135deg, #8B5CF6, #6D28D9)',
        'linear-gradient(135deg, #F59E0B, #D97706)'
      ];
      courseGrid.innerHTML = userClassrooms.map((c, idx) => {
        const grad = gradients[idx % gradients.length];
        const progress = Math.min(100, (idx + 1) * 30);
        return `
          <div class="course-progress-card">
            <div class="course-progress-banner" style="background:${grad}">
              <div>
                <h4>${c.classroomName}</h4>
                <p style="font-size:12px; opacity:0.9; margin:2px 0 0 0;">${c.courseCode || c.subject || c.section || 'General'}</p>
              </div>
              <span style="font-size:11px; background:rgba(255,255,255,0.2); padding:2px 8px; border-radius:10px; width:fit-content;">Instructor: ${c.teacherName || 'Teacher'}</span>
            </div>
            <div class="course-progress-body">
              <div class="progress-bar-container">
                <div style="display:flex; justify-content:space-between; font-size:12px; color:var(--text-muted);">
                  <span>Course Completion</span>
                  <span style="font-weight:700; color:var(--text-main);">${progress}%</span>
                </div>
                <div class="progress-bar-bg">
                  <div class="progress-bar-fill" style="width:${progress}%"></div>
                </div>
              </div>
              <button class="btn btn-outline btn-open-course-card" data-classroom-id="${c.classroomId}" style="width:100%; margin-top:16px; font-size:12px; padding:8px;">
                <i class="material-icons" style="font-size:15px; margin-right:4px;">arrow_forward</i> Continue Learning
              </button>
            </div>
          </div>
        `;
      }).join('');

      courseGrid.querySelectorAll('.btn-open-course-card').forEach(btn => {
        btn.addEventListener('click', () => {
          const cId = btn.dataset.classroomId;
          const targetClassroom = userClassrooms.find(cls => cls.classroomId === cId);
          if (targetClassroom) openClassroomDetail(targetClassroom);
        });
      });
    }
  }

  // 3. Today's Schedule Widget
  const scheduleList = document.getElementById('student-todays-schedule-list');
  if (scheduleList) {
    scheduleList.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:12px;">
        <div style="display:flex; align-items:center; gap:12px; padding:12px; background:var(--bg-color); border:1px solid var(--border); border-radius:10px;">
          <div style="width:40px; height:40px; border-radius:8px; background:rgba(59,130,246,0.1); color:var(--primary); display:flex; align-items:center; justify-content:center;">
            <i class="material-icons">videocam</i>
          </div>
          <div style="flex:1;">
            <div style="font-weight:600; font-size:13px;">Live Interactive Class</div>
            <div style="font-size:11px; color:var(--text-muted);">Computer Science &bull; Today, 2:00 PM</div>
          </div>
          <button class="btn btn-outline" style="font-size:11px; padding:4px 10px;" onclick="document.querySelector('.nav-item[data-tab=\'meetings\']')?.click()">Join</button>
        </div>
        <div style="display:flex; align-items:center; gap:12px; padding:12px; background:var(--bg-color); border:1px solid var(--border); border-radius:10px;">
          <div style="width:40px; height:40px; border-radius:8px; background:rgba(245,158,11,0.1); color:#F59E0B; display:flex; align-items:center; justify-content:center;">
            <i class="material-icons">assignment</i>
          </div>
          <div style="flex:1;">
            <div style="font-weight:600; font-size:13px;">Homework Window</div>
            <div style="font-size:11px; color:var(--text-muted);">Due Today before 11:59 PM</div>
          </div>
          <button class="btn btn-outline" style="font-size:11px; padding:4px 10px;" onclick="document.querySelector('.nav-item[data-tab=\'kanban-tracker\']')?.click()">Track</button>
        </div>
      </div>
    `;
  }

  // 4. Upcoming Deadlines Widget
  const deadlinesList = document.getElementById('student-upcoming-deadlines-list');
  if (deadlinesList) {
    deadlinesList.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:12px;">
        <div style="display:flex; align-items:center; justify-content:space-between; padding:12px; background:var(--bg-color); border:1px solid var(--border); border-radius:10px;">
          <div>
            <div style="font-weight:600; font-size:13px;">Problem Set 1: Data Structures</div>
            <div style="font-size:11px; color:var(--text-muted);">Computer Science &bull; Due in 2 days</div>
          </div>
          <span style="font-size:11px; padding:3px 8px; border-radius:12px; background:rgba(239,68,68,0.1); color:#EF4444; font-weight:600;">Pending</span>
        </div>
        <div style="display:flex; align-items:center; justify-content:space-between; padding:12px; background:var(--bg-color); border:1px solid var(--border); border-radius:10px;">
          <div>
            <div style="font-weight:600; font-size:13px;">Midterm Chapter Quiz</div>
            <div style="font-size:11px; color:var(--text-muted);">General Science &bull; Due in 4 days</div>
          </div>
          <span style="font-size:11px; padding:3px 8px; border-radius:12px; background:rgba(245,158,11,0.1); color:#F59E0B; font-weight:600;">Upcoming</span>
        </div>
      </div>
    `;
  }

  // 5. Performance SVG Visual Chart
  const svgEl = document.getElementById('student-performance-svg');
  if (svgEl) {
    svgEl.innerHTML = `
      <defs>
        <linearGradient id="gradPath" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#3B82F6" />
          <stop offset="100%" stop-color="#10B981" />
        </linearGradient>
      </defs>
      <line x1="40" y1="180" x2="560" y2="180" stroke="var(--border)" stroke-width="1" />
      <line x1="40" y1="120" x2="560" y2="120" stroke="var(--border)" stroke-width="1" stroke-dasharray="4" />
      <line x1="40" y1="60" x2="560" y2="60" stroke="var(--border)" stroke-width="1" stroke-dasharray="4" />
      <path d="M 60 140 Q 180 60, 300 110 T 540 50" fill="none" stroke="url(#gradPath)" stroke-width="4" stroke-linecap="round" />
      <circle cx="60" cy="140" r="5" fill="#3B82F6" />
      <circle cx="300" cy="110" r="5" fill="#3B82F6" />
      <circle cx="540" cy="50" r="6" fill="#10B981" />
      <text x="60" y="202" fill="var(--text-muted)" font-size="11" text-anchor="middle">Week 1</text>
      <text x="300" y="202" fill="var(--text-muted)" font-size="11" text-anchor="middle">Week 2</text>
      <text x="540" y="202" fill="var(--text-muted)" font-size="11" text-anchor="middle">Week 3 (Current)</text>
      <text x="540" y="36" fill="#10B981" font-size="12" font-weight="bold" text-anchor="middle">92% Grade Avg</text>
    `;
  }
}

// ─── KANBAN HOMEWORK TRACKER ───────────────────────────────────────────────

let currentHomeworkItems = [
  { id: 'hw-1', title: 'Data Structures Problem Set 1', course: 'Computer Science 101', status: 'todo', dueDate: 'Tomorrow' },
  { id: 'hw-2', title: 'Physics Newton Laws Essay', course: 'General Physics', status: 'in_progress', dueDate: 'In 3 days' },
  { id: 'hw-3', title: 'Calculus Quiz 2 Revision', course: 'Mathematics II', status: 'submitted', dueDate: 'Submitted' },
  { id: 'hw-4', title: 'Database ER Diagram Project', course: 'Database Systems', status: 'graded', score: '95/100', dueDate: 'Graded' }
];

export function renderKanbanBoard() {
  const statuses = ['todo', 'in_progress', 'submitted', 'graded'];
  statuses.forEach(status => {
    const listEl = document.getElementById(`kanban-col-${status}`);
    const countEl = document.getElementById(`count-${status}`);
    if (!listEl) return;

    const items = currentHomeworkItems.filter(item => item.status === status);
    if (countEl) countEl.textContent = items.length;

    if (items.length === 0) {
      listEl.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-muted); font-size:12px;">No items</div>';
    } else {
      listEl.innerHTML = items.map(item => `
        <div class="kanban-card" data-hw-id="${item.id}">
          <div class="kanban-card-title">${item.title}</div>
          <div class="kanban-card-course">${item.course}</div>
          <div class="kanban-card-footer">
            <span style="color:var(--text-muted);">${item.dueDate}</span>
            <select class="kanban-status-select" data-hw-id="${item.id}" style="font-size:11px; padding:2px 4px; border-radius:4px; background:var(--card-bg); border:1px solid var(--border); color:var(--text-main);">
              <option value="todo" ${item.status === 'todo' ? 'selected' : ''}>To-Do</option>
              <option value="in_progress" ${item.status === 'in_progress' ? 'selected' : ''}>In Progress</option>
              <option value="submitted" ${item.status === 'submitted' ? 'selected' : ''}>Submitted</option>
              <option value="graded" ${item.status === 'graded' ? 'selected' : ''}>Graded</option>
            </select>
          </div>
        </div>
      `).join('');

      listEl.querySelectorAll('.kanban-status-select').forEach(select => {
        select.addEventListener('change', (e) => {
          const hwId = select.dataset.hwId;
          const newStatus = e.target.value;
          const targetItem = currentHomeworkItems.find(i => i.id === hwId);
          if (targetItem) {
            targetItem.status = newStatus;
            renderKanbanBoard();
          }
        });
      });
    }
  });
}

// ─── RESOURCE VAULT ───────────────────────────────────────────────────────

const sampleResources = [
  { id: 'res-1', title: 'Data Structures & Algorithms Cheat Sheet', topic: 'Computer Science', fileType: 'PDF', size: '2.4 MB' },
  { id: 'res-2', title: 'Physics Fundamentals Formulas Notes', topic: 'Science', fileType: 'PDF', size: '1.8 MB' },
  { id: 'res-3', title: 'Linear Algebra & Calculus Overview', topic: 'Mathematics', fileType: 'DOCX', size: '3.1 MB' },
  { id: 'res-4', title: 'General Academic Study Strategies Guide', topic: 'General', fileType: 'PDF', size: '1.2 MB' }
];

export function renderResourceVault(activeTopic = 'all', searchQuery = '') {
  const gridEl = document.getElementById('resource-vault-grid');
  if (!gridEl) return;

  const bookmarkedIds = getBookmarkedResourceIds();

  let filtered = sampleResources.filter(res => {
    const isBkm = bookmarkedIds.includes(res.id);
    if (activeTopic === 'bookmarked' && !isBkm) return false;
    if (activeTopic !== 'all' && activeTopic !== 'bookmarked' && res.topic !== activeTopic) return false;
    if (searchQuery && !res.title.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  if (filtered.length === 0) {
    gridEl.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:40px 0;color:var(--text-muted);grid-column:1/-1;">No matching resources found.</div>';
    return;
  }

  gridEl.innerHTML = filtered.map(res => {
    const isBookmarked = bookmarkedIds.includes(res.id);
    return `
      <div class="note-card" style="position:relative;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px;">
          <span style="font-size:11px; padding:3px 8px; border-radius:10px; background:rgba(59,130,246,0.1); color:var(--primary); font-weight:600;">${res.topic}</span>
          <button class="bookmark-star-btn ${isBookmarked ? 'bookmarked' : ''}" data-res-id="${res.id}" title="Toggle Bookmark">
            ${isBookmarked ? '★' : '☆'}
          </button>
        </div>
        <h4 style="font-size:14px; margin:0 0 8px 0; color:var(--text-main);">${res.title}</h4>
        <div style="display:flex; justify-content:space-between; font-size:12px; color:var(--text-muted); margin-top:12px;">
          <span>📄 ${res.fileType}</span>
          <span>${res.size}</span>
        </div>
      </div>
    `;
  }).join('');

  gridEl.querySelectorAll('.bookmark-star-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const resId = btn.dataset.resId;
      toggleBookmarkResource(resId);
      renderResourceVault(activeTopic, searchQuery);
    });
  });
}

// ─── AI STUDY ASSISTANT ───────────────────────────────────────────────────

export function initAIAssistant() {
  const btnSummary = document.getElementById('btn-generate-summary');
  const summaryInput = document.getElementById('ai-summary-input');
  const summaryOutput = document.getElementById('ai-summary-output');
  const summaryText = document.getElementById('ai-summary-text');
  const takeawaysList = document.getElementById('ai-takeaways-list');

  if (btnSummary && summaryInput) {
    btnSummary.onclick = () => {
      const val = summaryInput.value;
      if (!val || !val.trim()) {
        alert('Please enter notes or study text first.');
        return;
      }
      const result = summarizeTextAI(val);
      if (result) {
        if (summaryOutput) summaryOutput.style.display = 'block';
        if (summaryText) summaryText.textContent = result.summary;
        if (takeawaysList) {
          takeawaysList.innerHTML = result.keyTakeaways.map(t => `<li>${t}</li>`).join('');
        }
      }
    };
  }

  const btnQuiz = document.getElementById('btn-generate-ai-quiz');
  const quizTopicInput = document.getElementById('ai-quiz-topic-input');
  const quizOutput = document.getElementById('ai-quiz-output');
  const questionsList = document.getElementById('ai-quiz-questions-list');

  if (btnQuiz && quizTopicInput) {
    btnQuiz.onclick = () => {
      const topic = quizTopicInput.value;
      const questions = generateQuizAI(topic);
      if (quizOutput) quizOutput.style.display = 'block';
      if (questionsList) {
        questionsList.innerHTML = questions.map(q => `
          <div class="ai-quiz-card">
            <div style="font-weight:600; font-size:14px; margin-bottom:12px; color:var(--text-main);">Q${q.id}. ${q.question}</div>
            <div style="display:flex; flex-direction:column; gap:8px;">
              ${q.options.map((opt, oIdx) => `
                <button class="ai-opt-btn" data-q-id="${q.id}" data-opt-idx="${oIdx}" data-correct-idx="${q.correctAnswer}">${opt}</button>
              `).join('')}
            </div>
          </div>
        `).join('');

        questionsList.querySelectorAll('.ai-opt-btn').forEach(btn => {
          btn.onclick = () => {
            const optIdx = parseInt(btn.dataset.optIdx, 10);
            const correctIdx = parseInt(btn.dataset.correctIdx, 10);
            const parent = btn.parentElement;
            parent.querySelectorAll('.ai-opt-btn').forEach(b => {
              b.disabled = true;
              const idx = parseInt(b.dataset.optIdx, 10);
              if (idx === correctIdx) b.classList.add('correct');
              else if (idx === optIdx) b.classList.add('wrong');
            });
          };
        });
      }
    };
  }

  const topicContainer = document.getElementById('resource-topic-filters');
  const searchInput = document.getElementById('resource-search-input');

  if (topicContainer) {
    topicContainer.querySelectorAll('.resource-pill').forEach(btn => {
      btn.onclick = () => {
        topicContainer.querySelectorAll('.resource-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const topic = btn.dataset.topic;
        renderResourceVault(topic, searchInput?.value || '');
      };
    });
  }

  if (searchInput) {
    searchInput.oninput = (e) => {
      const activeBtn = topicContainer?.querySelector('.resource-pill.active');
      const topic = activeBtn ? activeBtn.dataset.topic : 'all';
      renderResourceVault(topic, e.target.value);
    };
  }

  renderKanbanBoard();
  renderResourceVault();
}

document.addEventListener('DOMContentLoaded', () => {
  initAIAssistant();
});

// ─── LIVE MEETINGS DASHBOARD & JITSI VIDEO CALL SDK ──────────────────────

teacherMeetingsUnsub = null;
let activeMeetingDataList = [];

export function initLiveMeetingsModule(userProfile, userClassroomsPassed = []) {
  if (!userProfile) return;

  const isUserTeacher = isTeacher(userProfile);

  // 1. Setup "New Meeting" Modal Trigger Buttons
  const btnGlobalNewMeeting = document.getElementById('btn-create-meeting-global');
  const btnEmptyInstant = document.getElementById('btn-empty-instant-meeting');
  const btnEmptySchedule = document.getElementById('btn-empty-schedule-meeting');
  const modalCreateMeeting = document.getElementById('modal-create-meeting');
  const classroomSelect = document.getElementById('meeting-form-classroom');
  const typeRadios = document.getElementsByName('meeting-type-radio');
  const scheduledTimeGroup = document.getElementById('meeting-scheduled-time-group');
  const formCreateMeeting = document.getElementById('form-create-meeting');
  const alertEl = document.getElementById('create-meeting-alert');

  // Populate Classroom selection dropdown
  if (classroomSelect) {
    classroomSelect.innerHTML = '<option value="">Choose classroom...</option>' + 
      userClassrooms.map(c => `<option value="${c.classroomId}">${c.classroomName} (${c.courseCode || c.section || c.subject || 'General'})</option>`).join('');
  }

  // Meeting type radio toggle
  if (typeRadios) {
    typeRadios.forEach(radio => {
      radio.onchange = () => {
        if (scheduledTimeGroup) {
          scheduledTimeGroup.style.display = (radio.value === 'scheduled') ? 'block' : 'none';
        }
      };
    });
  }

  const openCreateModal = (defaultType = 'instant') => {
    const targetModal = document.getElementById('modal-create-meeting');
    if (!targetModal) return;

    const selectEl = document.getElementById('meeting-form-classroom');
    const alertBox = document.getElementById('create-meeting-alert');
    const formEl = document.getElementById('form-create-meeting');

    if (alertBox) alertBox.style.display = 'none';
    if (formEl) formEl.reset();

    const currentRooms = (userClassrooms && userClassrooms.length > 0) ? userClassrooms : userClassroomsPassed;
    if (selectEl) {
      selectEl.innerHTML = '<option value="">Choose classroom...</option>' + 
        currentRooms.map(c => `<option value="${c.classroomId}">${c.classroomName} (${c.courseCode || c.section || c.subject || 'General'})</option>`).join('');
      
      if (typeof detailCurrentClassroomId !== 'undefined' && detailCurrentClassroomId) {
        selectEl.value = detailCurrentClassroomId;
      } else if (currentRooms.length > 0) {
        selectEl.value = currentRooms[0].classroomId;
      }
    }

    if (typeRadios) {
      typeRadios.forEach(r => {
        if (r.value === defaultType) r.checked = true;
      });
      if (scheduledTimeGroup) {
        scheduledTimeGroup.style.display = (defaultType === 'scheduled') ? 'block' : 'none';
      }
    }

    targetModal.style.display = 'flex';
  };

  if (btnGlobalNewMeeting) btnGlobalNewMeeting.onclick = () => openCreateModal('instant');
  if (btnEmptyInstant) btnEmptyInstant.onclick = () => openCreateModal('instant');
  if (btnEmptySchedule) btnEmptySchedule.onclick = () => openCreateModal('scheduled');

  // Form submit handler
  if (formCreateMeeting) {
    formCreateMeeting.onsubmit = async (e) => {
      e.preventDefault();
      const title = document.getElementById('meeting-form-title')?.value.trim();
      const classroomId = classroomSelect?.value;
      const selectedType = Array.from(typeRadios).find(r => r.checked)?.value || 'instant';
      const scheduledTimeVal = document.getElementById('meeting-form-scheduled-time')?.value;
      const autoRecord = document.getElementById('meeting-toggle-recording')?.checked;
      const notifyStudents = document.getElementById('meeting-toggle-notify')?.checked;

      if (!title || !classroomId) {
        if (alertEl) {
          alertEl.className = 'alert alert-danger';
          alertEl.textContent = 'Please enter a title and select a classroom.';
          alertEl.style.display = 'block';
        }
        return;
      }

      if (selectedType === 'scheduled' && !scheduledTimeVal) {
        if (alertEl) {
          alertEl.className = 'alert alert-danger';
          alertEl.textContent = 'Please select a scheduled date and time.';
          alertEl.style.display = 'block';
        }
        return;
      }

      const targetClassroom = userClassrooms.find(c => c.classroomId === classroomId);

      try {
        const newMeeting = await createMeeting({
          title,
          classroomId,
          classroomName: targetClassroom ? targetClassroom.classroomName : 'General Class',
          createdBy: userProfile.uid,
          teacherName: userProfile.displayName || 'Teacher',
          meetingType: selectedType,
          scheduledTime: selectedType === 'scheduled' ? scheduledTimeVal : null,
          autoRecord,
          notifyStudents
        });

        modalCreateMeeting.style.display = 'none';

        if (selectedType === 'instant') {
          openInAppMeeting(newMeeting, userProfile);
        } else {
          alert(`Meeting '${title}' scheduled successfully!`);
        }
      } catch (err) {
        if (alertEl) {
          alertEl.className = 'alert alert-danger';
          alertEl.textContent = err.message || 'Failed to create meeting.';
          alertEl.style.display = 'block';
        }
      }
    };
  }

  // 2. Real-time Meeting Listener Subscription
  if (teacherMeetingsUnsub) teacherMeetingsUnsub();
  
  if (isUserTeacher) {
    teacherMeetingsUnsub = subscribeTeacherMeetings(userProfile.uid, (meetings) => {
      renderMeetingsDashboard(meetings, userProfile, userClassrooms);
    });
  } else {
    const cIds = userClassrooms.map(c => c.classroomId);
    if (cIds.length > 0) {
      teacherMeetingsUnsub = subscribeClassroomMeetings(cIds[0], (meetings) => {
        renderMeetingsDashboard(meetings, userProfile, userClassrooms);
      });
    }
  }
}

/**
 * Renders the 3 main dashboard sections or the Empty State UI
 */
export function renderMeetingsDashboard(meetings = [], userProfile = {}, userClassrooms = []) {
  const emptyStateEl = document.getElementById('meetings-empty-state');
  const ongoingWrapper = document.getElementById('meetings-ongoing-wrapper');
  const ongoingCard = document.getElementById('meetings-ongoing-card');
  const upcomingGrid = document.getElementById('meetings-upcoming-grid');
  const historyList = document.getElementById('meetings-history-list');

  activeMeetingDataList = meetings;

  if (!meetings || meetings.length === 0) {
    if (emptyStateEl) emptyStateEl.style.display = 'block';
    if (ongoingWrapper) ongoingWrapper.style.display = 'none';
    if (upcomingGrid) upcomingGrid.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:30px 0;color:var(--text-muted);grid-column:1/-1;">No upcoming classes scheduled.</div>';
    if (historyList) historyList.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:30px 0;color:var(--text-muted);">No past classes found.</div>';
    return;
  }

  if (emptyStateEl) emptyStateEl.style.display = 'none';

  const isUserTeacher = isTeacher(userProfile);
  const ongoing = meetings.find(m => m.status === 'ongoing');
  const upcoming = meetings.filter(m => m.status === 'scheduled');
  const past = meetings.filter(m => m.status === 'ended');

  // Section A: Ongoing Meeting Card
  if (ongoing && ongoingWrapper && ongoingCard) {
    ongoingWrapper.style.display = 'block';
    const participantCount = ongoing.participantCount || (ongoing.participants ? ongoing.participants.length : 1);
    ongoingCard.innerHTML = `
      <div>
        <div style="font-size:18px; font-weight:700; color:var(--text-main); margin-bottom:4px;">${ongoing.title}</div>
        <div style="font-size:13px; color:var(--text-muted);">${ongoing.classroomName} &bull; Instructor: ${ongoing.teacherName}</div>
        <div style="margin-top:10px; font-size:12px; color:var(--success); font-weight:600; display:flex; align-items:center; gap:6px;">
          <i class="material-icons" style="font-size:16px;">people</i> ${participantCount} Active Participants Joined
        </div>
      </div>
      <div style="display:flex; gap:10px;">
        <button class="btn btn-primary btn-rejoin-meeting" data-meeting-id="${ongoing.id}" style="padding:8px 18px;">
          <i class="material-icons" style="font-size:16px; margin-right:4px;">videocam</i> Re-join Class
        </button>
        ${isUserTeacher ? `
          <button class="btn btn-outline btn-end-meeting" data-meeting-id="${ongoing.id}" style="color:#EF4444; border-color:#EF4444; padding:8px 16px;">
            <i class="material-icons" style="font-size:16px; margin-right:4px;">call_end</i> End Meeting
          </button>
        ` : ''}
      </div>
    `;

    ongoingCard.querySelector('.btn-rejoin-meeting')?.addEventListener('click', () => {
      openInAppMeeting(ongoing, userProfile);
    });

    ongoingCard.querySelector('.btn-end-meeting')?.addEventListener('click', async () => {
      if (!confirm('Are you sure you want to end this live meeting for all students?')) return;
      await updateMeetingStatus(ongoing.id, 'ended');
    });
  } else if (ongoingWrapper) {
    ongoingWrapper.style.display = 'none';
  }

  // Section B: Upcoming Meetings List
  if (upcomingGrid) {
    if (upcoming.length === 0) {
      upcomingGrid.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:30px 0;color:var(--text-muted);grid-column:1/-1;">No upcoming classes scheduled.</div>';
    } else {
      upcomingGrid.innerHTML = upcoming.map(m => {
        const timeStr = m.scheduledTime
          ? new Date(m.scheduledTime.toMillis ? m.scheduledTime.toMillis() : m.scheduledTime).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
          : 'Scheduled';

        let countdownText = 'Starts soon';
        if (m.scheduledTime) {
          const diffMs = (m.scheduledTime.toMillis ? m.scheduledTime.toMillis() : new Date(m.scheduledTime).getTime()) - Date.now();
          if (diffMs > 0) {
            const diffMins = Math.round(diffMs / 60000);
            if (diffMins < 60) countdownText = `Starts in ${diffMins} mins`;
            else countdownText = `Starts in ${Math.round(diffMins / 60)} hours`;
          } else {
            countdownText = 'Ready to start';
          }
        }

        return `
          <div class="upcoming-meeting-card">
            <div>
              <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px;">
                <span class="countdown-badge">🕒 ${countdownText}</span>
                <span style="font-size:11px; color:var(--text-muted);">${m.classroomName}</span>
              </div>
              <h4 style="font-size:15px; font-weight:700; margin:0 0 6px 0; color:var(--text-main);">${m.title}</h4>
              <div style="font-size:12px; color:var(--text-muted);"><i class="material-icons" style="font-size:14px; vertical-align:middle;">event</i> ${timeStr}</div>
            </div>
            <div style="display:flex; gap:8px; margin-top:16px;">
              <button class="btn btn-primary btn-start-scheduled-meeting" data-meeting-id="${m.id}" style="flex:1; font-size:12px; padding:6px 12px;">
                <i class="material-icons" style="font-size:14px; margin-right:4px;">play_arrow</i> Start Class
              </button>
              <button class="btn btn-outline btn-copy-meeting-link" data-link="${m.meetingLink}" style="font-size:12px; padding:6px 10px;" title="Copy Meeting Link">
                <i class="material-icons" style="font-size:14px;">content_copy</i>
              </button>
            </div>
          </div>
        `;
      }).join('');

      upcomingGrid.querySelectorAll('.btn-start-scheduled-meeting').forEach(btn => {
        btn.onclick = async () => {
          const mId = btn.dataset.meetingId;
          const targetMeeting = upcoming.find(item => item.id === mId);
          if (targetMeeting) {
            await updateMeetingStatus(mId, 'ongoing');
            openInAppMeeting(targetMeeting, userProfile);
          }
        };
      });

      upcomingGrid.querySelectorAll('.btn-copy-meeting-link').forEach(btn => {
        btn.onclick = () => {
          const link = btn.dataset.link;
          if (link) {
            navigator.clipboard.writeText(link);
            alert('Meeting link copied to clipboard!');
          }
        };
      });
    }
  }

  // Section C: Past Class History & Recordings
  if (historyList) {
    if (past.length === 0) {
      historyList.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:30px 0;color:var(--text-muted);">No past classes recorded yet.</div>';
    } else {
      historyList.innerHTML = past.map(m => {
        const dateStr = m.createdAt
          ? new Date(m.createdAt.toMillis ? m.createdAt.toMillis() : m.createdAt).toLocaleDateString()
          : 'Past';
        const attendeesCount = (m.participants ? m.participants.length : 0);
        return `
          <div class="history-meeting-row">
            <div>
              <div style="font-weight:600; font-size:14px; color:var(--text-main);">${m.title}</div>
              <div style="font-size:12px; color:var(--text-muted);">${m.classroomName} &bull; Date: ${dateStr} &bull; ${attendeesCount} Attendees</div>
            </div>
            <div style="display:flex; gap:8px;">
              <button class="btn btn-outline btn-download-attendance" data-meeting-id="${m.id}" style="font-size:12px; padding:6px 12px;">
                <i class="material-icons" style="font-size:14px; margin-right:4px;">download</i> Attendance Report (CSV)
              </button>
              <button class="btn btn-outline btn-watch-recording" data-link="${m.meetingLink}" style="font-size:12px; padding:6px 12px;">
                <i class="material-icons" style="font-size:14px; margin-right:4px;">content_copy</i> Copy Invite
              </button>
            </div>
          </div>
        `;
      }).join('');

      historyList.querySelectorAll('.btn-download-attendance').forEach(btn => {
        btn.onclick = () => {
          const mId = btn.dataset.meetingId;
          const targetMeeting = past.find(item => item.id === mId);
          if (targetMeeting) {
            exportAttendanceCSV(targetMeeting);
          }
        };
      });

      historyList.querySelectorAll('.btn-watch-recording').forEach(btn => {
        btn.onclick = () => {
          const link = btn.dataset.link;
          if (link) {
            navigator.clipboard.writeText(link);
            showAppToast('Meeting invite link copied to clipboard.', 'info');
          }
        };
      });
    }
  }
}

/**
 * Opens the embedded WebRTC meeting UI inside the current page (no new
 * tabs / external URLs). Renders the React meeting component into a
 * fullscreen overlay within the SPA.
 */
export async function openInAppMeeting(meeting, userProfile) {
  if (!meeting) return;
  if (isMeetingOpen()) {
    showAppToast('A meeting is already open in this window.', 'info');
    return;
  }

  // When the classroom detail workspace is open, embed the meeting inside
  // it (over the Meetings dashboard) instead of the fullscreen overlay.
  const detailModal = document.getElementById('modal-classroom-detail');
  const inClassroomDetail = detailModal && detailModal.style.display !== 'none' && detailCurrentClassroomId;
  if (inClassroomDetail && document.getElementById('classroom-meeting-host')) {
    return openClassroomMeetingInline(meeting, detailCurrentClassroomId, userProfile);
  }

  const roomName = meeting.roomName || `OpenClass-${meeting.id || Date.now().toString(36)}`;
  const displayName = (userProfile && (userProfile.displayName || userProfile.email)) || 'Guest';
  const inviteLink = meeting.meetingLink && !meeting.meetingLink.includes('meet.jit.si')
    ? meeting.meetingLink
    : buildLocalMeetingLink(roomName);

  mountMeetingUi({
    roomName,
    userName: displayName,
    title: meeting.title || 'OpenClass Live Meeting',
    inviteLink,
  });

  if (meeting.id && userProfile) {
    try {
      await recordMeetingJoin(meeting.id, userProfile);
    } catch (e) {
      console.warn('Could not record meeting join:', e);
    }
  }
}


