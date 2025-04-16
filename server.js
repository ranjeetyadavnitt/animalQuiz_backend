const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// Read questions from JSON file
const questions = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Game state
let players = [];
let gameActive = false;
let currentRound = 0;
const totalRounds = 10;
let hostId = null;
let roundTimer = null;
const roundDuration = 15; // 15 seconds per round
let waitingForNextRound = [];

// Helper functions
function getRandomQuestion() {
  const randomIndex = Math.floor(Math.random() * questions.length);
  return questions[randomIndex];
}

function calculateScore(timeLeft) {
  // 100 points for correct answer + up to 100 points based on time left
  return 100 + Math.floor((timeLeft / roundDuration) * 100);
}

function updateLeaderboard() {
  const leaderboard = players
    .sort((a, b) => b.score - a.score)
    .map(player => ({
      id: player.id,
      name: player.name,
      score: player.score
    }));
  
  io.emit('leaderboard-update', leaderboard);
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`New connection: ${socket.id}`);
  
  // Player joining
  socket.on('player-join', (playerName) => {
    const newPlayer = {
      id: socket.id,
      name: playerName,
      score: 0,
      currentQuestion: null
    };
    
    // First player becomes host
    if (players.length === 0) {
      hostId = socket.id;
      socket.emit('set-as-host');
    }
    
    players.push(newPlayer);
    console.log(`${playerName} joined the game`);
    
    // Notify everyone about the new player
    io.emit('player-joined', { id: socket.id, name: playerName });
    
    // Send current game status to the new player
    socket.emit('game-status', {
      isActive: gameActive,
      currentRound: currentRound,
      totalRounds: totalRounds,
      canJoin: !gameActive
    });
    
    // Update leaderboard
    updateLeaderboard();
    
    // If game is active, add to waiting list
    if (gameActive) {
      waitingForNextRound.push(socket.id);
      socket.emit('wait-for-next-round');
    }
  });
  
  // Host starts the game
  socket.on('start-game', () => {
    if (socket.id === hostId && !gameActive) {
      gameActive = true;
      currentRound = 1;
      
      // Reset all player scores
      players.forEach(player => {
        player.score = 0;
      });
      
      // Start the first round
      startNewRound();
      
      io.emit('game-started', { 
        totalRounds: totalRounds,
        currentRound: currentRound
      });
    }
  });
  
  // Player submits an answer
  socket.on('submit-answer', (data) => {
    const { answer, timeLeft } = data;
    const player = players.find(p => p.id === socket.id);
    
    if (!player || !gameActive) return;
    
    const correctAnswer = player.currentQuestion.answer;
    const isCorrect = answer === correctAnswer;
    
    if (isCorrect) {
      const earnedPoints = calculateScore(timeLeft);
      player.score += earnedPoints;
      socket.emit('answer-result', { 
        correct: true, 
        points: earnedPoints, 
        correctAnswer 
      });
    } else {
      socket.emit('answer-result', { 
        correct: false, 
        points: 0, 
        correctAnswer 
      });
    }
    
    // Update leaderboard after each answer
    updateLeaderboard();
    
    // Check if all players answered
    const allAnswered = players.every(p => !p.currentQuestion || p.currentQuestion.answered);
    if (allAnswered && gameActive) {
      clearTimeout(roundTimer);
      setTimeout(() => {
        if (currentRound < totalRounds) {
          currentRound++;
          startNewRound();
        } else {
          endGame();
        }
      }, 2000); // Short delay before next round
    }
  });
  
  // Chat message
  socket.on('chat-message', (message) => {
    const player = players.find(p => p.id === socket.id);
    if (player) {
      io.emit('new-chat-message', {
        sender: player.name,
        message: message,
        timestamp: new Date().toISOString()
      });
    }
  });
  
  // Player disconnection
  socket.on('disconnect', () => {
    const playerIndex = players.findIndex(p => p.id === socket.id);
    
    if (playerIndex !== -1) {
      const playerName = players[playerIndex].name;
      console.log(`${playerName} disconnected`);
      
      // Remove from players array
      players.splice(playerIndex, 1);
      
      // Remove from waiting list if present
      const waitingIndex = waitingForNextRound.indexOf(socket.id);
      if (waitingIndex !== -1) {
        waitingForNextRound.splice(waitingIndex, 1);
      }
      
      // Notify others
      io.emit('player-left', socket.id);
      
      // Update leaderboard
      updateLeaderboard();
      
      // If host disconnects, assign a new host
      if (socket.id === hostId && players.length > 0) {
        hostId = players[0].id;
        io.to(hostId).emit('set-as-host');
      }
      
      // End game if no players left
      if (players.length === 0) {
        resetGame();
      }
    }
  });
});

// Start a new round
function startNewRound() {
  // Add waiting players to the game
  waitingForNextRound.forEach(playerId => {
    const socket = io.sockets.sockets.get(playerId);
    if (socket) {
      socket.emit('join-current-game');
    }
  });
  waitingForNextRound = [];
  
  // Assign new questions to each player
  players.forEach(player => {
    player.currentQuestion = getRandomQuestion();
    player.currentQuestion.timeStamp = Date.now();
    player.currentQuestion.answered = false;
    
    io.to(player.id).emit('new-question', {
      question: player.currentQuestion.question,
      image: player.currentQuestion.image,
      options: player.currentQuestion.options,
      round: currentRound,
      totalRounds: totalRounds
    });
  });
  
  // Set timeout for the round
  if (roundTimer) {
    clearTimeout(roundTimer);
  }
  
  roundTimer = setTimeout(() => {
    endRound();
  }, roundDuration * 1000);
  
  // Start the countdown
  io.emit('round-timer-start', roundDuration);
}

// End the current round
function endRound() {
  // Handle unanswered questions
  players.forEach(player => {
    if (player.currentQuestion && !player.currentQuestion.answered) {
      player.currentQuestion.answered = true;
      io.to(player.id).emit('answer-result', {
        correct: false,
        points: 0,
        correctAnswer: player.currentQuestion.answer,
        timedOut: true
      });
    }
  });
  
  // Proceed to next round or end game
  setTimeout(() => {
    if (currentRound < totalRounds) {
      currentRound++;
      startNewRound();
    } else {
      endGame();
    }
  }, 2000);
}

// End the game
function endGame() {
  gameActive = false;
  
  // Calculate final results
  const finalResults = players
    .sort((a, b) => b.score - a.score)
    .map(player => ({
      id: player.id,
      name: player.name,
      score: player.score
    }));
  
  io.emit('game-ended', {
    results: finalResults
  });
  
  // Reset for the next game
  setTimeout(resetGame, 10000); // Reset after 10 seconds
}

// Reset the game state
function resetGame() {
  currentRound = 0;
  gameActive = false;
  
  if (players.length > 0) {
    hostId = players[0].id;
    io.to(hostId).emit('set-as-host');
  } else {
    hostId = null;
  }
  
  io.emit('game-reset');
}

// Start the server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});