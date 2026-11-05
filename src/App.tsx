import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Search, RotateCcw, CheckCircle2, AlertCircle, Timer, Trophy, ShieldCheck, Sparkles, Lightbulb, Trash2, Flame, Crown, Info, X, Clock, Eye, Wind, Ghost, Skull, HelpCircle, Globe, Settings, Volume2, VolumeX, Music, UserMinus, Maximize, Download, RefreshCw, AlertTriangle, FastForward, Snowflake, Bug, Users, Swords, ArrowRight, ArrowLeft, Shuffle, UserPlus, Check, MoreVertical } from 'lucide-react';
import tmi from 'tmi.js';
import confetti from 'canvas-confetti';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { getVersion } from '@tauri-apps/api/app';

import logoImg from './assets/logo-ap.png';

import LEVELS_DATA from './levels.json';
import CHANGELOG_DATA from './changelog.json';
import { loadStats, saveStats, clearStats } from './lib/persistence';
import { AUDIO_PATHS } from './constants';
import { FaTwitch } from "react-icons/fa";
import "./App.css";

export type GameMode = 'solo' | 'teams';

export interface TeamMemberStat {
  username: string;
  team: 'blue' | 'red';
  points: number;
  wordsFound: number;
}

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

type SpecialWordType = 'FREEZE' | 'GOLD' | 'TIME' | 'SCANNER' | 'STORM' | 'DARKNESS' | 'TRAP' | 'MYSTERY' | 'LEADER_BLOCK' | 'SHIELD' | 'SELF_STUN' | 'FROST_BITE' | 'PARASITE' | null;

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
  team?: 'blue' | 'red' | 'spectator';
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
  teamMvp?: number;
  blueTeamMvp?: number;
  redTeamMvp?: number;
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
  const [showGameMenu, setShowGameMenu] = useState(false);
  const [helpTab, setHelpTab] = useState<'solo' | 'teams'>('solo');
  const [showChangelog, setShowChangelog] = useState(false);
  const [shuffledLetters, setShuffledLetters] = useState<Letter[]>([]);
  const lettersPoolRef = useRef<Letter[]>([]);
  const [feedback, setFeedback] = useState<{ message: string; type: 'success' | 'error' | 'freeze' | 'hazard' | null }>({ message: "", type: null });
  const [specialWords, setSpecialWords] = useState<Record<string, SpecialWordType>>({});
  const specialWordsRef = useRef<Record<string, SpecialWordType>>({});
  const [isTimeFrozen, setIsTimeFrozen] = useState(false);
  const [isDarknessActive, setIsDarknessActive] = useState(false);
  const [showRoundWords, setShowRoundWords] = useState(false);
  const [playedMasterWords, setPlayedMasterWords] = useState<string[]>(() => {
    const saved = localStorage.getItem('playedMasterWords');
    return saved ? JSON.parse(saved) : [];
  });
  const [statsTab, setStatsTab] = useState<'world' | 'points' | 'rounds' | 'games' | 'masters' | 'streaks' | 'shields' | 'teamMvp'>('world');
  const [blockedPlayer, setBlockedPlayer] = useState<{ username: string; expiresAt: number } | null>(null);
  const blockedPlayerRef = useRef<{ username: string; expiresAt: number } | null>(null);
  const [frozenWords, setFrozenWords] = useState<Record<string, number>>({});
  const [activeParasites, setActiveParasites] = useState<Record<string, { victim: string; expiresAt: number }>>({});
  const frozenWordsRef = useRef<Record<string, number>>({});
  const activeParasitesRef = useRef<Record<string, { victim: string; expiresAt: number }>>({});

  // Team Mode States (Drużynówka / Przeciąganie Liny)
  const [gameMode, setGameMode] = useState<GameMode>(() => {
    const saved = localStorage.getItem('gameMode');
    return (saved === 'teams' ? 'teams' : 'solo') as GameMode;
  });
  const [teamLobbyPlayers, setTeamLobbyPlayers] = useState<string[]>([]);
  const [blueTeam, setBlueTeam] = useState<string[]>([]);
  const [redTeam, setRedTeam] = useState<string[]>([]);
  const [ropePosition, setRopePosition] = useState<number>(50); // 50% = Środek, 0% = K.O. Niebiescy, 100% = K.O. Czerwoni
  const [teamScores, setTeamScores] = useState<{ blue: number; red: number }>({ blue: 0, red: 0 });
  const [teamPlayerStats, setTeamPlayerStats] = useState<Record<string, TeamMemberStat>>({});
  const [currentTeamStreak, setCurrentTeamStreak] = useState<{ team: 'blue' | 'red' | null; count: number }>({ team: null, count: 0 });
  const maxTeamStreakRef = useRef<{ blue: number; red: number }>({ blue: 0, red: 0 });
  const [teamMatchWinner, setTeamMatchWinner] = useState<'blue' | 'red' | 'draw' | null>(null);
  const [teamWinReason, setTeamWinReason] = useState<'ko' | 'timeout' | 'clear' | null>(null);
  const [teamRound, setTeamRound] = useState<number>(1);
  const [lastPullDelta, setLastPullDelta] = useState<{ team: 'blue' | 'red'; amount: number; word: string; user: string } | null>(null);

  useEffect(() => {
    blockedPlayerRef.current = blockedPlayer;
  }, [blockedPlayer]);

  useEffect(() => {
    frozenWordsRef.current = frozenWords;
  }, [frozenWords]);

  useEffect(() => {
    activeParasitesRef.current = activeParasites;
  }, [activeParasites]);
  
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

  const [showDevPanel, setShowDevPanel] = useState(false);
  const [isDevAuthorized, setIsDevAuthorized] = useState(false);
  const [devPasswordInput, setDevPasswordInput] = useState("");
  const [devCustomGuessWord, setDevCustomGuessWord] = useState("");
  const [appVersion, setAppVersion] = useState(CHANGELOG_DATA[0]?.version || '0.2.4');
  const [timeLeft, setTimeLeft] = useState(INITIAL_TIME);
  const [hints, setHints] = useState<Record<string, number[]>>({}); // word: revealedIndices[]
  const [lastActionTime, setLastActionTime] = useState(Date.now());

  // Audio Settings
  const [soundVolume, setSoundVolume] = useState(0.5);
  const [musicVolume, setMusicVolume] = useState(0.3);
  const [settingsTab, setSettingsTab] = useState<'audio' | 'layout' | 'twitch' | 'admin' | 'developer'>('audio');
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

  const showFeedback = useCallback((message: string, type: 'success' | 'error' | 'freeze' | 'hazard', soundKey?: keyof typeof AUDIO_PATHS) => {
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
  }, [playSound]);

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
    // History Management: We want to exclude words seen in previous games
    // Filter out already played words from the total pool
    let availableIndices = LEVELS.map((_, i) => i).filter(i => !playedMasterWords.includes(LEVELS[i].masterWord));
    
    // If we've played a significant portion (e.g., > 90% of pool or less than 5 words left),
    // we clear the history to allow words back in, but we always try to avoid the absolute last few.
    if (availableIndices.length < 5) {
      // Keep only the last 10 words in history to avoid immediate repetition even after reset
      const recentHistory = playedMasterWords.slice(-10);
      setPlayedMasterWords(recentHistory);
      availableIndices = LEVELS.map((_, i) => i).filter(i => !recentHistory.includes(LEVELS[i].masterWord));
      
      addDebugLog("Word rotation reset", { remainingWords: availableIndices.length });
    }

    const sevenLetterIndices = availableIndices.filter(i => LEVELS[i].masterWord.length === 7);
    const otherIndices = availableIndices.filter(i => LEVELS[i].masterWord.length !== 7);
    
    const shuffledSeven = [...sevenLetterIndices].sort(() => Math.random() - 0.5);
    const shuffledOthers = [...otherIndices].sort(() => Math.random() - 0.5);
    
    // Mix and match to create a progression (easier 7-letter words first)
    const firstCount = Math.min(shuffledSeven.length, 5);
    const firstPart = shuffledSeven.slice(0, firstCount);
    const remainingSeven = shuffledSeven.slice(firstCount);
    const secondPart = [...shuffledOthers, ...remainingSeven].sort(() => Math.random() - 0.5);
    
    const finalSequence = [...firstPart, ...secondPart];
    addDebugLog("Generated new level sequence", { length: finalSequence.length });
    return finalSequence;
  }, [playedMasterWords, addDebugLog]);

  // Initialize random level sequence and load stats
  useEffect(() => {
    setLevelSequence(generateLevelSequence());

    // Fetch version from Tauri if available
    const fetchVersion = async () => {
      try {
        if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
          const version = await getVersion();
          setAppVersion(version);
        }
      } catch (err) {
        console.error("Failed to get version:", err);
      }
    };
    fetchVersion();

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
      await updateObjectRef.current.install();
      
      addDebugLog("Installation command sent, relaunching in 1s...", {});
      
      // On Windows, the installer might take over, but we signal relaunch just in case
      setTimeout(async () => {
        try {
          await relaunch();
        } catch (e) {
          addDebugLog("Relaunch skipped - likely installer is running", e);
        }
      }, 1500);

    } catch (err) {
      console.error("Update failed:", err);
      setUpdateError("Błąd podczas aktualizacji: " + (err instanceof Error ? err.message : String(err)));
      setIsDownloading(false);
      addDebugLog("Update Error Detail", err);
    }
  };

  // Save layout and word history settings to localStorage
  useEffect(() => {
    localStorage.setItem('wordScale', wordScale.toString());
    localStorage.setItem('diceScale', diceScale.toString());
    localStorage.setItem('diceSpacing', diceSpacing.toString());
    localStorage.setItem('wordCols', wordCols.toString());
    localStorage.setItem('wordHeight', wordHeight.toString());
    localStorage.setItem('isCompactLayout', isCompactLayout.toString());
    localStorage.setItem('playedMasterWords', JSON.stringify(playedMasterWords));
  }, [wordScale, diceScale, diceSpacing, wordCols, wordHeight, isCompactLayout, playedMasterWords]);

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
    setTeamRound(1);
    setRopePosition(50);
    setTeamScores({ blue: 0, red: 0 });
    setTeamPlayerStats({});
    setCurrentTeamStreak({ team: null, count: 0 });
    setTeamMatchWinner(null);
    setTeamWinReason(null);
    setLastPullDelta(null);
    teamMvpAwardedRef.current = false;
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

  // Team Mode Refs
  const gameModeRef = useRef(gameMode);
  const teamLobbyPlayersRef = useRef(teamLobbyPlayers);
  const blueTeamRef = useRef(blueTeam);
  const redTeamRef = useRef(redTeam);
  const ropePositionRef = useRef(ropePosition);
  const currentTeamStreakRef = useRef(currentTeamStreak);
  const teamMatchWinnerRef = useRef(teamMatchWinner);
  const teamWinReasonRef = useRef(teamWinReason);
  const teamRoundRef = useRef(teamRound);
  const teamPlayerStatsRef = useRef(teamPlayerStats);
  const teamMvpAwardedRef = useRef(false);

  // Sync refs immediately in render
  gameStateRef.current = gameState;
  possibleAnswersRef.current = possibleAnswers;
  currentLevelRef.current = currentLevel;
  foundWordsRef.current = foundWords;
  sessionScoresRef.current = sessionScores;
  sessionShieldsRef.current = sessionShields;
  levelIndexRef.current = levelIndex;
  gameModeRef.current = gameMode;
  teamLobbyPlayersRef.current = teamLobbyPlayers;
  blueTeamRef.current = blueTeam;
  redTeamRef.current = redTeam;
  ropePositionRef.current = ropePosition;
  currentTeamStreakRef.current = currentTeamStreak;
  teamMatchWinnerRef.current = teamMatchWinner;
  teamWinReasonRef.current = teamWinReason;
  teamRoundRef.current = teamRound;
  teamPlayerStatsRef.current = teamPlayerStats;

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

    let roundTeamWinner: 'blue' | 'red' | 'draw' | null = null;
    if (gameModeRef.current === 'teams') {
      let winner = teamMatchWinnerRef.current;
      let reason = teamWinReasonRef.current;
      if (!winner) {
        if (ropePositionRef.current >= 100) {
          winner = 'blue';
          reason = 'ko';
          teamMatchWinnerRef.current = 'blue';
          teamWinReasonRef.current = 'ko';
          setTeamMatchWinner('blue');
          setTeamWinReason('ko');
        } else if (ropePositionRef.current <= 0) {
          winner = 'red';
          reason = 'ko';
          teamMatchWinnerRef.current = 'red';
          teamWinReasonRef.current = 'ko';
          setTeamMatchWinner('red');
          setTeamWinReason('ko');
        } else {
          // NO K.O.! The match continues into the next round!
          winner = null;
          reason = null;
          teamMatchWinnerRef.current = null;
          teamWinReasonRef.current = null;
          setTeamMatchWinner(null);
          setTeamWinReason(null);
        }
      }
      roundTeamWinner = winner;
      addDebugLog("Team Match Round Finished", { winner, reason, preservedRope: ropePositionRef.current, isKO: !!winner });
    }

    const contributors = foundWordsRef.current.reduce((acc, fw) => {
      const key = fw.user.toLowerCase();
      acc[key] = (acc[key] || 0) + fw.word.length;
      return acc;
    }, {} as Record<string, number>);
    const sortedRound = (Object.entries(contributors) as [string, number][]).sort((a, b) => b[1] - a[1]);

    // Prepare team MVP awards BEFORE the React state updater.
    // State updater callbacks must stay pure: React StrictMode may invoke them twice.
    const teamWinner = roundTeamWinner || teamMatchWinnerRef.current;
    const isTeamWin = gameModeRef.current === 'teams' && (teamWinner === 'blue' || teamWinner === 'red');
    let blueMvpUser: string | undefined;
    let redMvpUser: string | undefined;
    if (isTeamWin && !teamMvpAwardedRef.current) {
      teamMvpAwardedRef.current = true;
      const allMemberStats = Object.values(teamPlayerStatsRef.current || {}) as TeamMemberStat[];
      const blueStats = allMemberStats.filter(p => p.team === 'blue' && p.points > 0);
      const redStats = allMemberStats.filter(p => p.team === 'red' && p.points > 0);
      blueMvpUser = [...blueStats].sort((a, b) => b.points - a.points || b.wordsFound - a.wordsFound)[0]?.username;
      redMvpUser = [...redStats].sort((a, b) => b.points - a.points || b.wordsFound - a.wordsFound)[0]?.username;
      addDebugLog('Team MVP candidates prepared', {
        winner: teamWinner,
        blueMvpUser: blueMvpUser || null,
        redMvpUser: redMvpUser || null,
        bluePlayersWithPoints: blueStats.length,
        redPlayersWithPoints: redStats.length
      });
    }

    setGlobalStats(prev => {
      const next = { ...prev };
      const roundPlayerSet = new Set(Object.keys(contributors));

      // Update maxLevelReached for all contributors in this round (ONLY in classic mode)
      if (gameModeRef.current !== 'teams') {
        roundPlayerSet.forEach(userKey => {
          if (next[userKey]) {
            next[userKey] = {
              ...next[userKey],
              maxLevelReached: Math.max(next[userKey].maxLevelReached || 0, levelIndex + 1)
            };
          }
        });
      }

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

      // 2. Award Participation and Streaks ONLY on Success (or on Team victory / ongoing team match)
      const isOngoingTeamMatch = gameModeRef.current === 'teams' && !teamWinner;

      // Award +1 Team MVP to the highest-scoring player on each team.
      // Only players with >0 points qualify; empty teams receive no MVP.
      if (isTeamWin) {
        if (blueMvpUser) {
          const k = blueMvpUser.toLowerCase();
          const cur = next[k] || {
            displayName: blueMvpUser,
            points: 0,
            wins: 0,
            roundWins: 0,
            gameWins: 0,
            masterWordWins: 0,
            currentStreak: 0,
            maxStreak: 0,
            maxLevelReached: 0,
            totalShields: 0,
            teamMvp: 0,
            blueTeamMvp: 0,
            redTeamMvp: 0,
          };
          next[k] = {
            ...cur,
            displayName: cur.displayName || blueMvpUser,
            teamMvp: (cur.teamMvp || 0) + 1,
            blueTeamMvp: (cur.blueTeamMvp || 0) + 1,
          };
          addDebugLog("Awarded BLUE TEAM MVP (+1)", { user: blueMvpUser, totalMvp: next[k].teamMvp, blueMvp: next[k].blueTeamMvp });
        }

        if (redMvpUser) {
          const k = redMvpUser.toLowerCase();
          const cur = next[k] || {
            displayName: redMvpUser,
            points: 0,
            wins: 0,
            roundWins: 0,
            gameWins: 0,
            masterWordWins: 0,
            currentStreak: 0,
            maxStreak: 0,
            maxLevelReached: 0,
            totalShields: 0,
            teamMvp: 0,
            blueTeamMvp: 0,
            redTeamMvp: 0,
          };
          next[k] = {
            ...cur,
            displayName: cur.displayName || redMvpUser,
            teamMvp: (cur.teamMvp || 0) + 1,
            redTeamMvp: (cur.redTeamMvp || 0) + 1,
          };
          addDebugLog("Awarded RED TEAM MVP (+1)", { user: redMvpUser, totalMvp: next[k].teamMvp, redMvp: next[k].redTeamMvp });
        }
        
      }

      if (isSuccess || isTeamWin || isOngoingTeamMatch) {
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
      saveStats(next);
      return next;
    });

    setGameState('roundSummary');
    
    // Play round end sound
    if (gameModeRef.current === 'teams') {
      const winner = teamMatchWinnerRef.current;
      if (winner === 'blue' || winner === 'red') {
        playSound(AUDIO_PATHS.ROUND_SUCCESS, 1);
      } else {
        playSound(AUDIO_PATHS.ROUND_SUCCESS, 0.7);
      }
    } else {
      playSound(isSuccess ? AUDIO_PATHS.ROUND_SUCCESS : AUDIO_PATHS.ROUND_FAILURE, 1);
    }
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

  const shuffleLetters = useCallback((forceRerollSpecial: boolean = false) => {
    // If pool is empty or level changed or forced, initialize it
    // Check if we need to regenerate the pool
    const currentPool = lettersPoolRef.current;
    const isNewLevel = currentPool.length === 0 || 
                       currentPool.filter(l => !l.isDecoy).map(l => l.char).join('') !== currentLevel.masterWord;

    if (isNewLevel || forceRerollSpecial) {
      const letters: Letter[] = currentLevel.masterWord.split('').map((char) => ({ 
        id: Math.random(), 
        char, 
        isDecoy: false,
        isHidden: false
      }));
      
      // Add hidden letter logic
      if (levelIndex + 1 >= 16) {
        const hiddenCount = levelIndex + 1 >= 30 ? 2 : 1;
        const availableIndices = Array.from({ length: letters.length }, (_, i) => i);
        
        for (let i = 0; i < hiddenCount; i++) {
          if (availableIndices.length === 0) break;
          const randomIndexIdx = Math.floor(Math.random() * availableIndices.length);
          const lettersIdx = availableIndices.splice(randomIndexIdx, 1)[0];
          letters[lettersIdx].isHidden = true;
        }
      }
      
      // Add decoy letter from level 10 onwards
      if (levelIndex + 1 >= 10) {
        const decoyCount = levelIndex + 1 >= 45 ? 2 : 1;
        const alphabet = "AĄBCĆDEĘFGHIJKLŁMNŃOÓPRSŚTUWYZŹŻ";
        for (let i = 0; i < decoyCount; i++) {
          const randomChar = alphabet[Math.floor(Math.random() * alphabet.length)];
          const decoy: Letter = { id: Math.random(), char: randomChar, isDecoy: true, isHidden: false };
          letters.push(decoy);
        }
      }
      lettersPoolRef.current = letters;

      // Assign Special Words
      const newSpecialWords: Record<string, SpecialWordType> = {};
      
      // Level 1-3: 2 positive special words
      // Level 4-14: 2 positive
      // Level 15+: 2 positive, 1 hazard, 1 mystery
      const positiveTypes: SpecialWordType[] = ['FREEZE', 'TIME', 'SCANNER', 'GOLD', 'FREEZE', 'TIME', 'SCANNER', 'GOLD', 'FREEZE', 'TIME', 'SCANNER', 'GOLD'];
      if (levelIndex + 1 >= 1) positiveTypes.push('SHIELD');
      
      const hazardTypes: SpecialWordType[] = ['DARKNESS', 'TRAP', 'DARKNESS', 'TRAP'];
      if (levelIndex + 1 >= 25) {
        hazardTypes.push('SELF_STUN');
        hazardTypes.push('SELF_STUN');
        hazardTypes.push('LEADER_BLOCK');
      }
      if (levelIndex + 1 >= 30) {
        hazardTypes.push('STORM');
        hazardTypes.push('STORM');
      }
      if (levelIndex + 1 >= 35) {
        hazardTypes.push('FROST_BITE');
      }
      if (levelIndex + 1 >= 30) {
        positiveTypes.push('PARASITE');
      }
      
      const posCount = levelIndex + 1 >= 11 ? 3 : 2;
      const hazCount = levelIndex + 1 >= 15 ? 1 : 0;
      const mysteryCount = levelIndex + 1 >= 15 ? 1 : 0;
      const leaderBlockCount = 0;
      const shieldCount = 0;
      
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
    setFrozenWords({});
    setActiveParasites({});
    setBlockedPlayer(null);
    setLastActionTime(Date.now());
    setTimeLeft(INITIAL_TIME);
    setCountdownValue(5);
    setGameState('countdown');
  };

  const nextTeamRound = useCallback(() => {
    // Track played master word
    const lastWord = currentLevel.masterWord;
    setPlayedMasterWords(prev => [...prev, lastWord]);

    // Team mode always advances exactly one word/round. The completion-rate
    // level-jump bonus is reserved for classic mode only.
    const nextIdx = levelIndex + 1 >= levelSequence.length ? 0 : levelIndex + 1;

    addDebugLog("Transitioning to Next Team Round", {
      currentRound: teamRoundRef.current,
      nextRound: teamRoundRef.current + 1,
      currentLevelIndex: levelIndex,
      nextLevelIndex: nextIdx,
      preservedRope: ropePositionRef.current
    });

    if (nextIdx === 0) {
      setLevelSequence(generateLevelSequence());
    }
    setLevelIndex(nextIdx);
    setTeamRound(prev => prev + 1);

    // RESET ATOMIC GUARDS & ROUND-SPECIFIC STATE
    processedWordsInRoundRef.current.clear();
    awardProcessedRef.current = false; // RELEASE LOCK
    setShowRoundWords(false);
    setFoundWords([]);
    lettersPoolRef.current = [];
    setHints({});
    setFrozenWords({});
    setActiveParasites({});
    setBlockedPlayer(null);
    setLastActionTime(Date.now());
    setTimeLeft(INITIAL_TIME);

    // Reset current round streak combo, but keep maxTeamStreak and scores intact
    setCurrentTeamStreak({ team: null, count: 0 });
    setLastPullDelta(null);

    // CRITICAL: ropePosition remains untouched! The rope gauge stays exactly where it was!
    setCountdownValue(5);
    setGameState('countdown');
  }, [currentLevel.masterWord, levelIndex, levelSequence.length, generateLevelSequence, addDebugLog]);

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

  // Unified chat message and guess processing (used by Twitch IRC and Developer Simulation)
  const processIncomingChatMessage = useCallback((rawUser: string, message: string, customTags: any = {}) => {
    const userKey = rawUser.toLowerCase();
    const rawTrimmed = message.trim();
    const lowerCmd = rawTrimmed.toLowerCase();

    // Team Mode Lobby Commands (!join / !dolacz / !leave)
    if (lowerCmd === '!join' || lowerCmd === '!dolacz' || lowerCmd === '!dołącz') {
      if (gameStateRef.current === 'lobby' && gameModeRef.current === 'teams') {
        setTeamLobbyPlayers(prev => {
          if (prev.some(p => p.toLowerCase() === userKey)) return prev;
          return [...prev, rawUser];
        });
        if (blueTeamRef.current.length > 0 || redTeamRef.current.length > 0) {
          if (blueTeamRef.current.length <= redTeamRef.current.length) {
            setBlueTeam(prev => prev.some(p => p.toLowerCase() === userKey) ? prev : [...prev, rawUser]);
          } else {
            setRedTeam(prev => prev.some(p => p.toLowerCase() === userKey) ? prev : [...prev, rawUser]);
          }
        }
        showFeedback(`${rawUser} DOŁĄCZYŁ DO GRY! ⚔️`, "success");
        return;
      }
    }

    if (lowerCmd === '!leave' || lowerCmd === '!opusc' || lowerCmd === '!opuść') {
      if (gameStateRef.current === 'lobby' && gameModeRef.current === 'teams') {
        setTeamLobbyPlayers(prev => prev.filter(p => p.toLowerCase() !== userKey));
        setBlueTeam(prev => prev.filter(p => p.toLowerCase() !== userKey));
        setRedTeam(prev => prev.filter(p => p.toLowerCase() !== userKey));
        showFeedback(`${rawUser} opuścił poczekalnię`, "hazard");
        return;
      }
    }

    // Clean up message: remove leading ! or / and trim for guessing
    let cleanMessage = message.trim();
    if (cleanMessage.startsWith('!') || cleanMessage.startsWith('/')) {
      cleanMessage = cleanMessage.substring(1).trim();
    }
    
    const guess = cleanMessage.toUpperCase();

    // Determine team affiliation
    let userTeam: 'blue' | 'red' | 'spectator' = 'spectator';
    if (gameModeRef.current === 'teams') {
      if (blueTeamRef.current.some(p => p.toLowerCase() === userKey)) {
        userTeam = 'blue';
      } else if (redTeamRef.current.some(p => p.toLowerCase() === userKey)) {
        userTeam = 'red';
      }
    }

    // Check if player is blocked
    if (blockedPlayerRef.current && blockedPlayerRef.current.username.toLowerCase() === userKey && Date.now() < blockedPlayerRef.current.expiresAt) {
      return;
    }

    const color = customTags.color || (userTeam === 'blue' ? "#3b82f6" : userTeam === 'red' ? "#ef4444" : "#9146FF");

    // In Team Mode, spectators can chat but cannot score/solve words
    if (gameModeRef.current === 'teams' && gameStateRef.current === 'playing' && userTeam === 'spectator') {
      const newMessage: ChatLog = {
        id: customTags.id || Math.random().toString(),
        username: rawUser,
        message: message,
        color: color,
        isCorrect: false,
        team: 'spectator',
      };
      setMessages((prev) => [...prev, newMessage].slice(-50));
      return;
    }

    // Check if correct before adding to log
    let isCorrectMessage = false;
    if (gameStateRef.current === 'playing' && guess.length >= 3) {
      if (!processedWordsInRoundRef.current.has(guess) && possibleAnswersRef.current.includes(guess)) {
        isCorrectMessage = true;
      }
    }

    // Add to chat log
    const newMessage: ChatLog = {
      id: customTags.id || Math.random().toString(),
      username: rawUser,
      message: message,
      color: color,
      isCorrect: isCorrectMessage,
      team: gameModeRef.current === 'teams' ? userTeam : undefined,
    };
    setMessages((prev) => [...prev, newMessage].slice(-50));
    
    if (gameStateRef.current === 'playing') {
      if (guess.length < 3) return;

      // Check if word is frozen
      const frostExpiry = frozenWordsRef.current[guess];
      if (frostExpiry && Date.now() < frostExpiry) {
        showFeedback(`${rawUser}: SŁOWO "${guess}" JEST ZAMROŻONE! ❄️`, "hazard", 'HAZARD_STUN');
        return;
      }

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
          const allTypes: SpecialWordType[] = ['FREEZE', 'GOLD', 'TIME', 'SCANNER', 'STORM', 'DARKNESS', 'TRAP', 'LEADER_BLOCK', 'FROST_BITE', 'PARASITE'];
          mysteryResolvedType = allTypes[Math.floor(Math.random() * allTypes.length)];
          specialType = mysteryResolvedType;
          showFeedback(`${rawUser}: NIESPODZIANKA! 🎁`, "success", 'BONUS_MYSTERY');
        }

        let pointsToAdd = specialType === 'GOLD' ? guess.length + 10 : guess.length;
        
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
            shuffleLetters(true);
            showFeedback(`SZTORM! LITERKI ZOSTAŁY PRZETASOWANE! 🌪️`, "hazard", 'HAZARD_STORM');
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
              setBlockedPlayer({ username: actualLeader, expiresAt: Date.now() + 15000 });
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
            setBlockedPlayer({ username: rawUser, expiresAt: Date.now() + 15000 });
            showFeedback(`${rawUser}: PARALIŻ! Zablokowany na 15s 🚫`, "hazard", 'HAZARD_STUN');
          }
        } else if (specialType === 'FROST_BITE') {
          if (hasShield(rawUser)) {
            showFeedback(`${rawUser}: TARCZA CHRONI PRZED MROŹNYM POWIEWEM! 🛡️`, "success", 'BONUS_SHIELD');
          } else {
            const undiscovered = possibleAnswersRef.current.filter(w => 
              w !== currentLevelRef.current.masterWord && 
              !foundWordsRef.current.find(fw => fw.word === w) &&
              !(frozenWordsRef.current[w] && Date.now() < frozenWordsRef.current[w])
            );

            if (undiscovered.length > 0) {
              const targetWord = undiscovered[Math.floor(Math.random() * undiscovered.length)];
              setFrozenWords(prev => ({ ...prev, [targetWord]: Date.now() + 10000 }));
              showFeedback(`${rawUser} aktywował SZRON! Zamrożono: ${targetWord} ❄️`, "hazard", 'HAZARD_FROST_BITE');
            } else {
              showFeedback(`${rawUser}: SZRON! (Brak słów do zamrożenia)`, "hazard", 'HAZARD_FROST_BITE');
            }
          }
        } else if (specialType === 'PARASITE') {
          const otherPlayers = Object.keys(sessionScoresRef.current).filter(u => u.toLowerCase() !== rawUser.toLowerCase());
          if (otherPlayers.length > 0) {
            const victim = otherPlayers[Math.floor(Math.random() * otherPlayers.length)];
            setActiveParasites(prev => ({
              ...prev,
              [rawUser.toLowerCase()]: { victim, expiresAt: Date.now() + 10000 }
            }));
            showFeedback(`${rawUser}: PASOŻYT! Pasożytujesz na ${victim} przez 10s! 👾`, "success", 'BONUS_PARASITE');
          } else {
            showFeedback(`${rawUser}: PASOŻYT! (Brak przeciwników online)`, "success", 'BONUS_PARASITE');
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
             totalShields: 0,
             teamMvp: 0,
             blueTeamMvp: 0,
             redTeamMvp: 0
          };
          
          const next = {
            ...prev,
            [userKey]: {
              ...userData,
              displayName: rawUser,
              points: (userData.points || 0) + pointsToAdd,
              masterWordWins: isMaster ? (userData.masterWordWins || 0) + 1 : (userData.masterWordWins || 0),
              maxLevelReached: gameModeRef.current === 'teams'
                ? (userData.maxLevelReached || 0)
                : Math.max(userData.maxLevelReached || 0, levelIndexRef.current + 1),
              totalShields: specialType === 'SHIELD' ? (userData.totalShields || 0) + 1 : (userData.totalShields || 0)
            }
          };
          saveStats(next);
          return next;
        });

        // 2. UI Feedback
        if (isMaster) {
          triggerConfetti();
          showFeedback(`${rawUser} ODKRYŁ HASŁO GŁÓWNE!`, "success", 'MASTER_WORD_CORRECT');
        } else if (specialType === 'FREEZE') {
          // Already handled above with specific 'freeze' type
        } else if (specialType === 'GOLD') {
          showFeedback(`${rawUser}: ZŁOTE SŁOWO! (+10pkt)`, "success", 'BONUS_GOLD');
        } else {
          showFeedback(`${rawUser} odgadł: ${guess}`, "success", 'WORD_CORRECT');
        }

        // 3. Update session scores
        setSessionScores(prev => {
          const next = { ...prev };
          next[rawUser] = (next[rawUser] || 0) + pointsToAdd;

          // PARASITE LOGIC: Check if anyone is parasite-linked to this user
          Object.entries(activeParasitesRef.current).forEach(([activator, data]) => {
            const pData = data as { victim: string; expiresAt: number };
            if (pData.victim.toLowerCase() === rawUser.toLowerCase() && Date.now() < pData.expiresAt) {
              const parasiticPoints = Math.floor(pointsToAdd * 0.5);
              if (parasiticPoints > 0) {
                 next[activator] = (next[activator] || 0) + parasiticPoints;
              }
            }
          });

          return next;
        });

        // 4. Update round words
        setFoundWords(prev => [...prev, { word: guess, user: rawUser, points: pointsToAdd }]);

        // 5. Team Mode (Tug-of-War & Team Streaks)
        if (gameModeRef.current === 'teams') {
          const scoringTeam = userTeam as 'blue' | 'red';
          
          // Direct letter count scoring:
          // 3-letter word = 3 pts, 6-letter word = 6 pts, etc.
          // System premiowy (Bonuses):
          // Master word: length + 5 bonus pts
          // GOLD special word: length + 5 bonus pts
          let basePull = guess.length;
          if (isMaster) {
            basePull += 5;
          }
          if (specialType === 'GOLD') {
            basePull += 5;
          }
          
          // Team Streak calculation (Combo Drużynowe)
          let newStreakCount = 1;
          if (currentTeamStreakRef.current.team === scoringTeam) {
            newStreakCount = currentTeamStreakRef.current.count + 1;
          }

          let multiplier = 1.0;
          if (newStreakCount === 2) multiplier = 1.3;
          else if (newStreakCount === 3) multiplier = 1.6;
          else if (newStreakCount >= 4) multiplier = 2.0;

          const actualPull = Number((basePull * multiplier).toFixed(1));

          setCurrentTeamStreak({ team: scoringTeam, count: newStreakCount });
          maxTeamStreakRef.current = {
            ...maxTeamStreakRef.current,
            [scoringTeam]: Math.max(maxTeamStreakRef.current[scoringTeam], newStreakCount)
          };

          setTeamPlayerStats(prev => {
            const cur = prev[userKey] || { username: rawUser, team: scoringTeam, points: 0, wordsFound: 0 };
            return {
              ...prev,
              [userKey]: {
                ...cur,
                points: cur.points + pointsToAdd,
                wordsFound: cur.wordsFound + 1
              }
            };
          });

          setTeamScores(prev => ({
            ...prev,
            [scoringTeam]: prev[scoringTeam] + pointsToAdd
          }));

          // Blue expands towards 100% (right), Red expands towards 0% (left)
          // 50 PKT each on start (scale 0-100 total)
          const curRope = ropePositionRef.current;
          let nextRope = scoringTeam === 'blue' 
            ? Math.min(100, curRope + actualPull) 
            : Math.max(0, curRope - actualPull);
          nextRope = Number(nextRope.toFixed(1));
          setRopePosition(nextRope);
          setLastPullDelta({ team: scoringTeam, amount: actualPull, word: guess, user: rawUser });

          // Check KO Instant Win (100 PKT)
          if (nextRope >= 100) {
            setTeamMatchWinner('blue');
            setTeamWinReason('ko');
            showFeedback(`🏆 K.O.! NIEBIESCY WYGRYWAJĄ MECZ (100 PKT)! 🏆`, "success");
            triggerConfetti(true);
            setTimeout(() => {
              processRoundResults(true);
            }, 1200);
          } else if (nextRope <= 0) {
            setTeamMatchWinner('red');
            setTeamWinReason('ko');
            showFeedback(`🏆 K.O.! CZERWONI WYGRYWAJĄ MECZ (100 PKT)! 🏆`, "success");
            triggerConfetti(true);
            setTimeout(() => {
              processRoundResults(true);
            }, 1200);
          } else {
            const bonusNote = isMaster ? ' [HASŁO GŁÓWNE +5]' : specialType === 'GOLD' ? ' [ZŁOTO +5]' : '';
            const comboNote = newStreakCount >= 2 ? ` (COMBO x${newStreakCount}! 🔥)` : '';
            const tName = scoringTeam === 'blue' ? 'NIEBIESCY' : 'CZERWONI';
            showFeedback(`[${tName}] ${rawUser}: +${actualPull} PKT! (${guess.length}-lit.${bonusNote})${comboNote}`, "success");
          }
        }
      }
    }
  }, [addDebugLog, processRoundResults, showFeedback, shuffleLetters, triggerConfetti]);

  const processIncomingChatMessageRef = useRef(processIncomingChatMessage);
  useEffect(() => {
    processIncomingChatMessageRef.current = processIncomingChatMessage;
  }, [processIncomingChatMessage]);

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
      const rawUser = tags['display-name'] || tags.username || "Anonim";
      processIncomingChatMessageRef.current(rawUser, message, tags);
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

  // Helper Functions for Team Mode
  const shuffleTeams = useCallback(() => {
    if (teamLobbyPlayers.length < 2) return;
    const shuffled = [...teamLobbyPlayers].sort(() => Math.random() - 0.5);
    const mid = Math.ceil(shuffled.length / 2);
    const blue = shuffled.slice(0, mid);
    const red = shuffled.slice(mid);
    setBlueTeam(blue);
    setRedTeam(red);
    showFeedback("ROZLOSOWANO SKŁADY DRUŻYN!", "success");
  }, [teamLobbyPlayers]);

  const movePlayerToTeam = useCallback((username: string, targetTeam: 'blue' | 'red') => {
    if (targetTeam === 'blue') {
      setRedTeam(prev => prev.filter(p => p !== username));
      setBlueTeam(prev => prev.includes(username) ? prev : [...prev, username]);
    } else {
      setBlueTeam(prev => prev.filter(p => p !== username));
      setRedTeam(prev => prev.includes(username) ? prev : [...prev, username]);
    }
  }, []);

  const removePlayerFromLobby = useCallback((username: string) => {
    setTeamLobbyPlayers(prev => prev.filter(p => p !== username));
    setBlueTeam(prev => prev.filter(p => p !== username));
    setRedTeam(prev => prev.filter(p => p !== username));
  }, []);

  const addTestPlayer = useCallback(() => {
    const testNames = ["GamerPro", "CyberNinja", "StreamFan", "PixelMaster", "ViperPL", "ShadowWolf", "NeonRider", "TurboHacker"];
    const available = testNames.filter(n => !teamLobbyPlayers.includes(n));
    const newName = available.length > 0 ? available[0] : `Gracz_${teamLobbyPlayers.length + 1}`;
    setTeamLobbyPlayers(prev => [...prev, newName]);
    if (blueTeam.length > 0 || redTeam.length > 0) {
      if (blueTeam.length <= redTeam.length) {
        setBlueTeam(prev => [...prev, newName]);
      } else {
        setRedTeam(prev => [...prev, newName]);
      }
    }
  }, [teamLobbyPlayers, blueTeam.length, redTeam.length]);

  const startTeamGame = useCallback(() => {
    // Use the same Twitch connection gate as Classic mode.
    if (!isConnected) {
      showFeedback("NAJPIERW POŁĄCZ BOTA Z KONTEM TWITCH!", "error");
      addDebugLog("Team game start blocked: Twitch disconnected", { channel: activeChannel });
      return;
    }
    addDebugLog("Starting Team Session", { blue: blueTeam.length, red: redTeam.length });
    setLevelSequence(generateLevelSequence());
    setLevelIndex(0);
    setFoundWords([]);
    setSessionScores({});
    awardProcessedRef.current = false;
    sessionAwardedRef.current = false; 
    lettersPoolRef.current = [];
    setBlockedPlayer(null);
    currentSessionIdRef.current = Math.random().toString(36).substring(7);
    lastProcessedLevelRef.current = -1;
    processedWordsInRoundRef.current.clear();
    setTeamRound(1);
    setRopePosition(50);
    setTeamScores({ blue: 0, red: 0 });
    setTeamPlayerStats({});
    setCurrentTeamStreak({ team: null, count: 0 });
    maxTeamStreakRef.current = { blue: 0, red: 0 };
    setTeamMatchWinner(null);
    setTeamWinReason(null);
    setLastPullDelta(null);
    teamMvpAwardedRef.current = false;
    setHints({});
    setFrozenWords({});
    setActiveParasites({});
    setTimeLeft(INITIAL_TIME);
    setCountdownValue(5);
    setGameState('countdown');
  }, [blueTeam.length, redTeam.length, generateLevelSequence, addDebugLog, isConnected, activeChannel, showFeedback]);


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
      streak: getTop((a, b) => (b[1].maxStreak || 0) - (a[1].maxStreak || 0)),
      teamMvp: getTop((a, b) => (b[1].teamMvp || 0) - (a[1].teamMvp || 0))
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
    if (leaders.teamMvp === userKey) badgesData.push({ icon: Swords, color: "text-amber-400", label: "LIDER MVP DRUŻYNY" });

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
      {/* Changelog Modal */}
      <AnimatePresence>
        {showChangelog && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[110] bg-black/95 backdrop-blur-2xl flex items-center justify-center p-4 overflow-y-auto custom-scrollbar"
          >
            <motion.div
              initial={{ scale: 0.9, y: 20, opacity: 0 }}
              animate={{ scale: 1, y: 0, opacity: 1 }}
              exit={{ scale: 0.9, y: 20, opacity: 0 }}
              className="bg-bg-card border border-white/10 rounded-[3rem] max-w-2xl w-full flex flex-col shadow-[0_0_100px_rgba(0,0,0,0.8)] relative"
            >
              <button 
                onClick={() => setShowChangelog(false)}
                className="absolute top-8 right-8 p-4 bg-white/5 hover:bg-accent-red rounded-2xl transition-all z-20 group"
              >
                <X className="w-6 h-6 text-white" />
              </button>

              <div className="p-10 border-b border-white/5 bg-gradient-to-br from-white/10 to-transparent">
                <div className="flex items-center gap-4 mb-2">
                  <div className="p-3 bg-yellow-500/20 rounded-2xl border border-yellow-500/20">
                    <Sparkles className="w-8 h-8 text-yellow-400" />
                  </div>
                  <div>
                    <h2 className="text-4xl font-black italic tracking-tighter text-white leading-none">CO NOWEGO?</h2>
                    <p className="text-[10px] font-black tracking-widest text-yellow-400 uppercase mt-2">DZIENNIK ZMIAN I AKTUALIZACJE</p>
                  </div>
                </div>
              </div>

              <div className="p-10 space-y-12 max-h-[60vh] overflow-y-auto custom-scrollbar">
                {CHANGELOG_DATA.map((entry: any, idx: number) => (
                  <div key={idx} className="relative pl-8 border-l-2 border-white/5 space-y-6">
                    <div className="absolute -left-[9px] top-0 w-4 h-4 bg-bg-card border-2 border-accent-red rounded-full shadow-[0_0_10px_rgba(230,57,70,0.4)]" />
                    
                    <div className="space-y-1">
                      <div className="flex items-center gap-3">
                        <span className="text-2xl font-black text-white italic tracking-tighter uppercase">{entry.title}</span>
                        <span className="px-3 py-1 bg-white/5 rounded-full text-[9px] font-black text-text-secondary border border-white/5 uppercase tracking-widest">v{entry.version}</span>
                      </div>
                      <span className="text-[10px] font-black text-text-secondary/40 uppercase tracking-widest block">{entry.date}</span>
                    </div>

                    <ul className="space-y-3">
                      {entry.changes.map((change: string, cIdx: number) => (
                        <li key={cIdx} className="flex gap-4 text-sm text-text-secondary leading-relaxed group">
                          <span className="text-accent-red font-black mt-0.5 group-hover:scale-125 transition-transform">•</span>
                          <span className="group-hover:text-white transition-colors uppercase font-medium tracking-tight text-[11px]">{change}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>

              <div className="p-10 bg-white/5 border-t border-white/5 flex flex-col items-center">
                 <button 
                   onClick={() => setShowChangelog(false)}
                   className="w-full bg-white hover:bg-neutral-200 text-black py-5 rounded-2xl font-black tracking-[0.3em] uppercase transition-all shadow-2xl active:scale-95 text-xs"
                 >
                   ZAMKNIJ OKNO
                 </button>
                 <p className="mt-6 text-[9px] font-black text-text-secondary opacity-30 uppercase tracking-widest italic">TWITCH SŁÓWKA • STWORZONE Z PASJĄ DLA SPOŁECZNOŚCI</p>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

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
                    <button 
                      onClick={() => setSettingsTab('developer')}
                      className={`px-6 py-2 rounded-xl text-[10px] font-black tracking-widest transition-all ${settingsTab === 'developer' ? 'bg-white/15 text-white' : 'text-white/30 hover:text-white'}`}
                    >
                      DEV
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

                {settingsTab === 'developer' && (
                  <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="space-y-8 flex flex-col items-center justify-center py-10">
                    <div className="text-center space-y-4 max-w-sm">
                      <div className="w-16 h-16 bg-white/5 rounded-3xl flex items-center justify-center mx-auto mb-6 border border-white/10 shadow-2xl">
                        <ShieldCheck className={`w-8 h-8 ${isDevAuthorized ? 'text-green-400' : 'text-text-secondary opacity-20'}`} />
                      </div>
                      
                      {isDevAuthorized ? (
                        <div className="space-y-6 w-full max-w-xl">
                          <div className="space-y-4">
                            <h3 className="text-xl font-black text-white italic tracking-tighter uppercase">DOSTĘP AUTORYZOWANY</h3>
                            <p className="text-[10px] font-bold text-green-400/60 uppercase tracking-widest">Narzędzia deweloperskie są teraz aktywne w rogu ekranu.</p>
                            <p className="text-[9px] font-medium text-white/20 uppercase max-w-[200px] mx-auto italic">Aby edytować changelog, zmień zawartość pliku src/changelog.json</p>
                            <button 
                              onClick={() => setIsDevAuthorized(false)}
                              className="bg-white/5 hover:bg-accent-red text-white px-6 py-2 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all"
                            >
                              WYLOGUJ Z TRYBU DEV
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-4">
                          <h3 className="text-xl font-black text-white italic tracking-tighter">TRYB DEWELOPERSKI</h3>
                          <p className="text-[10px] font-bold text-text-secondary/40 uppercase tracking-widest">Wpisz hasło, aby odblokować narzędzia testowe.</p>
                          
                          <div className="relative group">
                            <input 
                              type="password"
                              placeholder="HASŁO..."
                              value={devPasswordInput}
                              onChange={(e) => {
                                const val = e.target.value;
                                setDevPasswordInput(val);
                                if (val === "Gr54@gmhy453") {
                                  setIsDevAuthorized(true);
                                  setDevPasswordInput("");
                                }
                              }}
                              className="w-full bg-black/40 border border-white/10 rounded-2xl px-6 py-4 text-center text-sm font-mono tracking-[0.3em] focus:border-accent-red outline-none transition-all placeholder:text-white/10"
                            />
                            <div className="absolute inset-0 rounded-2xl bg-accent-red/20 opacity-0 group-hover:opacity-10 pointer-events-none transition-opacity" />
                          </div>

                          {devPasswordInput.length > 0 && devPasswordInput !== "Gr54@gmhy453" && (
                            <motion.p 
                              initial={{ opacity: 0 }}
                              animate={{ opacity: 1 }}
                              className="text-[9px] font-black text-accent-red uppercase tracking-widest"
                            >
                              BŁĘDNE HASŁO
                            </motion.p>
                          )}
                        </div>
                      )}
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
              <div className="p-6 md:p-8 border-b border-white/5 bg-white/5 flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-2xl md:text-3xl font-black italic tracking-tighter text-white leading-none mb-1">
                      {helpTab === 'teams' ? 'INSTRUKCJA GRY DRUŻYNOWEJ' : 'INSTRUKCJA GRY KLASYCZNEJ'}
                    </h2>
                    <p className="text-[10px] font-black tracking-widest text-text-secondary uppercase opacity-60">
                      {helpTab === 'teams' ? 'BITWA CZATU • PRZECIĄGANIE LINY • ZASADY & MVP' : 'ZASADY I BONUSY SPECJALNE (TRYB FFA)'}
                    </p>
                  </div>
                  <button 
                    onClick={() => setShowHelp(false)}
                    className="p-3 bg-white/5 hover:bg-accent-red rounded-2xl transition-all group cursor-pointer"
                  >
                    <X className="w-6 h-6 text-white" />
                  </button>
                </div>

                {/* Tab Switcher */}
                <div className="grid grid-cols-2 gap-2 bg-black/40 p-1.5 rounded-2xl border border-white/10">
                  <button
                    onClick={() => setHelpTab('solo')}
                    className={`py-2.5 px-3 rounded-xl text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center gap-2 cursor-pointer ${
                      helpTab === 'solo'
                        ? 'bg-accent-red text-white shadow-[0_0_15px_rgba(230,57,70,0.5)]'
                        : 'text-text-secondary hover:text-white hover:bg-white/5'
                    }`}
                  >
                    <Trophy className="w-4 h-4" />
                    <span>TRYB KLASYCZNY</span>
                  </button>
                  <button
                    onClick={() => setHelpTab('teams')}
                    className={`py-2.5 px-3 rounded-xl text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center gap-2 cursor-pointer ${
                      helpTab === 'teams'
                        ? 'bg-gradient-to-r from-blue-600 via-purple-600 to-red-600 text-white shadow-[0_0_15px_rgba(59,130,246,0.5)]'
                        : 'text-text-secondary hover:text-white hover:bg-white/5'
                    }`}
                  >
                    <Swords className="w-4 h-4 text-yellow-300" />
                    <span>TRYB DRUŻYNOWY</span>
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-6 md:p-8 custom-scrollbar space-y-8">
                {helpTab === 'teams' ? (
                  <>
                    {/* SECTION 1: TUG OF WAR MECHANIC */}
                    <div className="space-y-4">
                      <h3 className="text-xs font-black tracking-[0.3em] text-cyan-400 uppercase flex items-center gap-2">
                        <Swords className="w-4 h-4 text-yellow-400" /> PRZECIĄGANIE LINY (TUG OF WAR)
                      </h3>

                      {/* Visual Rope Gauge Representation */}
                      <div className="bg-black/40 border border-white/10 p-5 rounded-2xl flex flex-col gap-3">
                        <div className="flex justify-between text-[10px] font-black tracking-wider uppercase">
                          <span className="text-blue-400 flex items-center gap-1">
                            <ShieldCheck className="w-3.5 h-3.5" /> 0% BAZA NIEBIESKICH (K.O.)
                          </span>
                          <span className="text-text-secondary font-mono">50% ŚRODEK</span>
                          <span className="text-red-400 flex items-center gap-1">
                            100% BAZA CZERWONYCH (K.O.) <Flame className="w-3.5 h-3.5" />
                          </span>
                        </div>
                        <div className="relative h-4 bg-white/5 rounded-full overflow-hidden border border-white/10 flex items-center">
                          <div className="w-1/2 h-full bg-blue-600/40" />
                          <div className="w-1/2 h-full bg-red-600/40" />
                          <div className="absolute left-1/2 top-0 bottom-0 w-1.5 bg-yellow-400 -translate-x-1/2 shadow-[0_0_8px_#facc15]" />
                        </div>
                        <p className="text-[11px] text-text-secondary leading-relaxed">
                          Lina na starcie meczu znajduje się na pozycji <span className="text-white font-bold">50%</span>. Gracze <span className="text-blue-400 font-bold">Drużyny Niebieskiej</span> przeciągają ją w lewo (do 0%), a gracze <span className="text-red-400 font-bold">Drużyny Czerwonej</span> w prawo (do 100%).
                        </p>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className="bg-blue-950/20 border border-blue-500/20 p-4 rounded-2xl flex flex-col gap-1.5">
                          <div className="flex items-center gap-2">
                            <div className="w-8 h-8 rounded-lg bg-blue-600/30 border border-blue-500/30 flex items-center justify-center text-blue-400">
                              <ShieldCheck className="w-4 h-4" />
                            </div>
                            <h4 className="text-xs font-black text-blue-400 uppercase">NATYCHMIASTOWE K.O.</h4>
                          </div>
                          <p className="text-[11px] text-text-secondary leading-relaxed">
                            Gdy lina osiągnie <span className="text-white font-bold">0%</span> (dla Niebieskich) lub <span className="text-white font-bold">100%</span> (dla Czerwonych), mecz kończy się natychmiastowym zwycięstwem przez K.O.!
                          </p>
                        </div>
                        <div className="bg-red-950/20 border border-red-500/20 p-4 rounded-2xl flex flex-col gap-1.5">
                          <div className="flex items-center gap-2">
                            <div className="w-8 h-8 rounded-lg bg-red-600/30 border border-red-500/30 flex items-center justify-center text-red-400">
                              <Timer className="w-4 h-4" />
                            </div>
                            <h4 className="text-xs font-black text-red-400 uppercase">KONIEC CZASU (60S)</h4>
                          </div>
                          <p className="text-[11px] text-text-secondary leading-relaxed">
                            Jeżeli upłynie czas rundy, wygrywa drużyna, która przeciągnęła linę na swoją połowę (&lt;50% Niebiescy, &gt;50% Czerwoni).
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* SECTION 2: WORD LENGTH & COMBO STREAK */}
                    <div className="space-y-4 pt-4 border-t border-white/5">
                      <h3 className="text-xs font-black tracking-[0.3em] text-yellow-400 uppercase flex items-center gap-2">
                        <Flame className="w-4 h-4 text-orange-400" /> SIŁA PRZECIĄGANIA I PŁONĄCE SERIE
                      </h3>
                      <div className="grid gap-2">
                        <div className="flex items-center gap-4 bg-yellow-400/5 border border-yellow-400/10 p-4 rounded-2xl">
                          <div className="w-12 h-12 bg-yellow-500 rounded-xl flex items-center justify-center shadow-[0_0_15px_rgba(234,179,8,0.3)] shrink-0">
                            <Trophy className="w-6 h-6 text-white" />
                          </div>
                          <div>
                            <h4 className="text-sm font-black text-yellow-400 uppercase">DŁUGOŚĆ SŁOWA = SIŁA CIĄGNIĘCIA</h4>
                            <p className="text-[11px] text-text-secondary leading-relaxed">
                              Każda litera ma znaczenie! Słowo <span className="text-white font-bold">3-literowe przesuwa linę o 3 punkty siły</span>, a słowo <span className="text-white font-bold">6-literowe aż o 6 punktów siły</span>. Odgadywanie dłuższych słów pozwala na potężny zryw!
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-4 bg-orange-400/5 border border-orange-400/10 p-4 rounded-2xl">
                          <div className="w-12 h-12 bg-orange-500 rounded-xl flex items-center justify-center shadow-[0_0_15px_rgba(249,115,22,0.3)] shrink-0">
                            <Flame className="w-6 h-6 text-white" />
                          </div>
                          <div>
                            <h4 className="text-sm font-black text-orange-400 uppercase">PŁONĄCA SERIA (COMBO STREAK 🔥)</h4>
                            <p className="text-[11px] text-text-secondary leading-relaxed">
                              Gdy ta sama drużyna odgadnie <span className="text-white font-bold">3 lub więcej haseł z rzędu</span> bez przerwania przez przeciwników, otrzymuje premię <span className="text-green-400 font-bold">+30% do siły przeciągania liny</span>!
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-4 bg-purple-400/5 border border-purple-400/10 p-4 rounded-2xl">
                          <div className="w-12 h-12 bg-purple-600 rounded-xl flex items-center justify-center shadow-[0_0_15px_rgba(147,51,234,0.3)] shrink-0">
                            <Crown className="w-6 h-6 text-yellow-300" />
                          </div>
                          <div>
                            <h4 className="text-sm font-black text-purple-400 uppercase">HASŁO GŁÓWNE (MASTER WORD)</h4>
                            <p className="text-[11px] text-text-secondary leading-relaxed">
                              Najdłuższe hasło planszy daje <span className="text-white font-bold">potężne pchnięcie liny</span> dla drużyny, która je rozszyfruje, oraz prestiżowy punkt mistrzowski.
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* SECTION 3: MVP DRUŻYNY */}
                    <div className="space-y-4 pt-4 border-t border-white/5">
                      <h3 className="text-xs font-black tracking-[0.3em] text-cyan-400 uppercase flex items-center gap-2">
                        <Swords className="w-4 h-4 text-cyan-400" /> SYSTEM MVP DRUŻYNY
                      </h3>
                      <div className="bg-gradient-to-r from-blue-950/30 via-purple-950/20 to-red-950/30 border border-white/10 p-5 rounded-2xl flex flex-col gap-3">
                        <div className="flex items-center gap-3">
                          <div className="p-2.5 bg-yellow-400/20 text-yellow-300 rounded-xl border border-yellow-400/30">
                            <Crown className="w-5 h-5" />
                          </div>
                          <div>
                            <h4 className="text-sm font-black text-white uppercase tracking-wider">
                              +1 PUNKT MVP DLA LIDERÓW NIEBIESKICH I CZERWONYCH
                            </h4>
                            <p className="text-[10px] text-text-secondary uppercase tracking-widest">
                              Przyznawane automatycznie po zakończeniu każdego meczu
                            </p>
                          </div>
                        </div>
                        <p className="text-[11px] text-text-secondary leading-relaxed">
                          Po zakończeniu każdego meczu wyłaniany jest najlepszy gracz z <span className="text-blue-400 font-bold">Drużyny Niebieskiej</span> oraz z <span className="text-red-400 font-bold">Drużyny Czerwonej</span>. Oboje otrzymują <span className="text-white font-bold">+1 punkt MVP</span> do globalnego rankingu w zakładce <span className="text-yellow-400 font-bold">STATYSTYKI &gt; MVP DRUŻYNY</span>.
                        </p>
                      </div>
                    </div>

                    {/* SECTION 4: TWITCH CHAT COMMANDS */}
                    <div className="space-y-4 pt-4 border-t border-white/5">
                      <h3 className="text-xs font-black tracking-[0.3em] text-white uppercase flex items-center gap-2">
                        <FaTwitch className="w-4 h-4 text-purple-400" /> KOMENDY NA CZACIE TWITCH
                      </h3>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <div className="bg-white/5 border border-white/10 p-3 rounded-xl flex items-center justify-between">
                          <code className="text-xs font-mono font-black text-yellow-400 bg-black/40 px-2 py-1 rounded">!join / !dolacz</code>
                          <span className="text-[10px] text-text-secondary uppercase font-bold">Zapisz się do meczu</span>
                        </div>
                        <div className="bg-white/5 border border-white/10 p-3 rounded-xl flex items-center justify-between">
                          <code className="text-xs font-mono font-black text-red-400 bg-black/40 px-2 py-1 rounded">!leave</code>
                          <span className="text-[10px] text-text-secondary uppercase font-bold">Opuść poczekalnię</span>
                        </div>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
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
                              <p className="text-[11px] text-text-secondary leading-relaxed">Daje bonus <span className="text-white font-bold">+10 PUNKTÓW</span> do podstawowej długości słowa.</p>
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
                         <div className="flex items-center gap-4 bg-purple-400/5 border border-purple-400/10 p-4 rounded-2xl">
                            <div className="w-12 h-12 bg-purple-600 rounded-xl flex items-center justify-center shadow-[0_0_15px_rgba(168,85,247,0.3)] shrink-0">
                              <Bug className="w-6 h-6 text-white" />
                            </div>
                            <div>
                              <div className="flex items-center gap-2">
                                 <h4 className="text-sm font-black text-purple-400 uppercase">PASOŻYT</h4>
                                 <span className="text-[8px] font-black bg-purple-500/20 text-purple-400 px-1.5 py-0.5 rounded border border-purple-500/20 uppercase tracking-tighter shrink-0">OD 30. POZIOMU</span>
                               </div>
                              <p className="text-[11px] text-text-secondary leading-relaxed">Przez 10 sekund otrzymujesz <span className="text-white font-bold">50% PUNKTÓW</span> za każde słowo odgadnięte przez wybranego losowo przeciwnika!</p>
                            </div>
                         </div>
                      </div>
                    </div>

                    <div className="space-y-4 pt-4 border-t border-white/5">
                      <div className="flex items-center justify-between">
                        <h3 className="text-xs font-black tracking-[0.3em] text-orange-500 uppercase flex items-center gap-2">
                          <Skull className="w-4 h-4" /> ZAGROŻENIA RUNDY
                        </h3>
                        <span className="text-[9px] font-black bg-orange-500/10 text-orange-500 px-2 py-0.5 rounded border border-orange-500/20 uppercase tracking-tighter">OD 30. POZIOMU</span>
                      </div>
                      <div className="grid gap-2">
                         <div className="flex items-center gap-4 bg-orange-400/5 border border-orange-400/10 p-4 rounded-2xl opacity-80">
                            <div className="w-12 h-12 bg-orange-500 rounded-xl flex items-center justify-center shadow-[0_0_15px_rgba(249,115,22,0.3)] shrink-0">
                              <Wind className="w-6 h-6 text-white" />
                            </div>
                            <div>
                              <h4 className="text-sm font-black text-orange-500 uppercase">SZTORM</h4>
                              <p className="text-[11px] text-text-secondary leading-relaxed">Natychmiast <span className="text-white font-bold">PRZETASOWUJE</span> wszystkie litery na dolnej belce. Potrafi także zmienić fałszywą oraz ukrytą literkę!</p>
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
                              <div className="flex items-center gap-2">
                                 <h4 className="text-sm font-black text-red-500 uppercase">BLOKADA LIDERA</h4>
                                 <span className="text-[8px] font-black bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded border border-red-500/20 uppercase tracking-tighter shrink-0">OD 25. POZIOMU</span>
                               </div>
                              <p className="text-[11px] text-text-secondary leading-relaxed">Jeśli inny gracz je trafi: <span className="text-white font-bold">BLOKUJE LIDERA</span> na 15s. Jeśli Lider je trafi: zyskuje <span className="text-green-400 font-bold">+30 PKT</span>.</p>
                            </div>
                         </div>
                         <div className="flex items-center gap-4 bg-blue-400/5 border border-blue-400/10 p-4 rounded-2xl opacity-80">
                            <div className="w-12 h-12 bg-blue-600 rounded-xl flex items-center justify-center shadow-[0_0_15px_rgba(37,99,235,0.3)] shrink-0">
                              <Snowflake className="w-6 h-6 text-white" />
                            </div>
                            <div>
                              <div className="flex items-center gap-2">
                                 <h4 className="text-sm font-black text-blue-400 uppercase">SZRON</h4>
                                 <span className="text-[8px] font-black bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded border border-blue-500/20 uppercase tracking-tighter shrink-0">OD 35. POZIOMU</span>
                               </div>
                              <p className="text-[11px] text-text-secondary leading-relaxed"><span className="text-white font-bold">ZAMRAŻA</span> losowe nieodkryte hasło na 10 sekund. W tym czasie nie można go odgadnąć!</p>
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
                              <p className="text-[11px] text-text-secondary leading-relaxed">Gracz, który odkryje to słowo, zostaje <span className="text-white font-bold">ZABLOKOWANY NA 15 SEKUND</span>. Tarcza chroni przed tym efektem.</p>
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
                  </>
                )}
              </div>

              <div className="p-6 md:p-8 bg-white/5 border-t border-white/5">
                 <button 
                   onClick={() => setShowHelp(false)}
                   className="w-full bg-accent-red hover:bg-red-700 text-white py-4 rounded-xl font-black tracking-[0.2em] uppercase transition-all shadow-xl active:scale-95 cursor-pointer"
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
                              ...(prev[userKey] || { 
                                displayName: 'DebugUser', 
                                points: 0, 
                                wins: 0, 
                                roundWins: 0, 
                                gameWins: 0, 
                                masterWordWins: 0, 
                                currentStreak: 0, 
                                maxStreak: 0,
                                maxLevelReached: 0,
                                totalShields: 0,
                                teamMvp: 0,
                                blueTeamMvp: 0,
                                redTeamMvp: 0
                              }),
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
      
      {/* Compact Game Menu Top Right */}
      {(gameState === 'playing' || gameState === 'countdown' || gameState === 'roundSummary') && (
        <div className="fixed top-3 right-3 md:top-5 md:right-5 z-50">
          <button
            type="button"
            onClick={() => setShowGameMenu(prev => !prev)}
            aria-label="Otwórz menu gry"
            aria-expanded={showGameMenu}
            title="Menu gry"
            className="w-10 h-10 flex items-center justify-center rounded-xl bg-bg-card/95 border border-border-color text-text-secondary hover:text-white hover:bg-neutral-800 shadow-xl backdrop-blur-sm transition-all active:scale-95"
          >
            <MoreVertical className="w-5 h-5" />
          </button>

          <AnimatePresence>
            {showGameMenu && (
              <motion.div
                initial={{ opacity: 0, y: -6, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -6, scale: 0.96 }}
                transition={{ duration: 0.14 }}
                className="absolute right-0 top-12 w-52 p-1.5 rounded-xl bg-[#1c1c21] border border-white/10 shadow-2xl backdrop-blur-xl"
              >
                <button
                  type="button"
                  onClick={() => {
                    setHelpTab(gameMode === 'teams' ? 'teams' : 'solo');
                    setShowHelp(true);
                    setShowGameMenu(false);
                  }}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left text-xs font-bold text-text-secondary hover:text-white hover:bg-cyan-600/20 transition-colors"
                >
                  <Info className="w-4 h-4 text-cyan-400" />
                  {gameMode === 'teams' ? 'Instrukcja drużyny' : 'Instrukcja gry'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowSettings(true);
                    setShowGameMenu(false);
                  }}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left text-xs font-bold text-text-secondary hover:text-white hover:bg-purple-600/20 transition-colors"
                >
                  <Settings className="w-4 h-4 text-purple-400" />
                  Opcje
                </button>
                <div className="my-1 border-t border-white/10" />
                <button
                  type="button"
                  onClick={() => {
                    setShowGameMenu(false);
                    exitToLobby();
                  }}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left text-xs font-bold text-red-400 hover:text-white hover:bg-red-600/80 transition-colors"
                >
                  <X className="w-4 h-4" />
                  Wyjdź z gry
                </button>
              </motion.div>
            )}
          </AnimatePresence>
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
      {/* Developer Debug Panel */}
      {isDevAuthorized && (
        <div className="fixed bottom-4 left-4 z-[9999] flex flex-col items-start gap-2">
          <button 
            onClick={() => setShowDevPanel(!showDevPanel)}
            className="bg-neutral-800 hover:bg-neutral-700 text-white p-2 rounded-full shadow-lg border border-white/10 transition-all active:scale-95 cursor-pointer"
            title="Developer Tools"
          >
            <Settings className={`w-5 h-5 ${showDevPanel ? 'rotate-90' : ''}`} />
          </button>

          <AnimatePresence>
            {showDevPanel && (
              <motion.div 
                initial={{ opacity: 0, y: 20, scale: 0.9 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 20, scale: 0.9 }}
                className="bg-neutral-900 border border-white/20 p-4 rounded-2xl shadow-2xl w-64 space-y-3 backdrop-blur-xl"
              >
                <div className="flex items-center justify-between border-b border-white/10 pb-2 mb-2">
                  <span className="text-[10px] font-black tracking-widest text-white/50 uppercase">DEV TOOLS</span>
                  <span className="text-[9px] font-mono text-white/30 uppercase">v{appVersion}</span>
                </div>

                <div className="space-y-2">
                  {/* Playing mode specific tools */}
                  {gameState === 'playing' && (
                    <>
                      <div className="flex flex-col gap-1">
                        <span className="text-[8px] font-bold text-white/40 uppercase">Master Word</span>
                        <div className="bg-black/50 px-2 py-1 rounded text-xs font-mono text-yellow-500 flex justify-between items-center group overflow-hidden">
                          <span className="whitespace-nowrap overflow-hidden text-ellipsis">{currentLevel.masterWord}</span>
                          <span className="text-[8px] text-white/20 group-hover:text-white/40 shrink-0 ml-2">{gameMode === 'teams' ? `RUNDA ${teamRound}` : `LEVEL ${levelIndex + 1}`}</span>
                        </div>
                      </div>

                      {gameMode !== 'teams' && (
                        <div className="flex flex-col gap-1">
                          <span className="text-[8px] font-bold text-white/40 uppercase">Jump to Level</span>
                          <div className="flex gap-2">
                            <input 
                              type="number" 
                              min="1"
                              placeholder="Lvl"
                              className="w-full bg-black/50 px-2 py-1 rounded text-xs font-mono text-white border border-white/10"
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  const val = parseInt((e.target as HTMLInputElement).value);
                                  if (!isNaN(val)) {
                                    const targetIdx = val - 1;
                                    setLevelIndex(targetIdx);
                                    setFoundWords([]);
                                    (e.target as HTMLInputElement).value = '';
                                    showFeedback(`Skoczono do poziomu ${val}!`, "success");
                                  }
                                }
                              }}
                            />
                          </div>
                        </div>
                      )}

                      <button 
                        onClick={() => {
                          const unplayed = possibleAnswers.filter(w => !foundWords.some(fw => fw.word === w));
                          if (unplayed.length === 0) {
                            showFeedback("Brak słów do rozwiązania!", "hazard");
                            return;
                          }
                          unplayed.forEach((word, idx) => {
                            setTimeout(() => {
                              processIncomingChatMessage(`Bot_${idx + 1}`, word, { color: '#22c55e' });
                            }, idx * 100);
                          });
                          showFeedback(`Rozwiązano ${unplayed.length} haseł!`, "success");
                        }}
                        className="w-full flex items-center justify-center gap-1.5 bg-green-600/20 hover:bg-green-600/30 text-green-400 py-1.5 rounded-xl text-[10px] font-bold uppercase transition-colors"
                      >
                        <Check className="w-3 h-3" /> Rozwiąż Cały Poziom
                      </button>

                      {/* Custom Word / Team Guess */}
                      <div className="flex flex-col gap-1 pt-1 border-t border-white/5">
                        <span className="text-[8px] font-bold text-white/40 uppercase">Wymuś odgadnięcie</span>
                        <input 
                          type="text"
                          placeholder="Wpisz własne słowo..."
                          value={devCustomGuessWord}
                          onChange={(e) => setDevCustomGuessWord(e.target.value.toUpperCase())}
                          className="w-full bg-black/50 px-2 py-1 rounded text-xs font-mono text-white border border-white/10 placeholder:text-white/20 uppercase"
                        />
                      </div>

                      {/* Team Specific Guesses */}
                      <div className="grid grid-cols-2 gap-1.5">
                        <button 
                          onClick={() => {
                            const custom = devCustomGuessWord.trim();
                            const unplayed = possibleAnswers.filter(w => !foundWords.some(fw => fw.word === w));
                            const targetWord = custom || (unplayed.length > 0 ? unplayed[0] : null);

                            if (!targetWord) {
                              showFeedback("Brak wolnych haseł w tej rundzie!", "hazard");
                              return;
                            }

                            let user = blueTeam[Math.floor(Math.random() * blueTeam.length)] || 'Niebieski_Bot';
                            if (!blueTeam.some(p => p.toLowerCase() === user.toLowerCase())) {
                              setBlueTeam(prev => [...prev, user]);
                            }
                            processIncomingChatMessage(user, targetWord, { color: '#3b82f6' });
                            if (custom) setDevCustomGuessWord("");
                          }}
                          className="flex items-center justify-center gap-1.5 bg-blue-600/30 hover:bg-blue-600/50 text-blue-300 border border-blue-500/40 py-2 rounded-xl text-[10px] font-black uppercase transition-all shadow-sm active:scale-95"
                        >
                          <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
                          🔵 Niebiescy
                        </button>
                        <button 
                          onClick={() => {
                            const custom = devCustomGuessWord.trim();
                            const unplayed = possibleAnswers.filter(w => !foundWords.some(fw => fw.word === w));
                            const targetWord = custom || (unplayed.length > 0 ? unplayed[0] : null);

                            if (!targetWord) {
                              showFeedback("Brak wolnych haseł w tej rundzie!", "hazard");
                              return;
                            }

                            let user = redTeam[Math.floor(Math.random() * redTeam.length)] || 'Czerwony_Bot';
                            if (!redTeam.some(p => p.toLowerCase() === user.toLowerCase())) {
                              setRedTeam(prev => [...prev, user]);
                            }
                            processIncomingChatMessage(user, targetWord, { color: '#ef4444' });
                            if (custom) setDevCustomGuessWord("");
                          }}
                          className="flex items-center justify-center gap-1.5 bg-red-600/30 hover:bg-red-600/50 text-red-300 border border-red-500/40 py-2 rounded-xl text-[10px] font-black uppercase transition-all shadow-sm active:scale-95"
                        >
                          <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />
                          🔴 Czerwoni
                        </button>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <button 
                          onClick={() => {
                            const custom = devCustomGuessWord.trim();
                            const unplayed = possibleAnswers.filter(w => !foundWords.some(fw => fw.word === w));
                            const targetWord = custom || (unplayed.length > 0 ? unplayed[0] : null);
                            if (!targetWord) {
                              showFeedback("Brak wolnych haseł!", "hazard");
                              return;
                            }
                            processIncomingChatMessage('DevTester', targetWord, { color: '#eab308' });
                            if (custom) setDevCustomGuessWord("");
                          }}
                          className="w-full flex items-center justify-center gap-1.5 bg-yellow-600/20 hover:bg-yellow-600/30 text-yellow-400 py-1.5 rounded-xl text-[10px] font-bold uppercase transition-colors"
                        >
                          <Sparkles className="w-3 h-3" /> Solo Guess
                        </button>

                        {gameMode === 'teams' && (
                          <button 
                            onClick={() => {
                              setRopePosition(50);
                              setCurrentTeamStreak({ team: null, count: 0 });
                              showFeedback("Lina wyzerowana do 50%!", "success");
                            }}
                            className="w-full flex items-center justify-center gap-1.5 bg-white/10 hover:bg-white/20 text-white/80 py-1.5 rounded-xl text-[10px] font-bold uppercase transition-colors"
                          >
                            ⚖️ Lina 50%
                          </button>
                        )}
                      </div>
                    </>
                  )}

                  {/* Lobby specific dev buttons */}
                  {gameMode === 'teams' && gameState === 'lobby' && (
                    <button 
                      onClick={addTestPlayer}
                      className="w-full flex items-center justify-center gap-1.5 bg-cyan-600/20 hover:bg-cyan-600/30 text-cyan-400 py-1.5 rounded-xl text-[10px] font-bold uppercase transition-colors"
                    >
                      <UserPlus className="w-3 h-3" /> + Dodaj Gracza Testowego
                    </button>
                  )}

                  {/* Team specific dev controls when playing */}
                  {gameMode === 'teams' && gameState === 'playing' && (
                    <div className="pt-1 border-t border-white/5 space-y-1.5">
                      <div className="flex justify-between items-center text-[8px] font-mono text-white/40">
                        <span>Runda: {teamRound}</span>
                        <span>Lina: {ropePosition.toFixed(1)}%</span>
                      </div>
                      <div className="grid grid-cols-2 gap-1.5">
                        <button 
                          onClick={() => {
                            setRopePosition(94);
                            showFeedback("Ustawiono 94% (blisko K.O. Niebieskich)!", "success");
                          }}
                          className="bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 py-1 rounded text-[9px] font-bold transition-colors"
                        >
                          ⚡ Ustaw 94%
                        </button>
                        <button 
                          onClick={() => {
                            setRopePosition(6);
                            showFeedback("Ustawiono 6% (blisko K.O. Czerwonych)!", "success");
                          }}
                          className="bg-red-500/20 hover:bg-red-500/30 text-red-300 py-1 rounded text-[9px] font-bold transition-colors"
                        >
                          ⚡ Ustaw 6%
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-1.5">
                        <button 
                          onClick={() => {
                            setRopePosition(100);
                            setTeamMatchWinner('blue');
                            setTeamWinReason('ko');
                            processRoundResults(true);
                            showFeedback("🏆 Symulacja: Wygrana Niebieskich (K.O.) + MVP!", "success");
                          }}
                          className="bg-blue-600/30 hover:bg-blue-600/50 text-blue-300 py-1 rounded text-[9px] font-bold transition-colors"
                        >
                          🏆 Win Niebiescy (+MVP)
                        </button>
                        <button 
                          onClick={() => {
                            setRopePosition(0);
                            setTeamMatchWinner('red');
                            setTeamWinReason('ko');
                            processRoundResults(true);
                            showFeedback("🏆 Symulacja: Wygrana Czerwonych (K.O.) + MVP!", "success");
                          }}
                          className="bg-red-600/30 hover:bg-red-600/50 text-red-300 py-1 rounded text-[9px] font-bold transition-colors"
                        >
                          🏆 Win Czerwoni (+MVP)
                        </button>
                      </div>
                    </div>
                  )}

                  <button 
                    onClick={() => {
                      clearStats();
                      exitToLobby();
                      window.location.reload();
                    }}
                    className="w-full flex items-center justify-center gap-1.5 bg-red-600/20 hover:bg-red-600/30 text-accent-red py-2 rounded-xl text-[10px] font-bold uppercase transition-colors"
                  >
                    <RefreshCw className="w-3 h-3" /> Hard Reset
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </>
  );

  // --- LOBBY SCREEN ---
  if (gameState === 'lobby') {
    return (
      <div className="min-h-screen bg-bg-main text-text-primary font-sans flex flex-col items-center p-6 pt-12 pb-16 relative overflow-y-auto custom-scrollbar">
        {/* Animated background accents */}
        <div className="absolute top-1/4 left-1/4 w-64 h-64 bg-accent-red/5 rounded-full blur-3xl animate-pulse" />
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-purple-500/5 rounded-full blur-3xl animate-pulse delay-700" />
        {gameMode === 'teams' && (
          <>
            <div className="absolute top-1/3 left-10 w-80 h-80 bg-blue-600/10 rounded-full blur-3xl pointer-events-none" />
            <div className="absolute top-1/3 right-10 w-80 h-80 bg-red-600/10 rounded-full blur-3xl pointer-events-none" />
          </>
        )}
        
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
          className={`z-10 flex flex-col items-center w-full text-center transition-all duration-300 ${gameMode === 'teams' ? 'max-w-4xl' : 'max-w-md'}`}
        >
          {/* Logo Section */}
          <div className="mb-2 relative group">
            <motion.img 
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              src={logoImg} 
              alt="Logo" 
              className="w-48 h-48 md:w-56 md:h-56 object-contain drop-shadow-[0_0_25px_rgba(230,57,70,0.4)] transition-all duration-500 group-hover:scale-105"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
          </div>

          <h1 className="text-4xl font-black tracking-tighter mb-1 italic">
            TWITCH<span className="text-accent-red">SŁÓWKA</span>
          </h1>
          <p className="text-text-secondary font-medium tracking-widest text-[10px] uppercase mb-6 opacity-60">
            INTERAKTYWNA WYKREŚLANKA DLA TWOJEGO CZATU
          </p>

          {/* Mode Selector Tabs */}
          <div className="w-full grid grid-cols-2 gap-2 p-1.5 bg-black/50 border border-white/10 rounded-2xl mb-6 shadow-2xl backdrop-blur-md">
            <button
              onClick={() => {
                setGameMode('solo');
                localStorage.setItem('gameMode', 'solo');
              }}
              className={`py-3.5 px-4 rounded-xl font-black text-xs tracking-wider uppercase transition-all flex items-center justify-center gap-2.5 ${
                gameMode === 'solo'
                  ? 'bg-accent-red text-white shadow-[0_0_20px_rgba(230,57,70,0.5)] scale-[1.02]'
                  : 'text-text-secondary hover:text-white hover:bg-white/5'
              }`}
            >
              <Trophy className="w-4 h-4" />
              KLASYCZNY (FFA)
            </button>
            <button
              onClick={() => {
                setGameMode('teams');
                localStorage.setItem('gameMode', 'teams');
              }}
              className={`py-3.5 px-4 rounded-xl font-black text-xs tracking-wider uppercase transition-all flex items-center justify-center gap-2.5 ${
                gameMode === 'teams'
                  ? 'bg-gradient-to-r from-blue-600 via-purple-600 to-red-600 text-white shadow-[0_0_25px_rgba(59,130,246,0.5)] scale-[1.02]'
                  : 'text-text-secondary hover:text-white hover:bg-white/5'
              }`}
            >
              <Swords className="w-4 h-4 text-yellow-300" />
              DRUŻYNÓWKA (PRZECIĄGANIE LINY)
            </button>
          </div>

          {/* Twitch Connection Card (Shared) */}
          <div className="w-full bg-bg-card border border-border-color rounded-2xl p-6 shadow-2xl mb-6 text-left">
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
                className="bg-purple-600 hover:bg-purple-700 text-white font-black px-5 rounded-xl text-[11px] tracking-widest uppercase transition-all shadow-lg active:scale-95"
              >
                POŁĄCZ
              </button>
            </div>

            <div className="flex items-center justify-between p-3 rounded-xl bg-bg-main border border-border-color mt-3">
              <span className="text-[10px] font-black tracking-widest text-text-secondary uppercase">STATUS BOT'A:</span>
              <span className={`text-[10px] font-black tracking-widest uppercase flex items-center gap-1.5 ${isConnected ? 'text-green-500' : 'text-accent-red'}`}>
                <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
                {status}
              </span>
            </div>
          </div>

          {/* SOLO MODE CONTENT */}
          {gameMode === 'solo' && (
            <div className="w-full bg-bg-card border border-border-color rounded-2xl p-6 shadow-2xl">
              <div className="flex flex-col gap-4">
                <div className="grid grid-cols-2 gap-3">
                  <button
                    disabled={!isConnected}
                    onClick={startGame}
                    className={`w-full py-4 rounded-xl font-black text-xs tracking-[0.2em] uppercase transition-all shadow-xl active:scale-95
                      ${isConnected 
                        ? 'bg-accent-red hover:bg-red-700 text-white shadow-[0_0_20px_rgba(230,57,70,0.4)]' 
                        : 'bg-neutral-800 text-neutral-600 cursor-not-allowed opacity-50'
                      }
                    `}
                  >
                    START GRY
                  </button>
                  <button
                    onClick={() => setGameState('stats')}
                    className="w-full py-4 rounded-xl font-black text-xs tracking-[0.2em] uppercase transition-all shadow-xl active:scale-95 bg-neutral-800 text-white hover:bg-neutral-700 border border-neutral-700"
                  >
                    STATYSTYKI
                  </button>
                </div>
                
                <button
                  onClick={() => {
                    setHelpTab('solo');
                    setShowHelp(true);
                  }}
                  className="w-full mt-2 py-3 rounded-xl font-black text-[10px] tracking-[0.3em] uppercase transition-all bg-white/5 text-text-secondary hover:bg-white/10 border border-white/5 flex items-center justify-center gap-2 group cursor-pointer"
                >
                  <Info className="w-3.5 h-3.5 group-hover:text-cyan-400 transition-colors" />
                  INSTRUKCJA GRY
                </button>

                <button
                  onClick={() => setShowChangelog(true)}
                  className="w-full py-3 rounded-xl font-black text-[10px] tracking-[0.3em] uppercase transition-all bg-white/5 text-text-secondary hover:bg-white/10 border border-white/5 flex items-center justify-center gap-2 group"
                >
                  <Sparkles className="w-3.5 h-3.5 group-hover:text-yellow-400 transition-colors" />
                  CO NOWEGO (PATCH NOTES)
                </button>
              </div>
            </div>
          )}

          {/* TEAM MODE CONTENT (DRUŻYNÓWKA) */}
          {gameMode === 'teams' && (
            <div className="w-full flex flex-col gap-6">
              {/* Call to action & Recruitment Instructions */}
              <div className="w-full bg-gradient-to-r from-blue-950/40 via-purple-950/30 to-red-950/40 border border-white/10 rounded-2xl p-6 shadow-2xl backdrop-blur-md relative overflow-hidden text-center">
                <div className="flex flex-col items-center">
                  <div className="flex items-center gap-3 mb-2">
                    <span className="p-2 bg-blue-500/20 text-blue-400 rounded-xl border border-blue-500/30">
                      <ShieldCheck className="w-5 h-5" />
                    </span>
                    <span className="font-black italic text-xl md:text-2xl tracking-tighter text-white uppercase">
                      POCZEKALNIA DO WALKI DRUŻYNOWEJ
                    </span>
                    <span className="p-2 bg-red-500/20 text-red-400 rounded-xl border border-red-500/30">
                      <Flame className="w-5 h-5" />
                    </span>
                  </div>
                  <p className="text-yellow-400 font-black tracking-widest text-xs uppercase mb-1">
                    WPISZ NA CZACIE: <span className="bg-yellow-400/20 px-2 py-0.5 rounded text-white border border-yellow-400/40">!join</span> LUB <span className="bg-yellow-400/20 px-2 py-0.5 rounded text-white border border-yellow-400/40">!dolacz</span>
                  </p>
                  <p className="text-white/40 text-[10px] font-bold uppercase tracking-wider">
                    Aby zrezygnować wpisz <span className="text-white/70">!leave</span>. Po starcie meczu zapisy zostają zablokowane!
                  </p>
                </div>

                {/* Streamer Quick Management Toolbar */}
                <div className="flex flex-wrap items-center justify-between gap-3 mt-5 pt-4 border-t border-white/10">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-black uppercase tracking-wider text-white/70">
                      ZAPISANYCH:
                    </span>
                    <span className={`px-2.5 py-0.5 rounded-full text-xs font-mono font-black border ${
                      teamLobbyPlayers.length >= 2 
                        ? 'bg-green-500/20 text-green-400 border-green-500/30' 
                        : 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
                    }`}>
                      {teamLobbyPlayers.length} GRACZY
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    {isDevAuthorized && (
                      <button
                        onClick={addTestPlayer}
                        className="px-3 py-1.5 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 rounded-xl text-[10px] font-black text-cyan-400 hover:text-cyan-300 transition-all flex items-center gap-1.5 active:scale-95 shadow-[0_0_10px_rgba(6,182,212,0.15)]"
                        title="Opcja deweloperska: dodaje gracza testowego do poczekalni"
                      >
                        <UserPlus className="w-3.5 h-3.5" />
                        + DODAJ GRACZA TESTOWEGO
                      </button>
                    )}
                    {teamLobbyPlayers.length > 0 && (
                      <button
                        onClick={() => {
                          setTeamLobbyPlayers([]);
                          setBlueTeam([]);
                          setRedTeam([]);
                        }}
                        className="px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 rounded-xl text-[10px] font-black text-red-400 hover:text-red-300 transition-all active:scale-95"
                      >
                        WYCZYŚĆ
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Waiting Pool or Divided Teams View */}
              {blueTeam.length === 0 && redTeam.length === 0 ? (
                /* WAITING POOL (Not yet shuffled) */
                <div className="w-full bg-bg-card border border-border-color rounded-2xl p-6 shadow-2xl flex flex-col items-center">
                  <span className="text-[10px] font-black tracking-widest text-text-secondary uppercase mb-4">
                    LISTA GRACZY W POCZEKALNI:
                  </span>

                  {teamLobbyPlayers.length === 0 ? (
                    <div className="py-12 flex flex-col items-center justify-center text-center text-white/30 space-y-2">
                      <Users className="w-10 h-10 stroke-1" />
                      <p className="text-xs font-bold uppercase tracking-wider">
                        Czekam na graczy z czatu...
                      </p>
                      <p className="text-[10px] text-white/20">
                        {isDevAuthorized 
                          ? "Wpisz !join na czacie lub kliknij przycisk „+ Dodaj gracza testowego” powyżej." 
                          : "Wpisz !join na czacie Twitch, aby dołączyć do gry drużynowej."}
                      </p>
                    </div>
                  ) : (
                    <div className="flex flex-wrap justify-center gap-2 mb-6 max-h-48 overflow-y-auto p-2 w-full custom-scrollbar">
                      {teamLobbyPlayers.map((player) => (
                        <div 
                          key={player}
                          className="px-3 py-1.5 bg-white/5 border border-white/10 rounded-xl flex items-center gap-2 group hover:border-white/20"
                        >
                          <span className="w-2 h-2 rounded-full bg-green-400 shadow-[0_0_6px_#4ade80]" />
                          <span className="text-xs font-bold text-white">{player}</span>
                          <button 
                            onClick={() => removePlayerFromLobby(player)}
                            className="opacity-40 group-hover:opacity-100 hover:text-red-400 transition-opacity ml-1"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <button
                    disabled={teamLobbyPlayers.length < 2}
                    onClick={shuffleTeams}
                    className={`w-full py-4 rounded-xl font-black text-xs tracking-[0.2em] uppercase transition-all shadow-xl active:scale-95 flex items-center justify-center gap-2
                      ${teamLobbyPlayers.length >= 2 
                        ? 'bg-gradient-to-r from-blue-600 via-purple-600 to-red-600 hover:from-blue-500 hover:to-red-500 text-white shadow-[0_0_20px_rgba(147,51,234,0.4)]' 
                        : 'bg-neutral-800 text-neutral-600 cursor-not-allowed opacity-50'
                      }
                    `}
                  >
                    <Shuffle className="w-4 h-4" />
                    ROZLOSUJ DRUŻYNY (50 / 50)
                  </button>
                  {teamLobbyPlayers.length < 2 && (
                    <span className="text-[9px] font-bold text-yellow-500/80 uppercase tracking-widest mt-2">
                      Wymagane minimum 2 osoby w poczekalni, aby rozlosować składy.
                    </span>
                  )}

                  <button
                    onClick={() => {
                      setHelpTab('teams');
                      setShowHelp(true);
                    }}
                    className="w-full mt-3 py-3 rounded-xl font-black text-[10px] tracking-[0.25em] uppercase transition-all bg-white/5 text-text-secondary hover:bg-white/10 hover:text-white border border-white/5 flex items-center justify-center gap-2 group cursor-pointer"
                  >
                    <Info className="w-3.5 h-3.5 text-blue-400 group-hover:text-cyan-300 transition-colors" />
                    <span>ZASADY & INSTRUKCJA GRY DRUŻYNOWEJ</span>
                  </button>
                </div>
              ) : (
                /* TEAMS DIVIDED VIEW (Roster cards) */
                <div className="w-full flex flex-col gap-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Blue Team Column */}
                    <div className="bg-blue-950/20 border-2 border-blue-500/40 rounded-2xl p-5 shadow-2xl flex flex-col backdrop-blur-md">
                      <div className="flex items-center justify-between pb-3 mb-3 border-b border-blue-500/30">
                        <div className="flex items-center gap-2">
                          <div className="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center text-white shadow-[0_0_10px_rgba(59,130,246,0.5)]">
                            <ShieldCheck className="w-4 h-4" />
                          </div>
                          <span className="font-black text-blue-400 tracking-wider text-sm uppercase">
                            DRUŻYNA NIEBIESKA
                          </span>
                        </div>
                        <span className="text-xs font-mono font-black text-blue-300 bg-blue-500/20 px-2 py-0.5 rounded-full border border-blue-500/30">
                          {blueTeam.length} GRACZY
                        </span>
                      </div>

                      <div className="space-y-1.5 min-h-[160px] max-h-[260px] overflow-y-auto custom-scrollbar pr-1">
                        {blueTeam.map((player) => (
                          <div 
                            key={player}
                            className="flex items-center justify-between bg-blue-900/30 hover:bg-blue-900/50 border border-blue-500/20 px-3 py-2 rounded-xl transition-colors group"
                          >
                            <span className="text-xs font-bold text-white truncate max-w-[150px]">{player}</span>
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => movePlayerToTeam(player, 'red')}
                                title="Przenieś do Czerwonych"
                                className="px-2 py-1 bg-white/5 hover:bg-red-600/40 text-blue-300 hover:text-white rounded-lg text-[9px] font-black uppercase transition-all flex items-center gap-1"
                              >
                                <span>Do Czerwonych</span>
                                <ArrowRight className="w-3 h-3" />
                              </button>
                              <button
                                onClick={() => removePlayerFromLobby(player)}
                                title="Usuń"
                                className="p-1 text-white/40 hover:text-red-400 transition-colors"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Red Team Column */}
                    <div className="bg-red-950/20 border-2 border-red-500/40 rounded-2xl p-5 shadow-2xl flex flex-col backdrop-blur-md">
                      <div className="flex items-center justify-between pb-3 mb-3 border-b border-red-500/30">
                        <div className="flex items-center gap-2">
                          <div className="w-7 h-7 rounded-lg bg-red-600 flex items-center justify-center text-white shadow-[0_0_10px_rgba(239,68,68,0.5)]">
                            <Flame className="w-4 h-4" />
                          </div>
                          <span className="font-black text-red-400 tracking-wider text-sm uppercase">
                            DRUŻYNA CZERWONA
                          </span>
                        </div>
                        <span className="text-xs font-mono font-black text-red-300 bg-red-500/20 px-2 py-0.5 rounded-full border border-red-500/30">
                          {redTeam.length} GRACZY
                        </span>
                      </div>

                      <div className="space-y-1.5 min-h-[160px] max-h-[260px] overflow-y-auto custom-scrollbar pr-1">
                        {redTeam.map((player) => (
                          <div 
                            key={player}
                            className="flex items-center justify-between bg-red-900/30 hover:bg-red-900/50 border border-red-500/20 px-3 py-2 rounded-xl transition-colors group"
                          >
                            <span className="text-xs font-bold text-white truncate max-w-[150px]">{player}</span>
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => movePlayerToTeam(player, 'blue')}
                                title="Przenieś do Niebieskich"
                                className="px-2 py-1 bg-white/5 hover:bg-blue-600/40 text-red-300 hover:text-white rounded-lg text-[9px] font-black uppercase transition-all flex items-center gap-1"
                              >
                                <ArrowLeft className="w-3 h-3" />
                                <span>Do Niebieskich</span>
                              </button>
                              <button
                                onClick={() => removePlayerFromLobby(player)}
                                title="Usuń"
                                className="p-1 text-white/40 hover:text-red-400 transition-colors"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Actions Row */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <button
                      onClick={shuffleTeams}
                      className="py-3 px-4 bg-white/5 hover:bg-white/10 text-white rounded-xl text-xs font-black uppercase tracking-wider transition-all border border-white/10 flex items-center justify-center gap-2"
                    >
                      <Shuffle className="w-4 h-4 text-yellow-400" />
                      PRZETASUJ PONOWNIE
                    </button>
                    <button
                      disabled={!isConnected || blueTeam.length === 0 || redTeam.length === 0}
                      onClick={startTeamGame}
                      title={!isConnected ? "Najpierw połącz bota z kontem Twitch" : undefined}
                      className={`md:col-span-2 py-4 rounded-xl font-black text-sm tracking-[0.2em] uppercase transition-all shadow-2xl active:scale-95 flex items-center justify-center gap-2
                        ${isConnected && blueTeam.length > 0 && redTeam.length > 0
                          ? 'bg-gradient-to-r from-blue-600 via-purple-600 to-red-600 hover:from-blue-500 hover:to-red-500 text-white shadow-[0_0_25px_rgba(230,57,70,0.5)]'
                          : 'bg-neutral-800 text-neutral-600 cursor-not-allowed opacity-50'
                        }
                      `}
                    >
                      <Swords className="w-5 h-5 text-yellow-300" />
                      {!isConnected ? "POŁĄCZ BOTA Z TWITCH, ABY GRAĆ" : "START MECZU DRUŻYNOWEGO"}
                    </button>
                  </div>
                </div>
              )}

              {/* Team Mode Bottom Navigation Bar */}
              <div className="w-full grid grid-cols-1 sm:grid-cols-3 gap-3 mt-2">
                <button
                  onClick={() => {
                    setHelpTab('teams');
                    setShowHelp(true);
                  }}
                  className="w-full py-4 px-4 rounded-xl font-black text-xs tracking-wider uppercase transition-all bg-gradient-to-r from-blue-600/20 via-purple-600/20 to-red-600/20 hover:from-blue-600/35 hover:to-red-600/35 border border-purple-500/40 text-white flex items-center justify-center gap-2 group shadow-xl active:scale-95 cursor-pointer"
                >
                  <Swords className="w-4 h-4 text-yellow-300 group-hover:scale-110 transition-transform" />
                  <span>INSTRUKCJA GRY DRUŻYNOWEJ</span>
                </button>
                <button
                  onClick={() => setGameState('stats')}
                  className="w-full py-4 px-4 rounded-xl font-black text-xs tracking-wider uppercase transition-all bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-white flex items-center justify-center gap-2 shadow-xl active:scale-95 cursor-pointer"
                >
                  <Trophy className="w-4 h-4 text-accent-red" />
                  <span>STATYSTYKI</span>
                </button>
                <button
                  onClick={() => setShowChangelog(true)}
                  className="w-full py-4 px-4 rounded-xl font-black text-xs tracking-wider uppercase transition-all bg-white/5 hover:bg-white/10 border border-white/10 text-text-secondary hover:text-white flex items-center justify-center gap-2 shadow-xl active:scale-95 cursor-pointer"
                >
                  <Sparkles className="w-4 h-4 text-yellow-400" />
                  <span>CO NOWEGO (PATCH NOTES)</span>
                </button>
              </div>
            </div>
          )}

          <div className="mt-8 flex justify-center">
            <span className="text-[9px] font-black tracking-widest text-neutral-600 uppercase">WERSJA: {appVersion}</span>
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
    const sortedByTeamMvp = (Object.entries(globalStats) as [string, UserStats][]).sort((a, b) => (b[1].teamMvp || 0) - (a[1].teamMvp || 0));
    const globalMaxLevel = Math.max(...(Object.values(globalStats) as UserStats[]).map(s => s.maxLevelReached || 0), 0);

    const handleReset = () => {
      setGlobalStats({});
      clearStats();
      setShowResetConfirm(false);
      showFeedback("Statystyki zostały zresetowane", "success");
    };

    return (
      <div className="min-h-screen bg-bg-main text-text-primary font-sans flex flex-col items-center p-6 pt-16 pb-16 relative overflow-y-auto custom-scrollbar">
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
          <div className="flex bg-bg-card border border-border-color p-1.5 rounded-2xl overflow-x-auto custom-scrollbar shadow-xl gap-1">
            {[
              { id: 'world', icon: Globe, label: 'REKORD', desc: 'Najwyższy poziom osiągnięty przez społeczność (Tylko tryb klasyczny)' },
              { id: 'points', icon: Trophy, label: 'PUNKTY', desc: 'Suma wszystkich odgadniętych liter' },
              { id: 'rounds', icon: CheckCircle2, label: 'RUNDY', desc: 'Liczba rund zakończonych na 1. miejscu' },
              { id: 'games', icon: Trophy, label: 'SESJE', desc: 'Liczba wygranych całych sesji gry' },
              { id: 'masters', icon: Crown, label: 'MISTRZ', desc: 'Pierwsze odkrycia głównego hasła poziomu' },
              { id: 'streaks', icon: Flame, label: 'SERIE', desc: 'Najdłuższa seria wygranych rund z rzędu' },
              { id: 'shields', icon: ShieldCheck, label: 'TARCZE', desc: 'Łączna liczba zebranych tarcz ochronnych' },
              { id: 'teamMvp', icon: Swords, label: 'MVP DRUŻYNY', desc: 'Tytuły MVP drużyny przyznawane najlepszym graczom Niebieskich i Czerwonych po zakończeniu meczu' }
            ].map((tab) => {
              const Icon = tab.icon;
              const isActive = statsTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setStatsTab(tab.id as any)}
                  className={`flex-1 min-w-[95px] flex flex-col items-center py-4 gap-1.5 rounded-xl transition-all relative group/tab cursor-pointer ${
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
                      <span className="text-[10px] font-black tracking-[0.5em] text-accent-red uppercase">NAJDALSZA OSIĄGNIĘTA RUNDA (TRYB KLASYCZNY)</span>
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

                    <div className="bg-neutral-900/50 border border-white/5 px-10 py-4 rounded-2xl backdrop-blur-sm flex flex-col items-center gap-1">
                      <span className="text-sm font-black italic tracking-[0.2em] text-text-secondary uppercase">REKORD ŚWIATA • TYLKO TRYB KLASYCZNY</span>
                      <span className="text-[9px] font-bold tracking-widest text-white/30 uppercase">*Rundy z trybu drużynowego nie są wliczane do tego rekordu</span>
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
                        {statsTab === 'teamMvp' && 'RANKING MVP DRUŻYNY'}
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
                      {statsTab === 'teamMvp' && 'Tytuły MVP drużyny przyznawane najlepszym graczom Niebieskich oraz Czerwonych po zakończeniu każdej gry.'}
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
                        else if (statsTab === 'teamMvp') { 
                          data = sortedByTeamMvp.filter(([_, item]) => (item.teamMvp || 0) > 0); 
                          colorClass = "text-amber-400"; 
                          valKey = "teamMvp"; 
                        }

                        if (data.length === 0) return (
                          <div className="py-24 text-center opacity-20 text-sm font-black uppercase tracking-widest">
                            {statsTab === 'teamMvp' ? 'BRAK DANYCH (ZAGRAJ I WYGRAJ MECZ DRUŻYNOWY)' : 'BRAK DANYCH'}
                          </div>
                        );

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
                                <div className="flex flex-col">
                                  <span className={`font-bold text-lg transition-all ${idx < 3 ? 'text-white' : 'text-text-secondary'}`}>{item.displayName || key}</span>
                                  {statsTab === 'teamMvp' && ((item.blueTeamMvp || 0) > 0 || (item.redTeamMvp || 0) > 0) && (
                                    <div className="flex items-center gap-2 mt-0.5">
                                      <span className="text-[10px] font-mono font-bold text-blue-400">
                                        Niebiescy: {item.blueTeamMvp || 0}
                                      </span>
                                      <span className="text-white/20">•</span>
                                      <span className="text-[10px] font-mono font-bold text-red-400">
                                        Czerwoni: {item.redTeamMvp || 0}
                                      </span>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                            <div className="flex flex-col items-end">
                              <span className={`font-black font-mono text-4xl ${colorClass}`}>
                                {(item[valKey] as number) || 0}
                              </span>
                              <span className="text-[8px] font-black text-text-secondary/30 uppercase tracking-widest">
                                {statsTab === 'points' && 'PKT'}
                                {statsTab === 'rounds' && 'RUND'}
                                {statsTab === 'games' && 'WYGRANYCH'}
                                {statsTab === 'masters' && 'MISTRZOSTW'}
                                {statsTab === 'streaks' && 'SERIA'}
                                {statsTab === 'shields' && 'TARCZ'}
                                {statsTab === 'teamMvp' && 'TYTUŁÓW MVP'}
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
    // TEAM MODE SUMMARY VIEW
    if (gameMode === 'teams') {
      const allStats = Object.values(teamPlayerStats) as TeamMemberStat[];
      const blueStats = allStats.filter(p => p.team === 'blue');
      const redStats = allStats.filter(p => p.team === 'red');

      const sortedBlue = [...blueStats].sort((a, b) => b.points - a.points || b.wordsFound - a.wordsFound);
      const sortedRed = [...redStats].sort((a, b) => b.points - a.points || b.wordsFound - a.wordsFound);

      const blueMvp: TeamMemberStat | null = sortedBlue[0] || (blueTeam[0] ? { username: blueTeam[0], points: 0, wordsFound: 0, team: 'blue' as const } : null);
      const redMvp: TeamMemberStat | null = sortedRed[0] || (redTeam[0] ? { username: redTeam[0], points: 0, wordsFound: 0, team: 'red' as const } : null);

      const isMatchWon = teamMatchWinner === 'blue' || teamMatchWinner === 'red';
      const winner = teamMatchWinner;


      // Helper to identify player's team
      const getPlayerTeam = (username: string): 'blue' | 'red' | 'spectator' => {
        const u = username.toLowerCase();
        if (blueTeam.some(p => p.toLowerCase() === u)) return 'blue';
        if (redTeam.some(p => p.toLowerCase() === u)) return 'red';
        return 'spectator';
      };

      // 1. ROUND POINTS BREAKDOWN (WYNIK RUNDY)
      const roundContributors = foundWords.reduce((acc, fw) => {
        acc[fw.user] = (acc[fw.user] || 0) + (fw.points || fw.word.length);
        return acc;
      }, {} as Record<string, number>);

      const sortedRoundContributors = (Object.entries(roundContributors) as [string, number][])
        .sort((a, b) => b[1] - a[1]);

      const roundBluePoints = foundWords
        .filter(fw => getPlayerTeam(fw.user) === 'blue')
        .reduce((acc, fw) => acc + (fw.points || fw.word.length), 0);
      const roundRedPoints = foundWords
        .filter(fw => getPlayerTeam(fw.user) === 'red')
        .reduce((acc, fw) => acc + (fw.points || fw.word.length), 0);

      // 2. OVERALL SESSION / MATCH BREAKDOWN (KLASYFIKACJA SESJI)
      const allSessionPlayers = Array.from(new Set([
        ...blueTeam,
        ...redTeam,
        ...Object.keys(sessionScores)
      ])).map(name => {
        const stat = teamPlayerStats[name.toLowerCase()];
        const pts = sessionScores[name] ?? (stat?.points || 0);
        const words = stat?.wordsFound || 0;
        const team = stat?.team || getPlayerTeam(name);
        return { username: name, points: pts, wordsFound: words, team };
      }).filter(p => p.points > 0 || blueTeam.includes(p.username) || redTeam.includes(p.username))
        .sort((a, b) => b.points - a.points || b.wordsFound - a.wordsFound);

      return (
        <div className="min-h-screen bg-bg-main text-text-primary font-sans flex flex-col items-center p-4 pt-12 pb-16 relative overflow-y-auto custom-scrollbar">
          {/* Ambient lighting */}
          {isMatchWon ? (
            winner === 'blue' ? (
              <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[300px] bg-blue-600/20 rounded-full blur-3xl pointer-events-none" />
            ) : (
              <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[300px] bg-red-600/20 rounded-full blur-3xl pointer-events-none" />
            )
          ) : (
            <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[700px] h-[350px] bg-gradient-to-r from-blue-600/10 via-purple-600/10 to-red-600/10 rounded-full blur-3xl pointer-events-none" />
          )}

          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="max-w-5xl w-full flex flex-col items-center z-10"
          >
            {/* Header: KO Match Victory vs Ongoing Round Transition */}
            <div className="flex flex-col items-center text-center mb-6">
              {isMatchWon ? (
                winner === 'blue' ? (
                  <>
                    <div className="w-20 h-20 rounded-2xl bg-blue-600/20 border-2 border-blue-500/50 flex items-center justify-center text-blue-400 mb-3 shadow-[0_0_30px_rgba(59,130,246,0.5)]">
                      <Trophy className="w-10 h-10 text-blue-400 drop-shadow" />
                    </div>
                    <h2 className="text-4xl md:text-5xl font-black italic tracking-tighter text-blue-400 uppercase drop-shadow-[0_0_20px_rgba(59,130,246,0.6)]">
                      ZWYCIĘSTWO DRUŻYNY NIEBIESKIEJ!
                    </h2>
                    <p className="text-blue-300 font-bold tracking-widest text-xs uppercase mt-1">
                      ⚡ WYGRANA PRZEZ K.O. – 100 PKT ZDOBYTE W RUNDZIE {teamRound}!
                    </p>
                  </>
                ) : (
                  <>
                    <div className="w-20 h-20 rounded-2xl bg-red-600/20 border-2 border-red-500/50 flex items-center justify-center text-red-400 mb-3 shadow-[0_0_30px_rgba(239,68,68,0.5)]">
                      <Trophy className="w-10 h-10 text-red-400 drop-shadow" />
                    </div>
                    <h2 className="text-4xl md:text-5xl font-black italic tracking-tighter text-red-400 uppercase drop-shadow-[0_0_20px_rgba(239,68,68,0.6)]">
                      ZWYCIĘSTWO DRUŻYNY CZERWONEJ!
                    </h2>
                    <p className="text-red-300 font-bold tracking-widest text-xs uppercase mt-1">
                      ⚡ WYGRANA PRZEZ K.O. – 100 PKT ZDOBYTE W RUNDZIE {teamRound}!
                    </p>
                  </>
                )
              ) : (
                <>
                  <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-blue-600/20 via-purple-600/20 to-red-600/20 border-2 border-yellow-500/50 flex items-center justify-center text-yellow-400 mb-3 shadow-[0_0_30px_rgba(234,179,8,0.4)]">
                    <Swords className="w-10 h-10 text-yellow-400 drop-shadow" />
                  </div>
                  <h2 className="text-3xl md:text-5xl font-black italic tracking-tighter text-white uppercase drop-shadow-[0_0_25px_rgba(255,255,255,0.4)]">
                    KONIEC RUNDY {teamRound} — WALKA TRWA DALEJ!
                  </h2>
                  <p className="text-yellow-400 font-black tracking-widest text-xs uppercase mt-1 flex items-center gap-2">
                    <Sparkles className="w-3.5 h-3.5 text-yellow-300" />
                    ŻADNA Z DRUŻYN NIE OSIĄGNĘŁA 100 PKT (BRAK K.O.). PUNKTY I POZYCJA LINY ZOSTAJĄ ZACHOWANE NA RUNDĘ {teamRound + 1}!
                    <Sparkles className="w-3.5 h-3.5 text-yellow-300" />
                  </p>
                </>
              )}
            </div>

            {/* Rope Gauge Status with Carry-Over Banner */}
            <div className="w-full bg-bg-card border border-white/10 rounded-2xl p-4 shadow-xl mb-6 flex flex-col gap-2 relative overflow-hidden">
              <div className="flex justify-between items-center text-xs font-black uppercase">
                <span className="text-blue-400 font-mono">NIEBIESCY: {ropePosition.toFixed(1)} PKT ({ropePosition.toFixed(1)}%)</span>
                <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider ${
                  isMatchWon 
                    ? 'bg-yellow-500/20 text-yellow-300 border border-yellow-500/30' 
                    : 'bg-green-500/20 text-green-300 border border-green-500/40 animate-pulse'
                }`}>
                  {isMatchWon ? 'STAN KOŃCOWY (K.O.)' : `🔒 PUNKTY I LINA ZACHOWANE NA RUNDĘ ${teamRound + 1}`}
                </span>
                <span className="text-red-400 font-mono">CZERWONI: {(100 - ropePosition).toFixed(1)} PKT ({(100 - ropePosition).toFixed(1)}%)</span>
              </div>

              <div className="relative w-full h-6 bg-neutral-950 rounded-xl overflow-hidden border border-white/10">
                <div 
                  className="absolute left-0 top-0 bottom-0 bg-gradient-to-r from-blue-700 to-cyan-400 shadow-[0_0_15px_rgba(59,130,246,0.5)]"
                  style={{ width: `${ropePosition}%` }}
                />
                <div 
                  className="absolute right-0 top-0 bottom-0 bg-gradient-to-l from-red-700 to-orange-400 shadow-[0_0_15px_rgba(239,68,68,0.5)]"
                  style={{ width: `${100 - ropePosition}%` }}
                />
                <div className="absolute left-1/2 -translate-x-1/2 top-0 bottom-0 w-0.5 bg-white/80 z-10" />

                {/* Knot position indicator */}
                <div 
                  className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 z-20 w-5 h-5 rounded-full bg-white border border-yellow-400 shadow-[0_0_10px_#fff]"
                  style={{ left: `${ropePosition}%` }}
                />
              </div>

              {!isMatchWon && (
                <p className="text-center text-[10px] font-bold text-white/50 uppercase tracking-wider mt-1">
                  W Rundzie {teamRound + 1} przeciąganie liny rozpocznie się od tego stanu ({ropePosition.toFixed(1)} PKT vs {(100 - ropePosition).toFixed(1)} PKT)!
                </p>
              )}
            </div>

            {/* MVP CARDS FOR BOTH TEAMS */}
            <div className="w-full grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
              {/* Blue Team MVP */}
              <div className="bg-gradient-to-br from-blue-950/40 to-blue-900/10 border-2 border-blue-500/40 rounded-2xl p-5 shadow-2xl relative overflow-hidden backdrop-blur-md">
                <div className="absolute top-3 right-3 opacity-20">
                  <ShieldCheck className="w-20 h-20 text-blue-400" />
                </div>
                <div className="flex items-center gap-2 mb-2">
                  <Crown className="w-5 h-5 text-yellow-400 drop-shadow" />
                  <span className="text-xs font-black tracking-widest text-blue-300 uppercase">
                    MVP DRUŻYNY NIEBIESKIEJ
                  </span>
                </div>
                {blueMvp ? (
                  <div>
                    <h3 className="text-2xl md:text-3xl font-black italic text-white tracking-tight truncate">
                      {blueMvp.username}
                    </h3>
                    <div className="flex items-center gap-3 mt-2">
                      <span className="px-2.5 py-1 bg-blue-500/20 text-blue-300 font-mono font-black text-xs rounded-lg border border-blue-500/30">
                        +{blueMvp.points} PKT
                      </span>
                      <span className="text-xs font-bold text-white/50 uppercase">
                        {blueMvp.wordsFound} {blueMvp.wordsFound === 1 ? 'HASŁO' : 'HASEŁ'}
                      </span>
                    </div>
                    {isMatchWon && (
                      <div className="mt-2.5 inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-yellow-500/20 text-yellow-300 border border-yellow-500/40 text-[10px] font-black uppercase tracking-wider shadow-[0_0_15px_rgba(234,179,8,0.25)] animate-pulse">
                        <Trophy className="w-3.5 h-3.5 text-yellow-400" />
                        +1 PKT W STATYSTYKACH (MVP DRUŻYNY)
                      </div>
                    )}
                  </div>
                ) : (
                  <span className="text-xs font-bold text-white/40 italic">Brak trafień w tej rundzie</span>
                )}
              </div>

              {/* Red Team MVP */}
              <div className="bg-gradient-to-br from-red-950/40 to-red-900/10 border-2 border-red-500/40 rounded-2xl p-5 shadow-2xl relative overflow-hidden backdrop-blur-md">
                <div className="absolute top-3 right-3 opacity-20">
                  <Flame className="w-20 h-20 text-red-400" />
                </div>
                <div className="flex items-center gap-2 mb-2">
                  <Crown className="w-5 h-5 text-yellow-400 drop-shadow" />
                  <span className="text-xs font-black tracking-widest text-red-300 uppercase">
                    MVP DRUŻYNY CZERWONEJ
                  </span>
                </div>
                {redMvp ? (
                  <div>
                    <h3 className="text-2xl md:text-3xl font-black italic text-white tracking-tight truncate">
                      {redMvp.username}
                    </h3>
                    <div className="flex items-center gap-3 mt-2">
                      <span className="px-2.5 py-1 bg-red-500/20 text-red-300 font-mono font-black text-xs rounded-lg border border-red-500/30">
                        +{redMvp.points} PKT
                      </span>
                      <span className="text-xs font-bold text-white/50 uppercase">
                        {redMvp.wordsFound} {redMvp.wordsFound === 1 ? 'HASŁO' : 'HASEŁ'}
                      </span>
                    </div>
                    {isMatchWon && (
                      <div className="mt-2.5 inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-yellow-500/20 text-yellow-300 border border-yellow-500/40 text-[10px] font-black uppercase tracking-wider shadow-[0_0_15px_rgba(234,179,8,0.25)] animate-pulse">
                        <Trophy className="w-3.5 h-3.5 text-yellow-400" />
                        +1 PKT W STATYSTYKACH (MVP DRUŻYNY)
                      </div>
                    )}
                  </div>
                ) : (
                  <span className="text-xs font-bold text-white/40 italic">Brak trafień w tej rundzie</span>
                )}
              </div>
            </div>

            {/* Side-by-Side Tables: WYNIK RUNDY & KLASYFIKACJA SESJI */}
            <div className="w-full grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
              {/* Round Leaderboard Card */}
              <div className="bg-bg-card border border-border-color rounded-2xl overflow-hidden shadow-2xl flex flex-col">
                <div className="p-5 bg-neutral-900/60 border-b border-border-color flex justify-between items-center">
                  <div className="flex flex-col">
                    <span className="text-xs font-black tracking-widest uppercase text-text-secondary">
                      WYNIK RUNDY {teamRound}
                    </span>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-[10px] font-mono font-bold text-blue-400">
                        N: +{roundBluePoints} pkt
                      </span>
                      <span className="text-white/20">•</span>
                      <span className="text-[10px] font-mono font-bold text-red-400">
                        C: +{roundRedPoints} pkt
                      </span>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-[8px] font-bold text-text-secondary uppercase">ODGADNIĘTO</p>
                    <p className="text-sm font-black text-yellow-400">{foundWords.length}/{possibleAnswers.length}</p>
                  </div>
                </div>

                <div className="max-h-[300px] min-h-[200px] overflow-y-auto p-4 space-y-2 custom-scrollbar">
                  {sortedRoundContributors.length > 0 ? (
                    sortedRoundContributors.map(([user, points], index) => {
                      const team = getPlayerTeam(user);
                      return (
                        <motion.div 
                          initial={{ x: -20, opacity: 0 }}
                          animate={{ x: 0, opacity: 1 }}
                          transition={{ delay: index * 0.04 }}
                          key={`round-${user}`} 
                          className={`flex items-center justify-between p-3 rounded-xl border transition-all ${
                            team === 'blue' 
                              ? 'bg-blue-950/20 border-blue-500/30' 
                              : team === 'red'
                                ? 'bg-red-950/20 border-red-500/30'
                                : 'bg-bg-main/50 border-border-color'
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            <span className={`w-5 text-[10px] font-black ${index === 0 ? 'text-yellow-400' : 'text-text-secondary'}`}>
                              #{index + 1}
                            </span>
                            <div className="flex items-center gap-2">
                              {team === 'blue' ? (
                                <span className="px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 border border-blue-500/30 text-[8px] font-black uppercase tracking-wider">
                                  NIEBIESCY
                                </span>
                              ) : team === 'red' ? (
                                <span className="px-1.5 py-0.5 rounded bg-red-500/20 text-red-300 border border-red-500/30 text-[8px] font-black uppercase tracking-wider">
                                  CZERWONI
                                </span>
                              ) : null}
                              <UserBadges username={user} size="w-3.5 h-3.5" />
                              <span className="font-bold text-sm text-white">{user}</span>
                            </div>
                          </div>
                          <span className={`font-black font-mono text-sm ${team === 'blue' ? 'text-blue-400' : team === 'red' ? 'text-red-400' : 'text-accent-red'}`}>
                            +{points} pkt
                          </span>
                        </motion.div>
                      );
                    })
                  ) : (
                    <div className="py-12 text-center opacity-30 text-[10px] font-black uppercase tracking-widest">
                      Brak odgadniętych haseł w tej rundzie
                    </div>
                  )}
                </div>
              </div>

              {/* Global Match/Session Leaderboard Card */}
              <div className="bg-bg-card border border-border-color rounded-2xl overflow-hidden shadow-2xl flex flex-col">
                <div className="p-5 bg-purple-900/20 border-b border-border-color flex justify-between items-center">
                  <div className="flex flex-col">
                    <span className="text-xs font-black tracking-widest uppercase text-purple-400">
                      KLASYFIKACJA CAŁEGO MECZU (SESJA)
                    </span>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-[10px] font-mono font-bold text-blue-400">
                        NIEBIESCY: {teamScores.blue} pkt
                      </span>
                      <span className="text-white/20">•</span>
                      <span className="text-[10px] font-mono font-bold text-red-400">
                        CZERWONI: {teamScores.red} pkt
                      </span>
                    </div>
                  </div>
                  <ShieldCheck className="w-5 h-5 text-purple-400" />
                </div>

                <div className="max-h-[300px] min-h-[200px] overflow-y-auto p-4 space-y-2 custom-scrollbar">
                  {allSessionPlayers.length > 0 ? (
                    allSessionPlayers.map((player, index) => (
                      <motion.div 
                        initial={{ x: 20, opacity: 0 }}
                        animate={{ x: 0, opacity: 1 }}
                        transition={{ delay: index * 0.04 }}
                        key={`session-${player.username}`} 
                        className={`flex items-center justify-between p-3 rounded-xl border transition-all ${
                          player.team === 'blue'
                            ? 'bg-blue-950/20 border-blue-500/30'
                            : player.team === 'red'
                              ? 'bg-red-950/20 border-red-500/30'
                              : 'bg-bg-main/50 border-purple-500/20'
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <span className={`w-5 text-[10px] font-black ${index === 0 ? 'text-yellow-400' : 'text-text-secondary'}`}>
                            #{index + 1}
                          </span>
                          <div className="flex flex-col">
                            <div className="flex items-center gap-2">
                              {player.team === 'blue' ? (
                                <span className="px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 border border-blue-500/30 text-[8px] font-black uppercase tracking-wider">
                                  NIEBIESCY
                                </span>
                              ) : player.team === 'red' ? (
                                <span className="px-1.5 py-0.5 rounded bg-red-500/20 text-red-300 border border-red-500/30 text-[8px] font-black uppercase tracking-wider">
                                  CZERWONI
                                </span>
                              ) : null}
                              <UserBadges username={player.username} size="w-3.5 h-3.5" />
                              <span className="font-bold text-sm text-white">{player.username}</span>
                            </div>
                            {player.wordsFound > 0 && (
                              <span className="text-[9px] font-bold text-white/40 uppercase mt-0.5 ml-0.5">
                                {player.wordsFound} {player.wordsFound === 1 ? 'hasło' : 'haseł'}
                              </span>
                            )}
                          </div>
                        </div>
                        <span className={`font-black font-mono text-sm ${player.team === 'blue' ? 'text-blue-400' : player.team === 'red' ? 'text-red-400' : 'text-purple-400'}`}>
                          {player.points} pkt
                        </span>
                      </motion.div>
                    ))
                  ) : (
                    <div className="py-12 text-center opacity-30 text-[10px] font-black uppercase tracking-widest">
                      Brak punktów w meczu
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Word Breakdown Toggle Button & Grid (With Team Colors) */}
            <div className="w-full max-w-5xl mb-6 flex flex-col gap-3">
              <button 
                onClick={() => setShowRoundWords(!showRoundWords)}
                className="w-full bg-white/5 border border-white/10 hover:bg-white/10 text-white py-3.5 rounded-xl font-bold tracking-widest uppercase transition-all flex items-center justify-center gap-2 text-xs shadow-lg group cursor-pointer"
              >
                <Lightbulb className={`w-4 h-4 transition-colors ${showRoundWords ? 'text-yellow-400' : 'text-text-secondary group-hover:text-yellow-400'}`} />
                {showRoundWords ? 'UKRYJ HASŁA RUNDY' : 'POKAŻ HASŁA RUNDY (Z KOLORAMI DRUŻYN)'}
              </button>

              {showRoundWords && (
                <motion.div 
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="bg-bg-card border border-border-color p-6 rounded-2xl shadow-2xl w-full"
                >
                  <div className="flex flex-col items-center mb-5">
                    <h3 className="text-[11px] font-black text-text-secondary uppercase tracking-[0.3em] text-center mb-2">
                      HASŁA RUNDY {teamRound} — KTO ODGADŁ DANE SŁOWO
                    </h3>
                    <div className="flex flex-wrap items-center justify-center gap-4 text-[10px] font-bold">
                      <span className="flex items-center gap-1.5 text-blue-400 bg-blue-500/10 px-2.5 py-1 rounded-lg border border-blue-500/30">
                        <span className="w-2.5 h-2.5 rounded-sm bg-blue-500 shadow-[0_0_6px_#3b82f6]" />
                        NIEBIESCY: {foundWords.filter(fw => getPlayerTeam(fw.user) === 'blue').length}
                      </span>
                      <span className="flex items-center gap-1.5 text-red-400 bg-red-500/10 px-2.5 py-1 rounded-lg border border-red-500/30">
                        <span className="w-2.5 h-2.5 rounded-sm bg-red-500 shadow-[0_0_6px_#ef4444]" />
                        CZERWONI: {foundWords.filter(fw => getPlayerTeam(fw.user) === 'red').length}
                      </span>
                      <span className="flex items-center gap-1.5 text-white/50 bg-white/5 px-2.5 py-1 rounded-lg border border-white/10">
                        <span className="w-2.5 h-2.5 rounded-sm bg-white/20" />
                        NIEODKRYTE: {possibleAnswers.length - foundWords.length}
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2.5">
                    {possibleAnswers.map(word => {
                      const found = foundWords.find(fw => fw.word === word);
                      const solverTeam = found ? getPlayerTeam(found.user) : null;
                      const specialType = specialWords[word];
                      const isMaster = word === currentLevel.masterWord;

                      let cardStyle = 'bg-white/5 border-white/10 text-white/30';
                      let teamBadge = null;

                      if (found) {
                        if (solverTeam === 'blue') {
                          cardStyle = 'bg-blue-950/40 border-2 border-blue-500/80 shadow-[0_0_15px_rgba(59,130,246,0.3)] text-blue-200';
                          teamBadge = (
                            <span className="px-1.5 py-0.5 rounded bg-blue-500/30 text-blue-300 border border-blue-400/40 text-[8px] font-black uppercase tracking-wider flex items-center gap-1">
                              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shadow-[0_0_4px_#3b82f6]" />
                              NIEBIESCY
                            </span>
                          );
                        } else if (solverTeam === 'red') {
                          cardStyle = 'bg-red-950/40 border-2 border-red-500/80 shadow-[0_0_15px_rgba(239,68,68,0.3)] text-red-200';
                          teamBadge = (
                            <span className="px-1.5 py-0.5 rounded bg-red-500/30 text-red-300 border border-red-400/40 text-[8px] font-black uppercase tracking-wider flex items-center gap-1">
                              <span className="w-1.5 h-1.5 rounded-full bg-red-400 shadow-[0_0_4px_#ef4444]" />
                              CZERWONI
                            </span>
                          );
                        } else {
                          cardStyle = 'bg-green-950/40 border-2 border-green-500/60 text-green-300';
                          teamBadge = (
                            <span className="px-1.5 py-0.5 rounded bg-green-500/20 text-green-300 text-[8px] font-black uppercase">
                              GRACZ
                            </span>
                          );
                        }
                      }

                      return (
                        <div
                          key={word}
                          className={`p-3 rounded-xl border flex flex-col items-center justify-between min-h-[76px] relative overflow-hidden transition-all ${cardStyle}`}
                        >
                          <div className="w-full flex items-center justify-between mb-1">
                            {teamBadge ? (
                              teamBadge
                            ) : (
                              <span className="text-[8px] font-black uppercase tracking-widest text-white/30">
                                {isMaster ? '⭐ GŁÓWNE' : 'NIEODKRYTE'}
                              </span>
                            )}
                            {specialType && !found && (
                              <span className="w-2 h-2 rounded-full bg-yellow-400 shadow-[0_0_6px_#facc15]" title={specialType} />
                            )}
                          </div>

                          <span className={`text-sm font-black font-mono tracking-tight text-center truncate max-w-full ${found ? 'text-white' : 'text-white/40'}`}>
                            {word}
                          </span>

                          {found ? (
                            <div className="w-full mt-1.5 pt-1 border-t border-white/10 flex items-center justify-between text-[9px] font-bold">
                              <span className="truncate max-w-[90px]">{found.user}</span>
                              <span className="font-mono font-black text-yellow-400 shrink-0">+{found.points} pkt</span>
                            </div>
                          ) : (
                            <div className="w-full mt-1 text-[8px] text-white/20 text-center font-mono">
                              {word.length} LIT.
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </motion.div>
              )}
            </div>

            {/* Action Buttons for Team Mode */}
            <div className="w-full max-w-xl space-y-3">
              {!isMatchWon ? (
                <button 
                  onClick={nextTeamRound}
                  className="w-full bg-gradient-to-r from-blue-600 via-purple-600 to-red-600 hover:from-blue-500 hover:to-red-500 text-white py-4 rounded-xl font-black tracking-[0.2em] uppercase transition-all shadow-[0_0_25px_rgba(168,85,247,0.4)] active:scale-95 flex items-center justify-center gap-3 text-sm cursor-pointer"
                >
                  <FastForward className="w-5 h-5 text-yellow-300" />
                  NASTĘPNA RUNDA {teamRound + 1} (LINA ZOSTAJE ➔)
                </button>
              ) : (
                <button 
                  disabled={!isConnected}
                  onClick={startTeamGame}
                  title={!isConnected ? "Najpierw połącz bota z kontem Twitch" : undefined}
                  className={`w-full py-4 rounded-xl font-black tracking-[0.2em] uppercase transition-all shadow-xl active:scale-95 flex items-center justify-center gap-2 text-sm ${isConnected ? 'bg-gradient-to-r from-blue-600 via-purple-600 to-red-600 hover:from-blue-500 hover:to-red-500 text-white cursor-pointer' : 'bg-neutral-800 text-neutral-600 opacity-50 cursor-not-allowed'}`}
                >
                  <Swords className="w-5 h-5 text-yellow-300" />
                  {isConnected ? "ZAGRAJ JESZCZE RAZ TYMI SAMYMI DRUŻYNAMI (START OD RUNDY 1)" : "POŁĄCZ BOTA Z TWITCH, ABY ZAGRAĆ PONOWNIE"}
                </button>
              )}
              
              <button 
                onClick={() => {
                  setGameState('lobby');
                  setFoundWords([]);
                  setShowRoundWords(false);
                  setSessionScores({});
                  setLevelIndex(0);
                  setTimeLeft(INITIAL_TIME);
                  setHints({});
                  setTeamRound(1);
                  setRopePosition(50);
                  setTeamScores({ blue: 0, red: 0 });
                  setTeamPlayerStats({});
                  setCurrentTeamStreak({ team: null, count: 0 });
                  setTeamMatchWinner(null);
                  setTeamWinReason(null);
                  setLastPullDelta(null);
                  teamMvpAwardedRef.current = false;
                }}
                className="w-full bg-white/5 hover:bg-white/10 text-white border border-white/10 py-3.5 rounded-xl font-black tracking-widest text-xs uppercase transition-all flex items-center justify-center gap-2 cursor-pointer"
              >
                <Users className="w-4 h-4 text-cyan-400" />
                POWRÓT DO LOBBY DRUŻYN
              </button>

              <button 
                onClick={exitToLobby}
                className="w-full bg-neutral-800 hover:bg-neutral-700 text-white/60 hover:text-white py-3 rounded-xl font-bold tracking-widest text-[10px] uppercase transition-all cursor-pointer"
              >
                MENU GŁÓWNE
              </button>
            </div>
          </motion.div>
          {renderGlobalOverlays()}
        </div>
      );
    }


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
      <div className="min-h-screen bg-bg-main text-text-primary font-sans flex flex-col items-center p-4 pt-16 pb-16 relative overflow-y-auto custom-scrollbar">
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
                    const isFrozen = frozenWords[word] && Date.now() < frozenWords[word];
                    return (
                      <div 
                        key={word}
                        className={`p-2 rounded-lg border flex flex-col items-center justify-center relative overflow-hidden ${
                          isFound ? 'bg-green-500/10 border-green-500/30' : isFrozen ? 'bg-blue-500/10 border-blue-500/50' : 'bg-white/5 border-white/10'
                        }`}
                      >
                        <span className={`text-xs font-black font-mono tracking-tighter whitespace-nowrap overflow-hidden ${isFound ? 'text-green-500' : isFrozen ? 'text-blue-300' : 'text-text-secondary'}`}>
                          {word}
                        </span>
                        {isFrozen && (
                          <div className="absolute inset-0 flex items-center justify-center bg-blue-500/5">
                             <Snowflake className="w-4 h-4 text-blue-400 opacity-40 animate-spin" />
                          </div>
                        )}
                        {specialType && !isFound && !isFrozen && (
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

  const masterWordFound = foundWords.some(fw => fw.word === currentLevel.masterWord);
  const decoyItems = shuffledLetters.filter(l => l.isDecoy);
  const hiddenItems = shuffledLetters.filter(l => l.isHidden);

  return (
    <div className="h-screen bg-bg-main text-text-primary font-sans flex flex-col overflow-hidden items-center">
      
      {/* TUG OF WAR ARENA BAR (TEAM MODE) */}
      {gameMode === 'teams' && (
        <div className="w-full max-w-7xl mx-auto px-4 pt-2 pb-1 z-40 shrink-0">
          <div className="bg-black/60 border border-white/10 rounded-xl p-2 md:p-2.5 backdrop-blur-xl shadow-2xl flex flex-col gap-1.5 relative overflow-hidden">
            {/* Top Team Status Header */}
            <div className="flex items-center justify-between px-2">
              {/* Blue Team Info */}
              <div className="flex items-center gap-3">
                <div className="w-7 h-7 rounded-lg bg-blue-600/30 border border-blue-500/50 flex items-center justify-center text-blue-400 font-black shadow-[0_0_15px_rgba(59,130,246,0.4)]">
                  <ShieldCheck className="w-5 h-5 text-blue-400" />
                </div>
                <div className="flex flex-col text-left">
                  <div className="flex items-center gap-2">
                    <span className="font-black text-blue-400 text-sm tracking-wider uppercase drop-shadow-[0_0_8px_rgba(59,130,246,0.6)]">
                      DRUŻYNA NIEBIESKA
                    </span>
                    {currentTeamStreak.team === 'blue' && currentTeamStreak.count >= 2 && (
                      <span className="bg-blue-500/20 text-blue-300 border border-blue-500/40 text-[9px] font-black px-2 py-0.5 rounded-full flex items-center gap-1 animate-pulse shadow-[0_0_10px_rgba(59,130,246,0.4)]">
                        <Flame className="w-3 h-3 text-blue-400" />
                        COMBO x{currentTeamStreak.count} (+{currentTeamStreak.count === 2 ? '30' : currentTeamStreak.count === 3 ? '60' : '100'}% SIŁY)
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-[10px] font-bold text-white/50 uppercase">
                    <span>{blueTeam.length} GRACZY</span>
                    <span>•</span>
                    <span className="text-blue-300 font-mono font-bold">PUNKTY: {ropePosition.toFixed(1)} / 100 PKT ({ropePosition.toFixed(1)}%) →</span>
                  </div>
                </div>
              </div>

              {/* Center Tug of War Label & Delta */}
              <div className="hidden md:flex flex-col items-center">
                <div className="flex items-center gap-1.5 text-[9px] font-black tracking-widest uppercase text-white/50">
                  <Swords className="w-3.5 h-3.5 text-yellow-400" />
                  <span>PRZECIĄGANIE LINY • START: 50 / 50 PKT</span>
                </div>
                {lastPullDelta && (
                  <motion.div
                    key={`${lastPullDelta.user}-${lastPullDelta.amount}-${Date.now()}`}
                    initial={{ scale: 0.8, opacity: 0, y: -4 }}
                    animate={{ scale: 1, opacity: 1, y: 0 }}
                    className={`text-[10px] font-black tracking-wider uppercase mt-0.5 flex items-center gap-1 ${
                      lastPullDelta.team === 'blue' ? 'text-blue-400' : 'text-red-400'
                    }`}
                  >
                    {lastPullDelta.team === 'blue' ? (
                      <span>► +{lastPullDelta.amount} PKT ("{lastPullDelta.word}" • {lastPullDelta.word.length} LIT.) OD {lastPullDelta.user}!</span>
                    ) : (
                      <span>◄ +{lastPullDelta.amount} PKT ("{lastPullDelta.word}" • {lastPullDelta.word.length} LIT.) OD {lastPullDelta.user}!</span>
                    )}
                  </motion.div>
                )}
              </div>

              {/* Red Team Info */}
              <div className="flex items-center gap-3 flex-row-reverse text-right">
                <div className="w-7 h-7 rounded-lg bg-red-600/30 border border-red-500/50 flex items-center justify-center text-red-400 font-black shadow-[0_0_15px_rgba(239,68,68,0.4)]">
                  <Flame className="w-5 h-5 text-red-400" />
                </div>
                <div className="flex flex-col items-end">
                  <div className="flex items-center gap-2 flex-row-reverse">
                    <span className="font-black text-red-400 text-sm tracking-wider uppercase drop-shadow-[0_0_8px_rgba(239,68,68,0.6)]">
                      DRUŻYNA CZERWONA
                    </span>
                    {currentTeamStreak.team === 'red' && currentTeamStreak.count >= 2 && (
                      <span className="bg-red-500/20 text-red-300 border border-red-500/40 text-[9px] font-black px-2 py-0.5 rounded-full flex items-center gap-1 animate-pulse shadow-[0_0_10px_rgba(239,68,68,0.4)]">
                        <Flame className="w-3 h-3 text-red-400" />
                        COMBO x{currentTeamStreak.count} (+{currentTeamStreak.count === 2 ? '30' : currentTeamStreak.count === 3 ? '60' : '100'}% SIŁY)
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-[10px] font-bold text-white/50 uppercase">
                    <span className="text-red-300 font-mono font-bold">← PUNKTY: {(100 - ropePosition).toFixed(1)} / 100 PKT ({(100 - ropePosition).toFixed(1)}%)</span>
                    <span>•</span>
                    <span>{redTeam.length} GRACZY</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Dynamic Tug-of-War Laser Bar */}
            <div className="relative w-full h-6 bg-neutral-950 rounded-xl border border-white/20 overflow-hidden shadow-[inset_0_2px_8px_rgba(0,0,0,0.8)] flex items-center">
              {/* Blue fill */}
              <div 
                className="absolute left-0 top-0 bottom-0 bg-gradient-to-r from-blue-700 via-blue-500 to-cyan-400 transition-all duration-300 shadow-[0_0_20px_rgba(59,130,246,0.6)]"
                style={{ width: `${ropePosition}%` }}
              />
              {/* Red fill */}
              <div 
                className="absolute right-0 top-0 bottom-0 bg-gradient-to-l from-red-700 via-red-500 to-orange-400 transition-all duration-300 shadow-[0_0_20px_rgba(239,68,68,0.6)]"
                style={{ width: `${100 - ropePosition}%` }}
              />

              {/* Center Line Marker (50 PKT Start) */}
              <div className="absolute left-1/2 -translate-x-1/2 top-0 bottom-0 w-0.5 bg-white/70 z-10 flex flex-col justify-between items-center py-0.5 pointer-events-none">
                <span className="text-[7px] font-black text-white/80 bg-black/60 px-1 rounded-sm leading-none">50</span>
                <span className="text-[7px] font-black text-white/80 bg-black/60 px-1 rounded-sm leading-none">PKT</span>
              </div>

              {/* Left & Right K.O. Threshold Indicators */}
              <div className="absolute left-3 text-[9px] font-black tracking-widest text-white drop-shadow z-10 flex items-center gap-1">
                <span>◄ K.O. CZERWONI (100 PKT)</span>
              </div>
              <div className="absolute right-3 text-[9px] font-black tracking-widest text-white drop-shadow z-10 flex items-center gap-1">
                <span>(100 PKT) K.O. NIEBIESCY ►</span>
              </div>

              {/* Sliding Laser Knot Indicator */}
              <motion.div
                animate={{ left: `${ropePosition}%` }}
                transition={{ type: "spring", stiffness: 300, damping: 25 }}
                className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 z-20 flex items-center justify-center pointer-events-none"
              >
                <div className="w-8 h-8 rounded-full bg-white border-2 border-yellow-400 shadow-[0_0_25px_#ffffff,0_0_15px_#facc15] flex items-center justify-center">
                  <Swords className="w-4 h-4 text-neutral-900 animate-spin-slow" />
                </div>
              </motion.div>
            </div>
          </div>
        </div>
      )}

      {/* Letters Section (The Scrambler) */}
      <section className={`w-full ${gameMode === 'teams' ? 'h-[170px] md:h-[180px]' : 'h-[240px]'} shrink-0 flex flex-col items-center justify-center bg-linear-to-b from-bg-card to-bg-main relative transition-all duration-700 overflow-visible z-30 ${isDarknessActive ? 'blur-xl grayscale opacity-30 pointer-events-none scale-110' : ''}`}>
          <div 
            className="flex flex-wrap justify-center items-center px-4 transition-transform duration-300 overflow-visible max-w-full"
            style={{ 
              transform: `scale(${diceScale})`, 
              transformOrigin: 'center center',
              gap: `${shuffledLetters.length > 10 ? diceSpacing / 2 : diceSpacing}px`,
            }}
          >
            <AnimatePresence mode="popLayout">
              {shuffledLetters.map((item) => {
                const masterWordFound = foundWords.some(fw => fw.word === currentLevel.masterWord);
                const isDecoyRevealed = item.isDecoy && (masterWordFound || timeLeft < 30);
                const isHiddenRevealed = item.isHidden && (masterWordFound || timeLeft < 30);
                
                const displayChar = (item.isHidden && !isHiddenRevealed) ? "?" : item.char;
                
                // Dynamic sizing logic based on word length
                const isLongWord = shuffledLetters.length > 8;
                const isVeryLongWord = shuffledLetters.length > 10;
                
                const tileSizeClass = isVeryLongWord 
                  ? 'w-[50px] h-[50px] md:w-[75px] md:h-[75px] text-2xl md:text-5xl mb-6' 
                  : isLongWord 
                    ? 'w-[60px] h-[60px] md:w-[85px] md:h-[85px] text-3xl md:text-6xl mb-8'
                    : 'w-[70px] h-[70px] md:w-[105px] md:h-[105px] text-4xl md:text-7xl mb-10';

                const shadowClass = isDecoyRevealed 
                  ? (isVeryLongWord ? 'shadow-[0_6px_0_#2a0000]' : isLongWord ? 'shadow-[0_8px_0_#2a0000]' : 'shadow-[0_10px_0_#2a0000]')
                  : isHiddenRevealed
                    ? (isVeryLongWord ? 'shadow-[0_6px_0_#ca8a04]' : isLongWord ? 'shadow-[0_8px_0_#ca8a04]' : 'shadow-[0_10px_0_#ca8a04]')
                    : (isVeryLongWord ? 'shadow-[0_6px_0_#b91c1c]' : isLongWord ? 'shadow-[0_8px_0_#b91c1c]' : 'shadow-[0_10px_0_#b91c1c]');

                return (
                  <motion.div
                    key={item.id}
                    layout
                    initial={{ opacity: 0, scale: 0.8, y: 15 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    transition={{ type: "spring", stiffness: 350, damping: 25 }}
                    className={`flex-shrink-0 flex items-center justify-center font-black rounded-2xl uppercase border-t border-white/20 transition-all ${tileSizeClass}
                      ${isDecoyRevealed 
                        ? 'bg-[#4a0000] text-red-500 border-2 border-red-900 ' + shadowClass
                        : isHiddenRevealed
                          ? 'bg-yellow-400 text-black border-2 border-yellow-600 ' + shadowClass
                          : 'bg-white text-black ' + shadowClass}
                    `}
                  >
                    {displayChar}
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        
        {/* Time Progress Bar (No Digital Clock) */}
        <div className={`absolute ${gameMode === 'teams' ? 'bottom-2' : 'bottom-4'} left-1/2 -translate-x-1/2 w-[95%] max-w-7xl`}>
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
        </div>
      </section>

      {/* Main Gameplay Area with Grid and Chat */}
      <main className={`flex-1 min-h-0 w-full max-w-[1800px] flex ${gameMode === 'teams' ? 'gap-5 p-3 md:p-4' : 'gap-10 p-4 md:p-10'} overflow-hidden items-stretch`}>
        
        {/* Answers Grid Section */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className={`flex justify-between items-center ${gameMode === 'teams' ? 'mb-2 pb-2' : 'mb-4 pb-4'} border-b border-white/5`}>
            <div className="flex flex-col min-w-[150px]">
              <div className="flex items-center gap-3 mb-1">
                <span className="text-[10px] font-black tracking-[0.3em] text-text-secondary uppercase opacity-50">
                  {gameMode === 'teams' ? 'PRZECIĄGANIE LINY' : 'STREFA GRY'}
                </span>
              </div>
              <span className={`${gameMode === 'teams' ? 'text-2xl md:text-3xl' : 'text-4xl'} font-black italic tracking-tighter text-accent-red uppercase italic leading-none`}>
                {gameMode === 'teams' ? `RUNDA ${teamRound}` : `POZIOM ${levelIndex + 1}`}
              </span>
            </div>

            {/* Notifications Middle */}
            <div className="flex-1 flex flex-col items-center justify-center gap-2 px-4 h-full pt-4">
               {isTimeFrozen && (
                <motion.div initial={{ y: 10, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="text-[9px] font-black text-cyan-400 tracking-widest animate-bounce bg-cyan-400/10 px-3 py-1 rounded-full border border-cyan-400/20 whitespace-nowrap">
                  CZAS ZAMROŻONY 🧊
                </motion.div>
              )}
              {isDarknessActive && (
                <motion.div initial={{ y: 10, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="text-[9px] font-black text-purple-400 tracking-widest animate-pulse bg-purple-400/10 px-3 py-1 rounded-full border border-purple-400/20 whitespace-nowrap">
                  MROK AKTYWNY 🌫️
                </motion.div>
              )}
              {blockedPlayer && Date.now() < blockedPlayer.expiresAt && (
                 <motion.div initial={{ y: 10, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="bg-red-600/20 px-4 py-1.5 rounded-full text-[10px] font-black text-red-500 tracking-widest animate-pulse border border-red-500/30 whitespace-nowrap">
                   LIDER BLOKOWANY: {blockedPlayer.username.toUpperCase()} 🚫
                 </motion.div>
              )}
              {currentLeader && (sessionShields[currentLeader] || 0) > 0 && (
                 <motion.div initial={{ y: 10, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="bg-cyan-600/20 px-4 py-1.5 rounded-full text-[10px] font-black text-cyan-400 tracking-widest border border-cyan-400/30 whitespace-nowrap">
                   LIDER MA TARCZĘ 🛡️ ({sessionShields[currentLeader]})
                 </motion.div>
              )}
            </div>

            <div className="flex flex-col items-end min-w-[150px]">
               <span className="text-[10px] font-black tracking-[0.2em] text-text-secondary uppercase opacity-50 mb-1 leading-none">ZDOBYTE LITERY:</span>
               <div className="flex items-baseline gap-2">
                 <span className={`text-4xl font-black font-mono transition-colors duration-500 leading-none ${completionRate >= 70 ? 'text-green-500' : 'text-accent-red'}`}>
                    {foundLettersInLevel}
                 </span>
                 <span className="text-text-secondary font-black text-xl opacity-30 leading-none">/</span>
                 <div className="flex flex-col">
                   <span className="text-text-secondary font-black text-xl opacity-50 leading-none">{targetLetters}</span>
                   <span className="text-[7px] font-black tracking-widest text-text-secondary uppercase opacity-30 mt-0.5 leading-none">CEL 70%</span>
                 </div>
               </div>
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto -mr-2 pr-3 pt-2 overflow-x-hidden">
            <div 
              className={`grid ${gameMode === 'teams' ? 'gap-2' : isCompactLayout ? 'gap-2' : 'gap-4'} content-start transition-all duration-300 ${isDarknessActive ? 'blur-md grayscale opacity-20 pointer-events-none' : ''}`}
              style={{ 
                gridTemplateColumns: `repeat(${gameMode === 'teams' ? Math.max(4, wordCols) : wordCols}, minmax(0, 1fr))`,
                width: '100%'
              }}
            >
              {possibleAnswers.map((word) => {
                const foundData = foundWords.find(fw => fw.word === word);
                const revealedIndices = hints[word] || [];
                const specialType = specialWords[word];
                const isFrozen = frozenWords[word] && Date.now() < frozenWords[word];
                
                return (
                  <motion.div
                    key={word}
                    initial={false}
                    animate={{ 
                      scale: foundData ? 1 : isFrozen ? 0.95 : 0.98,
                      y: foundData ? 0 : 2
                    }}
                    className={`relative flex flex-col items-center justify-center rounded-xl border-2 transition-all duration-300 px-3
                      ${foundData 
                        ? 'bg-accent-red border-accent-red text-white shadow-[0_0_20px_rgba(230,57,70,0.3)]' 
                        : isFrozen ? 'bg-blue-500/20 border-blue-500 shadow-[0_0_15px_rgba(59,130,246,0.5)]'
                        : specialType === 'PARASITE' ? 'bg-purple-500/20 border-purple-500 shadow-[0_0_15px_rgba(168,85,247,0.5)]'
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
                    style={{ height: `${gameMode === 'teams' ? Math.min(wordHeight, 68) : wordHeight}px` }}
                  >
                    {specialType && !foundData && !isFrozen && (
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
                        {specialType === 'FROST_BITE' && <div className="w-7 h-7 bg-blue-600 rounded-full flex items-center justify-center shadow-lg border-2 border-bg-main"><Snowflake className="w-4 h-4 text-white" /></div>}
                        {specialType === 'PARASITE' && <div className="w-7 h-7 bg-purple-600 rounded-full flex items-center justify-center shadow-lg border-2 border-bg-main"><Bug className="w-4 h-4 text-white" /></div>}
                        {specialType === 'MYSTERY' && <div className="w-8 h-8 bg-white rounded-full flex items-center justify-center shadow-lg border-2 border-bg-main animate-bounce"><HelpCircle className="w-5 h-5 text-bg-main" /></div>}
                      </div>
                    )}
                    {isFrozen && (
                      <div className="absolute inset-0 z-30 flex items-center justify-center bg-blue-500/20 backdrop-blur-[1px]">
                         <motion.div
                           animate={{ rotate: 360 }}
                           transition={{ duration: 4, repeat: Infinity, ease: "linear" }}
                         >
                            <Snowflake className="w-10 h-10 text-blue-300 opacity-80" />
                         </motion.div>
                      </div>
                    )}
                    <div 
                      className={`font-black tracking-[0.1em] font-mono leading-none whitespace-nowrap text-center px-1 ${foundData ? 'text-white' : isFrozen ? 'text-blue-300 opacity-50' : 'text-accent-red font-bold'}`}
                      style={{ 
                        fontSize: `calc(${word.length > 10 ? Math.max(0.7, 1.8 - (word.length - 10) * 0.1) : (word.length > 7 ? 1.6 : 2.25)}rem * ${wordScale})`,
                        maxWidth: '100%',
                        overflow: 'hidden'
                      }}
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
        </div>

        {/* Side Chat Panel */}
        <aside className="w-96 hidden lg:flex flex-col bg-[#18181b] border border-white/10 rounded-2xl overflow-hidden shadow-2xl">
          {/* Top Instruction & Feedback Area (MOVED FROM BOTTOM) */}
          <div className="h-28 bg-[#1f1f23] border-b border-white/10 flex flex-col items-center justify-center relative overflow-hidden shadow-lg shrink-0">
            <div className="w-full h-full flex flex-col items-center justify-center px-4 text-center">
              {(levelIndex + 1 >= 10 || levelIndex + 1 >= 16) ? (
                <div className="flex flex-col gap-2">
                  {levelIndex + 1 >= 10 && (
                    <motion.span 
                      key={`false-${masterWordFound}`}
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className={`${masterWordFound ? 'text-green-400' : 'text-accent-red'} font-black animate-pulse tracking-[0.1em] text-sm uppercase drop-shadow-[0_0_8px_rgba(239,68,68,0.5)]`}
                    >
                      {masterWordFound 
                        ? decoyItems.length > 1
                          ? `✅ LITERY "${decoyItems.map(d => d.char).join(', ')}" BYŁY FAŁSZYWE!`
                          : `✅ LITERA "${decoyItems[0]?.char}" BYŁA FAŁSZYWA!` 
                        : levelIndex + 1 >= 45 
                          ? "⚠️ DWIE LITERY SĄ FAŁSZYWE!" 
                          : "⚠️ JEDNA LITERA JEST FAŁSZYWA!"}
                    </motion.span>
                  )}
                  {levelIndex + 1 >= 16 && (
                    <motion.span 
                      key={`hidden-${masterWordFound}`}
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className={`${masterWordFound ? 'text-yellow-300' : 'text-yellow-400'} font-black animate-pulse tracking-[0.1em] text-sm uppercase drop-shadow-[0_0_8px_rgba(250,204,21,0.5)]`}
                    >
                      {masterWordFound 
                        ? hiddenItems.length > 1 
                          ? `✅ LITERY "${hiddenItems.map(h => h.char).join(', ')}" BYŁY UKRYTE!`
                          : `✅ LITERA "${hiddenItems[0]?.char}" BYŁA UKRYTA!` 
                        : levelIndex + 1 >= 30 
                          ? "❓ DWIE LITERY SĄ UKRYTE!" 
                          : "❓ JEDNA LITERA JEST UKRYTA!"}
                    </motion.span>
                  )}
                </div>
              ) : (
                <div className="text-[11px] font-black text-white tracking-[0.2em] uppercase flex flex-col items-center gap-1.5 px-4 text-center">
                  <span className="text-[#bf94ff] drop-shadow-md leading-tight">WPISUJ HASŁA NA CZACIE TWITCH</span>
                </div>
              )}
            </div>
            
            <AnimatePresence>
              {feedback.type && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  className={`absolute inset-0 flex items-center justify-center gap-2 z-10 backdrop-blur-md px-4 text-center
                    ${feedback.type === 'success' ? 'bg-green-500/20 text-green-400' : 
                      feedback.type === 'freeze' ? 'bg-blue-500/20 text-blue-300' : 
                      feedback.type === 'hazard' ? 'bg-red-500/20 text-accent-red' : 'bg-accent-red/20 text-accent-red'}
                  `}
                >
                  {feedback.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : 
                   feedback.type === 'freeze' ? <Timer className="w-4 h-4 animate-spin-slow shrink-0" /> : 
                   feedback.type === 'hazard' ? <Skull className="w-4 h-4 animate-bounce shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                  <span className="font-black text-[11px] tracking-wider uppercase leading-tight whitespace-nowrap overflow-hidden text-ellipsis">{feedback.message}</span>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Consolidated Chat Header */}
          <div className="p-4 border-b border-white/10 bg-[#18181b] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FaTwitch className={`w-4 h-4 ${isConnected ? 'text-[#9146ff]' : 'text-neutral-700'}`} />
              <span className="text-[10px] font-black tracking-widest text-white/50 uppercase">TWITCH CHAT</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-[10px] font-black text-[#9146ff] uppercase">{activeChannel}</span>
              <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500 shadow-[0_0_8px_#22c55e]' : 'bg-neutral-700'}`} />
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
                        ? msg.team === 'blue'
                          ? 'bg-blue-600/20 border-blue-500/40 -mx-4 px-4 py-2.5 !border-y shadow-[0_0_15px_rgba(59,130,246,0.2)]'
                          : msg.team === 'red'
                            ? 'bg-red-600/20 border-red-500/40 -mx-4 px-4 py-2.5 !border-y shadow-[0_0_15px_rgba(239,68,68,0.2)]'
                            : 'bg-green-500/20 border-green-500/40 -mx-4 px-4 py-2.5 !border-y shadow-[0_0_15px_rgba(34,197,94,0.1)]' 
                        : ''
                    }`}
                  >
                    <div className="inline-flex items-baseline flex-wrap gap-x-1.5">
                      {msg.team === 'blue' && (
                        <span className="px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 border border-blue-500/40 text-[8px] font-black uppercase tracking-wider">
                          NIEBIESCY
                        </span>
                      )}
                      {msg.team === 'red' && (
                        <span className="px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 border border-red-500/40 text-[8px] font-black uppercase tracking-wider">
                          CZERWONI
                        </span>
                      )}
                      {msg.team === 'spectator' && (
                        <span className="px-1.5 py-0.5 rounded bg-white/5 text-white/40 border border-white/10 text-[8px] font-black uppercase tracking-wider">
                          KIBIC
                        </span>
                      )}
                      <UserBadges username={msg.username} size="w-3.5 h-3.5" />
                      <span className="font-black text-sm" style={{ color: msg.color }}>{msg.username}:</span>
                      <span className={`${
                        msg.isCorrect 
                          ? msg.team === 'blue' 
                            ? 'text-blue-300 font-black tracking-tight scale-105 origin-left inline-block' 
                            : msg.team === 'red'
                              ? 'text-red-300 font-black tracking-tight scale-105 origin-left inline-block'
                              : 'text-green-400 font-black tracking-tighter scale-110 origin-left inline-block' 
                          : 'text-text-secondary'
                      } font-medium`}>
                        {msg.message}
                      </span>
                      {msg.isCorrect && <Sparkles className="w-4 h-4 text-yellow-400 ml-1 animate-bounce" />}
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
