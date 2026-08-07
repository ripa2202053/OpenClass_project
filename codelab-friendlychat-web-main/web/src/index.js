/**
 * Copyright 2015 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
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
   orderBy,
   limit,
   onSnapshot,
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
 import { createUser, getUser, updateUser, updateProfile, createUserWithRole, getAllStudents, approveStudent, rejectStudent } from './userService.js';
 import { createClassroom, joinClassroomByCode, subscribeToUserClassrooms, updateClassroom, deleteClassroom, leaveClassroom, getClassroom } from './classroomService.js';
 import { subscribeDashboardData, unsubscribeAll, addActivity, addNotice } from './dashboardService.js';
 import {
   subscribeToChannels, createChannel, sendMessage, sendImageMessage,
   subscribeToMessages, setTyping, subscribeToTyping, markChannelAsRead,
   subscribeToUnreadCounts
 } from './chatService.js';

 // Global Application State
 let currentUserProfile = null;
 let selectedProfileImageFile = null;
 let classroomsUnsubscribe = null;
 let dashboardUnsubscribe = null;
 let chatChannelsUnsubscribe = null;
 let chatMessagesUnsubscribe = null;
 let chatTypingUnsubscribe = null;
 let currentChannelId = null;
 let typingTimeout = null;

 // Signs-in Friendly Chat.
async function signIn() {
  try {
    var provider = new GoogleAuthProvider();
    await signInWithPopup(getAuth(), provider);
  } catch (error) {
    console.error('Sign-in failed:', error);
  }
}
 
 // Signs-out of Friendly Chat.
function signOutUser() {
  try {
    signOut(getAuth());
  } catch (error) {
    console.error('Sign-out failed:', error);
  }
}
 
 // Initialize firebase auth
 function initFirebaseAuth() {
   onAuthStateChanged(getAuth(), authStateObserver);
 }
 
 // Returns the signed-in user's profile Pic URL.
 function getProfilePicUrl() {
   return (currentUserProfile && currentUserProfile.photoURL) || getAuth().currentUser?.photoURL || '/images/profile_placeholder.png';
 }
 
 // Returns the signed-in user's display name.
 function getUserName() {
   return (currentUserProfile && currentUserProfile.displayName) || getAuth().currentUser?.displayName || 'OpenClass User';
 }
 
 // Returns true if a user is signed-in.
 function isUserSignedIn() {
   return !!getAuth().currentUser;
 }
 
 // Saves a new message to the current channel.
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
 
 // Saves a new message containing an image in Firebase.
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
 
 // Saves the messaging device token to Cloud Firestore.
 async function saveMessagingDeviceToken() {
   try {
     const currentToken = await getToken(getMessaging());
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
     console.error('Unable to get messaging token.', error);
   };
 }
 
 // Requests permissions to show notifications.
 async function requestNotificationsPermissions() {
   console.log('Requesting notifications permission...');
   const permission = await Notification.requestPermission();
   
   if (permission === 'granted') {
     console.log('Notification permission granted.');
     await saveMessagingDeviceToken();
   } else {
     console.log('Unable to get permission to notify.');
   }
 }
 
 // Triggered when a file is selected via the media picker.
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
 
 // Triggered when the send new message form is submitted.
 function onMessageFormSubmit(e) {
   e.preventDefault();
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
 
 // Populates the Profile Page UI elements with Firestore user data
 function populateProfileForm(profile) {
   if (!profile) return;
   
   const nameInput = document.getElementById('profile-input-name');
   const emailInput = document.getElementById('profile-input-email');
   const roleInput = document.getElementById('profile-input-role');
   const deptInput = document.getElementById('profile-input-department');
   const stuIdInput = document.getElementById('profile-input-student-id');
   const tchIdInput = document.getElementById('profile-input-teacher-id');
   const semInput = document.getElementById('profile-input-semester');
   const phoneInput = document.getElementById('profile-input-phone');

   const headerName = document.getElementById('profile-header-name');
   const headerEmail = document.getElementById('profile-header-email');
   const headerRole = document.getElementById('profile-header-role');
   const topbarRoleBadge = document.getElementById('topbar-role-badge');
   const avatarImg = document.getElementById('profile-avatar');

   if (nameInput) nameInput.value = profile.displayName || '';
   if (emailInput) emailInput.value = profile.email || '';
   if (roleInput) roleInput.value = profile.role || 'Student';
   if (deptInput) deptInput.value = profile.department || '';
   if (stuIdInput) stuIdInput.value = profile.studentId || '';
   if (tchIdInput) tchIdInput.value = profile.teacherId || '';
   if (semInput) semInput.value = profile.semester || '';
   if (phoneInput) phoneInput.value = profile.phone || '';

   if (headerName) headerName.textContent = profile.displayName || 'OpenClass User';
   if (headerEmail) headerEmail.textContent = profile.email || '';
   if (headerRole) headerRole.textContent = profile.role || 'Student';
   if (topbarRoleBadge) {
     topbarRoleBadge.textContent = profile.role || 'Student';
     topbarRoleBadge.removeAttribute('hidden');
   }

   if (avatarImg) {
     const photoUrl = profile.photoURL || '/images/profile_placeholder.png';
     avatarImg.style.backgroundImage = `url('${addSizeToGoogleProfilePic(photoUrl)}')`;
   }
 }

 // Handles saving profile changes
 async function onProfileFormSubmit(e) {
   e.preventDefault();
   if (!isUserSignedIn()) return;

   const alertElement = document.getElementById('profile-alert-msg');
   const saveBtn = document.getElementById('save-profile-btn');
   if (saveBtn) saveBtn.disabled = true;

   try {
     const updatedData = {
       displayName: document.getElementById('profile-input-name').value,
       role: document.getElementById('profile-input-role').value,
       department: document.getElementById('profile-input-department').value,
       studentId: document.getElementById('profile-input-student-id').value,
       teacherId: document.getElementById('profile-input-teacher-id').value,
       semester: document.getElementById('profile-input-semester').value,
       phone: document.getElementById('profile-input-phone').value,
     };

     const updatedUser = await updateProfile(
       getAuth().currentUser.uid,
       updatedData,
       selectedProfileImageFile
     );

     currentUserProfile = updatedUser;
     selectedProfileImageFile = null;
     populateProfileForm(updatedUser);

     // Update topbar UI
     userPicElement.style.backgroundImage = 'url(' + addSizeToGoogleProfilePic(getProfilePicUrl()) + ')';
     userNameElement.textContent = getUserName();

     if (alertElement) {
       alertElement.className = 'profile-alert success';
       alertElement.textContent = 'Profile updated successfully!';
       alertElement.style.display = 'block';
       setTimeout(() => { alertElement.style.display = 'none'; }, 4000);
     }
   } catch (error) {
     console.error('Error saving profile:', error);
     if (alertElement) {
       alertElement.className = 'profile-alert error';
       alertElement.textContent = 'Failed to save profile changes. Please try again.';
       alertElement.style.display = 'block';
     }
   } finally {
     if (saveBtn) saveBtn.disabled = false;
   }
 }

 // Triggers when the auth state change for instance when the user signs-in or signs-out.
 async function authStateObserver(user) {
   if (user) { // User is signed in!
     try {
       // Create or load profile in Firestore users collection
       currentUserProfile = await createUser(user);
     } catch (err) {
       console.error('Could not initialize user document:', err);
     }

     var profilePicUrl = getProfilePicUrl();
     var userName = getUserName();

     userPicElement.style.backgroundImage = 'url(' + addSizeToGoogleProfilePic(profilePicUrl) + ')';
     userNameElement.textContent = userName;

     userNameElement.removeAttribute('hidden');
     userPicElement.removeAttribute('hidden');
     signOutButtonElement.removeAttribute('hidden');

     signInButtonElement.setAttribute('hidden', 'true');
     signInButtonElement.style.display = 'none';

     // Populate Profile Page
     if (currentUserProfile) {
       populateProfileForm(currentUserProfile);
       
       const isTeacher = currentUserProfile.role === 'Teacher';
       const isStudent = currentUserProfile.role === 'Student';
       
       if (isStudent && currentUserProfile.status === 'pending') {
         document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active-tab'));
         document.getElementById('tab-pending-approval').style.display = 'block';
         document.getElementById('tab-pending-approval').classList.add('active-tab');
         document.querySelectorAll('.nav-menu .nav-item').forEach(el => {
           const tab = el.getAttribute('data-tab');
           if (tab !== 'dashboard' && tab !== 'profile' && el.id !== 'sign-out') el.style.display = 'none';
         });
         document.querySelector('.dashboard-hero').style.display = 'none';
         document.querySelector('.stats-grid').style.display = 'none';
         document.querySelector('.dashboard-bottom').style.display = 'none';
       } else if (isStudent && currentUserProfile.status === 'rejected') {
         document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active-tab'));
         document.getElementById('tab-rejected').style.display = 'block';
         document.getElementById('tab-rejected').classList.add('active-tab');
         document.querySelectorAll('.nav-menu .nav-item').forEach(el => {
           const tab = el.getAttribute('data-tab');
           if (tab !== 'dashboard' && tab !== 'profile' && el.id !== 'sign-out') el.style.display = 'none';
         });
         document.querySelector('.dashboard-hero').style.display = 'none';
         document.querySelector('.stats-grid').style.display = 'none';
         document.querySelector('.dashboard-bottom').style.display = 'none';
       } else {
         // Show classroom buttons based on role
         if (isTeacher) {
           const btnCreate = document.getElementById('btn-create-classroom');
           if (btnCreate) btnCreate.style.display = 'inline-flex';
           const navStudents = document.getElementById('nav-manage-students');
           if (navStudents) navStudents.style.display = 'flex';
         }
         const btnJoin = document.getElementById('btn-join-classroom');
         if (btnJoin) btnJoin.style.display = 'inline-flex';

         if (classroomsUnsubscribe) classroomsUnsubscribe();
         classroomsUnsubscribe = subscribeToUserClassrooms(user.uid, renderClassrooms);
       }
     }

     // Subscribe to dashboard real-time data
     if (dashboardUnsubscribe) dashboardUnsubscribe();
     dashboardUnsubscribe = subscribeDashboardData(user.uid, (update) => {
       handleDashboardUpdate(update);
     });

     saveMessagingDeviceToken();
   } else { // User is signed out!
     currentUserProfile = null;
     userNameElement.setAttribute('hidden', 'true');
     userPicElement.setAttribute('hidden', 'true');
     signOutButtonElement.setAttribute('hidden', 'true');

     const topbarRoleBadge = document.getElementById('topbar-role-badge');
     if (topbarRoleBadge) topbarRoleBadge.setAttribute('hidden', 'true');

     signInButtonElement.removeAttribute('hidden');
     signInButtonElement.style.display = '';
     
     if (classroomsUnsubscribe) {
       classroomsUnsubscribe();
       classroomsUnsubscribe = null;
     }
     if (dashboardUnsubscribe) { dashboardUnsubscribe(); dashboardUnsubscribe = null; }
     if (chatChannelsUnsubscribe) { chatChannelsUnsubscribe(); chatChannelsUnsubscribe = null; }
     if (chatMessagesUnsubscribe) { chatMessagesUnsubscribe(); chatMessagesUnsubscribe = null; }
     if (chatTypingUnsubscribe) { chatTypingUnsubscribe(); chatTypingUnsubscribe = null; }
     unsubscribeAll();
     
     const btnCreate = document.getElementById('btn-create-classroom');
     const btnJoin = document.getElementById('btn-join-classroom');
     if (btnCreate) btnCreate.style.display = 'none';
     if (btnJoin) btnJoin.style.display = 'none';
     
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
 
 // Returns true if user is signed-in. Otherwise false and displays a message.
 function checkSignedInWithMessage() {
   if (isUserSignedIn()) {
     return true;
   }
   var data = {
     message: 'You must sign-in first',
     timeout: 2000
   };
   signInSnackbarElement.MaterialSnackbar.showSnackbar(data);
   return false;
 }
 
 // Resets the given MaterialTextField.
 function resetMaterialTextfield(element) {
   element.value = '';
   element.parentNode.MaterialTextfield.boundUpdateClassesHandler();
 }
 
 // Template for messages.
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
 
 // Adds a size to Google Profile pics URLs.
 function addSizeToGoogleProfilePic(url) {
   if (url && url.indexOf('googleusercontent.com') !== -1 && url.indexOf('?') === -1) {
     return url + '?sz=150';
   }
   return url || '/images/profile_placeholder.png';
 }
 
 // A loading image URL.
 var LOADING_IMAGE_URL = 'https://www.google.com/images/spin-32.gif?a';
 
 // Delete a Message from the UI.
 function deleteMessage(id) {
   var div = document.getElementById(id);
   if (div) {
     div.parentNode.removeChild(div);
   }
 }
 
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
         throw new Error(
           `Child ${messageListNode.id} has no 'timestamp' attribute`
         );
       }
 
       if (messageListNodeTime > timestamp) {
         break;
       }
 
       messageListNode = messageListNode.nextSibling;
     }
 
     messageListElement.insertBefore(div, messageListNode);
   }
 
   return div;
 }
 
 // Displays a Message in the UI.
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
 
 // Enables or disables the submit button depending on the values of the input
 // fields.
 function toggleButton() {
   if (messageInputElement.value) {
     submitButtonElement.removeAttribute('disabled');
   } else {
     submitButtonElement.setAttribute('disabled', 'true');
   }
 }
 
  // ─── AUTH GATE ──────────────────────────────────────────────────────────

let authResolve = null;
const authReady = new Promise((resolve) => { authResolve = resolve; });

function showApp() {
  const loadingEl = document.getElementById('loading-screen');
  const authEl = document.getElementById('auth-container');
  const appEl = document.querySelector('.app-layout');
  const signInEl = document.getElementById('sign-in');
  if (loadingEl) loadingEl.classList.add('hidden');
  if (authEl) authEl.style.display = 'none';
  if (appEl) appEl.style.display = 'flex';
  if (signInEl) signInEl.style.display = 'none';
}

function showAuth() {
  const loadingEl = document.getElementById('loading-screen');
  const authEl = document.getElementById('auth-container');
  const appEl = document.querySelector('.app-layout');
  if (loadingEl) loadingEl.classList.add('hidden');
  if (authEl) authEl.style.display = 'block';
  if (appEl) appEl.style.display = 'none';
  // Show splash, then auto-transition to welcome
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
  try {
    await signInWithEmailAndPassword(getAuth(), email, password);
  } catch (err) {
    showAuthError('auth-error-msg', err.message);
  }
}

async function handleEmailRegister(e) {
  e.preventDefault();
  const name = document.getElementById('auth-reg-name').value;
  const email = document.getElementById('auth-reg-email').value;
  const password = document.getElementById('auth-reg-password').value;
  const confirm = document.getElementById('auth-reg-confirm').value;
  const role = document.getElementById('auth-reg-role').value;
  const department = document.getElementById('auth-reg-department').value;
  const studentId = document.getElementById('auth-reg-student-id').value;
  const teacherId = document.getElementById('auth-reg-teacher-id').value;
  const semester = document.getElementById('auth-reg-semester').value;
  const phone = document.getElementById('auth-reg-phone').value;

  if (password !== confirm) {
    showAuthError('auth-reg-error-msg', 'Passwords do not match.');
    return;
  }

  try {
    const cred = await createUserWithEmailAndPassword(getAuth(), email, password);
    // Update auth profile
    if (cred.user) {
      const { updateProfile } = await import('firebase/auth');
      await updateProfile(cred.user, { displayName: name });
      await createUserWithRole({ uid: cred.user.uid, displayName: name, email: email }, role);
    }
  } catch (err) {
    showAuthError('auth-reg-error-msg', err.message);
  }
}

async function handleGoogleAuth() {
  try {
    const provider = new GoogleAuthProvider();
    await signInWithPopup(getAuth(), provider);
  } catch (err) {
    showAuthError('auth-error-msg', err.message);
  }
}

async function handleGoogleRegister() {
  try {
    const provider = new GoogleAuthProvider();
    await signInWithPopup(getAuth(), provider);
  } catch (err) {
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
    await sendPasswordResetEmail(getAuth(), email);
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

  // Shortcuts to DOM Elements.
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

 // DOM Event Listeners
 messageFormElement.addEventListener('submit', onMessageFormSubmit);
 signOutButtonElement.addEventListener('click', signOutUser);
 signInButtonElement.addEventListener('click', signIn);
 
 messageInputElement.addEventListener('keyup', toggleButton);
 messageInputElement.addEventListener('change', toggleButton);
 
 imageButtonElement.addEventListener('click', function(e) {
   e.preventDefault();
   mediaCaptureElement.click();
 });
 mediaCaptureElement.addEventListener('change', onMediaFileSelected);

 if (profileFormElement) {
   profileFormElement.addEventListener('submit', onProfileFormSubmit);
 }

 if (profileFileInputElement) {
   profileFileInputElement.addEventListener('change', function(e) {
     const file = e.target.files[0];
     if (file && file.type.match('image.*')) {
       selectedProfileImageFile = file;
       const reader = new FileReader();
       reader.onload = function(evt) {
         const avatarImg = document.getElementById('profile-avatar');
         if (avatarImg) {
           avatarImg.style.backgroundImage = `url('${evt.target.result}')`;
         }
       };
       reader.readAsDataURL(file);
     }
   });
 }

  // ─── AUTH EVENT LISTENERS ──────────────────────────────────────────────
  document.getElementById('auth-login-form')?.addEventListener('submit', handleEmailLogin);
  document.getElementById('auth-register-form')?.addEventListener('submit', handleEmailRegister);
  document.getElementById('auth-google-btn')?.addEventListener('click', handleGoogleAuth);
  document.getElementById('auth-google-reg-btn')?.addEventListener('click', handleGoogleRegister);
  document.getElementById('auth-forgot-btn')?.addEventListener('click', handleForgotPassword);
  document.getElementById('auth-guest-btn')?.addEventListener('click', handleGuestAuth);

try {
  const firebaseApp = initializeApp(getFirebaseConfig());
  getPerformance();
  // Auth gate: handle auth state with loading → auth screens or dashboard
  onAuthStateChanged(getAuth(), async (user) => {
    if (user) {
      // User is signed in: show dashboard immediately
      showApp();
      await authStateObserver(user);
      updateHeroGreeting();
      loadInitialChannels();
    } else {
      // User is signed out: show auth flow
      showAuth();
    }
    if (authResolve) authResolve(user);
  });
} catch (error) {
  console.warn('Firebase initialization failed — some features will be unavailable:', error);
  showAuth();
}

// ─── DASHBOARD ────────────────────────────────────────────────────

function handleDashboardUpdate(update) {
  const { type, data } = update;
  switch (type) {
    case 'totalClassrooms': {
      const el = document.getElementById('dashboard-total-classrooms');
      if (el) el.textContent = data;
      break;
    }
    case 'pendingAssignments': {
      const el = document.getElementById('dashboard-pending-assignments');
      if (el) el.textContent = data;
      const subEl = document.getElementById('dashboard-hero-subtitle');
      if (subEl && typeof data === 'number') {
        subEl.textContent = data > 0
          ? `You have ${data} assignment${data > 1 ? 's' : ''} due soon.`
          : 'All caught up! No pending assignments.';
      }
      break;
    }
    case 'unreadMessages': {
      const el = document.getElementById('dashboard-unread-messages');
      if (el) el.textContent = data;
      break;
    }
    case 'recentActivity': {
      const listEl = document.getElementById('dashboard-activity-list');
      if (!listEl) return;
      if (!data || data.length === 0) {
        listEl.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:40px 0;color:var(--text-muted);">No recent activity.</div>';
        return;
      }
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
      break;
    }
    case 'notices': {
      const listEl = document.getElementById('notice-list');
      if (!listEl) return;
      if (!data || data.length === 0) {
        listEl.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:60px 0;color:var(--text-muted);">No notices yet.</div>';
        return;
      }
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
  if (!el) return;
  const name = getUserName();
  const hour = new Date().getHours();
  let greeting = 'Welcome back';
  if (hour < 12) greeting = 'Good morning';
  else if (hour < 17) greeting = 'Good afternoon';
  else greeting = 'Good evening';
  el.textContent = `${greeting}, ${name.split(' ')[0]}!`;
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
  
  // Subscribe to messages
  chatMessagesUnsubscribe = subscribeToMessages(channelId, (msgs) => {
    if (msgContainer) msgContainer.innerHTML = '';
    msgs.forEach(m => {
      const seenBy = m.seenBy ? Object.keys(m.seenBy) : [];
      displayMessage(m.id, m.timestamp, m.senderName, m.text, m.senderPic, m.imageUrl, seenBy);
    });
    if (msgContainer) msgContainer.scrollTop = msgContainer.scrollHeight;
    // Mark as read
    if (getAuth().currentUser) {
      markChannelAsRead(channelId, getAuth().currentUser.uid);
    }
  });
  
  // Subscribe to typing indicators
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
  if (chatChannelsUnsubscribe) chatChannelsUnsubscribe();
  chatChannelsUnsubscribe = subscribeToChannels((channels) => {
    renderChannels(channels);
    if (channels.length > 0 && !currentChannelId) {
      switchChannel(channels[0].id, channels[0].name);
    }
  });
}

// Typing indicator on input
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

// Emoji picker toggle
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
 
 function renderClassrooms(classrooms) {
   const listEl = document.getElementById('classroom-list');
   if (!listEl) return;
   
   if (classrooms.length === 0) {
     listEl.innerHTML = `
       <div class="empty-state-lg" id="classroom-empty-state">
         <img src="https://www.gstatic.com/images/branding/product/2x/classroom_64dp.png" alt="Classroom" style="width: 64px; opacity: 0.5; margin-bottom: 20px;">
         <h2>No classrooms yet</h2>
         <p id="classroom-empty-text">Join or create a classroom to get started.</p>
       </div>`;
     return;
   }
   
   listEl.innerHTML = '';
   classrooms.forEach(c => {
     const card = document.createElement('div');
     card.className = 'class-card';
     const isCreator = c.createdBy === getAuth().currentUser?.uid;
     const isTeacherOrAdmin = currentUserProfile && currentUserProfile.role === 'Teacher';
     card.innerHTML = `
       <div class="class-card-banner">
         <h3>${c.subject || 'General'}</h3>
       </div>
       <div class="class-card-body">
         <h4>${c.classroomName}</h4>
         <p>${c.teacherName}</p>
         <div style="margin-top:8px;font-size:12px;color:var(--text-muted);">
           <span>Code: <strong>${c.classroomCode || 'N/A'}</strong></span>
         </div>
       </div>
       <div class="class-card-footer">
         <span class="text-muted"><i class="material-icons-outlined" style="font-size: 16px; vertical-align: middle;">group</i> ${c.memberCount}</span>
         <div style="display:flex;gap:6px;">
           <button class="btn btn-outline chat-btn" data-classroom-id="${c.classroomId}" data-classroom-name="${c.classroomName}" style="padding: 4px 10px; font-size: 0.8rem;">Chat</button>
           ${(isCreator || isTeacherOrAdmin)
             ? `<button class="btn btn-outline edit-btn" data-classroom-id="${c.classroomId}" style="padding: 4px 10px; font-size: 0.8rem;">Edit</button>
                <button class="btn btn-outline delete-btn" data-classroom-id="${c.classroomId}" style="padding: 4px 10px; font-size: 0.8rem;color:var(--danger);">Delete</button>`
             : `<button class="btn btn-outline leave-btn" data-classroom-id="${c.classroomId}" style="padding: 4px 10px; font-size: 0.8rem;color:var(--warning);">Leave</button>`}
         </div>
       </div>
     `;
     listEl.appendChild(card);
   });
   
   // Event delegation for classroom card buttons
   listEl.querySelectorAll('.chat-btn').forEach(btn => {
     btn.addEventListener('click', (e) => {
       e.stopPropagation();
       const cId = btn.dataset.classroomId;
       const cName = btn.dataset.classroomName;
       const channelItem = document.querySelector(`.channel-item[data-channel-id="${cId}"]`);
       if (channelItem) channelItem.click();
       else {
         document.querySelector('.nav-item[data-tab="chat"]')?.click();
       }
     });
   });
   listEl.querySelectorAll('.edit-btn').forEach(btn => {
     btn.addEventListener('click', (e) => {
       e.stopPropagation();
       const cId = btn.dataset.classroomId;
       const classroom = classrooms.find(c => c.classroomId === cId);
       if (classroom) openEditModal(classroom);
     });
   });
   listEl.querySelectorAll('.delete-btn').forEach(btn => {
     btn.addEventListener('click', async (e) => {
       e.stopPropagation();
       if (!confirm('Are you sure you want to delete this classroom? This action cannot be undone.')) return;
       try {
         await deleteClassroom(btn.dataset.classroomId, currentUserProfile);
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
 }
 
 const btnCreateClass = document.getElementById('btn-create-classroom');
 const btnJoinClass = document.getElementById('btn-join-classroom');
 const formCreateClass = document.getElementById('form-create-classroom');
 const formJoinClass = document.getElementById('form-join-classroom');
 
 if (btnCreateClass) {
   btnCreateClass.addEventListener('click', () => {
     document.getElementById('modal-create-classroom').style.display = 'flex';
   });
 }
 
 if (btnJoinClass) {
   btnJoinClass.addEventListener('click', () => {
     document.getElementById('modal-join-classroom').style.display = 'flex';
   });
 }
 
 if (formCreateClass) {
   formCreateClass.addEventListener('submit', async (e) => {
     e.preventDefault();
     if (!currentUserProfile) return;
     
     const alertEl = document.getElementById('create-classroom-alert');
     const btnSubmit = document.getElementById('btn-submit-create');
     btnSubmit.disabled = true;
     
     try {
       await createClassroom({
         classroomName: document.getElementById('create-classroom-name').value,
         subject: document.getElementById('create-classroom-subject').value,
         description: document.getElementById('create-classroom-desc').value,
       }, currentUserProfile);
       
       formCreateClass.reset();
       document.getElementById('modal-create-classroom').style.display = 'none';
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
 
  if (formJoinClass) {
   formJoinClass.addEventListener('submit', async (e) => {
     e.preventDefault();
     if (!currentUserProfile) return;
     
     const alertEl = document.getElementById('join-classroom-alert');
     const btnSubmit = document.getElementById('btn-submit-join');
     btnSubmit.disabled = true;
     
     try {
       await joinClassroomByCode(
         document.getElementById('join-classroom-code').value,
         currentUserProfile
       );
       formJoinClass.reset();
       document.getElementById('modal-join-classroom').style.display = 'none';
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
   document.getElementById('edit-classroom-subject').value = classroom.subject || '';
   document.getElementById('edit-classroom-desc').value = classroom.description || '';
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
          subject: document.getElementById('edit-classroom-subject').value,
          description: document.getElementById('edit-classroom-desc').value,
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

  // ─── NEW MODULE IMPORTS ────────────────────────────────────────

  import {
    createAssignment, updateAssignment, deleteAssignment,
    subscribeAssignments, submitAssignment, gradeAssignment,
    subscribeSubmissions, subscribeMySubmission, uploadFile
  } from './assignmentService.js';
  import {
    createQuiz, updateQuiz, deleteQuiz,
    subscribeQuizzes, submitQuizAttempt,
    subscribeMyAttempt, subscribeLeaderboard
  } from './quizService.js';
  import { uploadNote, deleteNote, subscribeNotes, getCategories, searchNotes } from './noteService.js';

  // ─── EXTENDED GLOBAL STATE ─────────────────────────────────────

  let currentAssignmentClassId = null;
  let currentQuizClassId = null;
  let assignmentsUnsub = null;
  let quizzesUnsub = null;
  let notesUnsub = null;
  let userClassrooms = [];
  let quizTimer = null;
  let quizTimerSeconds = 0;
  let quizAnswers = [];

  // ─── ASSIGNMENTS ───────────────────────────────────────────────

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
    if (!assignments || assignments.length === 0) {
      container.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:60px 0;color:var(--text-muted);">No assignments yet.</div>';
      return;
    }
    container.innerHTML = '';
    const isTeacher = currentUserProfile && currentUserProfile.role === 'Teacher';
    assignments.forEach(a => {
      const dueDate = a.dueDate ? new Date(a.dueDate.seconds * 1000) : null;
      const dueStr = dueDate ? dueDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'No due date';
      const isOverdue = dueDate && dueDate < new Date();
      const card = document.createElement('div');
      card.className = 'assignment-card';
      card.innerHTML =
        '<div class="assignment-card-header"><h3>' + a.title + '</h3><span class="badge-status ' + (isOverdue ? 'bg-warning-dim' : 'bg-success-dim') + '">' + (isOverdue ? 'Overdue' : 'Active') + '</span></div>' +
        (a.description ? '<div class="assignment-card-desc">' + a.description + '</div>' : '') +
        '<div class="assignment-card-meta"><span><i class="material-icons" style="font-size:16px;">calendar_today</i> ' + dueStr + '</span><span><i class="material-icons" style="font-size:16px;">grade</i> ' + (a.maxMarks || 0) + ' marks</span>' + (a.fileUrl ? '<span><i class="material-icons" style="font-size:16px;">attach_file</i> <a href="' + a.fileUrl + '" target="_blank" style="color:var(--primary);">View PDF</a></span>' : '') + '</div>' +
        '<div class="assignment-card-actions"></div>';
      container.appendChild(card);
      const actionsDiv = card.querySelector('.assignment-card-actions');
      if (isTeacher) {
        const delBtn = document.createElement('button');
        delBtn.className = 'btn btn-outline'; delBtn.style.cssText = 'padding:4px 10px;font-size:0.8rem;color:var(--danger);';
        delBtn.innerHTML = '<i class="material-icons" style="font-size:14px;">delete</i> Delete';
        delBtn.addEventListener('click', async () => {
          if (!confirm('Delete this assignment?')) return;
          await deleteAssignment(currentAssignmentClassId, a.id);
        });
        actionsDiv.appendChild(delBtn);
      } else {
        const subBtn = document.createElement('button');
        subBtn.className = 'btn btn-primary'; subBtn.style.cssText = 'padding:4px 10px;font-size:0.8rem;';
        subBtn.innerHTML = '<i class="material-icons" style="font-size:14px;">upload</i> Submit';
        subBtn.addEventListener('click', () => {
          document.getElementById('submit-assignment-id').value = a.id;
          document.getElementById('submit-assignment-classroom').value = currentAssignmentClassId;
          document.getElementById('submit-assignment-title').textContent = 'Submit: ' + a.title;
          document.getElementById('submit-assignment-info').textContent = 'Assignment: ' + a.title;
          document.getElementById('submit-assignment-alert').style.display = 'none';
          document.getElementById('modal-submit-assignment').style.display = 'flex';
        });
        actionsDiv.appendChild(subBtn);
        if (currentAssignmentClassId) {
          subscribeMySubmission(currentAssignmentClassId, a.id, getAuth().currentUser.uid, (sub) => {
            actionsDiv.querySelectorAll('.grade-display').forEach(e => e.remove());
            if (sub && sub.marks !== null && sub.marks !== undefined) {
              const ge = document.createElement('span');
              ge.className = 'grade-display'; ge.style.cssText = 'font-weight:700;color:var(--success);font-size:14px;';
              ge.textContent = 'Marks: ' + sub.marks + '/' + (a.maxMarks || 0);
              actionsDiv.appendChild(ge);
              if (sub.feedback) {
                const fe = document.createElement('div');
                fe.className = 'grade-display'; fe.style.cssText = 'font-size:13px;color:var(--text-muted);margin-top:4px;';
                fe.textContent = 'Feedback: ' + sub.feedback;
                actionsDiv.appendChild(fe);
              }
            }
          });
        }
      }
    });
  }

  document.getElementById('btn-create-assignment')?.addEventListener('click', () => {
    if (!currentAssignmentClassId) { alert('Select a classroom first.'); return; }
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
      let fileUrl = '', fileName = '';
      const fi = document.getElementById('create-assignment-file');
      if (fi.files[0]) {
        fileUrl = await uploadFile('assignments/' + cId + '/' + Date.now() + '_' + fi.files[0].name, fi.files[0]);
        fileName = fi.files[0].name;
      }
      const dd = document.getElementById('create-assignment-due').value;
      await createAssignment(cId, {
        title: document.getElementById('create-assignment-title').value,
        description: document.getElementById('create-assignment-desc').value,
        dueDate: dd ? new Date(dd) : null,
        maxMarks: document.getElementById('create-assignment-marks').value,
        fileUrl: fileUrl, fileName: fileName,
      }, currentUserProfile);
      document.getElementById('form-create-assignment').reset();
      document.getElementById('modal-create-assignment').style.display = 'none';
    } catch (err) {
      alertEl.className = 'alert error'; alertEl.textContent = err.message; alertEl.style.display = 'block';
      setTimeout(() => alertEl.style.display = 'none', 4000);
    } finally { btn.disabled = false; }
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
      const fi = document.getElementById('submit-assignment-file');
      await submitAssignment(cId, aId, currentUserProfile, fi.files[0], fi.files[0] ? fi.files[0].name : '');
      document.getElementById('form-submit-assignment').reset();
      document.getElementById('modal-submit-assignment').style.display = 'none';
    } catch (err) {
      alertEl.className = 'alert error'; alertEl.textContent = err.message; alertEl.style.display = 'block';
      setTimeout(() => alertEl.style.display = 'none', 4000);
    } finally { btn.disabled = false; }
  });

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
        if (cb) cb.style.display = (currentUserProfile && currentUserProfile.role === 'Teacher') ? 'inline-flex' : 'none';
      });
      container.appendChild(btn);
    });
    if (container.firstChild) container.firstChild.click();
  }

  function renderQuizzes(quizzes) {
    const container = document.getElementById('quiz-list');
    if (!container) return;
    if (!quizzes || quizzes.length === 0) {
      container.innerHTML = '<div class="empty-state-sm" style="text-align:center;padding:60px 0;color:var(--text-muted);">No quizzes yet.</div>';
      return;
    }
    container.innerHTML = '';
    const isTeacher = currentUserProfile && currentUserProfile.role === 'Teacher';
    quizzes.forEach(q => {
      const qCount = (q.questions && q.questions.length) || 0;
      const card = document.createElement('div');
      card.className = 'quiz-card';
      card.innerHTML =
        '<div class="quiz-card-header"><h3>' + q.title + '</h3><span class="badge-status bg-success-dim">' + qCount + ' questions</span></div>' +
        (q.description ? '<p style="font-size:14px;color:var(--text-muted);margin-bottom:12px;">' + q.description + '</p>' : '') +
        '<div class="quiz-card-meta"><span><i class="material-icons" style="font-size:16px;">timer</i> ' + (q.timeLimit || 0) + ' min</span></div>' +
        '<div class="quiz-card-actions"></div>';
      container.appendChild(card);
      const actionsDiv = card.querySelector('.quiz-card-actions');
      if (isTeacher) {
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
            const lb2 = document.createElement('button');
            lb2.className = 'btn btn-outline'; lb2.style.cssText = 'padding:4px 10px;font-size:0.8rem;';
            lb2.innerHTML = '<i class="material-icons" style="font-size:14px;">leaderboard</i> Leaderboard';
            lb2.addEventListener('click', () => openLeaderboard(currentQuizClassId, q.id, q.title));
            actionsDiv.appendChild(lb2);
          } else {
            const sb = document.createElement('button');
            sb.className = 'btn btn-primary'; sb.style.cssText = 'padding:4px 10px;font-size:0.8rem;';
            sb.innerHTML = '<i class="material-icons" style="font-size:14px;">play_arrow</i> Attempt';
            sb.addEventListener('click', () => startQuizAttempt(currentQuizClassId, q));
            actionsDiv.appendChild(sb);
          }
        });
      }
    });
  }

  function startQuizAttempt(classroomId, quiz) {
    quizAnswers = new Array((quiz.questions || []).length).fill(-1);
    document.getElementById('attempt-quiz-id').value = quiz.id;
    document.getElementById('attempt-quiz-classroom').value = classroomId;
    document.getElementById('attempt-quiz-total').value = (quiz.questions || []).length;
    document.getElementById('attempt-quiz-title').textContent = quiz.title;
    document.getElementById('attempt-quiz-alert').style.display = 'none';
    const container = document.getElementById('attempt-questions-container');
    container.innerHTML = '';
    (quiz.questions || []).forEach((q, idx) => {
      const qDiv = document.createElement('div');
      qDiv.className = 'quiz-question-card';
      qDiv.innerHTML = '<div class="q-title">' + (idx + 1) + '. ' + q.question + '</div>';
      q.options.forEach((opt, oi) => {
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
  }

  async function submitQuizAttemptAction() {
    if (quizTimer) clearInterval(quizTimer);
    const qId = document.getElementById('attempt-quiz-id').value;
    const cId = document.getElementById('attempt-quiz-classroom').value;
    const tt = (parseInt(document.getElementById('create-quiz-timer').value) || 0) * 60 - quizTimerSeconds;
    try {
      const r = await submitQuizAttempt(cId, qId, currentUserProfile, quizAnswers, Math.max(0, tt));
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

  function openReview(classroomId, quiz, attempt) {
    const container = document.getElementById('attempt-questions-container');
    container.innerHTML = '';
    (quiz.questions || []).forEach((q, idx) => {
      const ans = (attempt.answers || []).find(a => a.questionIndex === idx);
      const qDiv = document.createElement('div');
      qDiv.className = 'quiz-question-card';
      qDiv.innerHTML = '<div class="q-title">' + (idx + 1) + '. ' + q.question + '</div>';
      q.options.forEach((opt, oi) => {
        const ic = ans && ans.correctAnswer === oi, is = ans && ans.selectedAnswer === oi;
        const od = document.createElement('div');
        od.className = 'quiz-option ' + (ic ? 'correct' : (is ? 'wrong' : ''));
        od.innerHTML = '<span style="width:24px;height:24px;border-radius:50%;border:2px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;">' + String.fromCharCode(65 + oi) + '</span> ' + opt + (ic || is ? ' <i class="material-icons" style="font-size:16px;color:' + (ic ? 'var(--success)' : 'var(--danger)') + ';">' + (ic ? 'check_circle' : 'cancel') + '</i>' : '');
        qDiv.appendChild(od);
      });
      container.appendChild(qDiv);
    });
    document.getElementById('attempt-quiz-title').textContent = 'Review: ' + quiz.title;
    document.getElementById('quiz-timer-display').textContent = 'Score: ' + attempt.score + '/' + attempt.total;
    document.getElementById('btn-submit-attempt').style.display = 'none';
    document.getElementById('modal-attempt-quiz').style.display = 'flex';
    document.getElementById('btn-close-attempt').addEventListener('click', () => { document.getElementById('btn-submit-attempt').style.display = ''; }, { once: true });
  }

  let qCount = 0;
  document.getElementById('btn-add-question')?.addEventListener('click', () => {
    const container = document.getElementById('quiz-questions-container');
    const idx = qCount++;
    const div = document.createElement('div');
    div.className = 'quiz-question-card';
    let oh = '';
    for (let i = 0; i < 4; i++) oh += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;"><input type="radio" name="c_' + idx + '" value="' + i + '" ' + (i === 0 ? 'checked' : '') + ' /><input type="text" class="form-control q-opt" placeholder="Option ' + String.fromCharCode(65 + i) + '..." style="flex:1;padding:8px 12px;font-size:13px;" /></div>';
    div.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><strong>Question ' + (idx + 1) + '</strong><button type="button" class="icon-btn remove-question" style="width:28px;height:28px;color:var(--danger);"><i class="material-icons" style="font-size:18px;">close</i></button></div><input type="text" class="form-control q-text" placeholder="Enter question..." style="margin-bottom:8px;" /><div>' + oh + '</div>';
    container.appendChild(div);
    div.querySelector('.remove-question')?.addEventListener('click', () => div.remove());
  });

  document.getElementById('form-create-quiz')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentUserProfile) return;
    const alertEl = document.getElementById('create-quiz-alert');
    const btn = document.getElementById('btn-submit-create-quiz');
    btn.disabled = true;
    try {
      const qes = document.querySelectorAll('#quiz-questions-container .quiz-question-card');
      const questions = Array.from(qes).map(el => ({
        question: el.querySelector('.q-text').value.trim(),
        options: Array.from(el.querySelectorAll('.q-opt')).map(o => o.value.trim()),
        correctAnswer: parseInt(el.querySelector('input[type="radio"]:checked').value),
      })).filter(q => q.question);
      if (questions.length === 0) throw new Error('Add at least one question.');
      await createQuiz(document.getElementById('create-quiz-classroom').value || currentQuizClassId, {
        title: document.getElementById('create-quiz-title').value,
        description: document.getElementById('create-quiz-desc').value,
        timeLimit: document.getElementById('create-quiz-timer').value,
        questions: questions,
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

  document.getElementById('btn-create-quiz')?.addEventListener('click', () => {
    if (!currentQuizClassId) { alert('Select a classroom first.'); return; }
    document.getElementById('create-quiz-classroom').value = currentQuizClassId;
    document.getElementById('create-quiz-alert').style.display = 'none';
    document.getElementById('modal-create-quiz').style.display = 'flex';
  });

  // ─── NOTES ─────────────────────────────────────────────────────

  document.getElementById('btn-upload-note')?.addEventListener('click', () => {
    if (userClassrooms.length === 0) { alert('You must be in a classroom.'); return; }
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
  renderClassrooms = function(classrooms) {
    userClassrooms = classrooms;
    origRC(classrooms);
    if (document.getElementById('assignment-list')) {
      buildAssignmentClassroomSelector('assignment-class-selector', (classId) => {
        currentAssignmentClassId = classId;
        if (assignmentsUnsub) assignmentsUnsub();
        document.getElementById('assignments-subtitle').textContent = classId ? 'Assignments for selected class.' : 'All classrooms.';
        const cb = document.getElementById('btn-create-assignment');
        if (cb) cb.style.display = (classId && currentUserProfile && currentUserProfile.role === 'Teacher') ? 'inline-flex' : 'none';
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

  // ─── STUDENT MANAGEMENT ────────────────────────────────────────

  async function loadStudents() {
    const tbody = document.getElementById('students-table-body');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--text-muted);">Loading students...</td></tr>';
    try {
      const students = await getAllStudents();
      tbody.innerHTML = '';
      if (students.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--text-muted);">No students found.</td></tr>';
        return;
      }
      students.forEach(s => {
        const tr = document.createElement('tr');
        const statusClass = s.status === 'approved' ? 'approved' : (s.status === 'rejected' ? 'rejected' : 'pending');
        tr.innerHTML = `
          <td>${s.displayName || 'Unknown'}</td>
          <td>${s.email || 'N/A'}</td>
          <td>${s.department || 'N/A'}</td>
          <td>${s.studentId || 'N/A'}</td>
          <td><span class="status-badge ${statusClass}">${s.status || 'pending'}</span></td>
          <td class="student-actions">
            ${s.status !== 'approved' ? `<button class="btn btn-outline btn-approve" data-uid="${s.uid}" style="padding:4px 10px;font-size:12px;color:var(--success);border-color:var(--success);">Approve</button>` : ''}
            ${s.status !== 'rejected' ? `<button class="btn btn-outline btn-reject" data-uid="${s.uid}" style="padding:4px 10px;font-size:12px;color:var(--danger);border-color:var(--danger);">Reject</button>` : ''}
          </td>
        `;
        tbody.appendChild(tr);
      });
      tbody.querySelectorAll('.btn-approve').forEach(btn => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            await approveStudent(btn.dataset.uid);
            await loadStudents();
          } catch (e) {
            alert('Failed to approve: ' + e.message);
            btn.disabled = false;
          }
        });
      });
      tbody.querySelectorAll('.btn-reject').forEach(btn => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            await rejectStudent(btn.dataset.uid);
            await loadStudents();
          } catch (e) {
            alert('Failed to reject: ' + e.message);
            btn.disabled = false;
          }
        });
      });
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--danger);">Error loading students: ${e.message}</td></tr>`;
    }
  }

  const btnRefreshStudents = document.getElementById('btn-refresh-students');
  if (btnRefreshStudents) btnRefreshStudents.addEventListener('click', loadStudents);

  const navManageStudents = document.getElementById('nav-manage-students');
  if (navManageStudents) {
    navManageStudents.addEventListener('click', () => {
      loadStudents();
    });
  }