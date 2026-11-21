const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    balance: { type: Number, default: 1000 }, // Starting bonus
    isAdmin: { type: Boolean, default: false },
    winRateOverride: { type: Number, default: null }, // 0.0 to 1.0
});

module.exports = mongoose.model('User', UserSchema);
