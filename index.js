
const express = require('express');
const http = require('http');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: '*',
        credentials: false
    },
    transports: ['websocket', 'polling'],
    connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000,
        skipMiddlewares: false
    }
});
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'wallet_secret_key_2026';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const recentlyNotifiedTransfers = new Map();
const PUBLIC_ACCOUNT_PREFIX = 700000000;
const PUBLIC_ACCOUNT_MAX = 799999999;
const PUBLIC_ACCOUNT_PATTERN = /^7\d{8}$/;
const CURRENCY_ACCOUNT_OFFSETS = { USD: 1, YER: 2, SAR: 3 };
const CURRENCY_COLUMNS = { USD: 'balance_usd', YER: 'balance_yer', SAR: 'balance_sar' };
const TOTP_ISSUER = 'المحفظة الذكية';
let wetaTokenCache = null;

function publicAccountNumbersFor(accountId) {
    const numericAccountId = Number(accountId);
    if (!Number.isInteger(numericAccountId) || numericAccountId < 1) {
        return { USD: null, YER: null, SAR: null };
    }

    const base = PUBLIC_ACCOUNT_PREFIX + ((numericAccountId - 1) * 3);
    if (base + Math.max(...Object.values(CURRENCY_ACCOUNT_OFFSETS)) > PUBLIC_ACCOUNT_MAX) {
        return { USD: null, YER: null, SAR: null };
    }

    return Object.fromEntries(
        Object.entries(CURRENCY_ACCOUNT_OFFSETS).map(([currency, offset]) => [
            currency,
            String(base + offset),
        ])
    );
}

function internalAccountIdFromPublic(value) {
    const normalized = String(value ?? '').trim();
    if (!PUBLIC_ACCOUNT_PATTERN.test(normalized)) return null;

    const publicNumber = Number(normalized);
    if (publicNumber <= PUBLIC_ACCOUNT_PREFIX || publicNumber > PUBLIC_ACCOUNT_MAX) return null;

    return Math.floor((publicNumber - (PUBLIC_ACCOUNT_PREFIX + 1)) / 3) + 1;
}

function isValidPublicAccountNumber(value) {
    return internalAccountIdFromPublic(value) !== null;
}

function encodeBase32(buffer) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0;
    let value = 0;
    let output = '';

    for (const byte of buffer) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            output += alphabet[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }

    if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
    return output;
}

function decodeBase32(value) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const normalized = String(value || '').toUpperCase().replace(/=+$/g, '').replace(/[^A-Z2-7]/g, '');
    let bits = 0;
    let buffer = 0;
    const bytes = [];

    for (const character of normalized) {
        const index = alphabet.indexOf(character);
        if (index < 0) throw new Error('رمز المصادقة غير صالح');
        buffer = (buffer << 5) | index;
        bits += 5;
        if (bits >= 8) {
            bytes.push((buffer >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }

    return Buffer.from(bytes);
}

function encryptionKey() {
    if (!SESSION_SECRET) throw new Error('مفتاح الجلسة غير مضبوط؛ إعداد المصادقة الثنائية غير متاح');
    return crypto.createHash('sha256').update(SESSION_SECRET).digest();
}

function encryptTotpSecret(secret) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
}

function decryptTotpSecret(payload) {
    const [ivValue, tagValue, encryptedValue] = String(payload || '').split('.');
    if (!ivValue || !tagValue || !encryptedValue) throw new Error('بيانات المصادقة الثنائية غير صالحة');
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivValue, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
    return Buffer.concat([
        decipher.update(Buffer.from(encryptedValue, 'base64url')),
        decipher.final(),
    ]).toString('utf8');
}

function totpCounter(secret, code, lastCounter = -1) {
    const normalizedCode = String(code || '').trim();
    if (!/^\d{6}$/.test(normalizedCode)) return null;
    const currentCounter = Math.floor(Date.now() / 30000);
    const secretBytes = decodeBase32(secret);

    for (const offset of [-1, 0, 1]) {
        const counter = currentCounter + offset;
        if (counter <= Number(lastCounter)) continue;
        const counterBuffer = Buffer.alloc(8);
        counterBuffer.writeBigUInt64BE(BigInt(counter));
        const digest = crypto.createHmac('sha1', secretBytes).update(counterBuffer).digest();
        const index = digest[digest.length - 1] & 0x0f;
        const binary = ((digest[index] & 0x7f) << 24)
            | ((digest[index + 1] & 0xff) << 16)
            | ((digest[index + 2] & 0xff) << 8)
            | (digest[index + 3] & 0xff);
        const expected = String(binary % 1000000).padStart(6, '0');
        if (crypto.timingSafeEqual(Buffer.from(normalizedCode), Buffer.from(expected))) return counter;
    }

    return null;
}

async function consumeTotpCode(client, userId, code) {
    const result = await client.query(
        'SELECT totp_secret, totp_enabled, totp_last_counter FROM users WHERE id = $1 FOR UPDATE',
        [userId]
    );
    const user = result.rows[0];
    if (!user?.totp_enabled) return { required: false, valid: true };
    if (!user.totp_secret) return { required: true, valid: false };

    try {
        const secret = decryptTotpSecret(user.totp_secret);
        const counter = totpCounter(secret, code, user.totp_last_counter);
        if (counter === null) return { required: true, valid: false };
        await client.query('UPDATE users SET totp_last_counter = $1 WHERE id = $2', [counter, userId]);
        return { required: true, valid: true };
    } catch {
        return { required: true, valid: false };
    }
}

function securityEvent(req, eventType, detail = '') {
    return pool.query(
        `INSERT INTO security_events (user_id, event_type, detail, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.user?.id || null, eventType, detail, req.ip || null, req.get('user-agent') || null]
    );
}

function receiptSignature(tx) {
    if (!SESSION_SECRET) return null;
    const signedValues = [
        tx.id,
        tx.sender_account_id ?? '',
        tx.receiver_account_id ?? '',
        String(tx.amount),
        tx.currency,
        tx.created_at instanceof Date ? tx.created_at.toISOString() : String(tx.created_at),
        tx.type || '',
        tx.status || '',
        tx.service_type || '',
        tx.service_number || '',
        tx.provider_reference || '',
    ];
    return crypto.createHmac('sha256', SESSION_SECRET).update(signedValues.join('|')).digest('hex');
}

async function getWetaAccessToken() {
    const username = process.env.WETA_USERNAME;
    const password = process.env.WETA_PASSWORD;
    if (!username || !password) {
        const error = new Error('ربط Weta غير مكتمل؛ أضف بيانات حساب المزود من مساحة الأسرار');
        error.status = 503;
        throw error;
    }

    if (wetaTokenCache && wetaTokenCache.expiresAt > Date.now() + 30000) return wetaTokenCache.token;

    const response = await fetch('https://yemenairtime.com/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
        signal: AbortSignal.timeout(15000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.token) {
        const error = new Error('تعذر تسجيل الدخول إلى مزود Weta');
        error.status = response.status >= 500 ? 502 : 502;
        throw error;
    }

    const expiry = Number(body.exp_date) * 1000;
    wetaTokenCache = {
        token: body.token,
        expiresAt: Number.isFinite(expiry) && expiry > Date.now() ? expiry : Date.now() + 20 * 60 * 1000,
    };
    return wetaTokenCache.token;
}

async function wetaPost(endpoint, body) {
    const token = await getWetaAccessToken();
    const response = await fetch(`https://yemenairtime.com/api/${endpoint}`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(payload.description || payload.message || 'رفض مزود Weta الطلب');
        error.status = response.status;
        error.providerResponse = payload;
        throw error;
    }
    return payload;
}

function emitTransferNotifications({ transactionId, receiverUserId, senderUserId, receiverNotification, senderNotification }) {
    const key = String(transactionId);
    const now = Date.now();
    const previousNotification = recentlyNotifiedTransfers.get(key);

    if (previousNotification && now - previousNotification < 2 * 60 * 1000) {
        return false;
    }

    recentlyNotifiedTransfers.set(key, now);
    if (recentlyNotifiedTransfers.size > 1000) {
        for (const [transferId, notifiedAt] of recentlyNotifiedTransfers) {
            if (now - notifiedAt > 2 * 60 * 1000) recentlyNotifiedTransfers.delete(transferId);
        }
    }

    io.to(String(receiverUserId)).emit('transfer:received', receiverNotification);
    io.to(String(senderUserId)).emit('transfer:sent', senderNotification);
    return true;
}

// 1. الاتصال بقاعدة البيانات السحابية (PostgreSQL)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ خطأ في الاتصال بقاعدة البيانات:', err.message);
    } else {
        console.log('✅ تم الاتصال بقاعدة البيانات السحابية بنجاح!');
        release();
    }
});
pool.query(`
    CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255),
        username VARCHAR(255) UNIQUE,
        email VARCHAR(255) UNIQUE,
        password VARCHAR(255),
        pin VARCHAR(10),
        totp_secret TEXT,
        totp_pending_secret TEXT,
        totp_enabled BOOLEAN DEFAULT FALSE,
        totp_last_counter BIGINT DEFAULT -1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS accounts (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        balance_yer NUMERIC(15, 2) DEFAULT 0,
        balance_sar NUMERIC(15, 2) DEFAULT 0,
        balance_usd NUMERIC(15, 2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS app_sessions (
        token_id VARCHAR(255) PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NOT NULL,
        revoked_at TIMESTAMP,
        ip_address VARCHAR(45),
        user_agent TEXT
    );

    CREATE TABLE IF NOT EXISTS security_events (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        event_type VARCHAR(100) NOT NULL,
        detail TEXT,
        ip_address VARCHAR(45),
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
`).then(() => console.log('✅ تم إنشاء الجداول بنجاح'))
  .catch(err => console.error('❌ خطأ في إنشاء الجداول:', err.message));

// 2. الوسائط (Middleware)
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// التحقق من توكين الجلسة (JWT)
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, error: 'يرجى تسجيل الدخول أولاً' });

    jwt.verify(token, JWT_SECRET, async (err, user) => {
        if (err) return res.status(403).json({ success: false, error: 'جلسة التواجد انتهت، أعد الدخول' });
        try {
            if (user.jti) {
                const session = await pool.query(
                    `UPDATE app_sessions SET last_seen_at = NOW()
                     WHERE token_id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > NOW()
                     RETURNING token_id`,
                    [user.jti, user.id]
                );
                if (session.rows.length === 0) {
                    return res.status(401).json({ success: false, error: 'تم إنهاء هذه الجلسة؛ سجّل الدخول مجددًا' });
                }
            }
            req.user = user;
            next();
        } catch (sessionError) {
            console.error('❌ تعذر التحقق من الجلسة:', sessionError.message);
            res.status(503).json({ success: false, error: 'تعذر التحقق من أمان الجلسة' });
        }
    });
};

// ربط كل جلسة Socket.IO بغرفة الحساب الخاصة بها لإرسال الإشعارات الآمنة
io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('غير مصرح بالاتصال'));

    jwt.verify(token, JWT_SECRET, async (err, user) => {
        if (err || !user?.id) return next(new Error('جلسة غير صالحة'));
        if (user.jti) {
            try {
                const session = await pool.query(
                    `SELECT token_id FROM app_sessions
                     WHERE token_id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > NOW()`,
                    [user.jti, user.id]
                );
                if (session.rows.length === 0) return next(new Error('تم إنهاء هذه الجلسة'));
            } catch {
                return next(new Error('تعذر التحقق من الجلسة'));
            }
        }
        socket.user = user;
        next();
    });
});

io.on('connection', (socket) => {
    const userId = socket.user.id;
    const accountId = socket.user.accountId;

    if (userId) socket.join(String(userId));
    if (userId) socket.join(`user:${userId}`);
    if (accountId) socket.join(`account:${accountId}`);

    socket.emit('notifications:ready', {
        userId,
        accountId,
        recovered: socket.recovered
    });

    socket.on('send_transfer', async (payload = {}, acknowledge) => {
        try {
            const transactionId = Number(payload.transactionId);
            if (!Number.isInteger(transactionId) || transactionId <= 0) {
                acknowledge?.({ success: false, error: 'رقم الحوالة غير صالح' });
                return;
            }

            const result = await pool.query(
                `SELECT t.id, t.amount, t.currency,
                        sender_user.id as sender_user_id, sender_user.name as sender_name,
                        receiver_user.id as receiver_user_id, receiver_user.name as receiver_name
                 FROM transactions t
                 JOIN accounts sender_account ON sender_account.id = t.sender_account_id
                 JOIN users sender_user ON sender_user.id = sender_account.user_id
                 JOIN accounts receiver_account ON receiver_account.id = t.receiver_account_id
                 JOIN users receiver_user ON receiver_user.id = receiver_account.user_id
                 WHERE t.id = $1 AND sender_user.id = $2`,
                [transactionId, socket.user.id]
            );

            if (result.rows.length === 0) {
                acknowledge?.({ success: false, error: 'الحوالة غير موجودة أو غير مصرح بها' });
                return;
            }

            const transfer = result.rows[0];
            const receiverName = transfer.receiver_name || 'المستلم';
            const senderName = transfer.sender_name || 'مشترك';
            const receiverNotification = {
                type: 'transfer_received',
                transactionId: transfer.id,
                amount: Number(transfer.amount),
                currency: transfer.currency,
                senderName,
                receiverName,
                message: `تم استلام حوالة جديدة بقيمة ${transfer.amount} ${transfer.currency} من ${senderName}`,
                createdAt: new Date().toISOString()
            };
            const senderNotification = {
                type: 'transfer_sent',
                transactionId: transfer.id,
                amount: Number(transfer.amount),
                currency: transfer.currency,
                senderName,
                receiverName,
                message: `تم إرسال المبلغ بنجاح إلى ${receiverName}`,
                createdAt: receiverNotification.createdAt
            };

            const notified = emitTransferNotifications({
                transactionId: transfer.id,
                receiverUserId: transfer.receiver_user_id,
                senderUserId: transfer.sender_user_id,
                receiverNotification,
                senderNotification
            });
            acknowledge?.({ success: true, notified });
        } catch (err) {
            console.error('❌ خطأ إرسال إشعار الحوالة:', err.message);
            acknowledge?.({ success: false, error: 'تعذر إرسال إشعار الحوالة' });
        }
    });
});

// 3. المسارات (API Endpoints)

// [أ] إنشاء حساب جديد
app.post('/api/register', async (req, res) => {
    const { name, username, email, password, pin } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const userEmail = email || `${username}@wallet.com`;

        const checkUser = await client.query(
            'SELECT id FROM users WHERE username = $1 OR email = $2',
            [username, userEmail]
        );

        if (checkUser.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, error: 'اسم المستخدم أو البريد مستخدم بالفعل' });
        }

        const userRes = await client.query(
            'INSERT INTO users (name, username, email, password, pin) VALUES ($1, $2, $3, $4, $5) RETURNING id',
            [name, username, userEmail, password, pin]
        );
        const userId = userRes.rows[0].id;

        await client.query(
            'INSERT INTO accounts (user_id, balance_yer, balance_sar, balance_usd) VALUES ($1, 50000, 1000, 300)',
            [userId]
        );

        await client.query('COMMIT');
        res.json({ success: true, message: 'تم إنشاء الحساب بنجاح' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ خطأ في إنشاء الحساب:', err.message);
        res.status(500).json({ success: false, error: 'حدث خطأ أثناء إنشاء الحساب: ' + err.message });
    } finally {
        client.release();
    }
});

// [ب] تسجيل الدخول
app.post('/api/login', async (req, res) => {
    const { loginInput, password } = req.body;

    try {
        const query = `
            SELECT u.*, a.id as account_id 
            FROM users u 
            JOIN accounts a ON u.id = a.user_id 
            WHERE u.username = $1
               OR u.email = $1
               OR a.id::text = $1
               OR a.id = $2
        `;
        const result = await pool.query(query, [loginInput, internalAccountIdFromPublic(loginInput)]);

        if (result.rows.length === 0) {
            return res.status(400).json({ success: false, error: 'بيانات الدخول غير صحيحة' });
        }

        const user = result.rows[0];

        if (user.password !== password) {
            return res.status(400).json({ success: false, error: 'كلمة المرور غير صحيحة' });
        }

        if (user.totp_enabled) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const verification = await consumeTotpCode(client, user.id, req.body.otp);
                if (!verification.valid) {
                    await client.query('ROLLBACK');
                    return res.status(401).json({ success: false, requiresOtp: true, error: 'رمز التحقق الثنائي غير صحيح' });
                }
                await client.query('COMMIT');
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            } finally {
                client.release();
            }
        }

        const sessionId = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        await pool.query(
            `INSERT INTO app_sessions (token_id, user_id, expires_at, ip_address, user_agent)
             VALUES ($1, $2, $3, $4, $5)`,
            [sessionId, user.id, expiresAt, req.ip || null, req.get('user-agent') || null]
        );

        const token = jwt.sign(
            { id: user.id, username: user.username, accountId: user.account_id, jti: sessionId },
            JWT_SECRET,
            { expiresIn: '7d' }
        );

        await pool.query(
            `INSERT INTO security_events (user_id, event_type, detail, ip_address, user_agent)
             VALUES ($1, 'LOGIN', 'تسجيل دخول ناجح', $2, $3)`,
            [user.id, req.ip || null, req.get('user-agent') || null]
        );
        res.json({ success: true, token });
    } catch (err) {
        console.error('❌ خطأ تسجيل الدخول:', err.message);
        res.status(500).json({ success: false, error: 'خطأ في عملية تسجيل الدخول' });
    }
});

// [ج] جلب بيانات المستخدم الحالي ورصيده
app.get('/api/me', authenticateToken, async (req, res) => {
    try {
        const userRes = await pool.query(
            'SELECT id, name, username, email, totp_enabled FROM users WHERE id = $1',
            [req.user.id]
        );
        const accRes = await pool.query('SELECT id, balance_yer, balance_sar, balance_usd FROM accounts WHERE user_id = $1', [req.user.id]);

        if (userRes.rows.length === 0 || accRes.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'الحساب غير موجود' });
        }

        const account = accRes.rows[0];
        const accountNumbers = publicAccountNumbersFor(account.id);

        res.json({
            success: true,
            user: userRes.rows[0],
            account: {
                ...account,
                id: accountNumbers.YER,
                internal_id: account.id,
                account_numbers: accountNumbers,
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: 'خطأ في جلب البيانات' });
    }
});

app.post('/api/security/totp/setup', authenticateToken, async (req, res) => {
    try {
        const key = encryptionKey();
        void key;
        const userResult = await pool.query(
            'SELECT username, totp_enabled FROM users WHERE id = $1',
            [req.user.id]
        );
        const user = userResult.rows[0];
        if (!user) return res.status(404).json({ success: false, error: 'الحساب غير موجود' });
        if (user.totp_enabled) {
            return res.status(409).json({ success: false, error: 'المصادقة الثنائية مفعّلة بالفعل' });
        }

        const secret = encodeBase32(crypto.randomBytes(20));
        const encryptedSecret = encryptTotpSecret(secret);
        const label = encodeURIComponent(`${TOTP_ISSUER}:${user.username}`);
        const otpauthUrl = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(TOTP_ISSUER)}&algorithm=SHA1&digits=6&period=30`;
        const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { errorCorrectionLevel: 'M', margin: 1, width: 240 });

        await pool.query('UPDATE users SET totp_pending_secret = $1 WHERE id = $2', [encryptedSecret, req.user.id]);
        await securityEvent(req, 'TOTP_SETUP_STARTED', 'بدء إعداد المصادقة الثنائية');
        res.json({ success: true, secret, qrDataUrl });
    } catch (error) {
        res.status(error.message.includes('مفتاح الجلسة') ? 503 : 500).json({
            success: false,
            error: error.message || 'تعذر إعداد المصادقة الثنائية'
        });
    }
});

app.post('/api/security/totp/enable', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query(
            'SELECT totp_pending_secret, totp_enabled FROM users WHERE id = $1 FOR UPDATE',
            [req.user.id]
        );
        const user = result.rows[0];
        if (!user || !user.totp_pending_secret) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, error: 'ابدأ إعداد المصادقة الثنائية أولاً' });
        }
        if (user.totp_enabled) {
            await client.query('ROLLBACK');
            return res.status(409).json({ success: false, error: 'المصادقة الثنائية مفعّلة بالفعل' });
        }

        const secret = decryptTotpSecret(user.totp_pending_secret);
        const counter = totpCounter(secret, req.body.code, -1);
        if (counter === null) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, error: 'رمز التحقق غير صحيح أو منتهي' });
        }

        await client.query(
            `UPDATE users
             SET totp_secret = totp_pending_secret, totp_pending_secret = NULL,
                 totp_enabled = TRUE, totp_last_counter = $1
             WHERE id = $2`,
            [counter, req.user.id]
        );
        await client.query(
            `INSERT INTO security_events (user_id, event_type, detail, ip_address, user_agent)
             VALUES ($1, 'TOTP_ENABLED', 'تم تفعيل المصادقة الثنائية', $2, $3)`,
            [req.user.id, req.ip || null, req.get('user-agent') || null]
        );
        await client.query('COMMIT');
        res.json({ success: true, message: 'تم تفعيل المصادقة الثنائية' });
    } catch (error) {
        await client.query('ROLLBACK');
        res.status(500).json({ success: false, error: 'تعذر تفعيل المصادقة الثنائية' });
    } finally {
        client.release();
    }
});

app.post('/api/security/totp/disable', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const auth = await client.query(
            `SELECT password, totp_enabled FROM users WHERE id = $1 FOR UPDATE`,
            [req.user.id]
        );
        const user = auth.rows[0];
        if (!user || user.password !== req.body.password) {
            await client.query('ROLLBACK');
            return res.status(401).json({ success: false, error: 'كلمة المرور غير صحيحة' });
        }
        const verification = await consumeTotpCode(client, req.user.id, req.body.code);
        if (!verification.required || !verification.valid) {
            await client.query('ROLLBACK');
            return res.status(401).json({ success: false, error: 'رمز التحقق الثنائي غير صحيح' });
        }
        await client.query(
            `UPDATE users SET totp_secret = NULL, totp_pending_secret = NULL,
             totp_enabled = FALSE, totp_last_counter = -1 WHERE id = $1`,
            [req.user.id]
        );
        await client.query(
            `INSERT INTO security_events (user_id, event_type, detail, ip_address, user_agent)
             VALUES ($1, 'TOTP_DISABLED', 'تم إيقاف المصادقة الثنائية', $2, $3)`,
            [req.user.id, req.ip || null, req.get('user-agent') || null]
        );
        await client.query('COMMIT');
        res.json({ success: true, message: 'تم إيقاف المصادقة الثنائية' });
    } catch {
        await client.query('ROLLBACK');
        res.status(500).json({ success: false, error: 'تعذر إيقاف المصادقة الثنائية' });
    } finally {
        client.release();
    }
});

app.get('/api/security/sessions', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT token_id, created_at, last_seen_at, expires_at, ip_address, user_agent
             FROM app_sessions
             WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
             ORDER BY last_seen_at DESC`,
            [req.user.id]
        );
        res.json({
            success: true,
            sessions: result.rows.map((session) => ({
                id: session.token_id,
                createdAt: session.created_at,
                lastSeenAt: session.last_seen_at,
                expiresAt: session.expires_at,
                ipAddress: session.ip_address,
                userAgent: session.user_agent,
                current: session.token_id === req.user.jti,
            })),
        });
    } catch {
        res.status(500).json({ success: false, error: 'تعذر جلب الجلسات' });
    }
});

app.delete('/api/security/sessions/:id', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `UPDATE app_sessions SET revoked_at = NOW()
             WHERE token_id = $1 AND user_id = $2 AND revoked_at IS NULL
             RETURNING token_id`,
            [req.params.id, req.user.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'الجلسة غير موجودة' });
        await securityEvent(req, 'SESSION_REVOKED', 'تم إنهاء جلسة من إعدادات الأمان');
        res.json({ success: true, message: 'تم إنهاء الجلسة' });
    } catch {
        res.status(500).json({ success: false, error: 'تعذر إنهاء الجلسة' });
    }
});

app.get('/api/security/activity', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT event_type, detail, ip_address, user_agent, created_at
             FROM security_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
            [req.user.id]
        );
        res.json({ success: true, events: result.rows });
    } catch {
        res.status(500).json({ success: false, error: 'تعذر جلب سجل الأمان' });
    }
});

app.post('/api/logout', authenticateToken, async (req, res) => {
    try {
        if (req.user.jti) {
            await pool.query(
                'UPDATE app_sessions SET revoked_at = NOW() WHERE token_id = $1 AND user_id = $2 AND revoked_at IS NULL',
                [req.user.jti, req.user.id]
            );
            await securityEvent(req, 'LOGOUT', 'تسجيل خروج');
        }
        res.json({ success: true });
    } catch {
        res.status(500).json({ success: false, error: 'تعذر إنهاء الجلسة' });
    }
});

app.get('/api/qr-code', authenticateToken, async (req, res) => {
    const payload = String(req.query.payload || '').trim();
    if (!payload || payload.length > 512) {
        return res.status(400).json({ success: false, error: 'بيانات QR غير صالحة' });
    }
    try {
        const dataUrl = await QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 1, width: 280 });
        res.json({ success: true, dataUrl });
    } catch {
        res.status(500).json({ success: false, error: 'تعذر إنشاء رمز QR' });
    }
});

// [ج-1] إنشاء أو تغيير رمز PIN بعد تأكيد بيانات الدخول
app.post('/api/settings/pin', authenticateToken, async (req, res) => {
    const { loginInput, password, newPin } = req.body;
    const normalizedLoginInput = String(loginInput || '').trim();
    const normalizedPin = String(newPin || '').trim();

    if (!normalizedLoginInput || !password || !/^\d{4}$/.test(normalizedPin)) {
        return res.status(400).json({ success: false, error: 'أدخل بيانات الدخول ورمز PIN مكوناً من 4 أرقام' });
    }

    try {
        const userResult = await pool.query(
            `SELECT u.id, u.password
             FROM users u
             JOIN accounts a ON a.user_id = u.id
             WHERE u.id = $1
               AND (u.username = $2 OR u.email = $2 OR a.id::text = $2 OR a.id = $3)
             LIMIT 1`,
            [req.user.id, normalizedLoginInput, internalAccountIdFromPublic(normalizedLoginInput)]
        );

        if (userResult.rows.length === 0 || userResult.rows[0].password !== password) {
            return res.status(401).json({ success: false, error: 'بيانات الدخول غير صحيحة' });
        }

        await pool.query('UPDATE users SET pin = $1 WHERE id = $2', [normalizedPin, req.user.id]);
        res.json({ success: true, message: 'تم تغيير رمز PIN بنجاح' });
    } catch (err) {
        console.error('❌ خطأ تغيير رمز PIN:', err.message);
        res.status(500).json({ success: false, error: 'تعذر تغيير رمز PIN' });
    }
});

// [د] الاستعلام عن اسم المستلم برقم الحساب
app.get('/api/account-info/:id', async (req, res) => {
    const internalAccountId = internalAccountIdFromPublic(req.params.id);
    if (internalAccountId === null) {
        return res.status(400).json({
            success: false,
            error: 'رقم الحساب يجب أن يتكون من 9 أرقام ويبدأ بالرقم 7'
        });
    }

    try {
        const query = `
            SELECT u.name 
            FROM accounts a 
            JOIN users u ON a.user_id = u.id 
            WHERE a.id = $1
        `;
        const result = await pool.query(query, [internalAccountId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'الحساب غير موجود' });
        }

        res.json({ success: true, receiver: { name: result.rows[0].name } });
    } catch (err) {
        res.status(500).json({ success: false, error: 'خطأ في البحث' });
    }
});

// [هـ] تنفيذ عملية التحويل المالي
app.post(['/api/transfer', '/api/transfers/send'], authenticateToken, async (req, res) => {
    const { receiverAccountId, currency, amount, pin, otp } = req.body;
    const receiverInternalAccountId = internalAccountIdFromPublic(receiverAccountId);

    if (!isValidPublicAccountNumber(receiverAccountId)) {
        return res.status(400).json({
            success: false,
            error: 'رقم حساب المستلم يجب أن يتكون من 9 أرقام ويبدأ بالرقم 7'
        });
    }

    const numAmount = parseFloat(amount);

    if (isNaN(numAmount) || numAmount <= 0) {
        return res.status(400).json({ success: false, error: 'المبلغ غير صالح' });
    }

    const columnMap = {
        'YER': 'balance_yer',
        'SAR': 'balance_sar',
        'USD': 'balance_usd'
    };

    const targetColumn = columnMap[currency];
    if (!targetColumn) {
        return res.status(400).json({ success: false, error: 'العملة غير مدعومة' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const senderRes = await client.query(
            `SELECT u.pin, u.name as sender_name, a.id as account_id, a.${targetColumn} as balance
             FROM users u JOIN accounts a ON u.id = a.user_id 
             WHERE u.id = $1 FOR UPDATE`, 
            [req.user.id]
        );

        const sender = senderRes.rows[0];
        if (!sender) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: 'الحساب غير موجود' });
        }

        if (sender.pin !== pin) {
            await client.query('ROLLBACK');
            return res.status(401).json({ success: false, error: 'رمز الـ PIN غير صحيح' });
        }

        const otpVerification = await consumeTotpCode(client, req.user.id, otp);
        if (!otpVerification.valid) {
            await client.query('ROLLBACK');
            return res.status(401).json({
                success: false,
                requiresOtp: otpVerification.required,
                error: 'رمز التحقق الثنائي غير صحيح',
            });
        }

        if (sender.account_id == receiverInternalAccountId) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, error: 'لا يمكنك التحويل لنفس الحساب' });
        }

        if (parseFloat(sender.balance) < numAmount) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, error: 'الرصيد غير كافٍ للتحويل' });
        }

        const receiverRes = await client.query(
            `SELECT a.id, u.id as receiver_user_id, u.name as receiver_name
             FROM accounts a JOIN users u ON u.id = a.user_id
             WHERE a.id = $1 FOR UPDATE`,
            [receiverInternalAccountId]
        );

        if (receiverRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: 'حساب المستلم غير موجود' });
        }

        await client.query(`UPDATE accounts SET ${targetColumn} = ${targetColumn} - $1 WHERE id = $2`, [numAmount, sender.account_id]);
        await client.query(`UPDATE accounts SET ${targetColumn} = ${targetColumn} + $1 WHERE id = $2`, [numAmount, receiverInternalAccountId]);

        const transactionRes = await client.query(
            `INSERT INTO transactions
             (sender_account_id, receiver_account_id, amount, currency, type, status)
             VALUES ($1, $2, $3, $4, 'TRANSFER', 'SUCCESS')
             RETURNING id, created_at, type, status`,
            [sender.account_id, receiverInternalAccountId, numAmount, currency]
        );

        await client.query('COMMIT');
        const receiverNotification = {
            type: 'transfer_received',
            transactionId: transactionRes.rows[0]?.id,
            amount: numAmount,
            currency,
            senderName: sender.sender_name || 'مشترك',
            receiverName: receiverRes.rows[0].receiver_name || 'المستلم',
            message: `تم استلام حوالة جديدة بقيمة ${numAmount} ${currency} من ${sender.sender_name || 'مشترك'}`,
            createdAt: new Date().toISOString()
        };
        const senderNotification = {
            type: 'transfer_sent',
            transactionId: transactionRes.rows[0]?.id,
            amount: numAmount,
            currency,
            senderName: sender.sender_name || 'مشترك',
            receiverName: receiverRes.rows[0].receiver_name || 'المستلم',
            message: `تم إرسال المبلغ بنجاح إلى ${receiverRes.rows[0].receiver_name || 'المستلم'}`,
            createdAt: receiverNotification.createdAt
        };

        emitTransferNotifications({
            transactionId: transactionRes.rows[0]?.id,
            receiverUserId: receiverRes.rows[0].receiver_user_id,
            senderUserId: req.user.id,
            receiverNotification,
            senderNotification
        });

        const receiptSignatureValue = receiptSignature({
            ...transactionRes.rows[0],
            sender_account_id: sender.account_id,
            receiver_account_id: receiverInternalAccountId,
            amount: numAmount,
            currency,
        });
        res.json({
            success: true,
            message: 'تمت الحوالة بنجاح',
            transaction: { ...receiverNotification, receiptSignature: receiptSignatureValue },
        });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ success: false, error: 'فشلت عملية التحويل: ' + err.message });
    } finally {
        client.release();
    }
});

// [و] شحن المحفظة عبر كروت الشحن (Vouchers)
app.post('/api/redeem-voucher', authenticateToken, async (req, res) => {
    const { code } = req.body;

    if (!code) {
        return res.status(400).json({ success: false, error: 'يرجى إدخال كود الكرت' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const voucherRes = await client.query(
            'SELECT * FROM vouchers WHERE code = $1 FOR UPDATE',
            [code.trim()]
        );

        if (voucherRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: 'كود الكرت غير صحيح' });
        }

        const voucher = voucherRes.rows[0];

        if (voucher.is_used) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, error: 'هذا الكرت مستخدم من قبل' });
        }

        const columnMap = {
            'YER': 'balance_yer',
            'SAR': 'balance_sar',
            'USD': 'balance_usd'
        };
        const targetColumn = columnMap[voucher.currency];

        if (!targetColumn) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, error: 'عملة الكرت غير مدعومة' });
        }

        const accRes = await client.query(
            'SELECT id FROM accounts WHERE user_id = $1 FOR UPDATE',
            [req.user.id]
        );
        const userAccountId = accRes.rows[0].id;

        await client.query(
            'UPDATE vouchers SET is_used = TRUE, used_by_account_id = $1, used_at = NOW() WHERE id = $2',
            [userAccountId, voucher.id]
        );

        await client.query(
            `UPDATE accounts SET ${targetColumn} = ${targetColumn} + $1 WHERE id = $2`,
            [voucher.amount, userAccountId]
        );

        await client.query(
            'INSERT INTO transactions (sender_account_id, receiver_account_id, amount, currency) VALUES (NULL, $1, $2, $3)',
            [userAccountId, voucher.amount, voucher.currency]
        );

        await client.query('COMMIT');
        res.json({
            success: true,
            message: `تم شحن حسابك بنجاح بمبلغ ${voucher.amount} ${voucher.currency}`
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ خطأ في شحن الكرت:', err.message);
        res.status(500).json({ success: false, error: 'فشلت عملية الشحن: ' + err.message });
    } finally {
        client.release();
    }
});

// [ز] جلب سجل الحوالات والمعاملات
app.get('/api/my-transactions', authenticateToken, async (req, res) => {
    try {
        const filters = [
            'a.user_id = $1',
            '(t.sender_account_id = a.id OR t.receiver_account_id = a.id)',
        ];
        const params = [req.user.id];
        const addFilter = (clause, value) => {
            params.push(value);
            filters.push(clause.replace('?', `$${params.length}`));
        };
        const currency = String(req.query.currency || '').toUpperCase();
        const direction = String(req.query.direction || '').toUpperCase();
        const kind = String(req.query.kind || '').toUpperCase();

        if (currency && CURRENCY_COLUMNS[currency]) addFilter('t.currency = ?', currency);
        if (['SENT', 'RECEIVED'].includes(direction)) {
            addFilter(`CASE WHEN t.sender_account_id = a.id THEN 'SENT' ELSE 'RECEIVED' END = ?`, direction);
        }
        if (['TRANSFER', 'EXCHANGE', 'BILL', 'DEPOSIT', 'VAULT_DEPOSIT', 'VAULT_WITHDRAW'].includes(kind)) {
            addFilter(
                `CASE WHEN COALESCE(t.type, CASE
                    WHEN t.sender_account_id IS NULL THEN 'DEPOSIT'
                    WHEN t.receiver_account_id IS NULL THEN 'BILL'
                    WHEN t.sender_account_id = t.receiver_account_id THEN 'EXCHANGE'
                    ELSE 'TRANSFER'
                 END) LIKE 'BILL%' THEN 'BILL'
                 ELSE COALESCE(t.type, CASE
                    WHEN t.sender_account_id IS NULL THEN 'DEPOSIT'
                    WHEN t.receiver_account_id IS NULL THEN 'BILL'
                    WHEN t.sender_account_id = t.receiver_account_id THEN 'EXCHANGE'
                    ELSE 'TRANSFER'
                 END) END = ?`,
                kind
            );
        }
        if (req.query.from && /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from))) {
            addFilter('t.created_at >= ?::date', String(req.query.from));
        }
        if (req.query.to && /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to))) {
            addFilter('t.created_at < (?::date + INTERVAL \'1 day\')', String(req.query.to));
        }

        const where = filters.join(' AND ');
        const query = `
            SELECT 
                t.id,
                t.amount,
                t.currency,
                t.created_at,
                t.sender_account_id,
                t.receiver_account_id,
                t.type,
                t.status,
                t.service_type,
                t.service_number,
                t.provider_reference,
                t.target_currency,
                t.exchange_rate,
                u_sender.name as sender_name,
                u_receiver.name as receiver_name,
                CASE
                    WHEN t.type = 'VAULT_WITHDRAW' THEN 'RECEIVED'
                    WHEN t.type = 'VAULT_DEPOSIT' THEN 'SENT'
                    WHEN t.sender_account_id = a.id THEN 'SENT'
                    ELSE 'RECEIVED'
                END as direction,
                CASE WHEN COALESCE(t.type, CASE
                    WHEN t.sender_account_id IS NULL THEN 'DEPOSIT'
                    WHEN t.receiver_account_id IS NULL THEN 'BILL'
                    WHEN t.sender_account_id = t.receiver_account_id THEN 'EXCHANGE'
                    ELSE 'TRANSFER'
                END) LIKE 'BILL%' THEN 'BILL'
                ELSE COALESCE(t.type, CASE
                    WHEN t.sender_account_id IS NULL THEN 'DEPOSIT'
                    WHEN t.receiver_account_id IS NULL THEN 'BILL'
                    WHEN t.sender_account_id = t.receiver_account_id THEN 'EXCHANGE'
                    ELSE 'TRANSFER'
                END) END as kind
            FROM transactions t
            JOIN accounts a ON a.user_id = $1
            LEFT JOIN accounts a_sender ON t.sender_account_id = a_sender.id
            LEFT JOIN users u_sender ON a_sender.user_id = u_sender.id
            LEFT JOIN accounts a_receiver ON t.receiver_account_id = a_receiver.id
            LEFT JOIN users u_receiver ON a_receiver.user_id = u_receiver.id
            WHERE ${where}
            ORDER BY t.created_at DESC
            LIMIT 250
        `;
        const result = await pool.query(query, params);

        const formattedTxs = result.rows.map(tx => ({
            id: tx.id,
            amount: tx.amount,
            currency: tx.currency,
            date: tx.created_at,
            direction: tx.direction,
            kind: tx.kind,
            type: tx.type,
            status: tx.status || 'SUCCESS',
            senderName: tx.sender_name || 'شحن كرت / إيداع',
            receiverName: tx.receiver_name || tx.service_number || 'غير معروف',
            serviceType: tx.service_type,
            serviceNumber: tx.service_number,
            providerReference: tx.provider_reference,
            targetCurrency: tx.target_currency,
            exchangeRate: tx.exchange_rate,
            receiptSignature: receiptSignature(tx),
        }));

        const summaryResult = await pool.query(
            `SELECT t.currency,
                    COUNT(*)::integer AS count,
                    COALESCE(SUM(CASE WHEN (t.sender_account_id = a.id
                        AND (t.receiver_account_id IS NULL OR t.receiver_account_id <> a.id))
                        OR t.type = 'VAULT_DEPOSIT'
                        THEN t.amount ELSE 0 END), 0) AS expenses,
                    COALESCE(SUM(CASE WHEN (t.receiver_account_id = a.id
                        AND (t.sender_account_id IS NULL OR t.sender_account_id <> a.id))
                        OR t.type = 'VAULT_WITHDRAW'
                        THEN t.amount ELSE 0 END), 0) AS income
             FROM transactions t
             JOIN accounts a ON a.user_id = $1
             WHERE ${where}
             GROUP BY t.currency
             ORDER BY t.currency`,
            params
        );
        const chartResult = await pool.query(
            `SELECT DATE(t.created_at) AS day, t.currency,
                    COALESCE(SUM(CASE WHEN (t.sender_account_id = a.id
                        AND (t.receiver_account_id IS NULL OR t.receiver_account_id <> a.id))
                        OR t.type = 'VAULT_DEPOSIT'
                        THEN t.amount ELSE 0 END), 0) AS expenses,
                    COALESCE(SUM(CASE WHEN (t.receiver_account_id = a.id
                        AND (t.sender_account_id IS NULL OR t.sender_account_id <> a.id))
                        OR t.type = 'VAULT_WITHDRAW'
                        THEN t.amount ELSE 0 END), 0) AS income
             FROM transactions t
             JOIN accounts a ON a.user_id = $1
             WHERE ${where} AND t.created_at >= NOW() - INTERVAL '30 days'
             GROUP BY DATE(t.created_at), t.currency
             ORDER BY day ASC`,
            params
        );

        res.json({
            success: true,
            transactions: formattedTxs,
            summary: summaryResult.rows,
            chart: chartResult.rows,
        });
    } catch (err) {
        console.error('❌ خطأ في سجل المعاملات:', err.message);
        res.status(500).json({ success: false, error: 'خطأ في جلب سجل المعاملات' });
    }
});

app.get('/api/receipts/:id/verify', async (req, res) => {
    if (!SESSION_SECRET) {
        return res.status(503).json({ success: false, error: 'التحقق الرقمي غير متاح حتى ضبط مفتاح الجلسة' });
    }
    try {
        const transactionId = Number(req.params.id);
        if (!Number.isInteger(transactionId) || transactionId <= 0) {
            return res.status(400).json({ success: false, error: 'رقم الإيصال غير صالح' });
        }
        const result = await pool.query(
            `SELECT id, sender_account_id, receiver_account_id, amount, currency, created_at,
                    type, status, service_type, service_number, provider_reference
             FROM transactions WHERE id = $1`,
            [transactionId]
        );
        const tx = result.rows[0];
        if (!tx) return res.status(404).json({ success: false, error: 'الإيصال غير موجود' });

        const expected = receiptSignature(tx);
        const supplied = String(req.query.signature || '');
        const verified = /^[a-f0-9]{64}$/i.test(supplied)
            && crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(supplied, 'hex'));
        res.json({
            success: true,
            verified,
            receipt: verified ? {
                id: tx.id,
                amount: tx.amount,
                currency: tx.currency,
                date: tx.created_at,
                type: tx.type,
                status: tx.status || 'SUCCESS',
                serviceType: tx.service_type,
                serviceNumber: tx.service_number,
                providerReference: tx.provider_reference,
            } : null,
        });
    } catch {
        res.status(500).json({ success: false, error: 'تعذر التحقق من الإيصال' });
    }
});

app.get('/api/savings/vaults', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, name, currency, balance, created_at, updated_at
             FROM savings_vaults WHERE user_id = $1 ORDER BY created_at DESC`,
            [req.user.id]
        );
        res.json({ success: true, vaults: result.rows });
    } catch {
        res.status(500).json({ success: false, error: 'تعذر جلب خزائن الادخار' });
    }
});

app.post('/api/savings/vaults', authenticateToken, async (req, res) => {
    const name = String(req.body.name || '').trim();
    const currency = String(req.body.currency || '').toUpperCase();
    if (name.length < 2 || name.length > 40 || !CURRENCY_COLUMNS[currency]) {
        return res.status(400).json({ success: false, error: 'أدخل اسمًا من حرفين إلى 40 حرفًا واختر عملة مدعومة' });
    }
    try {
        const result = await pool.query(
            `INSERT INTO savings_vaults (user_id, name, currency)
             VALUES ($1, $2, $3) RETURNING id, name, currency, balance, created_at, updated_at`,
            [req.user.id, name, currency]
        );
        await securityEvent(req, 'VAULT_CREATED', `إنشاء خزنة ادخار بعملة ${currency}`);
        res.status(201).json({ success: true, vault: result.rows[0] });
    } catch (error) {
        console.error('❌ خطأ إنشاء خزنة الادخار:', error.message);
        res.status(500).json({ success: false, error: 'تعذر إنشاء خزنة الادخار' });
    }
});

app.post('/api/savings/vaults/:id/movements', authenticateToken, async (req, res) => {
    const vaultId = Number(req.params.id);
    const amount = Number(req.body.amount);
    const direction = String(req.body.direction || '').toUpperCase();
    if (!Number.isInteger(vaultId) || vaultId <= 0 || !Number.isFinite(amount) || amount <= 0
        || !['DEPOSIT', 'WITHDRAW'].includes(direction)) {
        return res.status(400).json({ success: false, error: 'بيانات حركة الادخار غير صالحة' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const vaultResult = await client.query(
            `SELECT id, currency, balance FROM savings_vaults
             WHERE id = $1 AND user_id = $2 FOR UPDATE`,
            [vaultId, req.user.id]
        );
        const accountResult = await client.query(
            `SELECT u.pin, a.id AS account_id, a.${CURRENCY_COLUMNS[req.body.currency] || 'balance_yer'} AS balance
             FROM users u JOIN accounts a ON a.user_id = u.id
             WHERE u.id = $1 FOR UPDATE`,
            [req.user.id]
        );
        const vault = vaultResult.rows[0];
        const account = accountResult.rows[0];
        if (!vault || !account) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: 'خزنة الادخار غير موجودة' });
        }
        const accountColumn = CURRENCY_COLUMNS[vault.currency];
        if (!accountColumn) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, error: 'عملة الخزنة غير مدعومة' });
        }
        if (account.pin !== req.body.pin) {
            await client.query('ROLLBACK');
            return res.status(401).json({ success: false, error: 'رمز PIN غير صحيح' });
        }
        const otp = await consumeTotpCode(client, req.user.id, req.body.otp);
        if (!otp.valid) {
            await client.query('ROLLBACK');
            return res.status(401).json({ success: false, requiresOtp: otp.required, error: 'رمز التحقق الثنائي غير صحيح' });
        }

        const walletBalanceResult = await client.query(
            `SELECT ${accountColumn} AS balance FROM accounts WHERE id = $1 FOR UPDATE`,
            [account.account_id]
        );
        const walletBalance = Number(walletBalanceResult.rows[0].balance || 0);
        const vaultBalance = Number(vault.balance || 0);
        if (direction === 'DEPOSIT' && walletBalance < amount) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, error: 'رصيد المحفظة غير كافٍ للإيداع' });
        }
        if (direction === 'WITHDRAW' && vaultBalance < amount) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, error: 'رصيد الخزنة غير كافٍ للسحب' });
        }

        const nextVaultBalance = direction === 'DEPOSIT' ? vaultBalance + amount : vaultBalance - amount;
        if (direction === 'DEPOSIT') {
            await client.query(`UPDATE accounts SET ${accountColumn} = ${accountColumn} - $1 WHERE id = $2`, [amount, account.account_id]);
        } else {
            await client.query(`UPDATE accounts SET ${accountColumn} = ${accountColumn} + $1 WHERE id = $2`, [amount, account.account_id]);
        }
        await client.query(
            'UPDATE savings_vaults SET balance = $1, updated_at = NOW() WHERE id = $2',
            [nextVaultBalance, vaultId]
        );
        const movement = await client.query(
            `INSERT INTO savings_vault_movements
             (vault_id, user_id, direction, amount, currency, balance_after)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, created_at`,
            [vaultId, req.user.id, direction, amount, vault.currency, nextVaultBalance]
        );
        const transaction = await client.query(
            `INSERT INTO transactions
             (sender_account_id, receiver_account_id, amount, currency, type, status, note)
             VALUES ($1, $1, $2, $3, $4, 'SUCCESS', $5)
             RETURNING id, created_at, type, status`,
            [
                account.account_id,
                amount,
                vault.currency,
                direction === 'DEPOSIT' ? 'VAULT_DEPOSIT' : 'VAULT_WITHDRAW',
                `${direction === 'DEPOSIT' ? 'إيداع في' : 'سحب من'} خزنة ${vault.name || vaultId}`,
            ]
        );
        await client.query('COMMIT');
        const receipt = {
            ...transaction.rows[0],
            sender_account_id: account.account_id,
            receiver_account_id: account.account_id,
            amount,
            currency: vault.currency,
        };
        res.json({
            success: true,
            vault: { id: vaultId, balance: nextVaultBalance, currency: vault.currency },
            movement: movement.rows[0],
            transaction: { ...transaction.rows[0], receiptSignature: receiptSignature(receipt) },
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ خطأ حركة خزنة الادخار:', error.message);
        res.status(500).json({ success: false, error: 'تعذر تنفيذ حركة الادخار' });
    } finally {
        client.release();
    }
});

app.delete('/api/savings/vaults/:id', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `DELETE FROM savings_vaults
             WHERE id = $1 AND user_id = $2 AND balance = 0
             RETURNING id`,
            [Number(req.params.id), req.user.id]
        );
        if (result.rows.length === 0) {
            return res.status(400).json({ success: false, error: 'أفرغ الخزنة قبل حذفها أو تحقق من ملكيتها' });
        }
        await securityEvent(req, 'VAULT_DELETED', 'حذف خزنة ادخار فارغة');
        res.json({ success: true });
    } catch {
        res.status(500).json({ success: false, error: 'تعذر حذف الخزنة' });
    }
});

app.get('/api/exchange-rates', authenticateToken, async (req, res) => {
    res.status(503).json({
        success: false,
        code: 'LOCAL_FX_PROVIDER_UNCONFIGURED',
        error: 'أسعار صنعاء وعدن تتطلب مزود أسعار محليًا موثوقًا. لم يتم تفعيل سعر صرف غير مؤكد.',
        markets: ['sanaa_old_notes', 'aden_new_notes'],
    });
});

app.post('/api/bills/weta/offers', authenticateToken, async (req, res) => {
    const mobile = String(req.body.mobile || '').replace(/\D/g, '');
    const serviceType = String(req.body.serviceType || '').toLowerCase();
    if (!/^(?:\d{10}|\d{12})$/.test(mobile)
        || !['prepaid', 'postpaid', 'line', 'adsl'].includes(serviceType)) {
        return res.status(400).json({ success: false, error: 'أدخل رقمًا من 10 أو 12 رقمًا واختر نوع الخدمة المدعوم' });
    }

    try {
        const result = await wetaPost('q/weta-offer', { mobile });
        const rawOffers = Array.isArray(result.data) ? result.data : Array.isArray(result.data?.data) ? result.data.data : [];
        const offers = rawOffers.map((offer) => ({
            code: String(offer.code ?? ''),
            telecomCompany: String(offer.telecom_company || ''),
            category: String(offer.category || ''),
            amountSent: Number(offer.amount_sent),
            processingFees: String(offer.processing_fees || ''),
            totalCost: Number(offer.total_cost),
            amountReceived: Number(offer.recevied ?? offer.received),
            serviceType,
        })).filter((offer) => offer.code && Number.isFinite(offer.totalCost) && offer.totalCost > 0);

        res.json({ success: true, provider: 'Weta', mobile, serviceType, offers });
    } catch (error) {
        res.status(error.status || 502).json({ success: false, error: error.message || 'تعذر جلب عروض Weta' });
    }
});

app.post('/api/bills/weta/pay', authenticateToken, async (req, res) => {
    const mobile = String(req.body.mobile || '').replace(/\D/g, '');
    const serviceType = String(req.body.serviceType || '').toLowerCase();
    const offerCode = String(req.body.offerCode || '').trim();
    const idempotencyKey = String(req.body.idempotencyKey || '');
    if (!/^(?:\d{10}|\d{12})$/.test(mobile)
        || !['prepaid', 'postpaid', 'line', 'adsl'].includes(serviceType)
        || !offerCode || offerCode.length > 40
        || !/^[a-f0-9-]{36}$/i.test(idempotencyKey)) {
        return res.status(400).json({ success: false, error: 'بيانات سداد Weta غير صالحة' });
    }

    const client = await pool.connect();
    let transactionId = null;
    let transactionRow = null;
    try {
        const existing = await client.query(
            `SELECT id, amount, currency, status, created_at
             FROM transactions WHERE idempotency_key = $1 AND sender_account_id IN
               (SELECT id FROM accounts WHERE user_id = $2)`,
            [idempotencyKey, req.user.id]
        );
        if (existing.rows.length > 0) {
            const prior = existing.rows[0];
            return res.status(prior.status === 'SUCCESS' ? 200 : 202).json({
                success: prior.status === 'SUCCESS',
                pending: prior.status !== 'SUCCESS',
                transaction: { id: prior.id, amount: prior.amount, currency: prior.currency, status: prior.status },
                message: prior.status === 'SUCCESS' ? 'تم تنفيذ العملية سابقًا' : 'العملية قيد المعالجة؛ لا تعاود إرسالها',
            });
        }

        const offerResult = await wetaPost('q/weta-offer', { mobile });
        const offers = Array.isArray(offerResult.data) ? offerResult.data : Array.isArray(offerResult.data?.data) ? offerResult.data.data : [];
        const chosenOffer = offers.find((offer) => String(offer.code) === offerCode);
        const cost = Number(chosenOffer?.total_cost);
        if (!chosenOffer || !Number.isFinite(cost) || cost <= 0) {
            return res.status(400).json({ success: false, error: 'العرض غير صالح أو لم يعد متاحًا؛ حدّث قائمة العروض' });
        }

        await client.query('BEGIN');
        const senderResult = await client.query(
            `SELECT u.pin, a.id AS account_id, a.balance_yer AS balance
             FROM users u JOIN accounts a ON a.user_id = u.id
             WHERE u.id = $1 FOR UPDATE`,
            [req.user.id]
        );
        const sender = senderResult.rows[0];
        if (!sender) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: 'الحساب غير موجود' });
        }
        if (sender.pin !== req.body.pin) {
            await client.query('ROLLBACK');
            return res.status(401).json({ success: false, error: 'رمز PIN غير صحيح' });
        }
        const otp = await consumeTotpCode(client, req.user.id, req.body.otp);
        if (!otp.valid) {
            await client.query('ROLLBACK');
            return res.status(401).json({ success: false, requiresOtp: otp.required, error: 'رمز التحقق الثنائي غير صحيح' });
        }
        if (Number(sender.balance) < cost) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, error: 'الرصيد غير كافٍ لسداد العرض' });
        }

        await client.query('UPDATE accounts SET balance_yer = balance_yer - $1 WHERE id = $2', [cost, sender.account_id]);
        const insert = await client.query(
            `INSERT INTO transactions
             (sender_account_id, receiver_account_id, amount, currency, type, status,
              service_type, service_number, idempotency_key, note)
             VALUES ($1, NULL, $2, 'YER', 'BILL_WETA', 'PROCESSING', $3, $4, $5, $6)
             RETURNING id, created_at, amount, currency, type, status, sender_account_id,
                       receiver_account_id, service_type, service_number, provider_reference`,
            [sender.account_id, cost, serviceType, mobile, idempotencyKey, `Weta ${offerCode}`]
        );
        transactionRow = insert.rows[0];
        transactionId = transactionRow.id;
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        if (error.code === '23505') {
            return res.status(409).json({ success: false, error: 'تم إرسال هذه العملية بالفعل؛ حدّث سجل العمليات' });
        }
        res.status(error.status || 500).json({ success: false, error: error.message || 'تعذر بدء عملية Weta' });
        return;
    } finally {
        client.release();
    }

    try {
        const providerResult = await wetaPost('bill/weta-offer', {
            mobile,
            trans_id: transactionId,
            code: offerCode,
            type: serviceType,
        });
        const inner = Array.isArray(providerResult.data) ? providerResult.data[0] : providerResult.data;
        const responseCode = Number(inner?.status_code ?? providerResult.status_code);
        if (responseCode !== 200) {
            const error = new Error(inner?.description || providerResult.description || 'لم يؤكد مزود Weta تنفيذ العملية');
            error.definitive = responseCode >= 400 && responseCode < 500;
            throw error;
        }

        const providerReference = String(inner?.data?.trans_id ?? inner?.trans_id ?? transactionId);
        const updated = await pool.query(
            `UPDATE transactions SET status = 'SUCCESS', provider_reference = $1
             WHERE id = $2
             RETURNING id, sender_account_id, receiver_account_id, amount, currency, created_at,
                       type, status, service_type, service_number, provider_reference`,
            [providerReference, transactionId]
        );
        const completed = updated.rows[0];
        res.json({
            success: true,
            message: 'أكد مزود Weta تنفيذ السداد',
            transaction: {
                id: completed.id,
                amount: completed.amount,
                currency: completed.currency,
                status: completed.status,
                serviceType: completed.service_type,
                serviceNumber: completed.service_number,
                providerReference: completed.provider_reference,
                receiptSignature: receiptSignature(completed),
            },
        });
    } catch (error) {
        if (error.definitive) {
            const refundClient = await pool.connect();
            try {
                await refundClient.query('BEGIN');
                await refundClient.query(
                    `UPDATE accounts SET balance_yer = balance_yer + $1
                     WHERE id = (SELECT sender_account_id FROM transactions WHERE id = $2)`,
                    [transactionRow.amount, transactionId]
                );
                await refundClient.query(
                    `UPDATE transactions SET status = 'FAILED', note = $1 WHERE id = $2`,
                    [String(error.message).slice(0, 240), transactionId]
                );
                await refundClient.query('COMMIT');
            } catch (refundError) {
                await refundClient.query('ROLLBACK');
                console.error('❌ تعذر رد مبلغ Weta:', refundError.message);
                return res.status(500).json({ success: false, pending: true, error: 'تعذر تأكيد العملية أو رد المبلغ؛ راجع سجل الأمان والدعم' });
            } finally {
                refundClient.release();
            }
            return res.status(502).json({ success: false, error: 'رفض مزود Weta العملية وتم رد المبلغ' });
        }

        await pool.query(
            `UPDATE transactions SET status = 'PENDING_REVIEW', note = $1 WHERE id = $2`,
            ['تعذر تأكيد رد المزود؛ يحتاج الأمر إلى مراجعة', transactionId]
        );
        res.status(202).json({
            success: false,
            pending: true,
            transactionId,
            error: 'لم يصل تأكيد نهائي من Weta؛ لا تعاود الإرسال، وتحقق من حالة العملية',
        });
    }
});

// [ح] سداد الفواتير والخدمات
app.post('/api/pay-bill', authenticateToken, async (req, res) => {
    return res.status(409).json({
        success: false,
        code: 'UNSUPPORTED_BILL_PROVIDER',
        error: 'استخدم خدمة Weta للهاتف والخط وADSL فقط؛ الكهرباء والمياه غير متاحتين دون مزود موثوق.',
    });
    const { billType, serviceNumber, amount, currency, pin } = req.body;
    const numAmount = parseFloat(amount);

    if (isNaN(numAmount) || numAmount <= 0) {
        return res.status(400).json({ success: false, error: 'المبلغ غير صالح' });
    }

    const columnMap = { 'YER': 'balance_yer', 'SAR': 'balance_sar', 'USD': 'balance_usd' };
    const targetColumn = columnMap[currency];
    if (!targetColumn) {
        return res.status(400).json({ success: false, error: 'العملة غير مدعومة' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const senderRes = await client.query(
            `SELECT u.pin, a.id as account_id, a.${targetColumn} as balance 
             FROM users u JOIN accounts a ON u.id = a.user_id 
             WHERE u.id = $1 FOR UPDATE`, 
            [req.user.id]
        );
        const sender = senderRes.rows[0];

        if (sender.pin !== pin) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, error: 'رمز الـ PIN غير صحيح' });
        }

        if (parseFloat(sender.balance) < numAmount) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, error: 'الرصيد غير كافٍ لسداد الفاتورة' });
        }

        await client.query(`UPDATE accounts SET ${targetColumn} = ${targetColumn} - $1 WHERE id = $2`, [numAmount, sender.account_id]);

        await client.query(
            `INSERT INTO transactions (sender_account_id, receiver_account_id, amount, currency) VALUES ($1, NULL, $2, $3)`,
            [sender.account_id, numAmount, currency]
        );

        await client.query('COMMIT');
        res.json({
            success: true,
            message: `تم سداد فاتورة ${billType} للرقم (${serviceNumber}) بنجاح!`
        });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ success: false, error: 'فشلت عملية السداد: ' + err.message });
    } finally {
        client.release();
    }
});

// [ط] إرسال طلب أموال جديد
app.post('/api/request-money', authenticateToken, async (req, res) => {
    const { targetAccountId, amount, currency } = req.body;
    const targetInternalAccountId = internalAccountIdFromPublic(targetAccountId);
    const numAmount = parseFloat(amount);

    if (!isValidPublicAccountNumber(targetAccountId)) {
        return res.status(400).json({
            success: false,
            error: 'رقم الحساب المستهدف يجب أن يتكون من 9 أرقام ويبدأ بالرقم 7'
        });
    }

    if (isNaN(numAmount) || numAmount <= 0) {
        return res.status(400).json({ success: false, error: 'المبلغ غير صالح' });
    }

    const client = await pool.connect();
    try {
        const accRes = await client.query('SELECT id FROM accounts WHERE user_id = $1', [req.user.id]);
        if (accRes.rows.length === 0) return res.status(404).json({ success: false, error: 'الحساب غير موجود' });
        const requesterAccId = accRes.rows[0].id;

        if (requesterAccId == targetInternalAccountId) {
            return res.status(400).json({ success: false, error: 'لا يمكنك طلب أموال من نفس حسابك' });
        }

        const targetRes = await client.query('SELECT id FROM accounts WHERE id = $1', [targetInternalAccountId]);
        if (targetRes.rows.length === 0) return res.status(404).json({ success: false, error: 'رقم حساب المستهدف غير موجود' });

        await client.query(
            'INSERT INTO money_requests (requester_account_id, target_account_id, amount, currency) VALUES ($1, $2, $3, $4)',
            [requesterAccId, targetInternalAccountId, numAmount, currency]
        );

        res.json({ success: true, message: 'تم إرسال طلب الأموال بنجاح' });
    } catch (err) {
        res.status(500).json({ success: false, error: 'خطأ في السيرفر: ' + err.message });
    } finally {
        client.release();
    }
});

// [ي] جلب الطلبات الواردة المعلقة للمستخدم
app.get('/api/my-requests', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
        const accRes = await client.query('SELECT id FROM accounts WHERE user_id = $1', [req.user.id]);
        if (accRes.rows.length === 0) return res.status(404).json({ success: false, error: 'الحساب غير موجود' });
        const accId = accRes.rows[0].id;

        const incomingRes = await client.query(`
            SELECT r.*, u.name as requester_name 
            FROM money_requests r 
            JOIN accounts a ON r.requester_account_id = a.id 
            JOIN users u ON a.user_id = u.id 
            WHERE r.target_account_id = $1 AND r.status = 'PENDING'
            ORDER BY r.created_at DESC
        `, [accId]);

        res.json({ success: true, requests: incomingRes.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: 'خطأ في السيرفر' });
    } finally {
        client.release();
    }
});

// [ك] سداد طلب الأموال
app.post('/api/pay-request/:id', authenticateToken, async (req, res) => {
    const requestId = req.params.id;
    const { pin } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const reqRes = await client.query('SELECT * FROM money_requests WHERE id = $1 AND status = $2', [requestId, 'PENDING']);
        if (reqRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: 'الطلب غير موجود أو تم التعامل معه مسبقاً' });
        }
        const moneyReq = reqRes.rows[0];

        const payerAccRes = await client.query('SELECT id FROM accounts WHERE user_id = $1', [req.user.id]);
        if (payerAccRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: 'الحساب غير موجود' });
        }
        const payerAccId = payerAccRes.rows[0].id;

        if (moneyReq.target_account_id !== payerAccId) {
            await client.query('ROLLBACK');
            return res.status(403).json({ success: false, error: 'غير مسموح لك بسداد هذا الطلب' });
        }

        const columnMap = { 'YER': 'balance_yer', 'SAR': 'balance_sar', 'USD': 'balance_usd' };
        const targetColumn = columnMap[moneyReq.currency];

        const payerDataRes = await client.query(`SELECT u.pin, a.${targetColumn} as balance FROM users u JOIN accounts a ON u.id = a.user_id WHERE a.id = $1 FOR UPDATE`, [payerAccId]);
        const payer = payerDataRes.rows[0];

        if (payer.pin !== pin) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, error: 'رمز الـ PIN غير صحيح' });
        }

        if (parseFloat(payer.balance) < parseFloat(moneyReq.amount)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, error: 'الرصيد غير كافٍ لسداد الطلب' });
        }

        await client.query(`UPDATE accounts SET ${targetColumn} = ${targetColumn} - $1 WHERE id = $2`, [moneyReq.amount, payerAccId]);
        await client.query(`UPDATE accounts SET ${targetColumn} = ${targetColumn} + $1 WHERE id = $2`, [moneyReq.amount, moneyReq.requester_account_id]);

        await client.query(
            'INSERT INTO transactions (sender_account_id, receiver_account_id, amount, currency) VALUES ($1, $2, $3, $4)',
            [payerAccId, moneyReq.requester_account_id, moneyReq.amount, moneyReq.currency]
        );

        await client.query("UPDATE money_requests SET status = 'PAID' WHERE id = $1", [requestId]);

        await client.query('COMMIT');
        res.json({ success: true, message: 'تم سداد الطلب وتحويل المبلغ بنجاح' });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ success: false, error: 'فشل السداد: ' + err.message });
    } finally {
        client.release();
    }
});

// لا تُنفّذ عمليات صرف بأرقام ثابتة؛ تفعيلها مرتبط بمزود سوق محلي موثوق.
app.post('/api/exchange', authenticateToken, async (req, res) => {
    res.status(503).json({
        success: false,
        code: 'LOCAL_FX_PROVIDER_UNCONFIGURED',
        error: 'الصرف متوقف حتى ربط مزود أسعار محلي موثوق لصنعاء وعدن.',
    });
});

// [م] الاستعلام عن حوالة شبكة محلية (جديد للربط مع واجهة الاستلام)
app.get('/api/local-remittance/:remittanceNumber', authenticateToken, async (req, res) => {
    const { remittanceNumber } = req.params;

    try {
        // الاستعلام عن الحوالة برقم الحوالة من قاعدة البيانات
        const query = `SELECT * FROM local_remittances WHERE remittance_number = $1`;
        const result = await pool.query(query, [remittanceNumber]);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'لم يتم العثور على حوالة بهذا الرقم' });
        }

        res.json({ success: true, remittance: result.rows[0] });
    } catch (err) {
        console.error('❌ خطأ البحث عن الحوالة:', err.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في البحث عن الحوالة' });
    }
});

// 4. تشغيل السيرفر
httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
});