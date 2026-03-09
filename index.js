const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// PostgreSQL Connection (The Vault)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// 1. Helper function to generate M-Pesa Access Token
const getAccessToken = async () => {
    const consumerKey = process.env.CONSUMER_KEY;
    const consumerSecret = process.env.CONSUMER_SECRET;
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

    console.log("Attempting to get M-Pesa Token...");
    try {
        const response = await axios.get("https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials", {
            headers: { Authorization: `Basic ${auth}` }
        });
        console.log("Token Received Successfully");
        return response.data.access_token;
    } catch (error) {
        console.error("AUTH ERROR DETAILS:", error.response ? error.response.data : error.message);
        return null;
    }
};

// 2. Route to Initiate STK Push
app.post('/api/initiate-payment', async (req, res) => {
    // We added fullName and shirtType to the request body here
    const { phone, amount, orderId, fullName, shirtType } = req.body; 
    
    let cleanPhone = phone.replace(/\D/g, '');
    if (cleanPhone.startsWith('0')) cleanPhone = '254' + cleanPhone.slice(1);
    if (cleanPhone.startsWith('7') || cleanPhone.startsWith('1')) cleanPhone = '254' + cleanPhone;

    const token = await getAccessToken();
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password = Buffer.from(`${process.env.BUSINESS_SHORT_CODE}${process.env.PASSKEY}${timestamp}`).toString('base64');

    const stkPayload = {
        BusinessShortCode: process.env.BUSINESS_SHORT_CODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerBuyGoodsOnline", 
        Amount: amount,
        PartyA: cleanPhone,
        PartyB: "3348765", 
        PhoneNumber: cleanPhone,
        CallBackURL: "https://btechplus-backend-mpesa.onrender.com/api/callback",
        AccountReference: orderId,
        TransactionDesc: `BTECH Order: ${shirtType}`
    };

    try {
        const response = await axios.post("https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest", stkPayload, {
            headers: { Authorization: `Bearer ${token}` }
        });

        // Now we save the REAL fullName and shirtType to DBeaver
        await pool.query(
            'INSERT INTO btech_orders (order_id, customer_name, phone_number, shirt_type, amount, payment_status) VALUES ($1, $2, $3, $4, $5, $6)',
            [orderId, fullName, cleanPhone, shirtType, amount, "PENDING"]
        );

        res.json({ success: true, checkoutRequestID: response.data.CheckoutRequestID });
    } catch (err) {
        console.error("STK ERROR:", err.response ? err.response.data : err.message);
        res.status(500).json({ success: false, message: "M-Pesa Gateway Error" });
    }
});

// 3. Callback Route (Updates DBeaver automatically)
app.post('/api/callback', async (req, res) => {
    try {
        const callbackData = req.body.Body.stkCallback;
        const checkoutID = callbackData.CheckoutRequestID;
        
        if (callbackData.ResultCode === 0) {
            const meta = callbackData.CallbackMetadata.Item;
            const receipt = meta.find(i => i.Name === 'MpesaReceiptNumber').Value;
            
            console.log(`Payment SUCCESS: ${receipt} for Order: ${checkoutID}`);

            await pool.query(
                'UPDATE btech_orders SET payment_status = $1, mpesa_receipt = $2 WHERE order_id = $3', 
                ['PAID', receipt, checkoutID]
            );
        } else {
            console.log(`Payment FAILED/CANCELLED: ${callbackData.ResultDesc}`);
            await pool.query(
                'UPDATE btech_orders SET payment_status = $1 WHERE order_id = $2', 
                ['FAILED', checkoutID]
            );
        }
    } catch (err) {
        console.error("Callback Processing Error:", err);
    }
    res.status(200).send("OK");
});


// Add this to your index.js
// ROUTE: Get all orders for the Admin Dashboard
app.get('/api/admin/orders', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM btech_orders ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: "Database error" });
    }
});

// ROUTE: Update order status (e.g., Pending -> Delivered)
// Updated Admin Route with Password Protection
app.get('/api/admin/orders', async (req, res) => {
    const adminPassword = req.headers['x-admin-password'];

    // Check if the password sent matches the one on Render
    if (adminPassword !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: "Unauthorized: Invalid Admin Password" });
    }

    try {
        const result = await pool.query('SELECT * FROM btech_orders ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: "Database error" });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`BTECH Brain Live on port ${PORT}`));