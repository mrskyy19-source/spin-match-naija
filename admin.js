require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User');

mongoose.connect(process.env.MONGO_URI);

async function setWinRate(username, rate) {
    try {
        const user = await User.findOne({ username });
        if (!user) return console.log("❌ User not found");

        user.winRateOverride = rate; // 0.9 = 90% Jackpot, 0.1 = 10% Jackpot, null = Normal
        await user.save();
        console.log(`✅ SUCCESS: ${username} win rate set to ${rate * 100}%`);
    } catch (e) {
        console.error("Error:", e);
    }
}

const [,, name, rate] = process.argv;
if (!name || rate === undefined) {
    console.log("Usage: node admin.js [username] [rate]");
    console.log("Example: node admin.js 'player1' 0.8 (80% win)");
    console.log("Example: node admin.js 'player1' null (Reset to normal)");
} else {
    setWinRate(name, rate === 'null' ? null : parseFloat(rate));
}
