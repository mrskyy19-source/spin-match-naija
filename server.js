require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const User = require('./models/User');

const app = express();

// Required for Render / cloud reverse proxies
app.set('trust proxy', 1);

// ==========================================
// 1. MIDDLEWARE & SECURITY
// ==========================================
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(morgan('dev'));

const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 180,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please slow down." }
});
app.use('/api/', apiLimiter);

// ==========================================
// 2. DATABASE CONNECTION
// ==========================================
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/casino';
mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 })
    .then(() => console.log("🟢 [DB] MongoDB Connected Successfully"))
    .catch(err => console.error("🔴 [DB] Connection Error:", err.message));

// ==========================================
// 3. AUTHENTICATION MIDDLEWARE
// ==========================================
const JWT_SECRET = process.env.JWT_SECRET || 'elite_spin_naija_secret_2026';

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Unauthorized: Please sign in" });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: "Session expired: Please sign in again" });
        req.user = user;
        next();
    });
};

// ==========================================
// 4. SPIN MATCH DUAL-WHEEL ENGINE
// ==========================================
const wheelSymbols = ['x2', 'x4', 'x6', 'x15', 'x24', 'x54', 'Wild'];

const matchOutcomes = [
    { label: "NO MATCH", multiplier: 0,  weight: 5600 },
    { label: "x2 MATCH", multiplier: 2,  weight: 2200 },
    { label: "x4 MATCH", multiplier: 4,  weight: 1100 },
    { label: "x6 MATCH", multiplier: 6,  weight: 600 },
    { label: "x15 MATCH", multiplier: 15, weight: 320 },
    { label: "x24 MATCH", multiplier: 24, weight: 130 },
    { label: "x54 JACKPOT", multiplier: 54, weight: 50 }
];

function generateSpinMatch(user) {
    let selected;

    if (user.winRateOverride !== null && user.winRateOverride !== undefined) {
        selected = Math.random() < user.winRateOverride
            ? matchOutcomes[matchOutcomes.length - 1]
            : matchOutcomes[0];
    } else {
        const totalWeight = matchOutcomes.reduce((sum, item) => sum + item.weight, 0);
        const secureHex = crypto.randomBytes(4).toString('hex');
        let randomNum = parseInt(secureHex, 16) % totalWeight;

        for (const item of matchOutcomes) {
            if (randomNum < item.weight) {
                selected = item;
                break;
            }
            randomNum -= item.weight;
        }
    }

    if (selected.multiplier > 0) {
        const targetSym = `x${selected.multiplier}`;
        // Either exact symbol match or Wild + target symbol
        const useWild = crypto.randomInt(0, 4) === 0;
        const leftSymbol = useWild ? 'Wild' : targetSym;
        const rightSymbol = targetSym;
        return {
            matched: true,
            leftSymbol,
            rightSymbol,
            multiplier: selected.multiplier,
            label: selected.label
        };
    } else {
        // Pick two non-matching symbols (never double Wild)
        const nonWild = wheelSymbols.filter(s => s !== 'Wild');
        const leftIdx = crypto.randomInt(0, nonWild.length);
        let rightIdx = crypto.randomInt(0, nonWild.length - 1);
        if (rightIdx >= leftIdx) rightIdx++;
        return {
            matched: false,
            leftSymbol: nonWild[leftIdx],
            rightSymbol: nonWild[rightIdx],
            multiplier: 0,
            label: "NO MATCH"
        };
    }
}

// ==========================================
// 5. API ROUTES
// ==========================================
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password || password.length < 4) {
            return res.status(400).json({ error: "Username and password (min 4 chars) required" });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const user = new User({
            username: username.trim(),
            password: hashedPassword,
            balance: 50000 // NGN 50,000 welcome balance
        });

        await user.save();
        const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' });
        res.status(201).json({ message: "Account created", token, balance: user.balance, username: user.username });
    } catch (e) {
        res.status(400).json({ error: "Username already taken" });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username: (username || '').trim() });
        if (!user || !(await bcrypt.compare(password || '', user.password))) {
            return res.status(401).json({ error: "Invalid username or password" });
        }

        const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, balance: user.balance, username: user.username });
    } catch (e) {
        res.status(500).json({ error: "Login failed" });
    }
});

app.get('/api/balance', authenticateToken, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId).select('balance username');
        if (!user) return res.status(404).json({ error: "User not found" });
        res.json({ balance: user.balance, username: user.username });
    } catch (e) {
        res.status(500).json({ error: "Failed to fetch balance" });
    }
});

app.post('/api/spin', authenticateToken, async (req, res) => {
    try {
        const parsedBet = parseFloat(req.body.bet);
        if (isNaN(parsedBet) || parsedBet <= 0) {
            return res.status(400).json({ error: "Invalid stake amount" });
        }

        const user = await User.findById(req.user.userId);
        if (!user) return res.status(404).json({ error: "User not found" });
        if (parsedBet > user.balance) return res.status(400).json({ error: "Insufficient NGN balance" });

        const result = generateSpinMatch(user);
        const winAmount = parseFloat((parsedBet * result.multiplier).toFixed(2));

        const updatedUser = await User.findOneAndUpdate(
            { _id: user._id, balance: { $gte: parsedBet } },
            { $inc: { balance: winAmount - parsedBet } },
            { new: true }
        );

        if (!updatedUser) return res.status(400).json({ error: "Transaction conflict, try again" });

        res.json({
            outcome: result.label,
            matched: result.matched,
            leftSymbol: result.leftSymbol,
            rightSymbol: result.rightSymbol,
            multiplier: result.multiplier,
            winAmount,
            newBalance: updatedUser.balance
        });
    } catch (e) {
        res.status(500).json({ error: "Spin failed to process" });
    }
});

// Fixed Deposit Route: Uses NOWPayments if API key is configured, otherwise credits instant NGN top-up
app.post('/api/deposit', authenticateToken, async (req, res) => {
    const amount = parseFloat(req.body.amount);
    if (isNaN(amount) || amount < 100) {
        return res.status(400).json({ error: "Minimum deposit is NGN 100.00" });
    }

    try {
        if (process.env.NOWPAYMENTS_API_KEY && process.env.NOWPAYMENTS_API_KEY.trim() !== '') {
            const response = await axios.post('https://api.nowpayments.io/v1/payment', {
                price_amount: amount,
                price_currency: 'ngn',
                pay_currency: 'usdttrc20',
                order_id: req.user.userId,
                order_description: "Spin Match NGN Deposit"
            }, {
                headers: { 'x-api-key': process.env.NOWPAYMENTS_API_KEY }
            });
            return res.json({ payment_url: response.data.invoice_url, payment_id: response.data.payment_id });
        }

        // Instant NGN Sandbox / Local Top-Up when no external gateway key is set
        const updatedUser = await User.findByIdAndUpdate(
            req.user.userId,
            { $inc: { balance: amount } },
            { new: true }
        );
        return res.json({
            instant: true,
            newBalance: updatedUser.balance,
            message: `NGN ${amount.toLocaleString('en-NG', { minimumFractionDigits: 2 })} credited instantly!`
        });
    } catch (e) {
        res.status(500).json({ error: "Deposit processing failed" });
    }
});

app.post('/api/webhook/nowpayments', async (req, res) => {
    try {
        const sig = req.headers['x-nowpayments-sig'];
        if (!sig) return res.status(400).json({ error: "Missing signature" });

        const hmac = crypto.createHmac('sha512', process.env.NOWPAYMENTS_IPN_SECRET || '');
        hmac.update(JSON.stringify(req.body));
        if (hmac.digest('hex') !== sig) return res.status(403).json({ error: "Invalid signature" });

        const { payment_status, order_id, price_amount } = req.body;
        if (payment_status === 'finished') {
            await User.findByIdAndUpdate(order_id, { $inc: { balance: parseFloat(price_amount) } });
        }
        res.sendStatus(200);
    } catch (e) {
        res.status(500).send("Webhook Error");
    }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`========================================`);
    console.log(`🚀 SPIN MATCH NAIJA LIVE on port ${PORT}`);
    console.log(`========================================`);
});
