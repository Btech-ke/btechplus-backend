const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// 1. Function to get M-Pesa Access Token
const getAccessToken = async () => {
    const auth = Buffer.from(`${process.env.CONSUMER_KEY}:${process.env.CONSUMER_SECRET}`).toString('base64');
    try {
        const res = await axios.get("https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials", {
            headers: { Authorization: `Basic ${auth}` }
        });
        return res.data.access_token;
    } catch (err) { console.error("Auth Error"); }
};

// 2. Real STK Push Route
app.post('/api/initiate-payment', async (req, res) => {
    const { phone, amount, orderId } = req.body;
    
    // Format phone to 254...
    let cleanPhone = phone.replace(/\D/g, '');
    if (cleanPhone.startsWith('0')) cleanPhone = '254' + cleanPhone.slice(1);
    
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
        PartyB: process.env.BUSINESS_SHORT_CODE,
        PhoneNumber: cleanPhone,
        CallBackURL: "https://btechplus-backend-mpesa.onrender.com/api/callback",
        AccountReference: orderId,
        TransactionDesc: "BTECH PLUS Order"
    };

    try {
        const response = await axios.post("https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest", stkPayload, {
            headers: { Authorization: `Bearer ${token}` }
        });

        // Save PENDING order to DBeaver
        await pool.query(
            'INSERT INTO btech_orders (order_id, customer_name, phone_number, shirt_type, amount, payment_status) VALUES ($1, $2, $3, $4, $5, $6)',
            [orderId, "BTECH Customer", cleanPhone, "Branded Shirt", amount, "PENDING"]
        );

        res.json({ success: true, checkoutRequestID: response.data.CheckoutRequestID });
    } catch (err) {
        res.status(500).json({ success: false, message: "M-Pesa Gateway Error" });
    }
});

// 3. Callback Route (Safaricom calls this when PIN is entered)
app.post('/api/callback', async (req, res) => {
    const callbackData = req.body.Body.stkCallback;
    if (callbackData.ResultCode === 0) {
        const receipt = callbackData.CallbackMetadata.Item.find(i => i.Name === 'MpesaReceiptNumber').Value;
        const checkoutID = callbackData.CheckoutRequestID;
        
        // Update DBeaver to PAID
        await pool.query('UPDATE btech_orders SET payment_status = $1, mpesa_receipt = $2 WHERE order_id = $3', 
            ['PAID', receipt, checkoutID]);
    }
    res.send("Received");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`BTECH Brain Live on ${PORT}`));