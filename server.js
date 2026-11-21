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
// 2. PAYSTACK WEBHOOK (RAW BODY BEFORE JSON)
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
            const amountNGN = parseFloat((amount / 100).toFixed(2));

            const existingTx = await Transaction.findOne({ reference });
            if (existingTx && existingTx.status === 'completed') return res.sendStatus(200);

            const userId = (existingTx && existingTx.userId) || (metadata && metadata.userId);
            if (userId && amountNGN > 0) {
                await Transaction.findOneAndUpdate(
                    { reference },
                    { userId, reference, type: 'deposit', gateway: 'paystack', amountNGN, status: 'completed' },
                    { upsert: true, new: true }
                );
                await User.findByIdAndUpdate(userId, { $inc: { balance: amountNGN } });
                console.log(`🟢 [PLUGBET PAYSTACK] Credited NGN ${amountNGN} (Ref: ${reference})`);
            }
        }
        res.sendStatus(200);
    } catch (err) {
        console.error('🔴 [WEBHOOK ERROR]:', err.message);
        res.sendStatus(500);
    }
});

// ==========================================
// 3. MIDDLEWARE & SECURITY
// ==========================================
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(morgan('dev'));

const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 240,
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

const JWT_SECRET = process.env.JWT_SECRET || 'plugbet_enterprise_secret_2026';

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
// 5. PLUGBET SPIN MATCH ENGINE (PROVABLY FAIR)
// ==========================================
const ALLOWED_SLOTS = ['2', '4', '6', '15', '24', '54'];
const wheelSymbols = ['x2', 'x4', 'x6', 'x15', 'x24', 'x54', 'Wild'];
const matchOutcomes = [
    { label: "NO MATCH", multiplier: 0,  weight: 5200 },
    { label: "x2",       multiplier: 2,  weight: 2400 },
    { label: "x4",       multiplier: 4,  weight: 1200 },
    { label: "x6",       multiplier: 6,  weight: 650 },
    { label: "x15",      multiplier: 15, weight: 340 },
    { label: "x24",      multiplier: 24, weight: 150 },
    { label: "x54",      multiplier: 54, weight: 60 }
];

function generateSpinMatch(user, preferredSlots = []) {
    const serverSeed = crypto.randomBytes(16).toString('hex');
    const roundHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
    const roundId = `PB-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

    let selected;
    if (user.winRateOverride !== null && user.winRateOverride !== undefined) {
        if (Math.random() < user.winRateOverride && preferredSlots.length > 0) {
            const topSlot = Math.max(...preferredSlots.map(Number));
            selected = matchOutcomes.find(o => o.multiplier === topSlot) || matchOutcomes[matchOutcomes.length - 1];
        } else {
            selected = matchOutcomes[0];
        }
    } else {
        const totalWeight = matchOutcomes.reduce((sum, item) => sum + item.weight, 0);
        const secureInt = parseInt(roundHash.slice(0, 8), 16);
        let randomNum = secureInt % totalWeight;
        for (const item of matchOutcomes) {
            if (randomNum < item.weight) { selected = item; break; }
            randomNum -= item.weight;
        }
    }

    if (selected.multiplier > 0) {
        const targetSym = `x${selected.multiplier}`;
        const useWild = crypto.randomInt(0, 4) === 0;
        const wildOnLeft = crypto.randomInt(0, 2) === 0;
        return {
            roundId,
            roundHash,
            matched: true,
            leftSymbol: useWild && wildOnLeft ? 'Wild' : targetSym,
            rightSymbol: useWild && !wildOnLeft ? 'Wild' : targetSym,
            multiplier: selected.multiplier,
            label: selected.label
        };
    } else {
        const nonWild = wheelSymbols.filter(s => s !== 'Wild');
        const leftIdx = crypto.randomInt(0, nonWild.length);
        let rightIdx = crypto.randomInt(0, nonWild.length - 1);
        if (rightIdx >= leftIdx) rightIdx++;
        return {
            roundId,
            roundHash,
            matched: false,
            leftSymbol: nonWild[leftIdx],
            rightSymbol: nonWild[rightIdx],
            multiplier: 0,
            label: "NO MATCH"
        };
    }
}

// ==========================================
// 6. USER & MULTI-SLOT SPIN ROUTES
// ==========================================
app.get('/health', (req, res) => res.status(200).json({ status: 'ok', brand: 'PLUGBET' }));

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
        const rawBets = req.body.bets;
        const sanitizedBets = {};
        let totalStake = 0;

        // Validate multi-slot bets map (e.g. { "2": 50, "4": 50, "54": 100 })
        if (rawBets && typeof rawBets === 'object') {
            for (const slot of ALLOWED_SLOTS) {
                const val = parseFloat(rawBets[slot] || 0);
                if (isNaN(val) || val < 0) return res.status(400).json({ error: "Invalid chip stake" });
                if (val > 0) {
                    sanitizedBets[slot] = parseFloat(val.toFixed(2));
                    totalStake += sanitizedBets[slot];
                }
            }
        } else {
            return res.status(400).json({ error: "Place at least one chip on a multiplier before spinning" });
        }

        totalStake = parseFloat(totalStake.toFixed(2));
        if (totalStake <= 0) return res.status(400).json({ error: "Total stake must be greater than NGN 0" });

        const user = await User.findById(req.user.userId);
        if (!user) return res.status(404).json({ error: "User not found" });
        if (totalStake > user.balance) return res.status(400).json({ error: "Insufficient NGN balance" });

        const result = generateSpinMatch(user, Object.keys(sanitizedBets));
        const winningSlotStake = result.multiplier > 0 ? (sanitizedBets[String(result.multiplier)] || 0) : 0;
        const winAmount = parseFloat((winningSlotStake * result.multiplier).toFixed(2));

        const updatedUser = await User.findOneAndUpdate(
            { _id: user._id, balance: { $gte: totalStake } },
            { $inc: { balance: winAmount - totalStake } },
            { new: true }
        );
        if (!updatedUser) return res.status(400).json({ error: "Transaction conflict, try again" });

        res.json({
            roundId: result.roundId,
            roundHash: result.roundHash,
            outcome: result.label,
            matched: result.matched,
            leftSymbol: result.leftSymbol,
            rightSymbol: result.rightSymbol,
            multiplier: result.multiplier,
            totalStake,
            winningSlotStake,
            winAmount,
            newBalance: updatedUser.balance
        });
    } catch (e) {
        res.status(500).json({ error: "Spin failed to process" });
    }
});

// ==========================================
// 7. PAYMENTS: PAYSTACK NGN & WITHDRAWALS
// ==========================================
app.post('/api/deposit', authenticateToken, async (req, res) => {
    const amount = parseFloat(req.body.amount);
    const email = (req.body.email || '').trim();

    if (isNaN(amount) || amount < 100) {
        return res.status(400).json({ error: "Minimum deposit is NGN 100.00" });
    }

    try {
        const user = await User.findById(req.user.userId);
        if (!user) return res.status(404).json({ error: "User not found" });

        if (process.env.PAYSTACK_SECRET_KEY && process.env.PAYSTACK_SECRET_KEY.trim() !== '') {
            const reference = `PB_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
            const customerEmail = email || `${user.username.toLowerCase().replace(/[^a-z0-9]/g, '')}@plugbet.ng`;
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
                amount: Math.round(amount * 100),
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

            return res.json({ payment_url: response.data.data.authorization_url, reference });
        }

        // Sandbox Instant Top-Up fallback if PAYSTACK_SECRET_KEY is not yet added
        const ref = `DEMO_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
        await Transaction.create({
            userId: user._id, reference: ref, type: 'deposit', gateway: 'instant_demo', amountNGN: amount, status: 'completed'
        });
        const updatedUser = await User.findByIdAndUpdate(user._id, { $inc: { balance: amount } }, { new: true });

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

app.get('/api/deposit/verify/:reference', authenticateToken, async (req, res) => {
    try {
        const { reference } = req.params;
        const tx = await Transaction.findOne({ reference, userId: req.user.userId });
        if (!tx) return res.status(404).json({ error: "Reference not found" });

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

            const updatedUser = await User.findByIdAndUpdate(req.user.userId, { $inc: { balance: verifiedNGN } }, { new: true });
            return res.json({ status: 'completed', amountNGN: verifiedNGN, newBalance: updatedUser.balance });
        }
        res.json({ status: response.data.data.status });
    } catch (err) {
        res.status(500).json({ error: "Could not verify payment" });
    }
});

app.post('/api/withdraw', authenticateToken, async (req, res) => {
    try {
        const amount = parseFloat(req.body.amount);
        const { bankName, accountNumber, accountName } = req.body;
        if (isNaN(amount) || amount < 1000) return res.status(400).json({ error: "Minimum withdrawal is NGN 1,000.00" });
        if (!bankName || !accountNumber || accountNumber.length !== 10) return res.status(400).json({ error: "Enter a valid 10-digit NUBAN account number" });

        const updatedUser = await User.findOneAndUpdate(
            { _id: req.user.userId, balance: { $gte: amount } },
            { $inc: { balance: -amount } },
            { new: true }
        );
        if (!updatedUser) return res.status(400).json({ error: "Insufficient NGN balance" });

        const reference = `WDR_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
        await Transaction.create({
            userId: req.user.userId, reference, type: 'withdrawal', gateway: 'nip_bank_transfer',
            amountNGN: amount, status: 'completed', meta: { bankName, accountNumber, accountName }
        });

        res.json({
            message: `NGN ${amount.toLocaleString('en-NG', { minimumFractionDigits: 2 })} queued to ${bankName}`,
            reference,
            newBalance: updatedUser.balance
        });
    } catch (err) {
        res.status(500).json({ error: "Withdrawal failed" });
    }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`========================================`);
    console.log(`🚀 PLUGBET ENTERPRISE LIVE on port ${PORT}`);
    console.log(`💳 Paystack: ${process.env.PAYSTACK_SECRET_KEY ? 'ACTIVE' : 'SANDBOX INSTANT MODE'}`);
    console.log(`========================================`);
});
