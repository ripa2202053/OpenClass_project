import { getAuth } from 'firebase/auth';

const API_BASE_URL = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? 'https://openclass-project.onrender.com' : 'http://localhost:5000');

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
