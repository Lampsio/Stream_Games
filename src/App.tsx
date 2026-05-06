import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Search, RotateCcw, CheckCircle2, AlertCircle, Timer, Trophy, ShieldCheck, Sparkles, Lightbulb, Trash2, Flame, Crown, Info, X, Clock, Eye, Wind, Ghost, Skull, HelpCircle, Globe, Settings, Volume2, VolumeX, Music, UserMinus, Maximize, Download, RefreshCw, AlertTriangle } from 'lucide-react';
import tmi from 'tmi.js';
import confetti from 'canvas-confetti';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

import logoImg from './assets/logo-ap.png';

import LEVELS_DATA from './levels.json';
import { loadStats, saveStats, clearStats } from './lib/persistence';
import { AUDIO_PATHS } from './constants';
import { FaTwitch } from "react-icons/fa";
import "./App.css";

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

type SpecialWordType = 'FREEZE' | 'GOLD' | 'TIME' | 'SCANNER' | 'STORM' | 'DARKNESS' | 'TRAP' | 'MYSTERY' | 'LEADER_BLOCK' | 'SHIELD' | 'SELF_STUN' | null;

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
  isCorrect?: boolean;
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
  totalShields: number;
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
  const [showDebug] = useState(false);
  const tmiClientRef = useRef<tmi.Client | null>(null);
  const [countdownValue, setCountdownValue] = useState(5);
  const [levelIndex, setLevelIndex] = useState(0);
  const [levelSequence, setLevelSequence] = useState<number[]>([]);
  const [foundWords, setFoundWords] = useState<FoundWord[]>([]);
  const [sessionScores, setSessionScores] = useState<Record<string, number>>({});
  const [sessionShields, setSessionShields] = useState<Record<string, number>>({});
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
  const [playedMasterWords, setPlayedMasterWords] = useState<string[]>([]);
  const [statsTab, setStatsTab] = useState<'world' | 'points' | 'rounds' | 'games' | 'masters' | 'streaks' | 'shields'>('world');
  const [blockedPlayer, setBlockedPlayer] = useState<{ username: string; expiresAt: number } | null>(null);
  
  // Layout Scaling Settings
  const [wordScale, setWordScale] = useState(() => {
    const saved = localStorage.getItem('wordScale');
    return saved ? parseFloat(saved) : 1;
  });
  const [diceScale, setDiceScale] = useState(() => {
    const saved = localStorage.getItem('diceScale');
    return saved ? parseFloat(saved) : 1;
  });
  const [diceSpacing, setDiceSpacing] = useState(() => {
    const saved = localStorage.getItem('diceSpacing');
    return saved ? parseInt(saved) : 24; // Default md:gap-6 is 24px
  });
  const [wordCols, setWordCols] = useState(() => {
    const saved = localStorage.getItem('wordCols');
    return saved ? parseInt(saved) : 3;
  });
  const [wordHeight, setWordHeight] = useState(() => {
    const saved = localStorage.getItem('wordHeight');
    return saved ? parseInt(saved) : 96; // Default 24rem (96px)
  });
  const [isCompactLayout, setIsCompactLayout] = useState(() => {
    const saved = localStorage.getItem('isCompactLayout');
    return saved === 'true';
  });

  const [timeLeft, setTimeLeft] = useState(INITIAL_TIME);
  const [hints, setHints] = useState<Record<string, number[]>>({}); // word: revealedIndices[]
  const [lastActionTime, setLastActionTime] = useState(Date.now());

  // Audio Settings
  const [soundVolume, setSoundVolume] = useState(0.5);
  const [musicVolume, setMusicVolume] = useState(0.3);
  const [settingsTab, setSettingsTab] = useState<'audio' | 'layout' | 'twitch' | 'admin'>('audio');
  const [showSettings, setShowSettings] = useState(false);
  
  // Tauri Updater States
  const [updateStatus, setUpdateStatus] = useState<{
    version: string;
    body?: string;
    date?: string;
  } | null>(null);
  const updateObjectRef = useRef<any>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [isDownloading, setIsDownloading] = useState(false);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  const musicRef = useRef<HTMLAudioElement | null>(null);
  const warningRef = useRef<HTMLAudioElement | null>(null);

  const playSound = useCallback((path: string, volumeScale: number = 1) => {
    const audio = new Audio(path);
    audio.volume = soundVolume * volumeScale;
    audio.play().catch(e => console.log("Sound blocked:", e));
  }, [soundVolume]);

  // Manage background music
  useEffect(() => {
    if (!musicRef.current) {
      musicRef.current = new Audio(AUDIO_PATHS.BACKGROUND_MUSIC);
      musicRef.current.loop = true;
    }
    musicRef.current.volume = musicVolume;
    musicRef.current.play().catch(e => console.log("Music blocked until interaction:", e));

    return () => {
      if (musicRef.current) {
        musicRef.current.pause();
      }
    };
  }, [musicVolume, gameState]);
  
  // Time warning sound (looping from 20s)
  useEffect(() => {
    if (gameState === 'playing' && timeLeft <= 20 && timeLeft > 0 && !isTimeFrozen) {
      if (!warningRef.current) {
        warningRef.current = new Audio(AUDIO_PATHS.TIME_WARNING);
        warningRef.current.loop = true;
      }
      warningRef.current.volume = soundVolume;
      warningRef.current.play().catch(e => console.log("Warning sound blocked:", e));
    } else {
      if (warningRef.current) {
        warningRef.current.pause();
        warningRef.current.currentTime = 0;
      }
    }

    return () => {
      if (warningRef.current) {
        warningRef.current.pause();
      }
    };
  }, [timeLeft, gameState, isTimeFrozen, soundVolume]);

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

  const generateLevelSequence = useCallback(() => {
    // Filter out already played words
    let availableIndices = LEVELS.map((_, i) => i).filter(i => !playedMasterWords.includes(LEVELS[i].masterWord));
    
    // If we've played everything or almost everything, reset the pool
    if (availableIndices.length < 5) {
      setPlayedMasterWords([]);
      availableIndices = LEVELS.map((_, i) => i);
    }

    const sevenLetterIndices = availableIndices.filter(i => LEVELS[i].masterWord.length === 7);
    const otherIndices = availableIndices.filter(i => LEVELS[i].masterWord.length !== 7);
    
    const shuffledSeven = [...sevenLetterIndices].sort(() => Math.random() - 0.5);
    const shuffledOthers = [...otherIndices].sort(() => Math.random() - 0.5);
    
    // First few levels should be 7-letter words if possible
    const firstCount = Math.min(shuffledSeven.length, 7);
    const firstPart = shuffledSeven.slice(0, firstCount);
    const remainingSeven = shuffledSeven.slice(firstCount);
    const secondPart = [...shuffledOthers, ...remainingSeven].sort(() => Math.random() - 0.5);
    
    return [...firstPart, ...secondPart];
  }, [playedMasterWords]);

  // Initialize random level sequence and load stats
  useEffect(() => {
    setLevelSequence(generateLevelSequence());

    // Load stats from Persistence Service (Tauri Store or localStorage)
    loadStats().then(saved => {
      if (saved) {
        setGlobalStats(saved);
      }
    });

    // Check for updates if running in Tauri
    const checkForUpdates = async () => {
      try {
        if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
          const update = await check();
          if (update) {
            updateObjectRef.current = update;
            setUpdateStatus({
              version: update.version,
              body: update.body,
              date: update.date
            });
            setShowUpdateModal(true);
            addDebugLog("Update Found", { version: update.version });
          }
        }
      } catch (err) {
        console.error("Update check failed:", err);
        addDebugLog("Update Check Error", err);
      }
    };

    checkForUpdates();
  }, []);

  const handleUpdate = async () => {
    if (!updateObjectRef.current) return;
    
    try {
      setIsDownloading(true);
      setUpdateError(null);
      setDownloadProgress(0);
      
      let downloaded = 0;
      let contentLength = 0;
      
      addDebugLog("Starting update download", { version: updateObjectRef.current.version });
      
      // We'll use download() then install() for more control
      await updateObjectRef.current.download((event: any) => {
        switch (event.event) {
          case 'Started':
            contentLength = event.data.contentLength || 0;
            addDebugLog("Update Download Started", { contentLength });
            break;
          case 'Progress':
            downloaded += event.data.chunkLength;
            if (contentLength > 0) {
              const progress = Math.round((downloaded / contentLength) * 100);
              setDownloadProgress(progress);
              // Avoid spamming logs too much, but log significant progress
              if (progress % 25 === 0) {
                addDebugLog("Download Progress", { progress, downloaded, total: contentLength });
              }
            }
            break;
          case 'Finished':
            addDebugLog("Update Download Finished", {});
            break;
        }
      });
      
      addDebugLog("Installation starting...", {});
      // install() will return after the installation procedure is started
      // On Windows, it usually triggers the installer which exits the app.
      await updateObjectRef.current.install();
      
      addDebugLog("Installation command sent, relaunching in 1s if still running...", {});
      
      // Delay relaunch slightly to allow the OS to handle the installation process
      // or to let the app naturally exit if that's what the installer expects.
      setTimeout(async () => {
        try {
          addDebugLog("Triggering manual relaunch...", {});
          await relaunch();
        } catch (relaunchErr) {
          console.error("Relaunch failed:", relaunchErr);
          addDebugLog("Relaunch Error", relaunchErr);
        }
      }, 1000);

    } catch (err) {
      console.error("Update failed:", err);
      setUpdateError("Błąd podczas aktualizacji: " + (err instanceof Error ? err.message : String(err)));
      setIsDownloading(false);
      addDebugLog("Update Error Detail", err);
    }
  };

  // Save layout settings to localStorage
  useEffect(() => {
    localStorage.setItem('wordScale', wordScale.toString());
    localStorage.setItem('diceScale', diceScale.toString());
    localStorage.setItem('diceSpacing', diceSpacing.toString());
    localStorage.setItem('wordCols', wordCols.toString());
    localStorage.setItem('wordHeight', wordHeight.toString());
    localStorage.setItem('isCompactLayout', isCompactLayout.toString());
  }, [wordScale, diceScale, diceSpacing, wordCols, wordHeight, isCompactLayout]);

  // Auto-scroll chat to bottom
  useEffect(() => {
    if (messages.length > 0) {
      const bottom = document.getElementById('chat-bottom');
      bottom?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  const currentLevel = useMemo(() => {
    const idx = levelSequence[levelIndex] ?? 0;
    return LEVELS[idx];
  }, [levelIndex, levelSequence]);
  
  const possibleAnswers = useMemo(() => 
    (Array.from(new Set(currentLevel.answers.map(a => a.toUpperCase()))) as string[])
      .sort((a, b) => b.length - a.length || a.localeCompare(b))
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

  const currentLeader = useMemo(() => {
    const players = Object.entries(sessionScores) as [string, number][];
    if (players.length === 0) return null;
    return players.sort((a, b) => b[1] - a[1])[0][0];
  }, [sessionScores]);

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
    setBlockedPlayer(null);
    setSessionShields({});
  }, [generateLevelSequence]);

  // Use Refs for logic that needs stable values without re-triggering effects
  const gameStateRef = useRef(gameState);
  const possibleAnswersRef = useRef(possibleAnswers);
  const currentLevelRef = useRef(currentLevel);
  const foundWordsRef = useRef(foundWords);
  const sessionScoresRef = useRef(sessionScores);
  const sessionShieldsRef = useRef(sessionShields);
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
  sessionShieldsRef.current = sessionShields;
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
    
    // Play round end sound
    playSound(isSuccess ? AUDIO_PATHS.ROUND_SUCCESS : AUDIO_PATHS.ROUND_FAILURE, 1);
  }, [levelIndex, addDebugLog, playSound]);

  // Timer logic
  useEffect(() => {
    if (gameState !== 'playing' || isTimeFrozen) return;
    
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
  }, [gameState, isTimeFrozen, processRoundResults]);

  // Countdown logic
  useEffect(() => {
    if (gameState !== 'countdown') return;
    
    // Play sound for countdown ticks (5, 4, 3, 2, 1)
    if (countdownValue > 0) {
      playSound(AUDIO_PATHS.COUNTDOWN_TICK, 1);
    } else {
      // Start game sound
      playSound(AUDIO_PATHS.GAME_START, 0.8);
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
        const alphabet = "AĄBCĆDEĘFGHIJKLŁMNŃOÓPRSŚTUWYZŹŻ";
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
      const positiveTypes: SpecialWordType[] = ['FREEZE', 'GOLD', 'TIME', 'SCANNER', 'SHIELD'];
      const hazardTypes: SpecialWordType[] = ['STORM', 'DARKNESS', 'TRAP'];
      if (levelIndex + 1 >= 25) hazardTypes.push('SELF_STUN');
      
      const posCount = levelIndex + 1 >= 11 ? 3 : 2;
      const hazCount = levelIndex + 1 >= 15 ? 1 : 0;
      const mysteryCount = levelIndex + 1 >= 15 ? 1 : 0;
      const leaderBlockCount = levelIndex + 1 >= 15 ? 1 : 0;
      const shieldCount = levelIndex + 1 >= 10 ? 1 : 0;
      
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

      shuffledAnswers.slice(posCount + hazCount + mysteryCount, posCount + hazCount + mysteryCount + leaderBlockCount).forEach((word) => {
        newSpecialWords[word.toUpperCase()] = 'LEADER_BLOCK';
      });

      shuffledAnswers.slice(posCount + hazCount + mysteryCount + leaderBlockCount, posCount + hazCount + mysteryCount + leaderBlockCount + shieldCount).forEach((word) => {
        newSpecialWords[word.toUpperCase()] = 'SHIELD';
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
    showFeedback("PODPOWIEDŹ!", "success", 'HINT_REVEALED');
  };

  const nextLevel = () => {
    // Track played master word
    const lastWord = currentLevel.masterWord;
    setPlayedMasterWords(prev => [...prev, lastWord]);

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
    
    if (nextIdx >= levelSequence.length) {
      setLevelSequence(generateLevelSequence());
      setLevelIndex(0);
    } else {
      setLevelIndex(nextIdx);
    }
    setFoundWords([]);
    lettersPoolRef.current = [];
    setHints({});
    setBlockedPlayer(null);
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

      // Check if player is blocked
      if (blockedPlayer && blockedPlayer.username.toLowerCase() === userKey && Date.now() < blockedPlayer.expiresAt) {
        return;
      }

      const color = tags.color || "#9146FF";

      // Check if correct before adding to log
      let isCorrectMessage = false;
      if (gameStateRef.current === 'playing' && guess.length >= 3) {
        if (!processedWordsInRoundRef.current.has(guess) && possibleAnswersRef.current.includes(guess)) {
          isCorrectMessage = true;
        }
      }

      // Add to chat log
      const newMessage: ChatLog = {
        id: tags.id || Math.random().toString(),
        username: rawUser,
        message: message,
        color: color,
        isCorrect: isCorrectMessage,
      };
      setMessages((prev) => [...prev, newMessage].slice(-50));
      
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
            const allTypes: SpecialWordType[] = ['FREEZE', 'GOLD', 'TIME', 'SCANNER', 'STORM', 'DARKNESS', 'TRAP', 'LEADER_BLOCK'];
            mysteryResolvedType = allTypes[Math.floor(Math.random() * allTypes.length)];
            specialType = mysteryResolvedType;
            showFeedback(`${rawUser}: NIESPODZIANKA! 🎁`, "success", 'BONUS_MYSTERY');
          }

          let pointsToAdd = specialType === 'GOLD' ? guess.length + 20 : guess.length;
          
          // Helper to check and consume shield
          const hasShield = (user: string) => {
            const shields = sessionShieldsRef.current[user] || 0;
            if (shields > 0) {
              setSessionShields(prev => ({ ...prev, [user]: shields - 1 }));
              return true;
            }
            return false;
          };

          // Handle Special Effects
          if (specialType === 'SHIELD') {
            setSessionShields(prev => ({ 
              ...prev, 
              [rawUser]: Math.min((prev[rawUser] || 0) + 1, 3) 
            }));
            showFeedback(`${rawUser}: TARCZA ZDOBYTA! 🛡️`, "success", 'BONUS_SHIELD');
          } else if (specialType === 'FREEZE') {
            setIsTimeFrozen(true);
            showFeedback(`${rawUser}: CZAS ZAMROŻONY! (10s)`, "freeze", 'BONUS_FREEZE');
            setTimeout(() => setIsTimeFrozen(false), 10000);
          } else if (specialType === 'TIME') {
            setTimeLeft(prev => prev + 15);
            showFeedback(`${rawUser}: DODATKOWY CZAS! (+15s)`, "success", 'BONUS_TIME');
          } else if (specialType === 'SCANNER') {
            showFeedback(`${rawUser}: SKANER LITER!`, "success", 'BONUS_SCANNER');
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
            if (hasShield(rawUser)) {
              showFeedback(`${rawUser}: TARCZA CHRONI PRZED SZTORMEM! 🛡️`, "success", 'BONUS_SHIELD');
            } else {
              showFeedback(`${rawUser}: SZTORM! (Przetasowanie)`, "hazard", 'HAZARD_STORM');
              shuffleLetters();
            }
          } else if (specialType === 'DARKNESS') {
            if (hasShield(rawUser)) {
              showFeedback(`${rawUser}: TARCZA CHRONI PRZED MROKIEM! 🛡️`, "success", 'BONUS_SHIELD');
            } else {
              showFeedback(`${rawUser}: MROK! (Litery Ukryte)`, "hazard", 'HAZARD_DARKNESS');
              setIsDarknessActive(true);
              setTimeout(() => setIsDarknessActive(false), 7000);
            }
          } else if (specialType === 'TRAP') {
            if (hasShield(rawUser)) {
              showFeedback(`${rawUser}: TARCZA CHRONI PRZED PUŁAPKĄ! 🛡️`, "success", 'BONUS_SHIELD');
            } else {
              showFeedback(`${rawUser}: PUŁAPKA! (-10s)`, "hazard", 'HAZARD_TRAP');
              setTimeLeft(prev => Math.max(0, prev - 10));
            }
          } else if (specialType === 'LEADER_BLOCK') {
            const actualLeader = (Object.entries(sessionScoresRef.current) as [string, number][]).sort((a, b) => b[1] - a[1])[0]?.[0];
            
            if (actualLeader && rawUser !== actualLeader) {
              if (hasShield(actualLeader)) {
                showFeedback(`LIDER ${actualLeader} UŻYŁ TARCZY! 🛡️`, "success", 'BONUS_SHIELD');
              } else {
                setBlockedPlayer({ username: actualLeader, expiresAt: Date.now() + 20000 });
                showFeedback(`${rawUser} BLOKUJE LIDERA (${actualLeader})!`, "hazard", 'HAZARD_BLOCK');
              }
            } else if (actualLeader && rawUser === actualLeader) {
              pointsToAdd += 30;
              showFeedback(`LIDER ${rawUser} ZYSKUJE BONUS! (+30pkt)`, "success", 'BONUS_GOLD');
            } else {
              // No leader yet or solo play
              pointsToAdd += 20;
              showFeedback(`${rawUser}: BONUS SPECJALNY! (+20pkt)`, "success", 'BONUS_GOLD');
            }
          } else if (specialType === 'SELF_STUN') {
            if (hasShield(rawUser)) {
              showFeedback(`${rawUser}: TARCZA CHRONI PRZED PARALIŻEM! 🛡️`, "success", 'BONUS_SHIELD');
            } else {
              setBlockedPlayer({ username: rawUser, expiresAt: Date.now() + 20000 });
              showFeedback(`${rawUser}: PARALIŻ! Zablokowany na 20s 🚫`, "hazard", 'HAZARD_STUN');
            }
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
               maxLevelReached: 0,
               totalShields: 0
            };
            
            const next = {
              ...prev,
              [userKey]: {
                ...userData,
                displayName: rawUser,
                points: (userData.points || 0) + pointsToAdd,
                masterWordWins: isMaster ? (userData.masterWordWins || 0) + 1 : (userData.masterWordWins || 0),
                maxLevelReached: Math.max(userData.maxLevelReached || 0, levelIndexRef.current + 1),
                totalShields: specialType === 'SHIELD' ? (userData.totalShields || 0) + 1 : (userData.totalShields || 0)
              }
            };
            return next;
          });

          // 2. UI Feedback
          if (isMaster) {
            triggerConfetti();
            showFeedback(`${rawUser} ODKRYŁ HASŁO GŁÓWNE!`, "success", 'MASTER_WORD_CORRECT');
          } else if (specialType === 'FREEZE') {
            // Already handled above with specific 'freeze' type
          } else if (specialType === 'GOLD') {
            showFeedback(`${rawUser}: ZŁOTE SŁOWO! (+20pkt)`, "success", 'BONUS_GOLD');
          } else {
            showFeedback(`${rawUser} odgadł: ${guess}`, "success", 'WORD_CORRECT');
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

  const showFeedback = (message: string, type: 'success' | 'error' | 'freeze' | 'hazard', soundKey?: keyof typeof AUDIO_PATHS) => {
    setFeedback({ message, type });
    
    let soundUrl: string = "";
    
    if (soundKey && AUDIO_PATHS[soundKey]) {
      soundUrl = AUDIO_PATHS[soundKey];
    } else {
      // Fallbacks if no specific soundKey provided
      soundUrl = type === 'success' 
        ? AUDIO_PATHS.WORD_CORRECT
        : type === 'freeze'
          ? AUDIO_PATHS.BONUS_FREEZE
          : type === 'hazard'
            ? AUDIO_PATHS.HAZARD_TRAP
            : AUDIO_PATHS.WORD_CORRECT;
    }
    
    if (soundUrl) {
      playSound(soundUrl, 1);
    }

    setTimeout(() => setFeedback({ message: "", type: null }), 2000);
  };

  const startGame = () => {
    addDebugLog("Starting New Session", {});
    setFoundWords([]);
    setSessionScores({});
    awardProcessedRef.current = false;
    sessionAwardedRef.current = false; 
    lettersPoolRef.current = [];
    setBlockedPlayer(null);
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
  
  // --- GLOBAL OVERLAYS ---
  const renderGlobalOverlays = () => (
    <>
      {/* Settings Modal */}
      <AnimatePresence>
        {showSettings && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-md flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="bg-bg-card border border-white/10 rounded-[2.5rem] max-w-2xl w-full overflow-hidden flex flex-col shadow-2xl"
            >
              <div className="p-8 border-b border-white/5 flex flex-col sm:flex-row sm:items-center justify-between gap-6 bg-white/5">
                <div>
                  <h2 className="text-3xl font-black italic tracking-tighter text-white leading-none mb-1">USTAWIENIA</h2>
                  <p className="text-[10px] font-black tracking-widest text-text-secondary uppercase opacity-50">
                    {settingsTab === 'audio' && 'DŹWIĘK I MUZYKA'}
                    {settingsTab === 'layout' && 'UKŁAD I SKALOWANIE'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex bg-black/20 p-1 rounded-2xl border border-white/5">
                    <button 
                      onClick={() => setSettingsTab('audio')}
                      className={`px-6 py-2 rounded-xl text-[10px] font-black tracking-widest transition-all ${settingsTab === 'audio' ? 'bg-white/15 text-white' : 'text-white/30 hover:text-white'}`}
                    >
                      DŹWIĘK
                    </button>
                    <button 
                      onClick={() => setSettingsTab('layout')}
                      className={`px-6 py-2 rounded-xl text-[10px] font-black tracking-widest transition-all ${settingsTab === 'layout' ? 'bg-white/15 text-white' : 'text-white/30 hover:text-white'}`}
                    >
                      UKŁAD
                    </button>
                  </div>
                  <button 
                    onClick={() => setShowSettings(false)}
                    className="p-3 bg-white/5 hover:bg-accent-red rounded-2xl transition-all group ml-2"
                  >
                    <X className="w-6 h-6 text-white" />
                  </button>
                </div>
              </div>

              <div className="p-8 space-y-8 min-h-[300px]">
                {settingsTab === 'audio' && (
                  <motion.div initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} className="space-y-8">
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <Music className="w-5 h-5 text-purple-400" />
                          <span className="text-xs font-black text-white tracking-widest uppercase">GŁOŚNOŚĆ MUZYKI</span>
                        </div>
                        <span className="text-xs font-mono font-black text-purple-400">{Math.round(musicVolume * 100)}%</span>
                      </div>
                      <div className="flex items-center gap-4">
                        {musicVolume === 0 ? <VolumeX className="w-4 h-4 text-neutral-600" /> : <Volume2 className="w-4 h-4 text-neutral-400" />}
                        <input 
                          type="range" 
                          min="0" 
                          max="1" 
                          step="0.01" 
                          value={musicVolume}
                          onChange={(e) => setMusicVolume(parseFloat(e.target.value))}
                          className="flex-1 h-1.5 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-purple-500"
                        />
                      </div>
                    </div>

                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <Volume2 className="w-5 h-5 text-accent-red" />
                          <span className="text-xs font-black text-white tracking-widest uppercase">EFEKTY DŹWIĘKOWE</span>
                        </div>
                        <span className="text-xs font-mono font-black text-accent-red">{Math.round(soundVolume * 100)}%</span>
                      </div>
                      <div className="flex items-center gap-4">
                        {soundVolume === 0 ? <VolumeX className="w-4 h-4 text-neutral-600" /> : <Volume2 className="w-4 h-4 text-neutral-400" />}
                        <input 
                          type="range" 
                          min="0" 
                          max="1" 
                          step="0.01" 
                          value={soundVolume}
                          onChange={(e) => setSoundVolume(parseFloat(e.target.value))}
                          className="flex-1 h-1.5 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-accent-red"
                        />
                      </div>
                    </div>
                  </motion.div>
                )}

                {settingsTab === 'layout' && (
                  <motion.div initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} className="space-y-8">
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <Eye className="w-5 h-5 text-cyan-400" />
                          <span className="text-xs font-black text-white tracking-widest uppercase">SKALA CZCIONKI</span>
                        </div>
                        <span className="text-xs font-mono font-black text-cyan-400">{Math.round(wordScale * 100)}%</span>
                      </div>
                      <div className="flex items-center gap-4">
                        <input 
                          type="range" 
                          min="0.5" 
                          max="1.5" 
                          step="0.05" 
                          value={wordScale}
                          onChange={(e) => setWordScale(parseFloat(e.target.value))}
                          className="flex-1 h-1.5 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-4">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-black text-white uppercase opacity-60">KOLUMNY</span>
                          <span className="text-xs font-mono font-black text-white">{wordCols}</span>
                        </div>
                        <div className="flex gap-1 bg-black/30 p-1 rounded-xl">
                          {[2, 3, 4, 5].map(c => (
                            <button
                              key={c}
                              onClick={() => setWordCols(c)}
                              className={`flex-1 py-2 text-[10px] font-black rounded-lg transition-all ${wordCols === c ? 'bg-accent-red text-white' : 'hover:bg-white/5 text-white/40'}`}
                            >
                              {c}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="space-y-4">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-black text-white uppercase opacity-60">WYSOKOŚĆ</span>
                          <span className="text-xs font-mono font-black text-white">{wordHeight}px</span>
                        </div>
                        <input 
                          type="range" 
                          min="50" 
                          max="150" 
                          step="5" 
                          value={wordHeight}
                          onChange={(e) => setWordHeight(parseInt(e.target.value))}
                          className="w-full h-1.5 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-white"
                        />
                      </div>
                    </div>

                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <Sparkles className="w-5 h-5 text-yellow-400" />
                          <span className="text-xs font-black text-white tracking-widest uppercase">SKALA LITER (KOSTEK)</span>
                        </div>
                        <span className="text-xs font-mono font-black text-yellow-400">{Math.round(diceScale * 100)}%</span>
                      </div>
                      <div className="flex items-center gap-4">
                        <input 
                          type="range" 
                          min="0.5" 
                          max="2" 
                          step="0.1" 
                          value={diceScale}
                          onChange={(e) => setDiceScale(parseFloat(e.target.value))}
                          className="flex-1 h-1.5 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-yellow-500"
                        />
                      </div>
                    </div>

                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <Maximize className="w-5 h-5 text-green-400" />
                          <span className="text-xs font-black text-white tracking-widest uppercase">ODSTĘPY KOSTEK</span>
                        </div>
                        <span className="text-xs font-mono font-black text-green-400">{diceSpacing}px</span>
                      </div>
                      <div className="flex items-center gap-4">
                        <input 
                          type="range" 
                          min="0" 
                          max="100" 
                          step="2" 
                          value={diceSpacing}
                          onChange={(e) => setDiceSpacing(parseInt(e.target.value))}
                          className="flex-1 h-1.5 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-green-500"
                        />
                      </div>
                    </div>

                    <div 
                      onClick={() => setIsCompactLayout(!isCompactLayout)}
                      className="flex items-center justify-between p-4 bg-white/5 border border-white/10 rounded-2xl cursor-pointer hover:bg-white/10 transition-all"
                    >
                      <div className="flex items-center gap-3">
                        <Settings className="w-5 h-5 text-neutral-400" />
                        <div>
                          <span className="text-xs font-black text-white uppercase block">TRYB KOMPAKTOWY</span>
                          <span className="text-[9px] text-text-secondary uppercase">ZMNIEJSZA ODSTĘPY MIĘDZY SŁOWAMI</span>
                        </div>
                      </div>
                      <div className={`w-12 h-6 rounded-full p-1 transition-all ${isCompactLayout ? 'bg-accent-red' : 'bg-neutral-800'}`}>
                        <div className={`w-4 h-4 bg-white rounded-full transition-all ${isCompactLayout ? 'translate-x-6' : 'translate-x-0'}`} />
                      </div>
                    </div>
                  </motion.div>
                )}
              </div>

              <div className="p-8 bg-white/5 border-t border-white/5">
                 <button 
                   onClick={() => setShowSettings(false)}
                   className="w-full bg-accent-red hover:bg-red-700 text-white py-4 rounded-xl font-black tracking-[0.2em] uppercase transition-all shadow-xl active:scale-95"
                 >
                   GOTOWE
                 </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Instructions Modal */}
      <AnimatePresence>
        {showHelp && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-md flex items-center justify-center p-4"
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
                <div className="space-y-4">
                  <h3 className="text-xs font-black tracking-[0.3em] text-cyan-400 uppercase flex items-center gap-2">
                    <Sparkles className="w-4 h-4" /> BONUSY SPECJALNE
                  </h3>
                  <div className="grid gap-2">
                     <div className="flex items-center gap-4 bg-cyan-400/5 border border-cyan-400/10 p-4 rounded-2xl">
                        <div className="w-12 h-12 bg-cyan-500 rounded-xl flex items-center justify-center shadow-[0_0_15px_rgba(6,182,212,0.3)] shrink-0">
                          <ShieldCheck className="w-6 h-6 text-white" />
                        </div>
                        <div>
                          <h4 className="text-sm font-black text-cyan-400 uppercase">TARCZA OCHRONNA</h4>
                          <p className="text-[11px] text-text-secondary leading-relaxed">Automatycznie <span className="text-white font-bold">BLOKUJE NASTĘPNY NEGATYWNY EFEKT</span> (sztorm, mrok, pułapka, paraliż) lub blokadę lidera. Można posiadać <span className="text-white font-bold">max 3 tarcze</span> jednocześnie.</p>
                        </div>
                     </div>
                     <div className="flex items-center gap-4 bg-yellow-400/5 border border-yellow-400/10 p-4 rounded-2xl">
                        <div className="w-12 h-12 bg-yellow-500 rounded-xl flex items-center justify-center shadow-[0_0_15px_rgba(234,179,8,0.3)] shrink-0">
                          <Trophy className="w-6 h-6 text-white" />
                        </div>
                        <div>
                          <h4 className="text-sm font-black text-yellow-500 uppercase">ZŁOTE SŁOWO</h4>
                          <p className="text-[11px] text-text-secondary leading-relaxed">Daje potężny bonus <span className="text-white font-bold">+20 PUNKTÓW</span> do podstawowej długości słowa.</p>
                        </div>
                     </div>
                     <div className="flex items-center gap-4 bg-blue-400/5 border border-blue-400/10 p-4 rounded-2xl">
                        <div className="w-12 h-12 bg-blue-500 rounded-xl flex items-center justify-center shadow-[0_0_15px_rgba(59,130,246,0.3)] shrink-0">
                          <Timer className="w-6 h-6 text-white" />
                        </div>
                        <div>
                          <h4 className="text-sm font-black text-blue-400 uppercase">MROŹNE SŁOWO</h4>
                          <p className="text-[11px] text-text-secondary leading-relaxed"><span className="text-white font-bold">ZAMRAŻA CZAS</span> na 10 sekund, pozwalając czatowi na spokojne odgadywanie haseł.</p>
                        </div>
                     </div>
                     <div className="flex items-center gap-4 bg-green-400/5 border border-green-400/10 p-4 rounded-2xl">
                        <div className="w-12 h-12 bg-green-500 rounded-xl flex items-center justify-center shadow-[0_0_15px_rgba(34,197,94,0.3)] shrink-0">
                          <Clock className="w-6 h-6 text-white" />
                        </div>
                        <div>
                          <h4 className="text-sm font-black text-green-500 uppercase">DODATKOWY CZAS</h4>
                          <p className="text-[11px] text-text-secondary leading-relaxed">Natychmiast dodaje <span className="text-white font-bold">+15 SEKUND</span> do licznika rundy.</p>
                        </div>
                     </div>
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

                <div className="space-y-4 pt-4 border-t border-white/5">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-black tracking-[0.3em] text-orange-500 uppercase flex items-center gap-2">
                      <Skull className="w-4 h-4" /> ZAGROŻENIA RUNDY
                    </h3>
                    <span className="text-[9px] font-black bg-orange-500/10 text-orange-500 px-2 py-0.5 rounded border border-orange-500/20 uppercase tracking-tighter">OD 15. POZIOMU</span>
                  </div>
                  <div className="grid gap-2">
                     <div className="flex items-center gap-4 bg-orange-400/5 border border-orange-400/10 p-4 rounded-2xl opacity-80">
                        <div className="w-12 h-12 bg-orange-500 rounded-xl flex items-center justify-center shadow-[0_0_15px_rgba(249,115,22,0.3)] shrink-0">
                          <Wind className="w-6 h-6 text-white" />
                        </div>
                        <div>
                          <h4 className="text-sm font-black text-orange-500 uppercase">SZTORM</h4>
                          <p className="text-[11px] text-text-secondary leading-relaxed">Natychmiast <span className="text-white font-bold">PRZETASOWUJE</span> wszystkie litery na dolnej belce.</p>
                        </div>
                     </div>
                     <div className="flex items-center gap-4 bg-purple-400/5 border border-purple-400/10 p-4 rounded-2xl opacity-80">
                        <div className="w-12 h-12 bg-purple-600 rounded-xl flex items-center justify-center shadow-[0_0_15px_rgba(147,51,234,0.3)] shrink-0">
                          <Ghost className="w-6 h-6 text-white" />
                        </div>
                        <div>
                          <h4 className="text-sm font-black text-purple-400 uppercase">MROK</h4>
                          <p className="text-[11px] text-text-secondary leading-relaxed"><span className="text-white font-bold">ROZMYWA TABLICĘ</span> na 7 sekund, czyniąc litery i hasła niemal niewidocznymi.</p>
                        </div>
                     </div>
                      <div className="flex items-center gap-4 bg-red-400/5 border border-red-400/10 p-4 rounded-2xl opacity-80">
                        <div className="w-12 h-12 bg-red-600 rounded-xl flex items-center justify-center shadow-[0_0_15px_rgba(220,38,38,0.3)] shrink-0">
                          <UserMinus className="w-6 h-6 text-white" />
                        </div>
                        <div>
                          <h4 className="text-sm font-black text-red-500 uppercase">BLOKADA LIDERA</h4>
                          <p className="text-[11px] text-text-secondary leading-relaxed">Jeśli inny gracz je trafi: <span className="text-white font-bold">BLOKUJE LIDERA</span> na 20s. Jeśli Lider je trafi: zyskuje <span className="text-green-400 font-bold">+30 PKT</span>.</p>
                        </div>
                     </div>
                     <div className="flex items-center gap-4 bg-neutral-400/5 border border-neutral-400/10 p-4 rounded-2xl opacity-80">
                        <div className="w-12 h-12 bg-neutral-700 rounded-xl flex items-center justify-center shadow-[0_0_15px_rgba(0,0,0,0.3)] shrink-0 border border-red-500/30">
                          <Skull className="w-6 h-6 text-white" />
                        </div>
                        <div>
                          <h4 className="text-sm font-black text-neutral-400 uppercase">PUŁAPKA</h4>
                          <p className="text-[11px] text-text-secondary leading-relaxed">Zabiera rundzie <span className="text-white font-bold">-10 SEKUND</span> cennego czasu.</p>
                        </div>
                     </div>
                     <div className="flex items-center gap-4 bg-red-900/10 border border-red-500/20 p-4 rounded-2xl opacity-80">
                        <div className="w-12 h-12 bg-red-600 rounded-xl flex items-center justify-center shadow-[0_0_15px_rgba(220,38,38,0.3)] shrink-0">
                          <Skull className="w-6 h-6 text-white" />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                             <h4 className="text-sm font-black text-red-500 uppercase">PARALIŻ</h4>
                             <span className="text-[8px] font-black bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded border border-red-500/20 uppercase tracking-tighter shrink-0">OD 25. POZIOMU</span>
                          </div>
                          <p className="text-[11px] text-text-secondary leading-relaxed">Gracz, który odkryje to słowo, zostaje <span className="text-white font-bold">ZABLOKOWANY NA 20 SEKUND</span>. Tarcza chroni przed tym efektem.</p>
                        </div>
                     </div>
                  </div>
                </div>

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

      {/* Debug Panel */}
      <AnimatePresence>
        {showDebug && (
          <motion.div 
            initial={{ opacity: 0, x: 300 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 300 }}
            className="fixed right-4 bottom-4 w-96 max-h-[80vh] bg-bg-card border border-white/10 rounded-2xl shadow-2xl z-[200] flex flex-col overflow-hidden backdrop-blur-xl"
          >
            <div className="p-4 bg-accent-red flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-white" />
                <span className="text-xs font-black tracking-widest text-white uppercase italic">DEBUG PANEL</span>
              </div>
              <div className="flex gap-2">
                <div className="px-2 py-0.5 bg-yellow-500/20 rounded border border-yellow-500/30 text-yellow-500 font-mono text-[9px] font-black flex items-center gap-2">
                  HASŁO: {currentLevel.masterWord}
                </div>
                <button 
                  onClick={() => {
                    const testWord = possibleAnswers[0] || 'DEBUG';
                    addDebugLog("Testing Idempotency (Guess)", { word: testWord });
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
                    simulate(); 
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
      
      {/* Game Actions Top Right */}
      {(gameState === 'playing' || gameState === 'countdown' || gameState === 'roundSummary') && (
        <div className="fixed top-6 right-6 z-50 flex items-center gap-3">
          <button 
            onClick={() => setShowSettings(true)}
            className="flex items-center gap-2 px-4 py-2 bg-bg-card border border-border-color rounded-xl hover:bg-purple-600 hover:text-white text-text-secondary transition-all shadow-xl group cursor-pointer"
          >
            <Settings className="w-4 h-4 group-hover:rotate-90 transition-transform duration-500" />
            <span className="text-[10px] font-black uppercase tracking-widest">OPCJE</span>
          </button>
          <button 
            onClick={exitToLobby}
            className="flex items-center gap-2 px-4 py-2 bg-bg-card border border-border-color rounded-xl hover:bg-accent-red hover:text-white text-text-secondary transition-all shadow-xl group cursor-pointer"
          >
            <X className="w-4 h-4 group-hover:rotate-90 transition-transform" />
            <span className="text-[10px] font-black uppercase tracking-widest">WYJDŹ</span>
          </button>
        </div>
      )}

      {/* Update Modal */}
      <AnimatePresence>
        {showUpdateModal && updateStatus && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[300] bg-black/90 backdrop-blur-xl flex items-center justify-center p-6"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 30, opacity: 0 }}
              animate={{ scale: 1, y: 0, opacity: 1 }}
              exit={{ scale: 0.9, y: 30, opacity: 0 }}
              className="bg-bg-card border border-white/10 rounded-[2.5rem] max-w-md w-full overflow-hidden shadow-2xl flex flex-col"
            >
              <div className="p-8 bg-linear-to-b from-blue-600/20 to-transparent border-b border-white/5 flex flex-col items-center text-center">
                <div className="w-20 h-20 bg-blue-600 rounded-3xl flex items-center justify-center shadow-[0_0_30px_rgba(37,99,235,0.4)] mb-6 rotate-3">
                  <Download className="w-10 h-10 text-white" />
                </div>
                <h2 className="text-3xl font-black italic tracking-tighter text-white uppercase mb-1">AKTUALIZACJA</h2>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-black tracking-widest text-blue-400 uppercase">DOSTĘPNA WERSJA {updateStatus.version}</span>
                  {updateStatus.date && <span className="text-[10px] font-bold text-white/30 uppercase">({new Date(updateStatus.date).toLocaleDateString()})</span>}
                </div>
              </div>

              <div className="p-8 flex-1 overflow-y-auto custom-scrollbar max-h-64">
                <div className="flex items-center gap-2 mb-4">
                  <Info className="w-4 h-4 text-white/40" />
                  <span className="text-[10px] font-black text-white/40 uppercase tracking-widest">CO NOWEGO:</span>
                </div>
                <p className="text-sm text-text-secondary leading-relaxed font-medium bg-white/5 p-4 rounded-xl border border-white/5 italic whitespace-pre-wrap">
                  {updateStatus.body || "Wersja stabilna z poprawkami wydajności i nowymi funkcjami."}
                </p>
                {updateError && (
                  <div className="mt-4 p-3 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center gap-2 text-red-500 text-[10px] font-bold uppercase tracking-wider">
                    <AlertCircle className="w-4 h-4" />
                    {updateError}
                  </div>
                )}
              </div>

              <div className="p-8 space-y-4">
                {isDownloading ? (
                  <div className="space-y-4">
                    <div className="flex justify-between items-end">
                      <span className="text-[10px] font-black text-blue-400 uppercase tracking-widest flex items-center gap-2">
                        <RefreshCw className="w-3 h-3 animate-spin" /> POBIERANIE...
                      </span>
                      <span className="text-2xl font-black font-mono text-white">{downloadProgress}%</span>
                    </div>
                    <div className="w-full h-3 bg-white/5 rounded-full overflow-hidden border border-white/10 p-0.5">
                      <motion.div 
                        initial={{ width: 0 }}
                        animate={{ width: `${downloadProgress}%` }}
                        className="h-full bg-blue-400 rounded-full shadow-[0_0_15px_rgba(59,130,246,0.5)]"
                      />
                    </div>
                    <p className="text-[9px] text-center text-text-secondary font-bold uppercase opacity-50">APLIKACJA URUCHOMI SIĘ PONOWNIE AUTOMATYCZNIE</p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    <button 
                      onClick={handleUpdate}
                      className="w-full bg-blue-600 hover:bg-blue-700 text-white py-5 rounded-2xl font-black tracking-[0.2em] uppercase transition-all shadow-xl active:scale-95 flex items-center justify-center gap-3"
                    >
                      <Download className="w-5 h-5" />
                      AKTUALIZUJ TERAZ
                    </button>
                    <button 
                      onClick={() => setShowUpdateModal(false)}
                      className="w-full bg-white/5 hover:bg-white/10 text-white/50 py-4 rounded-2xl font-black text-[10px] tracking-widest uppercase transition-all border border-white/5"
                    >
                      MOŻE PÓŹNIEJ
                    </button>
                    <div className="flex items-center justify-center gap-2 opacity-30 mt-2">
                      <AlertTriangle className="w-3 h-3" />
                      <span className="text-[8px] font-black uppercase tracking-tighter">ZALECANE DLA NAJLEPSZEJ WYDAJNOŚCI</span>
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );

  // --- LOBBY SCREEN ---
  if (gameState === 'lobby') {
    return (
      <div className="h-screen bg-bg-main text-text-primary font-sans flex flex-col items-center justify-center p-6 relative overflow-hidden">
        {/* Animated background accents */}
        <div className="absolute top-1/4 left-1/4 w-64 h-64 bg-accent-red/5 rounded-full blur-3xl animate-pulse" />
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-purple-500/5 rounded-full blur-3xl animate-pulse delay-700" />
        
        {/* Settings Button Lobby */}
        <div className="absolute top-8 right-8 z-20">
          <button 
            onClick={() => setShowSettings(true)}
            className="p-4 bg-bg-card border border-border-color rounded-2xl hover:bg-neutral-800 transition-all active:scale-90 group shadow-xl"
          >
            <Settings className="w-6 h-6 text-text-secondary group-hover:rotate-90 transition-transform duration-500" />
          </button>
        </div>

        <motion.div 
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          className="z-10 flex flex-col items-center max-w-md w-full text-center"
        >
          {/* Logo Section */}
          <div className="mb-2 relative group">
            <motion.img 
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              src={logoImg} 
              alt="Logo" 
              className="w-64 h-64 object-contain drop-shadow-[0_0_25px_rgba(230,57,70,0.4)] transition-all duration-500 group-hover:scale-105"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
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
        {renderGlobalOverlays()}
      </div>
    );
  }

  // --- COUNTDOWN SCREEN ---
  if (gameState === 'countdown') {
    return (
      <div className="h-screen bg-bg-main flex flex-col items-center justify-center relative overflow-hidden">
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
         {renderGlobalOverlays()}
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
    const sortedByShields = (Object.entries(globalStats) as [string, UserStats][]).sort((a, b) => (b[1].totalShields || 0) - (a[1].totalShields || 0));
    const globalMaxLevel = Math.max(...(Object.values(globalStats) as UserStats[]).map(s => s.maxLevelReached || 0), 0);

    const handleReset = () => {
      setGlobalStats({});
      clearStats();
      setShowResetConfirm(false);
      showFeedback("Statystyki zostały zresetowane", "success");
    };

    return (
      <div className="h-screen bg-bg-main text-text-primary font-sans flex flex-col items-center justify-center p-6 relative overflow-hidden">
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
                className="p-4 bg-bg-card border border-accent-red/20 text-accent-red rounded-xl hover:bg-accent-red hover:text-white transition-all active:scale-90 group"
              >
                <Trash2 className="w-6 h-6 group-hover:rotate-12 transition-transform" />
              </button>
              <button 
                onClick={() => setGameState('lobby')}
                className="p-4 bg-bg-card border border-border-color rounded-xl hover:bg-neutral-800 transition-all active:scale-90 group"
              >
                <RotateCcw className="w-6 h-6 group-hover:-rotate-90 transition-transform duration-500" />
              </button>
            </div>
          </div>

          {/* TAB SWITCHER */}
          <div className="flex bg-bg-card border border-border-color p-1.5 rounded-2xl overflow-hidden shadow-xl">
            {[
              { id: 'world', icon: Globe, label: 'REKORD', desc: 'Najwyższy poziom osiągnięty przez społeczność' },
              { id: 'points', icon: Trophy, label: 'PUNKTY', desc: 'Suma wszystkich odgadniętych liter' },
              { id: 'rounds', icon: CheckCircle2, label: 'RUNDY', desc: 'Liczba rund zakończonych na 1. miejscu' },
              { id: 'games', icon: Trophy, label: 'SESJE', desc: 'Liczba wygranych całych sesji gry' },
              { id: 'masters', icon: Crown, label: 'MISTRZ', desc: 'Pierwsze odkrycia głównego hasła poziomu' },
              { id: 'streaks', icon: Flame, label: 'SERIE', desc: 'Najdłuższa seria wygranych rund z rzędu' },
              { id: 'shields', icon: ShieldCheck, label: 'TARCZE', desc: 'Łączna liczba zebranych tarcz ochronnych' }
            ].map((tab) => {
              const Icon = tab.icon;
              const isActive = statsTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setStatsTab(tab.id as any)}
                  className={`flex-1 flex flex-col items-center py-4 gap-1.5 rounded-xl transition-all relative group/tab ${
                    isActive 
                      ? 'bg-accent-red text-white shadow-lg' 
                      : 'text-text-secondary hover:bg-white/5'
                  }`}
                >
                  {/* Tooltip */}
                  <div className="absolute bottom-full mb-3 left-1/2 -translate-x-1/2 w-48 p-2.5 bg-neutral-900 border border-border-color rounded-xl text-[9px] font-bold text-text-secondary text-center z-50 pointer-events-none opacity-0 group-hover/tab:opacity-100 transition-all shadow-2xl scale-95 group-hover/tab:scale-100">
                    {tab.desc}
                    <div className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0 border-l-[4px] border-l-transparent border-r-[4px] border-r-transparent border-t-[4px] border-t-neutral-900"></div>
                  </div>

                  <Icon className={`w-6 h-6 ${isActive ? 'scale-110' : 'opacity-50 group-hover/tab:opacity-100'}`} />
                  <span className="text-[9px] font-black tracking-widest uppercase">{tab.label}</span>
                  {isActive && (
                    <motion.div 
                      layoutId="tab-active"
                      className="absolute -bottom-1 w-1.5 h-1.5 bg-white rounded-full"
                    />
                  )}
                </button>
              );
            })}
          </div>

          <div className="min-h-[500px] flex flex-col">
            <AnimatePresence mode="wait">
              {statsTab === 'world' && (
                <motion.section 
                  key="world"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="bg-bg-card border border-border-color rounded-[3rem] overflow-hidden shadow-2xl relative group flex-1"
                >
                  <div className="absolute inset-0 bg-linear-to-tr from-accent-red/5 via-transparent to-blue-500/5 opacity-50 group-hover:opacity-100 transition-opacity" />
                  <div className="absolute -top-24 -left-24 w-64 h-64 bg-accent-red/10 blur-[100px] rounded-full" />
                  <div className="absolute -bottom-24 -right-24 w-64 h-64 bg-blue-500/10 blur-[100px] rounded-full" />
                  
                  <div className="relative p-16 flex flex-col items-center justify-center text-center h-full">
                    <motion.div 
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="flex items-center gap-4 mb-6"
                    >
                      <div className="h-px w-12 bg-accent-red/30" />
                      <span className="text-[10px] font-black tracking-[0.5em] text-accent-red uppercase">NAJDALSZA OSIĄGNIĘTA RUNDA</span>
                      <div className="h-px w-12 bg-accent-red/30" />
                    </motion.div>

                    <div className="relative">
                      <motion.div 
                        initial={{ scale: 0.8, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        className="text-[14rem] font-black font-mono leading-none tracking-tighter text-white drop-shadow-[0_0_30px_rgba(255,255,255,0.1)] mb-6"
                      >
                        {globalMaxLevel}
                      </motion.div>
                      <div className="absolute -left-16 top-1/2 -translate-y-1/2 text-9xl font-thin text-white/5 pointer-events-none">[</div>
                      <div className="absolute -right-16 top-1/2 -translate-y-1/2 text-9xl font-thin text-white/5 pointer-events-none">]</div>
                    </div>

                    <div className="bg-neutral-900/50 border border-white/5 px-10 py-4 rounded-2xl backdrop-blur-sm">
                      <span className="text-sm font-black italic tracking-[0.2em] text-text-secondary uppercase">REKORD ŚWIATA</span>
                    </div>
                  </div>
                </motion.section>
              )}

              {statsTab !== 'world' && (
                <motion.div 
                  key="table"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="bg-bg-card border border-border-color rounded-2xl shadow-2xl flex flex-col overflow-hidden flex-1"
                >
                  <div className="p-6 bg-neutral-900/50 border-b border-border-color flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[12px] font-black tracking-widest uppercase text-text-secondary">
                        {statsTab === 'points' && 'RANKING PUNKTÓW'}
                        {statsTab === 'rounds' && 'RANKING WYGRANYCH RUND'}
                        {statsTab === 'games' && 'RANKING WYGRANYCH SESJI'}
                        {statsTab === 'masters' && 'RANKING MISTRZÓW'}
                        {statsTab === 'streaks' && 'RANKING SERII'}
                        {statsTab === 'shields' && 'RANKING TARCOWNIKÓW'}
                      </span>
                      <span className="text-[10px] font-bold text-text-secondary/50 uppercase">TOP 50 GRACZY</span>
                    </div>
                    <p className="text-[11px] font-bold text-text-secondary/40 italic">
                      {statsTab === 'points' && 'Łączna liczba liter odgadniętych we wszystkich słowach.'}
                      {statsTab === 'rounds' && 'Ile razy gracz był najszybszy w pojedynczej rundzie.'}
                      {statsTab === 'games' && 'Liczba zwycięstw w całych sesjach gry (najwięcej pkt na koniec).'}
                      {statsTab === 'masters' && 'Liczba odkrytych haseł głównych (tych na samej górze).'}
                      {statsTab === 'streaks' && 'Rekordowa liczba rund wygranych pod rząd przez jednego gracza.'}
                      {statsTab === 'shields' && 'Łączna liczba tarcz zdobytych we wszystkich grach.'}
                    </p>
                  </div>

                  <div className="max-h-[600px] overflow-y-auto p-6 custom-scrollbar">
                    <div className="grid grid-cols-1 gap-3">
                      {(() => {
                        let data: [string, UserStats][] = [];
                        let colorClass = "text-accent-red";
                        let valKey: keyof UserStats = "points";

                        if (statsTab === 'points') { data = sortedByPoints; colorClass = "text-yellow-500"; valKey = "points"; }
                        else if (statsTab === 'rounds') { data = sortedByRoundWins; colorClass = "text-green-400"; valKey = "roundWins"; }
                        else if (statsTab === 'games') { data = sortedByGameWins; colorClass = "text-blue-400"; valKey = "gameWins"; }
                        else if (statsTab === 'masters') { data = sortedByMaster; colorClass = "text-orange-400"; valKey = "masterWordWins"; }
                        else if (statsTab === 'streaks') { data = sortedByStreaks; colorClass = "text-purple-400"; valKey = "maxStreak"; }
                        else if (statsTab === 'shields') { data = sortedByShields; colorClass = "text-cyan-400"; valKey = "totalShields"; }

                        if (data.length === 0) return <div className="py-24 text-center opacity-20 text-sm font-black uppercase tracking-widest">BRAK DANYCH</div>;

                        return data.slice(0, 50).map(([key, item], idx) => (
                          <motion.div 
                            initial={{ opacity: 0, x: -15 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: idx * 0.02 }}
                            key={key} 
                            className="flex items-center justify-between bg-bg-main/40 p-4 rounded-xl border border-white/5 hover:border-white/10 transition-all group"
                          >
                            <div className="flex items-center gap-6">
                              <span className={`text-sm font-black w-8 text-center ${idx < 3 ? colorClass : 'text-text-secondary/30'}`}>#{idx + 1}</span>
                              <div className="flex items-center gap-3">
                                <UserBadges username={key} size="w-5 h-5" />
                                <span className={`font-bold text-lg transition-all ${idx < 3 ? 'text-white' : 'text-text-secondary'}`}>{item.displayName || key}</span>
                              </div>
                            </div>
                            <div className="flex flex-col items-end">
                              <span className={`font-black font-mono text-4xl ${colorClass}`}>
                                {item[valKey] as number}
                              </span>
                              <span className="text-[8px] font-black text-text-secondary/30 uppercase tracking-widest">
                                {statsTab === 'points' && 'PKT'}
                                {statsTab === 'rounds' && 'RUND'}
                                {statsTab === 'games' && 'WYGRANYCH'}
                                {statsTab === 'masters' && 'MISTRZOSTW'}
                                {statsTab === 'streaks' && 'SERIA'}
                                {statsTab === 'shields' && 'TARCZ'}
                              </span>
                            </div>
                          </motion.div>
                        ));
                      })()}
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <button 
            onClick={() => setGameState('lobby')}
            className="w-full bg-accent-red hover:bg-red-700 text-white py-6 rounded-2xl font-black tracking-[0.5em] text-lg uppercase transition-all shadow-2xl active:scale-[0.98] mt-4 flex items-center justify-center gap-3"
          >
            POWRÓT DO MENU
          </button>
        </motion.div>
        {renderGlobalOverlays()}
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
      <div className="h-screen bg-bg-main text-text-primary font-sans flex flex-col items-center justify-center p-4 relative overflow-hidden">
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
                    
                    {/* Next level display */}
                    {(() => {
                      const jump = roundCompletionRate >= 100 ? 3 : (roundCompletionRate >= 85 ? 2 : 1);
                      let nextNum = levelIndex + 1 + jump;
                      if (nextNum > levelSequence.length) nextNum = 1;
                      return (
                        <div className="flex flex-col items-center mt-2 px-6 py-2 bg-white/5 rounded-xl border border-white/10">
                          <span className="text-[10px] font-black tracking-[0.3em] text-white/30 uppercase">NASTĘPNA RUNDA</span>
                          <span className="text-2xl font-black italic tracking-tighter text-white">POZIOM {nextNum}</span>
                        </div>
                      );
                    })()}

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
                 <span className="text-accent-red font-black tracking-[0.1em] text-sm uppercase mb-1">KONIEC GRY NA POZIOMIE {levelIndex + 1}</span>
                 <span className="text-text-secondary/50 font-black tracking-[0.2em] text-[10px] uppercase">LITERY: {roundFoundLetters}/{roundTotalLetters} ({roundCompletionRate.toFixed(0)}%)</span>
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
                        <div className="flex flex-col">
                          <div className="flex items-center">
                            <UserBadges username={user} size="w-3.5 h-3.5" />
                            <span className="font-bold text-sm text-text-primary">{user}</span>
                          </div>
                          {(sessionShields[user] || 0) > 0 && (
                            <div className="flex items-center gap-0.5 mt-0.5">
                              {[...Array(sessionShields[user])].map((_, i) => (
                                <ShieldCheck key={i} className="w-3 h-3 text-cyan-400" />
                              ))}
                            </div>
                          )}
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
        {renderGlobalOverlays()}
      </div>
    );
  }

  // --- GAME ENDED SCREEN (Fallback) ---
  if (gameState === 'ended') {
    return (
      <div className="h-screen bg-bg-main text-text-primary font-sans flex flex-col items-center justify-center p-6 text-center">
         <motion.div 
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="max-w-md w-full"
         >
            <AlertCircle className="w-20 h-20 text-accent-red mx-auto mb-6" />
            <h1 className="text-5xl font-black italic tracking-tighter mb-2">KONIEC GRY</h1>
            <p className="text-accent-red font-black tracking-[0.3em] uppercase mb-8 text-sm">ZAKOŃCZONO NA POZIOMIE {levelIndex + 1}</p>
            <button 
              onClick={() => setGameState('lobby')}
              className="w-full bg-white text-bg-main py-4 rounded-xl font-black tracking-[0.2em] uppercase hover:bg-accent-red hover:text-white transition-all active:scale-95"
            >
              POWRÓT DO LOBBY
            </button>
         </motion.div>
         {renderGlobalOverlays()}
      </div>
    );
  }

  return (
    <div className="h-screen bg-bg-main text-text-primary font-sans flex flex-col overflow-hidden items-center">
      
      {/* Letters Section (The Scrambler) */}
      <section className={`w-full h-[240px] flex flex-col items-center justify-center bg-linear-to-b from-bg-card to-bg-main relative transition-all duration-700 overflow-visible z-30 ${isDarknessActive ? 'blur-xl grayscale opacity-30 pointer-events-none scale-110' : ''}`}>
        <div 
          className="flex px-4 transition-transform duration-300 overflow-visible"
          style={{ 
            transform: `scale(${diceScale})`, 
            transformOrigin: 'center center',
            gap: `${diceSpacing}px`,
            whiteSpace: 'nowrap'
          }}
        >
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
                  className={`flex-shrink-0 w-[70px] h-[70px] md:w-[105px] md:h-[105px] flex items-center justify-center text-4xl md:text-7xl font-black rounded-2xl shadow-[0_10px_0_#b91c1c] uppercase mb-10 border-t border-white/20
                    ${isDecoyRevealed 
                      ? 'bg-[#4a0000] text-red-500 border-2 border-red-900 shadow-[0_10px_0_#2a0000]' 
                      : isHiddenRevealed
                        ? 'bg-yellow-400 text-black border-2 border-yellow-600 shadow-[0_10px_0_#ca8a04]'
                        : masterWordFound ? 'bg-red-600 text-white shadow-[0_10px_0_#7f1d1d]' : 'bg-white text-black'}
                  `}
                >
                  {displayChar}
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
        
        {/* Time Progress Bar (No Digital Clock) */}
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 w-[95%] max-w-7xl">
          <div className="w-full h-5 bg-black/40 rounded-full border-2 border-white/10 overflow-hidden shadow-[inset_0_2px_4px_rgba(0,0,0,0.5)] flex justify-start relative">
            <motion.div 
              initial={{ width: "100%" }}
              animate={{ width: `${(timeLeft / INITIAL_TIME) * 100}%` }}
              transition={{ duration: 1, ease: "linear" }}
              className={`h-full rounded-full shadow-[0_0_20px_rgba(230,57,70,0.6)]
                ${isTimeFrozen ? 'bg-cyan-400 shadow-[0_0_20px_rgba(34,211,238,0.8)] animate-pulse' : timeLeft < 30 ? 'bg-red-500 animate-pulse' : 'bg-accent-red'}
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
          {blockedPlayer && Date.now() < blockedPlayer.expiresAt && (
             <div className="absolute -top-10 left-1/2 -translate-x-1/2 bg-red-600 px-4 py-1 rounded-full text-[10px] font-black text-white tracking-widest animate-pulse border border-red-400 shadow-lg whitespace-nowrap">
               LIDER BLOKOWANY: {blockedPlayer.username.toUpperCase()} (20s) 🚫
             </div>
          )}
          {currentLeader && (sessionShields[currentLeader] || 0) > 0 && (
             <div className={`absolute -top-10 left-1/2 -translate-x-1/2 bg-cyan-600 px-4 py-1 rounded-full text-[10px] font-black text-white tracking-widest border border-cyan-400 shadow-lg whitespace-nowrap transition-all duration-300 ${blockedPlayer ? 'translate-y-8' : ''}`}>
               LIDER MA TARCZĘ 🛡️ ({sessionShields[currentLeader]})
             </div>
          )}
        </div>
      </section>

      {/* Main Gameplay Area with Grid and Chat */}
      <main className="flex-1 w-full max-w-[1800px] flex gap-10 p-4 md:p-10 overflow-hidden items-stretch h-0">
        
        {/* Answers Grid Section */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex justify-between items-end mb-4 border-b border-white/5 pb-4">
            <div className="flex flex-col">
              <div className="flex items-center gap-3 mb-1">
                <span className="text-[10px] font-black tracking-[0.3em] text-text-secondary uppercase opacity-50">STREFA GRY</span>
              </div>
              <span className="text-4xl font-black italic tracking-tighter text-accent-red uppercase italic">POZIOM {levelIndex + 1}</span>
            </div>
            <div className="flex flex-col items-end">
               <span className="text-[10px] font-black tracking-[0.2em] text-text-secondary uppercase opacity-50 mb-1">ZDOBYTE LITERY:</span>
               <div className="flex items-baseline gap-2">
                 <span className={`text-4xl font-black font-mono transition-colors duration-500 ${completionRate >= 70 ? 'text-green-500' : 'text-accent-red'}`}>
                    {foundLettersInLevel}
                 </span>
                 <span className="text-text-secondary font-black text-xl opacity-30">/</span>
                 <div className="flex flex-col">
                   <span className="text-text-secondary font-black text-xl opacity-50 leading-none">{targetLetters}</span>
                   <span className="text-[7px] font-black tracking-widest text-text-secondary uppercase opacity-30 mt-0.5">CEL 70%</span>
                 </div>
               </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto -mr-2 pr-4 pt-4 overflow-x-hidden">
            <div 
              className={`grid ${isCompactLayout ? 'gap-2' : 'gap-4'} h-full content-start transition-all duration-300 ${isDarknessActive ? 'blur-md grayscale opacity-20 pointer-events-none' : ''}`}
              style={{ 
                gridTemplateColumns: `repeat(${wordCols}, minmax(0, 1fr))`,
                width: '100%'
              }}
            >
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
                    className={`relative flex flex-col items-center justify-center rounded-xl border-2 transition-all duration-300 px-3
                      ${foundData 
                        ? 'bg-accent-red border-accent-red text-white shadow-[0_0_20px_rgba(230,57,70,0.3)]' 
                        : specialType === 'FREEZE' ? 'bg-blue-900/20 border-blue-500/50 shadow-[0_0_15px_rgba(59,130,246,0.3)]'
                        : specialType === 'GOLD' ? 'bg-yellow-900/20 border-yellow-500/50 shadow-[0_0_15px_rgba(234,179,8,0.3)]'
                        : specialType === 'TIME' ? 'bg-green-900/20 border-green-500/50 shadow-[0_0_15px_rgba(34,197,94,0.3)]'
                        : specialType === 'SCANNER' ? 'bg-cyan-900/20 border-cyan-500/50 shadow-[0_0_15px_rgba(6,182,212,0.3)]'
                        : specialType === 'STORM' ? 'bg-orange-900/20 border-orange-500/50'
                        : specialType === 'DARKNESS' ? 'bg-purple-900/20 border-purple-500/50'
                        : specialType === 'TRAP' ? 'bg-neutral-900 border-red-900/50'
                        : specialType === 'MYSTERY' ? 'bg-white/10 border-white/30 skew-x-1'
                        : specialType === 'SHIELD' ? 'bg-indigo-900/20 border-indigo-400/50 shadow-[0_0_15px_rgba(129,140,248,0.3)]'
                        : specialType === 'LEADER_BLOCK' ? 'bg-red-900/20 border-red-500/50 shadow-[0_0_15px_rgba(239,68,68,0.3)]'
                        : specialType === 'SELF_STUN' ? 'bg-pink-900/20 border-pink-500/50 shadow-[0_0_15px_rgba(236,72,153,0.3)]'
                        : 'bg-bg-card/50 border-border-color'
                      }
                      ${!foundData && specialType ? 'animate-pulse' : ''}
                    `}
                    style={{ height: `${wordHeight}px` }}
                  >
                    {specialType && !foundData && (
                      <div className="absolute top-1 right-1 z-20">
                        {specialType === 'FREEZE' && <div className="w-7 h-7 bg-blue-500 rounded-full flex items-center justify-center shadow-lg border-2 border-bg-main"><Timer className="w-4 h-4 text-white" /></div>}
                        {specialType === 'GOLD' && <div className="w-7 h-7 bg-yellow-500 rounded-full flex items-center justify-center shadow-lg border-2 border-bg-main"><Trophy className="w-4 h-4 text-white" /></div>}
                        {specialType === 'TIME' && <div className="w-7 h-7 bg-green-500 rounded-full flex items-center justify-center shadow-lg border-2 border-bg-main"><Clock className="w-4 h-4 text-white" /></div>}
                        {specialType === 'SCANNER' && <div className="w-7 h-7 bg-cyan-500 rounded-full flex items-center justify-center shadow-lg border-2 border-bg-main"><Search className="w-4 h-4 text-white" /></div>}
                        {specialType === 'STORM' && <div className="w-7 h-7 bg-orange-500 rounded-full flex items-center justify-center shadow-lg border-2 border-bg-main"><Wind className="w-4 h-4 text-white" /></div>}
                        {specialType === 'DARKNESS' && <div className="w-7 h-7 bg-purple-600 rounded-full flex items-center justify-center shadow-lg border-2 border-bg-main"><Ghost className="w-4 h-4 text-white" /></div>}
                        {specialType === 'TRAP' && <div className="w-7 h-7 bg-neutral-700 rounded-full flex items-center justify-center shadow-lg border-2 border-bg-main"><Skull className="w-4 h-4 text-white" /></div>}
                        {specialType === 'SHIELD' && <div className="w-7 h-7 bg-indigo-500 rounded-full flex items-center justify-center shadow-lg border-2 border-bg-main"><ShieldCheck className="w-4 h-4 text-white" /></div>}
                        {specialType === 'LEADER_BLOCK' && <div className="w-7 h-7 bg-red-600 rounded-full flex items-center justify-center shadow-lg border-2 border-bg-main"><UserMinus className="w-4 h-4 text-white" /></div>}
                        {specialType === 'SELF_STUN' && <div className="w-7 h-7 bg-pink-500 rounded-full flex items-center justify-center shadow-lg border-2 border-bg-main"><AlertCircle className="w-4 h-4 text-white" /></div>}
                        {specialType === 'MYSTERY' && <div className="w-8 h-8 bg-white rounded-full flex items-center justify-center shadow-lg border-2 border-bg-main animate-bounce"><HelpCircle className="w-5 h-5 text-bg-main" /></div>}
                      </div>
                    )}
                    <div 
                      className={`font-black tracking-[0.1em] font-mono leading-none break-all text-center ${foundData ? 'text-white' : 'text-accent-red font-bold'}`}
                      style={{ fontSize: `${word.length > 8 ? 1.5 * wordScale : 2.25 * wordScale}rem` }}
                    >
                      {foundData ? word : word.split('').map((char, i) => revealedIndices.includes(i) ? char : '_').join('')}
                      {revealedIndices.length > 0 && !foundData && <Sparkles className="inline-block w-6 h-6 ml-1 text-yellow-500 animate-pulse" />}
                    </div>
                    {foundData && (
                      <motion.div 
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className={`${isCompactLayout ? 'text-[9px]' : 'text-xs'} font-black mt-1 truncate max-w-[95%] opacity-100 px-2 py-0.5 rounded bg-black/60 text-white uppercase tracking-tight flex items-center gap-1.5 shadow-sm border border-white/10`}
                      >
                        <UserBadges username={foundData.user} size="w-3.5 h-3.5" />
                        <span className="truncate">{foundData.user}</span>
                      </motion.div>
                    )}
                  </motion.div>
                );
              })}
            </div>
          </div>

          {/* Bottom Feedback Area (No Input) */}
          <div className="mt-4 h-20 bg-black border-2 border-white/20 rounded-2xl flex flex-col items-center justify-center relative overflow-hidden shadow-[0_0_30px_rgba(0,0,0,0.5)]">
            <div className="text-base font-black text-white tracking-[0.3em] uppercase flex flex-col items-center gap-1">
              <span className="text-yellow-400 drop-shadow-md">WPISUJ HASŁA NA CZACIE TWITCH</span>
              <div className="flex gap-4">
                {levelIndex + 1 >= 10 && (
                  <motion.span 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="text-accent-red animate-pulse tracking-widest text-xs"
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
        <aside className="w-96 hidden lg:flex flex-col bg-bg-card border border-border-color rounded-2xl overflow-hidden shadow-2xl">
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

          <div className="flex-1 p-4 overflow-y-auto space-y-2 custom-scrollbar flex flex-col">
            {messages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center space-y-2 opacity-30">
                <FaTwitch className="w-8 h-8" />
                <span className="text-[10px] font-black tracking-tighter uppercase">CZEKAM NA WIADOMOŚCI...</span>
              </div>
            ) : (
              <>
                {messages.map((msg) => (
                  <motion.div 
                    initial={{ opacity: 0, x: 10 }}
                    animate={{ opacity: 1, x: 0 }}
                    key={msg.id} 
                    className={`text-sm break-words border-b border-white/5 pb-2 last:border-0 transition-all ${
                      msg.isCorrect 
                        ? 'bg-green-500/20 border-green-500/40 -mx-4 px-4 py-3 !border-y shadow-[0_0_15px_rgba(34,197,94,0.1)]' 
                        : ''
                    }`}
                  >
                    <div className="inline-flex items-baseline flex-wrap gap-x-1.5">
                      <UserBadges username={msg.username} size="w-3.5 h-3.5" />
                      <span className="font-black text-sm" style={{ color: msg.color }}>{msg.username}:</span>
                      <span className={`${
                        msg.isCorrect 
                          ? 'text-green-400 font-black tracking-tighter scale-110 origin-left inline-block' 
                          : 'text-text-secondary'
                      } font-medium`}>
                        {msg.message}
                      </span>
                      {msg.isCorrect && <Sparkles className="w-4 h-4 text-yellow-400 ml-2 animate-bounce" />}
                    </div>
                  </motion.div>
                ))}
                <div id="chat-bottom" />
              </>
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

      {renderGlobalOverlays()}
    </div>
  );
}
