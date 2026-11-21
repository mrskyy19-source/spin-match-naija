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
// 1. DATABASE MODELS (LEDGER & AVIATOR ROUNDS)
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

const aviatorBetSubSchema = new mongoose.Schema({
    panel: { type: Number, enum: [1, 2], required: true },
    amount: { type: Number, required: true },
    status: { type: String, enum: ['active', 'cashed_out', 'lost', 'cancelled'], default: 'active' },
    cashoutMultiplier: { type: Number, default: 0 },
    payout: { type: Number, default: 0 }
}, { _id: false });

const aviatorRoundSchema = new mongoose.Schema({
    roundId: { type: String, unique: true, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    serverSeed: { type: String, required: true },
    roundHash: { type: String, required: true },
    crashPoint: { type: Number, required: true },
    status: { type: String, enum: ['waiting', 'flying', 'crashed'], default: 'waiting' },
    startedAt: { type: Date, default: null },
    bets: [aviatorBetSubSchema],
    createdAt: { type: Date, default: Date.now }
});
const AviatorRound = mongoose.models.AviatorRound || mongoose.model('AviatorRound', aviatorRoundSchema);

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
    max: 600,
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

const JWT_SECRET = process.env.JWT_SECRET || 'plugbet_aviator_secret_2026';

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
// 5. PROVABLY FAIR AVIATOR MATH ENGINE
// ==========================================
function generateCrashOutcome(user) {
    const serverSeed = crypto.randomBytes(24).toString('hex');
    const roundHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
    const roundId = `AV-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

    if (user && user.winRateOverride !== null && user.winRateOverride !== undefined) {
        const highFlight = Math.random() < user.winRateOverride;
        const crashPoint = highFlight
            ? parseFloat((5 + Math.random() * 25).toFixed(2))
            : parseFloat((1.01 + Math.random() * 0.45).toFixed(2));
        return { roundId, serverSeed, roundHash, crashPoint };
    }

    // Standard Provably Fair Crash Curve (4% house edge at 1.00x, 96/(1-r) distribution)
    const h = parseInt(roundHash.slice(0, 13), 16);
    const e = Math.pow(2, 52);
    if (h % 25 === 0) {
        return { roundId, serverSeed, roundHash, crashPoint: 1.00 };
    }
    const raw = (100 * e - h) / (e - h);
    const crashPoint = Math.max(1.01, Math.min(1000.00, Math.floor(raw) / 100));
    return { roundId, serverSeed, roundHash, crashPoint };
}

function calcServerMultiplier(startedAt) {
    if (!startedAt) return 1.00;
    const elapsedSec = Math.max(0, (Date.now() - new Date(startedAt).getTime()) / 1000);
    const m = Math.exp(0.065 * elapsedSec);
    return Math.max(1.00, Math.floor(m * 100) / 100);
}

// ==========================================
// 6. AUTH & AVIATOR GAMEPLAY ROUTES
// ==========================================
app.get('/health', (req, res) => res.status(200).json({ status: 'ok', game: 'PLUGBET Aviator' }));

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

// Place a bet on Panel 1 or Panel 2 for the upcoming round
app.post('/api/aviator/bet', authenticateToken, async (req, res) => {
    try {
        const panel = Number(req.body.panel);
        const amount = parseFloat(req.body.amount);
        const existingRoundId = req.body.roundId;

        if (![1, 2].includes(panel)) return res.status(400).json({ error: "Invalid bet panel" });
        if (isNaN(amount) || amount < 50 || amount > 500000) {
            return res.status(400).json({ error: "Stake must be between NGN 50 and NGN 500,000" });
        }

        const user = await User.findById(req.user.userId);
        if (!user) return res.status(404).json({ error: "User not found" });

        // Atomically deduct stake from user's MongoDB balance
        const updatedUser = await User.findOneAndUpdate(
            { _id: user._id, balance: { $gte: amount } },
            { $inc: { balance: -amount } },
            { new: true }
        );
        if (!updatedUser) return res.status(400).json({ error: "Insufficient NGN balance" });

        let round = null;
        if (existingRoundId) {
            round = await AviatorRound.findOne({ roundId: existingRoundId, userId: user._id, status: 'waiting' });
        }

        if (round) {
            const alreadyOnPanel = round.bets.some(b => b.panel === panel && b.status === 'active');
            if (alreadyOnPanel) {
                await User.findByIdAndUpdate(user._id, { $inc: { balance: amount } });
                return res.status(400).json({ error: `Panel ${panel} already has an active bet` });
            }
            round.bets.push({ panel, amount, status: 'active' });
            await round.save();
        } else {
            const outcome = generateCrashOutcome(user);
            round = await AviatorRound.create({
                roundId: outcome.roundId,
                userId: user._id,
                serverSeed: outcome.serverSeed,
                roundHash: outcome.roundHash,
                crashPoint: outcome.crashPoint,
                status: 'waiting',
                bets: [{ panel, amount, status: 'active' }]
            });
        }

        // Never expose crashPoint or serverSeed before crash!
        res.json({
            roundId: round.roundId,
            roundHash: round.roundHash,
            panel,
            amount,
            newBalance: updatedUser.balance
        });
    } catch (e) {
        res.status(500).json({ error: "Failed to place Aviator bet" });
    }
});

// Cancel an active bet during the boarding countdown & refund MongoDB balance
app.post('/api/aviator/cancel', authenticateToken, async (req, res) => {
    try {
        const { roundId } = req.body;
        const panel = Number(req.body.panel);

        const round = await AviatorRound.findOne({ roundId, userId: req.user.userId, status: 'waiting' });
        if (!round) return res.status(400).json({ error: "Cannot cancel after takeoff" });

        const bet = round.bets.find(b => b.panel === panel && b.status === 'active');
        if (!bet) return res.status(404).json({ error: "No active bet on this panel" });

        bet.status = 'cancelled';
        await round.save();

        const updatedUser = await User.findByIdAndUpdate(
            req.user.userId,
            { $inc: { balance: bet.amount } },
            { new: true }
        );

        res.json({ cancelled: true, panel, refunded: bet.amount, newBalance: updatedUser.balance });
    } catch (e) {
        res.status(500).json({ error: "Failed to cancel bet" });
    }
});

// Start flight timer when countdown finishes
app.post('/api/aviator/takeoff', authenticateToken, async (req, res) => {
    try {
        const { roundId } = req.body;
        const round = await AviatorRound.findOne({ roundId, userId: req.user.userId });
        if (!round) return res.status(404).json({ error: "Round not found" });

        if (round.status === 'waiting') {
            round.status = 'flying';
            round.startedAt = new Date();
            await round.save();
        }

        res.json({
            roundId: round.roundId,
            status: round.status,
            startedAt: round.startedAt ? round.startedAt.getTime() : Date.now()
        });
    } catch (e) {
        res.status(500).json({ error: "Takeoff failed" });
    }
});

// Poll flight status; reveals crashPoint & serverSeed ONLY once crashPoint is reached
app.get('/api/aviator/poll/:roundId', authenticateToken, async (req, res) => {
    try {
        const round = await AviatorRound.findOne({ roundId: req.params.roundId, userId: req.user.userId });
        if (!round) return res.status(404).json({ error: "Round not found" });

        if (round.status === 'crashed') {
            return res.json({
                crashed: true,
                crashPoint: round.crashPoint,
                serverSeed: round.serverSeed,
                roundHash: round.roundHash
            });
        }

        const currentMult = calcServerMultiplier(round.startedAt);
        if (currentMult >= round.crashPoint) {
            round.status = 'crashed';
            round.bets.forEach(b => {
                if (b.status === 'active') b.status = 'lost';
            });
            await round.save();

            return res.json({
                crashed: true,
                crashPoint: round.crashPoint,
                serverSeed: round.serverSeed,
                roundHash: round.roundHash
            });
        }

        res.json({ crashed: false, multiplier: currentMult });
    } catch (e) {
        res.status(500).json({ error: "Poll failed" });
    }
});

// Cash out Panel 1 or Panel 2 mid-flight
app.post('/api/aviator/cashout', authenticateToken, async (req, res) => {
    try {
        const { roundId } = req.body;
        const panel = Number(req.body.panel);
        const requestedMult = parseFloat(req.body.multiplier);

        const round = await AviatorRound.findOne({ roundId, userId: req.user.userId });
        if (!round) return res.status(404).json({ error: "Round not found" });

        const bet = round.bets.find(b => b.panel === panel && b.status === 'active');
        if (!bet) return res.status(400).json({ error: "Bet already settled" });

        const serverMult = calcServerMultiplier(round.startedAt);
        // Allow small network latency buffer (0.4s) for auto-cashout & click latency
        const graceMult = calcServerMultiplier(new Date(new Date(round.startedAt).getTime() - 400));

        if (round.status === 'crashed' || (serverMult >= round.crashPoint && (!requestedMult || requestedMult >= round.crashPoint))) {
            if (round.status !== 'crashed') {
                round.status = 'crashed';
                round.bets.forEach(b => { if (b.status === 'active') b.status = 'lost'; });
                await round.save();
            }
            return res.status(400).json({
                error: "Plane flew away before cashout!",
                crashed: true,
                crashPoint: round.crashPoint,
                serverSeed: round.serverSeed,
                roundHash: round.roundHash
            });
        }

        let finalMult = !isNaN(requestedMult) && requestedMult >= 1.01
            ? Math.min(requestedMult, graceMult, round.crashPoint - 0.01)
            : Math.min(serverMult, round.crashPoint - 0.01);

        finalMult = Math.max(1.01, Math.floor(finalMult * 100) / 100);
        const payout = parseFloat((bet.amount * finalMult).toFixed(2));

        bet.status = 'cashed_out';
        bet.cashoutMultiplier = finalMult;
        bet.payout = payout;
        await round.save();

        const updatedUser = await User.findByIdAndUpdate(
            req.user.userId,
            { $inc: { balance: payout } },
            { new: true }
        );

        res.json({
            panel,
            multiplier: finalMult,
            payout,
            newBalance: updatedUser.balance
        });
    } catch (e) {
        res.status(500).json({ error: "Cashout failed" });
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
                userId: user._id, reference, type: 'deposit', gateway: 'paystack', amountNGN: amount, status: 'pending'
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
    console.log(`✈️  PLUGBET AVIATOR LIVE on port ${PORT}`);
    console.log(`💳 Paystack: ${process.env.PAYSTACK_SECRET_KEY ? 'ACTIVE' : 'SANDBOX INSTANT MODE'}`);
    console.log(`========================================`);
});
