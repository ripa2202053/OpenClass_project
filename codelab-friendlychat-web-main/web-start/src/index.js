'use strict';

import { initializeApp } from 'firebase/app';
import {
  getAuth,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
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
import { getMessaging, getToken, onMessage } from 'firebase/messaging';
import { getPerformance } from 'firebase/performance';

import { getFirebaseConfig } from './firebase-config.js';

const firebaseAppConfig = getFirebaseConfig();

let app;
let auth;
let firestore;
let storage;
let messaging;
let performance;

try {
  app = initializeApp(firebaseAppConfig);
  auth = getAuth(app);
  firestore = getFirestore(app);
  storage = getStorage(app);
  messaging = getMessaging(app);
  performance = getPerformance(app);
} catch (e) {
  console.warn('Firebase initialization failed:', e);
}

async function signIn() {
  var provider = new GoogleAuthProvider();
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    console.error('Sign-in failed:', e);
  }
}

function signOutUser() {
  signOut(auth).catch(function (error) {
    console.error('Sign-out error:', error);
  });
}

function initFirebaseAuth() {
  onAuthStateChanged(auth, authStateObserver);
}

function getProfilePicUrl() {
  return auth.currentUser ? auth.currentUser.photoURL : '';
}

function getUserName() {
  return auth.currentUser ? auth.currentUser.displayName : '';
}

function isUserSignedIn() {
  return !!auth.currentUser;
}

async function saveMessage(messageText) {
  try {
    await addDoc(collection(firestore, 'messages'), {
      name: getUserName(),
      text: messageText,
      profilePicUrl: getProfilePicUrl(),
      timestamp: serverTimestamp(),
    });
  } catch (e) {
    console.error('Error saving message:', e);
  }
}

function loadMessages() {
  var q = query(
    collection(firestore, 'messages'),
    orderBy('timestamp', 'desc'),
    limit(12)
  );
  onSnapshot(q, function (snapshot) {
    snapshot.docChanges().forEach(function (change) {
      if (change.type === 'removed') {
        deleteMessage(change.doc.id);
      } else {
        var message = change.doc.data();
        displayMessage(
          change.doc.id,
          message.timestamp,
          message.name,
          message.text,
          message.profilePicUrl,
          message.imageUrl
        );
      }
    });
  });
}

async function saveImageMessage(file) {
  try {
    var storageRef = ref(storage, 'messages/' + file.name);
    var snapshot = await uploadBytesResumable(storageRef, file);
    var imageUrl = await getDownloadURL(snapshot.ref);
    await addDoc(collection(firestore, 'messages'), {
      name: getUserName(),
      imageUrl: imageUrl,
      profilePicUrl: getProfilePicUrl(),
      timestamp: serverTimestamp(),
    });
  } catch (e) {
    console.error('Error saving image message:', e);
  }
}

async function saveMessagingDeviceToken() {
  try {
    var currentToken = await getToken(messaging);
    if (currentToken) {
      console.log('FCM token:', currentToken);
    } else {
      await requestNotificationsPermissions();
    }
  } catch (e) {
    console.error('Unable to get messaging token:', e);
  }
}

async function requestNotificationsPermissions() {
  try {
    var permission = await Notification.requestPermission();
    if (permission === 'granted') {
      await saveMessagingDeviceToken();
    }
  } catch (e) {
    console.error('Unable to get permission to notify:', e);
  }
}

function onMediaFileSelected(event) {
  event.preventDefault();
  var file = event.target.files[0];

  imageFormElement.reset();

  if (!file.type.match('image.*')) {
    var data = {
      message: 'You can only share images',
      timeout: 2000,
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
  if (messageInputElement.value && checkSignedInWithMessage()) {
    saveMessage(messageInputElement.value).then(function () {
      resetMaterialTextfield(messageInputElement);
      toggleButton();
    });
  }
}

function authStateObserver(user) {
  if (user) {
    var profilePicUrl = getProfilePicUrl();
    var userName = getUserName();

    userPicElement.style.backgroundImage =
      'url(' + addSizeToGoogleProfilePic(profilePicUrl) + ')';
    userNameElement.textContent = userName;

    userNameElement.removeAttribute('hidden');
    userPicElement.removeAttribute('hidden');
    signOutButtonElement.removeAttribute('hidden');

    signInButtonElement.setAttribute('hidden', 'true');

    saveMessagingDeviceToken();
  } else {
    userNameElement.setAttribute('hidden', 'true');
    userPicElement.setAttribute('hidden', 'true');
    signOutButtonElement.setAttribute('hidden', 'true');

    signInButtonElement.removeAttribute('hidden');
  }
}

function checkSignedInWithMessage() {
  if (isUserSignedIn()) {
    return true;
  }

  var data = {
    message: 'You must sign-in first',
    timeout: 2000,
  };
  signInSnackbarElement.MaterialSnackbar.showSnackbar(data);
  return false;
}

function resetMaterialTextfield(element) {
  element.value = '';
  element.parentNode.MaterialTextfield.boundUpdateClassesHandler();
}

var MESSAGE_TEMPLATE =
  '<div class="message-container">' +
  '<div class="spacing"><div class="pic"></div></div>' +
  '<div class="message"></div>' +
  '<div class="name"></div>' +
  '</div>';

function addSizeToGoogleProfilePic(url) {
  if (url.indexOf('googleusercontent.com') !== -1 && url.indexOf('?') === -1) {
    return url + '?sz=150';
  }
  return url;
}

var LOADING_IMAGE_URL = 'https://www.google.com/images/spin-32.gif?a';

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

function displayMessage(id, timestamp, name, text, picUrl, imageUrl) {
  var div =
    document.getElementById(id) || createAndInsertMessage(id, timestamp);

  if (picUrl) {
    div.querySelector('.pic').style.backgroundImage =
      'url(' + addSizeToGoogleProfilePic(picUrl) + ')';
  }

  div.querySelector('.name').textContent = name;
  var messageElement = div.querySelector('.message');

  if (text) {
    messageElement.textContent = text;
    messageElement.innerHTML = messageElement.innerHTML.replace(/\n/g, '<br>');
  } else if (imageUrl) {
    var image = document.createElement('img');
    image.addEventListener('load', function () {
      messageListElement.scrollTop = messageListElement.scrollHeight;
    });
    image.src = imageUrl + '&' + new Date().getTime();
    messageElement.innerHTML = '';
    messageElement.appendChild(image);
  }
  setTimeout(function () {
    div.classList.add('visible');
  }, 1);
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

messageFormElement.addEventListener('submit', onMessageFormSubmit);
signOutButtonElement.addEventListener('click', signOutUser);
signInButtonElement.addEventListener('click', signIn);

messageInputElement.addEventListener('keyup', toggleButton);
messageInputElement.addEventListener('change', toggleButton);

imageButtonElement.addEventListener('click', function (e) {
  e.preventDefault();
  mediaCaptureElement.click();
});
mediaCaptureElement.addEventListener('change', onMediaFileSelected);

initFirebaseAuth();
loadMessages();
