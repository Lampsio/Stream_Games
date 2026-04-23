import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Search, RotateCcw, CheckCircle2, AlertCircle, Timer, Trophy, ShieldCheck, Sparkles, Lightbulb, Trash2, Flame, Crown, Info, X, Clock, Eye, Wind, Ghost, Skull, HelpCircle } from 'lucide-react';
import tmi from 'tmi.js';
import confetti from 'canvas-confetti';
import { FaTwitch } from "react-icons/fa";
import "./App.css";

import LEVELS_DATA from './levels.json';
import { loadStats, saveStats, clearStats } from './lib/persistence';

interface Level {
  masterWord: string;
  answers: string[];
}

const LEVELS = LEVELS_DATA as Level[];

const INITIAL_TIME = 120; // 2 minutes in seconds

interface Letter {
  id: number;
  char: string;
  isDecoy?: boolean;
  isHidden?: boolean;
}

type SpecialWordType = 'FREEZE' | 'GOLD' | 'TIME' | 'SCANNER' | 'STORM' | 'DARKNESS' | 'TRAP' | 'MYSTERY' | null;

interface FoundWord {
  word: string;
  user: string;
  points: number;
}

interface ChatLog {
  id: string;
  username: string;
  message: string;
  color: string;
}

interface UserStats {
  displayName: string; // Store original casing for display
  points: number;
  wins: number;
  roundWins: number;
  gameWins: number;
  masterWordWins: number;
  currentStreak: number;
  maxStreak: number;
  maxLevelReached: number;
}

interface DebugLog {
  id: string;
  time: string;
  event: string;
  data: any;
}

export default function App() {
  const [gameState, setGameState] = useState<'lobby' | 'countdown' | 'playing' | 'roundSummary' | 'stats' | 'ended'>('lobby');
  const [debugLogs, setDebugLogs] = useState<DebugLog[]>([]);
  const [showDebug, setShowDebug] = useState(false);
  const tmiClientRef = useRef<tmi.Client | null>(null);
  const [countdownValue, setCountdownValue] = useState(5);
  const [levelIndex, setLevelIndex] = useState(0);
  const [levelSequence, setLevelSequence] = useState<number[]>([]);
  const [foundWords, setFoundWords] = useState<FoundWord[]>([]);
  const [sessionScores, setSessionScores] = useState<Record<string, number>>({});
  const [globalStats, setGlobalStats] = useState<Record<string, UserStats>>({});
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [shuffledLetters, setShuffledLetters] = useState<Letter[]>([]);
  const lettersPoolRef = useRef<Letter[]>([]);
  const [feedback, setFeedback] = useState<{ message: string; type: 'success' | 'error' | 'freeze' | 'hazard' | null }>({ message: "", type: null });
  const [specialWords, setSpecialWords] = useState<Record<string, SpecialWordType>>({});
  const specialWordsRef = useRef<Record<string, SpecialWordType>>({});
  const [isTimeFrozen, setIsTimeFrozen] = useState(false);
  const [isDarknessActive, setIsDarknessActive] = useState(false);
  const [showRoundWords, setShowRoundWords] = useState(false);
  
  const addDebugLog = useCallback((event: string, data: any) => {
    const log: DebugLog = {
      id: Math.random().toString(),
      time: new Date().toLocaleTimeString(),
      event,
      data
    };
    setDebugLogs(prev => [log, ...prev].slice(0, 50));
    console.log(`[DEBUG] ${event}`, data);
  }, []);

  // Twitch states from user snippet
  const [inputValue, setInputValue] = useState("");
  const [activeChannel, setActiveChannel] = useState("");
  const [messages, setMessages] = useState<ChatLog[]>([]);
  const [status, setStatus] = useState("Wpisz kanał, aby zacząć");
  const [isConnected, setIsConnected] = useState(false);

  const [timeLeft, setTimeLeft] = useState(INITIAL_TIME);
  const [hints, setHints] = useState<Record<string, number[]>>({}); // word: revealedIndices[]
  const [lastActionTime, setLastActionTime] = useState(Date.now());

  const generateLevelSequence = useCallback(() => {
    const indices = LEVELS.map((_, i) => i);
    const sevenLetterIndices = indices.filter(i => LEVELS[i].masterWord.length === 7);
    const otherIndices = indices.filter(i => LEVELS[i].masterWord.length !== 7);
    
    const shuffledSeven = [...sevenLetterIndices].sort(() => Math.random() - 0.5);
    const shuffledOthers = [...otherIndices].sort(() => Math.random() - 0.5);
    
    // First 7 levels should be 7-letter words if possible
    const firstPart = shuffledSeven.slice(0, 7);
    const remainingSeven = shuffledSeven.slice(7);
    const secondPart = [...shuffledOthers, ...remainingSeven].sort(() => Math.random() - 0.5);
    
    return [...firstPart, ...secondPart];
  }, []);

  // Initialize random level sequence and load stats
  useEffect(() => {
    setLevelSequence(generateLevelSequence());

    // Load stats from Persistence Service (Tauri Store or localStorage)
    loadStats().then(saved => {
      if (saved) {
        setGlobalStats(saved);
      }
    });
  }, []);


  const currentLevel = useMemo(() => {
    const idx = levelSequence[levelIndex] ?? 0;
    return LEVELS[idx];
  }, [levelIndex, levelSequence]);
  
  const possibleAnswers = useMemo(() => 
    currentLevel.answers.map(a => a.toUpperCase()).sort((a, b) => b.length - a.length || a.localeCompare(b))
  , [currentLevel]);

  const totalLettersInLevel = useMemo(() => {
    return possibleAnswers.reduce((acc, word) => acc + word.length, 0);
  }, [possibleAnswers]);

  const foundLettersInLevel = useMemo(() => {
    return foundWords.reduce((acc, fw) => acc + fw.word.length, 0);
  }, [foundWords]);

  const completionRate = useMemo(() => {
    if (totalLettersInLevel === 0) return 0;
    return (foundLettersInLevel / totalLettersInLevel) * 100;
  }, [foundLettersInLevel, totalLettersInLevel]);

  const targetLetters = useMemo(() => {
    return Math.ceil(totalLettersInLevel * 0.7);
  }, [totalLettersInLevel]);

  const exitToLobby = useCallback(() => {
    setGameState('lobby');
    setFoundWords([]);
    setSessionScores({});
    setLevelIndex(0);
    setShowRoundWords(false);
    setLevelSequence(generateLevelSequence());
    setTimeLeft(INITIAL_TIME);
    setHints({});
    setIsTimeFrozen(false);
  }, [generateLevelSequence]);

  // Use Refs for logic that needs stable values without re-triggering effects
  const gameStateRef = useRef(gameState);
  const possibleAnswersRef = useRef(possibleAnswers);
  const currentLevelRef = useRef(currentLevel);
  const foundWordsRef = useRef(foundWords);
  const sessionScoresRef = useRef(sessionScores);
  const awardProcessedRef = useRef(false);
  const sessionAwardedRef = useRef(false);
  const levelIndexRef = useRef(levelIndex);
  const currentSessionIdRef = useRef<string | null>(null);
  const lastProcessedLevelRef = useRef(-1);
  const processedWordsInRoundRef = useRef<Set<string>>(new Set());

  // Sync refs immediately in render
  gameStateRef.current = gameState;
  possibleAnswersRef.current = possibleAnswers;
  currentLevelRef.current = currentLevel;
  foundWordsRef.current = foundWords;
  sessionScoresRef.current = sessionScores;
  levelIndexRef.current = levelIndex;

  const totalLettersRef = useRef(0);
  totalLettersRef.current = totalLettersInLevel;
  const foundLettersRef = useRef(0);
  foundLettersRef.current = foundLettersInLevel;

  // Logic for awarding round and session wins
  const processRoundResults = useCallback((isSuccess: boolean) => {
    // ATOMIC GUARDS
    // 1. Prevent overlapping calls in the same round transition
    if (awardProcessedRef.current) return;
    // 2. Only process if we are actually playing
    if (gameStateRef.current !== 'playing') return;
    
    awardProcessedRef.current = true;
    
    addDebugLog("Processing Results", { isSuccess, level: levelIndex, sessionId: currentSessionIdRef.current });

    const contributors = foundWordsRef.current.reduce((acc, fw) => {
      const key = fw.user.toLowerCase();
      acc[key] = (acc[key] || 0) + fw.word.length;
      return acc;
    }, {} as Record<string, number>);
    const sortedRound = (Object.entries(contributors) as [string, number][]).sort((a, b) => b[1] - a[1]);

    setGlobalStats(prev => {
      const next = { ...prev };
      const roundPlayerSet = new Set(Object.keys(contributors));

      // Update maxLevelReached for all contributors in this round
      roundPlayerSet.forEach(userKey => {
        if (next[userKey]) {
          next[userKey] = {
            ...next[userKey],
            maxLevelReached: Math.max(next[userKey].maxLevelReached || 0, levelIndex + 1)
          };
        }
      });

      // 1. Award Round Win to #1 (Leader) ALWAYS, regardless of isSuccess
      // This ensures the leader of the round is recognized even on failure
      if (sortedRound.length > 0) {
        const roundWinnerKey = sortedRound[0][0];
        if (next[roundWinnerKey]) {
          next[roundWinnerKey] = {
            ...next[roundWinnerKey],
            roundWins: (next[roundWinnerKey].roundWins || 0) + 1
          };
          addDebugLog("Awarded ROUND Win", { user: roundWinnerKey });
        }
      }

      // 2. Award Participation and Streaks ONLY on Success
      if (isSuccess) {
        roundPlayerSet.forEach(userKey => {
          if (next[userKey]) {
            next[userKey] = {
              ...next[userKey],
              wins: (next[userKey].wins || 0) + 1,
              currentStreak: (next[userKey].currentStreak || 0) + 1,
              maxStreak: Math.max(next[userKey].maxStreak || 0, (next[userKey].currentStreak || 0) + 1)
            };
          }
        });

        // Reset streak for non-contributors
        Object.keys(next).forEach(userKey => {
          if (!roundPlayerSet.has(userKey)) {
            next[userKey] = { ...next[userKey], currentStreak: 0 };
          }
        });
      } else {
        // 3. SESSION FAILURE (Game Over)
        // Award Game Win (Session Leader) once per physical session
        if (!sessionAwardedRef.current) {
          sessionAwardedRef.current = true;
          const sortedSession = (Object.entries(sessionScoresRef.current) as [string, number][]).sort((a, b) => b[1] - a[1]);
          if (sortedSession.length > 0) {
            const gameWinnerKey = sortedSession[0][0].toLowerCase();
            if (next[gameWinnerKey]) {
              next[gameWinnerKey] = {
                ...next[gameWinnerKey],
                gameWins: (next[gameWinnerKey].gameWins || 0) + 1
              };
              addDebugLog("Awarded SESSION Win", { user: gameWinnerKey });
            }
          }
        }

        // Reset streaks for everyone on failure
        Object.keys(next).forEach(u => {
          next[u] = { ...next[u], currentStreak: 0 };
        });
      }
      return next;
    });

    setGameState('roundSummary');
  }, [levelIndex, addDebugLog]);

  // Timer logic
  useEffect(() => {
    if (gameState !== 'playing' || timeLeft <= 0 || isTimeFrozen) return;
    const timer = setInterval(() => {
      setTimeLeft(prev => {
        if (prev <= 1) {
          // If time is up, evaluate if the group reached the 70% letter threshold
          const rate = totalLettersRef.current === 0 ? 0 : (foundLettersRef.current / totalLettersRef.current) * 100;
          const isRoundSuccess = rate >= 70;
          processRoundResults(isRoundSuccess);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [timeLeft, gameState, processRoundResults, isTimeFrozen]);

  // Countdown logic
  useEffect(() => {
    if (gameState !== 'countdown') return;
    
    // Play sound for countdown ticks (5, 4, 3, 2, 1)
    if (countdownValue > 0) {
      const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2571/2571-preview.mp3');
      audio.volume = 0.5;
      audio.play().catch(e => console.log("Countdown sound blocked:", e));
    } else {
      // Start game sound
      const startAudio = new Audio('https://assets.mixkit.co/active_storage/sfx/2568/2568-preview.mp3');
      startAudio.volume = 0.4;
      startAudio.play().catch(e => console.log("Start sound blocked:", e));
    }

    const timer = setTimeout(() => {
      if (countdownValue <= 0) {
        setGameState('playing');
        setLastActionTime(Date.now());
      } else {
        setCountdownValue(prev => prev - 1);
      }
    }, 1000);

    return () => clearTimeout(timer);
  }, [gameState, countdownValue]);

  const shuffleLetters = useCallback(() => {
    // If pool is empty or level changed, initialize it
    // Check if we need to regenerate the pool
    const currentPool = lettersPoolRef.current;
    const isNewLevel = currentPool.length === 0 || 
                       currentPool.filter(l => !l.isDecoy).map(l => l.char).join('') !== currentLevel.masterWord;

    if (isNewLevel) {
      const letters: Letter[] = currentLevel.masterWord.split('').map((char) => ({ 
        id: Math.random(), 
        char, 
        isDecoy: false,
        isHidden: false
      }));
      
      // Add hidden letter logic from level 16 onwards
      if (levelIndex + 1 >= 16) {
        const randomIndex = Math.floor(Math.random() * letters.length);
        letters[randomIndex].isHidden = true;
      }
      
      // Add decoy letter from level 10 onwards
      if (levelIndex + 1 >= 10) {
        const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        const randomChar = alphabet[Math.floor(Math.random() * alphabet.length)];
        const decoy: Letter = { id: Math.random(), char: randomChar, isDecoy: true, isHidden: false };
        letters.push(decoy);
      }
      lettersPoolRef.current = letters;

      // Assign Special Words
      const newSpecialWords: Record<string, SpecialWordType> = {};
      
      // Level 1-3: 2 positive special words
      // Level 4-14: 2 positive
      // Level 15+: 2 positive, 1 hazard, 1 mystery
      const positiveTypes: SpecialWordType[] = ['FREEZE', 'GOLD', 'TIME', 'SCANNER'];
      const hazardTypes: SpecialWordType[] = ['STORM', 'DARKNESS', 'TRAP'];
      
      const posCount = levelIndex + 1 >= 11 ? 3 : 2;
      const hazCount = levelIndex + 1 >= 15 ? 1 : 0;
      const mysteryCount = levelIndex + 1 >= 15 ? 1 : 0;
      
      // Shuffle all but master word
      const shuffledAnswers = currentLevel.answers
        .filter(w => w.toUpperCase() !== currentLevel.masterWord.toUpperCase())
        .sort(() => Math.random() - 0.5);

      shuffledAnswers.slice(0, posCount).forEach((word) => {
        newSpecialWords[word.toUpperCase()] = positiveTypes[Math.floor(Math.random() * positiveTypes.length)];
      });
      
      shuffledAnswers.slice(posCount, posCount + hazCount).forEach((word) => {
        newSpecialWords[word.toUpperCase()] = hazardTypes[Math.floor(Math.random() * hazardTypes.length)];
      });

      shuffledAnswers.slice(posCount + hazCount, posCount + hazCount + mysteryCount).forEach((word) => {
        newSpecialWords[word.toUpperCase()] = 'MYSTERY';
      });

      setSpecialWords(newSpecialWords);
      specialWordsRef.current = newSpecialWords;
      setIsTimeFrozen(false);
      setIsDarknessActive(false);
    }

    setShuffledLetters([...lettersPoolRef.current].sort(() => Math.random() - 0.5));
  }, [currentLevel, levelIndex]);

  useEffect(() => {
    shuffleLetters();
    const interval = setInterval(shuffleLetters, 5000);
    return () => clearInterval(interval);
  }, [shuffleLetters]);

  // Round transition logic (100% completion)
  useEffect(() => {
    if (foundWords.length === possibleAnswers.length && possibleAnswers.length > 0 && gameState === 'playing') {
      // Immediate guard check to prevent multiple timeouts being scheduled
      if (awardProcessedRef.current) return;
      
      triggerConfetti(true);
      showFeedback("POZIOM WYCZYSZCZONY!", "success");
      
      const timer = setTimeout(() => {
        processRoundResults(true);
      }, 2000);
      
      return () => clearTimeout(timer);
    }
  }, [foundWords, possibleAnswers, gameState, processRoundResults]);

  // Hint Logic: Reveal a letter if no correct guess for 30 seconds
  useEffect(() => {
    if (gameState !== 'playing') return;
    
    const hintInterval = setInterval(() => {
      const timeSinceLastAction = (Date.now() - lastActionTime) / 1000;
      if (timeSinceLastAction >= 30) {
        revealRandomHint();
        setLastActionTime(Date.now());
      }
    }, 5000);
    return () => clearInterval(hintInterval);
  }, [lastActionTime, foundWords, hints, gameState]);

  const revealRandomHint = () => {
    const hiddenWords = possibleAnswers.filter(word => !foundWords.find(fw => fw.word === word));
    if (hiddenWords.length === 0) return;
    
    const randomWord = hiddenWords[Math.floor(Math.random() * hiddenWords.length)];
    const revealedIndices = hints[randomWord] || [];
    
    if (revealedIndices.length >= randomWord.length - 1) return;

    const availableIndices = Array.from({ length: randomWord.length }, (_, i) => i)
      .filter(i => !revealedIndices.includes(i));
    
    if (availableIndices.length === 0) return;
    
    const nextIndex = availableIndices[Math.floor(Math.random() * availableIndices.length)];
    
    setHints(prev => ({
      ...prev,
      [randomWord]: [...(prev[randomWord] || []), nextIndex]
    }));
    showFeedback("PODPOWIEDŹ!", "success");
  };

  const nextLevel = () => {
    // Determine the jump based on completion rate of the level we just finished
    const roundTotalLetters = possibleAnswers.reduce((acc, word) => acc + word.length, 0);
    const roundFoundLetters = foundWords.reduce((acc, fw) => acc + fw.word.length, 0);
    const rate = roundTotalLetters === 0 ? 0 : (roundFoundLetters / roundTotalLetters) * 100;
    
    let jump = 1;
    if (rate >= 100) jump = 3;
    else if (rate >= 85) jump = 2;

    addDebugLog("Transitioning to Next Level", { index: levelIndex, jump, rate });
    const nextIdx = levelIndex + jump;
    
    // RESET ATOMIC GUARDS
    processedWordsInRoundRef.current.clear();
    awardProcessedRef.current = false; // RELEASE LOCK
    setShowRoundWords(false);
    
    if (nextIdx >= LEVELS.length) {
      setLevelSequence(generateLevelSequence());
      setLevelIndex(0);
    } else {
      setLevelIndex(nextIdx);
    }
    setFoundWords([]);
    lettersPoolRef.current = [];
    setHints({});
    setLastActionTime(Date.now());
    setTimeLeft(INITIAL_TIME);
    setCountdownValue(5);
    setGameState('countdown');
  };

  const triggerConfetti = (isLevelFinish = false) => {
    if (isLevelFinish) {
      const end = Date.now() + 3000;
      const colors = ['#E63946', '#ffffff', '#1A1A1F'];

      (function frame() {
        confetti({
          particleCount: 3,
          angle: 60,
          spread: 55,
          origin: { x: 0 },
          colors: colors
        });
        confetti({
          particleCount: 3,
          angle: 120,
          spread: 55,
          origin: { x: 1 },
          colors: colors
        });

        if (Date.now() < end) {
          requestAnimationFrame(frame);
        }
      }());
    } else {
      confetti({
        particleCount: 100,
        spread: 70,
        origin: { y: 0.6 },
        colors: ['#E63946', '#ffffff']
      });
    }
  };

  // Twitch Client Setup (User pattern)
  useEffect(() => {
    if (!activeChannel) return;

    // Singleton check: If a client exists, disconnect it before recreating
    if (tmiClientRef.current) {
        addDebugLog("Destroying old TMI client", { channel: activeChannel });
        tmiClientRef.current.disconnect().catch(e => console.log("cleanup error", e));
        tmiClientRef.current.removeAllListeners();
    }

    const client = new tmi.Client({
      connection: { secure: true, reconnect: true },
      channels: [activeChannel],
    });
    tmiClientRef.current = client;

    addDebugLog("Creating new TMI client", { channel: activeChannel });
    setStatus(`Łączenie z: ${activeChannel}...`);

    client.on('message', (_channel, tags, message, self) => {
      if (self) return;
      
      // Clean up message: remove leading ! or / and trim
      let cleanMessage = message.trim();
      if (cleanMessage.startsWith('!') || cleanMessage.startsWith('/')) {
        cleanMessage = cleanMessage.substring(1).trim();
      }
      
      const guess = cleanMessage.toUpperCase();
      const rawUser = tags['display-name'] || tags.username || "Anonim";
      const userKey = rawUser.toLowerCase();
      const color = tags.color || "#9146FF";

      // Add to chat log
      const newMessage: ChatLog = {
        id: tags.id || Math.random().toString(),
        username: rawUser,
        message: message,
        color: color,
      };
      setMessages((prev) => [newMessage, ...prev].slice(0, 10));
      
      if (gameStateRef.current === 'playing') {
        if (guess.length < 3) return;

        // Synchronous check to prevent double-processing of the same word in the same round
        if (processedWordsInRoundRef.current.has(guess)) {
          addDebugLog("Duplicate word blocked", { guess, user: rawUser });
          return;
        }
        
        if (possibleAnswersRef.current.includes(guess)) {
          processedWordsInRoundRef.current.add(guess);
          addDebugLog("Match found", { guess, user: rawUser });
          setLastActionTime(Date.now());
          
          const isMaster = guess === currentLevelRef.current.masterWord;
          let specialType = specialWordsRef.current[guess];
          
          // Mystery Resolution
          let mysteryResolvedType: SpecialWordType = null;
          if (specialType === 'MYSTERY') {
            const allTypes: SpecialWordType[] = ['FREEZE', 'GOLD', 'TIME', 'SCANNER', 'STORM', 'DARKNESS', 'TRAP'];
            mysteryResolvedType = allTypes[Math.floor(Math.random() * allTypes.length)];
            specialType = mysteryResolvedType;
            showFeedback(`${rawUser}: NIESPODZIANKA! 🎁`, "success");
          }

          const pointsToAdd = specialType === 'GOLD' ? guess.length + 20 : guess.length;
          
          // Handle Special Effects
          if (specialType === 'FREEZE') {
            setIsTimeFrozen(true);
            showFeedback(`${rawUser}: CZAS ZAMROŻONY! (10s)`, "freeze");
            setTimeout(() => setIsTimeFrozen(false), 10000);
          } else if (specialType === 'TIME') {
            setTimeLeft(prev => prev + 15);
            showFeedback(`${rawUser}: DODATKOWY CZAS! (+15s)`, "success");
          } else if (specialType === 'SCANNER') {
            showFeedback(`${rawUser}: SKANER LITER!`, "success");
            setHints(prev => {
              const next = { ...prev };
              const hiddenWords = possibleAnswersRef.current.filter(w => !foundWordsRef.current.find(fw => fw.word === w));
              const count = Math.ceil(hiddenWords.length / 2);
              const selected = hiddenWords.sort(() => Math.random() - 0.5).slice(0, count);
              
              selected.forEach(word => {
                if (!next[word]) next[word] = [];
                if (!next[word].includes(0)) {
                  next[word] = [...next[word], 0].sort((a, b) => a - b);
                }
              });
              return next;
            });
          } else if (specialType === 'STORM') {
            showFeedback(`${rawUser}: SZTORM! (Przetasowanie)`, "hazard");
            shuffleLetters();
          } else if (specialType === 'DARKNESS') {
            showFeedback(`${rawUser}: MROK! (Litery Ukryte)`, "hazard");
            setIsDarknessActive(true);
            setTimeout(() => setIsDarknessActive(false), 7000);
          } else if (specialType === 'TRAP') {
            showFeedback(`${rawUser}: PUŁAPKA! (-10s)`, "hazard");
            setTimeLeft(prev => Math.max(0, prev - 10));
          }
          
          // 1. Update global stats (Atomic Functional Update)
          setGlobalStats(prev => {
            const userData = prev[userKey] || { 
               displayName: rawUser, 
               points: 0, 
               wins: 0, 
               roundWins: 0, 
               gameWins: 0, 
               masterWordWins: 0, 
               currentStreak: 0, 
               maxStreak: 0,
               maxLevelReached: 0
            };
            
            const next = {
              ...prev,
              [userKey]: {
                ...userData,
                displayName: rawUser,
                points: (userData.points || 0) + pointsToAdd,
                masterWordWins: isMaster ? (userData.masterWordWins || 0) + 1 : (userData.masterWordWins || 0),
                maxLevelReached: Math.max(userData.maxLevelReached || 0, levelIndexRef.current + 1)
              }
            };
            return next;
          });

          // 2. UI Feedback
          if (isMaster) {
            triggerConfetti();
            showFeedback(`${rawUser} ODKRYŁ HASŁO GŁÓWNE!`, "success");
          } else if (specialType === 'FREEZE') {
            // Already handled above with specific 'freeze' type
          } else if (specialType === 'GOLD') {
            showFeedback(`${rawUser}: ZŁOTE SŁOWO! (+20pkt)`, "success");
          } else {
            showFeedback(`${rawUser} odgadł: ${guess}`, "success");
          }

          // 3. Update session scores
          setSessionScores(prev => ({
            ...prev,
            [rawUser]: (prev[rawUser] || 0) + pointsToAdd
          }));

          // 4. Update round words
          setFoundWords(prev => [...prev, { word: guess, user: rawUser, points: pointsToAdd }]);
        }
      }
    });

    client.connect()
      .then(() => {
        addDebugLog("TMI Connected", { channel: activeChannel });
        setIsConnected(true);
        setStatus(`Aktywne: ${activeChannel}`);
      })
      .catch((err) => {
        addDebugLog("TMI Connect Error", err);
        setIsConnected(false);
        setStatus(`Błąd: ${err}`);
      });

    return () => {
      if (tmiClientRef.current) {
        addDebugLog("Unmounting TMI Cleanup", { channel: activeChannel });
        tmiClientRef.current.disconnect().catch(() => {});
        tmiClientRef.current.removeAllListeners();
        tmiClientRef.current = null;
      }
      setIsConnected(false);
    };
  }, [activeChannel, addDebugLog]);

  // Save stats when globalStats changes
  useEffect(() => {
    if (Object.keys(globalStats).length > 0) {
      saveStats(globalStats);
    }
  }, [globalStats]);

  const handleConnect = () => {
    if (inputValue.trim()) {
      setMessages([]); 
      setActiveChannel(inputValue.trim().toLowerCase());
    }
  };

  const showFeedback = (message: string, type: 'success' | 'error' | 'freeze' | 'hazard') => {
    setFeedback({ message, type });
    
    const soundUrl = type === 'success' 
      ? 'https://assets.mixkit.co/active_storage/sfx/2013/2013-preview.mp3' 
      : type === 'freeze'
        ? 'https://assets.mixkit.co/active_storage/sfx/2571/2571-preview.mp3'
        : type === 'hazard'
          ? 'https://assets.mixkit.co/active_storage/sfx/2501/2501-preview.mp3' // Explosion/Buzz sound
          : 'https://assets.mixkit.co/active_storage/sfx/2568/2568-preview.mp3';
    
    const audio = new Audio(soundUrl);
    audio.volume = 0.4;
    audio.play().catch(e => console.log("Audio playback blocked:", e));

    setTimeout(() => setFeedback({ message: "", type: null }), 2000);
  };

  const startGame = () => {
    addDebugLog("Starting New Session", {});
    setFoundWords([]);
    setSessionScores({});
    awardProcessedRef.current = false;
    sessionAwardedRef.current = false; 
    lettersPoolRef.current = [];
    currentSessionIdRef.current = Math.random().toString(36).substring(7);
    lastProcessedLevelRef.current = -1;
    processedWordsInRoundRef.current.clear();
    setCountdownValue(5);
    setGameState('countdown');
  };

  const leaders = useMemo(() => {
    const statsEntries = Object.entries(globalStats) as [string, UserStats][];
    if (statsEntries.length === 0) return {};
    
    // Find absolute top 1 for each category
    const getTop = (sortFn: (a: [string, UserStats], b: [string, UserStats]) => number) => {
      const sorted = [...statsEntries].sort(sortFn);
      const top = sorted[0];
      // Only return if they have more than the min threshold to be a leader
      // Also ensure the userKey is in the correct casing (lowercase for mapping)
      return (top && (sortFn(top, ['', { points: 0, wins: 0, roundWins: 0, gameWins: 0, masterWordWins: 0, currentStreak: 0, maxStreak: 0, maxLevelReached: 0, displayName: '' }] as [string, UserStats]) < 0)) ? top[0].toLowerCase() : null;
    };

    return {
      points: getTop((a, b) => b[1].points - a[1].points),
      roundWins: getTop((a, b) => (b[1].roundWins || 0) - (a[1].roundWins || 0)),
      gameWins: getTop((a, b) => (b[1].gameWins || 0) - (a[1].gameWins || 0)),
      master: getTop((a, b) => (b[1].masterWordWins || 0) - (a[1].masterWordWins || 0)),
      streak: getTop((a, b) => (b[1].maxStreak || 0) - (a[1].maxStreak || 0))
    };
  }, [globalStats]);

  const UserBadges = ({ username, size = "w-3 h-3" }: { username: string, size?: string }) => {
    const userKey = username.toLowerCase();
    const badgesData = [];
    
    if (leaders.points === userKey) badgesData.push({ icon: Trophy, color: "text-yellow-500", label: "LIDER PUNKTÓW" });
    if (leaders.roundWins === userKey) badgesData.push({ icon: Trophy, color: "text-green-400", label: "LIDER WYGRANYCH RUND" });
    if (leaders.gameWins === userKey) badgesData.push({ icon: Trophy, color: "text-blue-400", label: "LIDER WYGRANYCH SESJI" });
    if (leaders.master === userKey) badgesData.push({ icon: Crown, color: "text-orange-400", label: "MISTRZ HASEŁ GŁÓWNYCH" });
    if (leaders.streak === userKey) badgesData.push({ icon: Flame, color: "text-purple-400", label: "LIDER REKORDOWEJ SERII" });

    if (badgesData.length === 0) return null;

    return (
      <div className="inline-flex items-center gap-0.5 mr-1.5 h-full">
        {badgesData.map((b, i) => (
          <div key={i} className="relative group/badge flex items-center">
            <b.icon className={`${size} ${b.color} drop-shadow-[0_0_2px_rgba(0,0,0,0.5)] cursor-help`} />
            
            {/* Badge Tooltip */}
            <div className="invisible group-hover/badge:visible absolute bottom-full left-1/2 -translate-x-1/2 mb-2 p-2 bg-black/95 border border-white/20 rounded-lg text-[8px] font-black text-white whitespace-nowrap z-[110] pointer-events-none opacity-0 group-hover/badge:opacity-100 transition-all shadow-2xl backdrop-blur-md">
              {b.label}
              <div className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0 border-l-[4px] border-l-transparent border-r-[4px] border-r-transparent border-t-[4px] border-t-black"></div>
            </div>
          </div>
        ))}
      </div>
    );
  };
  
  // --- LOBBY SCREEN ---
  if (gameState === 'lobby') {
    return (
      <div className="min-h-screen bg-bg-main text-text-primary font-sans flex flex-col items-center justify-center p-6 relative overflow-hidden">
        {/* Animated background accents */}
        <div className="absolute top-1/4 left-1/4 w-64 h-64 bg-accent-red/5 rounded-full blur-3xl animate-pulse" />
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-purple-500/5 rounded-full blur-3xl animate-pulse delay-700" />
        
        <motion.div 
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          className="z-10 flex flex-col items-center max-w-md w-full text-center"
        >
          {/* Logo Section */}
          <div className="mb-8 relative">
            <div className="w-24 h-24 bg-accent-red rounded-3xl flex items-center justify-center shadow-[0_0_30px_rgba(230,57,70,0.3)] rotate-6">
              <FaTwitch className="w-12 h-12 text-white fill-white" />
            </div>
            <div className="absolute -bottom-2 -right-2 w-12 h-12 bg-white rounded-2xl flex items-center justify-center shadow-lg -rotate-12 border-2 border-accent-red">
              <Sparkles className="w-6 h-6 text-accent-red" />
            </div>
          </div>

          <h1 className="text-4xl font-black tracking-tighter mb-2 italic">
            TWITCH<span className="text-accent-red">GAMER</span>
          </h1>
          <p className="text-text-secondary font-medium tracking-widest text-[10px] uppercase mb-12 opacity-50">
            INTERAKTYWNA WYKREŚLANKA DLA TWOJEGO CZATU
          </p>

          <div className="w-full bg-bg-card border border-border-color rounded-2xl p-6 shadow-2xl">
            <div className="flex flex-col gap-4">
              <div className="text-left">
                <label className="text-[10px] font-black tracking-widest text-text-secondary uppercase ml-1 mb-2 block">
                  TWÓJ KANAŁ TWITCH
                </label>
                <div className="flex gap-2">
                  <div className="flex-1 bg-bg-main border border-border-color rounded-xl px-4 py-3 flex items-center gap-3 focus-within:border-purple-500/50 transition-all">
                    <FaTwitch className="w-4 h-4 text-text-secondary" />
                    <input 
                      type="text" 
                      placeholder="NAZWA KANAŁU..."
                      value={inputValue}
                      onChange={(e) => setInputValue(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleConnect()}
                      className="bg-transparent w-full outline-none text-sm font-bold placeholder:text-neutral-700 uppercase"
                    />
                  </div>
                  <button 
                    onClick={handleConnect}
                    className="bg-purple-600 hover:bg-purple-700 text-white font-black px-4 rounded-xl text-[11px] tracking-widest uppercase transition-all shadow-lg active:scale-95"
                  >
                    POŁĄCZ
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between p-3 rounded-xl bg-bg-main border border-border-color mt-2">
                <span className="text-[10px] font-black tracking-widest text-text-secondary uppercase">STATUS BOT'A:</span>
                <span className={`text-[10px] font-black tracking-widest uppercase ${isConnected ? 'text-green-500' : 'text-accent-red'}`}>
                  {status}
                </span>
              </div>

              <div className="flex justify-center mt-2">
                <span className="text-[9px] font-black tracking-widest text-neutral-600 uppercase">WERSJA: 0.1.1</span>
              </div>

              <div className="grid grid-cols-2 gap-3 mt-4">
                <button
                  disabled={!isConnected}
                  onClick={startGame}
                  className={`w-full py-4 rounded-xl font-black text-xs tracking-[0.2em] uppercase transition-all shadow-xl active:scale-95
                    ${isConnected 
                      ? 'bg-accent-red hover:bg-red-700 text-white' 
                      : 'bg-neutral-800 text-neutral-600 cursor-not-allowed opacity-50'
                    }
                  `}
                >
                  START
                </button>
                <button
                  onClick={() => setGameState('stats')}
                  className="w-full py-4 rounded-xl font-black text-xs tracking-[0.2em] uppercase transition-all shadow-xl active:scale-95 bg-neutral-800 text-white hover:bg-neutral-700 border border-neutral-700"
                >
                  STATYSTYKI
                </button>
              </div>
              
              <button
                onClick={() => setShowHelp(true)}
                className="w-full mt-2 py-3 rounded-xl font-black text-[10px] tracking-[0.3em] uppercase transition-all bg-white/5 text-text-secondary hover:bg-white/10 border border-white/5 flex items-center justify-center gap-2 group"
              >
                <Info className="w-3.5 h-3.5 group-hover:text-cyan-400 transition-colors" />
                INSTRUKCJA GRY
              </button>
            </div>
          </div>
        </motion.div>

        {/* Instructions Modal */}
        <AnimatePresence>
          {showHelp && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 bg-black/90 backdrop-blur-md flex items-center justify-center p-4"
            >
              <motion.div
                initial={{ scale: 0.9, y: 20 }}
                animate={{ scale: 1, y: 0 }}
                exit={{ scale: 0.9, y: 20 }}
                className="bg-bg-card border border-white/10 rounded-[2.5rem] max-w-2xl w-full max-h-[85vh] overflow-hidden flex flex-col shadow-2xl"
              >
                <div className="p-8 border-b border-white/5 flex items-center justify-between bg-white/5">
                  <div>
                    <h2 className="text-3xl font-black italic tracking-tighter text-white leading-none mb-1">INSTRUKCJA</h2>
                    <p className="text-[10px] font-black tracking-widest text-text-secondary uppercase opacity-50">ZASADY I BONUSY SPECJALNE</p>
                  </div>
                  <button 
                    onClick={() => setShowHelp(false)}
                    className="p-3 bg-white/5 hover:bg-accent-red rounded-2xl transition-all group"
                  >
                    <X className="w-6 h-6 text-white" />
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto p-8 custom-scrollbar space-y-8">
                  {/* Bonuses Table */}
                  <div className="space-y-4">
                    <h3 className="text-xs font-black tracking-[0.3em] text-cyan-400 uppercase flex items-center gap-2">
                      <Sparkles className="w-4 h-4" /> BONUSY SPECJALNE
                    </h3>
                    <div className="grid gap-2">
                       {/* GOLD */}
                       <div className="flex items-center gap-4 bg-yellow-400/5 border border-yellow-400/10 p-4 rounded-2xl">
                          <div className="w-12 h-12 bg-yellow-500 rounded-xl flex items-center justify-center shadow-[0_0_15px_rgba(234,179,8,0.3)] shrink-0">
                            <Trophy className="w-6 h-6 text-white" />
                          </div>
                          <div>
                            <h4 className="text-sm font-black text-yellow-500 uppercase">ZŁOTE SŁOWO</h4>
                            <p className="text-[11px] text-text-secondary leading-relaxed">Daje potężny bonus <span className="text-white font-bold">+20 PUNKTÓW</span> do podstawowej długości słowa.</p>
                          </div>
                       </div>
                       {/* FREEZE */}
                       <div className="flex items-center gap-4 bg-blue-400/5 border border-blue-400/10 p-4 rounded-2xl">
                          <div className="w-12 h-12 bg-blue-500 rounded-xl flex items-center justify-center shadow-[0_0_15px_rgba(59,130,246,0.3)] shrink-0">
                            <Timer className="w-6 h-6 text-white" />
                          </div>
                          <div>
                            <h4 className="text-sm font-black text-blue-400 uppercase">MROŹNE SŁOWO</h4>
                            <p className="text-[11px] text-text-secondary leading-relaxed"><span className="text-white font-bold">ZAMRAŻA CZAS</span> na 10 sekund, pozwalając czatowi na spokojne odgadywanie haseł.</p>
                          </div>
                       </div>
                       {/* TIME */}
                       <div className="flex items-center gap-4 bg-green-400/5 border border-green-400/10 p-4 rounded-2xl">
                          <div className="w-12 h-12 bg-green-500 rounded-xl flex items-center justify-center shadow-[0_0_15px_rgba(34,197,94,0.3)] shrink-0">
                            <Clock className="w-6 h-6 text-white" />
                          </div>
                          <div>
                            <h4 className="text-sm font-black text-green-500 uppercase">DODATKOWY CZAS</h4>
                            <p className="text-[11px] text-text-secondary leading-relaxed">Natychmiast dodaje <span className="text-white font-bold">+15 SEKUND</span> do licznika rundy.</p>
                          </div>
                       </div>
                       {/* SCANNER */}
                       <div className="flex items-center gap-4 bg-cyan-400/5 border border-cyan-400/10 p-4 rounded-2xl">
                          <div className="w-12 h-12 bg-cyan-500 rounded-xl flex items-center justify-center shadow-[0_0_15px_rgba(6,182,212,0.3)] shrink-0">
                            <Search className="w-6 h-6 text-white" />
                          </div>
                          <div>
                            <h4 className="text-sm font-black text-cyan-400 uppercase">SKANER LITER</h4>
                            <p className="text-[11px] text-text-secondary leading-relaxed">Automatycznie odkrywa <span className="text-white font-bold">PIERWSZĄ LITERĘ</span> w połowie nieodkrytych słów.</p>
                          </div>
                       </div>
                    </div>
                  </div>

                  {/* Hazards Table */}
                  <div className="space-y-4 pt-4 border-t border-white/5">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-black tracking-[0.3em] text-orange-500 uppercase flex items-center gap-2">
                        <Skull className="w-4 h-4" /> ZAGROŻENIA RUNDY
                      </h3>
                      <span className="text-[9px] font-black bg-orange-500/10 text-orange-500 px-2 py-0.5 rounded border border-orange-500/20 uppercase tracking-tighter">OD 15. POZIOMU</span>
                    </div>
                    <div className="grid gap-2">
                       {/* STORM */}
                       <div className="flex items-center gap-4 bg-orange-400/5 border border-orange-400/10 p-4 rounded-2xl opacity-80">
                          <div className="w-12 h-12 bg-orange-500 rounded-xl flex items-center justify-center shadow-[0_0_15px_rgba(249,115,22,0.3)] shrink-0">
                            <Wind className="w-6 h-6 text-white" />
                          </div>
                          <div>
                            <h4 className="text-sm font-black text-orange-500 uppercase">SZTORM</h4>
                            <p className="text-[11px] text-text-secondary leading-relaxed">Natychmiast <span className="text-white font-bold">PRZETASOWUJE</span> wszystkie litery na dolnej belce.</p>
                          </div>
                       </div>
                       {/* DARKNESS */}
                       <div className="flex items-center gap-4 bg-purple-400/5 border border-purple-400/10 p-4 rounded-2xl opacity-80">
                          <div className="w-12 h-12 bg-purple-600 rounded-xl flex items-center justify-center shadow-[0_0_15px_rgba(147,51,234,0.3)] shrink-0">
                            <Ghost className="w-6 h-6 text-white" />
                          </div>
                          <div>
                            <h4 className="text-sm font-black text-purple-400 uppercase">MROK</h4>
                            <p className="text-[11px] text-text-secondary leading-relaxed"><span className="text-white font-bold">ROZMYWA TABLICĘ</span> na 7 sekund, czyniąc litery i hasła niemal niewidocznymi.</p>
                          </div>
                       </div>
                       {/* TRAP */}
                       <div className="flex items-center gap-4 bg-neutral-400/5 border border-neutral-400/10 p-4 rounded-2xl opacity-80">
                          <div className="w-12 h-12 bg-neutral-700 rounded-xl flex items-center justify-center shadow-[0_0_15px_rgba(0,0,0,0.3)] shrink-0 border border-red-500/30">
                            <Skull className="w-6 h-6 text-white" />
                          </div>
                          <div>
                            <h4 className="text-sm font-black text-neutral-400 uppercase">PUŁAPKA</h4>
                            <p className="text-[11px] text-text-secondary leading-relaxed">Zabiera rundzie <span className="text-white font-bold">-10 SEKUND</span> cennego czasu.</p>
                          </div>
                       </div>
                    </div>
                  </div>

                  {/* Mystery Section */}
                  <div className="space-y-4 pt-4 border-t border-white/5">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-black tracking-[0.3em] text-white uppercase flex items-center gap-2">
                        <HelpCircle className="w-4 h-4" /> BONUS NIESPODZIANKA
                      </h3>
                      <span className="text-[9px] font-black bg-white/10 text-white px-2 py-0.5 rounded border border-white/20 uppercase tracking-tighter">OD 15. POZIOMU</span>
                    </div>
                    <div className="bg-white/5 border border-white/10 p-5 rounded-2xl flex items-center gap-4">
                      <div className="w-12 h-12 bg-white rounded-xl flex items-center justify-center shadow-[0_0_15px_rgba(255,255,255,0.2)] shrink-0 animate-bounce">
                        <HelpCircle className="w-6 h-6 text-bg-main" />
                      </div>
                      <p className="text-[11px] text-text-secondary leading-relaxed">
                        Nigdy nie wiesz co trafisz! Może to być <span className="text-green-400 font-bold">LEGENDARNY BONUS</span> lub <span className="text-accent-red font-bold">KRYTYCZNE ZAGROŻENIE</span>. Losuje jeden z dostępnych efektów w grze.
                      </p>
                    </div>
                  </div>

                  {/* Mechanics */}
                  <div className="space-y-4 pt-4 border-t border-white/5">
                    <h3 className="text-xs font-black tracking-[0.3em] text-accent-red uppercase flex items-center gap-2">
                       <ShieldCheck className="w-4 h-4" /> ELEMENTY ROZGRYWKI
                    </h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="bg-white/5 border border-white/5 p-5 rounded-2xl">
                        <div className="flex items-center gap-2 mb-2">
                          <Trash2 className="w-4 h-4 text-accent-red" />
                          <h4 className="text-[11px] font-black text-white uppercase italic">FAŁSZYWE LITERY</h4>
                        </div>
                        <p className="text-[10px] text-text-secondary leading-relaxed">Na belce z literami mogą znajdować się "zmyłki" - litery, które nie pasują do żadnego słowa w rundzie.</p>
                      </div>
                      <div className="bg-white/5 border border-white/5 p-5 rounded-2xl">
                        <div className="flex items-center gap-2 mb-2">
                          <Eye className="w-4 h-4 text-purple-400" />
                          <h4 className="text-[11px] font-black text-white uppercase italic">UKRYTE LITERY</h4>
                        </div>
                        <p className="text-[10px] text-text-secondary leading-relaxed">Od 16. poziomu niektóre wymagane litery mogą być całkowicie ukryte pod znakiem zapytania (?).</p>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="p-8 bg-white/5 border-t border-white/5">
                   <button 
                     onClick={() => setShowHelp(false)}
                     className="w-full bg-accent-red hover:bg-red-700 text-white py-4 rounded-xl font-black tracking-[0.2em] uppercase transition-all shadow-xl active:scale-95"
                   >
                     ROZUMIEM, GRAMY!
                   </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  // --- COUNTDOWN SCREEN ---
  if (gameState === 'countdown') {
    return (
      <div className="min-h-screen bg-bg-main flex flex-col items-center justify-center relative overflow-hidden">
         <motion.div 
            key={countdownValue}
            initial={{ scale: 2, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            className="text-[15rem] font-black italic text-accent-red tracking-tighter drop-shadow-[0_0_50px_rgba(230,57,70,0.5)]"
         >
            {countdownValue > 0 ? countdownValue : "GO!"}
         </motion.div>
         <motion.div 
            initial={{ width: 0 }}
            animate={{ width: "100%" }}
            transition={{ duration: 5 }}
            className="absolute bottom-0 left-0 h-2 bg-accent-red"
         />
         <div className="mt-12 text-[10px] font-black tracking-[1em] text-text-secondary uppercase opacity-50">
            PRZECHODZENIE DO PANELU GRY...
         </div>
      </div>
    );
  }

  // --- STATISTICS SCREEN ---
  if (gameState === 'stats') {
    const sortedByPoints = (Object.entries(globalStats) as [string, UserStats][]).sort((a, b) => b[1].points - a[1].points);
    const sortedByRoundWins = (Object.entries(globalStats) as [string, UserStats][]).sort((a, b) => (b[1].roundWins || 0) - (a[1].roundWins || 0));
    const sortedByGameWins = (Object.entries(globalStats) as [string, UserStats][]).sort((a, b) => (b[1].gameWins || 0) - (a[1].gameWins || 0));
    const sortedByMaster = (Object.entries(globalStats) as [string, UserStats][]).sort((a, b) => (b[1].masterWordWins || 0) - (a[1].masterWordWins || 0));
    const sortedByStreaks = (Object.entries(globalStats) as [string, UserStats][]).sort((a, b) => (b[1].maxStreak || 0) - (a[1].maxStreak || 0));
    const globalMaxLevel = Math.max(...(Object.values(globalStats) as UserStats[]).map(s => s.maxLevelReached || 0), 0);

    const handleReset = () => {
      setGlobalStats({});
      clearStats();
      setShowResetConfirm(false);
      showFeedback("Statystyki zostały zresetowane", "success");
    };

    return (
      <div className="min-h-screen bg-bg-main text-text-primary font-sans flex flex-col items-center justify-center p-6 relative overflow-hidden">
        {/* Reset Confirmation Overlay */}
        <AnimatePresence>
          {showResetConfirm && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-6"
            >
              <motion.div 
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                className="bg-bg-card border border-accent-red/30 p-8 rounded-3xl max-w-sm w-full text-center shadow-[0_0_50px_rgba(230,57,70,0.2)]"
              >
                <div className="w-16 h-16 bg-accent-red/20 rounded-2xl flex items-center justify-center mx-auto mb-6">
                  <AlertCircle className="w-8 h-8 text-accent-red" />
                </div>
                <h3 className="text-xl font-black italic mb-2">CZY NA PEWNO?</h3>
                <p className="text-text-secondary text-sm mb-8">Tej operacji nie można cofnąć. Wszystkie zdobyte punkty i wygrane zostaną bezpowrotnie usunięte.</p>
                
                <div className="flex flex-col gap-3">
                  <button 
                    onClick={handleReset}
                    className="w-full bg-accent-red hover:bg-red-700 text-white py-4 rounded-xl font-black text-xs tracking-widest uppercase transition-all shadow-lg active:scale-95"
                  >
                    TAK, USUŃ WSZYSTKO
                  </button>
                  <button 
                    onClick={() => setShowResetConfirm(false)}
                    className="w-full bg-neutral-800 hover:bg-neutral-700 text-white py-4 rounded-xl font-black text-xs tracking-widest uppercase transition-all border border-neutral-700"
                  >
                    ANULUJ
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-6xl w-full z-10 flex flex-col gap-8"
        >
          <div className="flex items-center justify-between">
            <div className="flex flex-col">
              <h2 className="text-5xl font-black italic tracking-tighter leading-none mb-1">GLOBALNE STATYSTYKI</h2>
              <div className="flex items-center gap-3">
                <span className="h-px w-8 bg-accent-red"></span>
                <p className="text-[10px] font-black tracking-[0.4em] text-text-secondary uppercase opacity-70">HISTORYCZNE ARCHIWUM MISTRZÓW</p>
              </div>
            </div>
            <div className="flex gap-3">
              <button 
                onClick={() => setShowResetConfirm(true)}
                title="Resetuj statystyki"
                className="p-4 bg-bg-card border border-accent-red/20 text-accent-red rounded-2xl hover:bg-accent-red hover:text-white transition-all active:scale-90 group"
              >
                <Trash2 className="w-5 h-5 group-hover:rotate-12 transition-transform" />
              </button>
              <button 
                onClick={() => setGameState('lobby')}
                className="p-4 bg-bg-card border border-border-color rounded-2xl hover:bg-neutral-800 transition-all active:scale-90 group"
              >
                <RotateCcw className="w-5 h-5 group-hover:-rotate-90 transition-transform duration-500" />
              </button>
            </div>
          </div>

          {/* HERO SECTION: GLOBAL WORLD RECORD (NAJDALSZA RUNDA) */}
          <section className="bg-bg-card border border-border-color rounded-[3rem] overflow-hidden shadow-2xl relative group">
            <div className="absolute inset-0 bg-linear-to-tr from-accent-red/5 via-transparent to-blue-500/5 opacity-50 group-hover:opacity-100 transition-opacity" />
            
            {/* Background elements */}
            <div className="absolute -top-24 -left-24 w-64 h-64 bg-accent-red/10 blur-[100px] rounded-full" />
            <div className="absolute -bottom-24 -right-24 w-64 h-64 bg-blue-500/10 blur-[100px] rounded-full" />
            
            <div className="relative p-12 flex flex-col items-center justify-center text-center">
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-center gap-3 mb-6"
              >
                <div className="h-px w-12 bg-accent-red/30" />
                <span className="text-[10px] font-black tracking-[0.5em] text-accent-red uppercase">REKORD ŚWIATA</span>
                <div className="h-px w-12 bg-accent-red/30" />
              </motion.div>

              <div className="relative">
                <motion.div 
                  initial={{ scale: 0.8, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ type: "spring", damping: 10, stiffness: 100 }}
                  className="text-[12rem] font-black font-mono leading-none tracking-tighter text-white drop-shadow-[0_0_30px_rgba(255,255,255,0.1)] mb-4"
                >
                  {globalMaxLevel}
                </motion.div>
                
                {/* Decorative brackets */}
                <div className="absolute -left-12 top-1/2 -translate-y-1/2 text-8xl font-thin text-white/5 selection:bg-transparent pointer-events-none">[</div>
                <div className="absolute -right-12 top-1/2 -translate-y-1/2 text-8xl font-thin text-white/5 selection:bg-transparent pointer-events-none">]</div>
              </div>

              <div className="bg-neutral-900/50 border border-white/5 px-8 py-3 rounded-2xl backdrop-blur-sm">
                <span className="text-sm font-black italic tracking-wider text-text-secondary uppercase">
                  NAJDALSZA OSIĄGNIĘTA RUNDA
                </span>
              </div>
            </div>
            
            {/* Bottom bar decorative */}
            <div className="h-1 w-full bg-linear-to-r from-transparent via-accent-red to-transparent opacity-30" />
          </section>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 w-full mb-12 text-center sm:text-left">
            {/* All-time Points Ranking */}
            <div className="bg-bg-card border border-border-color rounded-2xl shadow-2xl flex flex-col group relative">
              <div className="p-4 bg-neutral-900/50 border-b border-border-color flex items-center justify-between cursor-help">
                <div className="flex items-center gap-1.5">
                  <span className="text-[9px] font-black tracking-widest uppercase text-text-secondary">PUNKTY</span>
                  <Info className="w-2.5 h-2.5 text-text-secondary/50" />
                </div>
                <Trophy className="w-3 h-3 text-yellow-500" />
              </div>
              {/* Tooltip */}
              <div className="invisible group-hover:visible absolute top-0 left-1/2 -translate-x-1/2 -translate-y-[calc(100%+8px)] w-48 p-3 bg-neutral-900 border border-border-color rounded-xl text-[9px] font-bold text-text-secondary text-center z-50 pointer-events-none opacity-0 group-hover:opacity-100 transition-all shadow-[0_10px_30px_rgba(0,0,0,0.5)]">
                Suma liter ze wszystkich odgadniętych słów
                <div className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-full w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-t-[6px] border-t-neutral-900"></div>
              </div>
              <div className="max-h-[300px] overflow-y-auto p-4 space-y-2 custom-scrollbar">
                {sortedByPoints.slice(0, 50).map(([key, data]) => (
                  <div key={key} className="flex items-center justify-between bg-bg-main/50 p-2.5 rounded-lg border border-border-color hover:border-yellow-500/30 transition-colors">
                    <span className="font-bold text-[10px] truncate max-w-[80px]">{data.displayName || key}</span>
                    <span className="font-black text-[10px] text-accent-red font-mono">{data.points}</span>
                  </div>
                ))}
                {sortedByPoints.length === 0 && <div className="py-10 text-center opacity-20 text-[8px] font-bold">BRAK DANYCH</div>}
              </div>
            </div>

            {/* Round Wins Ranking */}
            <div className="bg-bg-card border border-border-color rounded-2xl shadow-2xl flex flex-col group relative">
              <div className="p-4 bg-green-900/10 border-b border-border-color flex items-center justify-between cursor-help">
                <div className="flex items-center gap-1.5">
                  <span className="text-[9px] font-black tracking-widest uppercase text-green-400">WYGRANE RUNDY</span>
                  <Info className="w-2.5 h-2.5 text-green-400/50" />
                </div>
                <Trophy className="w-3 h-3 text-green-400" />
              </div>
              {/* Tooltip */}
              <div className="invisible group-hover:visible absolute top-0 left-1/2 -translate-x-1/2 -translate-y-[calc(100%+8px)] w-48 p-3 bg-neutral-900 border border-border-color rounded-xl text-[9px] font-bold text-green-400 text-center z-50 pointer-events-none opacity-0 group-hover:opacity-100 transition-all shadow-[0_10px_30px_rgba(0,0,0,0.5)]">
                Ile razy gracz był #1 w pojedynczej rundzie
                <div className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-full w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-t-[6px] border-t-neutral-900"></div>
              </div>
              <div className="max-h-[300px] overflow-y-auto p-4 space-y-2 custom-scrollbar">
                {sortedByRoundWins.slice(0, 50).map(([key, data]) => (
                  <div key={`${key}-roundwins`} className="flex items-center justify-between bg-bg-main/50 p-2.5 rounded-lg border border-green-500/10 hover:border-green-500/30 transition-colors">
                    <span className="font-bold text-[10px] truncate max-w-[80px]">{data.displayName || key}</span>
                    <span className="font-black text-[10px] text-green-400 font-mono">{data.roundWins || 0}</span>
                  </div>
                ))}
                {sortedByRoundWins.length === 0 && <div className="py-10 text-center opacity-20 text-[8px] font-bold">BRAK DANYCH</div>}
              </div>
            </div>

            {/* Game Wins Ranking */}
            <div className="bg-bg-card border border-border-color rounded-2xl shadow-2xl flex flex-col group relative">
              <div className="p-4 bg-blue-900/10 border-b border-border-color flex items-center justify-between cursor-help">
                <div className="flex items-center gap-1.5">
                  <span className="text-[9px] font-black tracking-widest uppercase text-blue-400">WYGRANE GRY</span>
                  <Info className="w-2.5 h-2.5 text-blue-400/50" />
                </div>
                <Trophy className="w-3 h-3 text-blue-400" />
              </div>
              {/* Tooltip */}
              <div className="invisible group-hover:visible absolute top-0 left-1/2 -translate-x-1/2 -translate-y-[calc(100%+8px)] w-48 p-3 bg-neutral-900 border border-border-color rounded-xl text-[9px] font-bold text-blue-400 text-center z-50 pointer-events-none opacity-0 group-hover:opacity-100 transition-all shadow-[0_10px_30px_rgba(0,0,0,0.5)]">
                Ile razy gracz był #1 na koniec całej sesji
                <div className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-full w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-t-[6px] border-t-neutral-900"></div>
              </div>
              <div className="max-h-[300px] overflow-y-auto p-4 space-y-2 custom-scrollbar">
                {sortedByGameWins.slice(0, 50).map(([key, data]) => (
                  <div key={`${key}-gamewins`} className="flex items-center justify-between bg-bg-main/50 p-2.5 rounded-lg border border-blue-500/10 hover:border-blue-500/30 transition-colors">
                    <span className="font-bold text-[10px] truncate max-w-[80px]">{data.displayName || key}</span>
                    <span className="font-black text-[10px] text-blue-400 font-mono">{data.gameWins || 0}</span>
                  </div>
                ))}
                {sortedByGameWins.length === 0 && <div className="py-10 text-center opacity-20 text-[8px] font-bold">BRAK DANYCH</div>}
              </div>
            </div>

            {/* Master Word Ranking */}
            <div className="bg-bg-card border border-border-color rounded-2xl shadow-2xl flex flex-col group relative">
              <div className="p-4 bg-orange-900/10 border-b border-border-color flex items-center justify-between cursor-help">
                <div className="flex items-center gap-1.5">
                  <span className="text-[9px] font-black tracking-widest uppercase text-orange-400">MISTRZOWIE</span>
                  <Info className="w-2.5 h-2.5 text-orange-400/50" />
                </div>
                <Crown className="w-3 h-3 text-orange-400" />
              </div>
              {/* Tooltip */}
              <div className="invisible group-hover:visible absolute top-0 left-1/2 -translate-x-1/2 -translate-y-[calc(100%+8px)] w-48 p-3 bg-neutral-900 border border-border-color rounded-xl text-[9px] font-bold text-orange-400 text-center z-50 pointer-events-none opacity-0 group-hover:opacity-100 transition-all shadow-[0_10px_30px_rgba(0,0,0,0.5)]">
                Pierwsze odkrycie głównego hasła poziomu
                <div className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-full w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-t-[6px] border-t-neutral-900"></div>
              </div>
              <div className="max-h-[300px] overflow-y-auto p-4 space-y-2 custom-scrollbar">
                {sortedByMaster.slice(0, 50).map(([key, data]) => (
                  <div key={`${key}-master`} className="flex items-center justify-between bg-bg-main/50 p-2.5 rounded-lg border border-orange-500/10 hover:border-orange-500/30 transition-colors">
                    <span className="font-bold text-[10px] truncate max-w-[80px]">{data.displayName || key}</span>
                    <span className="font-black text-[10px] text-orange-400 font-mono">{data.masterWordWins || 0}</span>
                  </div>
                ))}
                {sortedByMaster.length === 0 && <div className="py-10 text-center opacity-20 text-[8px] font-bold">BRAK DANYCH</div>}
              </div>
            </div>

            {/* Max Streaks Ranking */}
            <div className="bg-bg-card border border-border-color rounded-2xl shadow-2xl flex flex-col group relative">
              <div className="p-4 bg-purple-900/10 border-b border-border-color flex items-center justify-between cursor-help">
                <div className="flex items-center gap-1.5">
                  <span className="text-[9px] font-black tracking-widest uppercase text-purple-400">REKORDY</span>
                  <Info className="w-2.5 h-2.5 text-purple-400/50" />
                </div>
                <Flame className="w-3 h-3 text-purple-400" />
              </div>
              {/* Tooltip */}
              <div className="invisible group-hover:visible absolute top-0 left-1/2 -translate-x-1/2 -translate-y-[calc(100%+8px)] w-48 p-3 bg-neutral-900 border border-border-color rounded-xl text-[9px] font-bold text-purple-400 text-center z-50 pointer-events-none opacity-0 group-hover:opacity-100 transition-all shadow-[0_10px_30px_rgba(0,0,0,0.5)]">
                Najdłuższa seria wygranych rund pod rząd
                <div className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-full w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-t-[6px] border-t-neutral-900"></div>
              </div>
              <div className="max-h-[300px] overflow-y-auto p-4 space-y-2 custom-scrollbar">
                {sortedByStreaks.slice(0, 50).map(([key, data]) => (
                  <div key={`${key}-streak`} className="flex items-center justify-between bg-bg-main/50 p-2.5 rounded-lg border border-purple-500/10 hover:border-purple-500/30 transition-colors">
                    <span className="font-bold text-[10px] truncate max-w-[80px]">{data.displayName || key}</span>
                    <div className="flex items-center gap-1">
                      <span className="font-black text-[10px] text-purple-400 font-mono">{data.maxStreak || 0}</span>
                    </div>
                  </div>
                ))}
                {sortedByStreaks.length === 0 && <div className="py-10 text-center opacity-20 text-[8px] font-bold">BRAK DANYCH</div>}
              </div>
            </div>
          </div>

          <button 
            onClick={() => setGameState('lobby')}
            className="w-full bg-accent-red hover:bg-red-700 text-white py-4 rounded-xl font-black tracking-[0.3em] uppercase transition-all shadow-xl active:scale-95"
          >
            POWRÓT DO MENU
          </button>
        </motion.div>
      </div>
    );
  }
  // --- ROUND SUMMARY / LEADERBOARD SCREEN ---
  if (gameState === 'roundSummary') {
    const roundTotalLetters = possibleAnswers.reduce((acc, word) => acc + word.length, 0);
    const roundFoundLetters = foundWords.reduce((acc, fw) => acc + fw.word.length, 0);
    const roundCompletionRate = roundTotalLetters === 0 ? 0 : (roundFoundLetters / roundTotalLetters) * 100;
    const isSuccess = roundCompletionRate >= 70;
    
    // Group round contributors by score
    const roundContributors = foundWords.reduce((acc, fw) => {
      acc[fw.user] = (acc[fw.user] || 0) + (fw.points || fw.word.length);
      return acc;
    }, {} as Record<string, number>);

    const sortedRound = (Object.entries(roundContributors) as [string, number][]).sort((a, b) => b[1] - a[1]);
    const sortedGlobal = (Object.entries(sessionScores) as [string, number][]).sort((a, b) => b[1] - a[1]);

    return (
      <div className="min-h-screen bg-bg-main text-text-primary font-sans flex flex-col items-center justify-center p-4 relative overflow-hidden">
        <motion.div 
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="max-w-4xl w-full flex flex-col items-center z-10"
        >
          <div className="mb-6">
            {isSuccess ? (
              <div className="flex flex-col items-center">
                 <Trophy className="w-20 h-20 text-yellow-500 mb-2 drop-shadow-[0_0_15px_rgba(234,179,8,0.4)]" />
                 <h2 className="text-4xl font-black italic tracking-tighter text-white uppercase">POZIOM {levelIndex + 1} UKOŃCZONY</h2>
                 <div className="flex flex-col items-center gap-1">
                    <span className="text-green-500 font-black tracking-[0.2em] text-sm uppercase">LITERY: {roundFoundLetters}/{roundTotalLetters} ({roundCompletionRate.toFixed(0)}%)</span>
                    {roundCompletionRate >= 100 ? (
                      <motion.div 
                        initial={{ scale: 0.8, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        className="bg-yellow-500/20 text-yellow-400 px-3 py-1 rounded-full text-[10px] font-black tracking-widest border border-yellow-500/30 animate-pulse"
                      >
                        BONUS: +3 POZIOMY! (100%)
                      </motion.div>
                    ) : roundCompletionRate >= 85 ? (
                      <motion.div 
                        initial={{ scale: 0.8, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        className="bg-blue-500/20 text-blue-400 px-3 py-1 rounded-full text-[10px] font-black tracking-widest border border-blue-500/30"
                      >
                        BONUS: +2 POZIOMY! (85%+)
                      </motion.div>
                    ) : null}
                 </div>
              </div>
            ) : (
              <div className="flex flex-col items-center">
                 <AlertCircle className="w-20 h-20 text-accent-red mb-2" />
                 <h2 className="text-4xl font-black italic tracking-tighter text-white">PORAŻKA!</h2>
                 <span className="text-accent-red font-black tracking-[0.2em] text-sm uppercase">LITERY: {roundFoundLetters}/{roundTotalLetters} ({roundCompletionRate.toFixed(0)}%)</span>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 w-full">
            {/* Round Leaderboard */}
            <div className="bg-bg-card border border-border-color rounded-2xl overflow-hidden shadow-2xl flex flex-col">
              <div className="p-6 bg-neutral-900/50 border-b border-border-color flex justify-between items-center">
                <span className="text-xs font-black tracking-widest uppercase text-text-secondary">WYNIK RUNDY</span>
                <div className="text-right">
                  <p className="text-[8px] font-bold text-text-secondary uppercase">SŁOWA</p>
                  <p className="text-sm font-black text-accent-red">{foundWords.length}/{possibleAnswers.length}</p>
                </div>
              </div>

              <div className="max-h-[300px] min-h-[200px] overflow-y-auto p-4 space-y-2 custom-scrollbar">
                {sortedRound.length > 0 ? (
                  sortedRound.map(([user, points], index) => (
                    <motion.div 
                      initial={{ x: -20, opacity: 0 }}
                      animate={{ x: 0, opacity: 1 }}
                      transition={{ delay: index * 0.05 }}
                      key={user} 
                      className="flex items-center justify-between bg-bg-main/50 p-3 rounded-xl border border-border-color"
                    >
                      <div className="flex items-center gap-4">
                        <span className={`w-6 text-[10px] font-black ${index === 0 ? 'text-yellow-400' : 'text-text-secondary'}`}>#{index + 1}</span>
                        <div className="flex items-center">
                          <UserBadges username={user} size="w-3.5 h-3.5" />
                          <span className="font-bold text-sm">{user}</span>
                        </div>
                      </div>
                      <span className="font-black text-accent-red text-sm">+{points}</span>
                    </motion.div>
                  ))
                ) : (
                  <div className="py-12 text-center opacity-30 text-[10px] font-black uppercase tracking-widest">Brak haseł</div>
                )}
              </div>
            </div>

            {/* Global Session Leaderboard */}
            <div className="bg-bg-card border border-border-color rounded-2xl overflow-hidden shadow-2xl flex flex-col">
              <div className="p-6 bg-purple-900/20 border-b border-border-color flex justify-between items-center">
                <span className="text-xs font-black tracking-widest uppercase text-purple-400">KLASYFIKACJA SESJI</span>
                <ShieldCheck className="w-4 h-4 text-purple-500" />
              </div>

              <div className="max-h-[300px] min-h-[200px] overflow-y-auto p-4 space-y-2 custom-scrollbar">
                {sortedGlobal.length > 0 ? (
                  sortedGlobal.map(([user, points], index) => (
                    <motion.div 
                      initial={{ x: 20, opacity: 0 }}
                      animate={{ x: 0, opacity: 1 }}
                      transition={{ delay: index * 0.05 }}
                      key={`${user}-global`} 
                      className="flex items-center justify-between bg-bg-main/50 p-3 rounded-xl border border-purple-500/10"
                    >
                      <div className="flex items-center gap-4">
                        <span className={`w-6 text-[10px] font-black ${index === 0 ? 'text-yellow-400' : 'text-text-secondary'}`}>#{index + 1}</span>
                        <div className="flex items-center">
                          <UserBadges username={user} size="w-3.5 h-3.5" />
                          <span className="font-bold text-sm text-text-primary">{user}</span>
                        </div>
                      </div>
                      <span className="font-black text-purple-400 text-sm">{points} pkt</span>
                    </motion.div>
                  ))
                ) : (
                  <div className="py-12 text-center opacity-30 text-[10px] font-black uppercase tracking-widest">Brak punktów</div>
                )}
              </div>
            </div>
          </div>

          <div className="w-full max-w-xl mt-6 space-y-4">
            {/* Show All Words Button */}
            <button 
              onClick={() => setShowRoundWords(!showRoundWords)}
              className="w-full bg-white/5 border border-white/10 hover:bg-white/10 text-white py-3 rounded-xl font-bold tracking-widest uppercase transition-all flex items-center justify-center gap-2 text-xs"
            >
              <Lightbulb className={`w-4 h-4 ${showRoundWords ? 'text-yellow-400' : 'text-text-secondary'}`} />
              {showRoundWords ? 'UKRYJ HASŁA' : 'POKAŻ WSZYSTKIE HASŁA'}
            </button>

            {showRoundWords && (
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-bg-card border border-border-color p-6 rounded-2xl shadow-inner"
              >
                <h3 className="text-[10px] font-black text-text-secondary uppercase tracking-[0.3em] mb-4 text-center">LISTA WSZYSTKICH HASEŁ</h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {possibleAnswers.map(word => {
                    const isFound = foundWords.some(fw => fw.word === word);
                    const specialType = specialWords[word];
                    return (
                      <div 
                        key={word}
                        className={`p-2 rounded-lg border flex flex-col items-center justify-center relative overflow-hidden ${
                          isFound ? 'bg-green-500/10 border-green-500/30' : 'bg-white/5 border-white/10'
                        }`}
                      >
                        <span className={`text-xs font-black font-mono tracking-tighter ${isFound ? 'text-green-500' : 'text-text-secondary'}`}>
                          {word}
                        </span>
                        {specialType && (
                          <div className={`absolute top-0 right-0 w-1.5 h-1.5 rounded-full m-1 ${
                            ['FREEZE', 'GOLD', 'TIME', 'SCANNER', 'MYSTERY'].includes(specialType || '') ? 'bg-cyan-400' : 'bg-red-500'
                          }`} />
                        )}
                      </div>
                    );
                  })}
                </div>
              </motion.div>
            )}

            <div className="p-6 bg-bg-card border border-border-color rounded-2xl shadow-2xl">
               {isSuccess ? (
                 <button 
                   onClick={nextLevel}
                   className="w-full bg-accent-red hover:bg-red-700 text-white py-4 rounded-xl font-black tracking-[0.3em] uppercase transition-all shadow-xl active:scale-95 flex items-center justify-center gap-3"
                 >
                   NASTĘPNA RUNDA <RotateCcw className="w-4 h-4" />
                 </button>
               ) : (
                 <button 
                   onClick={() => {
                     setGameState('lobby');
                     setFoundWords([]);
                     setShowRoundWords(false);
                     setSessionScores({}); // Reset session scores
                     setLevelIndex(0);
                      // Reshuffle on lobby return
                      setLevelSequence(generateLevelSequence());
                     setTimeLeft(INITIAL_TIME);
                     setHints({});
                   }}
                   className="w-full bg-neutral-800 hover:bg-neutral-700 text-white py-4 rounded-xl font-black tracking-[0.3em] uppercase transition-all shadow-xl active:scale-95 flex items-center justify-center gap-3"
                 >
                   POWRÓT DO STARTU <AlertCircle className="w-4 h-4" />
                 </button>
               )}
            </div>
          </div>
        </motion.div>
      </div>
    );
  }

  // --- GAME ENDED SCREEN (Fallback) ---
  if (gameState === 'ended') {
    return (
      <div className="min-h-screen bg-bg-main text-text-primary font-sans flex flex-col items-center justify-center p-6 text-center">
         <motion.div 
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="max-w-md w-full"
         >
            <AlertCircle className="w-20 h-20 text-accent-red mx-auto mb-6" />
            <h1 className="text-5xl font-black italic tracking-tighter mb-4">KONIEC GRY</h1>
            <button 
              onClick={() => setGameState('lobby')}
              className="w-full bg-white text-bg-main py-4 rounded-xl font-black tracking-[0.2em] uppercase hover:bg-accent-red hover:text-white transition-all active:scale-95"
            >
              POWRÓT DO LOBBY
            </button>
         </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg-main text-text-primary font-sans flex flex-col overflow-hidden items-center">
      
      {/* Letters Section (The Scrambler) */}
      <section className={`w-full h-[170px] flex flex-col items-center justify-center bg-linear-to-b from-bg-card to-bg-main relative transition-all duration-700 ${isDarknessActive ? 'blur-xl grayscale opacity-30 pointer-events-none scale-110' : ''}`}>
        <div className="flex gap-2 md:gap-4 px-4 overflow-x-auto scrollbar-hide max-w-full">
          <AnimatePresence mode="popLayout">
            {shuffledLetters.map((item) => {
              const masterWordFound = foundWords.some(fw => fw.word === currentLevel.masterWord);
              const isDecoyRevealed = item.isDecoy && (masterWordFound || timeLeft < 30);
              const isHiddenRevealed = item.isHidden && (masterWordFound || timeLeft < 30);
              
              const displayChar = (item.isHidden && !isHiddenRevealed) ? "?" : item.char;
              
              return (
                <motion.div
                  key={item.id}
                  layout
                  initial={{ opacity: 0, scale: 0.8, y: 15 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  transition={{ type: "spring", stiffness: 350, damping: 25 }}
                  className={`flex-shrink-0 w-[50px] h-[50px] md:w-[70px] md:h-[70px] flex items-center justify-center text-3xl md:text-5xl font-black rounded-xl shadow-[0_6px_0_#E63946] uppercase mb-4
                    ${isDecoyRevealed 
                      ? 'bg-[#4a0000] text-red-500 border-2 border-red-900 shadow-[0_6px_0_#2a0000]' 
                      : isHiddenRevealed
                        ? 'bg-yellow-400 text-bg-main border-2 border-yellow-600 shadow-[0_6px_0_#ca8a04]'
                        : masterWordFound ? 'bg-accent-red text-white' : 'bg-white text-bg-main'}
                  `}
                >
                  {displayChar}
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
        
        {/* Time Progress Bar (No Digital Clock) */}
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 w-[90%] max-w-3xl">
          <div className="w-full h-1.5 bg-neutral-900 rounded-full border border-border-color overflow-hidden shadow-inner flex justify-start relative">
            <motion.div 
              initial={{ width: "100%" }}
              animate={{ width: `${(timeLeft / INITIAL_TIME) * 100}%` }}
              transition={{ duration: 1, ease: "linear" }}
              className={`h-full rounded-full shadow-[0_0_10px_rgba(230,57,70,0.4)] transition-colors duration-500
                ${isTimeFrozen ? 'bg-cyan-400 animate-pulse' : timeLeft < 30 ? 'bg-red-500 animate-pulse' : 'bg-accent-red'}
              `}
            />
          </div>
          {isTimeFrozen && (
            <div className="absolute -top-6 left-1/2 -translate-x-1/2 text-[9px] font-black text-cyan-400 tracking-widest animate-bounce">
              CZAS ZAMROŻONY 🧊
            </div>
          )}
          {isDarknessActive && (
            <div className="absolute -top-6 left-1/2 -translate-x-1/2 text-[9px] font-black text-purple-400 tracking-widest animate-pulse">
              MROK AKTYWNY 🌫️
            </div>
          )}
        </div>
      </section>

      {/* Main Gameplay Area with Grid and Chat */}
      <main className="flex-1 w-full max-w-7xl flex gap-6 p-4 md:p-6 overflow-hidden items-stretch">
        
        {/* Answers Grid Section */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex justify-between items-end mb-4 border-b border-white/5 pb-4">
            <div className="flex flex-col">
              <div className="flex items-center gap-3 mb-1">
                <span className="text-[10px] font-black tracking-[0.3em] text-text-secondary uppercase opacity-50">STREFA GRY</span>
                <button 
                  onClick={exitToLobby}
                  className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-white/5 hover:bg-accent-red hover:text-white text-text-secondary transition-all group z-50 cursor-pointer"
                >
                  <X className="w-2.5 h-2.5" />
                  <span className="text-[8px] font-black uppercase tracking-tighter">WYJDŹ</span>
                </button>
              </div>
              <span className="text-3xl font-black tracking-tighter text-accent-red uppercase italic">POZIOM {levelIndex + 1}</span>
            </div>
            <div className="flex flex-col items-end">
               <span className="text-[10px] font-black tracking-[0.2em] text-text-secondary uppercase opacity-50 mb-1">ZDOBYTE LITERY:</span>
               <div className="flex items-baseline gap-2">
                 <span className={`text-2xl font-black font-mono transition-colors duration-500 ${completionRate >= 70 ? 'text-green-500' : 'text-accent-red'}`}>
                    {foundLettersInLevel}
                 </span>
                 <span className="text-text-secondary font-black text-sm opacity-30">/</span>
                 <div className="flex flex-col">
                   <span className="text-text-secondary font-black text-sm opacity-50 leading-none">{targetLetters}</span>
                   <span className="text-[7px] font-black tracking-widest text-text-secondary uppercase opacity-30 mt-0.5">CEL 70%</span>
                 </div>
               </div>
            </div>
          </div>

          <div className="flex-1 overflow-hidden pr-2">
            <div className={`grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2 h-full content-start transition-all duration-700 ${isDarknessActive ? 'blur-md grayscale opacity-20 pointer-events-none' : ''}`}>
              {possibleAnswers.map((word) => {
                const foundData = foundWords.find(fw => fw.word === word);
                const revealedIndices = hints[word] || [];
                const specialType = specialWords[word];
                
                return (
                  <motion.div
                    key={word}
                    initial={false}
                    animate={{ 
                      scale: foundData ? 1 : 0.98,
                      y: foundData ? 0 : 2
                    }}
                    className={`relative h-12 flex flex-col items-center justify-center rounded-lg border-2 transition-all duration-300
                      ${foundData 
                        ? 'bg-accent-red border-accent-red text-white shadow-[0_0_15px_rgba(230,57,70,0.2)]' 
                        : specialType === 'FREEZE' ? 'bg-blue-900/20 border-blue-500/50 shadow-[0_0_10px_rgba(59,130,246,0.3)]'
                        : specialType === 'GOLD' ? 'bg-yellow-900/20 border-yellow-500/50 shadow-[0_0_10px_rgba(234,179,8,0.3)]'
                        : specialType === 'TIME' ? 'bg-green-900/20 border-green-500/50 shadow-[0_0_10px_rgba(34,197,94,0.3)]'
                        : specialType === 'SCANNER' ? 'bg-cyan-900/20 border-cyan-500/50 shadow-[0_0_10px_rgba(6,182,212,0.3)]'
                        : specialType === 'STORM' ? 'bg-orange-900/20 border-orange-500/50'
                        : specialType === 'DARKNESS' ? 'bg-purple-900/20 border-purple-500/50'
                        : specialType === 'TRAP' ? 'bg-neutral-900 border-red-900/50'
                        : specialType === 'MYSTERY' ? 'bg-white/10 border-white/30 skew-x-1'
                        : 'bg-bg-card/50 border-border-color'
                      }
                      ${!foundData && specialType ? 'animate-pulse' : ''}
                    `}
                  >
                    {specialType && !foundData && (
                      <div className="absolute -top-2 -right-2 z-20">
                        {specialType === 'FREEZE' && <div className="w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center shadow-lg border-2 border-bg-main"><Timer className="w-3 h-3 text-white" /></div>}
                        {specialType === 'GOLD' && <div className="w-5 h-5 bg-yellow-500 rounded-full flex items-center justify-center shadow-lg border-2 border-bg-main"><Trophy className="w-3 h-3 text-white" /></div>}
                        {specialType === 'TIME' && <div className="w-5 h-5 bg-green-500 rounded-full flex items-center justify-center shadow-lg border-2 border-bg-main"><Clock className="w-3 h-3 text-white" /></div>}
                        {specialType === 'SCANNER' && <div className="w-5 h-5 bg-cyan-500 rounded-full flex items-center justify-center shadow-lg border-2 border-bg-main"><Search className="w-3 h-3 text-white" /></div>}
                        {specialType === 'STORM' && <div className="w-5 h-5 bg-orange-500 rounded-full flex items-center justify-center shadow-lg border-2 border-bg-main"><Wind className="w-3 h-3 text-white" /></div>}
                        {specialType === 'DARKNESS' && <div className="w-5 h-5 bg-purple-600 rounded-full flex items-center justify-center shadow-lg border-2 border-bg-main"><Ghost className="w-3 h-3 text-white" /></div>}
                        {specialType === 'TRAP' && <div className="w-5 h-5 bg-neutral-700 rounded-full flex items-center justify-center shadow-lg border-2 border-bg-main"><Skull className="w-3 h-3 text-white" /></div>}
                        {specialType === 'MYSTERY' && <div className="w-6 h-6 bg-white rounded-full flex items-center justify-center shadow-lg border-2 border-bg-main animate-bounce"><HelpCircle className="w-3.5 h-3.5 text-bg-main" /></div>}
                      </div>
                    )}
                    <div className={`font-black text-lg tracking-[0.2em] font-mono ${foundData ? 'text-white' : 'text-accent-red font-bold'}`}>
                      {foundData ? word : word.split('').map((char, i) => revealedIndices.includes(i) ? char : '_').join('')}
                      {revealedIndices.length > 0 && !foundData && <Sparkles className="inline-block w-3 h-3 ml-1 text-yellow-500 animate-pulse" />}
                    </div>
                    {foundData && (
                      <motion.div 
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="text-[8px] font-black mt-0.5 truncate max-w-[90%] opacity-90 px-1.5 py-0.25 rounded bg-black/20 uppercase tracking-tighter flex items-center gap-1"
                      >
                        <UserBadges username={foundData.user} size="w-2 h-2" />
                        {foundData.user}
                      </motion.div>
                    )}
                  </motion.div>
                );
              })}
            </div>
          </div>

          {/* Bottom Feedback Area (No Input) */}
          <div className="mt-4 h-16 bg-bg-card border border-border-color rounded-xl flex flex-col items-center justify-center relative overflow-hidden">
            <div className="text-[10px] font-black text-text-secondary tracking-[0.4em] uppercase opacity-50 flex flex-col items-center gap-1">
              <span>WPISUJ HASŁA NA CZACIE TWITCH</span>
              <div className="flex gap-4">
                {levelIndex + 1 >= 10 && (
                  <motion.span 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="text-accent-red animate-pulse tracking-widest text-[9px]"
                  >
                    UWAGA: JEDNA LITERA JEST FAŁSZYWA!
                  </motion.span>
                )}
                {levelIndex + 1 >= 16 && (
                  <motion.span 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="text-yellow-500 animate-pulse tracking-widest text-[9px]"
                  >
                    UWAGA: JEDNA LITERA JEST UKRYTA! (?)
                  </motion.span>
                )}
              </div>
            </div>
            
            <AnimatePresence>
              {feedback.type && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  className={`absolute inset-0 flex items-center justify-center gap-3 z-10 backdrop-blur-sm
                    ${feedback.type === 'success' ? 'bg-green-500/10 text-green-500' : 
                      feedback.type === 'freeze' ? 'bg-blue-500/10 text-blue-400' : 
                      feedback.type === 'hazard' ? 'bg-red-500/10 text-accent-red' : 'bg-accent-red/10 text-accent-red'}
                  `}
                >
                  {feedback.type === 'success' ? <CheckCircle2 className="w-5 h-5" /> : 
                   feedback.type === 'freeze' ? <Timer className="w-5 h-5 animate-spin-slow" /> : 
                   feedback.type === 'hazard' ? <Skull className="w-5 h-5 animate-bounce" /> : <AlertCircle className="w-5 h-5" />}
                  <span className="font-black text-sm tracking-widest uppercase">{feedback.message}</span>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Side Chat Panel */}
        <aside className="w-80 hidden lg:flex flex-col bg-bg-card border border-border-color rounded-2xl overflow-hidden shadow-2xl">
          {/* Consolidated Channel & Chat Header */}
          <div className="p-4 border-b border-border-color bg-neutral-900/50 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FaTwitch className={`w-4 h-4 ${isConnected ? 'text-purple-500 fill-purple-500' : 'text-neutral-700'}`} />
                <span className="text-[10px] font-black tracking-widest text-text-secondary uppercase">TWITCH CHAT</span>
              </div>
              <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500 shadow-[0_0_8px_#22c55e]' : 'bg-neutral-700'}`} />
            </div>
            <div className="flex items-center justify-between bg-bg-main/50 px-3 py-1.5 rounded-lg border border-border-color">
              <span className="text-[9px] font-bold text-text-secondary uppercase opacity-70">KANAŁ:</span>
              <span className="text-[11px] font-black text-purple-500 uppercase tracking-tighter">{activeChannel}</span>
            </div>
          </div>

          <div className="flex-1 p-4 overflow-y-auto space-y-3 custom-scrollbar flex flex-col-reverse">
            {messages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center space-y-2 opacity-30">
                <FaTwitch className="w-8 h-8" />
                <span className="text-[10px] font-black tracking-tighter">CZEKAM NA WIADOMOŚCI...</span>
              </div>
            ) : (
              messages.map((msg) => (
                <motion.div 
                  initial={{ opacity: 0, x: 10 }}
                  animate={{ opacity: 1, x: 0 }}
                  key={msg.id} 
                  className="text-xs break-words border-b border-white/5 pb-2 last:border-0"
                >
                  <div className="inline-flex items-baseline flex-wrap gap-x-1">
                    <UserBadges username={msg.username} size="w-2.5 h-2.5" />
                    <span className="font-black" style={{ color: msg.color }}>{msg.username}:</span>
                    <span className="text-text-secondary">{msg.message}</span>
                  </div>
                </motion.div>
              ))
            )}
          </div>
        </aside>
      </main>

      <style dangerouslySetInnerHTML={{ __html: `
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #2D2D35;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #E63946;
        }
        .scrollbar-hide::-webkit-scrollbar {
          display: none;
        }
      `}} />

      {/* X-RAY Debug Panel */}
      <div className="fixed bottom-4 left-4 z-[100]">
        <button 
          onClick={() => setShowDebug(!showDebug)}
          className="bg-neutral-900/80 backdrop-blur text-[9px] font-black py-1 px-3 rounded-full border border-white/10 hover:bg-neutral-800 transition-all text-white"
        >
          {showDebug ? 'HIDE DEBUG' : 'SHOW DEBUG (X-RAY)'}
        </button>
        
        <AnimatePresence>
          {showDebug && (
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="mt-2 w-80 max-h-[400px] bg-black/95 backdrop-blur-xl border border-white/20 rounded-2xl shadow-2xl flex flex-col overflow-hidden"
            >
              <div className="p-3 border-b border-white/10 flex items-center justify-between bg-white/5">
                <span className="text-[10px] font-black tracking-widest uppercase opacity-50 text-white">SYSTEM LOGS</span>
                <div className="flex gap-2">
                  <div className="px-2 py-0.5 bg-yellow-500/20 rounded border border-yellow-500/30 text-yellow-500 font-mono text-[9px] font-black flex items-center gap-2">
                    HASŁO: {currentLevel.masterWord}
                  </div>
                  <button 
                    onClick={() => {
                      const testWord = possibleAnswers[0] || 'DEBUG';
                      addDebugLog("Testing Idempotency (Guess)", { word: testWord });
                      // Simulate the exact logic twice to prove it's blocked
                      const simulate = () => {
                          const guess = testWord.toUpperCase();
                          const userKey = "debug_user";
                          if (processedWordsInRoundRef.current.has(guess)) return;
                          processedWordsInRoundRef.current.add(guess);
                          setGlobalStats(prev => ({
                            ...prev,
                            [userKey]: {
                                ...(prev[userKey] || { displayName: 'DebugUser', points: 0, wins: 0, roundWins: 0, gameWins: 0, masterWordWins: 0, currentStreak: 0, maxStreak: 0 }),
                                points: (prev[userKey]?.points || 0) + guess.length
                            }
                          }));
                      };
                      simulate();
                      simulate(); // This second call should be blocked by the sync ref
                    }}
                    className="text-[9px] font-bold text-blue-400 hover:text-blue-300"
                  >
                    TEST GUESS
                  </button>
                  <button onClick={() => setDebugLogs([])} className="text-[9px] font-bold hover:text-accent-red text-white">CLEAR</button>
                </div>
              </div>
              <div className="overflow-y-auto p-2 space-y-2 custom-scrollbar flex-1 bg-neutral-900/50">
                {debugLogs.map(log => (
                  <div key={log.id} className="text-[9px] border-b border-white/5 pb-2 last:border-0">
                    <div className="flex justify-between text-white/30 mb-0.5">
                      <span className="font-mono">{log.time}</span>
                      <span className="font-black text-accent-red tracking-widest uppercase">{log.event}</span>
                    </div>
                    <pre className="text-[8px] text-white/70 overflow-x-auto bg-black/30 p-1 rounded font-mono">
                      {JSON.stringify(log.data, null, 2)}
                    </pre>
                  </div>
                ))}
                {debugLogs.length === 0 && <div className="py-20 text-center text-white/20 text-[9px] font-bold italic">WAITING FOR EVENTS...</div>}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
