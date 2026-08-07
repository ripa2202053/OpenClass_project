importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyA_9sYK0qYRAEHN-KsF1HnO88xJq3uKsh0",
  authDomain: "openclass-7889d.firebaseapp.com",
  projectId: "openclass-7889d",
  storageBucket: "openclass-7889d.firebasestorage.app",
  messagingSenderId: "140549781612",
  appId: "1:140549781612:web:70998bfe3b796e03578049",
  measurementId: "G-WVPKQXYVP6"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || 'OpenClass';
  const options = {
    body: payload.notification?.body || '',
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    data: payload.data,
  };
  self.registration.showNotification(title, options);
});
