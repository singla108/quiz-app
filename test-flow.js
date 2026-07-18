/**
 * Automated test script for the Quiz App
 * Tests: quiz selection, player join, answer submission, correct answer reveal, rankings, reset
 */
const WebSocket = require('ws');
const http = require('http');

const BASE = 'http://localhost:3000';
let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.log(`  ✗ FAIL: ${msg}`);
    failed++;
  }
}

function httpGet(path) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE}${path}`, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

function httpPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: 'localhost', port: 3000, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    };
    const req = http.request(options, (res) => {
      let result = '';
      res.on('data', (chunk) => result += chunk);
      res.on('end', () => resolve(JSON.parse(result)));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function connectWS() {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://localhost:3000');
    ws.messages = [];
    ws.on('message', (msg) => ws.messages.push(JSON.parse(msg.toString())));
    ws.on('open', () => resolve(ws));
  });
}

function waitForMessage(ws, type, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const existing = ws.messages.find(m => m.type === type);
    if (existing) {
      ws.messages = ws.messages.filter(m => m !== existing);
      return resolve(existing);
    }
    const start = Date.now();
    const interval = setInterval(() => {
      const msg = ws.messages.find(m => m.type === type);
      if (msg) {
        clearInterval(interval);
        ws.messages = ws.messages.filter(m => m !== msg);
        resolve(msg);
      } else if (Date.now() - start > timeout) {
        clearInterval(interval);
        reject(new Error(`Timeout waiting for message type: ${type}`));
      }
    }, 50);
  });
}

function send(ws, data) {
  ws.send(JSON.stringify(data));
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runTests() {
  console.log('\n═══════════════════════════════════════');
  console.log('  QUIZ APP - AUTOMATED FLOW TESTS');
  console.log('═══════════════════════════════════════\n');

  // ─── TEST 1: API Endpoints ───
  console.log('TEST 1: REST API Endpoints');
  
  const quizzes = await httpGet('/api/quizzes');
  assert(quizzes.quizzes.length === 2, 'Two quizzes available (Batch A, Batch B)');
  assert(quizzes.quizzes[0].id === 'batch-a', 'First quiz is batch-a');
  assert(quizzes.quizzes[1].id === 'batch-b', 'Second quiz is batch-b');

  const quizInfoBefore = await httpGet('/api/quiz');
  assert(quizInfoBefore.title === 'No quiz selected', 'No quiz selected initially');

  // ─── TEST 2: Quiz Selection ───
  console.log('\nTEST 2: Quiz Selection');
  
  const selectResult = await httpPost('/api/select-quiz', { quizId: 'batch-a' });
  assert(selectResult.success === true, 'Batch A selected successfully');
  assert(selectResult.totalQuestions === 12, 'Batch A has 12 questions');
  assert(selectResult.title === 'AI in Banking & Financial Services – Batch A', 'Correct title for Batch A');

  const quizInfo = await httpGet('/api/quiz');
  assert(quizInfo.totalQuestions === 12, 'Quiz API returns 12 questions');

  // ─── TEST 3: QR Code Generation ───
  console.log('\nTEST 3: QR Code Generation');
  
  const qr = await httpGet('/api/qrcode');
  assert(qr.qr.startsWith('data:image/png;base64,'), 'QR code is a valid data URL');
  assert(qr.url.includes('/student.html'), 'QR URL points to student.html');

  // ─── TEST 4: Host + Player WebSocket Join ───
  console.log('\nTEST 4: WebSocket Join Flow');
  
  const host = await connectWS();
  send(host, { type: 'host-join' });
  const gameState = await waitForMessage(host, 'game-state');
  assert(gameState.status === 'waiting', 'Game starts in waiting state');

  const player1 = await connectWS();
  send(player1, { type: 'player-join', name: 'Alice' });
  const joinConfirm1 = await waitForMessage(player1, 'join-confirmed');
  assert(joinConfirm1.playerId.startsWith('player_'), 'Player 1 gets a valid ID');
  assert(joinConfirm1.gameStatus === 'waiting', 'Player told game is waiting');

  const hostNotify1 = await waitForMessage(host, 'player-joined');
  assert(hostNotify1.name === 'Alice', 'Host notified of Alice joining');
  assert(hostNotify1.players.length === 1, 'Host sees 1 player');

  const player2 = await connectWS();
  send(player2, { type: 'player-join', name: 'Bob' });
  const joinConfirm2 = await waitForMessage(player2, 'join-confirmed');
  assert(joinConfirm2.playerId.startsWith('player_'), 'Player 2 gets a valid ID');

  const hostNotify2 = await waitForMessage(host, 'player-joined');
  assert(hostNotify2.players.length === 2, 'Host sees 2 players');

  // ─── TEST 5: Start Quiz ───
  console.log('\nTEST 5: Start Quiz & First Question');
  
  send(host, { type: 'start-quiz' });
  
  const p1Question = await waitForMessage(player1, 'question');
  assert(p1Question.questionIndex === 0, 'Player 1 gets question 0');
  assert(p1Question.question.includes('predicts & classifies'), 'Q1 text is correct');
  assert(p1Question.options.length === 4, 'Q1 has 4 options');
  assert(p1Question.timeLimit === 20, 'Q1 has 20s time limit');
  assert(p1Question.totalQuestions === 12, 'Total questions = 12');

  const p2Question = await waitForMessage(player2, 'question');
  assert(p2Question.questionIndex === 0, 'Player 2 also gets question 0');

  const hostQuestion = await waitForMessage(host, 'question-host');
  assert(hostQuestion.correctAnswer === 1, 'Host sees correct answer index = 1');
  assert(hostQuestion.totalPlayers === 2, 'Host sees 2 total players');

  // ─── TEST 6: Submit Answers ───
  console.log('\nTEST 6: Answer Submission & Scoring');
  
  await sleep(100); // Small delay to simulate thinking
  send(player1, { type: 'submit-answer', answer: 1 }); // Correct
  const p1Feedback = await waitForMessage(player1, 'answer-confirmed');
  assert(p1Feedback.correct === true, 'Alice answered correctly');
  assert(p1Feedback.score >= 1000 && p1Feedback.score <= 1500, `Alice score ${p1Feedback.score} is in valid range`);

  const hostResponse1 = await waitForMessage(host, 'player-responded');
  assert(hostResponse1.name === 'Alice', 'Host sees Alice responded');
  assert(hostResponse1.wordCloudNames.includes('Alice'), 'Word cloud contains Alice');

  await sleep(500); // Bob is slower
  send(player2, { type: 'submit-answer', answer: 0 }); // Wrong
  const p2Feedback = await waitForMessage(player2, 'answer-confirmed');
  assert(p2Feedback.correct === false, 'Bob answered incorrectly');
  assert(p2Feedback.score === 0, 'Bob gets 0 points for wrong answer');

  const hostResponse2 = await waitForMessage(host, 'player-responded');
  assert(hostResponse2.responsesCount === 2, 'Host sees 2 responses total');
  assert(hostResponse2.wordCloudNames.length === 2, 'Word cloud has 2 names');

  // ─── TEST 7: Show Results ───
  console.log('\nTEST 7: Show Answer / Results');
  
  send(host, { type: 'show-results' });
  
  const hostResults = await waitForMessage(host, 'question-results');
  assert(hostResults.questionIndex === 0, 'Results are for question 0');
  assert(hostResults.correctAnswer === 1, 'Correct answer index = 1');
  assert(hostResults.options[1] === 'AI / Machine Learning', 'Correct answer text matches');
  assert(hostResults.rankings.length === 2, 'Rankings have 2 players');
  assert(hostResults.rankings[0].name === 'Alice', 'Alice is ranked #1');

  const p1Results = await waitForMessage(player1, 'question-results');
  assert(p1Results.questionIndex === 0, 'Player 1 gets results for Q0');
  assert(p1Results.options[p1Results.correctAnswer] === 'AI / Machine Learning', 'Player sees correct answer text');

  const p2Results = await waitForMessage(player2, 'question-results');
  assert(p2Results.correctAnswer === 1, 'Player 2 also sees correct answer');

  // ─── TEST 8: Next Question ───
  console.log('\nTEST 8: Next Question');
  
  send(host, { type: 'next-question' });
  
  const p1Q2 = await waitForMessage(player1, 'question');
  assert(p1Q2.questionIndex === 1, 'Player 1 gets question 1');
  assert(p1Q2.question.includes('plans & acts'), 'Q2 text is correct');

  const hostQ2 = await waitForMessage(host, 'question-host');
  assert(hostQ2.questionIndex === 1, 'Host gets question 1');
  assert(hostQ2.correctAnswer === 2, 'Q2 correct answer = index 2 (Agentic AI)');

  // ─── TEST 9: Duplicate Answer Prevention ───
  console.log('\nTEST 9: Duplicate Answer Prevention');
  
  send(player1, { type: 'submit-answer', answer: 2 }); // Correct
  const p1Q2Feedback = await waitForMessage(player1, 'answer-confirmed');
  assert(p1Q2Feedback.correct === true, 'Alice answers Q2 correctly');

  // Try submitting again
  send(player1, { type: 'submit-answer', answer: 0 }); // Try to answer again
  await sleep(300);
  const duplicateMsg = player1.messages.find(m => m.type === 'answer-confirmed');
  assert(!duplicateMsg, 'Duplicate answer is ignored (no second confirmation)');

  // ─── TEST 10: Play Through to End ───
  console.log('\nTEST 10: Play Through Remaining Questions to End');
  
  // Answer Q2 for Bob
  send(player2, { type: 'submit-answer', answer: 2 }); // Correct
  await waitForMessage(player2, 'answer-confirmed');

  // Fast-forward through remaining questions
  for (let i = 2; i < 12; i++) {
    send(host, { type: 'show-results' });
    await waitForMessage(host, 'question-results');
    await sleep(100);
    
    send(host, { type: 'next-question' });

    if (i < 11) {
      const hostQ = await waitForMessage(host, 'question-host');
      const pQ = await waitForMessage(player1, 'question');
      assert(pQ.questionIndex === i, `Question ${i} received`);
      
      // Both players answer
      send(player1, { type: 'submit-answer', answer: 1 });
      await waitForMessage(player1, 'answer-confirmed');
      send(player2, { type: 'submit-answer', answer: 0 });
      await waitForMessage(player2, 'answer-confirmed');
    } else {
      // Last question - host gets question-host, players get question
      const hostQ = await waitForMessage(host, 'question-host');
      const pQ = await waitForMessage(player1, 'question');
      assert(pQ.questionIndex === i, `Question ${i} received`);
      
      // Both answer last question
      send(player1, { type: 'submit-answer', answer: 1 });
      await waitForMessage(player1, 'answer-confirmed');
      send(player2, { type: 'submit-answer', answer: 0 });
      await waitForMessage(player2, 'answer-confirmed');
      
      // Show results for last question
      send(host, { type: 'show-results' });
      await waitForMessage(host, 'question-results');
      await sleep(100);
      
      // Next question after last = triggers quiz-finished
      send(host, { type: 'next-question' });
    }
  }

  // Last question results should trigger quiz-finished
  const finished = await waitForMessage(host, 'quiz-finished', 5000);
  assert(finished.rankings.length === 2, 'Final rankings have 2 players');
  assert(finished.rankings[0].score > finished.rankings[1].score, 'Player with more correct answers ranks higher');

  const p1Finished = await waitForMessage(player1, 'quiz-finished', 5000);
  assert(p1Finished.rankings.length === 2, 'Player 1 sees final rankings');

  // ─── TEST 11: Reset Quiz ───
  console.log('\nTEST 11: Reset Quiz');
  
  send(host, { type: 'reset-quiz' });
  const resetMsg = await waitForMessage(host, 'quiz-reset');
  assert(resetMsg.players.length === 2, 'Players still listed after reset');

  const p1Reset = await waitForMessage(player1, 'quiz-reset');
  assert(p1Reset !== undefined, 'Player 1 receives reset notification');

  // ─── TEST 12: Switch to Batch B ───
  console.log('\nTEST 12: Switch to Batch B');
  
  const selectB = await httpPost('/api/select-quiz', { quizId: 'batch-b' });
  assert(selectB.success === true, 'Batch B selected');
  assert(selectB.title === 'AI, Gen AI & Agentic AI in BFSI – Batch B', 'Batch B title correct');
  assert(selectB.totalQuestions === 12, 'Batch B has 12 questions');

  // ─── TEST 13: Reload Questions ───
  console.log('\nTEST 13: Hot Reload Questions');
  
  const reload = await httpPost('/api/reload-questions', {});
  assert(reload.success === true, 'Questions reloaded successfully');
  assert(reload.totalQuestions === 12, 'Still 12 questions after reload');

  // ─── TEST 14: Invalid quiz selection ───
  console.log('\nTEST 14: Error Handling');
  
  const invalidQuiz = await httpPost('/api/select-quiz', { quizId: 'nonexistent' });
  assert(invalidQuiz.error === 'Invalid quiz ID', 'Invalid quiz returns error');

  // ─── CLEANUP ───
  host.close();
  player1.close();
  player2.close();

  // ─── SUMMARY ───
  console.log('\n═══════════════════════════════════════');
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
