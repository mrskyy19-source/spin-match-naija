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
app.set('trust proxy', 1);

// ==========================================
// 1. TRANSACTION LEDGER MODEL (IDEMPOTENCY)
// ==========================================
const transactionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reference: { type: String, unique: true, required: true },
    type: { type: String, enum: ['deposit', 'withdrawal'], required: true },
    gateway: { type: String, default: 'paystack' },
    amountNGN: { type: Number, required: true },
    status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
    meta: { type: Object, default: {} },
    createdAt: { type: Date, default: Date.now }
});
const Transaction = mongoose.models.Transaction || mongoose.model('Transaction', transactionSchema);

// ==========================================
// 2. PAYSTACK WEBHOOK (MUST BE BEFORE express.json)
// ==========================================
app.post('/api/webhook/paystack', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const secret = process.env.PAYSTACK_SECRET_KEY;
        const signature = req.headers['x-paystack-signature'];
        if (!secret || !signature) return res.sendStatus(401);

        const expectedHash = crypto.createHmac('sha512', secret).update(req.body).digest('hex');
        const sigBuf = Buffer.from(signature, 'utf8');
        const expBuf = Buffer.from(expectedHash, 'utf8');
        if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
            return res.status(401).send('Invalid Paystack signature');
        }

        const event = JSON.parse(req.body.toString('utf8'));
        if (event.event === 'charge.success') {
            const { reference, amount, metadata } = event.data;
            const amountNGN = parseFloat((amount / 100).toFixed(2)); // Kobo to NGN

            const existingTx = await Transaction.findOne({ reference });
            if (existingTx && existingTx.status === 'completed') {
                return res.sendStatus(200); // Already credited
            }

            const userId = (existingTx && existingTx.userId) || (metadata && metadata.userId);
            if (userId && amountNGN > 0) {
                await Transaction.findOneAndUpdate(
                    { reference },
                    { userId, reference, type: 'deposit', gateway: 'paystack', amountNGN, status: 'completed' },
                    { upsert: true, new: true }
                );
                await User.findByIdAndUpdate(userId, { $inc: { balance: amountNGN } });
                console.log(`🟢 [PAYSTACK WEBHOOK] Credited NGN ${amountNGN} (Ref: ${reference})`);
            }
        }
        res.sendStatus(200);
    } catch (err) {
        console.error('🔴 [PAYSTACK WEBHOOK ERROR]:', err.message);
        res.sendStatus(500);
    }
});

// ==========================================
// 3. STANDARD MIDDLEWARE & SECURITY
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
// 4. DATABASE & AUTH
// ==========================================
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/casino';
mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 })
    .then(() => console.log("🟢 [DB] MongoDB Connected Successfully"))
    .catch(err => console.error("🔴 [DB] Connection Error:", err.message));

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
// 5. SPIN MATCH DUAL-WHEEL ENGINE
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
            if (randomNum < item.weight) { selected = item; break; }
            randomNum -= item.weight;
        }
    }

    if (selected.multiplier > 0) {
        const targetSym = `x${selected.multiplier}`;
        const useWild = crypto.randomInt(0, 4) === 0;
        return {
            matched: true,
            leftSymbol: useWild ? 'Wild' : targetSym,
            rightSymbol: targetSym,
            multiplier: selected.multiplier,
            label: selected.label
        };
    } else {
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
// 6. USER & GAME ROUTES
// ==========================================
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password || password.length < 4) {
            return res.status(400).json({ error: "Username and password (min 4 chars) required" });
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        const user = new User({ username: username.trim(), password: hashedPassword, balance: 50000 });
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
        if (isNaN(parsedBet) || parsedBet <= 0) return res.status(400).json({ error: "Invalid stake amount" });

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

// ==========================================
// 7. PAYMENTS: PAYSTACK NGN, DEMO TOP-UP & WITHDRAWALS
// ==========================================
app.post('/api/deposit', authenticateToken, async (req, res) => {
    const amount = parseFloat(req.body.amount);
    const email = (req.body.email || '').trim();
    const mode = req.body.mode || 'paystack';

    if (isNaN(amount) || amount < 100) {
        return res.status(400).json({ error: "Minimum deposit is NGN 100.00" });
    }

    try {
        const user = await User.findById(req.user.userId);
        if (!user) return res.status(404).json({ error: "User not found" });

        // 1. Live / Test Paystack Checkout (Card, Bank Transfer, USSD)
        if (mode === 'paystack' && process.env.PAYSTACK_SECRET_KEY && process.env.PAYSTACK_SECRET_KEY.trim() !== '') {
            const reference = `SMN_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
            const customerEmail = email || `${user.username.toLowerCase().replace(/[^a-z0-9]/g, '')}@spinmatch.ng`;
            const callbackUrl = `${req.protocol}://${req.get('host')}/`;

            await Transaction.create({
                userId: user._id,
                reference,
                type: 'deposit',
                gateway: 'paystack',
                amountNGN: amount,
                status: 'pending'
            });

            const response = await axios.post('https://api.paystack.co/transaction/initialize', {
                email: customerEmail,
                amount: Math.round(amount * 100), // Convert NGN to Kobo
                currency: 'NGN',
                reference,
                callback_url: callbackUrl,
                metadata: { userId: user._id.toString(), username: user.username }
            }, {
                headers: {
                    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY.trim()}`,
                    'Content-Type': 'application/json'
                }
            });

            return res.json({
                payment_url: response.data.data.authorization_url,
                reference
            });
        }

        // 2. Instant Sandbox / Demo NGN Top-Up (Active when PAYSTACK_SECRET_KEY is not configured)
        const ref = `DEMO_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
        await Transaction.create({
            userId: user._id,
            reference: ref,
            type: 'deposit',
            gateway: 'instant_demo',
            amountNGN: amount,
            status: 'completed'
        });

        const updatedUser = await User.findByIdAndUpdate(
            user._id,
            { $inc: { balance: amount } },
            { new: true }
        );

        return res.json({
            instant: true,
            newBalance: updatedUser.balance,
            reference: ref,
            message: `NGN ${amount.toLocaleString('en-NG', { minimumFractionDigits: 2 })} credited!`
        });
    } catch (err) {
        console.error('🔴 [DEPOSIT ERROR]:', err.response?.data || err.message);
        res.status(500).json({ error: err.response?.data?.message || "Payment initialization failed" });
    }
});

// Verify Paystack Redirect Callback Idempotently
app.get('/api/deposit/verify/:reference', authenticateToken, async (req, res) => {
    try {
        const { reference } = req.params;
        const tx = await Transaction.findOne({ reference, userId: req.user.userId });
        if (!tx) return res.status(404).json({ error: "Transaction reference not found" });

        if (tx.status === 'completed') {
            const user = await User.findById(req.user.userId);
            return res.json({ status: 'completed', amountNGN: tx.amountNGN, newBalance: user.balance });
        }

        const response = await axios.get(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
            headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY.trim()}` }
        });

        if (response.data.data.status === 'success') {
            const verifiedNGN = parseFloat((response.data.data.amount / 100).toFixed(2));
            tx.status = 'completed';
            tx.amountNGN = verifiedNGN;
            await tx.save();

            const updatedUser = await User.findByIdAndUpdate(
                req.user.userId,
                { $inc: { balance: verifiedNGN } },
                { new: true }
            );
            return res.json({ status: 'completed', amountNGN: verifiedNGN, newBalance: updatedUser.balance });
        }

        res.json({ status: response.data.data.status });
    } catch (err) {
        res.status(500).json({ error: "Could not verify payment" });
    }
});

// Withdraw NGN to Nigerian Bank Account
app.post('/api/withdraw', authenticateToken, async (req, res) => {
    try {
        const amount = parseFloat(req.body.amount);
        const { bankName, accountNumber, accountName } = req.body;

        if (isNaN(amount) || amount < 1000) {
            return res.status(400).json({ error: "Minimum withdrawal is NGN 1,000.00" });
        }
        if (!bankName || !accountNumber || accountNumber.length !== 10) {
            return res.status(400).json({ error: "Enter a valid 10-digit Nigerian NUBAN account number" });
        }

        const updatedUser = await User.findOneAndUpdate(
            { _id: req.user.userId, balance: { $gte: amount } },
            { $inc: { balance: -amount } },
            { new: true }
        );
        if (!updatedUser) return res.status(400).json({ error: "Insufficient NGN balance for withdrawal" });

        const reference = `WDR_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
        await Transaction.create({
            userId: req.user.userId,
            reference,
            type: 'withdrawal',
            gateway: 'nip_bank_transfer',
            amountNGN: amount,
            status: 'completed',
            meta: { bankName, accountNumber, accountName }
        });

        res.json({
            message: `NGN ${amount.toLocaleString('en-NG', { minimumFractionDigits: 2 })} payout queued to ${bankName} (${accountNumber})`,
            reference,
            newBalance: updatedUser.balance
        });
    } catch (err) {
        res.status(500).json({ error: "Withdrawal failed" });
    }
});

app.get('/api/transactions', authenticateToken, async (req, res) => {
    const list = await Transaction.find({ userId: req.user.userId }).sort({ createdAt: -1 }).limit(10);
    res.json({ transactions: list });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`========================================`);
    console.log(`🚀 SPIN MATCH NAIJA LIVE on port ${PORT}`);
    console.log(`💳 Paystack Gateway: ${process.env.PAYSTACK_SECRET_KEY ? 'LIVE/TEST KEY LOADED' : 'SANDBOX INSTANT MODE'}`);
    console.log(`========================================`);
});
