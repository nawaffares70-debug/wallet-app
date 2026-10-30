const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
    secret: 'wallet_secret_key_2026',
    resave: false,
    saveUninitialized: false
}));

async function initDb() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                password VARCHAR(50) NOT NULL,
                pin VARCHAR(10),
                name VARCHAR(100),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS accounts (
                id SERIAL PRIMARY KEY,
                user_id INT REFERENCES users(id),
                balance_yer NUMERIC DEFAULT 0,
                balance_sar NUMERIC DEFAULT 0,
                balance_usd NUMERIC DEFAULT 0
            );
        `);
        console.log("Database tables checked/created successfully.");
    } catch (err) {
        console.error("Error creating tables:", err);
    }
}
initDb();

app.get('/login', (req, res) => {
    res.send(`
        <html dir="rtl"><body style="background:#0f172a;color:white;font-family:Tahoma;padding:30px;text-align:center;">
        <h2>تسجيل الدخول</h2>
        <form method="POST" action="/login">
            <input type="text" name="username" placeholder="اسم المستخدم" style="padding:10px;margin:5px;display:block;margin:auto;width:80%;max-width:300px;"><br>
            <input type="password" name="password" placeholder="كلمة المرور" style="padding:10px;margin:5px;display:block;margin:auto;width:80%;max-width:300px;"><br>
            <button type="submit" style="padding:10px 20px;background:#0284c7;color:white;border:none;border-radius:5px;">دخول</button>
        </form>
        </body></html>
    `);
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1 AND password = $2', [username, password]);
        if (result.rows.length > 0) {
            req.session.userId = result.rows[0].id;
            res.redirect('/');
        } else {
            res.send('<script>alert("خطأ في بيانات الدخول"); window.location="/login";</script>');
        }
    } catch (err) {
        res.status(500).send('Error: ' + err.message);
    }
});

app.get('/', async (req, res) => {
    if (!req.session || !req.session.userId) {
        return res.redirect('/login');
    }
    try {
        const result = await pool.query(`
            SELECT u.name, a.balance_yer, a.balance_sar, a.balance_usd 
            FROM users u 
            LEFT JOIN accounts a ON u.id = a.user_id 
            WHERE u.id = $1
        `, [req.session.userId]);
        const user = result.rows[0] || {};
        res.send(`
            <!DOCTYPE html>
            <html lang="ar" dir="rtl">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>المحفظة الإلكترونية</title>
                <style>
                    body { font-family: Tahoma, sans-serif; background: #0f172a; color: #f8fafc; padding: 15px; margin: 0; }
                    .header { display: flex; justify-content: space-between; align-items: center; background: #1e293b; padding: 15px 20px; border-radius: 12px; margin-bottom: 20px; box-shadow: 0 4px 6px rgba(0,0,0,0.2); }
                    .welcome { font-size: 16px; font-weight: bold; color: #38bdf8; }
                    .settings-gear { background: #334155; color: #38bdf8; width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; text-decoration: none; font-size: 20px; transition: all 0.3s ease; box-shadow: 0 2px 4px rgba(0,0,0,0.3); }
                    .settings-gear:hover { background: #0284c7; color: white; transform: rotate(90deg); }
                    .card { background: #1e293b; border-radius: 12px; padding: 20px; margin-bottom: 15px; box-shadow: 0 4px 6px rgba(0,0,0,0.2); text-align: center; }
                    .balance-title { color: #94a3b8; font-size: 14px; margin-bottom: 5px; }
                    .balance-val { font-size: 24px; font-weight: bold; color: #34d399; font-family: monospace; }
                </style>
            </head>
            <body>
                <div class="header">
                    <div class="welcome">مرحباً، ${user.name || 'مستخدم'}</div>
                    <a href="/settings" class="settings-gear" title="الإعدادات">⚙️</a>
                </div>
                <div class="card">
                    <div class="balance-title">الرصيد اليمني (YER)</div>
                    <div class="balance-val">${user.balance_yer || 0}</div>
                </div>
                <div class="card">
                    <div class="balance-title">الرصيد السعودي (SAR)</div>
                    <div class="balance-val">${user.balance_sar || 0}</div>
                </div>
                <div class="card">
                    <div class="balance-title">رصيد الدولار (USD)</div>
                    <div class="balance-val">${user.balance_usd || 0}</div>
                </div>
            </body>
            </html>
        `);
    } catch (err) {
        res.status(500).send('❌ حدث خطأ: ' + err.message);
    }
});

app.get('/settings', async (req, res) => {
    if (!req.session || !req.session.userId) {
        return res.redirect('/login');
    }
    try {
        const result = await pool.query(`
            SELECT u.username, u.name, u.password, u.pin, a.id as account_id 
            FROM users u 
            LEFT JOIN accounts a ON u.id = a.user_id 
            WHERE u.id = $1
        `, [req.session.userId]);
        const user = result.rows[0] || {};
        res.send(`
            <!DOCTYPE html>
            <html lang="ar" dir="rtl">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>الإعدادات والحساب</title>
                <style>
                    body { font-family: Tahoma, sans-serif; background: #0f172a; color: #f8fafc; padding: 15px; margin: 0; }
                    .container { max-width: 400px; margin: 20px auto; }
                    h2 { color: #38bdf8; text-align: center; margin-bottom: 20px; }
                    .section-card { background: #1e293b; border-radius: 12px; padding: 20px; margin-bottom: 15px; box-shadow: 0 4px 6px rgba(0,0,0,0.2); }
                    .title { color: #38bdf8; font-size: 16px; font-weight: bold; margin-bottom: 15px; border-bottom: 1px solid #334155; padding-bottom: 8px; }
                    .info-row { display: flex; justify-content: space-between; margin-bottom: 12px; font-size: 14px; }
                    .label { color: #94a3b8; }
                    .value { color: #f8fafc; font-weight: bold; font-family: monospace; }
                    .badge-pass { color: #34d399; }
                    .badge-pin { color: #fbbf24; }
                    .back-btn { display: block; text-align: center; background: #334155; color: white; padding: 12px; border-radius: 8px; text-decoration: none; margin-top: 20px; font-weight: bold; }
                    .back-btn:hover { background: #475569; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h2>⚙️ الإعدادات</h2>
                    <div class="section-card">
                        <div class="title">👤 معلومات الحساب</div>
                        <div class="info-row">
                            <span class="label">الاسم:</span>
                            <span class="value">${user.name || 'بدون'}</span>
                        </div>
                        <div class="info-row">
                            <span class="label">رقم الحساب:</span>
                            <span class="value">${user.account_id || '-'}</span>
                        </div>
                        <div class="info-row">
                            <span class="label">اسم المستخدم:</span>
                            <span class="value">${user.username}</span>
                        </div>
                        <div class="info-row">
                            <span class="label">كلمة المرور:</span>
                            <span class="value badge-pass">${user.password}</span>
                        </div>
                        <div class="info-row">
                            <span class="label">رمز الـ PIN:</span>
                            <span class="value badge-pin">${user.pin || 'غير مخصص'}</span>
                        </div>
                    </div>
                    <a href="/" class="back-btn">← العودة للرئيسية</a>
                </div>
            </body>
            </html>
        `);
    } catch (err) {
        res.status(500).send('❌ حدث خطأ: ' + err.message);
    }
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
