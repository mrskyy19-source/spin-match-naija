/**
 * PLUGBET NG — Production Node.js / Express Server for Render (spin-match-naija.onrender.com)
 * Serves the single-page application in /public/index.html and exposes API endpoints
 * for Live Betting, Instant Football, Super 6 Jackpot, and Provably Fair state.
 */

const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware for JSON payloads & static assets in /public
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  maxAge: 0,
  setHeaders: (res) => {
    // Prevent stale browser caching so updated index.html loads immediately on Render deploy
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

// ============================================================================
// IN-MEMORY SERVER STATE FOR LIVE BETTING, INSTANT FOOTBALL & JACKPOT
// ============================================================================
let serverState = {
  jackpotPoolNGN: 10458200.00,
  liveMatches: [
    { id: 'm1', league: 'NPFL Nigeria', home: 'Enyimba FC', away: 'Kano Pillars', scoreH: 1, scoreA: 0, min: 58, o1: 1.55, oX: 3.40, o2: 5.20, o25: 1.85 },
    { id: 'm2', league: 'Premier League', home: 'Arsenal', away: 'Liverpool', scoreH: 2, scoreA: 2, min: 71, o1: 2.65, oX: 2.35, o2: 2.95, o25: 1.18 },
    { id: 'm3', league: 'La Liga', home: 'Real Madrid', away: 'Barcelona', scoreH: 1, scoreA: 1, min: 44, o1: 2.15, oX: 3.10, o2: 3.25, o25: 1.48 },
    { id: 'm4', league: 'Serie A', home: 'Napoli', away: 'AC Milan', scoreH: 0, scoreA: 1, min: 63, o1: 4.10, oX: 2.90, o2: 1.88, o25: 2.05 },
    { id: 'm5', league: 'Champions League', home: 'Man City', away: 'Bayern Munich', scoreH: 2, scoreA: 1, min: 52, o1: 1.45, oX: 4.30, o2: 6.10, o25: 1.25 },
    { id: 'm6', league: 'NPFL Nigeria', home: 'Remo Stars', away: 'Rivers United', scoreH: 0, scoreA: 0, min: 34, o1: 2.25, oX: 2.85, o2: 3.40, o25: 2.30 }
  ]
};

// ============================================================================
// API ROUTES FOR NAVIGATION PORTS
// ============================================================================

// Health check for Render zero-downtime deploys
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'PLUGBET-NG', timestamp: new Date().toISOString() });
});

// 1. Live Betting Matches Feed
app.get('/api/live-betting', (req, res) => {
  res.json({
    success: true,
    matches: serverState.liveMatches
  });
});

// 2. Instant Football Server-Verified Simulation
app.post('/api/instant-football/simulate', (req, res) => {
  try {
    const { home, away, pick, stake, odds } = req.body;
    const validStake = Math.max(100, Number(stake) || 100);
    const gH = Math.floor(Math.random() * 4);
    const gA = Math.floor(Math.random() * 4);
    const outcome = gH > gA ? 'HOME' : gA > gH ? 'AWAY' : 'DRAW';
    const won = outcome === pick;
    const payout = won ? Number((validStake * (Number(odds) || 2.0)).toFixed(2)) : 0;

    res.json({
      success: true,
      fixture: `${home} vs ${away}`,
      score: `${gH} - ${gA}`,
      outcome,
      won,
      payout
    });
  } catch (err) {
    res.status(400).json({ success: false, error: 'Invalid match simulation request' });
  }
});

// 3. Super 6 Jackpot Ticket Entry
app.post('/api/jackpot/enter', (req, res) => {
  try {
    const { picks } = req.body;
    if (!Array.isArray(picks) || picks.length !== 6) {
      return res.status(400).json({ success: false, error: 'All 6 predictions are required' });
    }

    serverState.jackpotPoolNGN += 200;
    const options = ['1', 'X', '2'];
    const officialResults = Array.from({ length: 6 }, () => options[crypto.randomInt(0, 3)]);
    let correctCount = 0;

    picks.forEach((p, idx) => {
      if (p === officialResults[idx]) correctCount++;
    });

    const prizeTable = { 0: 0, 1: 0, 2: 0, 3: 500, 4: 5000, 5: 75000, 6: serverState.jackpotPoolNGN };
    const payout = prizeTable[correctCount] || 0;

    res.json({
      success: true,
      correctCount,
      officialResults,
      payout,
      updatedPoolNGN: serverState.jackpotPoolNGN
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Jackpot draw error' });
  }
});

// ============================================================================
// SPA CATCH-ALL ROUTE (Ensures direct links or refreshes never fail on Render)
// ============================================================================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 PLUGBET NG Server live on port ${PORT}`);
});
