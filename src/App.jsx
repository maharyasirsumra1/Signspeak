import React, { useEffect, useRef, useState } from 'react';
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import {
  Hand,
  Video,
  VideoOff,
  AlertCircle,
  RefreshCw,
  CheckCircle2,
  FlipHorizontal,
  Layers,
  Zap,
  Radio,
  Play,
  Download,
  Trash2,
  Database,
  Check,
  RotateCcw,
  Camera,
  Copy,
  Pause,
  Activity,
  Sparkles,
  Terminal,
  Save
} from 'lucide-react';
import {
  VOCABULARY,
  TARGET_SAMPLES_PER_WORD,
  saveRecording,
  getAllRecordings,
  getCountsByWord,
  deleteLastRecording,
  clearAllRecordings,
  FRAMES_PER_SAMPLE,
  FEATURES_PER_FRAME,
  SCHEMA_VERSION
} from './utils/db';
import { loadModelAssets, predictSign } from './utils/signModel';
import {
  extractFrameFeatures,
  resampleFrames,
  getRealHandSide
} from './utils/features';

// ==========================================
// VISUAL SCALE & SIZE CONSTANTS (Tweakable)
// ==========================================
export const HUD_PANEL_MAX_WIDTH = 170; // px: width of top-left and top-right HUD panels (~37% smaller)
export const SKELETON_LINE_WIDTH = 1.5; // px: thickness of hand skeleton lines
export const SKELETON_DOT_RADIUS = 2; // px: radius of landmark joint dots
export const SKELETON_TIP_RADIUS = 3; // px: radius of fingertip dots
export const SKELETON_WRIST_RADIUS = 2.5; // px: radius of wrist anchor dot
export const SKELETON_OPACITY = 0.8; // opacity of hand skeleton (0.0 to 1.0, 80% lighter)
export const HAND_BOX_LINE_WIDTH = 2; // px: thickness of hand bounding box
export const HAND_BOX_LABEL_FONT_SIZE = 12; // px: font size of hand box label
export const HUD_PROGRESS_BAR_HEIGHT = 4; // px: height of HUD progress bars
const ACCEPT_CONFIDENCE = 0.5;
// Recording gesture window: same rules as live recognition
const CAPTURE_MAX_MS = 3000; // stop after 3 s
const CAPTURE_END_SILENCE_MS = 600; // stop when the hand has been gone this long
const CAPTURE_MIN_HAND_FRAMES = 8; // fewer hand frames than this is rejected

// The 21 hand landmarks connection pairs defined by MediaPipe
const HAND_CONNECTIONS = [
  // Thumb
  [0, 1], [1, 2], [2, 3], [3, 4],
  // Index finger
  [0, 5], [5, 6], [6, 7], [7, 8],
  // Middle finger
  [9, 10], [10, 11], [11, 12],
  // Ring finger
  [13, 14], [14, 15], [15, 16],
  // Pinky finger
  [0, 17], [17, 18], [18, 19], [19, 20],
  // Palm knuckles connectors
  [5, 9], [9, 13], [13, 17]
];

// Fingertip landmark indices
const FINGERTIPS = [4, 8, 12, 16, 20];

export default function App() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const landmarkerRef = useRef(null);
  const streamRef = useRef(null);
  const animFrameIdRef = useRef(null);

  // App Mode & Tab ('live' | 'record')
  const [activeTab, setActiveTab] = useState('live');
  const activeTabRef = useRef(activeTab);
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  // MediaPipe Vision & Camera States
  const [modelLoading, setModelLoading] = useState(true);
  const [modelReady, setModelReady] = useState(false);
  const [cameraStatus, setCameraStatus] = useState('idle'); // idle | requesting | active | error
  const [errorMessage, setErrorMessage] = useState('');
  const [detectedHandsCount, setDetectedHandsCount] = useState(0);
  const [isMirrored, setIsMirrored] = useState(true);
  const isMirroredRef = useRef(isMirrored);
  useEffect(() => {
    isMirroredRef.current = isMirrored;
  }, [isMirrored]);

  // Visual Overlays Toggles
  const [showSkeleton, setShowSkeleton] = useState(true);
  const showSkeletonRef = useRef(showSkeleton);
  useEffect(() => {
    showSkeletonRef.current = showSkeleton;
  }, [showSkeleton]);

  const [showLandmarks, setShowLandmarks] = useState(true);
  const showLandmarksRef = useRef(showLandmarks);
  useEffect(() => {
    showLandmarksRef.current = showLandmarks;
  }, [showLandmarks]);

  const [showHandBox, setShowHandBox] = useState(true);
  const showHandBoxRef = useRef(showHandBox);
  useEffect(() => {
    showHandBoxRef.current = showHandBox;
  }, [showHandBox]);

  const [showHud, setShowHud] = useState(true);
  const showHudRef = useRef(showHud);
  useEffect(() => {
    showHudRef.current = showHud;
  }, [showHud]);

  // Hand Mode: 'both' | 'right' | 'left'
  const [handMode, setHandMode] = useState('both');
  const handModeRef = useRef(handMode);
  useEffect(() => {
    handModeRef.current = handMode;
  }, [handMode]);

  // Ghost Mode (Invisibility of real webcam feed), persisted in localStorage
  const [isGhostMode, setIsGhostMode] = useState(() => {
    try {
      return localStorage.getItem('signspeak_ghost_mode') === 'true';
    } catch {
      return false;
    }
  });
  const isGhostModeRef = useRef(isGhostMode);
  useEffect(() => {
    isGhostModeRef.current = isGhostMode;
    try {
      localStorage.setItem('signspeak_ghost_mode', String(isGhostMode));
    } catch {}
  }, [isGhostMode]);

  // Video Freeze / Pause
  const [isPaused, setIsPaused] = useState(false);
  const isPausedRef = useRef(isPaused);
  useEffect(() => {
    isPausedRef.current = isPaused;
  }, [isPaused]);

  // Telemetry Metrics
  const [fps, setFps] = useState(0);
  const [avgFps, setAvgFps] = useState('0.0');
  const [modelLatency, setModelLatency] = useState('0.0');
  const [totalFramesProcessed, setTotalFramesProcessed] = useState(0);
  const totalFramesRef = useRef(0);
  const fpsHistoryRef = useRef([]);
  const [currentTime, setCurrentTime] = useState(() =>
    new Date().toLocaleTimeString('en-US', { hour12: false })
  );

  // Neural Recognition Model States
  const [aiModelLoading, setAiModelLoading] = useState(true);
  const [aiModelReady, setAiModelReady] = useState(false);
  const [aiModelError, setAiModelError] = useState('');
  const aiModelRef = useRef(null);
  const labelsRef = useRef([]);

  // Subtitle Bar (Single most recent recognized word, 4s fade)
  const [currentSubtitle, setCurrentSubtitle] = useState('');
  const [currentConfidence, setCurrentConfidence] = useState(null);
  const [isSubtitleFaded, setIsSubtitleFaded] = useState(false);
  const [wordBuffer, setWordBuffer] = useState([]); // Last 3 recognized words
  const subtitleFadeTimerRef = useRef(null);
  const [sentenceBuilder, setSentenceBuilder] = useState([]);
  const [hasTrailingSpace, setHasTrailingSpace] = useState(false);
  const sentenceText = `${sentenceBuilder.map((item) => item.word).join(' ')}${
    hasTrailingSpace ? ' ' : ''
  }`;
  const [captionSize, setCaptionSize] = useState('medium');
  const [isSpeaking, setIsSpeaking] = useState(false);

  // Live HUD Recognition Telemetry State
  const [hudData, setHudData] = useState({
    currentWord: '---',
    confidence: 0,
    stability: 0,
    handConfidence: 0,
    handSide: 'Right'
  });

  // Live Hand Box Prediction Rolling Buffer & Smoothing Refs
  const rollingBufferRef = useRef([]); // Last 32 frames of features
  const predHistoryRef = useRef([]); // Last 3 prediction probability vectors (for anti-flicker smoothing)
  const last10PredictionsRef = useRef([]); // Last 10 prediction top words (for stability calculation)
  const lastLivePredTimeRef = useRef(0);
  const liveLabelRef = useRef({ word: '...', confidence: 0 });

  // Live Gesture Collection Tracking Refs (for Subtitle Bar)
  const isCollectingRef = useRef(false);
  const collectedFramesRef = useRef([]);
  const gestureStartTimeRef = useRef(null);
  const noHandsStartTimeRef = useRef(null);
  const handAbsentSinceRef = useRef(null);
  const lastAcceptedWordRef = useRef(null);
  const prevWristCoordsRef = useRef(null);
  const cooldownUntilRef = useRef(0);
  const [liveCollectingFrames, setLiveCollectingFrames] = useState(0);

  // Debug prediction info (for lower diagnostics card)
  const [debugPredictionInfo, setDebugPredictionInfo] = useState({
    top3: [],
    frameCount: 0,
    timestamp: null
  });

  // Recording Mode States (Dataset Collection Studio)
  const [selectedWord, setSelectedWord] = useState(VOCABULARY[0]);
  const [recordingState, setRecordingState] = useState('idle'); // idle | countdown | recording | saving
  const [countdown, setCountdown] = useState(null); // 3 | 2 | 1 | null
  const [recordedFramesCount, setRecordedFramesCount] = useState(0);
  const [wordCounts, setWordCounts] = useState({});
  const [notification, setNotification] = useState(null);

  // General references
  const latestLandmarkerResultRef = useRef(null);
  const countdownTimerRef = useRef(null);
  const recordIntervalRef = useRef(null);
  const notificationTimeoutRef = useRef(null);
  const lastFpsCalcRef = useRef(performance.now());
  const frameCountRef = useRef(0);

  // 1. Digital Clock (every 1 second)
  useEffect(() => {
    const clockInterval = setInterval(() => {
      setCurrentTime(new Date().toLocaleTimeString('en-US', { hour12: false }));
    }, 1000);
    return () => clearInterval(clockInterval);
  }, []);

  // 2. Load Sample Counts from IndexedDB on initial mount
  const refreshWordCounts = async () => {
    try {
      const counts = await getCountsByWord();
      setWordCounts(counts);
    } catch (err) {
      console.error('Failed to load word counts from IndexedDB:', err);
    }
  };

  useEffect(() => {
    refreshWordCounts();
  }, []);

  const showNotification = (message, type = 'info') => {
    if (notificationTimeoutRef.current) {
      clearTimeout(notificationTimeoutRef.current);
    }
    setNotification({ message, type });
    notificationTimeoutRef.current = setTimeout(() => {
      setNotification(null);
    }, 3200);
  };

  // 3. Initialize Neural Recognition Model (/labels.json & /model_weights.json from public/)
  useEffect(() => {
    let isCancelled = false;

    async function initNeuralModel() {
      try {
        setAiModelLoading(true);
        const { labels, model } = await loadModelAssets();
        if (isCancelled) return;

        aiModelRef.current = model;
        labelsRef.current = labels;
        setAiModelReady(true);
        setAiModelLoading(false);
      } catch (err) {
        console.error('Failed to load neural sign model:', err);
        if (!isCancelled) {
          setAiModelLoading(false);
          setAiModelError(`Neural model error: ${err.message || 'Failed to load model weights'}`);
        }
      }
    }

    initNeuralModel();

    return () => {
      isCancelled = true;
    };
  }, []);

  // 4. Initialize MediaPipe HandLandmarker on mount
  useEffect(() => {
    let isCancelled = false;

    async function initMediaPipe() {
      try {
        setModelLoading(true);
        const vision = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
        );

        if (isCancelled) return;

        let landmarker;
        try {
          landmarker = await HandLandmarker.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath:
                'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
              delegate: 'GPU'
            },
            runningMode: 'VIDEO',
            numHands: 2,
            minHandDetectionConfidence: 0.5,
            minHandPresenceConfidence: 0.5,
            minTrackingConfidence: 0.5
          });
        } catch (gpuErr) {
          console.warn('GPU delegate failed, falling back to CPU mode:', gpuErr);
          landmarker = await HandLandmarker.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath:
                'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
              delegate: 'CPU'
            },
            runningMode: 'VIDEO',
            numHands: 2,
            minHandDetectionConfidence: 0.5,
            minHandPresenceConfidence: 0.5,
            minTrackingConfidence: 0.5
          });
        }

        if (isCancelled) return;

        landmarkerRef.current = landmarker;
        setModelReady(true);
        setModelLoading(false);
      } catch (err) {
        console.error('Failed to load MediaPipe Hand Landmarker:', err);
        if (!isCancelled) {
          setModelLoading(false);
          setErrorMessage(
            'Failed to load the AI hand detection model. Please check your internet connection and refresh.'
          );
        }
      }
    }

    initMediaPipe();

    return () => {
      isCancelled = true;
      if (landmarkerRef.current) {
        landmarkerRef.current.close();
      }
    };
  }, []);

  // 5. Start Webcam once MediaPipe model is ready
  useEffect(() => {
    if (modelReady && cameraStatus === 'idle') {
      startCamera();
    }
  }, [modelReady]);

  const startCamera = async () => {
    try {
      setCameraStatus('requesting');
      setErrorMessage('');

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280, max: 1920 },
          height: { ideal: 720, max: 1080 },
          facingMode: 'user'
        },
        audio: false
      });

      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.onloadedmetadata = () => {
          videoRef.current.play().then(() => {
            setCameraStatus('active');
            startDetectionLoop();
          });
        };
      }
    } catch (err) {
      console.error('Webcam access error:', err);
      setCameraStatus('error');
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setErrorMessage(
          'Camera access was denied. Please allow camera permissions in your browser URL bar.'
        );
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        setErrorMessage('No camera found on this device. Please connect a webcam.');
      } else {
        setErrorMessage(`Camera error: ${err.message || 'Unable to access camera'}`);
      }
    }
  };

  const stopCamera = () => {
    if (animFrameIdRef.current) {
      cancelAnimationFrame(animFrameIdRef.current);
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    if (canvasRef.current) {
      const ctx = canvasRef.current.getContext('2d');
      ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    }
    latestLandmarkerResultRef.current = null;
    setCameraStatus('idle');
    setDetectedHandsCount(0);
    setFps(0);
  };

  // 6. Draw Hand Landmarks & Skeleton Lines
  const drawHandLandmarks = (ctx, landmarks, width, height, drawSkeleton, drawDots) => {
    ctx.save();
    ctx.globalAlpha = SKELETON_OPACITY;

    const scaleFactor = Math.max(0.6, width / 1280);
    const lineWidth = SKELETON_LINE_WIDTH * scaleFactor;
    const dotRadius = SKELETON_DOT_RADIUS * scaleFactor;
    const tipRadius = SKELETON_TIP_RADIUS * scaleFactor;
    const wristRadius = SKELETON_WRIST_RADIUS * scaleFactor;

    if (drawSkeleton) {
      ctx.lineWidth = lineWidth;
      ctx.strokeStyle = '#38bdf8'; // Sky blue
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.shadowColor = '#0284c7';
      ctx.shadowBlur = 4 * scaleFactor;

      for (const [startIdx, endIdx] of HAND_CONNECTIONS) {
        const p1 = landmarks[startIdx];
        const p2 = landmarks[endIdx];
        if (p1 && p2) {
          ctx.beginPath();
          ctx.moveTo(p1.x * width, p1.y * height);
          ctx.lineTo(p2.x * width, p2.y * height);
          ctx.stroke();
        }
      }
      ctx.shadowBlur = 0;
    }

    if (drawDots) {
      landmarks.forEach((point, index) => {
        const x = point.x * width;
        const y = point.y * height;
        const isTip = FINGERTIPS.includes(index);
        const isWrist = index === 0;

        if (isTip) {
          ctx.beginPath();
          ctx.arc(x, y, tipRadius, 0, 2 * Math.PI);
          ctx.fillStyle = '#f43f5e'; // Coral rose
          ctx.fill();
          ctx.lineWidth = 1 * scaleFactor;
          ctx.strokeStyle = '#ffffff';
          ctx.stroke();

          ctx.beginPath();
          ctx.arc(x, y, Math.max(1, tipRadius * 0.4), 0, 2 * Math.PI);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
        } else if (isWrist) {
          ctx.beginPath();
          ctx.arc(x, y, wristRadius, 0, 2 * Math.PI);
          ctx.fillStyle = '#10b981'; // Emerald
          ctx.fill();
          ctx.lineWidth = 1 * scaleFactor;
          ctx.strokeStyle = '#ffffff';
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.arc(x, y, dotRadius, 0, 2 * Math.PI);
          ctx.fillStyle = '#0284c7';
          ctx.fill();
          ctx.lineWidth = 0.8 * scaleFactor;
          ctx.strokeStyle = '#e0f2fe';
          ctx.stroke();
        }
      });
    }
    ctx.restore();
  };

  // 7. Draw Live Hand Bounding Box with Label
  const drawHandBoundingBox = (ctx, landmarks, labelData, width, height, mirrored, handSide) => {
    if (!landmarks || landmarks.length === 0) return;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < landmarks.length; i++) {
      const pt = landmarks[i];
      const px = pt.x * width;
      const py = pt.y * height;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }

    const padding = 20;
    minX = Math.max(0, minX - padding);
    minY = Math.max(0, minY - padding);
    maxX = Math.min(width, maxX + padding);
    maxY = Math.min(height, maxY + padding);

    const boxWidth = maxX - minX;
    const boxHeight = maxY - minY;

    const conf = labelData?.confidence ?? 0;
    const word = labelData?.word || '';
    const percent = Math.round(conf * 100);

    let color = '#64748b'; // Slate grey for < 50%
    let labelText = `${handSide} | ...`;

    if (conf >= 0.8) {
      color = '#10b981'; // Green
      labelText = `${handSide} | ${word} ${percent}%`;
    } else if (conf >= 0.5) {
      color = '#f59e0b'; // Yellow
      labelText = `${handSide} | ${word} ${percent}%`;
    } else {
      color = '#64748b'; // Grey
      labelText = percent > 0 ? `${handSide} | ... ${percent}%` : `${handSide} | ...`;
    }

    const scaleFactor = Math.max(0.6, width / 1280);

    // A. Draw rounded bounding rectangle
    ctx.save();
    ctx.lineWidth = HAND_BOX_LINE_WIDTH * scaleFactor;
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 6 * scaleFactor;

    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(minX, minY, boxWidth, boxHeight, 10 * scaleFactor);
    } else {
      ctx.rect(minX, minY, boxWidth, boxHeight);
    }
    ctx.stroke();
    ctx.restore();

    // B. Measure label dimensions
    const labelFontSize = Math.round(HAND_BOX_LABEL_FONT_SIZE * scaleFactor);
    ctx.font = `bold ${labelFontSize}px "JetBrains Mono", Menlo, Consolas, monospace`;
    const textMetrics = ctx.measureText(labelText);
    const textWidth = textMetrics.width;
    const pillPaddingX = 8 * scaleFactor;
    const pillHeight = 20 * scaleFactor;
    const pillWidth = textWidth + pillPaddingX * 2;

    // Position: above box, or inside top edge if touches top of video
    let pillY = minY - pillHeight - 6;
    if (pillY < 4) {
      pillY = minY + 6; // Inside top edge
    }

    let pillX = minX;
    if (pillX + pillWidth > width - 4) {
      pillX = width - pillWidth - 4;
    }
    if (pillX < 4) {
      pillX = 4;
    }

    const pillCenterX = pillX + pillWidth / 2;
    const pillCenterY = pillY + pillHeight / 2;

    // C. Draw non-mirrored solid background pill with white text
    ctx.save();
    if (mirrored) {
      ctx.translate(pillCenterX, pillCenterY);
      ctx.scale(-1, 1);
      ctx.translate(-pillCenterX, -pillCenterY);
    }

    ctx.fillStyle = color;
    ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(pillX, pillY, pillWidth, pillHeight, 8);
    } else {
      ctx.rect(pillX, pillY, pillWidth, pillHeight);
    }
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(labelText, pillCenterX, pillCenterY + 1);

    ctx.restore();
  };

  // 8. Subtitle Update (single most recent recognized word, 4s fade)
  const showRecognizedWord = (word, confidence) => {
    const acceptedWord = word.toLowerCase();
    if (lastAcceptedWordRef.current === acceptedWord) return;
    lastAcceptedWordRef.current = acceptedWord;
    setIsSubtitleFaded(false);
    setCurrentSubtitle(word);
    setCurrentConfidence(confidence);
    setWordBuffer((prev) => [...prev, word].slice(-3));
    setSentenceBuilder((prev) => [...prev, { word, confidence }]);
    setHasTrailingSpace(false);

    if (subtitleFadeTimerRef.current) {
      clearTimeout(subtitleFadeTimerRef.current);
    }
    subtitleFadeTimerRef.current = null;
    subtitleFadeTimerRef.current = setTimeout(() => {
      setIsSubtitleFaded(true);
    }, 4000);
  };

  const handleClearSubtitle = () => {
    setCurrentSubtitle('');
    setCurrentConfidence(null);
    setIsSubtitleFaded(false);
    if (subtitleFadeTimerRef.current) {
      clearTimeout(subtitleFadeTimerRef.current);
      subtitleFadeTimerRef.current = null;
    }
    showNotification('Subtitles cleared', 'info');
  };

  const handleClearSentence = () => {
    setSentenceBuilder([]);
    setHasTrailingSpace(false);
    showNotification('Sentence cleared', 'info');
  };

  const handleDeleteLastWord = () => {
    setSentenceBuilder((prev) => prev.slice(0, -1));
    setHasTrailingSpace(false);
  };

  const handleInsertSpace = () => {
    if (sentenceBuilder.length > 0) setHasTrailingSpace(true);
  };

  const handleCapitalizeSentence = () => {
    setSentenceBuilder((prev) => prev.map((item, index) => (
      index === 0
        ? { ...item, word: item.word.charAt(0).toUpperCase() + item.word.slice(1) }
        : item
    )));
  };

  const handleSpeakSentence = () => {
    if (!sentenceText.trim()) {
      showNotification('Build or recognize a sentence first', 'info');
      return;
    }
    if (!('speechSynthesis' in window)) {
      showNotification('Text-to-speech is not supported by this browser', 'error');
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(sentenceText);
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);
    setIsSpeaking(true);
    window.speechSynthesis.speak(utterance);
  };

  const handleStopSpeaking = () => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    setIsSpeaking(false);
  };

  const handleExportSentence = () => {
    if (!sentenceText.trim()) {
      showNotification('No sentence to export', 'info');
      return;
    }
    const blob = new Blob([sentenceText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `signspeak_sentence_${Date.now()}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleCopySentence = () => {
    const textToCopy = sentenceText;
    if (!textToCopy) {
      showNotification('No sentence to copy', 'info');
      return;
    }
    navigator.clipboard.writeText(textToCopy).then(() => {
      showNotification('Sentence copied to clipboard!', 'success');
    }).catch(() => {
      showNotification('Failed to copy', 'error');
    });
  };

  const handleCopyWord = () => {
    const textToCopy = currentSubtitle;
    if (textToCopy) {
      navigator.clipboard.writeText(textToCopy).then(() => {
        showNotification(`Copied "${textToCopy}" to clipboard!`, 'success');
      }).catch(() => {
        showNotification('Failed to copy', 'error');
      });
    } else {
      showNotification('No active subtitle word to copy', 'info');
    }
  };

  // 9. Take Screenshot and Download
  const handleScreenshot = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const w = canvas.width || video.videoWidth || 1280;
    const h = canvas.height || video.videoHeight || 720;

    const offscreen = document.createElement('canvas');
    offscreen.width = w;
    offscreen.height = h;
    const octx = offscreen.getContext('2d');

    if (isMirroredRef.current) {
      octx.translate(w, 0);
      octx.scale(-1, 1);
    }

    if (isGhostModeRef.current) {
      octx.fillStyle = '#020617';
      octx.fillRect(0, 0, w, h);
      octx.strokeStyle = 'rgba(6, 182, 212, 0.15)';
      octx.lineWidth = 1;
      for (let x = 0; x < w; x += 40) {
        octx.beginPath(); octx.moveTo(x, 0); octx.lineTo(x, h); octx.stroke();
      }
      for (let y = 0; y < h; y += 40) {
        octx.beginPath(); octx.moveTo(0, y); octx.lineTo(w, y); octx.stroke();
      }
    } else {
      octx.drawImage(video, 0, 0, w, h);
    }

    octx.drawImage(canvas, 0, 0, w, h);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const link = document.createElement('a');
    link.download = `signspeak_hud_${timestamp}.png`;
    link.href = offscreen.toDataURL('image/png');
    link.click();

    showNotification('HUD Screenshot captured and downloaded!', 'success');
  };

  // 10. Finalize Gesture & Recognize for Subtitle Bar
  const finishGestureAndRecognize = (now) => {
    const frames = collectedFramesRef.current;
    const count = frames.length;

    isCollectingRef.current = false;
    gestureStartTimeRef.current = null;
    noHandsStartTimeRef.current = null;
    prevWristCoordsRef.current = null;
    collectedFramesRef.current = [];
    setLiveCollectingFrames(0);
    cooldownUntilRef.current = now + 400;

    if (count < 8) return;

    const resampled = resampleFrames(frames, 32);

    if (!aiModelRef.current || !labelsRef.current || labelsRef.current.length === 0) {
      return;
    }

    try {
      const { predictions, top1 } = predictSign(resampled, aiModelRef.current, labelsRef.current);
      const top3 = predictions.slice(0, 3);

      setDebugPredictionInfo({
        top3,
        frameCount: count,
        timestamp: Date.now()
      });

      if (top1 && top1.confidence >= ACCEPT_CONFIDENCE) {
        showRecognizedWord(top1.word, top1.confidence);
      } else if (top1) {
        setIsSubtitleFaded(false);
        setCurrentSubtitle('Uncertain - please repeat');
        setCurrentConfidence(null);
        if (subtitleFadeTimerRef.current) {
          clearTimeout(subtitleFadeTimerRef.current);
        }
        subtitleFadeTimerRef.current = setTimeout(() => {
          setCurrentSubtitle((current) => (
            current === 'Uncertain - please repeat' ? '' : current
          ));
          subtitleFadeTimerRef.current = null;
        }, 2000);
      }
    } catch (err) {
      console.error('Sign recognition error:', err);
    }
  };

  // Process live frame for subtitle collection
  const handleLiveRecognitionFrame = (results, hasHands, now, frameFeatures = null, frameWrists = null) => {
    if (hasHands) {
      if (
        handAbsentSinceRef.current !== null &&
        now - handAbsentSinceRef.current >= 600
      ) {
        lastAcceptedWordRef.current = null;
      }
      handAbsentSinceRef.current = null;
    } else if (handAbsentSinceRef.current === null) {
      handAbsentSinceRef.current = now;
    }

    if (now < cooldownUntilRef.current) return;

    if (hasHands) {
      if (!isCollectingRef.current) {
        isCollectingRef.current = true;
        gestureStartTimeRef.current = now;
        noHandsStartTimeRef.current = null;
        collectedFramesRef.current = [];
        prevWristCoordsRef.current = null;
      } else {
        noHandsStartTimeRef.current = null;
      }

      let features = frameFeatures;
      let wristCoords = frameWrists;
      if (!features) {
        const featData = extractFrameFeatures(
          results,
          prevWristCoordsRef.current,
          handModeRef.current,
          isMirroredRef.current
        );
        features = featData.features;
        wristCoords = featData.wristCoords;
      }

      collectedFramesRef.current.push(features);
      prevWristCoordsRef.current = wristCoords;

      const currentCount = collectedFramesRef.current.length;
      setLiveCollectingFrames(currentCount);

      if (now - gestureStartTimeRef.current >= 3000) {
        finishGestureAndRecognize(now);
      }
    } else {
      if (isCollectingRef.current) {
        if (noHandsStartTimeRef.current === null) {
          noHandsStartTimeRef.current = now;
        } else if (now - noHandsStartTimeRef.current >= 600) {
          finishGestureAndRecognize(now);
        }
      }
    }
  };

  // 11. Real-time Detection Loop
  const startDetectionLoop = () => {
    let lastProcessedTime = -1;

    const loop = () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const landmarker = landmarkerRef.current;

      if (
        video &&
        canvas &&
        landmarker &&
        video.readyState >= 2 &&
        !video.paused &&
        !isPausedRef.current
      ) {
        if (
          video.videoWidth > 0 &&
          (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight)
        ) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
        }

        const now = performance.now();

        // FPS Calculation
        frameCountRef.current += 1;
        totalFramesRef.current += 1;
        setTotalFramesProcessed(totalFramesRef.current);

        if (now - lastFpsCalcRef.current >= 1000) {
          const currentFps = Math.round((frameCountRef.current * 1000) / (now - lastFpsCalcRef.current));
          setFps(currentFps);
          fpsHistoryRef.current.push(currentFps);
          if (fpsHistoryRef.current.length > 20) fpsHistoryRef.current.shift();
          const avg = (
            fpsHistoryRef.current.reduce((a, b) => a + b, 0) / fpsHistoryRef.current.length
          ).toFixed(1);
          setAvgFps(avg);

          frameCountRef.current = 0;
          lastFpsCalcRef.current = now;
        }

        if (now > lastProcessedTime + 10) {
          lastProcessedTime = now;
          try {
            const results = landmarker.detectForVideo(video, now);
            latestLandmarkerResultRef.current = results;

            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            // Filter hands according to handMode option ('both' | 'right' | 'left')
            const rawLandmarks = results?.landmarks || [];
            const rawHandedness = results?.handedness || results?.handednesses || [];
            const activeHands = [];

            for (let i = 0; i < rawLandmarks.length; i++) {
              const lm = rawLandmarks[i];
              const hEntry = rawHandedness?.[i];
              const cat = Array.isArray(hEntry) ? hEntry[0]?.categoryName : hEntry?.categoryName;
              const realSide = getRealHandSide(cat, isMirroredRef.current);
              const score = Array.isArray(hEntry) ? hEntry[0]?.score : hEntry?.score;

              if (handModeRef.current === 'both') {
                activeHands.push({ landmarks: lm, side: realSide, score: score ?? 1 });
              } else if (handModeRef.current === 'right' && realSide === 'Right') {
                activeHands.push({ landmarks: lm, side: realSide, score: score ?? 1 });
              } else if (handModeRef.current === 'left' && realSide === 'Left') {
                activeHands.push({ landmarks: lm, side: realSide, score: score ?? 1 });
              }
            }

            const hasHands = activeHands.length > 0;
            setDetectedHandsCount(activeHands.length);

            let currentFeatures = null;
            let currentWristCoords = null;

            if (hasHands) {
              // Extract 138 features respecting handMode
              const featData = extractFrameFeatures(
                results,
                prevWristCoordsRef.current,
                handModeRef.current,
                isMirroredRef.current
              );
              currentFeatures = featData.features;
              currentWristCoords = featData.wristCoords;

              // Maintain 32-frame rolling buffer
              rollingBufferRef.current.push(currentFeatures);
              if (rollingBufferRef.current.length > 32) {
                rollingBufferRef.current.shift();
              }

              // Live prediction every 300ms while hand is visible and buffer has >= 12 frames
              if (
                aiModelRef.current &&
                labelsRef.current.length > 0 &&
                now - lastLivePredTimeRef.current >= 300 &&
                rollingBufferRef.current.length >= 12
              ) {
                lastLivePredTimeRef.current = now;
                const resampledRolling = resampleFrames(rollingBufferRef.current, 32);

                try {
                  const t0 = performance.now();
                  const { rawProbs } = predictSign(
                    resampledRolling,
                    aiModelRef.current,
                    labelsRef.current
                  );
                  const latency = (performance.now() - t0).toFixed(1);
                  setModelLatency(latency);

                  if (rawProbs) {
                    predHistoryRef.current.push(rawProbs);
                    if (predHistoryRef.current.length > 3) {
                      predHistoryRef.current.shift();
                    }

                    // Anti-flicker probability averaging across last 3 predictions
                    const numHistory = predHistoryRef.current.length;
                    const numClasses = labelsRef.current.length;
                    let bestIndex = 0;
                    let bestConfidence = -1;

                    for (let c = 0; c < numClasses; c++) {
                      let sumProb = 0;
                      for (let h = 0; h < numHistory; h++) {
                        sumProb += predHistoryRef.current[h][c];
                      }
                      const avgProb = sumProb / numHistory;
                      if (avgProb > bestConfidence) {
                        bestConfidence = avgProb;
                        bestIndex = c;
                      }
                    }

                    const topWord = labelsRef.current[bestIndex];

                    // Track last 10 predictions for stability metric
                    last10PredictionsRef.current.push(topWord);
                    if (last10PredictionsRef.current.length > 10) {
                      last10PredictionsRef.current.shift();
                    }

                    const matchCount = last10PredictionsRef.current.filter((w) => w === topWord).length;
                    const stabilityPct = Math.round(
                      (matchCount / last10PredictionsRef.current.length) * 100
                    );

                    liveLabelRef.current = {
                      word: topWord,
                      confidence: bestConfidence
                    };

                    const topHandScore = Math.round((activeHands[0]?.score ?? 0.95) * 100);

                    setHudData({
                      currentWord: topWord,
                      confidence: Math.round(bestConfidence * 100),
                      stability: stabilityPct,
                      handConfidence: topHandScore,
                      handSide: activeHands[0]?.side || 'Right'
                    });
                  }
                } catch (liveErr) {
                  console.error('Live label prediction error:', liveErr);
                }
              }

              // Draw landmarks dots & skeleton lines
              for (const h of activeHands) {
                drawHandLandmarks(
                  ctx,
                  h.landmarks,
                  canvas.width,
                  canvas.height,
                  showSkeletonRef.current,
                  showLandmarksRef.current
                );
              }

              // Draw hand bounding boxes with prediction pills
              if (showHandBoxRef.current) {
                for (const h of activeHands) {
                  drawHandBoundingBox(
                    ctx,
                    h.landmarks,
                    liveLabelRef.current,
                    canvas.width,
                    canvas.height,
                    isMirroredRef.current,
                    h.side
                  );
                }
              }
            } else {
              setDetectedHandsCount(0);
              rollingBufferRef.current = [];
              predHistoryRef.current = [];
              liveLabelRef.current = { word: '...', confidence: 0 };
              setHudData((prev) => ({
                ...prev,
                currentWord: '---',
                confidence: 0,
                stability: 0
              }));
            }

            // Subtitle Bar live collection
            if (activeTabRef.current === 'live' && aiModelRef.current && labelsRef.current.length > 0) {
              handleLiveRecognitionFrame(results, hasHands, now, currentFeatures, currentWristCoords);
            }
          } catch (err) {
            console.error('Detection frame error:', err);
          }
        }
      }

      animFrameIdRef.current = requestAnimationFrame(loop);
    };

    if (animFrameIdRef.current) {
      cancelAnimationFrame(animFrameIdRef.current);
    }
    animFrameIdRef.current = requestAnimationFrame(loop);
  };

  // 12. Global Keyboard Shortcuts Listener
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Ignore if typing inside input / select
      if (
        e.target.tagName === 'INPUT' ||
        e.target.tagName === 'SELECT' ||
        e.target.tagName === 'TEXTAREA'
      ) {
        return;
      }

      const key = e.key.toUpperCase();
      switch (key) {
        case 'P':
          setIsPaused((prev) => !prev);
          showNotification(isPausedRef.current ? 'Resumed detection' : 'Paused detection', 'info');
          break;
        case 'S':
          handleScreenshot();
          break;
        case 'E':
          handleExportSentence();
          break;
        case 'BACKSPACE':
          e.preventDefault();
          handleDeleteLastWord();
          break;
        case 'R':
          setActiveTab((prev) => (prev === 'live' ? 'record' : 'live'));
          break;
        case 'L':
          setShowLandmarks((prev) => !prev);
          showNotification(showLandmarksRef.current ? 'Landmarks hidden' : 'Landmarks visible', 'info');
          break;
        case 'K':
          setShowSkeleton((prev) => !prev);
          showNotification(showSkeletonRef.current ? 'Skeleton hidden' : 'Skeleton visible', 'info');
          break;
        case 'H':
          setShowHud((prev) => !prev);
          showNotification(showHudRef.current ? 'HUD hidden' : 'HUD visible', 'info');
          break;
        case 'C':
          handleClearSubtitle();
          break;
        case 'X':
          handleCopyWord();
          break;
        case 'G':
          setIsGhostMode((prev) => !prev);
          showNotification(isGhostModeRef.current ? 'Ghost mode OFF' : 'Ghost invisibility ON', 'success');
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentSubtitle, sentenceBuilder, hasTrailingSpace]);

  // 13. Recording Mode Handlers (Dataset Studio)
  const startRecordingFlow = () => {
    if (cameraStatus !== 'active') {
      showNotification('Please start the webcam first before recording.', 'error');
      return;
    }
    if (recordingState !== 'idle') return;

    setRecordingState('countdown');
    setCountdown(3);

    let currentCount = 3;
    countdownTimerRef.current = setInterval(() => {
      currentCount -= 1;
      if (currentCount > 0) {
        setCountdown(currentCount);
      } else {
        clearInterval(countdownTimerRef.current);
        countdownTimerRef.current = null;
        setCountdown(null);
        startCapturingFrames();
      }
    }, 1000);
  };

  const startCapturingFrames = () => {
    setRecordingState('recording');
    setRecordedFramesCount(0);

    const capturedFrames = [];
    let prevWrist = null;
    let lastResult = null;
    let handAbsentSince = null;
    let finished = false;
    const startedAt = performance.now();

    const finishCapture = async () => {
      if (finished) return;
      finished = true;
      clearInterval(recordIntervalRef.current);
      recordIntervalRef.current = null;

      if (capturedFrames.length < CAPTURE_MIN_HAND_FRAMES) {
        setRecordingState('idle');
        setRecordedFramesCount(0);
        showNotification(
          `Only ${capturedFrames.length} hand frames captured. Keep your hand in view and sign again.`,
          'error'
        );
        return;
      }

      setRecordingState('saving');
      try {
        await saveRecording({
          label: selectedWord,
          frames: resampleFrames(capturedFrames, FRAMES_PER_SAMPLE),
          timestamp: Date.now()
        });

        const updatedCounts = await getCountsByWord();
        setWordCounts(updatedCounts);

        showNotification(
          `Saved "${selectedWord}" sample #${updatedCounts[selectedWord]} (${updatedCounts[selectedWord]} / ${TARGET_SAMPLES_PER_WORD})`,
          'success'
        );
      } catch (err) {
        console.error('Error saving recording to IndexedDB:', err);
        showNotification(`Failed to save recording: ${err.message}`, 'error');
      } finally {
        setRecordingState('idle');
        setRecordedFramesCount(0);
      }
    };

    recordIntervalRef.current = setInterval(() => {
      const now = performance.now();
      const result = latestLandmarkerResultRef.current;

      // Use each detection result once, the same way live recognition does
      if (result && result !== lastResult) {
        lastResult = result;
        const { features, wristCoords, hasHand } = extractFrameFeatures(
          result,
          prevWrist,
          handModeRef.current,
          isMirroredRef.current
        );

        if (hasHand) {
          capturedFrames.push(features);
          prevWrist = wristCoords;
          handAbsentSince = null;
          setRecordedFramesCount(capturedFrames.length);
        } else if (handAbsentSince === null) {
          handAbsentSince = now;
        }
      }

      const handGoneLongEnough =
        capturedFrames.length > 0 &&
        handAbsentSince !== null &&
        now - handAbsentSince >= CAPTURE_END_SILENCE_MS;
      const timedOut = now - startedAt >= CAPTURE_MAX_MS;

      if (handGoneLongEnough || timedOut) {
        finishCapture();
      }
    }, 33);
  };

  const handleDeleteLastRecording = async () => {
    if (recordingState !== 'idle') return;

    try {
      const deletedRecord = await deleteLastRecording();
      if (deletedRecord) {
        const updatedCounts = await getCountsByWord();
        setWordCounts(updatedCounts);
        showNotification(
          `Deleted last recording for "${deletedRecord.label}" (ID #${deletedRecord.id})`,
          'info'
        );
      } else {
        showNotification('No recordings found in IndexedDB to delete.', 'info');
      }
    } catch (err) {
      console.error('Failed to delete recording:', err);
      showNotification(`Error deleting recording: ${err.message}`, 'error');
    }
  };

  const handleDownloadDataset = async () => {
    try {
      const allRecordings = await getAllRecordings();
      if (!allRecordings || allRecordings.length === 0) {
        showNotification('No recordings in IndexedDB yet! Record some words first.', 'info');
        return;
      }

      const totalSamples = allRecordings.length;
      const datasetExport = {
        datasetName: 'SignSpeak Hand Landmark Dataset',
        exportDate: new Date().toISOString(),
        totalSamples,
        targetPerWord: TARGET_SAMPLES_PER_WORD,
        vocabulary: VOCABULARY,
        samplesPerWord: wordCounts,
        schema: {
          schemaVersion: SCHEMA_VERSION,
          framesPerSample: FRAMES_PER_SAMPLE,
          featuresPerFrame: FEATURES_PER_FRAME,
          description: 'Same feature pipeline as live recognition (src/utils/features.js)'
        },
        recordings: allRecordings
      };

      const blob = new Blob([JSON.stringify(datasetExport, null, 2)], {
        type: 'application/json'
      });
      const url = URL.createObjectURL(blob);
      const downloadAnchor = document.createElement('a');
      const dateStr = new Date().toISOString().slice(0, 10);
      downloadAnchor.href = url;
      downloadAnchor.download = `signspeak_dataset_${dateStr}_${totalSamples}samples.json`;
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
      URL.revokeObjectURL(url);

      showNotification(`Downloaded ${totalSamples} samples dataset file!`, 'success');
    } catch (err) {
      console.error('Failed to export dataset:', err);
      showNotification(`Failed to download dataset: ${err.message}`, 'error');
    }
  };

  // 14. Sample Storage Handlers (IndexedDB 32-Frame Feature Store)
  const [storageWord, setStorageWord] = useState(
    VOCABULARY.includes('hello') ? 'hello' : VOCABULARY[0]
  );

  const handleSaveSample = async () => {
    if (cameraStatus !== 'active') {
      showNotification('Please start webcam first before saving samples.', 'error');
      return;
    }

    const buffer = rollingBufferRef.current;
    if (!buffer || buffer.length === 0) {
      showNotification('No hand features in buffer yet. Move your hand in view!', 'error');
      return;
    }

    // Resample the rolling buffer to exactly 32 frames of hand features
    const framesToSave = resampleFrames(buffer, 32);

    try {
      await saveRecording({
        label: storageWord,
        frames: framesToSave,
        timestamp: Date.now()
      });

      const updated = await getCountsByWord();
      setWordCounts(updated);
      showNotification(
        `Saved sample for "${storageWord}" (${updated[storageWord]} total)`,
        'success'
      );
    } catch (err) {
      console.error('Error saving sample to IndexedDB:', err);
      showNotification(`Failed to save sample: ${err.message}`, 'error');
    }
  };

  const handleDownloadSamples = async () => {
    try {
      const allRecordings = await getAllRecordings();
      if (!allRecordings || allRecordings.length === 0) {
        showNotification('No samples stored in IndexedDB yet.', 'info');
        return;
      }

      const total = allRecordings.length;
      const exportData = {
        datasetName: 'SignSpeak Hand Feature Samples',
        exportedAt: new Date().toISOString(),
        totalSamples: total,
        vocabulary: VOCABULARY,
        countsPerWord: wordCounts,
        schema: {
          schemaVersion: SCHEMA_VERSION,
          framesPerSample: FRAMES_PER_SAMPLE,
          featuresPerFrame: FEATURES_PER_FRAME,
          description: 'Same feature pipeline as live recognition (src/utils/features.js)'
        },
        samples: allRecordings
      };

      const blob = new Blob([JSON.stringify(exportData, null, 2)], {
        type: 'application/json'
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const dateStr = new Date().toISOString().slice(0, 10);
      link.href = url;
      link.download = `signspeak_samples_${dateStr}_${total}samples.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);

      showNotification(`Downloaded ${total} samples as JSON file!`, 'success');
    } catch (err) {
      console.error('Download samples error:', err);
      showNotification(`Error downloading samples: ${err.message}`, 'error');
    }
  };

  const handleClearSamples = async () => {
    if (window.confirm('Are you sure you want to clear all stored samples from IndexedDB?')) {
      try {
        await clearAllRecordings();
        const updated = await getCountsByWord();
        setWordCounts(updated);
        showNotification('All samples cleared from IndexedDB.', 'info');
      } catch (err) {
        console.error('Clear samples error:', err);
        showNotification(`Error clearing samples: ${err.message}`, 'error');
      }
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (animFrameIdRef.current) cancelAnimationFrame(animFrameIdRef.current);
      if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
      if (recordIntervalRef.current) clearInterval(recordIntervalRef.current);
      if (notificationTimeoutRef.current) clearTimeout(notificationTimeoutRef.current);
      if (subtitleFadeTimerRef.current) clearTimeout(subtitleFadeTimerRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const totalRecordingsCount = Object.values(wordCounts).reduce((acc, count) => acc + count, 0);
  const currentWordCount = wordCounts[selectedWord] || 0;
  const currentProgressPercent = Math.min(
    100,
    Math.round((currentWordCount / TARGET_SAMPLES_PER_WORD) * 100)
  );

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-between p-3 md:p-5 select-none font-sans">
      {/* HEADER: AI Vision Control Room Bar */}
      <header className="w-full max-w-6xl flex flex-col sm:flex-row items-center justify-between gap-3 py-2.5 px-5 bg-slate-900/75 backdrop-blur-xl border border-cyan-500/25 rounded-2xl shadow-xl shadow-cyan-950/20">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-cyan-500 via-blue-600 to-indigo-600 flex items-center justify-center shadow-lg shadow-cyan-500/30">
            <Hand className="w-5 h-5 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl md:text-2xl font-black tracking-wider bg-gradient-to-r from-white via-cyan-200 to-cyan-400 bg-clip-text text-transparent font-mono">
                SignSpeak
              </h1>
              <span className="px-2 py-0.5 text-[10px] font-mono font-bold uppercase bg-cyan-950/90 text-cyan-300 border border-cyan-500/40 rounded-full tracking-wider">
                HUD Control Room
              </span>
            </div>
            <p className="text-[11px] text-slate-400 font-mono hidden sm:block">
              Sign language to live subtitles • Neural client-side engine
            </p>
          </div>
        </div>

        {/* Tab & Primary Mode Switcher */}
        <div className="flex items-center gap-3">
          <div className="flex items-center bg-slate-950/90 border border-slate-800 p-1 rounded-xl shadow-inner font-mono text-xs">
            <button
              onClick={() => setActiveTab('live')}
              aria-pressed={activeTab === 'live'}
              className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg font-semibold transition-all ${
                activeTab === 'live'
                  ? 'bg-gradient-to-r from-cyan-500 to-blue-600 text-white shadow-md shadow-cyan-500/30'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Play className="w-3.5 h-3.5" />
              <span>Live Vision</span>
            </button>
            <button
              onClick={() => setActiveTab('record')}
              aria-pressed={activeTab === 'record'}
              className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg font-semibold transition-all ${
                activeTab === 'record'
                  ? 'bg-gradient-to-r from-rose-500 to-red-600 text-white shadow-md shadow-rose-500/30'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Radio className="w-3.5 h-3.5" />
              <span>Record Studio</span>
            </button>
          </div>

          {/* Model Loading Status Indicator */}
          <div className="flex items-center gap-2 text-xs font-mono">
            {modelLoading || aiModelLoading ? (
              <div className="flex items-center gap-2 px-3 py-1 bg-amber-950/50 border border-amber-600/50 text-amber-300 rounded-full animate-pulse">
                <RefreshCw className="w-3 h-3 animate-spin" />
                <span>Loading AI...</span>
              </div>
            ) : modelReady && aiModelReady ? (
              <div className="flex items-center gap-1.5 px-2.5 py-1 bg-emerald-950/50 border border-emerald-500/40 text-emerald-300 rounded-full">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span className="hidden md:inline">Neural AI</span> Ready
              </div>
            ) : null}
          </div>
        </div>
      </header>

      {/* MAIN VIDEO & HUD STAGE */}
      <main className="w-full max-w-4xl my-2 sm:my-3 flex-1 flex flex-col items-center justify-center">
        {/* Error Notification Alert */}
        {(errorMessage || aiModelError) && (
          <div className="w-full mb-3 p-3.5 bg-red-950/60 border border-red-700/60 rounded-xl flex items-start gap-3 text-red-200 backdrop-blur-md">
            <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            <div className="text-xs md:text-sm">
              <p className="font-bold text-red-100">Camera or Model Notice</p>
              <p>{errorMessage || aiModelError}</p>
            </div>
          </div>
        )}

        {/* Video & Canvas Stage */}
        <div
          className={`relative w-full aspect-video min-h-[420px] max-h-[56vh] bg-slate-950 rounded-2xl overflow-hidden border shadow-2xl transition-all duration-300 ${
            recordingState === 'recording'
              ? 'border-rose-500 shadow-rose-950/60 ring-2 ring-rose-500/50'
              : 'border-cyan-500/30 shadow-cyan-950/30'
          }`}
        >
          {/* Cyber Holographic Grid for Ghost Mode */}
          <div
            className={`absolute inset-0 pointer-events-none transition-opacity duration-500 ${
              isGhostMode ? 'opacity-100' : 'opacity-0'
            }`}
            style={{
              backgroundImage: `linear-gradient(rgba(6, 182, 212, 0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(6, 182, 212, 0.08) 1px, transparent 1px)`,
              backgroundSize: '36px 36px',
              backgroundColor: '#020617'
            }}
          />

          {/* Mirrored container for webcam and canvas */}
          <div
            className={`w-full h-full relative transition-transform duration-300 ${
              isMirrored ? '-scale-x-100' : 'scale-x-100'
            }`}
          >
            {/* Webcam Feed (Invisible in Ghost Mode) */}
            <video
              ref={videoRef}
              playsInline
              muted
              className={`w-full h-full object-cover transition-opacity duration-300 ${
                isGhostMode ? 'opacity-0' : 'opacity-100'
              }`}
            />

            {/* Canvas Overlay: Skeleton, Landmarks, Bounding Boxes */}
            <canvas
              ref={canvasRef}
              className="absolute inset-0 w-full h-full object-cover pointer-events-none"
            />
          </div>

          {/* PAUSED BANNER OVERLAY */}
          {isPaused && (
            <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/60 backdrop-blur-sm pointer-events-none">
              <div className="px-6 py-3 rounded-2xl bg-cyan-950/90 border border-cyan-400/80 text-cyan-200 font-mono font-bold tracking-widest text-lg shadow-2xl flex items-center gap-3 animate-pulse">
                <Pause className="w-6 h-6 text-cyan-400" />
                <span>PAUSED [PRESS P TO RESUME]</span>
              </div>
            </div>
          )}

          {/* GHOST MODE ACTIVE BADGE */}
          {isGhostMode && cameraStatus === 'active' && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
              <div className="flex items-center gap-2 px-3.5 py-1 rounded-full bg-cyan-950/80 backdrop-blur-md border border-cyan-400/60 text-cyan-300 font-mono text-[11px] font-bold shadow-lg shadow-cyan-950/50">
                <Sparkles className="w-3.5 h-3.5 text-cyan-400 animate-spin" />
                <span>GHOST INVISIBILITY ACTIVE</span>
              </div>
            </div>
          )}

          {/* HUD OVERLAY (TOP-LEFT & TOP-RIGHT PANELS) */}
          {showHud && cameraStatus === 'active' && (
            <>
              {/* TOP-LEFT PANEL: "SIGN LANGUAGE RECOGNITION" Telemetry (Compact 170px) */}
              <div
                style={{ maxWidth: `${HUD_PANEL_MAX_WIDTH}px` }}
                className="absolute top-2.5 left-2.5 z-20 w-full p-2 bg-slate-950/85 backdrop-blur-xl border border-cyan-500/35 rounded-xl shadow-xl shadow-cyan-950/30 text-[10px] font-mono select-none pointer-events-auto"
              >
                <div className="flex items-center justify-between pb-1 mb-1 border-b border-cyan-500/20">
                  <div className="flex items-center gap-1 text-cyan-400 font-bold tracking-wider text-[10px] truncate">
                    <Terminal className="w-3 h-3 shrink-0" />
                    <span className="truncate">TELEMETRY</span>
                  </div>
                  <span className="text-[9px] text-slate-400 shrink-0">{currentTime}</span>
                </div>

                <div className="space-y-1 text-[10px]">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">STATUS:</span>
                    <span className="flex items-center gap-1 font-bold">
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${
                          detectedHandsCount > 0
                            ? 'bg-emerald-400 animate-ping'
                            : 'bg-amber-400'
                        }`}
                      />
                      <span className={detectedHandsCount > 0 ? 'text-emerald-400' : 'text-amber-400'}>
                        {detectedHandsCount > 0 ? 'TRACKING' : 'SEARCH'}
                      </span>
                    </span>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">FPS:</span>
                    <span className="text-slate-200">
                      <span className="font-bold text-cyan-300">{fps}</span>{' '}
                      <span className="text-[9px] text-slate-500">({avgFps})</span>
                    </span>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">LATENCY:</span>
                    <span className="text-emerald-400 font-semibold">{modelLatency}ms</span>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">HANDS:</span>
                    <span className="text-slate-200 font-bold">
                      {detectedHandsCount === 0
                        ? '0'
                        : detectedHandsCount === 1
                        ? `1 (${hudData.handSide.slice(0, 1)})`
                        : '2 (Dual)'}
                    </span>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">FRAMES:</span>
                    <span className="text-slate-400 font-mono">#{totalFramesProcessed}</span>
                  </div>
                </div>
              </div>

              {/* TOP-RIGHT PANEL: "RECOGNITION" Diagnostics (Compact 170px) */}
              <div
                style={{ maxWidth: `${HUD_PANEL_MAX_WIDTH}px` }}
                className="absolute top-2.5 right-2.5 z-20 w-full p-2 bg-slate-950/85 backdrop-blur-xl border border-cyan-500/35 rounded-xl shadow-xl shadow-cyan-950/30 text-[10px] font-mono select-none pointer-events-auto"
              >
                <div className="flex items-center justify-between pb-1 mb-1 border-b border-cyan-500/20">
                  <div className="flex items-center gap-1 text-cyan-400 font-bold tracking-wider text-[10px] truncate">
                    <Activity className="w-3 h-3 shrink-0" />
                    <span className="truncate">RECOGNITION</span>
                  </div>
                  <span className="px-1 py-0.2 rounded bg-cyan-950 text-cyan-300 border border-cyan-800 text-[9px] shrink-0">
                    300ms
                  </span>
                </div>

                <div className="space-y-1 text-[10px]">
                  {/* Current Word */}
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">WORD:</span>
                    <span className="text-xs font-black text-cyan-200 capitalize tracking-wide truncate max-w-[90px]">
                      {hudData.currentWord}
                    </span>
                  </div>

                  {/* Confidence Progress Bar */}
                  <div>
                    <div className="flex items-center justify-between text-[9px] mb-0.5">
                      <span className="text-slate-400">CONFIDENCE:</span>
                      <span className={`font-bold ${hudData.confidence >= 80 ? 'text-emerald-400' : hudData.confidence >= 50 ? 'text-amber-400' : 'text-slate-400'}`}>
                        {hudData.confidence}%
                      </span>
                    </div>
                    <div
                      style={{ height: `${HUD_PROGRESS_BAR_HEIGHT}px` }}
                      className="w-full bg-slate-900 rounded-full overflow-hidden border border-slate-800"
                    >
                      <div
                        className={`h-full rounded-full transition-all duration-200 ${
                          hudData.confidence >= 80
                            ? 'bg-gradient-to-r from-emerald-500 to-teal-400 shadow-sm shadow-emerald-400/50'
                            : hudData.confidence >= 50
                            ? 'bg-gradient-to-r from-amber-500 to-yellow-400'
                            : 'bg-slate-600'
                        }`}
                        style={{ width: `${Math.min(100, hudData.confidence)}%` }}
                      />
                    </div>
                  </div>

                  {/* Stability Progress Bar */}
                  <div>
                    <div className="flex items-center justify-between text-[9px] mb-0.5">
                      <span className="text-slate-400">STABILITY:</span>
                      <span className="text-cyan-300 font-bold">{hudData.stability}%</span>
                    </div>
                    <div
                      style={{ height: `${HUD_PROGRESS_BAR_HEIGHT}px` }}
                      className="w-full bg-slate-900 rounded-full overflow-hidden border border-slate-800"
                    >
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-blue-500 transition-all duration-200"
                        style={{ width: `${Math.min(100, hudData.stability)}%` }}
                      />
                    </div>
                  </div>

                  {/* Word Buffer: Last 3 predicted words */}
                  <div className="pt-0.5 border-t border-slate-800/80">
                    <div className="text-[9px] text-slate-400 mb-0.5">BUFFER (LAST 3):</div>
                    <div className="flex items-center gap-1 overflow-hidden">
                      {wordBuffer.length > 0 ? (
                        wordBuffer.map((w, idx) => (
                          <span
                            key={idx}
                            className="px-1.5 py-0.2 rounded bg-slate-900 border border-slate-700 text-slate-200 text-[9px] font-bold capitalize truncate"
                          >
                            {w}
                          </span>
                        ))
                      ) : (
                        <span className="text-[9px] text-slate-500 italic">Empty</span>
                      )}
                    </div>
                  </div>

                  {/* MediaPipe Handedness Score */}
                  <div className="flex items-center justify-between text-[9px] pt-0.5">
                    <span className="text-slate-400">HAND:</span>
                    <span className="text-slate-300">
                      {hudData.handConfidence > 0 ? `${hudData.handConfidence}% (${hudData.handSide.slice(0, 1)})` : '---'}
                    </span>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* 3-2-1 Countdown Overlay for Recording Studio */}
          {countdown !== null && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/70 backdrop-blur-md pointer-events-none animate-in fade-in duration-200">
              <div className="w-28 h-28 md:w-36 md:h-36 rounded-full border-4 border-rose-500 bg-rose-950/80 flex items-center justify-center shadow-2xl shadow-rose-500/50 transform scale-110">
                <span className="text-6xl md:text-7xl font-black text-rose-200 font-mono">
                  {countdown}
                </span>
              </div>
              <p className="mt-4 text-base md:text-lg font-bold text-rose-200 tracking-wider uppercase drop-shadow-md">
                Get ready to sign: "{selectedWord}"
              </p>
            </div>
          )}

          {/* Recording Badge Indicator */}
          {recordingState === 'recording' && (
            <div className="absolute top-4 right-16 z-20 flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-rose-950/90 border border-rose-500 text-xs font-bold text-rose-300 shadow-xl shadow-rose-950/50 animate-pulse font-mono">
              <span className="w-2.5 h-2.5 rounded-full bg-rose-500 animate-ping" />
              <span>RECORDING: {recordedFramesCount} HAND FRAMES</span>
            </div>
          )}

          {/* Camera Inactive Placeholder */}
          {cameraStatus !== 'active' && (
            <div className="absolute inset-0 flex flex-col items-center justify-start pt-8 sm:pt-10 md:pt-12 bg-slate-950/95 backdrop-blur-md z-10 p-6 text-center">
              {cameraStatus === 'requesting' ? (
                <div className="flex flex-col items-center gap-3">
                  <div className="w-14 h-14 rounded-full border-4 border-cyan-500/30 border-t-cyan-400 animate-spin flex items-center justify-center">
                    <Video className="w-6 h-6 text-cyan-400" />
                  </div>
                  <p className="text-base font-semibold text-slate-200 font-mono">Accessing Camera Feed...</p>
                  <p className="text-xs text-slate-400 max-w-sm">
                    Please approve camera permissions when prompted by your browser.
                  </p>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3 sm:gap-3.5">
                  <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-2xl bg-slate-900 border border-slate-700/80 flex items-center justify-center shadow-inner">
                    <VideoOff className="w-7 h-7 sm:w-8 sm:h-8 text-slate-400" />
                  </div>
                  <div>
                    <h3 className="text-base sm:text-lg font-bold text-slate-200 font-mono">Camera Offline</h3>
                    <p className="text-xs text-slate-400 max-w-sm mt-1">
                      Start your camera to enable hand tracking, HUD telemetry, and real-time sign recognition.
                    </p>
                  </div>
                  <button
                    onClick={startCamera}
                    disabled={modelLoading}
                    className="flex items-center gap-2 px-6 py-2.5 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-mono font-bold rounded-xl shadow-lg shadow-cyan-500/25 transition-all transform hover:scale-105 active:scale-95 disabled:opacity-50 cursor-pointer pointer-events-auto"
                  >
                    <Video className="w-4 h-4" />
                    <span>Initialize Camera</span>
                  </button>
                </div>
              )}
            </div>
          )}

          {/* SUBTITLE BAR (Single Most Recent Recognized Word, 4s Fade) */}
          <div
            className={`absolute ${
              showHud ? 'bottom-11 sm:bottom-12' : 'bottom-3 sm:bottom-4'
            } left-1/2 -translate-x-1/2 z-20 w-[92%] max-w-3xl pointer-events-none transition-all duration-200`}
          >
            <div className="flex flex-col items-center">
              <div className="px-5 py-2.5 sm:px-6 sm:py-3 bg-black/85 backdrop-blur-xl rounded-2xl border border-cyan-500/30 shadow-2xl text-center transform transition-all pointer-events-auto">
                <div className="flex items-center justify-center gap-2 mb-0.5">
                  <span
                    className={`text-[10px] font-mono font-bold tracking-wider uppercase ${
                      activeTab === 'record' ? 'text-rose-400' : 'text-cyan-400'
                    }`}
                  >
                    {activeTab === 'record' ? 'Recording Mode' : 'Live Subtitle'}
                  </span>
                  {activeTab === 'live' && currentSubtitle && (
                    <button
                      onClick={handleClearSubtitle}
                      title="Clear subtitle [C]"
                      className="ml-2 px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20 text-[9px] font-mono text-slate-300 hover:text-white transition-colors flex items-center gap-1 cursor-pointer"
                    >
                      <RotateCcw className="w-2.5 h-2.5" />
                      <span>Clear</span>
                    </button>
                  )}
                </div>

                <div
                  className={`text-white font-black tracking-wide drop-shadow-[0_2px_8px_rgba(0,0,0,0.95)] ${
                    captionSize === 'small'
                      ? 'text-sm sm:text-base'
                      : captionSize === 'large'
                      ? 'text-xl sm:text-2xl md:text-3xl'
                      : 'text-lg sm:text-xl md:text-2xl'
                  }`}
                >
                  {activeTab === 'record' ? (
                    recordingState === 'countdown' ? (
                      `Get ready to sign "${selectedWord}" in ${countdown}...`
                    ) : recordingState === 'recording' ? (
                      `Recording "${selectedWord}"... (${recordedFramesCount} hand frames)`
                    ) : recordingState === 'saving' ? (
                      `Saving "${selectedWord}" to IndexedDB...`
                    ) : (
                      `Target: "${selectedWord}" (${currentWordCount} / ${TARGET_SAMPLES_PER_WORD} samples)`
                    )
                  ) : (
                    <>
                      <div
                        role="status"
                        aria-live="polite"
                        className={`transition-opacity duration-700 ${
                          isSubtitleFaded ? 'opacity-0' : 'opacity-100'
                        }`}
                      >
                        {currentSubtitle ? (
                          <span className={`capitalize ${
                            currentSubtitle === 'Uncertain - please repeat'
                              ? 'text-slate-400 text-base font-semibold'
                              : 'text-cyan-100'
                          }`}>
                            {currentSubtitle}
                            {currentConfidence !== null && (
                              <span className="ml-2 text-sm font-semibold text-cyan-300">
                                {Math.round(currentConfidence * 100)}%
                              </span>
                            )}
                          </span>
                        ) : (
                          <span className="text-slate-400 text-xs sm:text-sm font-normal italic font-sans">
                            {aiModelReady
                              ? liveCollectingFrames > 0
                                ? 'Signing gesture in progress...'
                                : 'Subtitles will appear here (sign a word)'
                              : 'Loading neural recognition model...'}
                          </span>
                        )}
                      </div>
                      {sentenceText && (
                        <p className="mt-1 max-w-full whitespace-normal break-words text-base sm:text-lg font-bold leading-snug text-white">
                          {sentenceText}
                        </p>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* BOTTOM SHORTCUT STRIP OVERLAY (Requirement B) */}
          {showHud && (
            <div className="absolute bottom-2 left-0 right-0 z-20 flex items-center justify-center pointer-events-none px-2">
              <div className="px-3.5 sm:px-4 py-1 rounded-full bg-slate-950/85 backdrop-blur-md border border-cyan-500/25 text-[10px] font-mono text-slate-300 tracking-wider shadow-lg flex flex-wrap items-center justify-center gap-1.5 sm:gap-2 pointer-events-auto max-w-[95%]">
                <span><span className="text-cyan-400 font-bold">[P]</span> Pause</span>
                <span>•</span>
                <span><span className="text-cyan-400 font-bold">[S]</span> Screenshot</span>
                <span>•</span>
                <span><span className="text-cyan-400 font-bold">[R]</span> Record</span>
                <span>•</span>
                <span><span className="text-cyan-400 font-bold">[L]</span> Landmarks</span>
                <span>•</span>
                <span><span className="text-cyan-400 font-bold">[K]</span> Skeleton</span>
                <span>•</span>
                <span><span className="text-cyan-400 font-bold">[H]</span> HUD</span>
                <span>•</span>
                <span><span className="text-cyan-400 font-bold">[C]</span> Clear</span>
                <span>•</span>
                <span><span className="text-cyan-400 font-bold">[X]</span> Copy</span>
                <span>•</span>
                <span><span className="text-cyan-400 font-bold">[G]</span> Ghost</span>
              </div>
            </div>
          )}
        </div>

        {/* MODULAR CONTROL DECK (Below Video Stage) */}
        <div className="w-full max-w-4xl mt-3 p-3 bg-slate-900/80 backdrop-blur-xl border border-cyan-500/25 rounded-2xl shadow-xl flex flex-wrap items-center justify-between gap-3 font-mono text-xs">
          {/* Hand Mode Segmented Control (Requirement D) */}
          <div className="flex items-center gap-2">
            <span className="text-slate-400 text-[11px] uppercase tracking-wider font-bold">Hand Mode:</span>
            <div className="flex items-center bg-slate-950 p-1 rounded-xl border border-slate-800">
              <button
                onClick={() => setHandMode('both')}
                aria-pressed={handMode === 'both'}
                className={`px-3 py-1.5 rounded-lg font-bold transition-all ${
                  handMode === 'both'
                    ? 'bg-cyan-500/25 text-cyan-300 border border-cyan-500/50 shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Both hands
              </button>
              <button
                onClick={() => setHandMode('right')}
                aria-pressed={handMode === 'right'}
                className={`px-3 py-1.5 rounded-lg font-bold transition-all ${
                  handMode === 'right'
                    ? 'bg-cyan-500/25 text-cyan-300 border border-cyan-500/50 shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Right hand only
              </button>
              <button
                onClick={() => setHandMode('left')}
                aria-pressed={handMode === 'left'}
                className={`px-3 py-1.5 rounded-lg font-bold transition-all ${
                  handMode === 'left'
                    ? 'bg-cyan-500/25 text-cyan-300 border border-cyan-500/50 shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Left hand only
              </button>
            </div>
          </div>

          {/* Interactive Button Deck for All Shortcuts */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Ghost (Invisibility) Mode Toggle [G] */}
            <button
              onClick={() => setIsGhostMode(!isGhostMode)}
              aria-pressed={isGhostMode}
              title="Toggle Ghost Mode [G]"
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border font-bold transition-all ${
                isGhostMode
                  ? 'bg-cyan-950 text-cyan-300 border-cyan-400 shadow-md shadow-cyan-500/30 ring-1 ring-cyan-400/50'
                  : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-slate-200'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
              <span>Ghost [G]</span>
            </button>

            {/* HUD Overlay Toggle [H] */}
            <button
              onClick={() => setShowHud(!showHud)}
              aria-pressed={showHud}
              title="Toggle HUD Overlay [H]"
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border font-bold transition-all ${
                showHud
                  ? 'bg-cyan-950/70 text-cyan-300 border-cyan-600/50'
                  : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-slate-200'
              }`}
            >
              <Activity className="w-3.5 h-3.5" />
              <span>HUD [H]</span>
            </button>

            {/* Landmarks Toggle [L] */}
            <button
              onClick={() => setShowLandmarks(!showLandmarks)}
              aria-pressed={showLandmarks}
              title="Toggle 21 Landmark Points [L]"
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border font-bold transition-all ${
                showLandmarks
                  ? 'bg-cyan-950/70 text-cyan-300 border-cyan-600/50'
                  : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-slate-200'
              }`}
            >
              <Zap className="w-3.5 h-3.5" />
              <span>Landmarks [L]</span>
            </button>

            {/* Skeleton Toggle [K] */}
            <button
              onClick={() => setShowSkeleton(!showSkeleton)}
              aria-pressed={showSkeleton}
              title="Toggle Skeleton Lines [K]"
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border font-bold transition-all ${
                showSkeleton
                  ? 'bg-cyan-950/70 text-cyan-300 border-cyan-600/50'
                  : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-slate-200'
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              <span>Skeleton [K]</span>
            </button>

            {/* Pause Detection [P] */}
            <button
              onClick={() => setIsPaused(!isPaused)}
              aria-pressed={isPaused}
              title="Pause / Resume Detection [P]"
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border font-bold transition-all ${
                isPaused
                  ? 'bg-amber-950 text-amber-300 border-amber-500 ring-1 ring-amber-500'
                  : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-slate-200'
              }`}
            >
              <Pause className="w-3.5 h-3.5" />
              <span>{isPaused ? 'Resume [P]' : 'Pause [P]'}</span>
            </button>

            {/* Screenshot [S] */}
            <button
              onClick={handleScreenshot}
              title="Capture HUD Screenshot [S]"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-950 hover:bg-cyan-950/70 border border-slate-800 hover:border-cyan-500 text-slate-300 hover:text-cyan-200 font-bold transition-all"
            >
              <Camera className="w-3.5 h-3.5" />
              <span>Snapshot [S]</span>
            </button>

            {/* Copy Word [X] */}
            <button
              onClick={handleCopyWord}
              disabled={!currentSubtitle}
              title="Copy active word to clipboard [X]"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-950 hover:bg-slate-800 border border-slate-800 text-slate-300 hover:text-white font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Copy className="w-3.5 h-3.5" />
              <span>Copy [X]</span>
            </button>

            {/* Clear Subtitle [C] */}
            <button
              onClick={handleClearSubtitle}
              disabled={!currentSubtitle}
              title="Clear active subtitle [C]"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-950 hover:bg-red-950/60 border border-slate-800 hover:border-red-600/60 text-slate-300 hover:text-red-300 font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Trash2 className="w-3.5 h-3.5 text-red-400" />
              <span>Clear [C]</span>
            </button>

            {/* Mirror Toggle */}
            <button
              onClick={() => setIsMirrored(!isMirrored)}
              aria-label="Toggle mirrored camera view"
              aria-pressed={isMirrored}
              title="Toggle Mirror View"
              className={`p-2 rounded-xl border transition-colors ${
                isMirrored
                  ? 'bg-cyan-950/70 border-cyan-600/50 text-cyan-300'
                  : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              <FlipHorizontal className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Accessible Sentence & Caption Controls */}
        <div className="w-full max-w-4xl mt-2.5 p-3 bg-slate-900/80 backdrop-blur-xl border border-cyan-500/25 rounded-2xl shadow-xl font-mono text-xs">
          <div className="flex flex-col md:flex-row md:items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-cyan-400 font-bold uppercase tracking-wider">Recognized sentence</span>
                <span className="text-slate-500">{sentenceText.length} characters</span>
              </div>
              <div
                className="min-h-12 whitespace-pre-wrap px-3 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-white text-lg font-bold leading-relaxed"
              >
                {sentenceBuilder.length > 0 ? sentenceBuilder.map((item, index) => (
                  <React.Fragment key={`word-${index}`}>
                    {index > 0 && ' '}
                    <span>{item.word}</span>
                    <span className="ml-1 text-sm font-semibold text-cyan-300">
                      {Math.round(item.confidence * 100)}%
                    </span>
                  </React.Fragment>
                )) : <span className="text-slate-500 italic">Recognized words will build a sentence here</span>}
                {hasTrailingSpace && sentenceBuilder.length > 0 && ' '}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button onClick={handleInsertSpace} className="px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-700 hover:border-cyan-500 text-slate-300">Space</button>
              <button onClick={handleDeleteLastWord} disabled={sentenceBuilder.length === 0} className="px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-700 hover:border-amber-500 text-slate-300 disabled:opacity-40">Delete</button>
              <button onClick={handleCapitalizeSentence} disabled={sentenceBuilder.length === 0} className="px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-700 hover:border-cyan-500 text-slate-300 disabled:opacity-40">Capitalize</button>
              <button onClick={handleClearSentence} disabled={sentenceBuilder.length === 0} className="px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-700 hover:border-red-500 text-slate-300 disabled:opacity-40">Clear sentence</button>
              <button onClick={handleCopySentence} disabled={sentenceBuilder.length === 0} title="Copy the recognized sentence" className="px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-700 hover:border-cyan-500 text-slate-300 disabled:opacity-40">Copy sentence</button>
              <button onClick={handleExportSentence} disabled={sentenceBuilder.length === 0} className="px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-700 hover:border-cyan-500 text-slate-300 disabled:opacity-40">Export</button>
              <button
                onClick={isSpeaking ? handleStopSpeaking : handleSpeakSentence}
                disabled={sentenceBuilder.length === 0}
                className={`px-2.5 py-1.5 rounded-lg border font-bold disabled:opacity-40 ${
                  isSpeaking
                    ? 'bg-rose-950 border-rose-600 text-rose-300'
                    : 'bg-cyan-950/70 border-cyan-700 text-cyan-300'
                }`}
              >
                {isSpeaking ? 'Stop speech' : 'Speak'}
              </button>
              <label className="flex items-center gap-1.5 text-slate-400">
                Caption size
                <select
                  value={captionSize}
                  onChange={(e) => setCaptionSize(e.target.value)}
                  className="bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-slate-200"
                >
                  <option value="small">Small</option>
                  <option value="medium">Medium</option>
                  <option value="large">Large</option>
                </select>
              </label>
            </div>
          </div>
        </div>

        {/* COMPACT SAMPLE STORAGE TOOLBAR (IndexedDB 32-Frame Feature Store) */}
        <div className="w-full max-w-4xl mt-2.5 px-3 py-2 bg-slate-900/80 backdrop-blur-xl border border-cyan-500/25 rounded-2xl shadow-xl flex flex-wrap items-center justify-between gap-2.5 font-mono text-xs">
          {/* Word selector & current count */}
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 text-cyan-400 font-bold text-[11px] tracking-wider uppercase">
              <Database className="w-3.5 h-3.5" />
              <span>Sample:</span>
            </div>

            <select
              value={storageWord}
              onChange={(e) => setStorageWord(e.target.value)}
              className="bg-slate-950 border border-slate-700 hover:border-cyan-500 text-slate-100 rounded-lg px-2.5 py-1 text-xs font-semibold focus:outline-none focus:border-cyan-400 cursor-pointer"
            >
              {VOCABULARY.map((word) => (
                <option key={word} value={word}>
                  {word} ({wordCounts[word] || 0})
                </option>
              ))}
            </select>

            <span className="px-2 py-0.5 rounded-md bg-cyan-950/80 border border-cyan-800 text-cyan-300 font-bold text-[11px]">
              {storageWord}: {wordCounts[storageWord] || 0}
            </span>
          </div>

          {/* Action buttons: Save Sample, Download Samples, Clear Samples */}
          <div className="flex items-center gap-2">
            <button
              onClick={handleSaveSample}
              title="Save last 32 frames of hand features for the selected word"
              className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-bold text-xs shadow-md shadow-cyan-500/25 transition-all transform active:scale-95"
            >
              <Save className="w-3.5 h-3.5" />
              <span>Save Sample</span>
            </button>

            <button
              onClick={handleDownloadSamples}
              disabled={totalRecordingsCount === 0}
              title="Download all stored samples as a single JSON file"
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-950 hover:bg-slate-800 border border-slate-700 hover:border-cyan-500 text-slate-200 text-xs font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Download className="w-3.5 h-3.5 text-cyan-400" />
              <span>Download Samples ({totalRecordingsCount})</span>
            </button>

            <button
              onClick={handleClearSamples}
              disabled={totalRecordingsCount === 0}
              title="Clear all stored samples from IndexedDB"
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-950 hover:bg-red-950/60 border border-slate-800 hover:border-red-600/60 text-slate-400 hover:text-red-300 text-xs font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Trash2 className="w-3.5 h-3.5 text-red-400" />
              <span>Clear Samples</span>
            </button>
          </div>
        </div>

        {/* TAB 2: RECORD MODE STUDIO CONTROLS (Dataset Collection Studio) */}
        {activeTab === 'record' && (
          <div className="w-full max-w-4xl mt-4 flex flex-col gap-4 font-sans">
            <div className="p-4 bg-slate-900/80 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-xl flex flex-wrap items-center justify-between gap-4">
              <div className="flex flex-col gap-1 min-w-[210px] flex-1 sm:flex-initial font-mono">
                <label className="text-xs font-semibold text-slate-400 flex items-center justify-between">
                  <span>Sign Word (23 words)</span>
                  <span className="text-rose-400 text-[11px]">
                    {currentWordCount} / {TARGET_SAMPLES_PER_WORD}
                  </span>
                </label>
                <select
                  value={selectedWord}
                  onChange={(e) => setSelectedWord(e.target.value)}
                  disabled={recordingState !== 'idle'}
                  className="bg-slate-950 border border-slate-700 text-slate-100 rounded-xl px-4 py-2.5 text-sm font-semibold focus:outline-none focus:border-rose-500 cursor-pointer disabled:opacity-50"
                >
                  {VOCABULARY.map((word) => {
                    const count = wordCounts[word] || 0;
                    return (
                      <option key={word} value={word}>
                        {word}: {count} / {TARGET_SAMPLES_PER_WORD}{' '}
                        {count >= TARGET_SAMPLES_PER_WORD ? '✓' : ''}
                      </option>
                    );
                  })}
                </select>
              </div>

              <div className="flex flex-col justify-center min-w-[180px] flex-1 sm:flex-initial font-mono">
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <span className="font-bold text-slate-300 capitalize">{selectedWord}</span>
                  <span className="text-slate-400 text-[11px]">
                    {currentWordCount} / {TARGET_SAMPLES_PER_WORD} ({currentProgressPercent}%)
                  </span>
                </div>
                <div className="w-full bg-slate-950 rounded-full h-2.5 overflow-hidden border border-slate-800">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${
                      currentWordCount >= TARGET_SAMPLES_PER_WORD
                        ? 'bg-emerald-500 shadow-sm shadow-emerald-500/50'
                        : 'bg-gradient-to-r from-rose-500 to-red-500'
                    }`}
                    style={{ width: `${currentProgressPercent}%` }}
                  />
                </div>
              </div>

              <button
                onClick={startRecordingFlow}
                disabled={recordingState !== 'idle' || cameraStatus !== 'active'}
                className={`flex items-center justify-center gap-2.5 px-8 py-3.5 rounded-xl font-bold font-mono text-base shadow-xl transition-all transform active:scale-95 ${
                  recordingState === 'recording'
                    ? 'bg-rose-700 text-white animate-pulse cursor-not-allowed shadow-rose-700/50'
                    : recordingState === 'countdown'
                    ? 'bg-amber-600 text-white cursor-not-allowed shadow-amber-600/50'
                    : recordingState === 'saving'
                    ? 'bg-blue-600 text-white cursor-not-allowed'
                    : cameraStatus !== 'active'
                    ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                    : 'bg-gradient-to-r from-rose-500 to-red-600 hover:from-rose-400 hover:to-red-500 text-white shadow-rose-600/30 hover:scale-105'
                }`}
              >
                <Radio className="w-5 h-5 animate-pulse" />
                <span>
                  {recordingState === 'countdown'
                    ? `Countdown: ${countdown}`
                    : recordingState === 'recording'
                    ? `Recording ${recordedFramesCount} frames...`
                    : recordingState === 'saving'
                    ? 'Saving to DB...'
                    : `Record "${selectedWord}"`}
                </span>
              </button>

              <div className="flex items-center gap-2 font-mono">
                <button
                  onClick={handleDeleteLastRecording}
                  disabled={recordingState !== 'idle' || totalRecordingsCount === 0}
                  aria-label="Delete last recording"
                  title="Delete the most recent recording"
                  className="flex items-center gap-2 px-3.5 py-3 bg-slate-950 hover:bg-red-950/60 border border-slate-800 hover:border-red-600/60 text-slate-300 hover:text-red-300 rounded-xl text-xs font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Trash2 className="w-4 h-4 text-red-400" />
                  <span className="hidden md:inline">Delete Last</span>
                </button>

                <button
                  onClick={handleDownloadDataset}
                  disabled={recordingState !== 'idle' || totalRecordingsCount === 0}
                  title="Download all recordings as one JSON dataset file"
                  className="flex items-center gap-2 px-4 py-3 bg-cyan-950/70 hover:bg-cyan-900/80 border border-cyan-800 hover:border-cyan-500 text-cyan-300 hover:text-white rounded-xl text-xs font-bold transition-all shadow-lg shadow-cyan-950/40 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Download className="w-4 h-4 text-cyan-400" />
                  <span>Download Dataset ({totalRecordingsCount})</span>
                </button>
              </div>
            </div>

            {/* Vocabulary Progress Grid */}
            <div className="p-4 bg-slate-900/60 border border-slate-800/80 rounded-2xl font-mono">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Database className="w-4 h-4 text-rose-400" />
                  <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider">
                    23 Words Progress ({totalRecordingsCount} total samples)
                  </h3>
                </div>
                <span className="text-[11px] text-slate-400">Click any word to select it</span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-2">
                {VOCABULARY.map((word) => {
                  const count = wordCounts[word] || 0;
                  const isCompleted = count >= TARGET_SAMPLES_PER_WORD;
                  const isCurrent = word === selectedWord;

                  return (
                    <button
                      key={word}
                      onClick={() => setSelectedWord(word)}
                      disabled={recordingState !== 'idle'}
                      className={`flex items-center justify-between px-3 py-2 rounded-xl text-xs font-medium transition-all ${
                        isCurrent
                          ? 'bg-rose-950/80 border-2 border-rose-500 text-rose-100 shadow-md shadow-rose-950/50'
                          : isCompleted
                          ? 'bg-emerald-950/40 border border-emerald-800/40 text-emerald-300 hover:bg-emerald-900/40'
                          : 'bg-slate-950/60 border border-slate-800/80 text-slate-300 hover:bg-slate-800/60'
                      }`}
                    >
                      <span className="font-semibold truncate">{word}</span>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded ${
                          isCompleted
                            ? 'bg-emerald-900/70 text-emerald-200'
                            : isCurrent
                            ? 'bg-rose-900/70 text-rose-200'
                            : 'bg-slate-800 text-slate-400'
                        }`}
                      >
                        {count}/{TARGET_SAMPLES_PER_WORD}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Floating Notification Toast */}
      {notification && (
        <div
          className={`fixed bottom-6 right-6 z-50 flex items-center gap-2.5 px-4 py-3 rounded-xl border shadow-2xl backdrop-blur-md transition-all animate-in fade-in slide-in-from-bottom-4 font-mono ${
            notification.type === 'success'
              ? 'bg-emerald-950/95 border-emerald-600 text-emerald-200'
              : notification.type === 'error'
              ? 'bg-red-950/95 border-red-600 text-red-200'
              : 'bg-slate-900/95 border-cyan-500/50 text-cyan-200'
          }`}
        >
          {notification.type === 'success' && <Check className="w-4 h-4 text-emerald-400" />}
          {notification.type === 'error' && <AlertCircle className="w-4 h-4 text-red-400" />}
          {notification.type === 'info' && <Sparkles className="w-4 h-4 text-cyan-400" />}
          <span className="text-xs md:text-sm font-semibold">{notification.message}</span>
        </div>
      )}

      {/* FOOTER */}
      <footer className="w-full max-w-6xl text-center py-2 text-[11px] font-mono text-slate-500 flex items-center justify-between">
        <span>SignSpeak Control Room • Hackathon Edition</span>
        <span className="hidden sm:inline">23 ASL Words • Pure JS Neural BiGRU • Client-Side WASM Vision</span>
        <span>Press <span className="text-cyan-400 font-bold">[H]</span> to Toggle HUD</span>
      </footer>
    </div>
  );
}
