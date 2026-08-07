import { initializeApp } from 'firebase/app';
import { getMessaging, onBackgroundMessage } from 'firebase/messaging/sw';
import { getFirebaseConfig } from './firebase-config';

const firebaseApp = initializeApp(getFirebaseConfig());
const messaging = getMessaging(firebaseApp);

onBackgroundMessage(messaging, (payload) => {
  const title = payload.notification?.title || 'OpenClass';
  const options = {
    body: payload.notification?.body || '',
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    data: payload.data,
  };
  self.registration.showNotification(title, options);
});
