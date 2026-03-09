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
    const { phone, amount, orderId } = req.body;
    
    // Format phone to 254...
    let cleanPhone = phone.replace(/\D/g, '');
    if (cleanPhone.startsWith('0')) cleanPhone = '254' + cleanPhone.slice(1);
    if (cleanPhone.startsWith('7') || cleanPhone.startsWith('1')) cleanPhone = '254' + cleanPhone;

    const token = await getAccessToken();
    if (!token) return res.status(500).json({ success: false, message: "Authentication failed" });

    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    
    // Password uses Shortcode (4560085) + Passkey + Timestamp
    const shortCode = process.env.BUSINESS_SHORT_CODE;
    const passkey = process.env.PASSKEY;
    const password = Buffer.from(`${shortCode}${passkey}${timestamp}`).toString('base64');

    const stkPayload = {
        BusinessShortCode: shortCode, // 4560085
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerBuyGoodsOnline", 
        Amount: amount,
        PartyA: cleanPhone,
        PartyB: "3348765", // YOUR ACTUAL TILL NUMBER
        PhoneNumber: cleanPhone,
        CallBackURL: "https://btechplus-backend-mpesa.onrender.com/api/callback",
        AccountReference: orderId,
        TransactionDesc: "BTECH PLUS Order"
    };

    console.log(`Sending STK Push to ${cleanPhone} for Till 3348765...`);

    try {
        const response = await axios.post("https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest", stkPayload, {
            headers: { Authorization: `Bearer ${token}` }
        });

        // Save initial PENDING order to DBeaver
        await pool.query(
            'INSERT INTO btech_orders (order_id, customer_name, phone_number, shirt_type, amount, payment_status) VALUES ($1, $2, $3, $4, $5, $6)',
            [orderId, "Web Customer", cleanPhone, "Branded Shirt", amount, "PENDING"]
        );

        res.status(200).json({ 
            success: true, 
            checkoutRequestID: response.data.CheckoutRequestID,
            message: "Prompt sent to phone" 
        });

    } catch (error) {
        console.error("STK ERROR DETAILS:", error.response ? error.response.data : error.message);
        res.status(500).json({ 
            success: false, 
            message: "M-Pesa Gateway Error",
            details: error.response ? error.response.data.errorMessage : error.message 
        });
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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`BTECH Brain Live on port ${PORT}`));