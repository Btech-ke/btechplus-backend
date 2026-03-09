const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// Connect to your Render Database (DBeaver Vault)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ROUTE 1: Trigger M-Pesa STK Push
app.post('/api/initiate-payment', async (req, res) => {
    const { phone, amount, orderId } = req.body;
    
    // For now, we will simulate the successful response so you can test the frontend
    // Later, we will add the real Safaricom Daraja live code here
    try {
        await pool.query(
            'INSERT INTO btech_orders (order_id, customer_name, phone_number, shirt_type, amount) VALUES ($1, $2, $3, $4, $5)',
            [orderId, "Web Customer", phone, "BTECH Branded", amount]
        );
        
        res.json({ success: true, message: "Prompt sent to phone!", checkoutRequestID: "ws_CO_000000" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: "Database Error" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`BTECH Brain running on port ${PORT}`));