const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Available quizzes configuration
const quizFiles = {
  'batch-a': { file: 'questions-batch-a.json', label: 'Batch A' },
  'batch-b': { file: 'questions-batch-b.json', label: 'Batch B' },
};

// Load questions from file
let currentQuizId = null;
let quizData = null;

function loadQuiz(quizId) {
  const quiz = quizFiles[quizId];
  if (!quiz) throw new Error(`Unknown quiz: ${quizId}`);
  quizData = JSON.parse(fs.readFileSync(path.join(__dirname, quiz.file), 'utf8'));
  currentQuizId = quizId;
  return quizData;
}

// Game state
let gameState = {
  status: 'waiting', // waiting, active, finished
  currentQuestionIndex: -1,
  questionStartTime: null,
  players: new Map(), // id -> { name, score, answers, ws }
  responses: [], // responses for current question
};

// Get local network IP for QR code
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

const PORT = process.env.PORT || 3000;
const LOCAL_IP = getLocalIP();

// API: List available quizzes
app.get('/api/quizzes', (req, res) => {
  const list = Object.entries(quizFiles).map(([id, info]) => ({ id, label: info.label }));
  res.json({ quizzes: list, currentQuizId });
});

// API: Select a quiz
app.post('/api/select-quiz', (req, res) => {
  const { quizId } = req.body;
  if (!quizFiles[quizId]) {
    return res.status(400).json({ error: 'Invalid quiz ID' });
  }
  try {
    loadQuiz(quizId);
    // Reset game state when switching quiz
    gameState.status = 'waiting';
    gameState.currentQuestionIndex = -1;
    gameState.questionStartTime = null;
    gameState.responses = [];
    gameState.players.clear();
    broadcast('quiz-reset', { players: [] }, null);
    res.json({ success: true, title: quizData.quizTitle, totalQuestions: quizData.questions.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load quiz' });
  }
});

// API: Generate QR code for student login
app.get('/api/qrcode', async (req, res) => {
  // Use the request's host header so it works on any deployment (local, Render, Railway, etc.)
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `${LOCAL_IP}:${PORT}`;
  const url = `${protocol}://${host}/student.html`;
  try {
    const qrDataUrl = await QRCode.toDataURL(url, { width: 300, margin: 2 });
    res.json({ qr: qrDataUrl, url });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

// API: Get quiz info
app.get('/api/quiz', (req, res) => {
  if (!quizData) {
    return res.json({ title: 'No quiz selected', totalQuestions: 0, defaultTimePerQuestion: 20 });
  }
  res.json({
    title: quizData.quizTitle,
    totalQuestions: quizData.questions.length,
    defaultTimePerQuestion: quizData.timePerQuestion,
  });
});

// API: Reload questions (hot reload)
app.post('/api/reload-questions', (req, res) => {
  if (!currentQuizId) {
    return res.status(400).json({ error: 'No quiz selected' });
  }
  try {
    loadQuiz(currentQuizId);
    res.json({ success: true, totalQuestions: quizData.questions.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reload questions' });
  }
});

// Broadcast to all connected clients of a specific type
function broadcast(type, data, targetRole) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      if (!targetRole || client.role === targetRole) {
        client.send(JSON.stringify({ type, ...data }));
      }
    }
  });
}

// Get current rankings
function getRankings() {
  const players = [];
  gameState.players.forEach((player, id) => {
    players.push({
      id,
      name: player.name,
      score: player.score,
      correctAnswers: player.answers.filter((a) => a.correct).length,
      totalTime: player.answers.reduce((sum, a) => sum + (a.time || 0), 0),
    });
  });
  // Sort by score (desc), then by total time (asc) for tiebreaker
  players.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.totalTime - b.totalTime;
  });
  return players;
}

// Get player list for lobby
function getPlayerList() {
  const players = [];
  gameState.players.forEach((player, id) => {
    players.push({ id, name: player.name });
  });
  return players;
}

// Calculate score based on correctness and speed
function calculateScore(correct, timeTaken, timeLimit) {
  if (!correct) return 0;
  // Base score 1000, bonus for speed (up to 500 extra points)
  const timeBonus = Math.round(500 * (1 - timeTaken / timeLimit));
  return 1000 + Math.max(0, timeBonus);
}

// WebSocket connection handling
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch (e) {
      return;
    }

    switch (data.type) {
      case 'host-join': {
        ws.role = 'host';
        ws.send(JSON.stringify({
          type: 'game-state',
          status: gameState.status,
          players: getPlayerList(),
          currentQuestionIndex: gameState.currentQuestionIndex,
          totalQuestions: quizData.questions.length,
        }));
        break;
      }

      case 'player-join': {
        const playerId = data.playerId || `player_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        ws.role = 'player';
        ws.playerId = playerId;

        gameState.players.set(playerId, {
          name: data.name,
          score: 0,
          answers: [],
          ws,
        });

        // Confirm join to the player
        ws.send(JSON.stringify({
          type: 'join-confirmed',
          playerId,
          gameStatus: gameState.status,
        }));

        // Notify host of new player
        broadcast('player-joined', {
          playerId,
          name: data.name,
          players: getPlayerList(),
        }, 'host');

        // If game is active, send current question to the new player
        if (gameState.status === 'active' && gameState.currentQuestionIndex >= 0) {
          const q = quizData.questions[gameState.currentQuestionIndex];
          const elapsed = (Date.now() - gameState.questionStartTime) / 1000;
          const remaining = Math.max(0, (q.timeLimit || quizData.timePerQuestion) - elapsed);
          ws.send(JSON.stringify({
            type: 'question',
            questionIndex: gameState.currentQuestionIndex,
            question: q.question,
            options: q.options,
            timeLimit: remaining,
            totalQuestions: quizData.questions.length,
          }));
        }
        break;
      }

      case 'start-quiz': {
        if (ws.role !== 'host') return;
        gameState.status = 'active';
        gameState.currentQuestionIndex = -1;
        // Reset scores
        gameState.players.forEach((player) => {
          player.score = 0;
          player.answers = [];
        });
        broadcast('quiz-started', {}, null);
        // Auto-send first question
        sendNextQuestion();
        break;
      }

      case 'next-question': {
        if (ws.role !== 'host') return;
        sendNextQuestion();
        break;
      }

      case 'submit-answer': {
        if (ws.role !== 'player') return;
        const player = gameState.players.get(ws.playerId);
        if (!player) return;

        const qIndex = gameState.currentQuestionIndex;
        if (qIndex < 0 || qIndex >= quizData.questions.length) return;

        // Check if already answered this question
        if (player.answers.length > qIndex) return;

        const question = quizData.questions[qIndex];
        const timeTaken = (Date.now() - gameState.questionStartTime) / 1000;
        const timeLimit = question.timeLimit || quizData.timePerQuestion;
        const correct = data.answer === question.correctAnswer;
        const score = calculateScore(correct, timeTaken, timeLimit);

        player.score += score;
        player.answers.push({
          questionIndex: qIndex,
          answer: data.answer,
          correct,
          time: timeTaken,
          score,
        });

        // Track response for word cloud
        gameState.responses.push({
          playerId: ws.playerId,
          name: player.name,
          time: timeTaken,
        });

        // Confirm to the player
        ws.send(JSON.stringify({
          type: 'answer-confirmed',
          correct,
          score,
          totalScore: player.score,
        }));

        // Notify host for word cloud update
        broadcast('player-responded', {
          playerId: ws.playerId,
          name: player.name,
          responsesCount: gameState.responses.length,
          totalPlayers: gameState.players.size,
          wordCloudNames: gameState.responses.map((r) => r.name),
        }, 'host');
        break;
      }

      case 'show-results': {
        if (ws.role !== 'host') return;
        const qIndex = gameState.currentQuestionIndex;
        const question = quizData.questions[qIndex];
        broadcast('question-results', {
          questionIndex: qIndex,
          question: question.question,
          options: question.options,
          correctAnswer: question.correctAnswer,
          rankings: getRankings().slice(0, 10),
        }, null);
        break;
      }

      case 'end-quiz': {
        if (ws.role !== 'host') return;
        gameState.status = 'finished';
        const finalRankings = getRankings();
        broadcast('quiz-finished', { rankings: finalRankings }, null);
        break;
      }

      case 'reset-quiz': {
        if (ws.role !== 'host') return;
        gameState.status = 'waiting';
        gameState.currentQuestionIndex = -1;
        gameState.questionStartTime = null;
        gameState.responses = [];
        gameState.players.forEach((player) => {
          player.score = 0;
          player.answers = [];
        });
        broadcast('quiz-reset', { players: getPlayerList() }, null);
        break;
      }
    }
  });

  ws.on('close', () => {
    if (ws.role === 'player' && ws.playerId) {
      // Keep player in game state for scoring, just mark disconnected
      const player = gameState.players.get(ws.playerId);
      if (player) {
        player.ws = null;
      }
      broadcast('player-left', {
        playerId: ws.playerId,
        players: getPlayerList(),
      }, 'host');
    }
  });
});

function sendNextQuestion() {
  gameState.currentQuestionIndex++;
  gameState.responses = [];

  if (gameState.currentQuestionIndex >= quizData.questions.length) {
    // Quiz is over
    gameState.status = 'finished';
    const finalRankings = getRankings();
    broadcast('quiz-finished', { rankings: finalRankings }, null);
    return;
  }

  const q = quizData.questions[gameState.currentQuestionIndex];
  const timeLimit = q.timeLimit || quizData.timePerQuestion;
  gameState.questionStartTime = Date.now();

  // Send question to all (players get options, host gets full info)
  broadcast('question', {
    questionIndex: gameState.currentQuestionIndex,
    question: q.question,
    options: q.options,
    timeLimit,
    totalQuestions: quizData.questions.length,
  }, 'player');

  broadcast('question-host', {
    questionIndex: gameState.currentQuestionIndex,
    question: q.question,
    options: q.options,
    correctAnswer: q.correctAnswer,
    timeLimit,
    totalQuestions: quizData.questions.length,
    totalPlayers: gameState.players.size,
  }, 'host');
}

// Heartbeat to detect disconnected clients
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎯 Quiz App Server Running!`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  Host Dashboard: http://localhost:${PORT}`);
  console.log(`  Student Join:   http://${LOCAL_IP}:${PORT}/student.html`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`\nShow the QR code on the host dashboard for students to join!\n`);
});
