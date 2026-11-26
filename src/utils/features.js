/**
 * SignSpeak Feature Extraction Pipeline
 * Extracts 138-dimensional feature vector per video frame:
 * - Left hand relative coordinates (63)
 * - Right hand relative coordinates (63)
 * - Left hand wrist x, y, z (3)
 * - Right hand wrist x, y, z (3)
 * - Wrist velocity compared to previous frame (6)
 * Total = 138 features.
 */

/**
 * Maps MediaPipe handedness label to the user's real physical hand side.
 * When isMirrored is true (default front-facing webcam preview with scaleX(-1)),
 * the user raises their physical Right hand, which to the raw unmirrored camera
 * sensor appears on the left side, so MediaPipe labels it 'Left'.
 * Hence:
 * - In mirrored mode: MediaPipe 'Left' -> user's real Right hand, 'Right' -> real Left hand.
 * - In non-mirrored mode: MediaPipe 'Right' -> user's real Right hand, 'Left' -> real Left hand.
 */
export function getRealHandSide(mpCategoryName, isMirrored = true) {
  if (!mpCategoryName) return 'Right';
  const cat = mpCategoryName.toLowerCase();
  if (isMirrored) {
    return cat === 'left' ? 'Right' : 'Left';
  } else {
    return cat === 'right' ? 'Right' : 'Left';
  }
}

/**
 * Assigns detected hands to Left and Right slots based on real handedness and handMode
 */
export function assignHands(landmarks, handedness, isMirrored = true, handMode = 'both') {
  let leftHand = null;
  let rightHand = null;

  if (!landmarks || landmarks.length === 0) {
    return { leftHand, rightHand };
  }

  for (let i = 0; i < landmarks.length; i++) {
    const hand = landmarks[i];
    const h = handedness?.[i];
    const rawCat = Array.isArray(h) ? h[0]?.categoryName : h?.categoryName;
    const realSide = getRealHandSide(rawCat, isMirrored);

    if (realSide === 'Right') {
      if (handMode === 'both' || handMode === 'right') {
        if (!rightHand) rightHand = hand;
      }
    } else {
      if (handMode === 'both' || handMode === 'left') {
        if (!leftHand) leftHand = hand;
      }
    }
  }

  // Fallback if two hands detected in 'both' mode but both had same raw label
  if (handMode === 'both' && landmarks.length >= 2 && (!leftHand || !rightHand)) {
    const wrist0X = landmarks[0][0]?.x ?? 0;
    const wrist1X = landmarks[1][0]?.x ?? 0;
    // In camera space: smaller x is camera-left (mirrored right)
    if (isMirrored) {
      if (wrist0X < wrist1X) {
        rightHand = landmarks[0];
        leftHand = landmarks[1];
      } else {
        leftHand = landmarks[0];
        rightHand = landmarks[1];
      }
    } else {
      if (wrist0X < wrist1X) {
        leftHand = landmarks[0];
        rightHand = landmarks[1];
      } else {
        rightHand = landmarks[0];
        leftHand = landmarks[1];
      }
    }
  }

  return { leftHand, rightHand };
}

/**
 * Computes 63 normalized relative coordinates and 3 wrist coordinates for one hand
 * Points 0-20:
 * wrist = point 0; rel = points minus wrist;
 * size = max(abs(rel)) + 1e-6; rel = rel / size, flattened to 63 numbers.
 */
function processSingleHand(hand) {
  if (!hand || hand.length < 21) {
    return {
      rel: new Array(63).fill(0),
      wrist: [0, 0, 0]
    };
  }

  const wristPt = hand[0];
  const wrist = [wristPt.x, wristPt.y, wristPt.z ?? 0];

  const diffs = new Float32Array(63);
  let maxAbs = 0;

  for (let i = 0; i < 21; i++) {
    const pt = hand[i];
    const dx = pt.x - wrist[0];
    const dy = pt.y - wrist[1];
    const dz = (pt.z ?? 0) - wrist[2];

    const idx = i * 3;
    diffs[idx] = dx;
    diffs[idx + 1] = dy;
    diffs[idx + 2] = dz;

    if (Math.abs(dx) > maxAbs) maxAbs = Math.abs(dx);
    if (Math.abs(dy) > maxAbs) maxAbs = Math.abs(dy);
    if (Math.abs(dz) > maxAbs) maxAbs = Math.abs(dz);
  }

  const size = maxAbs + 1e-6;
  const rel = new Array(63);
  for (let j = 0; j < 63; j++) {
    rel[j] = diffs[j] / size;
  }

  return { rel, wrist };
}

/**
 * Extracts 138-dimensional feature vector for the current video frame
 * @param {Object} landmarkerResults Result from MediaPipe HandLandmarker.detectForVideo
 * @param {Array<number>|null} prevWristCoords The 6 wrist coordinates from previous frame [lx, ly, lz, rx, ry, rz]
 * @param {string} handMode 'both' | 'right' | 'left'
 * @param {boolean} isMirrored whether preview container is mirrored
 * @returns {{ features: Array<number>, wristCoords: Array<number>, hasHand: boolean }}
 */
export function extractFrameFeatures(
  landmarkerResults,
  prevWristCoords = null,
  handMode = 'both',
  isMirrored = true
) {
  const landmarks = landmarkerResults?.landmarks || [];
  const handedness = landmarkerResults?.handedness || landmarkerResults?.handednesses || [];

  const { leftHand, rightHand } = assignHands(landmarks, handedness, isMirrored, handMode);
  const hasHand = Boolean(leftHand || rightHand);

  const leftProcessed = processSingleHand(leftHand);
  const rightProcessed = processSingleHand(rightHand);

  // 6 wrist numbers of this frame: [left wrist (3), right wrist (3)]
  const currWristCoords = [
    ...leftProcessed.wrist,
    ...rightProcessed.wrist
  ];

  // Velocity: wrist numbers of this frame minus previous frame (zeros for first frame)
  const velocity = new Array(6).fill(0);
  if (prevWristCoords && prevWristCoords.length === 6) {
    for (let i = 0; i < 6; i++) {
      velocity[i] = currWristCoords[i] - prevWristCoords[i];
    }
  }

  // Combine into 138 features:
  // [left rel (63), right rel (63), left wrist (3), right wrist (3), velocity (6)]
  const features = [
    ...leftProcessed.rel,
    ...rightProcessed.rel,
    ...leftProcessed.wrist,
    ...rightProcessed.wrist,
    ...velocity
  ];

  return {
    features,
    wristCoords: currWristCoords,
    hasHand,
    leftHand,
    rightHand
  };
}

/**
 * Resamples a sequence of frames to exactly targetCount (default 32)
 * using evenly spaced indices like numpy.linspace
 * @param {Array<Array<number>>} frames
 * @param {number} targetCount
 * @returns {Array<Array<number>>} Exactly targetCount frames
 */
export function resampleFrames(frames, targetCount = 32) {
  const n = frames.length;
  if (n === 0) return [];
  if (n === targetCount) return frames.map((f) => [...f]);

  const resampled = [];
  for (let i = 0; i < targetCount; i++) {
    const idx = Math.round((i * (n - 1)) / (targetCount - 1));
    resampled.push([...frames[idx]]);
  }
  return resampled;
}
