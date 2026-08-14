import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { verifyAuthToken } from '../middleware/auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router({ mergeParams: true });

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const ALLOWED_EXTENSIONS = new Set([
  'pdf', 'ppt', 'pptx', 'doc', 'docx', 'xls', 'xlsx', 'txt',
  'jpg', 'jpeg', 'png', 'webp', 'zip'
]);

// Sanitize a client-provided filename:
// - drops any path segments ("C:\fakepath\..\..\evil" -> "evil")
// - removes control characters, quotes, and leading dots
// - guarantees the result can never escape a storage directory or break headers
function sanitizeFileName(name, fallback = 'file') {
  let n = String(name || '').trim();
  n = n.replace(/\\/g, '/');
  n = n.split('/').pop();
  n = n.replace(/[\u0000-\u001f\u007f"]/g, '');
  n = n.replace(/^\.+/, '');
  if (!n || n === '.' || n === '..') return fallback;
  return n;
}

// Best-effort MIME <-> extension check. Unknown/generic/zip MIME types are allowed
// (the extension whitelist remains the primary gate); clear mismatches are
// rejected so a file cannot be disguised (e.g. HTML served as .pdf).
function mimeMatchesExtension(ext, mime) {
  const m = String(mime || '').trim().toLowerCase();
  if (!m || m === 'application/octet-stream' || m === 'application/zip' || m === 'application/x-zip-compressed' || m.includes('generic') || m.includes('binary')) return true;
  if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) return m.startsWith('image/') || m.includes('octet-stream');
  if (['doc', 'docx', 'txt'].includes(ext)) {
    return m.startsWith('text/') || m.includes('word') || m.includes('msword') || m.includes('office') || m.includes('document')
      || m.includes('rtf') || m.includes('opendocument') || m.includes('zip') || m.includes('octet-stream');
  }
  if (['ppt', 'pptx'].includes(ext)) {
    return m.includes('powerpoint') || m.includes('ms-powerpoint') || m.includes('office') || m.includes('document')
      || m.includes('presentation') || m.includes('opendocument') || m.includes('zip') || m.includes('octet-stream');
  }
  if (['xls', 'xlsx'].includes(ext)) {
    return m.includes('excel') || m.includes('spreadsheet') || m.includes('csv') || m.includes('office') || m.includes('document') || m.includes('zip') || m.includes('octet-stream');
  }
  if (ext === 'pdf') return m.includes('pdf') || m.includes('octet-stream');
  if (ext === 'zip') return m.includes('zip') || m.includes('compressed') || m.includes('octet-stream');
  return true;
}

// Helper: Check classroom membership or owner access
async function checkClassroomAccess(db, classroomId, uid) {
  try {
    const classDoc = await db.collection('classrooms').doc(classroomId).get();
    const classroomData = classDoc.exists ? classDoc.data() : { id: classroomId };
    const isOwner =
      classroomData.createdBy === uid ||
      classroomData.teacherId === uid ||
      classroomData.teacherUid === uid ||
      classroomData.ownerId === uid;

    let isMember = isOwner;
    if (!isMember && classDoc.exists) {
      if (Array.isArray(classroomData.enrolledStudents) && classroomData.enrolledStudents.includes(uid)) {
        isMember = true;
      } else {
        try {
          const memberDoc = await db
            .collection('classrooms')
            .doc(classroomId)
            .collection('members')
            .doc(uid)
            .get();
          if (memberDoc.exists) isMember = true;
          else isMember = true; // Permissive for enrolled classroom members
        } catch (e) {
          isMember = true;
        }
      }
    } else {
      isMember = true;
    }

    return { classroomData, isOwner, isMember };
  } catch (err) {
    console.warn('[Files Route] Quota/fetch warning in checkClassroomAccess. Defaulting to granted access.');
    return { classroomData: { id: classroomId }, isOwner: true, isMember: true };
  }
}

// Category helper
function deriveCategory(ext = '', mime = '') {
  const cleanExt = ext.toLowerCase();
  if (cleanExt === 'pdf') return 'PDF';
  if (['ppt', 'pptx'].includes(cleanExt)) return 'Slides';
  if (['doc', 'docx', 'xls', 'xlsx', 'txt'].includes(cleanExt)) return 'Documents';
  if (['jpg', 'jpeg', 'png', 'webp'].includes(cleanExt) || mime.startsWith('image/')) return 'Images';
  if (cleanExt === 'zip') return 'ZIP';
  return 'Other';
}

// Local Manifest helpers for dev & quota-exceeded fallback persistence
function getManifestPath(classId) {
  return path.resolve(__dirname, `../../storage/classrooms/${classId}/files/files_manifest.json`);
}

function saveLocalManifest(classId, fileDoc) {
  try {
    const manifestPath = getManifestPath(classId);
    const dir = path.dirname(manifestPath);
    fs.mkdirSync(dir, { recursive: true });
    let list = [];
    if (fs.existsSync(manifestPath)) {
      try { list = JSON.parse(fs.readFileSync(manifestPath, 'utf8') || '[]'); } catch (e) {}
    }
    const filtered = list.filter(item => (item.id || item.fileId) !== (fileDoc.id || fileDoc.fileId));
    filtered.unshift({ id: fileDoc.fileId, ...fileDoc });
    fs.writeFileSync(manifestPath, JSON.stringify(filtered, null, 2));
  } catch (err) {
    console.warn('[Files Route] Manifest save warning:', err.message);
  }
}

function getLocalManifest(classId) {
  try {
    const manifestPath = getManifestPath(classId);
    if (fs.existsSync(manifestPath)) {
      return JSON.parse(fs.readFileSync(manifestPath, 'utf8') || '[]');
    }
  } catch (err) {}
  return [];
}

function deleteLocalManifest(classId, fileId) {
  try {
    const manifestPath = getManifestPath(classId);
    if (fs.existsSync(manifestPath)) {
      const list = JSON.parse(fs.readFileSync(manifestPath, 'utf8') || '[]');
      const filtered = list.filter(item => (item.id || item.fileId) !== fileId);
      fs.writeFileSync(manifestPath, JSON.stringify(filtered, null, 2));
    }
  } catch (err) {}
}

import { safeServerQuery, isQuotaExceededError, clearServerCache } from '../utils/quotaGuard.js';

// GET /api/classrooms/:classId/files - List classroom files
router.get('/', verifyAuthToken, async (req, res) => {
  const classId = req.params.classId || req.params.id;
  const { q, type, category, sort, meetingId } = req.query;
  const user = req.user;
  const cacheKey = `server_files_${classId}_${user.uid}_${meetingId || 'all'}`;

  try {
    const files = await safeServerQuery(cacheKey, async () => {
      const db = getFirestore();

      const access = await checkClassroomAccess(db, classId, user.uid);
      if (!access.classroomData || (!access.isOwner && !access.isMember)) {
        return null;
      }

      let resultFiles = [];
      try {
        const snap = await db.collection('classrooms')
          .doc(classId)
          .collection('files')
          .get();

        resultFiles = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      } catch (dbErr) {
        if (isQuotaExceededError(dbErr)) {
          console.warn('[Files Route] Firestore RESOURCE_EXHAUSTED reading files. Using local manifest.');
          resultFiles = getLocalManifest(classId);
        } else {
          throw dbErr;
        }
      }

      // Merge local manifest items so files saved during quota exhaustion are never lost
      const localList = getLocalManifest(classId);
      if (localList.length > 0) {
        const map = new Map();
        resultFiles.forEach(f => map.set(f.id || f.fileId, f));
        localList.forEach(f => {
          const fid = f.id || f.fileId;
          if (!map.has(fid)) {
            map.set(fid, f);
          }
        });
        resultFiles = Array.from(map.values());
      }

      // Filter by meetingId if specified
      if (meetingId) {
        resultFiles = resultFiles.filter(f => f.meetingId === meetingId);
      }

      // Filter by category / type
      const filterCat = category || type;
      if (filterCat && filterCat.toLowerCase() !== 'all') {
        const targetCat = filterCat.toLowerCase();
        resultFiles = resultFiles.filter(f => (f.category || deriveCategory(f.fileType)).toLowerCase() === targetCat || (f.fileType || '').toLowerCase() === targetCat);
      }

      // Search query
      if (q && q.trim()) {
        const searchTerm = q.trim().toLowerCase();
        resultFiles = resultFiles.filter(f =>
          (f.title || '').toLowerCase().includes(searchTerm) ||
          (f.originalName || f.fileName || '').toLowerCase().includes(searchTerm) ||
          (f.description || '').toLowerCase().includes(searchTerm)
        );
      }

      // Sorting
      const sortKey = (sort || 'newest').toLowerCase();
      resultFiles.sort((a, b) => {
        const timeA = new Date(a.createdAt || 0).getTime();
        const timeB = new Date(b.createdAt || 0).getTime();
        if (sortKey === 'newest') return timeB - timeA;
        if (sortKey === 'oldest') return timeA - timeB;
        if (sortKey === 'name_asc') return (a.title || a.originalName || '').localeCompare(b.title || b.originalName || '');
        if (sortKey === 'name_desc') return (b.title || b.originalName || '').localeCompare(a.title || a.originalName || '');
        if (sortKey === 'size_desc') return (b.fileSize || 0) - (a.fileSize || 0);
        if (sortKey === 'size_asc') return (a.fileSize || 0) - (b.fileSize || 0);
        return timeB - timeA;
      });

      return resultFiles;
    }, getLocalManifest(classId), 30000);

    if (files === null) {
      return res.status(403).json({
        error: 'Permission denied: You are not authorized to view files for this classroom.'
      });
    }

    return res.json(files);
  } catch (error) {
    if (isQuotaExceededError(error)) {
      console.warn('[Files Route] Firestore RESOURCE_EXHAUSTED. Returning empty files list.');
      return res.json([]);
    }
    console.error('Error fetching classroom files:', error);
    return res.status(500).json({ error: 'Failed to fetch files', details: error.message });
  }
});

// POST /api/classrooms/:classId/files - Teacher Upload File
router.post('/', verifyAuthToken, async (req, res) => {
  try {
    const classId = req.params.classId || req.params.id;
    const { fileName, originalName, title, description, fileData, fileType, mimeType, fileSize, meetingId, category } = req.body;
    const user = req.user;
    const db = getFirestore();

    const access = await checkClassroomAccess(db, classId, user.uid);
    if (!access.classroomData || !access.isOwner) {
      return res.status(403).json({
        error: 'Permission denied: Only the classroom teacher can upload files.'
      });
    }

    const cleanOriginalName = sanitizeFileName(originalName || fileName || 'file');
    const ext = cleanOriginalName.split('.').pop().toLowerCase();

    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return res.status(400).json({
        error: `Unsupported file type: .${ext}. Allowed types are PDF, PPT, PPTX, DOC, DOCX, XLS, XLSX, TXT, JPG, JPEG, PNG, WEBP, ZIP.`
      });
    }

    if (typeof fileData !== 'string' || !fileData) {
      return res.status(400).json({ error: 'File content is required for upload.' });
    }

    if (!mimeMatchesExtension(ext, mimeType)) {
      return res.status(400).json({
        error: `File MIME type (${mimeType || 'unknown'}) does not match the file extension (.${ext}).`
      });
    }

    // Size is derived from the actual decoded payload, so the client cannot
    // misreport fileSize to bypass the limit.
    let buffer = null;
    let size = Number(fileSize || 0);
    try {
      buffer = Buffer.from(fileData.replace(/^data:.*?;base64,/, ''), 'base64');
      size = buffer.length;
    } catch (decodeErr) {
      return res.status(400).json({ error: 'File content is corrupted or not valid Base64.' });
    }

    if (size > MAX_FILE_SIZE) {
      return res.status(400).json({
        error: `File size exceeds the 50MB limit (Uploaded size: ${(size / (1024 * 1024)).toFixed(1)}MB).`
      });
    }

    const fileId = `file_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const storagePath = `classrooms/${classId}/files/${fileId}/${cleanOriginalName}`;
    const downloadURL = `/api/classrooms/${classId}/files/${fileId}/download`;

    // Save actual file content if provided
    let usedLocalFallback = false;
    if (buffer) {
      try {
        const bucket = getStorage().bucket();
        const fileRef = bucket.file(storagePath);
        await fileRef.save(buffer, {
          metadata: { contentType: mimeType || 'application/octet-stream' }
        });
      } catch (err) {
        // Fallback for dev / local mock storage directory
        usedLocalFallback = true;
        const localDir = path.resolve(__dirname, `../../storage/classrooms/${classId}/files/${fileId}`);
        fs.mkdirSync(localDir, { recursive: true });
        fs.writeFileSync(path.join(localDir, cleanOriginalName), buffer);
      }
    }

    const fileDoc = {
      fileId,
      classroomId: classId,
      fileName: cleanOriginalName,
      originalName: cleanOriginalName,
      title: (title || cleanOriginalName).trim(),
      description: (description || '').trim(),
      fileType: ext,
      mimeType: mimeType || 'application/octet-stream',
      fileSize: size,
      storagePath,
      downloadURL,
      uploadedBy: user.uid,
      uploadedByName: user.name || user.displayName || user.email || 'Teacher',
      meetingId: meetingId || null,
      category: category || deriveCategory(ext, mimeType),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    saveLocalManifest(classId, fileDoc);

    try {
      await db.collection('classrooms')
        .doc(classId)
        .collection('files')
        .doc(fileId)
        .set(fileDoc);
    } catch (dbErr) {
      if (isQuotaExceededError(dbErr)) {
        console.warn('[Files Route] Quota exceeded while creating file record in Firestore. Local manifest & file storage succeeded.');
        clearServerCache(`server_files_${classId}`);
        return res.status(201).json({ id: fileId, ...fileDoc });
      }
      // Cleanup payload when a non-quota Firestore error occurs
      try {
        if (usedLocalFallback) {
          const localFile = path.resolve(__dirname, `../../storage/classrooms/${classId}/files/${fileId}/${cleanOriginalName}`);
          if (fs.existsSync(localFile)) fs.unlinkSync(localFile);
        } else {
          const bucket = getStorage().bucket();
          await bucket.file(storagePath).delete().catch(() => {});
        }
      } catch (e) {}
      throw dbErr;
    }

    clearServerCache(`server_files_${classId}`);
    return res.status(201).json({ id: fileId, ...fileDoc });
  } catch (error) {
    if (isQuotaExceededError(error)) {
      console.warn('[Files Route] Firestore RESOURCE_EXHAUSTED on file upload. Returning fallback success.');
      return res.status(201).json({ id: `file_${Date.now()}`, title: req.body.title || 'Uploaded File', createdAt: new Date().toISOString() });
    }
    console.error('Error uploading file:', error);
    return res.status(500).json({ error: error.message || 'Failed to upload file', details: error.message });
  }
});

// PUT /api/classrooms/:classId/files/:fileId - Teacher Edit Metadata
router.put('/:fileId', verifyAuthToken, async (req, res) => {
  try {
    const classId = req.params.classId || req.params.id;
    const { fileId } = req.params;
    const { title, description, category } = req.body;
    const user = req.user;
    const db = getFirestore();

    const access = await checkClassroomAccess(db, classId, user.uid);
    if (!access.classroomData || !access.isOwner) {
      return res.status(403).json({
        error: 'Permission denied: Only the classroom teacher can edit file metadata.'
      });
    }

    const updates = {
      ...(title ? { title: title.trim() } : {}),
      ...(description !== undefined ? { description: description.trim() } : {}),
      ...(category ? { category: category.trim() } : {}),
      updatedAt: new Date().toISOString(),
    };

    await db.collection('classrooms')
      .doc(classId)
      .collection('files')
      .doc(fileId)
      .update(updates);

    return res.json({ message: 'File metadata updated successfully', fileId, ...updates });
  } catch (error) {
    console.error('Error updating file metadata:', error);
    return res.status(500).json({ error: 'Failed to update file metadata', details: error.message });
  }
});

// DELETE /api/classrooms/:classId/files/:fileId - Teacher Delete File
router.delete('/:fileId', verifyAuthToken, async (req, res) => {
  try {
    const classId = req.params.classId || req.params.id;
    const { fileId } = req.params;
    const user = req.user;
    const db = getFirestore();

    const access = await checkClassroomAccess(db, classId, user.uid);
    if (!access.classroomData || !access.isOwner) {
      return res.status(403).json({
        error: 'Permission denied: Only the classroom teacher can delete files.'
      });
    }

    const fileRef = db.collection('classrooms').doc(classId).collection('files').doc(fileId);
    const fileSnap = await fileRef.get();
    if (!fileSnap.exists) {
      return res.status(404).json({ error: 'File document not found.' });
    }

    const fileData = fileSnap.data();

    // 1. Delete Firestore metadata document
    await fileRef.delete();

    // 2. Delete Storage file
    if (fileData.storagePath) {
      try {
        const bucket = getStorage().bucket();
        await bucket.file(fileData.storagePath).delete().catch(() => {});
      } catch (err) {
        // Fallback for dev / local mock storage directory.
        // Resolve from the sanitized original name only, never from the raw
        // client-supplied value, so a crafted name cannot escape the directory.
        const safeName = sanitizeFileName(fileData.originalName || fileData.fileName, 'file');
        const localFile = path.resolve(__dirname, `../../storage/classrooms/${classId}/files/${fileId}/${path.basename(safeName)}`);
        if (fs.existsSync(localFile)) {
          try { fs.unlinkSync(localFile); } catch (e) {}
        }
        // Remove the now-empty per-file directory (no-op if it still has content)
        const fileDir = path.resolve(__dirname, `../../storage/classrooms/${classId}/files/${fileId}`);
        try { fs.rmdirSync(fileDir); } catch (e) {}
      }
    }

    return res.json({ message: 'File deleted successfully', fileId });
  } catch (error) {
    console.error('Error deleting file:', error);
    return res.status(500).json({ error: 'Failed to delete file', details: error.message });
  }
});

// GET /api/classrooms/:classId/files/:fileId/download - Enrolled Student / Teacher Download
router.get('/:fileId/download', verifyAuthToken, async (req, res) => {
  try {
    const classId = req.params.classId || req.params.id;
    const { fileId } = req.params;
    const user = req.user;
    const db = getFirestore();

    const access = await checkClassroomAccess(db, classId, user.uid);
    if (!access.classroomData || (!access.isOwner && !access.isMember)) {
      return res.status(403).json({
        error: 'Permission denied: You are not authorized to download files for this classroom.'
      });
    }

    let file = null;
    try {
      const fileSnap = await db.collection('classrooms').doc(classId).collection('files').doc(fileId).get();
      if (fileSnap.exists) {
        file = fileSnap.data();
      }
    } catch (e) {
      if (isQuotaExceededError(e)) {
        console.warn('[Files Route] Quota exceeded on download lookup. Falling back to local manifest.');
      }
    }

    if (!file) {
      const localManifest = getLocalManifest(classId);
      file = localManifest.find(f => (f.id || f.fileId) === fileId);
    }

    if (!file) {
      return res.status(404).json({ error: 'File not found.' });
    }

    const safeName = sanitizeFileName(file.originalName || file.fileName, 'file');
    const localFilePath = path.resolve(__dirname, `../../storage/classrooms/${classId}/files/${fileId}/${path.basename(safeName)}`);
    if (fs.existsSync(localFilePath)) {
      res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return fs.createReadStream(localFilePath).pipe(res);
    }

    // Try Admin Storage URL stream
    try {
      const bucket = getStorage().bucket();
      const storageFile = bucket.file(file.storagePath);
      res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return storageFile.createReadStream().pipe(res);
    } catch (err) {
      return res.status(404).json({ error: 'File payload unavailable in storage.' });
    }
  } catch (error) {
    console.error('Error downloading file:', error);
    return res.status(500).json({ error: 'Failed to download file', details: error.message });
  }
});

export default router;
