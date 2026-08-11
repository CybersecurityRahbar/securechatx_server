const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Pool } = require('pg');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// ==================== الإعدادات من متغيرات البيئة ====================
const PORT = process.env.PORT || 8080;
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://your-app.pxxl.pro';
const DATABASE_URL = process.env.DATABASE_URL; // ستُضبط من Pxxl

if (!DATABASE_URL) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

// ==================== اتصال PostgreSQL ====================
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: false // ضروري لـ Pxxl
});

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        identity_public TEXT NOT NULL,
        signed_public TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS one_time_prekeys (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        public_key TEXT UNIQUE NOT NULL,
        is_used BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(user_id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS file_metadata (
        file_id TEXT PRIMARY KEY,
        sender_id TEXT,
        recipient_id TEXT,
        file_path TEXT,
        expires_at BIGINT
      )
    `);
    console.log('Database tables created/verified');
  } catch (err) {
    console.error('Database initialization error:', err);
    process.exit(1);
  }
})();

// ==================== إعداد Express ====================
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// مجلد الملفات (سيتم حفظها في نظام الملفات المؤقت، لكن Pxxl توفر تخزيناً دائماً عبر الحجم المرفق)
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname)),
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

// ==================== REST API ====================

// 1. رفع المفاتيح المسبقة
app.post('/api/prekeys', async (req, res) => {
  const { userId, identityPublic, signedPreKeyPublic, oneTimePreKeys } = req.body;
  if (!userId || !identityPublic || !signedPreKeyPublic) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const oneTimeList = oneTimePreKeys ? oneTimePreKeys.split(',') : [];

  try {
    // إدراج أو تحديث المستخدم
    await pool.query(
      `INSERT INTO users (user_id, identity_public, signed_public) VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET identity_public = EXCLUDED.identity_public, signed_public = EXCLUDED.signed_public`,
      [userId, identityPublic, signedPreKeyPublic]
    );

    // إدراج مفاتيح One-Time (تجاهل المكرر)
    for (const key of oneTimeList) {
      if (key.trim()) {
        await pool.query(
          `INSERT INTO one_time_prekeys (user_id, public_key) VALUES ($1, $2) ON CONFLICT (public_key) DO NOTHING`,
          [userId, key.trim()]
        );
      }
    }

    res.json({ status: 'success', message: 'Prekeys uploaded' });
  } catch (err) {
    console.error('DB error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// 2. جلب المفاتيح المسبقة لمستخدم
app.get('/api/prekeys/:userId', async (req, res) => {
  const userId = req.params.userId;

  try {
    const userResult = await pool.query(
      `SELECT identity_public, signed_public FROM users WHERE user_id = $1`,
      [userId]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const user = userResult.rows[0];

    // البحث عن مفتاح One-Time غير مستخدم
    const otResult = await pool.query(
      `SELECT public_key FROM one_time_prekeys WHERE user_id = $1 AND is_used = FALSE ORDER BY id LIMIT 1`,
      [userId]
    );

    let oneTimePublic = null;
    if (otResult.rows.length > 0) {
      oneTimePublic = otResult.rows[0].public_key;
      // تحديث إلى مستخدم
      await pool.query(
        `UPDATE one_time_prekeys SET is_used = TRUE WHERE public_key = $1`,
        [oneTimePublic]
      );
    } else {
      // Fallback (نادر)
      console.warn(`No unused one-time prekey for ${userId}, providing fallback`);
      const fallback = await pool.query(
        `SELECT public_key FROM one_time_prekeys WHERE user_id = $1 ORDER BY id LIMIT 1`,
        [userId]
      );
      if (fallback.rows.length > 0) oneTimePublic = fallback.rows[0].public_key;
      else oneTimePublic = 'fallback_key';
    }

    res.json({
      identityPublic: user.identity_public,
      signedPreKeyPublic: user.signed_public,
      oneTimePreKeyPublic: oneTimePublic
    });
  } catch (err) {
    console.error('Error fetching prekeys:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// 3. رفع الملفات
app.post('/files', upload.single('file'), async (req, res) => {
  const recipientId = req.body.recipientId;
  const file = req.file;
  if (!recipientId || !file) {
    return res.status(400).json({ error: 'Missing file or recipient' });
  }

  const fileId = uuidv4();
  const downloadUrl = `${PUBLIC_URL}/files/${fileId}`;
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;

  try {
    await pool.query(
      `INSERT INTO file_metadata (file_id, sender_id, recipient_id, file_path, expires_at) VALUES ($1, $2, $3, $4, $5)`,
      [fileId, 'system', recipientId, file.path, expiresAt]
    );
    res.json({ url: downloadUrl, size: file.size });
  } catch (err) {
    console.error('File metadata error:', err);
    res.status(500).json({ error: 'Failed to save file metadata' });
  }
});

// 4. تحميل الملفات
app.get('/files/:fileId', async (req, res) => {
  const fileId = req.params.fileId;
  try {
    const result = await pool.query(`SELECT file_path FROM file_metadata WHERE file_id = $1`, [fileId]);
    if (result.rows.length === 0) return res.status(404).send('File not found');
    const filePath = result.rows[0].file_path;
    if (fs.existsSync(filePath)) {
      res.sendFile(path.resolve(filePath));
    } else {
      res.status(404).send('File not found on disk');
    }
  } catch (err) {
    res.status(500).send('Server error');
  }
});

// 5. فحص الصحة
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ==================== WebSocket Server ====================
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

const clients = new Map(); // userId -> { ws, sessionKey, deviceId }

wss.on('connection', (ws) => {
  console.log('New WebSocket connection');
  let authenticatedUserId = null;
  let sessionKey = null;

  ws.on('message', async (data) => {
    try {
      if (typeof data === 'string') {
        const parsed = JSON.parse(data);
        if (parsed.type === 'auth') {
          const { userId, deviceId } = parsed;
          if (!userId || !deviceId) {
            ws.send(JSON.stringify({ type: 'auth_response', status: 'error', message: 'Invalid credentials' }));
            ws.close();
            return;
          }
          sessionKey = crypto.randomBytes(32);
          authenticatedUserId = userId;
          clients.set(userId, { ws, sessionKey, deviceId });
          ws.send(JSON.stringify({
            type: 'auth_response',
            status: 'success',
            sessionKey: sessionKey.toString('base64')
          }));
          console.log(`User ${userId} authenticated`);
          return;
        }
        if (parsed.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
          return;
        }
        return;
      }

      // Binary messages (encrypted)
      if (data instanceof Buffer) {
        if (!authenticatedUserId || !sessionKey) {
          ws.close(1008, 'Unauthorized');
          return;
        }
        const decrypted = decryptAESGCM(data, sessionKey);
        if (!decrypted) {
          console.warn('Decryption failed for', authenticatedUserId);
          return;
        }
        const payload = JSON.parse(decrypted.toString('utf8'));
        const { type, messageId, conversationId, recipientId } = payload;

        let targetUserId = recipientId || conversationId;
        if (!targetUserId && conversationId && conversationId.includes('_')) {
          const parts = conversationId.split('_');
          targetUserId = parts[0] === authenticatedUserId ? parts[1] : parts[0];
        }
        if (!targetUserId) {
          console.warn('Cannot determine recipient');
          return;
        }

        const recipientClient = clients.get(targetUserId);
        if (recipientClient && recipientClient.ws.readyState === WebSocket.OPEN) {
          const encryptedForRecipient = encryptAESGCM(Buffer.from(JSON.stringify(payload)), recipientClient.sessionKey);
          if (encryptedForRecipient) {
            recipientClient.ws.send(encryptedForRecipient);
          }
        } else {
          console.log(`Recipient ${targetUserId} offline, message dropped`);
        }
      }
    } catch (e) {
      console.error('Error handling message:', e);
    }
  });

  ws.on('close', () => {
    if (authenticatedUserId) clients.delete(authenticatedUserId);
    console.log(`User ${authenticatedUserId} disconnected`);
  });
});

// ==================== دوال التشفير ====================
function encryptAESGCM(plaintext, key) {
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, encrypted, tag]);
  } catch (e) {
    console.error('Encryption error:', e);
    return null;
  }
}

function decryptAESGCM(ciphertext, key) {
  try {
    if (ciphertext.length < 28) return null;
    const iv = ciphertext.subarray(0, 12);
    const tag = ciphertext.subarray(ciphertext.length - 16);
    const encrypted = ciphertext.subarray(12, ciphertext.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch (e) {
    console.error('Decryption error:', e);
    return null;
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Public URL: ${PUBLIC_URL}`);
});

// تنظيف الملفات القديمة كل ساعة
setInterval(async () => {
  const now = Date.now();
  try {
    const result = await pool.query(`SELECT file_id, file_path FROM file_metadata WHERE expires_at < $1`, [now]);
    for (const row of result.rows) {
      try { if (fs.existsSync(row.file_path)) fs.unlinkSync(row.file_path); } catch (_) {}
    }
    await pool.query(`DELETE FROM file_metadata WHERE expires_at < $1`, [now]);
  } catch (_) {}
}, 60 * 60 * 1000);
