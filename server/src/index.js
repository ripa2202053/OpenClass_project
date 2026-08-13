import http from 'http';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeApp, getApps, cert } from 'firebase-admin/app';

import { attachSignaling } from './socket.js';

import dashboardRoutes from './routes/dashboard.js';
import classroomsRoutes from './routes/classrooms.js';
import assignmentsRoutes from './routes/assignments.js';
import quizzesRoutes from './routes/quizzes.js';
import attendanceRoutes from './routes/attendance.js';
import notesRoutes from './routes/notes.js';
import meetingsRoutes from './routes/meetings.js';
import calendarRoutes from './routes/calendar.js';
import filesRoutes from './routes/files.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Firebase Admin
if (!getApps().length) {
  const keyPath = path.resolve(__dirname, '../serviceAccountKey.json');
  if (fs.existsSync(keyPath)) {
    try {
      const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
      initializeApp({
        credential: cert(serviceAccount)
      });
      console.log('Firebase Admin initialized with serviceAccountKey.json');
    } catch (err) {
      console.warn('Error reading serviceAccountKey.json, using fallback config:', err.message);
      initializeApp({ projectId: 'openclass-7889d' });
    }
  } else {
    initializeApp({ projectId: 'openclass-7889d' });
    console.log('Firebase Admin initialized with default project openclass-7889d');
  }
}

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS for http://localhost:5173
app.use(cors({
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  credentials: true,
}));

// 70mb body limit so a 50MB file can be transmitted as Base64 (~67MB) plus JSON overhead
app.use(express.json({ limit: '70mb' }));
app.use(express.urlencoded({ extended: true, limit: '70mb' }));

// Register API Routes - Specific sub-resource routes MUST be registered BEFORE base /api/classrooms
app.use('/api/classrooms/:classId/assignments', assignmentsRoutes);
app.use('/api/classrooms/:classId/quizzes', quizzesRoutes);
app.use('/api/classrooms/:classId/attendance', attendanceRoutes);
app.use('/api/classrooms/:classId/notes', notesRoutes);
app.use('/api/classrooms/:classId/meetings', meetingsRoutes);
app.use('/api/classrooms/:classId/files', filesRoutes);

app.use('/api/dashboard', dashboardRoutes);
app.use('/api/classrooms', classroomsRoutes);
app.use('/api', calendarRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const server = http.createServer(app);
attachSignaling(server);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use by another process. Please close it or kill the process using port ${PORT}.`);
  } else {
    console.error('Server error:', err);
  }
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
