import { getAuth } from 'firebase/auth';

export const API_BASE_URL = 
  (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'))
    ? 'http://localhost:5000'
    : 'https://openclass-project.onrender.com';

async function getAuthUser() {
  const auth = getAuth();
  if (auth.currentUser) {
    return auth.currentUser;
  }
  if (typeof auth.authStateReady === 'function') {
    try {
      await auth.authStateReady();
    } catch (err) {
      console.warn('authStateReady failed:', err);
    }
  }
  return auth.currentUser;
}

export async function fetchWithAuth(endpoint, options = {}) {
  const user = await getAuthUser();

  let token = '';
  if (user) {
    try {
      token = await user.getIdToken();
    } catch (err) {
      console.warn('Failed to retrieve Firebase ID token:', err);
    }
  } else {
    console.warn('fetchWithAuth: no signed-in user yet; sending request without a Bearer token.');
  }

  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {}),
  };

  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE_URL}${endpoint}`;

  const config = {
    ...options,
    headers,
  };

  const response = await fetch(url, config);

  if (!response.ok) {
    let errorMessage = `HTTP error! Status: ${response.status} ${response.statusText}`;
    try {
      const errorData = await response.json();
      if (errorData && (errorData.error || errorData.message)) {
        errorMessage = errorData.error || errorData.message;
      }
    } catch (e) {
      // Ignore JSON parse error on non-JSON response
    }
    throw new Error(errorMessage);
  }

  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    return await response.json();
  }

  return await response.text();
}

export default fetchWithAuth;
