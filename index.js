// ═══════════════════════════════════════════════════════════════
// BTECH PLUS — Backend Server (server.js)
// M-Pesa STK Push + PostgreSQL + Admin API
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { Pool }  = require('pg');
const axios     = require('axios');
const cors      = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors({
    origin: '*', // Lock this down to your domain in production
    methods: ['GET','POST','PATCH','DELETE'],
    allowedHeaders: ['Content-Type','x-admin-password']
}));

// ─────────────────────────────────────────────────────────────
// DATABASE
// ─────────────────────────────────────────────────────────────
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

// Auto-create table on startup if it doesn't exist
pool.query(`
    CREATE TABLE IF NOT EXISTS btech_orders (
        id                  SERIAL PRIMARY KEY,
        order_id            VARCHAR(100) UNIQUE NOT NULL,
        checkout_request_id VARCHAR(200),
        customer_name       VARCHAR(200),
        phone_number        VARCHAR(20),
        shirt_type          TEXT,
        amount              INTEGER NOT NULL,
        payment_status      VARCHAR(20) DEFAULT 'PENDING',
        mpesa_receipt       VARCHAR(100),
        created_at          TIMESTAMP DEFAULT NOW(),
        updated_at          TIMESTAMP DEFAULT NOW()
    );
`).then(() => console.log('✅ DB table ready'))
  .catch(err => console.error('❌ DB table error:', err.message));


// ─────────────────────────────────────────────────────────────
// ADMIN MIDDLEWARE
// ─────────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
    const provided = req.headers['x-admin-password'];
    if (!provided || provided !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: "Unauthorized: Invalid Admin Password" });
    }
    next();
}

// ─────────────────────────────────────────────────────────────
// HELPER: Get M-Pesa Access Token (with caching)
// ─────────────────────────────────────────────────────────────
let tokenCache = { value: null, expiresAt: 0 };

async function getAccessToken() {
    if (tokenCache.value && Date.now() < tokenCache.expiresAt) {
        return tokenCache.value;
    }
    const auth = Buffer.from(`${process.env.CONSUMER_KEY}:${process.env.CONSUMER_SECRET}`).toString('base64');
    try {
        const response = await axios.get(
            "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
            { headers: { Authorization: `Basic ${auth}` }, timeout: 10000 }
        );
        tokenCache = {
            value: response.data.access_token,
            expiresAt: Date.now() + (response.data.expires_in - 60) * 1000
        };
        console.log("✅ M-Pesa Token Refreshed");
        return tokenCache.value;
    } catch (error) {
        console.error("❌ Token Error:", error.response?.data || error.message);
        return null;
    }
}

// ─────────────────────────────────────────────────────────────
// HELPER: Normalize Kenyan phone number
// ─────────────────────────────────────────────────────────────
function normalizePhone(phone) {
    let clean = phone.replace(/\D/g, '');
    if (clean.startsWith('0'))   clean = '254' + clean.slice(1);
    if (clean.startsWith('7') || clean.startsWith('1')) clean = '254' + clean;
    return clean;
}

// ─────────────────────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString(), service: 'BTECH PLUS Backend' });
});

// ─────────────────────────────────────────────────────────────
// ROUTE 1: Initiate STK Push
// POST /api/initiate-payment
// Body: { phone, amount, orderId, fullName, shirtType }
// ─────────────────────────────────────────────────────────────
app.post('/api/initiate-payment', async (req, res) => {
    const { phone, amount, orderId, fullName, shirtType } = req.body;

    // Validate inputs
    if (!phone || !amount || !orderId || !fullName) {
        return res.status(400).json({ success: false, message: "Missing required fields" });
    }
    if (isNaN(amount) || amount < 1) {
        return res.status(400).json({ success: false, message: "Invalid amount" });
    }

    const cleanPhone = normalizePhone(phone);
    const token      = await getAccessToken();
    if (!token) {
        return res.status(503).json({ success: false, message: "M-Pesa service unavailable. Try again." });
    }

    const timestamp  = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password   = Buffer.from(`${process.env.BUSINESS_SHORT_CODE}${process.env.PASSKEY}${timestamp}`).toString('base64');

    const stkPayload = {
        BusinessShortCode: process.env.BUSINESS_SHORT_CODE,
        Password:          password,
        Timestamp:         timestamp,
        TransactionType:   "CustomerBuyGoodsOnline",
        Amount:            Math.round(amount),
        PartyA:            cleanPhone,
        PartyB:            process.env.TILL_NUMBER || process.env.BUSINESS_SHORT_CODE,
        PhoneNumber:       cleanPhone,
        CallBackURL:       `${process.env.BASE_URL || 'https://btechplus-backend-mpesa.onrender.com'}/api/callback`,
        AccountReference:  orderId,
        TransactionDesc:   `BTECH PLUS Order`
    };

    try {
        const response = await axios.post(
            "https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
            stkPayload,
            { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
        );

        const checkoutRequestID = response.data.CheckoutRequestID;

        // Save to DB
        await pool.query(
            `INSERT INTO btech_orders 
             (order_id, checkout_request_id, customer_name, phone_number, shirt_type, amount, payment_status)
             VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')
             ON CONFLICT (order_id) DO NOTHING`,
            [orderId, checkoutRequestID, fullName, cleanPhone, shirtType || 'N/A', Math.round(amount)]
        );

        console.log(`📲 STK Push sent → ${cleanPhone} | Order: ${orderId} | KES ${amount}`);
        res.json({ success: true, checkoutRequestID, message: "M-Pesa prompt sent successfully" });

    } catch (err) {
        const errData = err.response?.data;
        console.error("❌ STK Error:", errData || err.message);

        // Friendly error messages
        let userMessage = "M-Pesa Gateway Error. Try again.";
        if (errData?.errorCode === "400.002.02") userMessage = "Invalid phone number format.";
        if (errData?.errorCode === "404.001.04") userMessage = "Customer could not be found. Check the phone number.";

        res.status(500).json({ success: false, message: userMessage });
    }
});

// ─────────────────────────────────────────────────────────────
// ROUTE 2: Query Payment Status (Polling)
// POST /api/query-payment
// Body: { checkoutRequestID }
// ─────────────────────────────────────────────────────────────
app.post('/api/query-payment', async (req, res) => {
    const { checkoutRequestID } = req.body;
    if (!checkoutRequestID) {
        return res.status(400).json({ success: false, message: "Missing checkoutRequestID" });
    }

    // First check our own DB (faster than Safaricom API)
    try {
        const dbResult = await pool.query(
            'SELECT payment_status, mpesa_receipt FROM btech_orders WHERE checkout_request_id = $1',
            [checkoutRequestID]
        );
        if (dbResult.rows.length > 0) {
            const row = dbResult.rows[0];
            if (row.payment_status === 'PAID') {
                return res.json({ success: true, receipt: row.mpesa_receipt });
            }
            if (row.payment_status === 'FAILED') {
                return res.json({ success: false, failed: true, message: "Transaction was cancelled or failed." });
            }
        }
    } catch (dbErr) {
        console.error("DB query error:", dbErr.message);
    }

    // Fallback: Query Safaricom API directly
    const token = await getAccessToken();
    if (!token) return res.json({ success: false, pending: true });

    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password  = Buffer.from(`${process.env.BUSINESS_SHORT_CODE}${process.env.PASSKEY}${timestamp}`).toString('base64');

    try {
        const response = await axios.post(
            "https://api.safaricom.co.ke/mpesa/stkpushquery/v1/query",
            {
                BusinessShortCode: process.env.BUSINESS_SHORT_CODE,
                Password:          password,
                Timestamp:         timestamp,
                CheckoutRequestID: checkoutRequestID
            },
            { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
        );

        const resultCode = response.data.ResultCode;
        if (resultCode === 0 || resultCode === "0") {
            // Payment succeeded — update DB
            await pool.query(
                `UPDATE btech_orders SET payment_status = 'PAID', updated_at = NOW() 
                 WHERE checkout_request_id = $1 AND payment_status = 'PENDING'`,
                [checkoutRequestID]
            );
            const updatedRow = await pool.query(
                'SELECT mpesa_receipt FROM btech_orders WHERE checkout_request_id = $1',
                [checkoutRequestID]
            );
            return res.json({ success: true, receipt: updatedRow.rows[0]?.mpesa_receipt || 'N/A' });
        } else if (resultCode === 1032) {
            // Cancelled by user
            await pool.query(
                `UPDATE btech_orders SET payment_status = 'FAILED', updated_at = NOW() 
                 WHERE checkout_request_id = $1`,
                [checkoutRequestID]
            );
            return res.json({ success: false, failed: true, message: "You cancelled the M-Pesa request." });
        } else {
            return res.json({ success: false, pending: true });
        }
    } catch (err) {
        console.error("Query error:", err.response?.data || err.message);
        return res.json({ success: false, pending: true });
    }
});

// ─────────────────────────────────────────────────────────────
// ROUTE 3: M-Pesa Callback (Safaricom → Your Server)
// POST /api/callback
// ─────────────────────────────────────────────────────────────
app.post('/api/callback', async (req, res) => {
    res.status(200).send("OK"); // Always respond 200 to Safaricom first

    try {
        const cb  = req.body?.Body?.stkCallback;
        if (!cb) return;

        const checkoutID = cb.CheckoutRequestID;
        console.log(`📩 Callback received | Code: ${cb.ResultCode} | ID: ${checkoutID}`);

        if (cb.ResultCode === 0) {
            const meta    = cb.CallbackMetadata.Item;
            const receipt = meta.find(i => i.Name === 'MpesaReceiptNumber')?.Value;
            const amount  = meta.find(i => i.Name === 'Amount')?.Value;

            await pool.query(
                `UPDATE btech_orders 
                 SET payment_status = 'PAID', mpesa_receipt = $1, amount = $2, updated_at = NOW()
                 WHERE checkout_request_id = $3`,
                [receipt, amount, checkoutID]
            );
            console.log(`✅ Payment CONFIRMED: ${receipt} | KES ${amount}`);
        } else {
            await pool.query(
                `UPDATE btech_orders 
                 SET payment_status = 'FAILED', updated_at = NOW()
                 WHERE checkout_request_id = $1`,
                [checkoutID]
            );
            console.log(`❌ Payment FAILED/CANCELLED: ${cb.ResultDesc}`);
        }
    } catch (err) {
        console.error("❌ Callback Error:", err.message);
    }
});

// ─────────────────────────────────────────────────────────────
// ADMIN ROUTE 1: Get All Orders
// GET /api/admin/orders
// ─────────────────────────────────────────────────────────────
app.get('/api/admin/orders', adminAuth, async (req, res) => {
    try {
        const { status, limit = 200, offset = 0 } = req.query;
        let query  = 'SELECT * FROM btech_orders';
        const params = [];
        if (status) {
            params.push(status.toUpperCase());
            query += ` WHERE payment_status = $1`;
        }
        query += ` ORDER BY created_at DESC LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}`;
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Database error" });
    }
});

// ─────────────────────────────────────────────────────────────
// ADMIN ROUTE 2: Update Order Status
// PATCH /api/admin/orders/:id/status
// Body: { status: "PAID" | "PENDING" | "FAILED" | "DELIVERED" }
// ─────────────────────────────────────────────────────────────
app.patch('/api/admin/orders/:id/status', adminAuth, async (req, res) => {
    const { id }     = req.params;
    const { status } = req.body;
    const allowed    = ['PAID','PENDING','FAILED','DELIVERED','REFUNDED'];
    if (!allowed.includes(status?.toUpperCase())) {
        return res.status(400).json({ error: "Invalid status value" });
    }
    try {
        const result = await pool.query(
            `UPDATE btech_orders SET payment_status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
            [status.toUpperCase(), id]
        );
        if (result.rowCount === 0) return res.status(404).json({ error: "Order not found" });
        res.json({ success: true, order: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: "Database error" });
    }
});

// ─────────────────────────────────────────────────────────────
// ADMIN ROUTE 3: Delete Order
// DELETE /api/admin/orders/:id
// ─────────────────────────────────────────────────────────────
app.delete('/api/admin/orders/:id', adminAuth, async (req, res) => {
    try {
        const result = await pool.query('DELETE FROM btech_orders WHERE id = $1 RETURNING id', [req.params.id]);
        if (result.rowCount === 0) return res.status(404).json({ error: "Order not found" });
        res.json({ success: true, deleted: result.rows[0].id });
    } catch (err) {
        res.status(500).json({ error: "Database error" });
    }
});

// ─────────────────────────────────────────────────────────────
// ADMIN ROUTE 4: Stats Summary
// GET /api/admin/stats
// ─────────────────────────────────────────────────────────────
app.get('/api/admin/stats', adminAuth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                COUNT(*)                                             AS total_orders,
                COUNT(*) FILTER (WHERE payment_status = 'PAID')    AS paid_orders,
                COUNT(*) FILTER (WHERE payment_status = 'PENDING') AS pending_orders,
                COUNT(*) FILTER (WHERE payment_status = 'FAILED')  AS failed_orders,
                COALESCE(SUM(amount) FILTER (WHERE payment_status = 'PAID'), 0) AS total_revenue,
                COALESCE(AVG(amount) FILTER (WHERE payment_status = 'PAID'), 0) AS avg_order_value
            FROM btech_orders
        `);
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: "Database error" });
    }
});

// ─────────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════╗
║   BTECH PLUS Backend is LIVE 🚀      ║
║   Port: ${PORT}                       ║
║   M-Pesa: Production (Safaricom)     ║
╚══════════════════════════════════════╝
    `);
});