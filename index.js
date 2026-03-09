// ═══════════════════════════════════════════════════════════════
// BTECH PLUS — Backend Server (server.js)
// M-Pesa STK Push + PostgreSQL + Admin API
// Full structured logging — every event timestamped & labelled
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { Pool }  = require('pg');
const axios     = require('axios');
const cors      = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors({
    origin: '*',
    methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-admin-password', 'Authorization'],
    preflightContinue: false,
    optionsSuccessStatus: 204
}));

// Handle preflight OPTIONS requests explicitly
app.options('*', cors());


// ═══════════════════════════════════════════════════════════════
// LOGGER — every line has a timestamp + category label
// ═══════════════════════════════════════════════════════════════
function ts() {
    return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

const ICONS = {
    INFO:  '📘 INFO ',
    OK:    '✅ OK   ',
    WARN:  '⚠️  WARN ',
    ERROR: '❌ ERROR',
    MPESA: '📲 MPESA',
    DB:    '🗄️  DB   ',
    HTTP:  '🌐 HTTP ',
    AUTH:  '🔐 AUTH ',
};

function log(level, message, data) {
    const prefix = ICONS[level] || '   ';
    const line = `[${ts()}] ${prefix} | ${message}`;
    if (data !== undefined && data !== null) {
        console.log(line);
        console.log('              └─', typeof data === 'object' ? JSON.stringify(data, null, 2) : data);
    } else {
        console.log(line);
    }
}

// Shorthand helpers
const logInfo  = (msg, d) => log('INFO',  msg, d);
const logOk    = (msg, d) => log('OK',    msg, d);
const logWarn  = (msg, d) => log('WARN',  msg, d);
const logError = (msg, d) => log('ERROR', msg, d);
const logMpesa = (msg, d) => log('MPESA', msg, d);
const logDb    = (msg, d) => log('DB',    msg, d);
const logHttp  = (msg, d) => log('HTTP',  msg, d);
const logAuth  = (msg, d) => log('AUTH',  msg, d);


// ═══════════════════════════════════════════════════════════════
// STARTUP — print all env var statuses (masked secrets)
// ═══════════════════════════════════════════════════════════════
function mask(val) {
    if (!val) return '❌ NOT SET';
    const s = String(val);
    if (s.length <= 6) return '****';
    return s.slice(0, 3) + '****' + s.slice(-3);
}

console.log('');
console.log('╔══════════════════════════════════════════════════╗');
console.log('║       BTECH PLUS Backend — Starting 🚀           ║');
console.log('╚══════════════════════════════════════════════════╝');
logInfo('NODE_ENV            = ' + (process.env.NODE_ENV || 'development'));
logInfo('PORT                = ' + (process.env.PORT || 10000));
logInfo('DATABASE_URL        = ' + (process.env.DATABASE_URL ? '✅ SET' : '❌ NOT SET'));
logInfo('CONSUMER_KEY        = ' + mask(process.env.CONSUMER_KEY));
logInfo('CONSUMER_SECRET     = ' + mask(process.env.CONSUMER_SECRET));
logInfo('BUSINESS_SHORT_CODE = ' + (process.env.BUSINESS_SHORT_CODE || '❌ NOT SET'));
logInfo('TILL_NUMBER         = ' + (process.env.TILL_NUMBER || '❌ NOT SET — will fallback to SHORT_CODE'));
logInfo('PASSKEY             = ' + mask(process.env.PASSKEY));
logInfo('BASE_URL            = ' + (process.env.BASE_URL || '❌ NOT SET — using hardcoded fallback'));
logInfo('ADMIN_PASSWORD      = ' + mask(process.env.ADMIN_PASSWORD));
console.log('═══════════════════════════════════════════════════');
console.log('');


// ═══════════════════════════════════════════════════════════════
// REQUEST LOGGER MIDDLEWARE
// Logs every incoming HTTP request with method, path, status, duration
// ═══════════════════════════════════════════════════════════════
app.use((req, res, next) => {
    const start = Date.now();
    const ip = req.headers['x-forwarded-for'] || req.ip || req.connection?.remoteAddress || 'unknown';
    logHttp(`→ ${req.method} ${req.originalUrl} | IP: ${ip}`);
    res.on('finish', () => {
        const ms   = Date.now() - start;
        const icon = res.statusCode < 300 ? '✅' : res.statusCode < 400 ? '↩️' : res.statusCode < 500 ? '⚠️' : '❌';
        logHttp(`← ${icon} ${req.method} ${req.originalUrl} | Status: ${res.statusCode} | ${ms}ms`);
    });
    next();
});


// ═══════════════════════════════════════════════════════════════
// DATABASE
// ═══════════════════════════════════════════════════════════════
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

pool.on('connect', () => logDb('New client connected to PostgreSQL pool'));
pool.on('error',   (err) => logError('Unexpected DB pool error', { message: err.message, code: err.code }));

// Auto-create table on startup
pool.query(`
    CREATE TABLE IF NOT EXISTS btech_orders (
        id                  SERIAL PRIMARY KEY,
        order_id            VARCHAR(100) UNIQUE NOT NULL,
        checkout_request_id VARCHAR(200),
        customer_name       VARCHAR(200),
        phone_number        VARCHAR(20),
        shirt_type          TEXT,
        amount              INTEGER NOT NULL DEFAULT 0,
        payment_status      VARCHAR(20) DEFAULT 'PENDING',
        mpesa_receipt       VARCHAR(100),
        created_at          TIMESTAMP DEFAULT NOW(),
        updated_at          TIMESTAMP DEFAULT NOW()
    );
`)
.then(() => logOk('DB table "btech_orders" ready'))
.catch(err  => logError('DB table creation failed', { message: err.message, code: err.code }));


// ═══════════════════════════════════════════════════════════════
// ADMIN MIDDLEWARE
// ═══════════════════════════════════════════════════════════════
function adminAuth(req, res, next) {
    const provided = req.headers['x-admin-password'];
    if (!provided) {
        logAuth(`DENIED — no password header | ${req.method} ${req.originalUrl}`);
        return res.status(401).json({ error: "Unauthorized: No password provided" });
    }
    if (provided !== process.env.ADMIN_PASSWORD) {
        logAuth(`DENIED — wrong password | ${req.method} ${req.originalUrl} | Provided: ${mask(provided)}`);
        return res.status(401).json({ error: "Unauthorized: Invalid Admin Password" });
    }
    logAuth(`GRANTED | ${req.method} ${req.originalUrl}`);
    next();
}


// ═══════════════════════════════════════════════════════════════
// HELPER: M-Pesa Access Token (cached)
// ═══════════════════════════════════════════════════════════════
let tokenCache = { value: null, expiresAt: 0 };

async function getAccessToken() {
    if (tokenCache.value && Date.now() < tokenCache.expiresAt) {
        logMpesa('Using cached access token');
        return tokenCache.value;
    }

    logMpesa('Requesting new M-Pesa access token from Safaricom...');

    if (!process.env.CONSUMER_KEY || !process.env.CONSUMER_SECRET) {
        logError('Cannot get token — CONSUMER_KEY or CONSUMER_SECRET is missing in .env');
        return null;
    }

    const auth = Buffer.from(`${process.env.CONSUMER_KEY}:${process.env.CONSUMER_SECRET}`).toString('base64');

    try {
        const response = await axios.get(
            "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
            { headers: { Authorization: `Basic ${auth}` }, timeout: 10000 }
        );
        const expiresIn = response.data.expires_in || 3600;
        tokenCache = {
            value:     response.data.access_token,
            expiresAt: Date.now() + (expiresIn - 60) * 1000
        };
        logOk(`M-Pesa token obtained. Valid for ${expiresIn}s`);
        return tokenCache.value;
    } catch (error) {
        logError('Failed to get M-Pesa access token', {
            httpStatus:   error.response?.status,
            errorCode:    error.response?.data?.errorCode,
            errorMessage: error.response?.data?.errorMessage,
            rawResponse:  error.response?.data
        });
        return null;
    }
}


// ═══════════════════════════════════════════════════════════════
// HELPER: Normalize phone to 254XXXXXXXXX
// ═══════════════════════════════════════════════════════════════
function normalizePhone(phone) {
    let clean = phone.replace(/\D/g, '');
    if (clean.startsWith('0'))                           clean = '254' + clean.slice(1);
    if (clean.startsWith('7') || clean.startsWith('1')) clean = '254' + clean;
    return clean;
}

// ═══════════════════════════════════════════════════════════════
// HELPER: Check if Safaricom number
// ═══════════════════════════════════════════════════════════════
function isSafaricomNumber(normalizedPhone) {
    const local = normalizedPhone.slice(3);
    const prefixes = [
        '700','701','702','703','704','705','706','707','708','709',
        '710','711','712','713','714','715','716','717','718','719',
        '720','721','722','723','724','725','726','727','728','729',
        '740','741','742','743','745','748',
        '757','758','759','768','769',
        '790','791','792','793','794','795','796','797','798','799',
        '110','111','112','113','114','115','116','117','118','119'
    ];
    return prefixes.some(p => local.startsWith(p));
}


// ═══════════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════════
app.get('/health', async (req, res) => {
    let dbStatus = 'unknown';
    try {
        await pool.query('SELECT 1');
        dbStatus = 'connected';
        logOk('Health check — DB connection OK');
    } catch (e) {
        dbStatus = 'ERROR: ' + e.message;
        logError('Health check — DB connection FAILED', { message: e.message });
    }
    const tokenSecondsLeft = tokenCache.value ? Math.round((tokenCache.expiresAt - Date.now()) / 1000) : 0;
    res.json({
        status:     'OK',
        timestamp:  new Date().toISOString(),
        database:   dbStatus,
        mpesaToken: tokenCache.value ? `cached (${tokenSecondsLeft}s remaining)` : 'not cached yet',
        env: {
            BUSINESS_SHORT_CODE: process.env.BUSINESS_SHORT_CODE || 'NOT SET',
            TILL_NUMBER:         process.env.TILL_NUMBER || 'NOT SET',
            BASE_URL:            process.env.BASE_URL || 'NOT SET',
            CONSUMER_KEY:        process.env.CONSUMER_KEY ? 'SET' : 'NOT SET',
            CONSUMER_SECRET:     process.env.CONSUMER_SECRET ? 'SET' : 'NOT SET',
            PASSKEY:             process.env.PASSKEY ? 'SET' : 'NOT SET',
        }
    });
});


// ═══════════════════════════════════════════════════════════════
// ROUTE 1: Initiate STK Push
// POST /api/initiate-payment
// Body: { phone, amount, orderId, fullName, shirtType }
// ═══════════════════════════════════════════════════════════════
app.post('/api/initiate-payment', async (req, res) => {
    logMpesa('══ NEW PAYMENT REQUEST ══════════════════════');
    logMpesa('Received body', {
        phone:     req.body.phone,
        amount:    req.body.amount,
        orderId:   req.body.orderId,
        fullName:  req.body.fullName,
        shirtType: req.body.shirtType
    });

    const { phone, amount, orderId, fullName, shirtType } = req.body;

    // Validate required fields
    if (!phone || !amount || !orderId || !fullName) {
        logWarn('Rejected — missing required fields', {
            phone: !!phone, amount: !!amount, orderId: !!orderId, fullName: !!fullName
        });
        return res.status(400).json({ success: false, message: "Missing required fields" });
    }
    if (isNaN(amount) || Number(amount) < 1) {
        logWarn('Rejected — invalid amount', { amount });
        return res.status(400).json({ success: false, message: "Invalid amount" });
    }

    // Normalize & validate phone
    const cleanPhone = normalizePhone(phone);
    logMpesa(`Phone normalized: "${phone}" → "${cleanPhone}"`);

    if (!isSafaricomNumber(cleanPhone)) {
        logWarn(`Rejected — not a Safaricom number: ${cleanPhone}`);
        return res.status(400).json({
            success: false,
            message: `"${phone}" is not a Safaricom line. M-Pesa only works on Safaricom numbers (07xx / 011x).`
        });
    }
    logOk(`Phone ${cleanPhone} confirmed as Safaricom`);

    // Get token
    const token = await getAccessToken();
    if (!token) {
        logError('Payment aborted — failed to get M-Pesa access token');
        return res.status(503).json({
            success: false,
            message: "M-Pesa service unavailable. Check CONSUMER_KEY / CONSUMER_SECRET in .env"
        });
    }

    // Build STK payload
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password  = Buffer.from(
        `${process.env.BUSINESS_SHORT_CODE}${process.env.PASSKEY}${timestamp}`
    ).toString('base64');

    const partyB = process.env.TILL_NUMBER || process.env.BUSINESS_SHORT_CODE;

    const stkPayload = {
        BusinessShortCode: process.env.BUSINESS_SHORT_CODE,
        Password:          password,
        Timestamp:         timestamp,
        TransactionType:   'CustomerBuyGoodsOnline',
        Amount:            Math.round(amount),
        PartyA:            cleanPhone,
        PartyB:            partyB,
        PhoneNumber:       cleanPhone,
        CallBackURL:       `${process.env.BASE_URL || 'https://btechplus-backend-mpesa.onrender.com'}/api/callback`,
        AccountReference:  orderId,
        TransactionDesc:   'BTECH PLUS Order'
    };

    // Log payload (no password)
    logMpesa('STK payload to Safaricom', {
        BusinessShortCode: stkPayload.BusinessShortCode,
        TransactionType:   stkPayload.TransactionType,
        Amount:            stkPayload.Amount,
        PartyA:            stkPayload.PartyA,
        PartyB:            stkPayload.PartyB,
        PhoneNumber:       stkPayload.PhoneNumber,
        CallBackURL:       stkPayload.CallBackURL,
        AccountReference:  stkPayload.AccountReference,
        Timestamp:         stkPayload.Timestamp
    });

    try {
        logMpesa('Calling Safaricom STK Push API...');
        const response = await axios.post(
            'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
            stkPayload,
            { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
        );

        logOk('Safaricom STK response', {
            MerchantRequestID:   response.data.MerchantRequestID,
            CheckoutRequestID:   response.data.CheckoutRequestID,
            ResponseCode:        response.data.ResponseCode,
            ResponseDescription: response.data.ResponseDescription,
            CustomerMessage:     response.data.CustomerMessage
        });

        const checkoutRequestID = response.data.CheckoutRequestID;

        // Save to DB
        logDb(`Inserting order | orderId: ${orderId} | checkoutRequestID: ${checkoutRequestID}`);
        await pool.query(
            `INSERT INTO btech_orders
             (order_id, checkout_request_id, customer_name, phone_number, shirt_type, amount, payment_status)
             VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')
             ON CONFLICT (order_id) DO NOTHING`,
            [orderId, checkoutRequestID, fullName, cleanPhone, shirtType || 'N/A', Math.round(amount)]
        );
        logOk(`Order inserted into DB | orderId: ${orderId}`);
        logMpesa(`✅ STK Push sent → ${cleanPhone} | KES ${amount} | orderId: ${orderId}`);

        res.json({ success: true, checkoutRequestID, message: "M-Pesa prompt sent successfully" });

    } catch (err) {
        const errData = err.response?.data;
        const errCode = errData?.errorCode || errData?.ResultCode || 'UNKNOWN';
        const errMsg  = errData?.errorMessage || errData?.ResultDesc || err.message;

        logError('STK Push FAILED — full details', {
            httpStatus:   err.response?.status || 'no response',
            errorCode:    errCode,
            errorMessage: errMsg,
            fullSafaricomResponse: errData || null,
            axiosError:   err.message
        });

        const errorMap = {
            '400.002.02':  'Invalid phone number format.',
            '404.001.04':  'Phone not registered on M-Pesa.',
            '400.002.05':  'Invalid BUSINESS_SHORT_CODE or TILL_NUMBER in .env',
            '404.001.02':  'M-Pesa temporarily unavailable. Try again.',
            '500.001.1001':'M-Pesa is down. Try later.',
            '400.002.01':  'Bad API credentials — check CONSUMER_KEY/SECRET in .env',
            '1':           'Insufficient M-Pesa balance.',
            '17':          'M-Pesa system error. Try again.',
            '26':          'M-Pesa busy. Wait and retry.',
            '1032':        'Cancelled by user.',
        };
        const userMessage = errorMap[String(errCode)]
            || `M-Pesa Gateway Error (code: ${errCode}). Check Render logs for details.`;

        res.status(500).json({ success: false, message: userMessage, code: errCode });
    }
});


// ═══════════════════════════════════════════════════════════════
// ROUTE 2: Query Payment Status (frontend polling)
// POST /api/query-payment
// Body: { checkoutRequestID }
// ═══════════════════════════════════════════════════════════════
app.post('/api/query-payment', async (req, res) => {
    const { checkoutRequestID } = req.body;

    if (!checkoutRequestID) {
        logWarn('query-payment called without checkoutRequestID');
        return res.status(400).json({ success: false, message: "Missing checkoutRequestID" });
    }

    logMpesa(`Polling | checkoutRequestID: ${checkoutRequestID}`);

    // Check DB first (fastest)
    try {
        const dbResult = await pool.query(
            'SELECT payment_status, mpesa_receipt FROM btech_orders WHERE checkout_request_id = $1',
            [checkoutRequestID]
        );
        if (dbResult.rows.length > 0) {
            const row = dbResult.rows[0];
            logDb(`DB poll result | status: ${row.payment_status} | receipt: ${row.mpesa_receipt || 'none'}`);

            if (row.payment_status === 'PAID') {
                logOk(`Payment already PAID in DB | receipt: ${row.mpesa_receipt}`);
                return res.json({ success: true, receipt: row.mpesa_receipt });
            }
            if (row.payment_status === 'FAILED') {
                logWarn('Payment already FAILED in DB');
                return res.json({ success: false, failed: true, message: "Transaction was cancelled or failed." });
            }
            logMpesa('DB status is PENDING — querying Safaricom API');
        } else {
            logWarn(`No DB row found for checkoutRequestID: ${checkoutRequestID}`);
        }
    } catch (dbErr) {
        logError('DB error during poll', { message: dbErr.message, code: dbErr.code });
    }

    // Query Safaricom directly
    const token = await getAccessToken();
    if (!token) {
        logWarn('Cannot query Safaricom — no token. Returning pending.');
        return res.json({ success: false, pending: true });
    }

    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password  = Buffer.from(
        `${process.env.BUSINESS_SHORT_CODE}${process.env.PASSKEY}${timestamp}`
    ).toString('base64');

    try {
        logMpesa('Querying Safaricom STK status...');
        const response = await axios.post(
            'https://api.safaricom.co.ke/mpesa/stkpushquery/v1/query',
            {
                BusinessShortCode: process.env.BUSINESS_SHORT_CODE,
                Password:          password,
                Timestamp:         timestamp,
                CheckoutRequestID: checkoutRequestID
            },
            { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
        );

        const resultCode = String(response.data.ResultCode);
        const resultDesc = response.data.ResultDesc;
        logMpesa(`Safaricom query response | ResultCode: ${resultCode} | ResultDesc: ${resultDesc}`);

        if (resultCode === '0') {
            logOk('Safaricom confirms payment SUCCESS — updating DB');
            await pool.query(
                `UPDATE btech_orders SET payment_status = 'PAID', updated_at = NOW()
                 WHERE checkout_request_id = $1 AND payment_status = 'PENDING'`,
                [checkoutRequestID]
            );
            const updated = await pool.query(
                'SELECT mpesa_receipt FROM btech_orders WHERE checkout_request_id = $1',
                [checkoutRequestID]
            );
            const receipt = updated.rows[0]?.mpesa_receipt || 'N/A';
            logOk(`DB updated to PAID | receipt: ${receipt}`);
            return res.json({ success: true, receipt });

        } else if (resultCode === '1032') {
            logWarn('Cancelled by user (1032)');
            await pool.query(
                `UPDATE btech_orders SET payment_status = 'FAILED', updated_at = NOW()
                 WHERE checkout_request_id = $1`,
                [checkoutRequestID]
            );
            return res.json({ success: false, failed: true, message: "You cancelled the M-Pesa request." });

        } else if (resultCode === '1037') {
            logWarn('Prompt timed out (1037) — user did not enter PIN');
            await pool.query(
                `UPDATE btech_orders SET payment_status = 'FAILED', updated_at = NOW()
                 WHERE checkout_request_id = $1`,
                [checkoutRequestID]
            );
            return res.json({ success: false, failed: true, message: "M-Pesa prompt timed out. Please try again." });

        } else {
            logMpesa(`Still pending | code: ${resultCode} | ${resultDesc}`);
            return res.json({ success: false, pending: true });
        }
    } catch (err) {
        logError('Safaricom query API error', {
            httpStatus:   err.response?.status,
            errorCode:    err.response?.data?.errorCode,
            errorMessage: err.response?.data?.errorMessage,
            axiosError:   err.message
        });
        return res.json({ success: false, pending: true });
    }
});


// ═══════════════════════════════════════════════════════════════
// ROUTE 3: M-Pesa Callback (Safaricom → Your server)
// POST /api/callback
// ═══════════════════════════════════════════════════════════════
app.post('/api/callback', async (req, res) => {
    res.status(200).send("OK"); // Must respond immediately

    logMpesa('══ CALLBACK FROM SAFARICOM ══════════════════');
    logMpesa('Full callback body', JSON.stringify(req.body, null, 2));

    try {
        const cb = req.body?.Body?.stkCallback;
        if (!cb) {
            logWarn('Callback missing stkCallback structure — ignoring');
            return;
        }

        const checkoutID = cb.CheckoutRequestID;
        const resultCode = cb.ResultCode;
        const resultDesc = cb.ResultDesc;

        logMpesa('Parsed callback', {
            CheckoutRequestID: checkoutID,
            MerchantRequestID: cb.MerchantRequestID,
            ResultCode:        resultCode,
            ResultDesc:        resultDesc
        });

        if (resultCode === 0) {
            const items   = cb.CallbackMetadata?.Item || [];
            const receipt = items.find(i => i.Name === 'MpesaReceiptNumber')?.Value;
            const amount  = items.find(i => i.Name === 'Amount')?.Value;
            const phone   = items.find(i => i.Name === 'PhoneNumber')?.Value;
            const txDate  = items.find(i => i.Name === 'TransactionDate')?.Value;

            logOk('Payment SUCCESS — metadata', { receipt, amount, phone, txDate });

            const result = await pool.query(
                `UPDATE btech_orders
                 SET payment_status = 'PAID', mpesa_receipt = $1, amount = $2, updated_at = NOW()
                 WHERE checkout_request_id = $3
                 RETURNING order_id, customer_name`,
                [receipt, amount, checkoutID]
            );

            if (result.rowCount > 0) {
                logOk(`DB updated to PAID | order: ${result.rows[0].order_id} | customer: ${result.rows[0].customer_name}`);
            } else {
                logWarn(`Callback DB update matched 0 rows | checkoutID: ${checkoutID}`);
            }

        } else {
            logWarn(`Payment FAILED/CANCELLED | code: ${resultCode} | reason: ${resultDesc}`);
            const result = await pool.query(
                `UPDATE btech_orders SET payment_status = 'FAILED', updated_at = NOW()
                 WHERE checkout_request_id = $1 RETURNING order_id`,
                [checkoutID]
            );
            logDb(`DB updated to FAILED | matched rows: ${result.rowCount}`);
        }
    } catch (err) {
        logError('Error processing callback', { message: err.message, stack: err.stack });
    }
});


// ═══════════════════════════════════════════════════════════════
// ADMIN: Get All Orders
// GET /api/admin/orders?status=PAID&limit=100&offset=0
// ═══════════════════════════════════════════════════════════════
app.get('/api/admin/orders', adminAuth, async (req, res) => {
    const { status, limit = 200, offset = 0 } = req.query;
    logDb(`Fetching orders | filter: ${status || 'ALL'} | limit: ${limit} | offset: ${offset}`);
    try {
        let query = 'SELECT * FROM btech_orders';
        const params = [];
        if (status) { params.push(status.toUpperCase()); query += ' WHERE payment_status = $1'; }
        query += ` ORDER BY created_at DESC LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}`;
        const result = await pool.query(query, params);
        logOk(`Returned ${result.rowCount} orders`);
        res.json(result.rows);
    } catch (err) {
        logError('Admin orders DB error', { message: err.message, code: err.code });
        res.status(500).json({ error: "Database error" });
    }
});


// ═══════════════════════════════════════════════════════════════
// ADMIN: Update Order Status
// PATCH /api/admin/orders/:orderId/status
// Body: { status }
// ═══════════════════════════════════════════════════════════════
app.patch('/api/admin/orders/:orderId/status', adminAuth, async (req, res) => {
    const { orderId } = req.params;
    const { status }  = req.body;
    const allowed     = ['PAID','PENDING','FAILED','DELIVERED','REFUNDED'];
    logDb(`Updating order status | order_id: ${orderId} | new status: ${status}`);
    if (!allowed.includes(status?.toUpperCase())) {
        logWarn(`Invalid status: ${status}`);
        return res.status(400).json({ error: "Invalid status value" });
    }
    try {
        const result = await pool.query(
            'UPDATE btech_orders SET payment_status = $1, updated_at = NOW() WHERE order_id = $2 RETURNING *',
            [status.toUpperCase(), orderId]
        );
        if (result.rowCount === 0) { logWarn(`Order not found: ${orderId}`); return res.status(404).json({ error: "Order not found" }); }
        logOk(`Order ${orderId} updated to ${status.toUpperCase()}`);
        res.json({ success: true, order: result.rows[0] });
    } catch (err) {
        logError('Status update DB error', { message: err.message, code: err.code });
        res.status(500).json({ error: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════
// ADMIN: Delete Order
// DELETE /api/admin/orders/:orderId
// ═══════════════════════════════════════════════════════════════
app.delete('/api/admin/orders/:orderId', adminAuth, async (req, res) => {
    const { orderId } = req.params;
    logDb(`Deleting order | order_id: ${orderId}`);
    try {
        const result = await pool.query(
            'DELETE FROM btech_orders WHERE order_id = $1 RETURNING order_id, customer_name',
            [orderId]
        );
        if (result.rowCount === 0) { logWarn(`Delete: not found order_id: ${orderId}`); return res.status(404).json({ error: "Order not found" }); }
        logOk(`Deleted | order_id: ${result.rows[0].order_id} | customer: ${result.rows[0].customer_name}`);
        res.json({ success: true, deleted: result.rows[0].order_id });
    } catch (err) {
        logError('Delete DB error', { message: err.message, code: err.code });
        res.status(500).json({ error: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════
// ADMIN: Stats Summary
// GET /api/admin/stats
// ═══════════════════════════════════════════════════════════════
app.get('/api/admin/stats', adminAuth, async (req, res) => {
    logDb('Fetching stats summary');
    try {
        const result = await pool.query(`
            SELECT
                COUNT(*) AS total_orders,
                COUNT(*) FILTER (WHERE payment_status = 'PAID')     AS paid_orders,
                COUNT(*) FILTER (WHERE payment_status = 'PENDING')  AS pending_orders,
                COUNT(*) FILTER (WHERE payment_status = 'FAILED')   AS failed_orders,
                COALESCE(SUM(amount) FILTER (WHERE payment_status = 'PAID'), 0) AS total_revenue,
                COALESCE(AVG(amount) FILTER (WHERE payment_status = 'PAID'), 0) AS avg_order_value
            FROM btech_orders
        `);
        logOk('Stats fetched', result.rows[0]);
        res.json(result.rows[0]);
    } catch (err) {
        logError('Stats DB error', { message: err.message, code: err.code });
        res.status(500).json({ error: "Database error" });
    }
});


// ═══════════════════════════════════════════════════════════════
// 404 CATCH-ALL
// ═══════════════════════════════════════════════════════════════
app.use((req, res) => {
    logWarn(`404 — Not found: ${req.method} ${req.originalUrl}`);
    res.status(404).json({ error: `Route ${req.method} ${req.originalUrl} not found` });
});


// ═══════════════════════════════════════════════════════════════
// GLOBAL ERROR HANDLER
// ═══════════════════════════════════════════════════════════════
app.use((err, req, res, next) => {
    logError('Unhandled server error', {
        message: err.message,
        stack:   err.stack,
        route:   req.originalUrl
    });
    res.status(500).json({ error: "Internal server error" });
});


// ═══════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    logOk(`Server LIVE on port ${PORT}`);
    logOk(`Callback URL: ${process.env.BASE_URL || 'https://btechplus-backend-mpesa.onrender.com'}/api/callback`);
    logInfo('Routes: GET /health | POST /api/initiate-payment | POST /api/query-payment | POST /api/callback | GET /api/admin/orders | GET /api/admin/stats | PATCH /api/admin/orders/:id/status | DELETE /api/admin/orders/:id');
});