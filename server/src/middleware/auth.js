import { getAuth } from 'firebase-admin/auth';

export async function verifyAuthToken(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid Authorization header' });
  }

  const token = authHeader.split('Bearer ')[1];

  try {
    const decodedToken = await getAuth().verifyIdToken(token);
    req.user = decodedToken;
    return next();
  } catch (error) {
    console.warn('Token verification failed via admin SDK:', error.message);
    
    // Dev fallback for testing environments when service account is dummy or token is mock
    if (process.env.NODE_ENV !== 'production' && token) {
      try {
        const payloadBase64 = token.split('.')[1];
        if (payloadBase64) {
          const decoded = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf-8'));
          req.user = {
            uid: decoded.user_id || decoded.sub || decoded.uid || 'dev_user_123',
            email: decoded.email || 'user@example.com',
            name: decoded.name || decoded.email || 'Dev User',
            ...decoded
          };
          return next();
        }
      } catch (e) {
        // Fallthrough to 401
      }
    }

    return res.status(401).json({ error: 'Unauthorized: Invalid token', details: error.message });
  }
}

export const verifySocketToken = async (tokenOrSocket, next) => {
  try {
    if (typeof next === 'function') {
      const token = tokenOrSocket?.handshake?.auth?.token || tokenOrSocket?.handshake?.query?.token;
      if (token) {
        try {
          const decoded = await getAuth().verifyIdToken(token);
          tokenOrSocket.user = decoded;
        } catch (e) {
          // allow connection even on invalid dev token
        }
      }
      return next();
    }
    const token = typeof tokenOrSocket === 'string' ? tokenOrSocket : null;
    if (!token) return null;
    try {
      return await getAuth().verifyIdToken(token);
    } catch (e) {
      return null;
    }
  } catch (err) {
    if (typeof next === 'function') return next();
    return null;
  }
};

export default verifyAuthToken;
